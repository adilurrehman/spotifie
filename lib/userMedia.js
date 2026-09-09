'use strict';

/**
 * Music a listener imported from their own device.
 *
 * The audio stays on this machine, under `.spotifie/media/<supabase-uid>/`,
 * and belongs to that account alone: another signed-in person never sees it,
 * and a guest cannot reach it at all. Nothing here ever touches Supabase -
 * the shared catalogue is the administrator's, and it is written only from
 * the dashboard.
 *
 * Each account gets its own LibraryService over that folder, so imported
 * music goes through exactly the same P2 pipeline as the shared music root:
 * content-hash ids, tag metadata, cached artwork, range-served streams.
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR, AUDIO_EXTENSIONS } = require('./config');
const { LibraryService } = require('./libraryService');
const { LibraryIndex } = require('./libraryIndex');
const { LocalFileSystemAdapter } = require('./adapters/localFileSystemAdapter');
const { ensureDir, containPath } = require('./safeFs');
const { isValidUserId } = require('./userState');

// One import, and one account's whole collection.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;

function importError(status, message, code) {
    const error = new Error(message);
    error.status = status;
    if (code) error.code = code;
    return error;
}

/**
 * A file name that is safe to write.
 *
 * Only the base name is kept - a caller cannot choose a folder - and the
 * result is stripped of anything that could mean something to a shell, a
 * filesystem or a path parser.
 */
function sanitizeFileName(rawName) {
    const base = path.basename(String(rawName || '').replace(/\\/g, '/'));
    const extension = path.extname(base).toLowerCase();

    let stem = base.slice(0, base.length - extension.length);
    stem = stem
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[<>:"/\\|?*]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+/, '')
        .replace(/[.\s]+$/, '')
        .slice(0, MAX_NAME_LENGTH);

    if (!stem) stem = 'Imported track';
    return { stem: stem, extension: extension };
}

/** A name nothing is using yet, so an import never overwrites what is there. */
function uniqueName(directory, stem, extension) {
    let candidate = stem + extension;
    let counter = 2;
    while (fs.existsSync(path.join(directory, candidate))) {
        candidate = stem + ' (' + counter + ')' + extension;
        counter += 1;
        if (counter > 999) throw importError(409, 'Too many files with this name');
    }
    return candidate;
}

class UserMediaStore {
    constructor(options) {
        const settings = options || {};
        this.mediaRoot = settings.mediaRoot || path.join(DATA_DIR, 'media');
        this.stateRoot = settings.stateRoot || path.join(DATA_DIR, 'users');
        this.maxFileBytes = settings.maxFileBytes || MAX_FILE_BYTES;
        this.maxTotalBytes = settings.maxTotalBytes || MAX_TOTAL_BYTES;
        this.libraries = new Map();
    }

    /** This account's own media folder, or null when the id is unusable. */
    directoryFor(userId) {
        if (!isValidUserId(userId)) return null;
        return containPath(this.mediaRoot, userId);
    }

    /**
     * The library over one account's imported music.
     * Built once per account and kept, so the index is read from disk once.
     */
    libraryFor(userId) {
        if (!isValidUserId(userId)) return null;

        const existing = this.libraries.get(userId);
        if (existing) return existing;

        const directory = this.directoryFor(userId);
        if (!directory) return null;

        ensureDir(directory);
        const stateDir = containPath(this.stateRoot, userId);
        if (!stateDir) return null;

        const library = new LibraryService({
            musicRoot: directory,
            adapter: new LocalFileSystemAdapter({ musicRoot: directory }),
            index: new LibraryIndex(path.join(stateDir, 'library.json')),
            artworkDir: path.join(stateDir, 'artwork'),
            dataDir: stateDir
        });

        this.libraries.set(userId, library);
        return library;
    }

    /** Total bytes this account has imported. */
    usage(userId) {
        const library = this.libraryFor(userId);
        if (!library) return 0;
        return library.getTracks({}).items.reduce((total, track) => total + (track.size || 0), 0);
    }

    /** The music this account imported from their own device. */
    getTracks(userId) {
        const library = this.libraryFor(userId);
        return library ? library.getTracks({}).items : [];
    }

    getTrack(userId, trackId) {
        const library = this.libraryFor(userId);
        return library ? library.getTrack(trackId) : null;
    }

    openStream(userId, trackId, rangeHeader) {
        const library = this.libraryFor(userId);
        if (!library) return { status: 404 };
        return library.openStream(trackId, rangeHeader);
    }

    getArtwork(userId, trackId) {
        const library = this.libraryFor(userId);
        if (!library) return Promise.resolve(null);
        return library.getArtwork(trackId);
    }

    /**
     * Write one uploaded file into this account's folder and index it.
     *
     * The body is streamed to a temporary file and only then given its final
     * name, so a failed or oversized upload leaves nothing behind. The caller
     * chooses a name, never a location: the name is sanitized, and the file
     * lands in this account's folder or nowhere.
     */
    async importStream(userId, options) {
        const settings = options || {};
        const directory = this.directoryFor(userId);
        if (!directory) throw importError(401, 'Importing music requires a signed-in account');

        const { stem, extension } = sanitizeFileName(settings.fileName);
        if (!AUDIO_EXTENSIONS.has(extension)) {
            throw importError(415, 'That file type is not supported', 'unsupported-type');
        }

        const used = this.usage(userId);
        if (used >= this.maxTotalBytes) {
            throw importError(507, 'Your imported music has reached its size limit', 'quota');
        }

        ensureDir(directory);
        const incoming = path.join(directory, '.incoming-' + process.pid + '-' + Date.now() + extension);

        try {
            await this._writeStream(settings.stream, incoming, Math.min(this.maxFileBytes, this.maxTotalBytes - used));
        } catch (err) {
            this._discard(incoming);
            throw err;
        }

        const library = this.libraryFor(userId);
        let finalName;

        try {
            finalName = uniqueName(directory, stem, extension);
            fs.renameSync(incoming, path.join(directory, finalName));
        } catch (err) {
            this._discard(incoming);
            throw importError(500, 'Could not save the file on this device', 'write-failed');
        }

        // Metadata comes from the same reader the scanner uses. A file it
        // cannot make sense of - no container, no codec - is not audio
        // whatever it is called, and is not kept.
        const readable = await library.adapter.readTags(finalName);
        const format = readable && readable.format;
        if (!format || !(format.container || format.codec)) {
            this._discard(path.join(directory, finalName));
            throw importError(415, 'That file could not be read as audio', 'unreadable');
        }

        // The same audio twice: keep the copy already in the library and drop
        // the new file, so one song never becomes two.
        const duplicate = await this._findDuplicate(library, finalName);
        if (duplicate) {
            this._discard(path.join(directory, finalName));
            return { track: duplicate, duplicate: true };
        }

        try {
            const indexed = await library.indexFile(finalName);
            return { track: indexed.track, duplicate: false };
        } catch (err) {
            this._discard(path.join(directory, finalName));
            throw importError(500, 'Could not add the file to your library', 'index-failed');
        }
    }

    /** The track this account already has with the same audio, if any. */
    async _findDuplicate(library, fileName) {
        let id;
        try {
            id = await library.adapter.hashFile(fileName);
        } catch (e) {
            return null;
        }

        library.load();
        const known = library.index.getTrack(id);
        if (!known) return null;
        if (known.fileName === fileName) return null;
        if (!library.adapter.statFile(known.relativePath)) return null;

        return library.getTrack(id);
    }

    _writeStream(stream, target, limitBytes) {
        return new Promise((resolve, reject) => {
            if (!stream) {
                reject(importError(400, 'No audio was uploaded'));
                return;
            }

            const out = fs.createWriteStream(target);
            let written = 0;
            let failed = false;

            function fail(error) {
                if (failed) return;
                failed = true;
                out.destroy();
                // Read the rest instead of cutting the connection, so the
                // caller can read the answer.
                stream.resume();
                reject(error);
            }

            stream.on('data', (chunk) => {
                if (failed) return;
                written += chunk.length;
                if (written > limitBytes) {
                    fail(importError(413, 'That file is larger than this device accepts', 'too-large'));
                }
            });

            stream.on('error', () => fail(importError(400, 'The upload did not finish')));
            out.on('error', () => fail(importError(500, 'Could not write the file to this device', 'write-failed')));

            out.on('finish', () => {
                if (failed) return;
                if (written === 0) {
                    reject(importError(400, 'No audio was uploaded'));
                    return;
                }
                resolve(written);
            });

            stream.pipe(out);
        });
    }

    _discard(file) {
        try {
            fs.unlinkSync(file);
        } catch (e) {
            /* nothing to remove */
        }
    }
}

module.exports = { UserMediaStore, sanitizeFileName, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
