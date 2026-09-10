/**
 * The published catalogue, read straight from Supabase.
 *
 * With a Spotifie server running, the catalogue arrives already assembled: the
 * server reads the rows, joins them, applies whatever this listener has done
 * to published albums, and hands the browser one answer. That is still the
 * path whenever there is a server.
 *
 * A published copy has none, so this reads the same two tables itself. It is
 * deliberately the smaller half of what the server does - the catalogue as
 * everybody sees it, and nothing personal - because everything personal lives
 * on a device, and a copy running without a helper has no device to read.
 *
 * Two rules it does not bend.
 *
 * The rows are public to read and that is not this file's decision: the
 * database says so, and would refuse anything else however this asked. Nothing
 * here writes, and nothing here could - the browser holds the anon key, which
 * is exactly the key that may read the catalogue and change nothing.
 *
 * And the shapes it answers are the shapes the server answers. Everything
 * above works from ids, titles and URLs, and never learns which of the two put
 * them there - which is the whole point of asking the platform rather than the
 * address bar.
 */
(function (global) {
    'use strict';

    var ALBUM_COLUMNS = 'id,title,artist,album_artist,description,artwork_path,created_at,updated_at';
    var TRACK_COLUMNS =
        'id,album_id,title,artist,album_artist,track_number,disc_number,duration,mime_type,audio_path,artwork_path,created_at,updated_at';

    // How long a signed address is asked to last. Long enough to play a song,
    // short enough that a copied link is not a permanent key to somebody's
    // storage.
    var SIGNED_SECONDS = 3600;

    function clean(value) {
        if (typeof value !== 'string') return null;
        var trimmed = value.trim();
        return trimmed ? trimmed : null;
    }

    function numberOrNull(value) {
        var n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Which picture this is, without saying where it is kept.
     *
     * The same idea the server uses: a short fingerprint of the object path,
     * so an address changes when the cover does and stays put when it does
     * not. The path itself never reaches the page.
     */
    function artworkVersionOf(path) {
        if (!path) return null;

        var hash = 0;
        for (var i = 0; i < path.length; i += 1) {
            hash = (hash * 31 + path.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(16);
    }

    function toAlbumId(uuid) {
        return 'global-album:' + uuid;
    }

    function toTrackId(uuid) {
        return 'global:' + uuid;
    }

    function mapAlbum(row) {
        var artist = clean(row.artist);
        var id = toAlbumId(row.id);

        return {
            id: id,
            source: 'global',
            title: clean(row.title) || 'Untitled Album',
            artist: artist,
            albumArtist: clean(row.album_artist) || artist || 'Unknown Artist',
            description: clean(row.description),
            // Resolved when it is drawn, because a signed address expires and
            // one written into a card would be stale by the time it was used.
            artworkUrl: null,
            trackCount: 0,
            duration: 0,
            metadata: {
                hasArtwork: Boolean(row.artwork_path),
                artworkVersion: artworkVersionOf(row.artwork_path),
                // Where the picture is kept, which is stable and is the one
                // thing worth remembering about it. A copy with no server
                // signs its own address from this; without it, a library drawn
                // from the device's copy before the catalogue has been read
                // has nothing to sign and shows the default cover instead.
                //
                // A path is not a key. Reading the object still needs the
                // signature, and the signature still needs the policy to allow
                // it.
                artworkPath: row.artwork_path || null,
                createdAt: row.created_at || null,
                updatedAt: row.updated_at || null
            }
        };
    }

    function mapTrack(row) {
        var artist = clean(row.artist) || 'Unknown Artist';

        return {
            id: toTrackId(row.id),
            source: 'global',
            title: clean(row.title) || 'Untitled',
            artist: artist,
            albumArtist: clean(row.album_artist) || artist,
            album: null,
            albumId: row.album_id ? toAlbumId(row.album_id) : null,
            duration: numberOrNull(row.duration),
            artworkUrl: null,
            streamUrl: null,
            metadata: {
                trackNumber: numberOrNull(row.track_number),
                discNumber: numberOrNull(row.disc_number),
                format: clean(row.mime_type),
                hasArtwork: Boolean(row.artwork_path),
                artworkVersion: artworkVersionOf(row.artwork_path),
                artworkPath: row.artwork_path || null,
                createdAt: row.created_at || null,
                updatedAt: row.updated_at || null
            }
        };
    }

    /**
     * The published catalogue, as a copy with no server sees it.
     *
     * Given a Supabase client, which is the one the page already uses for
     * signing in - so there is one session, one key and one place that knows
     * about Supabase at all.
     */
    function CloudCatalog(options) {
        var settings = options || {};
        this.client = settings.client || null;
        this.audioBucket = settings.audioBucket || 'catalog-audio';
        this.artworkBucket = settings.artworkBucket || 'catalog-artwork';
        // Where each track's and album's file is, kept only in memory and only
        // for as long as the page is open. Never written down: a signed
        // address is a temporary key, and keeping one is keeping a key.
        this.paths = new Map();
        this.signed = new Map();
        // The read that fills the table above, while it is happening.
        this.indexed = null;
    }

    /** Is there anything to read from? */
    CloudCatalog.prototype.available = function () {
        return Boolean(this.client);
    };

    /**
     * Everything published, as albums and tracks.
     *
     * One read of each table. The counts and lengths an album carries are
     * worked out here rather than asked for, because they are simply what its
     * tracks add up to.
     */
    CloudCatalog.prototype.read = function () {
        var self = this;
        if (!this.client) return Promise.reject(new Error('Supabase is not configured.'));

        return Promise.all([
            this.client.from('catalog_albums').select(ALBUM_COLUMNS).order('title', { ascending: true }),
            this.client.from('catalog_tracks').select(TRACK_COLUMNS).order('title', { ascending: true })
        ]).then(function (answers) {
            var albumAnswer = answers[0];
            var trackAnswer = answers[1];

            if (albumAnswer.error) throw albumAnswer.error;
            if (trackAnswer.error) throw trackAnswer.error;

            var albums = (albumAnswer.data || []).map(mapAlbum);
            var tracks = (trackAnswer.data || []).map(mapTrack);

            // Where each file is, remembered so an address can be signed for it
            // when it is actually needed.
            self.paths.clear();
            (albumAnswer.data || []).forEach(function (row) {
                self.paths.set(toAlbumId(row.id), { artwork: row.artwork_path || null });
            });
            (trackAnswer.data || []).forEach(function (row) {
                self.paths.set(toTrackId(row.id), { artwork: row.artwork_path || null, audio: row.audio_path || null });
            });

            // Everything is known now, so the smaller read that exists to find
            // out where one file is has nothing left to find out.
            self.indexed = Promise.resolve(true);

            // An album is what its tracks add up to, and each track carries the
            // name of the album it is on.
            var byId = new Map();
            albums.forEach(function (album) {
                byId.set(album.id, album);
            });

            tracks.forEach(function (track) {
                var album = track.albumId ? byId.get(track.albumId) : null;
                if (!album) return;

                track.album = album.title;
                album.trackCount += 1;
                if (Number.isFinite(track.duration)) album.duration += track.duration;
            });

            return { albums: albums, tracks: tracks };
        });
    };

    /**
     * Take note of where the files are, from a catalogue somebody already has.
     *
     * The library is drawn from the device's copy before Supabase is asked
     * anything, and each item in that copy carries the path its picture is
     * kept at. Handing them over here is what lets a cover be signed on that
     * first paint rather than after a round trip - which is the difference
     * between a library that comes back with its artwork and one that comes
     * back as a wall of default covers and stays that way until something
     * forces a redraw.
     */
    CloudCatalog.prototype.learn = function (items) {
        var self = this;

        (items || []).forEach(function (item) {
            if (!item || !item.id) return;

            var metadata = item.metadata || {};
            var artwork = metadata.artworkPath || null;
            if (!artwork) return;

            var known = self.paths.get(item.id) || {};
            if (known.artwork === artwork) return;

            self.paths.set(item.id, { artwork: artwork, audio: known.audio || null });
            // A picture that has moved is a different picture, so an address
            // signed for the old one is no longer worth keeping.
            self.signed.delete('artwork:' + item.id);
        });
    };

    /**
     * Where everything is kept, asked for once.
     *
     * The fallback for an item nothing has said anything about: two small
     * reads of ids and paths, shared by every caller and made at most once per
     * page. The whole catalogue read fills the same table, so this is only
     * ever the first one to arrive.
     */
    CloudCatalog.prototype.index = function () {
        var self = this;
        if (this.indexed) return this.indexed;
        if (!this.client) return Promise.resolve(null);

        this.indexed = Promise.all([
            this.client.from('catalog_albums').select('id,artwork_path'),
            this.client.from('catalog_tracks').select('id,artwork_path,audio_path')
        ])
            .then(function (answers) {
                if (answers[0].error || answers[1].error) return null;

                (answers[0].data || []).forEach(function (row) {
                    var id = toAlbumId(row.id);
                    var known = self.paths.get(id) || {};
                    self.paths.set(id, { artwork: row.artwork_path || null, audio: known.audio || null });
                });

                (answers[1].data || []).forEach(function (row) {
                    self.paths.set(toTrackId(row.id), {
                        artwork: row.artwork_path || null,
                        audio: row.audio_path || null
                    });
                });

                return true;
            })
            .catch(function () {
                // Asking again later is better than never asking again.
                self.indexed = null;
                return null;
            });

        return this.indexed;
    };

    /**
     * A temporary address for one file, or null.
     *
     * Signed when it is asked for and remembered only until it expires, so a
     * song that plays for an hour does not stop halfway and a page open all day
     * does not hold a hundred keys it will never use.
     */
    CloudCatalog.prototype.resolve = function (id, kind) {
        var self = this;
        if (!this.client) return Promise.resolve(null);

        var known = this.paths.get(id);
        var objectPath = known ? known[kind] : null;

        // Nothing here has said where this one is. That is an ordinary state
        // on a first paint from the device's copy, so it is asked rather than
        // given up on - the alternative is the default cover for a picture
        // that is sitting in storage.
        if (!objectPath) {
            return this.index().then(function () {
                var found = self.paths.get(id);
                if (!found || !found[kind]) return null;
                return self.resolve(id, kind);
            });
        }

        var cacheKey = kind + ':' + id;
        var cached = this.signed.get(cacheKey);
        if (cached && cached.expiresAt > Date.now() + 60000) return Promise.resolve(cached.url);

        var bucket = kind === 'audio' ? this.audioBucket : this.artworkBucket;

        return this.client.storage
            .from(bucket)
            .createSignedUrl(objectPath, SIGNED_SECONDS)
            .then(function (answer) {
                if (answer.error || !answer.data || !answer.data.signedUrl) return null;

                self.signed.set(cacheKey, {
                    url: answer.data.signedUrl,
                    expiresAt: Date.now() + SIGNED_SECONDS * 1000
                });
                return answer.data.signedUrl;
            })
            .catch(function () {
                return null;
            });
    };

    /** Where this track's audio is, for as long as the address lasts. */
    CloudCatalog.prototype.resolveAudio = function (trackId) {
        return this.resolve(trackId, 'audio');
    };

    /** And where its picture is. */
    CloudCatalog.prototype.resolveArtwork = function (id) {
        return this.resolve(id, 'artwork');
    };

    /** An address that has expired is asked for again rather than reused. */
    CloudCatalog.prototype.forgetSigned = function (id) {
        this.signed.delete('audio:' + id);
        this.signed.delete('artwork:' + id);
    };

    global.SpotifieCloudCatalog = CloudCatalog;
})(typeof window !== 'undefined' ? window : globalThis);
