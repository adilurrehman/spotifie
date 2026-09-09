'use strict';

/**
 * Local store for artwork a person adds to their own albums.
 *
 * The image file itself stays on this device, under .spotifie/user-artwork/.
 * Albums keep only the id of the stored file, so nothing large or binary ends
 * up in browser storage, and nothing here is ever uploaded to Supabase.
 *
 * The id is generated here - a caller never supplies a path - so a request can
 * only ever reach a file inside this folder.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./config');
const { ensureDir } = require('./safeFs');

const ARTWORK_DIR = path.join(DATA_DIR, 'user-artwork');
const MAX_BYTES = 2 * 1024 * 1024;

// The only image types accepted, and the extension each one is stored with.
const ALLOWED_TYPES = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif'
};

const MIME_BY_EXTENSION = {
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
};

/** Ids are 32 hex characters; anything else is refused before touching disk. */
function isValidId(id) {
    return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
}

function extensionFor(mimeType) {
    return ALLOWED_TYPES[String(mimeType || '').toLowerCase().split(';')[0].trim()] || null;
}

class UserArtworkStore {
    constructor(options) {
        const settings = options || {};
        this.directory = settings.directory || ARTWORK_DIR;
        this.maxBytes = settings.maxBytes || MAX_BYTES;
    }

    /**
     * Store an image and return its id.
     * Throws for an unsupported type or an oversized file; the caller turns
     * that into a 400 rather than writing anything.
     */
    save(buffer, mimeType) {
        const extension = extensionFor(mimeType);
        if (!extension) {
            const error = new Error('Unsupported image type');
            error.status = 415;
            throw error;
        }
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            const error = new Error('No image data');
            error.status = 400;
            throw error;
        }
        if (buffer.length > this.maxBytes) {
            const error = new Error('Image is larger than ' + Math.round(this.maxBytes / (1024 * 1024)) + ' MB');
            error.status = 413;
            throw error;
        }

        const id = crypto.randomBytes(16).toString('hex');
        ensureDir(this.directory);

        // Written to a temp file first, then renamed, so a half-written file is
        // never served.
        const target = path.join(this.directory, id + extension);
        const temporary = target + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, buffer);
        fs.renameSync(temporary, target);

        return { id: id, url: '/api/library/artwork/' + id, mimeType: MIME_BY_EXTENSION[extension] };
    }

    /** Locate a stored image by id, or null when there is none. */
    find(id) {
        if (!isValidId(id)) return null;

        for (const extension of Object.keys(MIME_BY_EXTENSION)) {
            const candidate = path.join(this.directory, id + extension);
            try {
                const stats = fs.statSync(candidate);
                if (stats.isFile()) {
                    return { path: candidate, size: stats.size, mimeType: MIME_BY_EXTENSION[extension] };
                }
            } catch (e) {
                /* try the next extension */
            }
        }
        return null;
    }

    /** Delete a stored image. Missing files are not an error. */
    remove(id) {
        const found = this.find(id);
        if (!found) return false;
        try {
            fs.unlinkSync(found.path);
            return true;
        } catch (e) {
            return false;
        }
    }
}

module.exports = { UserArtworkStore, ARTWORK_DIR, MAX_BYTES, ALLOWED_TYPES, isValidId };
