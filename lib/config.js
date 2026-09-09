'use strict';

/**
 * Runtime configuration for the local library layer.
 *
 * Everything the library touches lives under one of two roots:
 * - MUSIC_ROOT: the user's music folder (read only)
 * - .spotifie:  rebuildable index/cache data (read/write)
 */

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveMusicRoot() {
    const configured = process.env.MUSIC_ROOT && process.env.MUSIC_ROOT.trim();
    return path.resolve(PROJECT_ROOT, configured || './music');
}

const MUSIC_ROOT = resolveMusicRoot();
const DATA_DIR = path.join(PROJECT_ROOT, '.spotifie');
const INDEX_FILE = path.join(DATA_DIR, 'library.json');
const ARTWORK_DIR = path.join(DATA_DIR, 'artwork');

// Audio extensions the scanner accepts.
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus']);

// What counts as a song when a device is searched for music. Files smaller
// than this are almost always sound effects, voice notes or fragments; files
// larger than it are almost always something other than a track. Both are
// settable, because someone's library is not someone else's.
const MIN_AUDIO_FILE_BYTES = Number(process.env.SPOTIFIE_MIN_AUDIO_BYTES) || 512 * 1024;
const MAX_AUDIO_FILE_BYTES = Number(process.env.SPOTIFIE_MAX_AUDIO_BYTES) || 500 * 1024 * 1024;

// A last, deliberately gentle check after the tags are read: only long enough
// to throw away a blip. Interludes and short tracks are real music and stay.
const MIN_TRACK_SECONDS = Number(process.env.SPOTIFIE_MIN_TRACK_SECONDS) || 1;

// How much of the disk a search may use at once. Searching is background work:
// it never gets in the way of a song that is playing, so it slows down while
// the player is busy.
const SCAN_CONCURRENCY = Number(process.env.SPOTIFIE_SCAN_CONCURRENCY) || 4;
const SCAN_BUSY_CONCURRENCY = Number(process.env.SPOTIFIE_SCAN_BUSY_CONCURRENCY) || 2;
const SCAN_MAX_DEPTH = Number(process.env.SPOTIFIE_SCAN_MAX_DEPTH) || 12;
const SCAN_MAX_CANDIDATES = Number(process.env.SPOTIFIE_SCAN_MAX_FILES) || 50000;

// Extra music folders this installation may search, beyond the standard ones.
// Set as a list separated by the platform's path separator.
function configuredExtraRoots() {
    const raw = process.env.SPOTIFIE_MUSIC_LOCATIONS;
    if (!raw || !raw.trim()) return [];
    return raw
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry));
}

const AUDIO_MIME_TYPES = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg'
};

module.exports = {
    PROJECT_ROOT,
    MUSIC_ROOT,
    DATA_DIR,
    INDEX_FILE,
    ARTWORK_DIR,
    AUDIO_EXTENSIONS,
    AUDIO_MIME_TYPES,
    MIN_AUDIO_FILE_BYTES,
    MAX_AUDIO_FILE_BYTES,
    MIN_TRACK_SECONDS,
    SCAN_CONCURRENCY,
    SCAN_BUSY_CONCURRENCY,
    SCAN_MAX_DEPTH,
    SCAN_MAX_CANDIDATES,
    configuredExtraRoots
};
