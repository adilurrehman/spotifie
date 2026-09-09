'use strict';

/**
 * LibraryService - the platform-neutral music library boundary.
 *
 * Player and UI code talks to this service (directly on the server, or over
 * the /api/library endpoints in the browser) and never to the filesystem.
 * Swapping the storage backend means passing a different adapter; the shapes
 * returned here stay the same on every platform.
 *
 * Returned objects never contain absolute paths.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { MUSIC_ROOT, ARTWORK_DIR, DATA_DIR } = require('./config');
const { LibraryIndex } = require('./libraryIndex');
const { LocalFileSystemAdapter } = require('./adapters/localFileSystemAdapter');
const { ensureDir } = require('./safeFs');

const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_ALBUM = 'Unknown Album';

const ARTWORK_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp'
};

function stableId(value) {
    return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function cleanString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
}

function firstNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * How many files are stat-ed at once during reconciliation.
 *
 * A stat is cheap but not free, and a library can hold thousands. This is
 * enough to keep the disk working and few enough that starting up is never
 * waiting behind a queue of them.
 */
const RECONCILE_CONCURRENCY = 32;

class LibraryService {
    constructor(options) {
        const settings = options || {};
        this.musicRoot = settings.musicRoot || MUSIC_ROOT;
        this.adapter = settings.adapter || new LocalFileSystemAdapter({ musicRoot: this.musicRoot });
        this.index = settings.index || new LibraryIndex(settings.indexFile);
        this.artworkDir = settings.artworkDir || ARTWORK_DIR;
        this.dataDir = settings.dataDir || DATA_DIR;
        this.loaded = false;
        this.scanning = null;
    }

    load() {
        if (!this.loaded) {
            this.index.load();
            this.loaded = true;
        }
        return this.index.data;
    }

    /** Library status without exposing any real path. */
    getStatus() {
        this.load();
        const description = this.adapter.describe();
        return {
            backend: description.kind,
            rootLabel: description.rootLabel,
            rootAvailable: this.adapter.rootExists ? this.adapter.rootExists() : true,
            trackCount: this.index.listTracks().length,
            updatedAt: this.index.data.updatedAt,
            indexRecovered: this.index.recovered
        };
    }

    /** Rescan the configured music root. Concurrent calls share one scan. */
    scan() {
        if (this.scanning) return this.scanning;
        this.scanning = this._scan().finally(() => {
            this.scanning = null;
        });
        return this.scanning;
    }

    async _scan() {
        this.load();

        const files = await this.adapter.listFiles();
        const nextFiles = {};
        const nextTracks = {};
        const errors = [];
        let hashed = 0;
        let reused = 0;

        for (const file of files) {
            let id = this.index.getCachedId(file.relativePath, file.size, file.mtimeMs);

            if (id) {
                reused += 1;
            } else {
                try {
                    id = await this.adapter.hashFile(file.relativePath);
                    hashed += 1;
                } catch (e) {
                    errors.push({ file: path.basename(file.relativePath), reason: 'unreadable' });
                    continue;
                }
            }

            nextFiles[file.relativePath] = { size: file.size, mtimeMs: file.mtimeMs, id };

            if (nextTracks[id]) continue;

            // Content-identical file that only moved or was renamed: reuse the
            // record we already have, so the track ID survives the move.
            const known = this.index.getTrack(id);
            if (known && known.contentHash === id) {
                nextTracks[id] = Object.assign({}, known, {
                    relativePath: file.relativePath,
                    fileName: path.basename(file.relativePath),
                    size: file.size,
                    mtimeMs: file.mtimeMs
                });
                continue;
            }

            try {
                nextTracks[id] = await this._buildTrack(id, file);
            } catch (e) {
                errors.push({ file: path.basename(file.relativePath), reason: 'metadata' });
                nextTracks[id] = this._fallbackTrack(id, file);
            }
        }

        this.index.replaceContents(nextFiles, nextTracks, this.adapter.describe().rootLabel);

        try {
            this.index.save();
        } catch (e) {
            errors.push({ file: 'library.json', reason: 'index-write-failed' });
        }

        return {
            trackCount: Object.keys(nextTracks).length,
            fileCount: files.length,
            hashed,
            reused,
            errors
        };
    }

    /**
     * Index one file that has just appeared in the root, without rescanning
     * everything. Same pipeline as a scan: content hash for the id, tags for
     * the metadata, embedded artwork cached beside it.
     *
     * A file the index already knows - same place, same size, same time - is
     * not read at all: it is not hashed, its tags are not parsed again and its
     * artwork is not extracted again. That is what makes looking again cheap
     * however large the collection is.
     *
     * The result says what actually happened: 'unchanged' for a file that was
     * already known, 'moved' when the same audio turned up under a new name,
     * and 'new' when it had not been seen before.
     */
    async indexFile(relativePath, options) {
        this.load();
        const settings = options || {};

        const stats = this.adapter.statFile(relativePath);
        if (!stats) throw new Error('File is not readable');

        const file = { relativePath: relativePath, size: stats.size, mtimeMs: stats.mtimeMs };

        // Nothing about this file has changed since it was indexed: the record
        // that is there is still right, and reading the file would only cost
        // time.
        if (!settings.force) {
            const cachedId = this.index.getCachedId(relativePath, file.size, file.mtimeMs);
            const cached = cachedId ? this.index.getTrack(cachedId) : null;
            if (cached) {
                return { id: cachedId, track: this.toPublicTrack(cached), known: true, state: 'unchanged' };
            }
        }

        // Read once, and - when asked - refuse anything the reader cannot
        // make sense of as audio, rather than keeping a nameless entry for it.
        let parsed = null;
        if (settings.requireAudio) {
            parsed = await this.adapter.readTags(relativePath);
            const format = parsed && parsed.format;
            if (!format || !(format.container || format.codec)) throw new Error('File is not audio');
        }

        const id = await this.adapter.hashFile(relativePath);
        const known = this.index.getTrack(id);

        // The same audio under a new name keeps the record it already has.
        const track = known
            ? Object.assign({}, known, {
                  relativePath: relativePath,
                  fileName: path.basename(relativePath),
                  size: file.size,
                  mtimeMs: file.mtimeMs
              })
            : await this._buildTrack(id, file, parsed);

        this.index.setFileEntry(relativePath, file.size, file.mtimeMs, id);
        this.index.setTrack(track);
        this.index.save();

        return {
            id: id,
            track: this.toPublicTrack(track),
            known: Boolean(known),
            state: known ? (known.relativePath === relativePath ? 'changed' : 'moved') : 'new'
        };
    }

    /**
     * How many indexed songs no longer have a file where the index says.
     *
     * Counted, not deleted: an album that refers to one keeps its reference,
     * and the song is there again the moment the file is. A song that merely
     * moved is not missing - its record follows it.
     */
    /**
     * Check that the files this index names are still there.
     *
     * The cheapest possible pass over a library: one stat per known file, and
     * nothing else. No tags are read, nothing is hashed, no artwork is
     * extracted, no directory is walked. A library of a thousand songs that
     * has not changed costs a thousand stats and no more - which is why this
     * can run on every start where a full scan could not.
     *
     * What it decides, per file:
     *
     * - gone: the entry is removed, and with it any track no remaining file
     *   points at. That is what takes a deleted song out of Local Music
     *   without waiting for somebody to press Play on it;
     * - there, same size and modification time: kept, untouched. This is
     *   almost every file, almost every time, and it costs one stat;
     * - there but changed: kept for now and named in the answer, so the
     *   caller can have that one file - and only that one - read properly.
     *
     * Nothing personal is touched. A playlist or a liked song that names a
     * track which has gone keeps naming it: the source library says what is
     * here, and somebody's own arrangement is theirs to change.
     */
    async reconcile(options) {
        const settings = options || {};
        const concurrency = Math.max(1, settings.concurrency || RECONCILE_CONCURRENCY);

        this.load();

        const paths = Object.keys(this.index.data.files);
        const missing = [];
        const changed = [];

        // A bounded number of stats in flight: enough to keep the disk busy,
        // never so many that starting up stalls behind them.
        let next = 0;
        const worker = async () => {
            while (next < paths.length) {
                const relativePath = paths[next];
                next += 1;

                const entry = this.index.data.files[relativePath];
                if (!entry) continue;

                const stats = this.adapter.statFile(relativePath);
                if (!stats) {
                    missing.push(relativePath);
                } else if (stats.size !== entry.size || stats.mtimeMs !== entry.mtimeMs) {
                    changed.push(relativePath);
                }

                // Yield between files so a large library never holds the loop.
                if (next % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
            }
        };

        await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));

        const removedTrackIds = this._forgetFiles(missing);

        if (missing.length) this.index.save();

        return {
            checked: paths.length,
            removed: missing.length,
            removedTrackIds: removedTrackIds,
            changed: changed
        };
    }

    /**
     * Take these files out of the index, and with them any track left with no
     * file behind it.
     *
     * The same audio can be in two places, so a track only goes when the last
     * file naming it has gone. Answers the track ids that were dropped, which
     * is what a caller needs in order to take them off the screen.
     */
    _forgetFiles(relativePaths) {
        if (!relativePaths.length) return [];

        const candidates = new Set();
        for (const relativePath of relativePaths) {
            const entry = this.index.data.files[relativePath];
            if (entry && entry.id) candidates.add(entry.id);
            delete this.index.data.files[relativePath];
        }

        const stillReferenced = new Set();
        for (const key of Object.keys(this.index.data.files)) {
            const entry = this.index.data.files[key];
            if (entry && entry.id) stillReferenced.add(entry.id);
        }

        const removed = [];
        candidates.forEach((id) => {
            if (stillReferenced.has(id)) return;
            delete this.index.data.tracks[id];
            removed.push(id);
        });

        return removed;
    }

    countMissingFiles() {
        this.load();
        let missing = 0;
        for (const track of this.index.listTracks()) {
            if (!this.adapter.statFile(track.relativePath)) missing += 1;
        }
        return missing;
    }

    _fallbackTrack(id, file) {
        return {
            id,
            contentHash: id,
            relativePath: file.relativePath,
            fileName: path.basename(file.relativePath),
            title: path.basename(file.relativePath, path.extname(file.relativePath)),
            artist: UNKNOWN_ARTIST,
            albumArtist: UNKNOWN_ARTIST,
            album: UNKNOWN_ALBUM,
            trackNumber: null,
            trackTotal: null,
            discNumber: null,
            discTotal: null,
            year: null,
            genre: [],
            duration: null,
            format: path.extname(file.relativePath).replace('.', '').toLowerCase() || null,
            bitrate: null,
            sampleRate: null,
            channels: null,
            hasArtwork: false,
            artworkFile: null,
            size: file.size,
            mtimeMs: file.mtimeMs
        };
    }

    async _buildTrack(id, file, tags) {
        const track = this._fallbackTrack(id, file);
        const parsed = tags || (await this.adapter.readTags(file.relativePath));
        if (!parsed) return track;

        const common = parsed.common || {};
        const format = parsed.format || {};

        // Only real tag values are used; missing values fall back to the
        // neutral Unknown placeholders, never to invented data.
        track.title = cleanString(common.title) || track.title;
        track.artist = cleanString(common.artist) || (Array.isArray(common.artists) ? cleanString(common.artists[0]) : null) || UNKNOWN_ARTIST;
        track.album = cleanString(common.album) || UNKNOWN_ALBUM;
        track.albumArtist = cleanString(common.albumartist) || track.artist;
        track.trackNumber = firstNumber(common.track && common.track.no);
        track.trackTotal = firstNumber(common.track && common.track.of);
        track.discNumber = firstNumber(common.disk && common.disk.no);
        track.discTotal = firstNumber(common.disk && common.disk.of);
        track.year = firstNumber(common.year);
        track.genre = Array.isArray(common.genre) ? common.genre.filter((g) => cleanString(g)) : [];
        track.duration = firstNumber(format.duration);
        track.format = cleanString(format.container) || cleanString(format.codec) || track.format;
        track.bitrate = firstNumber(format.bitrate);
        track.sampleRate = firstNumber(format.sampleRate);
        track.channels = firstNumber(format.numberOfChannels);

        const pictures = common.picture;
        if (pictures && pictures.length) {
            const picture = pictures[0];
            const data = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data);
            track.hasArtwork = true;
            track.artworkFile = this._cacheArtwork(id, picture.format || 'image/jpeg', data);
        }

        return track;
    }

    /** Write embedded artwork once; later scans reuse the cached file. */
    _cacheArtwork(id, mimeType, data) {
        const extension = ARTWORK_EXTENSIONS[String(mimeType).toLowerCase()] || '.jpg';
        const fileName = id + extension;
        const target = path.join(this.artworkDir, fileName);
        try {
            if (fs.existsSync(target)) return fileName;
            ensureDir(this.artworkDir);
            const temp = target + '.' + process.pid + '.tmp';
            fs.writeFileSync(temp, data);
            fs.renameSync(temp, target);
            return fileName;
        } catch (e) {
            return null;
        }
    }

    toPublicTrack(track) {
        if (!track) return null;
        return {
            id: track.id,
            title: track.title,
            artist: track.artist,
            artistId: stableId('artist:' + track.artist.toLowerCase()),
            album: track.album,
            albumId: stableId('album:' + track.albumArtist.toLowerCase() + '::' + track.album.toLowerCase()),
            albumArtist: track.albumArtist,
            trackNumber: track.trackNumber,
            trackTotal: track.trackTotal,
            discNumber: track.discNumber,
            discTotal: track.discTotal,
            year: track.year,
            genre: track.genre || [],
            duration: track.duration,
            format: track.format,
            bitrate: track.bitrate,
            sampleRate: track.sampleRate,
            channels: track.channels,
            size: track.size,
            fileName: track.fileName,
            hasArtwork: Boolean(track.hasArtwork),
            // When this file was last written, which for music that arrived on
            // a machine is when it arrived. Read from the index, never written
            // to the file: no tag is touched by reporting it.
            addedAt: Number.isFinite(track.mtimeMs) ? new Date(track.mtimeMs).toISOString() : null,
            streamUrl: this.getStreamUrl(track.id),
            artworkUrl: this.getArtworkUrl(track.id)
        };
    }

    getStreamUrl(trackId) {
        return '/api/library/tracks/' + encodeURIComponent(trackId) + '/stream';
    }

    getArtworkUrl(trackId) {
        return '/api/library/tracks/' + encodeURIComponent(trackId) + '/artwork';
    }

    getTracks(options) {
        this.load();
        const settings = options || {};
        let tracks = this.index.listTracks().map((track) => this.toPublicTrack(track));

        if (settings.albumId) tracks = tracks.filter((track) => track.albumId === settings.albumId);
        if (settings.artistId) tracks = tracks.filter((track) => track.artistId === settings.artistId);

        tracks.sort((a, b) => {
            const albumCompare = a.album.localeCompare(b.album);
            if (albumCompare !== 0) return albumCompare;
            const discCompare = (a.discNumber || 0) - (b.discNumber || 0);
            if (discCompare !== 0) return discCompare;
            const trackCompare = (a.trackNumber || 0) - (b.trackNumber || 0);
            if (trackCompare !== 0) return trackCompare;
            return a.title.localeCompare(b.title);
        });

        const total = tracks.length;
        const offset = Number.isFinite(settings.offset) && settings.offset > 0 ? Math.floor(settings.offset) : 0;
        const limit = Number.isFinite(settings.limit) && settings.limit > 0 ? Math.floor(settings.limit) : null;
        const page = limit === null ? tracks.slice(offset) : tracks.slice(offset, offset + limit);

        return { total, offset, limit, items: page };
    }

    getTrack(trackId) {
        this.load();
        return this.toPublicTrack(this.index.getTrack(trackId));
    }

    getAlbums() {
        this.load();
        const albums = new Map();

        for (const track of this.getTracks({}).items) {
            let album = albums.get(track.albumId);
            if (!album) {
                album = {
                    id: track.albumId,
                    title: track.album,
                    albumArtist: track.albumArtist,
                    artistId: stableId('artist:' + track.albumArtist.toLowerCase()),
                    year: track.year,
                    trackCount: 0,
                    duration: 0,
                    artworkUrl: null
                };
                albums.set(track.albumId, album);
            }
            album.trackCount += 1;
            if (track.duration) album.duration += track.duration;
            if (!album.artworkUrl && track.hasArtwork) album.artworkUrl = track.artworkUrl;
            if (!album.year && track.year) album.year = track.year;
        }

        return { total: albums.size, items: Array.from(albums.values()) };
    }

    getArtists() {
        this.load();
        const artists = new Map();

        for (const track of this.getTracks({}).items) {
            let artist = artists.get(track.artistId);
            if (!artist) {
                artist = { id: track.artistId, name: track.artist, trackCount: 0, albumIds: [] };
                artists.set(track.artistId, artist);
            }
            artist.trackCount += 1;
            if (artist.albumIds.indexOf(track.albumId) === -1) artist.albumIds.push(track.albumId);
        }

        return {
            total: artists.size,
            items: Array.from(artists.values()).map((artist) => ({
                id: artist.id,
                name: artist.name,
                trackCount: artist.trackCount,
                albumCount: artist.albumIds.length
            }))
        };
    }

    /**
     * Artwork bytes for a track, or null when the track has none.
     * Artwork is served as its own binary response, never inlined as Base64.
     */
    async getArtwork(trackId) {
        this.load();
        const track = this.index.getTrack(trackId);
        if (!track) return null;

        if (track.artworkFile) {
            const cached = path.join(this.artworkDir, path.basename(track.artworkFile));
            try {
                const data = fs.readFileSync(cached);
                const extension = path.extname(cached).toLowerCase();
                const mimeType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
                return { mimeType, data };
            } catch (e) {
                /* fall through to re-reading the file */
            }
        }

        if (!track.hasArtwork) return null;

        const artwork = await this.adapter.readArtwork(track.relativePath);
        if (!artwork) return null;
        this._cacheArtwork(trackId, artwork.mimeType, artwork.data);
        return artwork;
    }

    /**
     * Open an audio stream for a track ID, honouring an HTTP Range header.
     * The caller only ever supplies a track ID - never a path.
     */
    openStream(trackId, rangeHeader) {
        this.load();
        const track = this.index.getTrack(trackId);
        if (!track) return { status: 404 };

        const stats = this.adapter.statFile(track.relativePath);
        if (!stats) return { status: 404 };

        const size = stats.size;
        const mimeType = this.adapter.mimeTypeFor(track.relativePath);
        const range = parseRange(rangeHeader, size);

        if (range === 'invalid') {
            return {
                status: 416,
                headers: {
                    'Content-Range': 'bytes */' + size,
                    'Accept-Ranges': 'bytes',
                    'Content-Type': mimeType
                }
            };
        }

        if (!range) {
            return {
                status: 200,
                headers: {
                    'Content-Type': mimeType,
                    'Content-Length': size,
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'private, max-age=0, must-revalidate'
                },
                stream: this.adapter.openStream(track.relativePath, null)
            };
        }

        return {
            status: 206,
            headers: {
                'Content-Type': mimeType,
                'Content-Length': range.end - range.start + 1,
                'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + size,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'private, max-age=0, must-revalidate'
            },
            stream: this.adapter.openStream(track.relativePath, range)
        };
    }
}

/**
 * Parse a Range header.
 * Returns null (no range), 'invalid' (unsatisfiable) or { start, end }.
 */
function parseRange(rangeHeader, size) {
    if (!rangeHeader || typeof rangeHeader !== 'string') return null;

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) return null;

    const startText = match[1];
    const endText = match[2];
    if (startText === '' && endText === '') return 'invalid';

    let start;
    let end;

    if (startText === '') {
        const suffixLength = Number(endText);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(startText);
        end = endText === '' ? size - 1 : Number(endText);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
        if (end > size - 1) end = size - 1;
    }

    if (size === 0) return 'invalid';
    if (start > end || start < 0 || start > size - 1) return 'invalid';

    return { start, end };
}

module.exports = { LibraryService, parseRange, UNKNOWN_ARTIST, UNKNOWN_ALBUM };
