/**
 * Spotifie catalogue cache.
 *
 * A copy of the published catalogue, kept on this device so the library can be
 * drawn the instant the page opens instead of after a journey to Supabase.
 * What is kept is only what an administrator has published for everyone: album
 * and song descriptions, and the name of the picture each one uses. It belongs
 * to the machine, not to an account, and a guest reads the same copy a
 * signed-in listener does.
 *
 * Three things are deliberately never written here:
 *
 * - audio, of any kind, from any source;
 * - a resolved media address, because every one of those carries a signature
 *   and expires - stored, it becomes a picture that loads once and is broken
 *   ever after;
 * - anything belonging to a person: their own titles for published albums,
 *   what they have hidden, what they have added. Those live in their own state
 *   and arrive with the request, so the copy on a shared machine says nothing
 *   about whoever used it last.
 *
 * The copy is a convenience and never a source of truth. A version that is not
 * understood, a store that will not open, a record that does not read back:
 * each of those is answered with "no copy", and the page loads the way it
 * always did.
 */
(function (global) {
    'use strict';

    var DB_NAME = 'spotifie-catalog';
    var DB_VERSION = 1;
    var STORE = 'snapshots';
    var SNAPSHOT_KEY = 'global';

    /**
     * What the records in the store look like.
     *
     * Raise this when the shape changes. A record written by an older version
     * is not migrated and not read - it is dropped, and the next visit writes
     * a fresh one. There is nothing in it that cannot be fetched again.
     */
    var SCHEMA_VERSION = 1;

    /** Fields kept for an album. Anything else is left behind. */
    var ALBUM_FIELDS = ['id', 'source', 'title', 'artist', 'albumArtist', 'description', 'trackCount', 'duration'];

    /** Fields kept for a song. */
    var TRACK_FIELDS = ['id', 'source', 'title', 'artist', 'albumArtist', 'album', 'albumId', 'duration'];

    /** Fields kept from an item's metadata. */
    var METADATA_FIELDS = [
        'trackNumber',
        'discNumber',
        'format',
        'hasArtwork',
        'artworkVersion',
        'createdAt',
        'updatedAt'
    ];

    /**
     * An address worth writing down, or null.
     *
     * Only this server's own addresses qualify, and only plain ones. Anything
     * absolute is somewhere else, which is where a signed address lives; a
     * query is how a signature, a ticket or an expiry is carried. Either is
     * refused outright rather than examined, so there is no reading of one
     * that could let one through.
     */
    function stableUrl(value) {
        if (typeof value !== 'string') return null;

        var url = value.trim();
        if (!url) return null;
        if (url.charAt(0) !== '/' || url.charAt(1) === '/') return null;
        if (url.indexOf('?') !== -1 || url.indexOf('#') !== -1) return null;

        return url;
    }

    function pick(source, fields) {
        var out = {};
        for (var i = 0; i < fields.length; i += 1) {
            var value = source[fields[i]];
            if (value !== undefined) out[fields[i]] = value;
        }
        return out;
    }

    function cleanMetadata(metadata) {
        return metadata && typeof metadata === 'object' ? pick(metadata, METADATA_FIELDS) : {};
    }

    /** One published album, reduced to what is safe and useful to keep. */
    function cleanAlbum(album) {
        if (!album || album.source !== 'global' || !album.id) return null;

        var out = pick(album, ALBUM_FIELDS);
        out.metadata = cleanMetadata(album.metadata);
        out.artworkUrl = stableUrl(album.artworkUrl);
        return out;
    }

    /** One published song, the same way. */
    function cleanTrack(track) {
        if (!track || track.source !== 'global' || !track.id) return null;

        var out = pick(track, TRACK_FIELDS);
        out.metadata = cleanMetadata(track.metadata);
        out.artworkUrl = stableUrl(track.artworkUrl);
        out.streamUrl = stableUrl(track.streamUrl);
        return out;
    }

    function cleanAll(items, clean) {
        var out = [];
        var list = items || [];
        for (var i = 0; i < list.length; i += 1) {
            var item = clean(list[i]);
            if (item) out.push(item);
        }
        return out;
    }

    /**
     * What one item is, right now, in as few characters as say it.
     *
     * Its id, when it last changed, and which picture it carries. Two
     * catalogues whose items all agree on those three are the same catalogue
     * as far as anything on screen is concerned, which is what lets a check
     * that finds no change cost nothing.
     */
    function stampOf(item) {
        var metadata = item.metadata || {};
        return [item.id, metadata.updatedAt || '', metadata.artworkVersion || ''].join('~');
    }

    /**
     * One short string for a whole catalogue.
     *
     * Order is not information here - the server sorts, and a re-sort is not a
     * change - so the stamps are sorted before they are joined.
     */
    function fingerprint(albums, tracks) {
        var stamps = [];
        var i;

        for (i = 0; i < (albums || []).length; i += 1) stamps.push('a:' + stampOf(albums[i]));
        for (i = 0; i < (tracks || []).length; i += 1) stamps.push('t:' + stampOf(tracks[i]));

        stamps.sort();
        return String(stamps.length) + ':' + hash(stamps.join('|'));
    }

    /** A small, stable number for a string. Not a secret, just a comparison. */
    function hash(text) {
        var value = 5381;
        for (var i = 0; i < text.length; i += 1) {
            value = ((value << 5) + value + text.charCodeAt(i)) | 0;
        }
        return (value >>> 0).toString(36);
    }

    /**
     * What changed between two catalogues.
     *
     * Answers in terms of the items themselves, so a caller can replace the
     * few that moved rather than rebuilding everything. `changed` is false when
     * nothing at all is different, which is the common case on a refresh and
     * the one worth making free.
     */
    function diff(previous, next) {
        var before = indexBy(previous);
        var after = indexBy(next);

        var added = [];
        var updated = [];
        var removed = [];

        Object.keys(after).forEach(function (id) {
            var was = before[id];
            if (!was) {
                added.push(after[id]);
                return;
            }
            if (stampOf(was) !== stampOf(after[id])) updated.push(after[id]);
        });

        Object.keys(before).forEach(function (id) {
            if (!after[id]) removed.push(before[id]);
        });

        return {
            changed: added.length > 0 || updated.length > 0 || removed.length > 0,
            added: added,
            updated: updated,
            removed: removed
        };
    }

    function indexBy(items) {
        var out = {};
        var list = items || [];
        for (var i = 0; i < list.length; i += 1) {
            if (list[i] && list[i].id) out[list[i].id] = list[i];
        }
        return out;
    }

    // ============================================
    // The store itself
    // ============================================

    var openPromise = null;

    function unavailable() {
        return typeof indexedDB === 'undefined' || !indexedDB;
    }

    /**
     * Open the store, once.
     *
     * A browser with storage turned off, a private window, a database that
     * will not open: all of them answer null. Nothing above this cares which,
     * because the answer to every one of them is the same - carry on without a
     * copy.
     */
    function openDatabase() {
        if (unavailable()) return Promise.resolve(null);
        if (openPromise) return openPromise;

        openPromise = new Promise(function (resolve) {
            var request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) {
                resolve(null);
                return;
            }

            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
            };
            request.onsuccess = function () {
                resolve(request.result);
            };
            request.onerror = function () {
                resolve(null);
            };
            request.onblocked = function () {
                resolve(null);
            };
        });

        return openPromise;
    }

    function withStore(mode, work) {
        return openDatabase().then(function (db) {
            if (!db) return null;

            return new Promise(function (resolve) {
                var transaction;
                try {
                    transaction = db.transaction(STORE, mode);
                } catch (e) {
                    resolve(null);
                    return;
                }

                var request;
                try {
                    request = work(transaction.objectStore(STORE));
                } catch (e) {
                    resolve(null);
                    return;
                }

                if (!request) {
                    transaction.oncomplete = function () {
                        resolve(null);
                    };
                    transaction.onerror = function () {
                        resolve(null);
                    };
                    return;
                }

                request.onsuccess = function () {
                    resolve(request.result === undefined ? null : request.result);
                };
                request.onerror = function () {
                    resolve(null);
                };
            });
        });
    }

    /**
     * The copy of the published catalogue this machine holds, or null.
     *
     * A record from an older version of this file, or one that does not read
     * back as a catalogue, is treated as no copy at all and cleared away. A
     * refresh must never be able to fail because of something cached.
     */
    function read() {
        return withStore('readonly', function (store) {
            return store.get(SNAPSHOT_KEY);
        })
            .then(function (record) {
                if (!record || record.schemaVersion !== SCHEMA_VERSION) {
                    if (record) clear();
                    return null;
                }
                if (!Array.isArray(record.albums) || !Array.isArray(record.tracks)) {
                    clear();
                    return null;
                }

                return {
                    schemaVersion: record.schemaVersion,
                    cachedAt: record.cachedAt || 0,
                    fingerprint: record.fingerprint || fingerprint(record.albums, record.tracks),
                    albums: record.albums,
                    tracks: record.tracks
                };
            })
            .catch(function () {
                return null;
            });
    }

    /**
     * Keep this catalogue for next time.
     *
     * Everything is put through the same reduction on the way in, so what is
     * written is decided here rather than by whoever happens to be calling.
     */
    function write(catalogue) {
        var albums = cleanAll(catalogue && catalogue.albums, cleanAlbum);
        var tracks = cleanAll(catalogue && catalogue.tracks, cleanTrack);

        var record = {
            key: SNAPSHOT_KEY,
            schemaVersion: SCHEMA_VERSION,
            cachedAt: Date.now(),
            fingerprint: fingerprint(albums, tracks),
            albums: albums,
            tracks: tracks
        };

        return withStore('readwrite', function (store) {
            return store.put(record);
        })
            .then(function (stored) {
                // Nothing came back from the store, so nothing was kept - a
                // browser that keeps nothing, rather than a failure.
                return stored === null ? null : record;
            })
            .catch(function () {
                return null;
            });
    }

    /** Throw the copy away. The catalogue itself is untouched. */
    function clear() {
        return withStore('readwrite', function (store) {
            return store.delete(SNAPSHOT_KEY);
        }).catch(function () {
            return null;
        });
    }

    global.spotifieCatalogCache = {
        SCHEMA_VERSION: SCHEMA_VERSION,
        read: read,
        write: write,
        clear: clear,
        diff: diff,
        fingerprint: fingerprint,
        // Exposed for the tests, which check that nothing temporary and
        // nothing personal can get into a record.
        _cleanAlbum: cleanAlbum,
        _cleanTrack: cleanTrack,
        _stableUrl: stableUrl,
        _stampOf: stampOf
    };
})(typeof window !== 'undefined' ? window : globalThis);
