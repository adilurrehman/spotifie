/**
 * Spotifie catalogue client.
 *
 * One view of all music: tracks the user has on this device (source 'local')
 * and tracks an administrator published for everyone (source 'global').
 *
 * Browsing and playing the published catalogue works without an account.
 * Personal actions - hiding something, restoring it - need a signed-in user
 * and are refused with 401 otherwise.
 *
 * The player only ever handles IDs and URLs. It never sees a filesystem path
 * or a Supabase Storage path, and it never needs to know which backend a
 * track came from to play it.
 */
(function (global) {
    'use strict';

    var DEFAULT_BASE = '/api/catalog';
    var DEFAULT_ARTWORK = 'img/music.svg';

    function CatalogClient(options) {
        var settings = options || {};
        this.baseUrl = settings.baseUrl || DEFAULT_BASE;
        this.fetchImpl = settings.fetch || null;
        // Signed URLs expire, so resolved media is cached only briefly.
        this.mediaCache = new Map();
        // Reads already on their way. Two parts of the page wanting the same
        // catalogue at the same moment share one journey rather than each
        // making the server work the whole thing out again.
        this.pending = new Map();
    }

    /**
     * Ask once, however many callers are asking.
     *
     * The entry is removed as soon as the answer arrives, so this shares a
     * journey rather than remembering one: the next caller starts a fresh
     * request and gets fresh rows.
     */
    CatalogClient.prototype._shared = function (key, start) {
        var self = this;

        var running = this.pending.get(key);
        if (running) return running;

        var journey = start().finally(function () {
            self.pending.delete(key);
        });

        this.pending.set(key, journey);
        return journey;
    };

    /**
     * Requests carry the Supabase session when there is one.
     * Reading the published catalogue does not need an account, so a missing
     * or broken session is not an error here - the request simply goes out
     * unauthenticated and the server answers with the public content.
     */
    CatalogClient.prototype._fetch = function (url, init) {
        if (this.fetchImpl) return this.fetchImpl(url, init);

        if (global.spotifieAuth && global.spotifieAuth.authorizedFetch) {
            try {
                return global.spotifieAuth.authorizedFetch(url, init).catch(function () {
                    return fetch(url, Object.assign({ credentials: 'same-origin' }, init));
                });
            } catch (e) {
                return fetch(url, Object.assign({ credentials: 'same-origin' }, init));
            }
        }

        return fetch(url, Object.assign({ credentials: 'same-origin' }, init));
    };

    CatalogClient.prototype._request = function (url, init) {
        return this._fetch(url, init).then(function (response) {
            if (response.ok) return response.json();

            // Carry the server's explanation through, so the interface can say
            // what went wrong instead of quoting a status code.
            return response
                .json()
                .catch(function () {
                    return null;
                })
                .then(function (body) {
                    var message =
                        (body && (body.error || body.detail)) ||
                        'Catalogue request failed with status ' + response.status;
                    if (body && body.error && body.detail && body.detail !== body.error) {
                        message += ' (' + body.detail + ')';
                    }

                    var error = new Error(message);
                    error.status = response.status;
                    error.detail = body ? body.detail : null;
                    throw error;
                });
        });
    };

    CatalogClient.prototype._query = function (params) {
        var pairs = [];
        Object.keys(params || {}).forEach(function (key) {
            var value = params[key];
            if (value === undefined || value === null || value === '') return;
            pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        });
        return pairs.length ? '?' + pairs.join('&') : '';
    };

    /** Per-source availability, hidden items and counts. */
    CatalogClient.prototype.getStatus = function () {
        return this._request(this.baseUrl + '/status');
    };

    /**
     * The published catalogue, from whichever half of Spotifie is running.
     *
     * A Spotifie server assembles it and hands it over, which is the path
     * whenever there is one. A published copy has no server, so the same two
     * tables are read straight from Supabase - the rows are public and the
     * browser holds the key that may read them and change nothing.
     *
     * Both answer the same shape, so nothing above here learns which it was.
     */
    CatalogClient.prototype._catalogue = function (kind, options) {
        var url = this.baseUrl + '/' + kind + this._query(options);
        var self = this;

        return this._shared(url, function () {
            return self._request(url).catch(function (error) {
                // A route that is not there is a copy with no server, not a
                // failure. Anything else - refused, broken, unreachable - is
                // passed on, because pretending otherwise would hide it.
                if (error.status !== 404) throw error;
                return self._fromCloud(kind);
            });
        });
    };

    /** Everything published, read from Supabase and shaped as a server would. */
    CatalogClient.prototype._fromCloud = function (kind) {
        var self = this;

        return this._cloudCatalogue().then(function (catalogue) {
            if (!catalogue) {
                var missing = new Error('The published catalogue is not reachable from here.');
                missing.status = 503;
                throw missing;
            }

            return catalogue.read().then(function (answer) {
                var items = kind === 'albums' ? answer.albums : answer.tracks;
                self._cloud = catalogue;

                return {
                    total: items.length,
                    items: items,
                    sources: {
                        local: { available: false, trackCount: 0, error: null },
                        global: { available: true, trackCount: answer.tracks.length, error: null }
                    }
                };
            });
        });
    };

    /**
     * The reader for a copy with no server, made once.
     *
     * Needs a signed-in-or-not Supabase client, which the page already has for
     * authentication - so there is one key, one session and one place that
     * knows anything about Supabase.
     */
    CatalogClient.prototype._cloudCatalogue = function () {
        var self = this;
        if (this._cloudPromise) return this._cloudPromise;

        var auth = typeof window !== 'undefined' ? window.spotifieAuth : null;
        var Catalogue = typeof window !== 'undefined' ? window.SpotifieCloudCatalog : null;

        if (!auth || !Catalogue) return Promise.resolve(null);

        this._cloudPromise = auth
            .tryGetClient()
            .then(function (supabase) {
                if (!supabase) return null;
                self._cloud = new Catalogue({ client: supabase });
                return self._cloud;
            })
            .catch(function () {
                return null;
            });

        return this._cloudPromise;
    };

    /** The reader in use, when there is one. Used to resolve media addresses. */
    CatalogClient.prototype.cloudCatalogue = function () {
        return this._cloud || null;
    };

    CatalogClient.prototype.getTracks = function (options) {
        return this._catalogue('tracks', options);
    };

    CatalogClient.prototype.getAlbums = function (options) {
        return this._catalogue('albums', options);
    };

    /**
     * The half of the catalogue this machine answers by itself: the music on
     * the device, and this listener's own state. Supabase is not consulted, so
     * it arrives at the speed of a local read.
     */
    CatalogClient.prototype.getLocalCatalog = function () {
        var url = this.baseUrl + '/local';
        var self = this;
        return this._shared(url, function () {
            return self._request(url);
        });
    };

    CatalogClient.prototype.getArtists = function () {
        return this._request(this.baseUrl + '/artists');
    };

    CatalogClient.prototype.getTrack = function (trackId) {
        return this._request(this.baseUrl + '/tracks/' + encodeURIComponent(trackId));
    };

    /**
     * A URL the <audio> element can play.
     * Local tracks stream from this server; global tracks resolve to a
     * short-lived signed URL.
     */
    CatalogClient.prototype.resolveStreamUrl = function (trackId, options) {
        var self = this;
        var settings = options || {};

        if (settings.refresh) {
            this.mediaCache.delete('stream:' + trackId);
        }

        var cached = this.mediaCache.get('stream:' + trackId);
        if (cached && cached.expiresAt > Date.now()) {
            return Promise.resolve(cached.url);
        }

        return this._request(this.baseUrl + '/tracks/' + encodeURIComponent(trackId) + '/stream')
            .catch(function (error) {
                // No server to ask. A published copy signs the address itself,
                // for a published song; a song on somebody's device is not
                // reachable from here at all, and says so by answering nothing.
                if (error.status !== 404) throw error;

                var cloud = self.cloudCatalogue();
                if (!cloud) return null;

                return cloud.resolveAudio(trackId).then(function (signed) {
                    return signed ? { url: signed, expiresIn: 3600 } : null;
                });
            })
            .then(function (result) {
            if (!result || !result.url) return null;
            if (result.expiresIn) {
                // Refresh a minute before Supabase expires the signature.
                self.mediaCache.set('stream:' + trackId, {
                    url: result.url,
                    expiresAt: Date.now() + Math.max(0, result.expiresIn - 60) * 1000
                });
            }
            return result.url;
        });
    };

    /**
     * Where this origin serves the published picture for an album or a song.
     *
     * The address names the version of the artwork, which is what makes it
     * worth keeping: the same cover is always the same address, so a browser
     * that has it does not ask again, and a replaced cover is a different
     * address, so the old one is never shown in its place.
     *
     * Nothing signed appears here. The signature is made inside the server,
     * used once to read the file, and never reaches the page.
     */
    CatalogClient.prototype.artworkImageUrl = function (id, options) {
        if (!id) return null;

        // This address is served by a Spotifie server, and a published copy
        // has none: it would answer nothing, and the picture would fall back
        // to the default while a perfectly good one waited in storage.
        // Answering null here sends the caller to the signed address instead,
        // which is the one that works where there is no server.
        if (this._cloud) return null;

        var settings = options || {};
        var kind = settings.kind === 'album' ? 'albums' : 'tracks';
        var url = this.baseUrl + '/' + kind + '/' + encodeURIComponent(id) + '/artwork/image';

        return settings.version ? url + '?v=' + encodeURIComponent(settings.version) : url;
    };

    /**
     * Artwork URL for a track or album; resolves to the default cover when
     * there is no artwork, so a missing image never breaks an album.
     */
    CatalogClient.prototype.resolveArtworkUrl = function (id, options) {
        var self = this;
        var settings = options || {};
        var kind = settings.kind === 'album' ? 'albums' : 'tracks';
        var fallback = settings.fallback || DEFAULT_ARTWORK;

        // The one place a resolved artwork address is held, and only until it
        // expires. Nothing else in the application keeps one.
        var cached = this.mediaCache.get('artwork:' + id);
        if (cached && cached.expiresAt > Date.now()) {
            return Promise.resolve(cached.url);
        }
        this.mediaCache.delete('artwork:' + id);

        return this._request(this.baseUrl + '/' + kind + '/' + encodeURIComponent(id) + '/artwork')
            .catch(function (error) {
                // No server to ask. A published copy signs an address for the
                // picture itself, from the same storage the server would have
                // signed one from - and gets the fallback if there is nothing
                // there, exactly as it would have.
                if (error.status !== 404) throw error;

                var cloud = self.cloudCatalogue();
                if (!cloud) return null;

                return cloud.resolveArtwork(id).then(function (signed) {
                    // Answered in the shape the server answers, so what follows
                    // does not care which of the two signed it.
                    return signed ? { url: signed, expiresIn: 3600 } : null;
                });
            })
            .then(function (result) {
                var url = result && result.url;
                if (!url) return fallback;

                // Only a real address is remembered, and only for as long as
                // it is good for - a minute short of its life, so one is never
                // handed out at the moment it stops working.
                if (result.expiresIn) {
                    self.mediaCache.set('artwork:' + id, {
                        url: url,
                        expiresAt: Date.now() + Math.max(0, result.expiresIn - 60) * 1000
                    });
                }
                return url;
            })
            .catch(function () {
                self.mediaCache.delete('artwork:' + id);
                return fallback;
            });
    };

    /**
     * Remove an item from THIS user's view.
     *
     * For global content this hides it for the signed-in user only: the shared
     * copy stays exactly as the administrator published it, and other users
     * still see it. Permanently deleting global content is a separate,
     * administrator-only action.
     */
    CatalogClient.prototype.hide = function (id) {
        return this._request(this.baseUrl + '/hidden', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
    };

    /** Bring back something this user had hidden. */
    CatalogClient.prototype.restore = function (id) {
        return this._request(this.baseUrl + '/hidden/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
    };

    /** Forget any cached media URL for a track, forcing a fresh resolve. */
    CatalogClient.prototype.forgetMedia = function (id) {
        this.mediaCache.delete('stream:' + id);
        this.mediaCache.delete('artwork:' + id);
    };

    /**
     * Forget one remembered artwork address.
     *
     * An address that did not load is not one to hand out again: the page
     * calls this the moment a picture fails, so the next attempt asks for a
     * fresh one rather than reusing the address that just failed.
     */
    CatalogClient.prototype.forgetArtwork = function (id) {
        this.mediaCache.delete('artwork:' + id);
    };

    /**
     * Save this account's own version of a published album.
     * Personal presentation only: the shared catalogue is never written to
     * from here.
     */
    /**
     * Put one of this person's own local tracks into a published album.
     *
     * Personal: the track keeps its own file on this device and the published
     * album is not changed for anybody else.
     */
    CatalogClient.prototype.addTrackToAlbum = function (albumId, trackId) {
        return this._request(this.baseUrl + '/albums/' + encodeURIComponent(albumId) + '/tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trackId })
        });
    };

    /** Take one of their tracks back out of a published album. The file stays. */
    CatalogClient.prototype.removeTrackFromAlbum = function (albumId, trackId) {
        return this._request(
            this.baseUrl + '/albums/' + encodeURIComponent(albumId) + '/tracks/' + encodeURIComponent(trackId),
            { method: 'DELETE' }
        );
    };

    /**
     * Send one audio file from this device to the local server, which keeps it
     * on this machine for this account and indexes it like any other local
     * music. The file is sent as itself - never Base64, never through storage
     * in the browser - and nothing about it reaches Supabase.
     */
    CatalogClient.prototype.importDeviceTrack = function (file) {
        var url = '/api/library/imports?name=' + encodeURIComponent(file.name || 'track');
        return this._request(url, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file
        });
    };

    /**
     * Ask this device to be searched for music.
     *
     * The search runs on the local server, over the music locations this
     * installation is allowed to look in; the page only says yes and then
     * watches the counts. Nothing found is uploaded anywhere.
     */
    CatalogClient.prototype.startDeviceScan = function (options) {
        var settings = options || {};
        // A full pass reads every file again; without one the server reuses
        // what it already knows and looks only at what changed.
        var query = settings.mode === 'full' ? '?mode=full' : '';
        return this._request('/api/library/scan' + query, { method: 'POST' });
    };

    /** How the search is going. 'playing' tells it to give way to playback. */
    CatalogClient.prototype.getDeviceScanStatus = function (options) {
        var settings = options || {};
        var query = settings.playing === undefined ? '' : '?playing=' + (settings.playing ? 'true' : 'false');
        return this._request('/api/library/scan' + query);
    };

    CatalogClient.prototype.cancelDeviceScan = function () {
        return this._request('/api/library/scan', { method: 'DELETE' });
    };

    CatalogClient.prototype.setAlbumOverride = function (albumId, override) {
        return this._request(this.baseUrl + '/overrides/' + encodeURIComponent(albumId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(override || {})
        });
    };

    /** Drop this account's edits and show the album as published. */
    CatalogClient.prototype.clearAlbumOverride = function (albumId) {
        return this._request(this.baseUrl + '/overrides/' + encodeURIComponent(albumId), { method: 'DELETE' });
    };

    CatalogClient.prototype.getAlbumOverrides = function () {
        return this._request(this.baseUrl + '/overrides');
    };

    CatalogClient.prototype.getHidden = function () {
        return this._request(this.baseUrl + '/hidden');
    };

    // ---- where this listener stopped, per track ----
    // Kept on this machine: this account's own state file when signed in, the
    // device's own file when not. Never Supabase.

    CatalogClient.prototype.getPlaybackProgress = function () {
        return this._request(this.baseUrl + '/progress');
    };

    CatalogClient.prototype.savePlaybackProgress = function (trackId, position, duration) {
        return this._request(this.baseUrl + '/progress', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trackId, position: position, duration: duration })
        });
    };

    /**
     * Save a position on the way out of the page.
     *
     * A normal request is abandoned when the tab closes, so this one is marked
     * to outlive it. It carries the session the same way every other request
     * does, so a signed-in listener's position lands in their own state file
     * and a guest's lands in this device's.
     */
    CatalogClient.prototype.savePlaybackProgressOnExit = function (trackId, position, duration) {
        try {
            this._request(this.baseUrl + '/progress', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: trackId, position: position, duration: duration }),
                keepalive: true
            }).catch(function () {
                /* the page is going away; there is nothing to report to */
            });
            return true;
        } catch (e) {
            return false;
        }
    };

    // ---- administrator actions (rejected for everyone else) ----

    CatalogClient.prototype.createGlobalAlbum = function (album) {
        return this._request(this.baseUrl + '/admin/albums', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(album)
        });
    };

    CatalogClient.prototype.createGlobalTrack = function (track) {
        return this._request(this.baseUrl + '/admin/tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(track)
        });
    };

    CatalogClient.prototype.updateGlobalTrack = function (trackId, patch) {
        return this._request(this.baseUrl + '/admin/tracks/' + encodeURIComponent(trackId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
    };

    CatalogClient.prototype.updateGlobalAlbum = function (albumId, patch) {
        return this._request(this.baseUrl + '/albums/' + encodeURIComponent(albumId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
    };

    /** Permanent, for everyone. Administrators only. */
    CatalogClient.prototype.deleteGlobalTrack = function (trackId) {
        return this._request(this.baseUrl + '/tracks/' + encodeURIComponent(trackId), { method: 'DELETE' });
    };

    CatalogClient.prototype.deleteGlobalAlbum = function (albumId) {
        return this._request(this.baseUrl + '/albums/' + encodeURIComponent(albumId), { method: 'DELETE' });
    };

    global.CatalogClient = CatalogClient;
    global.spotifieCatalog = new CatalogClient();

    if (typeof module === 'object' && module.exports) {
        module.exports = { CatalogClient: CatalogClient };
    }
})(typeof window !== 'undefined' ? window : globalThis);
