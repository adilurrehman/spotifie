/**
 * What this listener has made of the library.
 *
 * Liked songs, playlists and what they have been listening to. All of it lives
 * on this machine, in that account's own state file, and this is the one place
 * the page talks to it.
 *
 * Three things follow from that being one place:
 *
 * - a heart means the same thing everywhere. Nothing keeps its own idea of
 *   whether a song is liked; every card, row, playbar and dialog reads it from
 *   here and is told when it changes, so they cannot disagree;
 * - a click feels immediate. The change is applied here and drawn at once, and
 *   the server's answer replaces it a moment later - or puts it back, if the
 *   server refused;
 * - signing out empties it. Personal state is held in memory only while
 *   somebody is signed in; the next person at this machine starts from
 *   nothing, and a guest has nothing to start from.
 *
 * Everything stored is a reference: canonical track ids and, for a cover
 * somebody chose, an artwork id this machine serves. No audio, no pictures, no
 * addresses that expire, and nothing at all in Supabase.
 */
(function (global) {
    'use strict';

    var DEFAULT_BASE = '/api/catalog';

    function PersonalClient(options) {
        var settings = options || {};
        this.baseUrl = settings.baseUrl || DEFAULT_BASE;
        this.request = settings.request || null;

        this.signedIn = false;
        this.loaded = false;

        // Liked songs as a set, because the question asked of it a hundred
        // times per render is "is this one liked".
        this.liked = new Set();
        this.likedOrder = [];
        this.likedTracks = [];
        this.playlists = [];
        this.recentlyPlayed = [];

        this.listeners = new Set();
        this.pending = null;
    }

    /** How a request is actually made. The catalogue client carries the session. */
    PersonalClient.prototype._send = function (path, init) {
        if (this.request) return this.request(this.baseUrl + path, init);

        var catalog = global.spotifieCatalog;
        if (catalog && typeof catalog._request === 'function') {
            return catalog._request(this.baseUrl + path, init);
        }

        return fetch(this.baseUrl + path, Object.assign({ credentials: 'same-origin' }, init)).then(function (response) {
            if (!response.ok) {
                var error = new Error('Request failed with status ' + response.status);
                error.status = response.status;
                throw error;
            }
            return response.json();
        });
    };

    PersonalClient.prototype._json = function (path, method, body) {
        return this._send(path, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
    };

    // ============================================
    // Reading
    // ============================================

    /**
     * Fetch everything this person has, in one request.
     *
     * Asking twice at once makes one journey. A failure leaves what is already
     * held alone rather than emptying it: a moment without the network is not
     * the same as having nothing.
     */
    PersonalClient.prototype.load = function (options) {
        var self = this;
        var settings = options || {};

        if (this.pending && !settings.force) return this.pending;

        this.pending = this._send('/me')
            .then(function (state) {
                self._apply(state);
                return self;
            })
            .catch(function (error) {
                console.warn('Could not read your library:', error && error.message);
                return self;
            })
            .finally(function () {
                self.pending = null;
            });

        return this.pending;
    };

    PersonalClient.prototype._apply = function (state) {
        var personal = state || {};

        this.signedIn = Boolean(personal.signedIn);
        this.loaded = true;

        this.likedTracks = (personal.liked && personal.liked.items) || [];
        this.likedOrder = this.likedTracks.map(function (track) {
            return track.id;
        });
        this.liked = new Set(this.likedOrder);

        this.playlists = personal.playlists || [];
        this.recentlyPlayed = (personal.recentlyPlayed && personal.recentlyPlayed.items) || [];

        this._announce();
    };

    /**
     * Forget everything held here.
     *
     * Called when somebody signs out, before the guest view is drawn. Two
     * people using the same machine must not see each other's library, and the
     * surest way to promise that is to have nothing left in memory to show.
     */
    PersonalClient.prototype.clear = function () {
        this.signedIn = false;
        this.loaded = false;
        this.liked = new Set();
        this.likedOrder = [];
        this.likedTracks = [];
        this.playlists = [];
        this.recentlyPlayed = [];
        this._announce();
    };

    // ============================================
    // Telling the page
    // ============================================

    /** Be told whenever any of this changes. Answers a function that stops it. */
    PersonalClient.prototype.onChange = function (listener) {
        var self = this;
        this.listeners.add(listener);
        return function () {
            self.listeners.delete(listener);
        };
    };

    PersonalClient.prototype._announce = function () {
        var self = this;
        this.listeners.forEach(function (listener) {
            try {
                listener(self);
            } catch (e) {
                console.warn('A library listener failed:', e && e.message);
            }
        });
    };

    // ============================================
    // Liked songs
    // ============================================

    PersonalClient.prototype.isLiked = function (trackId) {
        return Boolean(trackId) && this.liked.has(trackId);
    };

    PersonalClient.prototype.getLiked = function () {
        return this.likedTracks.slice();
    };

    /**
     * Like a song, or unlike it if it is already liked.
     *
     * Drawn immediately and confirmed after: a heart that waits for the
     * network to fill in reads as a click that did not land. If the server
     * refuses, the heart goes back to what it was and the caller is told.
     */
    PersonalClient.prototype.toggleLike = function (trackId) {
        if (!trackId) return Promise.resolve(false);

        var self = this;
        var wasLiked = this.liked.has(trackId);

        this._setLikedLocally(trackId, !wasLiked);

        return this._json('/liked', 'POST', { id: trackId })
            .then(function (result) {
                var liked = Boolean(result && result.liked);
                if (liked !== !wasLiked) self._setLikedLocally(trackId, liked);
                return liked;
            })
            .catch(function (error) {
                self._setLikedLocally(trackId, wasLiked);
                throw error;
            });
    };

    PersonalClient.prototype._setLikedLocally = function (trackId, liked) {
        if (liked) {
            if (!this.liked.has(trackId)) {
                this.liked.add(trackId);
                this.likedOrder.unshift(trackId);
            }
        } else {
            this.liked.delete(trackId);
            this.likedOrder = this.likedOrder.filter(function (id) {
                return id !== trackId;
            });
            this.likedTracks = this.likedTracks.filter(function (track) {
                return track.id !== trackId;
            });
        }
        this._announce();
    };

    // ============================================
    // Playlists
    // ============================================

    PersonalClient.prototype.getPlaylists = function () {
        return this.playlists.slice();
    };

    PersonalClient.prototype.getPlaylist = function (playlistId) {
        return (
            this.playlists.filter(function (playlist) {
                return playlist.id === playlistId;
            })[0] || null
        );
    };

    PersonalClient.prototype.createPlaylist = function (details) {
        var self = this;
        return this._json('/playlists', 'POST', details || {}).then(function (playlist) {
            self.playlists = self.playlists.concat([playlist]);
            self._announce();
            return playlist;
        });
    };

    PersonalClient.prototype.updatePlaylist = function (playlistId, patch) {
        var self = this;
        return this._json('/playlists/' + encodeURIComponent(playlistId), 'PATCH', patch || {}).then(function (playlist) {
            self._replacePlaylist(playlist);
            return playlist;
        });
    };

    PersonalClient.prototype.deletePlaylist = function (playlistId) {
        var self = this;
        return this._send('/playlists/' + encodeURIComponent(playlistId), { method: 'DELETE' }).then(function (result) {
            self.playlists = self.playlists.filter(function (playlist) {
                return playlist.id !== playlistId;
            });
            self._announce();
            return result;
        });
    };

    PersonalClient.prototype.addTrack = function (playlistId, trackId, position) {
        var self = this;
        var body = { id: trackId };
        if (Number.isInteger(position)) body.position = position;

        return this._json('/playlists/' + encodeURIComponent(playlistId) + '/tracks', 'POST', body).then(function (playlist) {
            self._replacePlaylist(playlist);
            return playlist;
        });
    };

    /**
     * Take one entry out of a playlist.
     *
     * A position says which entry, because a playlist may name the same song
     * more than once and only one of them is being removed.
     */
    PersonalClient.prototype.removeTrack = function (playlistId, trackId, position) {
        var self = this;
        var url =
            '/playlists/' + encodeURIComponent(playlistId) + '/tracks/' + encodeURIComponent(trackId);
        if (Number.isInteger(position)) url += '?position=' + position;

        return this._send(url, { method: 'DELETE' }).then(function (playlist) {
            self._replacePlaylist(playlist);
            return playlist;
        });
    };

    /** Move one entry, or state the whole order at once. */
    PersonalClient.prototype.reorder = function (playlistId, arrangement) {
        var self = this;
        return this._json('/playlists/' + encodeURIComponent(playlistId) + '/tracks', 'PUT', arrangement).then(
            function (playlist) {
                self._replacePlaylist(playlist);
                return playlist;
            }
        );
    };

    PersonalClient.prototype._replacePlaylist = function (playlist) {
        if (!playlist || !playlist.id) return;

        var found = false;
        this.playlists = this.playlists.map(function (entry) {
            if (entry.id !== playlist.id) return entry;
            found = true;
            return playlist;
        });

        if (!found) this.playlists = this.playlists.concat([playlist]);
        this._announce();
    };

    // ============================================
    // Recently played
    // ============================================

    PersonalClient.prototype.getRecentlyPlayed = function () {
        return this.recentlyPlayed.slice();
    };

    /**
     * Note that a song was played.
     *
     * Called when playback of a track actually begins, not while it runs: what
     * is being recorded is that somebody listened to something, and that is one
     * fact per song rather than one per second.
     *
     * A guest is not refused, only not recorded.
     */
    PersonalClient.prototype.notePlayed = function (trackId) {
        if (!trackId || !this.signedIn) return Promise.resolve(false);

        return this._json('/recent', 'POST', { id: trackId })
            .then(function (result) {
                return Boolean(result && result.noted);
            })
            .catch(function () {
                // Failing to write down what was played must never interrupt
                // the playing of it.
                return false;
            });
    };

    PersonalClient.prototype.clearRecentlyPlayed = function () {
        var self = this;
        return this._send('/recent', { method: 'DELETE' }).then(function (result) {
            self.recentlyPlayed = [];
            self._announce();
            return result;
        });
    };

    global.PersonalClient = PersonalClient;
    global.spotifiePersonal = new PersonalClient();
})(typeof window !== 'undefined' ? window : globalThis);
