'use strict';

/**
 * Global (admin) catalogue backed by Supabase.
 *
 * Rows live in catalog_albums / catalog_tracks; the audio and artwork files
 * live in private Storage buckets, reachable only through short-lived signed
 * URLs generated here.
 *
 * Reading is public: a guest with no session browses and plays the admin
 * catalogue just like a signed-in listener. Writing is administrator-only,
 * enforced by Row Level Security - this module never holds a service-role
 * key, so it cannot bypass that for anyone.
 *
 * Storage paths never leave this module. Callers get namespaced IDs and,
 * on request, a short-lived signed URL.
 */

const crypto = require('crypto');

const {
    SupabaseError,
    selectRows,
    insertRow,
    updateRows,
    deleteRows,
    createSignedUrl,
    removeStorageObject
} = require('./supabaseRest');

const AUDIO_BUCKET = process.env.SUPABASE_AUDIO_BUCKET || 'catalog-audio';
const ARTWORK_BUCKET = process.env.SUPABASE_ARTWORK_BUCKET || 'catalog-artwork';
const SIGNED_URL_TTL_SECONDS = 3600;

const TRACK_PREFIX = 'global:';
const ALBUM_PREFIX = 'global-album:';

const ALBUM_COLUMNS = 'id,title,artist,album_artist,description,artwork_path,created_by,created_at,updated_at';

// The same list without the description column, used against a project where
// the column has not been added yet. The catalogue keeps working; those albums
// simply read back with no description.
const ALBUM_COLUMNS_WITHOUT_DESCRIPTION = ALBUM_COLUMNS.split(',')
    .filter((column) => column !== 'description')
    .join(',');
const TRACK_COLUMNS =
    'id,album_id,title,artist,album_artist,track_number,disc_number,duration,mime_type,audio_path,artwork_path,created_by,created_at,updated_at';

function toGlobalTrackId(uuid) {
    return TRACK_PREFIX + uuid;
}

function toGlobalAlbumId(uuid) {
    return ALBUM_PREFIX + uuid;
}

/** Extract the uuid from a namespaced id, or null when it is not global. */
function parseGlobalTrackId(id) {
    if (typeof id !== 'string' || !id.startsWith(TRACK_PREFIX)) return null;
    const uuid = id.slice(TRACK_PREFIX.length);
    return uuid.length ? uuid : null;
}

function parseGlobalAlbumId(id) {
    if (typeof id !== 'string' || !id.startsWith(ALBUM_PREFIX)) return null;
    const uuid = id.slice(ALBUM_PREFIX.length);
    return uuid.length ? uuid : null;
}

/** True for the PostgREST error raised when a column does not exist yet. */
function isMissingColumnError(err) {
    const message = String((err && err.message) || '');
    const code = err && err.body && err.body.code;
    return code === '42703' || /column .* does not exist/i.test(message);
}

function cleanString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
}

function numberOrNull(value) {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A short, stable name for whichever artwork file an album or track points at.
 *
 * The browser needs to know when a cover has been replaced, so that a picture
 * it has already downloaded is not shown for a cover that has since changed.
 * The Storage path answers that question exactly, but a path is the one thing
 * this module never lets out. A hash of it carries the same information and
 * reveals nothing: same file, same name; new file, new name.
 *
 * Null when there is no artwork at all, which is not an error - the caller
 * shows the default cover.
 */
function artworkVersionOf(objectPath) {
    if (typeof objectPath !== 'string' || !objectPath.trim()) return null;
    return crypto.createHash('sha1').update(objectPath).digest('hex').slice(0, 16);
}

/**
 * How long a fetched catalogue may be reused.
 *
 * One page load asks for albums and for tracks, and each of those needs the
 * whole catalogue: without this the same rows are pulled from Supabase twice
 * before anything is drawn. The window is deliberately small - it exists to
 * collapse the requests of a single visit, not to serve stale rows - and an
 * administrator's own write clears it outright.
 */
const CATALOG_TTL_MS = Number(process.env.SPOTIFIE_CATALOG_TTL_MS) || 5000;

/**
 * Map a catalog_tracks row onto the platform-neutral track model.
 * The UI sees IDs and URLs only - never a bucket or an object path.
 */
function mapTrack(row) {
    const id = toGlobalTrackId(row.id);
    const artist = cleanString(row.artist) || 'Unknown Artist';

    return {
        id: id,
        source: 'global',
        title: cleanString(row.title) || 'Untitled',
        artist: artist,
        albumArtist: cleanString(row.album_artist) || artist,
        album: null, // filled in by the catalogue service from the album row
        albumId: row.album_id ? toGlobalAlbumId(row.album_id) : null,
        duration: numberOrNull(row.duration),
        artworkUrl: '/api/catalog/tracks/' + encodeURIComponent(id) + '/artwork',
        streamUrl: '/api/catalog/tracks/' + encodeURIComponent(id) + '/stream',
        metadata: {
            trackNumber: numberOrNull(row.track_number),
            discNumber: numberOrNull(row.disc_number),
            format: cleanString(row.mime_type),
            hasArtwork: Boolean(row.artwork_path),
            // Which picture this is, without saying where it is kept.
            artworkVersion: artworkVersionOf(row.artwork_path),
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null
        }
    };
}

function mapAlbum(row) {
    const artist = cleanString(row.artist);
    const albumArtist = cleanString(row.album_artist) || artist || 'Unknown Artist';
    const id = toGlobalAlbumId(row.id);

    return {
        id: id,
        source: 'global',
        title: cleanString(row.title) || 'Untitled Album',
        artist: artist,
        albumArtist: albumArtist,
        // The album's own text. It is independent of the artist: an album
        // without one has no description, never a copy of the artist name.
        description: cleanString(row.description),
        artworkUrl: '/api/catalog/albums/' + encodeURIComponent(id) + '/artwork',
        trackCount: 0,
        duration: 0,
        metadata: {
            hasArtwork: Boolean(row.artwork_path),
            artworkVersion: artworkVersionOf(row.artwork_path),
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null
        }
    };
}

class GlobalCatalog {
    constructor(options) {
        const settings = options || {};
        this.audioBucket = settings.audioBucket || AUDIO_BUCKET;
        this.artworkBucket = settings.artworkBucket || ARTWORK_BUCKET;
        this.rest = settings.rest || {
            selectRows,
            insertRow,
            updateRows,
            deleteRows,
            createSignedUrl,
            removeStorageObject
        };

        // The last catalogue read, and the read still in flight. Two callers
        // asking at once share one journey to Supabase; a caller asking again
        // a moment later is answered from what came back.
        this.catalogTtlMs = settings.catalogTtlMs === undefined ? CATALOG_TTL_MS : settings.catalogTtlMs;
        this.catalogCache = new Map();
        this.catalogInFlight = new Map();
    }

    /**
     * Forget what was read, so the next question goes to Supabase.
     *
     * Called after every administrator write: the person who just published an
     * album must see it, and so must the next listener to open the library.
     */
    invalidateCatalog() {
        this.catalogCache.clear();
        this.catalogInFlight.clear();
    }

    /**
     * Read the whole global catalogue.
     *
     * No session is needed: the admin catalogue is public to read, so a guest
     * request goes out with the anon key alone and Row Level Security decides
     * what comes back. Writes still require an administrator.
     *
     * Returns { available, albums, tracks, error } - a Supabase outage is
     * reported, never thrown, so the local library keeps working.
     */
    async fetchCatalog(token) {
        // Rows are the same for everyone - the catalogue is public to read -
        // but the request carries a session when there is one, so the two are
        // kept apart rather than one being answered with the other's read.
        const key = token ? 'session' : 'anon';

        const fresh = this.catalogCache.get(key);
        if (fresh && fresh.expiresAt > Date.now()) return fresh.value;

        const running = this.catalogInFlight.get(key);
        if (running) return running;

        const journey = this.readCatalog(token)
            .then((value) => {
                // A failed read is not worth remembering: the next caller
                // should try again rather than inherit an outage.
                if (value.available && this.catalogTtlMs > 0) {
                    this.catalogCache.set(key, { value: value, expiresAt: Date.now() + this.catalogTtlMs });
                }
                return value;
            })
            .finally(() => {
                this.catalogInFlight.delete(key);
            });

        this.catalogInFlight.set(key, journey);
        return journey;
    }

    /** The read itself, without the sharing. */
    async readCatalog(token) {
        try {
            const [albumRows, trackRows] = await Promise.all([
                this.selectAlbumRows('&order=title.asc', token),
                this.rest.selectRows('catalog_tracks', 'select=' + TRACK_COLUMNS + '&order=title.asc', token)
            ]);

            if (!Array.isArray(albumRows) || !Array.isArray(trackRows)) {
                return { available: false, albums: [], tracks: [], error: 'Malformed catalogue response' };
            }

            const albums = albumRows.map(mapAlbum);
            const albumsById = new Map(albums.map((album) => [album.id, album]));

            const tracks = trackRows.map((row) => {
                const track = mapTrack(row);
                const album = track.albumId ? albumsById.get(track.albumId) : null;
                track.album = album ? album.title : 'Unknown Album';
                if (album) {
                    album.trackCount += 1;
                    if (track.duration) album.duration += track.duration;
                }
                return track;
            });

            return { available: true, albums: albums, tracks: tracks, error: null };
        } catch (err) {
            return {
                available: false,
                albums: [],
                tracks: [],
                error: err instanceof SupabaseError ? err.message : String(err && err.message)
            };
        }
    }

    /**
     * The catalogue rows as they are stored, object paths included.
     *
     * Everything else in this module maps rows into the platform-neutral model
     * and drops the paths on the way, which is right for anything the browser
     * will see. The maintenance audit is the one caller that needs the paths -
     * comparing rows against what is in the buckets is the whole of its job -
     * and it runs inside the server, for an administrator, and reports counts
     * and names rather than paths.
     */
    async readRawRows(token) {
        const [albumRows, trackRows] = await Promise.all([
            this.selectAlbumRows('&order=title.asc', token),
            this.rest.selectRows('catalog_tracks', 'select=' + TRACK_COLUMNS + '&order=title.asc', token)
        ]);

        return {
            albums: Array.isArray(albumRows) ? albumRows : [],
            tracks: Array.isArray(trackRows) ? trackRows : []
        };
    }

    async getTrackRow(uuid, token) {
        const rows = await this.rest.selectRows(
            'catalog_tracks',
            'select=' + TRACK_COLUMNS + '&id=eq.' + encodeURIComponent(uuid) + '&limit=1',
            token
        );
        return Array.isArray(rows) && rows.length ? rows[0] : null;
    }

    /**
     * Select album rows, retrying without the description column when the
     * database has not been migrated yet.
     */
    async selectAlbumRows(filter, token) {
        try {
            return await this.rest.selectRows('catalog_albums', 'select=' + ALBUM_COLUMNS + filter, token);
        } catch (err) {
            if (!isMissingColumnError(err)) throw err;
            this.albumDescriptionMissing = true;
            return this.rest.selectRows('catalog_albums', 'select=' + ALBUM_COLUMNS_WITHOUT_DESCRIPTION + filter, token);
        }
    }

    async getAlbumRow(uuid, token) {
        const rows = await this.selectAlbumRows('&id=eq.' + encodeURIComponent(uuid) + '&limit=1', token);
        return Array.isArray(rows) && rows.length ? rows[0] : null;
    }

    /**
     * The one place a Storage object becomes a URL a browser can use.
     *
     * Every context goes through here - guest player, signed-in player and
     * admin dashboard - so all three see exactly the same media. Only the two
     * catalogue buckets are reachable: an arbitrary bucket or path is refused
     * before any request is made.
     *
     * The URL is short-lived and generated on demand. Nothing here is ever
     * written back to the database, so an expired URL is simply resolved
     * again.
     */
    async resolveGlobalMedia(bucket, objectPath, token) {
        if (!objectPath || typeof objectPath !== 'string') return null;
        if (bucket !== this.audioBucket && bucket !== this.artworkBucket) return null;
        if (objectPath.includes('..')) return null;

        const url = await this.rest.createSignedUrl(bucket, objectPath, SIGNED_URL_TTL_SECONDS, token);
        return { url: url, expiresIn: SIGNED_URL_TTL_SECONDS };
    }

    /**
     * Playable audio for a global track.
     * Works with or without a session: the published catalogue is read-only
     * public, so a guest resolves the same URL a member does.
     */
    async resolveGlobalAudio(trackId, token) {
        const uuid = parseGlobalTrackId(trackId);
        if (!uuid) return null;

        const row = await this.getTrackRow(uuid, token);
        if (!row || !row.audio_path) return null;

        const media = await this.resolveGlobalMedia(this.audioBucket, row.audio_path, token);
        if (!media) return null;

        return {
            url: media.url,
            expiresIn: media.expiresIn,
            mimeType: row.mime_type || 'audio/mpeg'
        };
    }

    /**
     * Artwork for a global track or album.
     * A track uses its own artwork, otherwise its album's. Returning null just
     * means there is none, and the caller shows the default cover - it is not
     * an error.
     */
    async resolveGlobalArtwork(id, token) {
        const trackUuid = parseGlobalTrackId(id);
        const albumUuid = parseGlobalAlbumId(id);

        let artworkPath = null;
        if (trackUuid) {
            const row = await this.getTrackRow(trackUuid, token);
            if (!row) return null;
            artworkPath = row.artwork_path;

            if (!artworkPath && row.album_id) {
                const album = await this.getAlbumRow(row.album_id, token);
                artworkPath = album ? album.artwork_path : null;
            }
        } else if (albumUuid) {
            const row = await this.getAlbumRow(albumUuid, token);
            if (!row) return null;
            artworkPath = row.artwork_path;
        } else {
            return null;
        }

        if (!artworkPath) return null;
        return this.resolveGlobalMedia(this.artworkBucket, artworkPath, token);
    }

    /**
     * Which Storage object holds the published artwork for this id, and what
     * that object is currently called.
     *
     * Only the published picture: a listener's own cover for an album is a
     * local file and is served by this machine, never from here. The path
     * stays inside this module - callers get the bucket-relative object and
     * its version, and only so that the artwork route can read the bytes and
     * name the cached copy.
     */
    async findArtworkObject(id, token) {
        const trackUuid = parseGlobalTrackId(id);
        const albumUuid = parseGlobalAlbumId(id);

        let artworkPath = null;
        if (trackUuid) {
            const row = await this.getTrackRow(trackUuid, token);
            if (!row) return null;
            artworkPath = row.artwork_path;

            if (!artworkPath && row.album_id) {
                const album = await this.getAlbumRow(row.album_id, token);
                artworkPath = album ? album.artwork_path : null;
            }
        } else if (albumUuid) {
            const row = await this.getAlbumRow(albumUuid, token);
            if (!row) return null;
            artworkPath = row.artwork_path;
        } else {
            return null;
        }

        if (!artworkPath) return null;

        const media = await this.resolveGlobalMedia(this.artworkBucket, artworkPath, token);
        if (!media) return null;

        return { url: media.url, expiresIn: media.expiresIn, version: artworkVersionOf(artworkPath) };
    }

    /** Kept as the earlier names; both delegate to the canonical resolver. */
    getStreamUrl(trackId, token) {
        return this.resolveGlobalAudio(trackId, token);
    }

    getArtworkUrl(id, token) {
        return this.resolveGlobalArtwork(id, token);
    }

    // ============================================
    // Administrator writes
    //
    // These run with the caller's token, so Supabase RLS rejects them for
    // anyone who is not in app_admins. The server checks admin rights first
    // as well, but RLS is the control that actually matters.
    // ============================================

    async createAlbum(payload, token) {
        const row = {
            title: payload.title,
            artist: payload.artist || null,
            album_artist: payload.albumArtist || payload.artist || null,
            description: payload.description || null,
            artwork_path: payload.artworkPath || null
        };

        let rows;
        try {
            rows = await this.rest.insertRow('catalog_albums', row, token);
        } catch (err) {
            if (!isMissingColumnError(err)) throw err;
            // The description column has not been added yet: save everything
            // else rather than failing the whole album.
            this.albumDescriptionMissing = true;
            delete row.description;
            rows = await this.rest.insertRow('catalog_albums', row, token);
        }

        const created = Array.isArray(rows) ? rows[0] : rows;
        this.invalidateCatalog();
        return mapAlbum(created);
    }

    async updateAlbum(albumId, patch, token) {
        const uuid = parseGlobalAlbumId(albumId);
        if (!uuid) throw new SupabaseError('Not a global album id', 400, null);

        // Remember the cover being replaced. It is removed only after the row
        // points at the new one, so a failed update never destroys the working
        // artwork. A patch that leaves artwork_path alone keeps it as it is.
        let previousArtworkPath = null;
        if (patch.artwork_path !== undefined) {
            const existing = await this.getAlbumRow(uuid, token);
            if (existing && existing.artwork_path && existing.artwork_path !== patch.artwork_path) {
                previousArtworkPath = existing.artwork_path;
            }
        }

        let rows;
        try {
            rows = await this.rest.updateRows('catalog_albums', 'id=eq.' + encodeURIComponent(uuid), patch, token);
        } catch (err) {
            if (!isMissingColumnError(err) || patch.description === undefined) throw err;
            this.albumDescriptionMissing = true;
            const withoutDescription = Object.assign({}, patch);
            delete withoutDescription.description;
            rows = await this.rest.updateRows(
                'catalog_albums',
                'id=eq.' + encodeURIComponent(uuid),
                withoutDescription,
                token
            );
        }

        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row) return null;

        if (previousArtworkPath) {
            await this.safeRemove(this.artworkBucket, previousArtworkPath, token);
        }

        this.invalidateCatalog();
        return mapAlbum(row);
    }

    async createTrack(payload, token) {
        const albumUuid = payload.albumId ? parseGlobalAlbumId(payload.albumId) : null;

        const rows = await this.rest.insertRow(
            'catalog_tracks',
            {
                album_id: albumUuid,
                title: payload.title,
                artist: payload.artist || null,
                album_artist: payload.albumArtist || null,
                track_number: payload.trackNumber || null,
                disc_number: payload.discNumber || null,
                duration: payload.duration || null,
                mime_type: payload.mimeType || null,
                audio_path: payload.audioPath,
                artwork_path: payload.artworkPath || null
            },
            token
        );
        const row = Array.isArray(rows) ? rows[0] : rows;
        this.invalidateCatalog();
        return mapTrack(row);
    }

    async updateTrack(trackId, patch, token) {
        const uuid = parseGlobalTrackId(trackId);
        if (!uuid) throw new SupabaseError('Not a global track id', 400, null);

        const rows = await this.rest.updateRows(
            'catalog_tracks',
            'id=eq.' + encodeURIComponent(uuid),
            patch,
            token
        );
        const row = Array.isArray(rows) ? rows[0] : rows;
        this.invalidateCatalog();
        return row ? mapTrack(row) : null;
    }

    /**
     * Permanently delete a global track: the row first, then its files.
     * Admin-only, and never reachable from the per-user hide path.
     */
    async deleteTrack(trackId, token) {
        const uuid = parseGlobalTrackId(trackId);
        if (!uuid) throw new SupabaseError('Not a global track id', 400, null);

        const row = await this.getTrackRow(uuid, token);
        if (!row) return { deleted: false, reason: 'not-found' };

        await this.rest.deleteRows('catalog_tracks', 'id=eq.' + encodeURIComponent(uuid), token);

        const removed = [];
        if (row.audio_path) removed.push(this.safeRemove(this.audioBucket, row.audio_path, token));
        if (row.artwork_path) removed.push(this.safeRemove(this.artworkBucket, row.artwork_path, token));
        await Promise.all(removed);

        this.invalidateCatalog();
        return { deleted: true, id: toGlobalTrackId(uuid) };
    }

    /** Permanently delete a global album and the tracks that belong to it. */
    async deleteAlbum(albumId, token) {
        const uuid = parseGlobalAlbumId(albumId);
        if (!uuid) throw new SupabaseError('Not a global album id', 400, null);

        const album = await this.getAlbumRow(uuid, token);
        if (!album) return { deleted: false, reason: 'not-found' };

        const trackRows = await this.rest.selectRows(
            'catalog_tracks',
            'select=' + TRACK_COLUMNS + '&album_id=eq.' + encodeURIComponent(uuid),
            token
        );

        for (const row of Array.isArray(trackRows) ? trackRows : []) {
            await this.deleteTrack(toGlobalTrackId(row.id), token);
        }

        await this.rest.deleteRows('catalog_albums', 'id=eq.' + encodeURIComponent(uuid), token);
        if (album.artwork_path) await this.safeRemove(this.artworkBucket, album.artwork_path, token);

        this.invalidateCatalog();
        return { deleted: true, id: toGlobalAlbumId(uuid), tracksDeleted: (trackRows || []).length };
    }

    /** Remove a Storage object, ignoring "already gone" failures. */
    async safeRemove(bucket, objectPath, token) {
        try {
            await this.rest.removeStorageObject(bucket, objectPath, token);
            return true;
        } catch (e) {
            console.warn('Could not remove storage object', bucket + '/' + objectPath, e.message);
            return false;
        }
    }
}

module.exports = {
    GlobalCatalog,
    AUDIO_BUCKET,
    ARTWORK_BUCKET,
    TRACK_PREFIX,
    ALBUM_PREFIX,
    toGlobalTrackId,
    toGlobalAlbumId,
    parseGlobalTrackId,
    parseGlobalAlbumId,
    mapTrack,
    mapAlbum
};
