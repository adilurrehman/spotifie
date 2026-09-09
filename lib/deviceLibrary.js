'use strict';

/**
 * The music this installation has found on the device it runs on.
 *
 * This belongs to the machine, not to an account. Whoever is at the computer -
 * a guest, one signed-in listener, another one afterwards - is looking at the
 * same songs on the same disk, so they are indexed once, under
 * `.spotifie/device/`, and everyone who can open Spotifie here can play them.
 *
 * What stays personal is everything an account does with that music: likes,
 * albums of their own, hidden items, edits. Those live under
 * `.spotifie/users/<uid>/` and are never mixed in here.
 *
 * Nothing in this file reaches Supabase, and nothing in it hands a path to a
 * browser: music is asked for by its track id, exactly as it is in the shared
 * music root.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./config');
const { LibraryService } = require('./libraryService');
const { LibraryIndex } = require('./libraryIndex');
const { LocalFileSystemAdapter } = require('./adapters/localFileSystemAdapter');
const { ensureDir, readJsonSafe, writeJsonAtomic, rootKey } = require('./safeFs');

/** A stable id for a music location, so its index can be found again. */
function locationId(directory) {
    return crypto.createHash('sha1').update(path.resolve(directory)).digest('hex').slice(0, 16);
}

function emptyState() {
    return {
        permission: 'unknown',
        lastScanAt: null,
        lastSuccessfulScanAt: null,
        lastScanSummary: null,
        // When the index was last checked against the disk. A different thing
        // from a search: a search looks for music, this confirms that what was
        // already found is still there.
        lastReconciledAt: null,
        locations: [],
        // Folders somebody told this installation to stop looking in.
        //
        // Kept because forgetting one has to outlast the folder itself. The
        // usual places music sits - Music, Downloads, Desktop - are found
        // again every time a search runs, so a folder taken out of the list
        // and nothing more would be put straight back by the next automatic
        // search, and would look as though forgetting it had done nothing at
        // all. Written down here, at the level of the installation, so it
        // survives a refresh, a restart, and every account that signs in.
        ignoredRoots: []
    };
}

class DeviceLibrary {
    constructor(options) {
        const settings = options || {};
        this.deviceDir = settings.deviceDir || path.join(DATA_DIR, 'device');
        this.stateFile = settings.stateFile || path.join(this.deviceDir, 'scan-state.json');
        this.indexDir = settings.indexDir || path.join(this.deviceDir, 'locations');
        this.artworkDir = settings.artworkDir || path.join(this.deviceDir, 'artwork');
        this.libraries = new Map();
    }

    /**
     * What this device remembers about searching itself: whether it was
     * allowed, when it last happened, and which folders were looked in.
     * A refusal is never written down - being asked again is the point.
     */
    readState() {
        const stored = readJsonSafe(this.stateFile, emptyState()).value || {};
        const locations = Array.isArray(stored.locations) ? stored.locations : [];

        return {
            permission: stored.permission === 'allowed' ? 'allowed' : 'unknown',
            lastScanAt: typeof stored.lastScanAt === 'string' ? stored.lastScanAt : null,
            lastSuccessfulScanAt:
                typeof stored.lastSuccessfulScanAt === 'string' ? stored.lastSuccessfulScanAt : null,
            // What the last finished search found, so the page can say
            // something true about the library before looking again.
            lastScanSummary:
                stored.lastScanSummary && typeof stored.lastScanSummary === 'object' ? stored.lastScanSummary : null,
            lastReconciledAt: typeof stored.lastReconciledAt === 'string' ? stored.lastReconciledAt : null,
            ignoredRoots: (Array.isArray(stored.ignoredRoots) ? stored.ignoredRoots : [])
                .filter((entry) => entry && typeof entry.path === 'string')
                .map((entry) => ({
                    id: entry.id || locationId(entry.path),
                    path: entry.path,
                    label: entry.label || path.basename(entry.path),
                    forgottenAt: entry.forgottenAt || null
                })),
            locations: locations
                .filter((entry) => entry && typeof entry.path === 'string' && typeof entry.id === 'string')
                .map((entry) => ({
                    id: entry.id,
                    path: entry.path,
                    label: entry.label || path.basename(entry.path),
                    addedAt: entry.addedAt || null,
                    lastScanAt: entry.lastScanAt || null
                }))
        };
    }

    writeState(changes) {
        const next = Object.assign(this.readState(), changes || {});
        ensureDir(path.dirname(this.stateFile));
        writeJsonAtomic(this.stateFile, next);
        return next;
    }

    /** Record that someone at this device agreed to have it searched. */
    allowScanning() {
        return this.writeState({ permission: 'allowed' });
    }

    isAllowed() {
        return this.readState().permission === 'allowed';
    }

    /** The folders somebody has asked this installation to stop looking in. */
    ignoredRoots() {
        return this.readState().ignoredRoots;
    }

    /**
     * Was this folder asked not to be searched?
     *
     * Compared by the key two paths share when they are the same folder, never
     * as text. "Music" and "MusicBackup" begin the same way and are different
     * folders, and forgetting one must not quietly forget the other.
     */
    isIgnoredRoot(directory) {
        if (!directory) return false;

        const wanted = rootKey(directory);
        return this.readState().ignoredRoots.some((entry) => rootKey(entry.path) === wanted);
    }

    /** Write down that this folder is not to be searched again by itself. */
    ignoreRoot(directory, details) {
        const settings = details || {};
        const state = this.readState();
        const wanted = rootKey(directory);

        const entry = {
            id: locationId(directory),
            path: path.resolve(directory),
            label: settings.label || path.basename(directory) || 'Music',
            forgottenAt: new Date().toISOString()
        };

        const ignoredRoots = state.ignoredRoots.filter((other) => rootKey(other.path) !== wanted).concat([entry]);
        this.writeState({ ignoredRoots: ignoredRoots });
        return entry;
    }

    /**
     * Consider every folder again.
     *
     * Only ever from something somebody asked for by hand. A search that runs
     * on its own - on opening the page, on noticing a file change - must never
     * undo a decision somebody made; asking for the whole device to be
     * searched again is asking for exactly that decision to be reconsidered.
     */
    clearIgnoredRoots() {
        const forgotten = this.readState().ignoredRoots;
        if (!forgotten.length) return [];

        this.writeState({ ignoredRoots: [] });
        return forgotten;
    }

    listLocations() {
        return this.readState().locations;
    }

    /** Remember a music location, or when it was last searched. */
    rememberLocation(directory, details) {
        const settings = details || {};
        const id = locationId(directory);
        const state = this.readState();
        const existing = state.locations.find((entry) => entry.id === id);

        const entry = {
            id: id,
            path: path.resolve(directory),
            label: settings.label || path.basename(directory) || 'Music',
            addedAt: (existing && existing.addedAt) || new Date().toISOString(),
            lastScanAt: settings.lastScanAt || (existing && existing.lastScanAt) || null
        };

        const locations = state.locations.filter((other) => other.id !== id).concat([entry]);
        this.writeState({ locations: locations });
        return entry;
    }

    /**
     * The library over one music location.
     *
     * Each folder keeps its own index, so a folder searched once is not read
     * from scratch again, and the track ids are the content hashes the rest of
     * the local library already uses.
     */
    libraryFor(directory) {
        const resolved = path.resolve(directory);
        const id = locationId(resolved);

        const existing = this.libraries.get(id);
        if (existing) return existing;

        ensureDir(this.indexDir);
        const library = new LibraryService({
            musicRoot: resolved,
            adapter: new LocalFileSystemAdapter({ musicRoot: resolved }),
            index: new LibraryIndex(path.join(this.indexDir, id + '.json')),
            artworkDir: this.artworkDir,
            dataDir: this.deviceDir
        });

        this.libraries.set(id, library);
        return library;
    }

    libraries_() {
        return this.listLocations().map((location) => this.libraryFor(location.path));
    }

    /**
     * Everything found on this device. The same audio in two searched folders
     * is one song: they share an id.
     */
    getTracks() {
        const seen = new Map();
        for (const library of this.libraries_()) {
            for (const track of library.getTracks({}).items) {
                if (!seen.has(track.id)) seen.set(track.id, track);
            }
        }
        return Array.from(seen.values());
    }

    getTrack(trackId) {
        for (const library of this.libraries_()) {
            const track = library.getTrack(trackId);
            if (track) return track;
        }
        return null;
    }

    /** Only an indexed track can be streamed: there is no path to ask for. */
    openStream(trackId, rangeHeader) {
        for (const library of this.libraries_()) {
            if (!library.getTrack(trackId)) continue;
            return library.openStream(trackId, rangeHeader);
        }
        return { status: 404 };
    }

    /**
     * Check that the music this device was told about is still on it.
     *
     * One stat per known file across every searched location, and nothing
     * else: no tags read, nothing hashed, no folder walked. A file that has
     * been deleted is taken out of the index here, which is what makes it
     * disappear from Local Music on the next load rather than lingering until
     * somebody presses Play on it and gets an error.
     *
     * Cheap enough to run on every start, which matters because a watcher
     * cannot see anything that happened while Spotifie was closed. This is the
     * pass that is always right.
     *
     * A file whose size or modification time has changed is not read here -
     * it is named in the answer so the scanner can look at that one file, and
     * only that one.
     */
    async reconcile(options) {
        const settings = options || {};

        let checked = 0;
        let removed = 0;
        const removedTrackIds = [];
        const changed = [];

        for (const library of this.libraries_()) {
            const result = await library.reconcile(settings);

            checked += result.checked;
            removed += result.removed;
            for (const id of result.removedTrackIds) removedTrackIds.push(id);
            for (const relativePath of result.changed) changed.push(relativePath);
        }

        // The same audio may sit in two searched folders. A track is only
        // really gone when no location still has it.
        const stillHere = new Set(this.getTracks().map((track) => track.id));
        const gone = removedTrackIds.filter((id) => !stillHere.has(id));

        // When the index was last known to agree with the disk. Written every
        // time, not only when something changed: "checked a minute ago and all
        // present" is the useful thing to be able to say.
        const finishedAt = new Date().toISOString();
        this.writeState({ lastReconciledAt: finishedAt });

        return {
            checked: checked,
            removed: removed,
            removedTrackIds: gone,
            changed: changed,
            finishedAt: finishedAt
        };
    }

    async getArtwork(trackId) {
        for (const library of this.libraries_()) {
            if (!library.getTrack(trackId)) continue;
            const artwork = await library.getArtwork(trackId);
            if (artwork) return artwork;
        }
        return null;
    }

    /** The locations as the browser may see them: a name, a count, a time. */
    /**
     * Stop searching a folder, and forget what was found there.
     *
     * The folder itself is untouched: this is Spotifie being told to stop
     * looking somewhere, not a request to delete anything. Every file stays
     * exactly where it is.
     *
     * What goes is the index for that folder, so its songs leave Local Music -
     * which is what Local Music means, the music this machine is currently
     * looking at. What does not go is anybody's arrangement: a playlist or a
     * liked song naming one of those tracks keeps naming it, becomes an
     * unavailable reference, and reconnects by itself if the folder is added
     * back, because the id is the fingerprint of the file's contents.
     */
    forgetLocation(wantedId) {
        const state = this.readState();
        const location = state.locations.find((entry) => entry.id === wantedId);
        if (!location) return null;

        this.writeState({ locations: state.locations.filter((entry) => entry.id !== wantedId) });

        // And remember that it was forgotten, so the next search does not
        // discover it all over again and put it back.
        this.ignoreRoot(location.path, { label: location.label });

        // The library object for it, and the index file behind it. Only that
        // one file, named by the id of the folder being forgotten: the songs
        // found in every other folder are in their own indexes and are not
        // touched, and no audio anywhere is deleted.
        this.libraries.delete(wantedId);

        const indexFile = path.join(this.indexDir, wantedId + '.json');
        try {
            if (fs.existsSync(indexFile)) fs.unlinkSync(indexFile);
        } catch (e) {
            // A file that will not go leaves a stale index nobody reads: the
            // folder is out of the list, so it is never opened again.
            console.warn('Could not remove the index for a forgotten folder:', e.message);
        }

        return { id: location.id, label: location.label };
    }

    /**
     * Songs that look like copies of one another.
     *
     * Two kinds, and they are different questions:
     *
     * - the same file in two places. Certain, because the id is the
     *   fingerprint of the contents: identical audio has one id and is one
     *   song, listed under both paths;
     * - two different files that look like the same recording - same title,
     *   same artist, near enough the same length. Probable, not certain: a
     *   remaster, a live version and a re-encode all look like this.
     *
     * Neither is acted on. Deciding that two songs are the same song is a
     * judgement about music, and it belongs to whoever owns the music.
     */
    findDuplicates() {
        // How many files carry each song, and what each song is called. The
        // count comes from the file entries rather than the tracks, because
        // the index already treats identical audio as one song - which is the
        // very thing being counted.
        const copies = new Map();
        const known = new Map();
        const byDescription = new Map();

        for (const library of this.libraries_()) {
            library.load();

            const files = library.index.data.files;
            for (const relativePath of Object.keys(files)) {
                const id = files[relativePath] && files[relativePath].id;
                if (!id) continue;
                copies.set(id, (copies.get(id) || 0) + 1);
            }

            for (const track of library.getTracks({}).items) {
                if (!known.has(track.id)) known.set(track.id, track);

                // Rounded to five seconds: two encodes of one recording rarely
                // agree to the millisecond.
                const length = Number.isFinite(track.duration) ? Math.round(track.duration / 5) : 'unknown';
                const key = [
                    String(track.title || '').trim().toLowerCase(),
                    String(track.artist || '').trim().toLowerCase(),
                    length
                ].join('~');

                const alike = byDescription.get(key) || [];
                alike.push(track);
                byDescription.set(key, alike);
            }
        }

        const identical = [];
        copies.forEach((count, id) => {
            if (count < 2) return;

            const track = known.get(id);
            if (!track) return;

            identical.push({
                kind: 'identical',
                id: 'local:' + id,
                title: track.title,
                artist: track.artist,
                copies: count
            });
        });

        const probable = [];
        byDescription.forEach((tracks) => {
            // Distinct recordings only: the same id in two folders is the
            // first kind, and is already reported as that.
            const ids = new Set(tracks.map((track) => track.id));
            if (ids.size < 2) return;

            probable.push({
                kind: 'probable',
                title: tracks[0].title,
                artist: tracks[0].artist,
                duration: tracks[0].duration,
                tracks: Array.from(ids).map((id) => 'local:' + id)
            });
        });

        return { identical: identical, probable: probable };
    }

    describeLocations() {
        return this.listLocations().map((location) => ({
            id: location.id,
            // A name somebody would recognise - Music, Downloads - and never
            // the path it stands for. Where a folder is on a disk is this
            // machine's business, not the browser's.
            label: location.label,
            addedAt: location.addedAt || null,
            lastScanAt: location.lastScanAt,
            trackCount: this.libraryFor(location.path).getTracks({}).total
        }));
    }
}

module.exports = { DeviceLibrary, locationId };
