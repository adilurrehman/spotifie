'use strict';

/**
 * Local filesystem adapter.
 *
 * This is the only place in the library layer that knows about Node's fs
 * module and about real paths. A desktop or mobile backend can be added later
 * by implementing the same interface:
 *
 *   listFiles()                        -> Promise<Array<{ relativePath, size, mtimeMs }>>
 *   statFile(relativePath)             -> { size, mtimeMs } | null
 *   hashFile(relativePath)             -> Promise<string>            (sha-256, hex)
 *   readTags(relativePath)             -> Promise<object|null>       (raw tag payload)
 *   readArtwork(relativePath)          -> Promise<{ mimeType, data }|null>
 *   openStream(relativePath, range)    -> stream (range: { start, end })
 *   mimeTypeFor(relativePath)          -> string
 *   describe()                         -> { kind, rootLabel }
 *
 * Nothing outside the adapter may receive absolute paths.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { AUDIO_EXTENSIONS, AUDIO_MIME_TYPES } = require('../config');
const { containPath, toRelative, isInside } = require('../safeFs');

const MAX_DEPTH = 24;

// Directory names that are never part of a music library.
const SKIPPED_DIRECTORIES = new Set([
    'node_modules',
    '$recycle.bin',
    'system volume information',
    '__macosx',
    'lost+found'
]);

// Partial-download and editor temp files.
const TEMP_SUFFIXES = ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.download', '~'];

function isHiddenOrSystemName(name) {
    if (!name) return true;
    if (name.startsWith('.')) return true;
    if (name.startsWith('~')) return true;
    if (name.toLowerCase() === 'thumbs.db' || name.toLowerCase() === 'desktop.ini') return true;
    return false;
}

function isTempFileName(name) {
    const lower = name.toLowerCase();
    return TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

class LocalFileSystemAdapter {
    constructor(options) {
        const settings = options || {};
        this.musicRoot = path.resolve(settings.musicRoot);
        this.parseFileFn = settings.parseFile || null;
    }

    describe() {
        return { kind: 'local-filesystem', rootLabel: path.basename(this.musicRoot) };
    }

    rootExists() {
        try {
            return fs.statSync(this.musicRoot).isDirectory();
        } catch (e) {
            return false;
        }
    }

    /** Absolute path for a library-relative path, or null when unsafe. */
    resolve(relativePath) {
        return containPath(this.musicRoot, relativePath);
    }

    async listFiles() {
        const results = [];
        if (!this.rootExists()) return results;
        this._walk(this.musicRoot, 0, results);
        return results;
    }

    _walk(directory, depth, results) {
        if (depth > MAX_DEPTH) return;

        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (e) {
            // Unreadable directory: skip it, keep scanning the rest.
            return;
        }

        for (const entry of entries) {
            const name = entry.name;
            if (isHiddenOrSystemName(name)) continue;

            const absolute = path.join(directory, name);

            // Symlinks are not followed: they are the easiest way out of the root.
            if (entry.isSymbolicLink()) continue;

            if (entry.isDirectory()) {
                if (SKIPPED_DIRECTORIES.has(name.toLowerCase())) continue;
                this._walk(absolute, depth + 1, results);
                continue;
            }

            if (!entry.isFile()) continue;
            if (isTempFileName(name)) continue;
            if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
            if (!isInside(this.musicRoot, absolute)) continue;

            let stats;
            try {
                stats = fs.statSync(absolute);
            } catch (e) {
                continue;
            }

            results.push({
                relativePath: toRelative(this.musicRoot, absolute),
                size: stats.size,
                mtimeMs: Math.floor(stats.mtimeMs)
            });
        }
    }

    statFile(relativePath) {
        const absolute = this.resolve(relativePath);
        if (!absolute) return null;
        try {
            const stats = fs.statSync(absolute);
            if (!stats.isFile()) return null;
            return { size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) };
        } catch (e) {
            return null;
        }
    }

    hashFile(relativePath) {
        const absolute = this.resolve(relativePath);
        if (!absolute) return Promise.reject(new Error('Path outside library root'));

        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(absolute);
            stream.on('error', reject);
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
        });
    }

    async _parse(relativePath, options) {
        const absolute = this.resolve(relativePath);
        if (!absolute) return null;

        if (!this.parseFileFn) {
            const loaded = await import('music-metadata');
            this.parseFileFn = loaded.parseFile;
        }

        return this.parseFileFn(absolute, options);
    }

    /** Raw tag payload; returns null when the file cannot be parsed. */
    async readTags(relativePath) {
        try {
            return await this._parse(relativePath, { duration: true });
        } catch (e) {
            return null;
        }
    }

    async readArtwork(relativePath) {
        try {
            const parsed = await this._parse(relativePath, { duration: false });
            const pictures = parsed && parsed.common && parsed.common.picture;
            if (!pictures || !pictures.length) return null;
            const picture = pictures[0];
            const data = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data);
            return { mimeType: picture.format || 'image/jpeg', data };
        } catch (e) {
            return null;
        }
    }

    openStream(relativePath, range) {
        const absolute = this.resolve(relativePath);
        if (!absolute) return null;
        const options = {};
        if (range && Number.isFinite(range.start)) options.start = range.start;
        if (range && Number.isFinite(range.end)) options.end = range.end;
        return fs.createReadStream(absolute, options);
    }

    mimeTypeFor(relativePath) {
        return AUDIO_MIME_TYPES[path.extname(relativePath).toLowerCase()] || 'application/octet-stream';
    }
}

module.exports = { LocalFileSystemAdapter };
