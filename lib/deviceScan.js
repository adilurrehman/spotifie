'use strict';

/**
 * Searching this device for music.
 *
 * Whoever is at this computer can have it look through the music folders
 * this installation is allowed to read. The audio never moves: the search
 * records where a song is and what it is, using the same index, the same
 * content-hash ids and the same metadata reader as the shared music root, so a
 * song found here behaves like any other local track.
 *
 * What is found belongs to the device, not to an account: it needs no sign-in,
 * it survives someone signing in or out, and everyone using Spotifie on this
 * machine sees the same songs. Nothing found here reaches Supabase. The search
 * is background work: it runs in small batches, gets out of the way while
 * music is playing, and can be stopped.
 *
 * Only this file knows how a device is searched. A desktop, Android or iOS
 * build replaces the walk below and keeps everything else - the job, the
 * progress, the index - exactly as it is.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
    MUSIC_ROOT,
    DATA_DIR,
    AUDIO_EXTENSIONS,
    MIN_AUDIO_FILE_BYTES,
    MAX_AUDIO_FILE_BYTES,
    MIN_TRACK_SECONDS,
    SCAN_CONCURRENCY,
    SCAN_BUSY_CONCURRENCY,
    SCAN_MAX_DEPTH,
    SCAN_MAX_CANDIDATES,
    configuredExtraRoots
} = require('./config');
// One canonical form for a folder, and one answer to whether two paths name
// the same one. Shared with the device library, which has to recognise a
// folder somebody asked not to search.
const { isInside, normalizeRoot, rootKey } = require('./safeFs');

// Folders that never hold someone's music collection, and that a search must
// not wander into: system and program folders, caches, version control,
// dependencies, and Spotifie's own working data.
const SKIPPED_DIRECTORIES = new Set([
    // Dependencies, version control and build caches.
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '.spotifie',
    // Windows system and program folders.
    'windows',
    'winnt',
    'program files',
    'program files (x86)',
    'programdata',
    'appdata',
    'application data',
    '$recycle.bin',
    'recycler',
    'system volume information',
    // The same idea elsewhere.
    '__macosx',
    'lost+found',
    '.trash',
    '.trash-1000',
    // Caches and scratch space, which hold copies rather than a collection.
    'cache',
    'caches',
    'temp',
    'tmp',
    '.venv',
    'venv'
]);

/** Names that are not part of a music collection. */
function isSkippableName(name) {
    if (!name) return true;
    if (name.startsWith('.')) return true;
    if (name.startsWith('~')) return true;
    return SKIPPED_DIRECTORIES.has(name.toLowerCase());
}

// The folders under a person's own profile where music actually turns up.
// Downloads is where a browser puts it, Desktop and Documents are where people
// put things they meant to sort out later.
const HOME_MUSIC_FOLDERS = ['Music', 'music', 'Downloads', 'Desktop', 'Documents'];


/**
 * The places on this device that may be searched for music.
 *
 * The folders under this person's own profile where music is kept, plus what
 * this installation is configured with - never the whole disk, and never a
 * system or program folder. A future platform adapter answers this question
 * its own way (a media library, a folder the person picked) without changing
 * anything else here.
 *
 * Each answer says whether the folder is actually there, so a search can
 * report what it looked at rather than claiming a folder it never saw.
 */
function describeMusicLocations(options) {
    const settings = options || {};
    // A caller may say there is no home folder to look in - a test, or a
    // platform where the idea does not apply - and that is not the same as
    // saying nothing at all.
    const home = settings.homeDir === null ? null : settings.homeDir || os.homedir();
    const candidates = [];

    if (home) {
        for (const folder of HOME_MUSIC_FOLDERS) candidates.push({ path: path.join(home, folder), kind: 'home' });
    }

    candidates.push({ path: settings.musicRoot || MUSIC_ROOT, kind: 'music-root' });

    // Music people imported into Spotifie itself is on this device too. A
    // caller may say there is none to look at, which is not the same as
    // saying nothing.
    const mediaRoot = settings.mediaRoot === null ? null : settings.mediaRoot || path.join(DATA_DIR, 'media');
    if (mediaRoot) candidates.push({ path: mediaRoot, kind: 'app-media' });

    for (const extra of settings.extraRoots || configuredExtraRoots()) {
        candidates.push({ path: extra, kind: 'configured' });
    }

    const seen = new Set();
    const described = [];

    for (const candidate of candidates) {
        if (!candidate || !candidate.path) continue;

        const resolved = normalizeRoot(candidate.path);
        const key = rootKey(resolved);
        if (seen.has(key)) continue;
        seen.add(key);

        // A folder inside another one that is already being searched adds
        // nothing but work: the walk reaches it anyway.
        const nested = described.some((entry) => entry.available && isInside(entry.path, resolved));
        if (nested) {
            described.push({ path: resolved, kind: candidate.kind, available: false, reason: 'nested' });
            continue;
        }

        if (isSkippableName(path.basename(resolved))) {
            described.push({ path: resolved, kind: candidate.kind, available: false, reason: 'excluded' });
            continue;
        }

        // A folder somebody told this installation to stop looking in. Asked
        // of the caller rather than decided here, because it is the device
        // that remembers the decision - and asked before the folder is even
        // checked for, so a forgotten folder is skipped whether it is still
        // there or not.
        if (settings.isIgnored && settings.isIgnored(resolved)) {
            described.push({ path: resolved, kind: candidate.kind, available: false, reason: 'ignored' });
            continue;
        }

        if (!isReadableDirectory(resolved)) {
            described.push({ path: resolved, kind: candidate.kind, available: false, reason: 'missing' });
            continue;
        }

        described.push({ path: resolved, kind: candidate.kind, available: true, reason: null });
    }

    return described;
}

/** The folders a search will actually walk. */
function defaultMusicLocations(options) {
    return describeMusicLocations(options)
        .filter((entry) => entry.available)
        .map((entry) => entry.path);
}

function isReadableDirectory(directory) {
    try {
        return fs.statSync(directory).isDirectory();
    } catch (e) {
        return false;
    }
}

/**
 * Say what the search is about to look at.
 *
 * Written to the server's own log, where naming a folder is fine and is often
 * the only way to see why a collection was not found. Nothing here is sent to
 * a browser. Set SPOTIFIE_SCAN_DEBUG=1 to see the folders themselves.
 */
function reportRoots(described) {
    const available = described.filter((entry) => entry.available);
    const unavailable = described.filter((entry) => !entry.available);

    console.log(
        'Music search: ' +
            available.length +
            ' location(s) to look in (' +
            available.map((entry) => entry.kind).join(', ') +
            ')' +
            (unavailable.length ? ', ' + unavailable.length + ' skipped' : '')
    );

    if (!process.env.SPOTIFIE_SCAN_DEBUG) return;
    for (const entry of described) {
        console.log('  ' + (entry.available ? 'scan   ' : 'skip   ') + entry.path + (entry.reason ? ' (' + entry.reason + ')' : ''));
    }
}

/** The reason a file is not a song, or null when it may be one. */
function rejectCandidate(name, size, limits) {
    if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) return 'unsupported';
    if (size < limits.minBytes) return 'too-small';
    if (size > limits.maxBytes) return 'too-large';
    return null;
}

/**
 * One search of this device's music locations.
 *
 * The job holds only counts and a state: it is what the browser is shown, and
 * it names no file and no folder.
 */
class ScanJob {
    constructor(locations, options) {
        const settings = options || {};
        this.id = 'scan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        this.locations = locations;
        // 'full' the first time this device is searched, 'incremental' every
        // time afterwards: the same walk, but files already known are
        // recognised and left alone.
        this.mode = settings.mode === 'full' ? 'full' : 'incremental';
        this.status = 'discovering';
        this.processed = 0;
        this.total = null;
        this.tracksFound = 0;
        this.filesSkipped = 0;
        // What the search actually did, so the page can say something true
        // about it rather than a number that means nothing.
        this.filesDiscovered = 0;
        this.existingUnchanged = 0;
        this.newTracks = 0;
        this.changedTracks = 0;
        this.missingTracks = 0;
        this.totalLocalTracks = 0;
        // What the walk itself saw, kept apart so "nothing new" can never be
        // reported as "nothing looked at".
        this.directoriesVisited = 0;
        this.filesSeen = 0;
        this.audioCandidates = 0;
        this.validTracks = 0;
        this.skippedSmall = 0;
        this.skippedLarge = 0;
        this.skippedUnsupported = 0;
        this.skippedCorrupt = 0;
        this.permissionErrors = 0;
        this.startedAt = new Date().toISOString();
        this.finishedAt = null;
        this.error = null;
        this.cancelled = false;
        this.busy = false;
        this.skipReasons = {};
        this.onProgress = settings.onProgress || null;
    }

    /** What the browser is told: counts and a state, never a path. */
    toPublic() {
        const known = typeof this.total === 'number';
        return {
            id: this.id,
            mode: this.mode,
            status: this.status,
            processed: this.processed,
            total: known ? this.total : null,
            tracksFound: this.tracksFound,
            filesSkipped: this.filesSkipped,
            filesDiscovered: this.filesDiscovered,
            filesChecked: this.processed,
            existingUnchanged: this.existingUnchanged,
            unchangedTracks: this.existingUnchanged,
            newTracks: this.newTracks,
            changedTracks: this.changedTracks,
            missingTracks: this.missingTracks,
            totalLocalTracks: this.totalLocalTracks,
            directoriesVisited: this.directoriesVisited,
            filesSeen: this.filesSeen,
            audioCandidates: this.audioCandidates,
            validTracks: this.validTracks,
            skippedSmall: this.skippedSmall,
            skippedLarge: this.skippedLarge,
            skippedUnsupported: this.skippedUnsupported,
            skippedCorrupt: this.skippedCorrupt,
            permissionErrors: this.permissionErrors,
            locationsAvailable: this.locations.length,
            locationsUnavailable: this.unavailableLocations || 0,
            // A percentage is only shown once there is something real to
            // measure it against.
            percent: known && this.total > 0 ? Math.min(100, Math.round((this.processed / this.total) * 100)) : null,
            locationCount: this.locations.length,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            error: this.error
        };
    }

    /** Record one file the search decided against, and why. */
    note(reason) {
        this.filesSkipped += 1;
        this.skipReasons[reason] = (this.skipReasons[reason] || 0) + 1;

        if (reason === 'too-small') this.skippedSmall += 1;
        else if (reason === 'too-large') this.skippedLarge += 1;
        else if (reason === 'unsupported') this.skippedUnsupported += 1;
        else if (reason === 'unreadable-folder') this.permissionErrors += 1;
        else if (reason === 'unreadable-file' || reason === 'too-short') this.skippedCorrupt += 1;
    }

    cancel() {
        this.cancelled = true;
    }
}

class DeviceMusicScanner {
    constructor(options) {
        const settings = options || {};
        // Where what is found is kept: the device's own library, shared by
        // everyone who uses Spotifie on this machine.
        this.deviceLibrary = settings.deviceLibrary;
        this.limits = {
            minBytes: settings.minBytes || MIN_AUDIO_FILE_BYTES,
            maxBytes: settings.maxBytes || MAX_AUDIO_FILE_BYTES,
            minSeconds: settings.minSeconds === undefined ? MIN_TRACK_SECONDS : settings.minSeconds,
            maxDepth: settings.maxDepth || SCAN_MAX_DEPTH,
            maxCandidates: settings.maxCandidates || SCAN_MAX_CANDIDATES,
            concurrency: settings.concurrency || SCAN_CONCURRENCY,
            busyConcurrency: settings.busyConcurrency || SCAN_BUSY_CONCURRENCY,
            batchSize: settings.batchSize || 25
        };
        this.locationOptions = settings.locations || null;
        // One device, one search: not one per account, and not one per tab.
        this.job = null;
        this.dataDir = settings.dataDir || DATA_DIR;
    }

    /** The most recent search on this device, if there has been one. */
    statusFor() {
        return this.job ? this.job.toPublic() : null;
    }

    isRunning() {
        return Boolean(this.job && (this.job.status === 'discovering' || this.job.status === 'scanning'));
    }

    /** Has this device been told to leave this folder alone? */
    _isIgnored(directory) {
        if (!this.deviceLibrary || typeof this.deviceLibrary.isIgnoredRoot !== 'function') return false;

        try {
            return this.deviceLibrary.isIgnoredRoot(directory);
        } catch (err) {
            // A state file that will not read is not permission to search a
            // folder somebody asked about. Left alone, and said once.
            console.warn('Could not read this device\'s forgotten folders:', err.message);
            return true;
        }
    }

    /** Say whether music is playing, so the search gets out of its way. */
    setBusy(busy) {
        if (this.job) this.job.busy = Boolean(busy);
    }

    cancel() {
        if (!this.job || !this.isRunning()) return null;
        this.job.cancel();
        return this.job.toPublic();
    }

    /**
     * Start searching this device's music locations, or hand back the search
     * that is already running.
     *
     * One search at a time, owned by the server: a second tab, a refresh or a
     * second click all get the job that is going rather than starting another
     * one against the same disk. Signing in or out does not touch it - the
     * search belongs to the machine, not to whoever happens to be signed in.
     */
    start(options) {
        if (this.isRunning()) return this.statusFor();

        const settings = options || {};

        // Asked for by hand, and asked for in full: every folder is considered
        // again, including the ones somebody had told this installation to
        // leave alone. That is what asking for the whole device to be searched
        // means, and it is the only thing that undoes forgetting a folder.
        //
        // A search that starts on its own - opening the page, a file changing
        // under a watcher, the cheap check for what moved - never reaches
        // here, so no decision anybody made is ever undone behind their back.
        const manual = settings.mode === 'full';
        if (manual && this.deviceLibrary) this.deviceLibrary.clearIgnoredRoots();

        const described = describeMusicLocations(
            Object.assign({ isIgnored: (directory) => this._isIgnored(directory) }, this.locationOptions, settings)
        );
        const locations = described.filter((entry) => entry.available).map((entry) => entry.path);

        // Said once, on the server, where saying where things are is fine.
        // The browser is only ever told counts.
        reportRoots(described);

        // The first search of this device reads everything; from then on the
        // index is there to be reused, and only what changed is read again.
        const searchedBefore = Boolean(this.deviceLibrary && this.deviceLibrary.listLocations().length);
        const mode = settings.mode || (searchedBefore ? 'incremental' : 'full');

        const job = new ScanJob(locations, Object.assign({}, settings, { mode: mode }));
        job.unavailableLocations = described.length - locations.length;
        this.job = job;

        // Started, not awaited: the answer goes back at once and the work
        // carries on behind it.
        this._run(job).catch((err) => {
            job.status = 'error';
            job.error = err.message;
            job.finishedAt = new Date().toISOString();
            console.error('Music search failed:', err.message);
        });

        return job.toPublic();
    }

    async _run(job) {
        for (const location of job.locations) {
            if (this.deviceLibrary) this.deviceLibrary.rememberLocation(location);
        }

        const candidates = [];
        for (const location of job.locations) {
            if (job.cancelled) break;
            await this._discover(job, location, location, 0, candidates);
        }

        if (job.cancelled) return this._finish(job, 'cancelled');

        job.total = candidates.length;
        job.filesDiscovered = candidates.length;
        job.status = 'scanning';

        await this._process(job, candidates);

        // Songs whose file is no longer where it was. They are counted, not
        // deleted: an album that refers to one keeps its reference, and the
        // song comes back if the file does.
        job.missingTracks = this._countMissing(job);

        return this._finish(job, job.cancelled ? 'cancelled' : 'complete');
    }

    /**
     * Walk one music location, collecting the files that could be songs.
     *
     * Reading a folder is asynchronous and yields between folders, so the
     * server keeps answering requests while a large collection is searched.
     * Anything unreadable is passed over rather than ending the search.
     */
    async _discover(job, root, directory, depth, candidates, visited) {
        if (job.cancelled) return;
        if (depth > this.limits.maxDepth) return;
        if (candidates.length >= this.limits.maxCandidates) return;

        // Folders are remembered by where they really are, so a link that
        // points back up the tree cannot send the search round in circles.
        const seen = visited || new Set();
        let real;
        try {
            real = await fsp.realpath(directory);
        } catch (e) {
            return;
        }
        if (seen.has(real)) return;
        seen.add(real);

        let entries;
        try {
            entries = await fsp.readdir(directory, { withFileTypes: true });
        } catch (e) {
            // A folder this account cannot read is not an error: it is simply
            // not part of their music.
            job.note('unreadable-folder');
            return;
        }

        job.directoriesVisited += 1;

        for (const entry of entries) {
            if (job.cancelled) return;
            if (isSkippableName(entry.name)) continue;

            const absolute = path.join(directory, entry.name);

            // Links are never followed: they are the way out of the folder
            // this account agreed to have searched.
            if (entry.isSymbolicLink()) continue;

            if (entry.isDirectory()) {
                await this._discover(job, root, absolute, depth + 1, candidates, seen);
                continue;
            }

            if (!entry.isFile()) continue;
            if (candidates.length >= this.limits.maxCandidates) return;

            job.filesSeen += 1;

            let stats;
            try {
                stats = await fsp.stat(absolute);
            } catch (e) {
                continue;
            }

            const reason = rejectCandidate(entry.name, stats.size, this.limits);
            if (reason) {
                // Everything the search looked at and decided against is
                // counted, so "nothing new" is never confused with "nothing
                // looked at".
                job.note(reason);
                continue;
            }

            if (!isInside(root, absolute)) continue;

            job.audioCandidates += 1;
            candidates.push({ root: root, absolute: absolute, size: stats.size });
        }
    }

    /**
     * Read the tags of each candidate and put it in this account's library.
     *
     * Done a few files at a time, with a pause between batches: the disk is
     * shared with whatever is playing, and playing wins.
     */
    async _process(job, candidates) {
        const byRoot = new Map();
        for (const candidate of candidates) {
            if (!byRoot.has(candidate.root)) byRoot.set(candidate.root, []);
            byRoot.get(candidate.root).push(candidate);
        }

        // The same audio in two places is one track; its id says so.
        const indexed = new Set();

        for (const [root, files] of byRoot) {
            if (job.cancelled) return;

            const library = this.deviceLibrary ? this.deviceLibrary.libraryFor(root) : null;
            if (!library) {
                job.processed += files.length;
                continue;
            }

            for (let start = 0; start < files.length; start += this.limits.batchSize) {
                if (job.cancelled) return;

                const batch = files.slice(start, start + this.limits.batchSize);
                const width = job.busy ? this.limits.busyConcurrency : this.limits.concurrency;

                await this._inBatches(batch, width, async (candidate) => {
                    const relative = path.relative(root, candidate.absolute).split(path.sep).join('/');
                    try {
                        // A file the index already knows is recognised from
                        // what the folder said about it - no hashing, no tags,
                        // no artwork. Only something new or changed is read.
                        const result = await library.indexFile(relative, {
                            requireAudio: true,
                            force: job.mode === 'full'
                        });
                        const track = result.track;

                        // A last, gentle check: something far too short to be a
                        // song is noise, and is left out.
                        if (track.duration !== null && track.duration < this.limits.minSeconds) {
                            job.note('too-short');
                        } else if (indexed.has(track.id)) {
                            job.note('duplicate');
                        } else {
                            indexed.add(track.id);
                            job.tracksFound += 1;
                            job.validTracks += 1;

                            if (result.state === 'unchanged') job.existingUnchanged += 1;
                            else if (result.state === 'new') job.newTracks += 1;
                            else job.changedTracks += 1;
                        }
                    } catch (err) {
                        // A corrupt file, or one that went away mid-search.
                        job.note('unreadable-file');
                    } finally {
                        job.processed += 1;
                    }
                });

                if (job.onProgress) job.onProgress(job.toPublic());

                // Let the event loop breathe between batches.
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
    }

    /** Run a batch with a fixed number of files in flight at once. */
    async _inBatches(items, width, work) {
        const queue = items.slice();
        const runners = [];

        for (let i = 0; i < Math.max(1, width); i += 1) {
            runners.push(
                (async () => {
                    while (queue.length) {
                        const item = queue.shift();
                        await work(item);
                    }
                })()
            );
        }

        await Promise.all(runners);
    }

    /** Indexed songs whose file was not there this time. */
    _countMissing(job) {
        if (!this.deviceLibrary) return 0;

        let missing = 0;
        for (const location of job.locations) {
            missing += this.deviceLibrary.libraryFor(location).countMissingFiles();
        }
        return missing;
    }

    _finish(job, status) {
        job.status = status;
        job.finishedAt = new Date().toISOString();

        if (this.deviceLibrary) job.totalLocalTracks = this.deviceLibrary.getTracks().length;

        console.log(
            'Music search ' +
                status +
                ': ' +
                job.directoriesVisited +
                ' folder(s), ' +
                job.filesSeen +
                ' file(s) seen, ' +
                job.audioCandidates +
                ' audio candidate(s), ' +
                job.newTracks +
                ' new, ' +
                job.existingUnchanged +
                ' unchanged, ' +
                job.filesSkipped +
                ' skipped'
        );

        if (this.deviceLibrary && status === 'complete') {
            for (const location of job.locations) {
                this.deviceLibrary.rememberLocation(location, { lastScanAt: job.finishedAt });
            }
            this.deviceLibrary.writeState({
                lastScanAt: job.finishedAt,
                lastSuccessfulScanAt: job.finishedAt,
                lastScanSummary: {
                    mode: job.mode,
                    filesChecked: job.processed,
                    filesDiscovered: job.filesDiscovered,
                    existingUnchanged: job.existingUnchanged,
                    newTracks: job.newTracks,
                    changedTracks: job.changedTracks,
                    missingTracks: job.missingTracks,
                    skippedFiles: job.filesSkipped,
                    totalLocalTracks: job.totalLocalTracks
                }
            });
        }

        if (job.onProgress) job.onProgress(job.toPublic());
        return job.toPublic();
    }
}

module.exports = {
    DeviceMusicScanner,
    ScanJob,
    defaultMusicLocations,
    describeMusicLocations,
    normalizeRoot,
    rejectCandidate,
    isSkippableName,
    HOME_MUSIC_FOLDERS,
    SKIPPED_DIRECTORIES
};
