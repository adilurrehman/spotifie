'use strict';

/**
 * Persistent, fully rebuildable library index.
 *
 * Stored under .spotifie/ as JSON and written atomically. Nothing here is a
 * source of truth: if the file is lost or corrupt it is rebuilt by rescanning.
 * Audio itself is never stored - only metadata and fingerprint bookkeeping.
 */

const { INDEX_FILE } = require('./config');
const { readJsonSafe, writeJsonAtomic } = require('./safeFs');

const INDEX_VERSION = 2;

function emptyIndex() {
    return {
        version: INDEX_VERSION,
        updatedAt: null,
        rootLabel: null,
        files: {},
        tracks: {}
    };
}

class LibraryIndex {
    constructor(file) {
        this.file = file || INDEX_FILE;
        this.data = emptyIndex();
        this.recovered = false;
    }

    load() {
        const result = readJsonSafe(this.file, emptyIndex());
        const candidate = result.value;
        this.recovered = result.recovered;

        if (
            !candidate ||
            candidate.version !== INDEX_VERSION ||
            typeof candidate.files !== 'object' ||
            candidate.files === null ||
            typeof candidate.tracks !== 'object' ||
            candidate.tracks === null
        ) {
            // Unknown or damaged shape: start clean rather than fail forever.
            this.data = emptyIndex();
            this.recovered = true;
            return this.data;
        }

        this.data = candidate;
        return this.data;
    }

    save() {
        this.data.version = INDEX_VERSION;
        this.data.updatedAt = new Date().toISOString();
        writeJsonAtomic(this.file, this.data);
    }

    /** Cached fingerprint for a file, valid only while size and mtime match. */
    getCachedId(relativePath, size, mtimeMs) {
        const entry = this.data.files[relativePath];
        if (!entry) return null;
        if (entry.size !== size || entry.mtimeMs !== mtimeMs) return null;
        return entry.id || null;
    }

    setFileEntry(relativePath, size, mtimeMs, id) {
        this.data.files[relativePath] = { size, mtimeMs, id };
    }

    getTrack(id) {
        return this.data.tracks[id] || null;
    }

    setTrack(track) {
        this.data.tracks[track.id] = track;
    }

    replaceContents(files, tracks, rootLabel) {
        this.data.files = files;
        this.data.tracks = tracks;
        this.data.rootLabel = rootLabel;
    }

    listTracks() {
        return Object.keys(this.data.tracks).map((id) => this.data.tracks[id]);
    }
}

module.exports = { LibraryIndex, INDEX_VERSION, emptyIndex };
