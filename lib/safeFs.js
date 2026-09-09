'use strict';

/**
 * Filesystem safety helpers.
 *
 * Every path used by the library layer goes through containPath(), which
 * rejects traversal and symlink escapes by comparing the *real* resolved
 * path against the *real* root.
 */

const fs = require('fs');
const path = require('path');

const NUL_CHAR = String.fromCharCode(0);

function realPathOrSelf(target) {
    try {
        return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
    } catch (e) {
        return target;
    }
}

function isInside(root, target) {
    const normalizedRoot = path.resolve(root);
    const normalizedTarget = path.resolve(target);
    if (normalizedTarget === normalizedRoot) return true;
    const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    return normalizedTarget.startsWith(withSep);
}

/**
 * Resolve a relative path against a root and confirm it stays inside it.
 * Returns the absolute path, or null when the path escapes or is unsafe.
 */
/**
 * One canonical form for a folder, so the same place is never two places.
 *
 * Windows says the same path several ways - either slash, a trailing one or
 * not, and a drive letter in either case - and all of them mean one folder.
 * Kept here rather than beside the search, because deciding that two paths
 * name the same folder is the same question whether it is being asked to
 * avoid searching it twice or to remember that somebody said not to search it
 * at all, and two answers to it would eventually disagree.
 */
function normalizeRoot(directory) {
    let resolved = path.resolve(String(directory));

    // A drive letter is not two different drives.
    if (/^[a-z]:/.test(resolved)) resolved = resolved[0].toUpperCase() + resolved.slice(1);

    // A trailing separator says nothing, except on a drive root, where it does.
    while (resolved.length > 3 && (resolved.endsWith(path.sep) || resolved.endsWith('/'))) {
        resolved = resolved.slice(0, -1);
    }

    return resolved;
}

/**
 * The key two paths share when they are the same folder.
 *
 * A key, and never a prefix. "/Music" and "/MusicBackup" begin with the same
 * letters and are not the same folder, and nothing here compares them as
 * text: two folders are the same when their keys are equal, and one is inside
 * another only when isInside says so.
 */
function rootKey(directory) {
    const normalized = normalizeRoot(directory);
    // Windows and macOS do not care about case; treating them as if they did
    // would make one folder look like two.
    return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function containPath(root, relativePath) {
    if (typeof relativePath !== 'string' || relativePath.indexOf(NUL_CHAR) !== -1) return null;
    if (path.isAbsolute(relativePath)) return null;

    const parts = relativePath.split(/[/\\]+/);
    for (const part of parts) {
        if (part === '..') return null;
    }

    const absolute = path.resolve(root, relativePath);
    if (!isInside(root, absolute)) return null;

    // Symlink escape check: compare real paths when the target exists.
    const realRoot = realPathOrSelf(root);
    const realTarget = realPathOrSelf(absolute);
    if (!isInside(realRoot, realTarget)) return null;

    return absolute;
}

/** Convert an absolute path inside root into a POSIX-style relative path. */
function toRelative(root, absolutePath) {
    return path.relative(root, absolutePath).split(path.sep).join('/');
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

/** Read JSON, returning fallback when the file is missing or unreadable. */
function readJsonSafe(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { value: fallback, recovered: true };
        return { value: parsed, recovered: false };
    } catch (e) {
        if (e.code === 'ENOENT') return { value: fallback, recovered: false };
        // Corrupt index: keep a copy for inspection, then rebuild from scratch.
        try {
            fs.renameSync(file, file + '.corrupt');
        } catch (renameError) {
            try {
                fs.unlinkSync(file);
            } catch (unlinkError) {
                /* ignore - rebuild proceeds in memory */
            }
        }
        return { value: fallback, recovered: true };
    }
}

/** Write JSON atomically (temp file in the same directory, then rename). */
function writeJsonAtomic(file, data) {
    ensureDir(path.dirname(file));
    const tempFile = file + '.' + process.pid + '.tmp';
    const payload = JSON.stringify(data, null, 2);
    let handle;
    try {
        handle = fs.openSync(tempFile, 'w');
        fs.writeFileSync(handle, payload, 'utf8');
        fs.fsyncSync(handle);
    } finally {
        if (handle !== undefined) {
            try {
                fs.closeSync(handle);
            } catch (e) {
                /* ignore */
            }
        }
    }
    fs.renameSync(tempFile, file);
}

module.exports = {
    normalizeRoot,
    rootKey,
    containPath,
    isInside,
    toRelative,
    ensureDir,
    readJsonSafe,
    writeJsonAtomic
};
