'use strict';

/**
 * Per-user local state, stored at .spotifie/users/<uid>/state.json.
 *
 * Everything a person builds on top of the music lives here: the songs they
 * liked, the playlists they made, what they have been listening to, and their
 * own view of the shared catalogue. None of it goes to Supabase, which holds
 * accounts and the published catalogue and nothing personal.
 *
 * What is written is references and nothing else - canonical track ids, and
 * an artwork id this machine can serve. No audio, no pictures, no signed
 * address, no filesystem path. A playlist is a list of ids; the songs it names
 * are resolved against the library each time it is shown, so a file that has
 * moved or a track that has been withdrawn is a missing entry rather than a
 * broken one.
 *
 * Two people using the same machine have two of these files and share nothing
 * in them. A guest has none, and is asked to sign in rather than being given
 * somebody else's.
 *
 * Writes are atomic (temp file + rename) and the file is fully rebuildable
 * from nothing: losing it costs the organisation, never the music.
 */

const crypto = require('crypto');
const path = require('path');

const { DATA_DIR } = require('./config');
const { containPath, ensureDir, readJsonSafe, writeJsonAtomic } = require('./safeFs');

/**
 * What the file looks like.
 *
 * 2 added liked songs, playlists and listening history. A version 1 file reads
 * back cleanly - the new collections are simply empty - so nothing needs
 * migrating and nobody loses what they had.
 */
const SCHEMA_VERSION = 2;

// A personal addition list is a playlist, not a library: keep it bounded.
const MAX_TRACKS_PER_ALBUM = 500;

// Somebody's own collections, kept to sizes a page can draw and a file can
// hold. These are generous enough not to be met in ordinary use.
const MAX_LIKED_TRACKS = 10000;
const MAX_PLAYLISTS = 500;
const MAX_TRACKS_PER_PLAYLIST = 2000;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

// What was listened to lately, and only lately. Old enough entries fall off
// the end: this is a way back to something, not a record of a life.
const MAX_RECENT_TRACKS = 200;

// Where a listener stopped, per track. A track is only remembered once it has
// been listened to for a while, is forgotten again once it has been heard to
// its end, and the oldest entries go when there are too many: this is a
// convenience, not an archive, and it never leaves this machine.
const MIN_PROGRESS_SECONDS = 5;
const PROGRESS_END_MARGIN_SECONDS = 10;
const PROGRESS_END_FRACTION = 0.98;
const MAX_PROGRESS_TRACKS = 500;

function emptyState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        hiddenGlobalTrackIds: [],
        hiddenGlobalAlbumIds: [],
        // Local tracks a user has removed from their own view. Local files are
        // never deleted and Supabase is never involved.
        hiddenLocalTrackIds: [],
        // A user's own edits to published albums, keyed by the album uuid.
        // Presentation only: the shared record in Supabase is never touched.
        globalAlbumOverrides: {},
        // Music of their own that a user has put into a published album,
        // keyed by the album uuid. Only ids of local tracks live here: the
        // audio stays on this device and the shared album never changes.
        globalAlbumTrackAdds: {},
        // Songs this person liked, newest first. Ids only: liking a song adds
        // a reference to it, never a copy of it.
        likedTrackIds: [],
        // Playlists they made. Each is a title, some words about it, an
        // optional cover this machine serves, and a list of track ids.
        playlists: [],
        // What they have played lately, newest first.
        recentlyPlayed: [],
        // Where this person stopped in each track, keyed by canonical track id.
        trackProgress: {},
        updatedAt: null
    };
}

function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

/** Trim a field, or null when it carries nothing. */
function normalizeText(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
}

/** A local artwork reference: an id served by this machine, nothing else. */
function normalizeArtwork(value) {
    if (!value || typeof value !== 'object') return null;
    const reference = normalizeText(value.reference);
    if (!reference) return null;
    if (/^(https?:|blob:|data:)/i.test(reference)) return null;
    return { type: 'local', reference: reference };
}

/**
 * A user's personal edits to published albums, keyed by the album's real uuid.
 * Only presentation fields live here: no audio, no track rows, no Supabase
 * metadata, and never a signed URL.
 */
function normalizeOverrides(value) {
    if (!value || typeof value !== 'object') return {};

    const result = {};
    for (const key of Object.keys(value)) {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) continue;

        const entry = value[key];
        if (!entry || typeof entry !== 'object') continue;

        const normalized = {};
        const title = normalizeText(entry.title);
        const artist = normalizeText(entry.artist);
        const description = normalizeText(entry.description);
        const artwork = normalizeArtwork(entry.artwork);

        if (title) normalized.title = title;
        if (artist) normalized.artist = artist;
        if (description) normalized.description = description;
        if (artwork) normalized.artwork = artwork;

        // An entry that overrides nothing is not kept.
        if (!Object.keys(normalized).length) continue;

        normalized.updatedAt = normalizeText(entry.updatedAt) || new Date().toISOString();
        result[key] = normalized;
    }
    return result;
}

/**
 * The local tracks a user has added to published albums.
 *
 * Keyed by album uuid, and only ever local track ids: a global id here would
 * mean duplicating the shared catalogue, and anything else would mean
 * pointing at something this device cannot serve.
 */
function normalizeTrackAdds(value) {
    if (!value || typeof value !== 'object') return {};

    const result = {};
    for (const key of Object.keys(value)) {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) continue;

        const ids = normalizeList(value[key]).filter((id) => /^local:[A-Za-z0-9_-]{8,128}$/.test(id));
        if (!ids.length) continue;

        result[key] = ids.slice(0, MAX_TRACKS_PER_ALBUM);
    }
    return result;
}

/** A canonical track id, and nothing else: no path, no file name, no album. */
function isTrackId(value) {
    return typeof value === 'string' && /^(local|global):[A-Za-z0-9_-]{8,128}$/.test(value);
}

function isFinitePositive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * True when a position is close enough to the end of a track that returning to
 * it should start it again, rather than drop the listener into its last
 * seconds.
 */
function isProgressNearEnd(position, duration) {
    if (!isFinitePositive(duration) || duration <= 0) return false;
    if (position >= duration - PROGRESS_END_MARGIN_SECONDS) return true;
    return position / duration >= PROGRESS_END_FRACTION;
}

/** Keep only what a listening position is allowed to be, newest kept first. */
function normalizeTrackProgress(value) {
    if (!value || typeof value !== 'object') return {};

    const entries = [];
    for (const key of Object.keys(value)) {
        if (!isTrackId(key)) continue;

        const entry = value[key];
        if (!entry || typeof entry !== 'object') continue;
        if (!isFinitePositive(entry.position)) continue;

        // A day is longer than any song: past that the number is not a position.
        const position = Math.min(entry.position, 24 * 60 * 60);
        if (position < MIN_PROGRESS_SECONDS) continue;

        const record = {
            position: Math.round(position * 10) / 10,
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString()
        };
        if (isFinitePositive(entry.duration) && entry.duration > 0) {
            record.duration = Math.round(entry.duration * 10) / 10;
        }

        entries.push([key, record]);
    }

    // Newest first, so trimming drops what was listened to longest ago.
    entries.sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));

    const result = {};
    for (const pair of entries.slice(0, MAX_PROGRESS_TRACKS)) {
        result[pair[0]] = pair[1];
    }
    return result;
}

/** A list of canonical track ids, in order, with a ceiling. */
function normalizeTrackIds(value, limit, options) {
    const settings = options || {};
    if (!Array.isArray(value)) return [];

    const seen = new Set();
    const result = [];

    for (const entry of value) {
        if (!isTrackId(entry)) continue;

        // A playlist may name the same song twice on purpose - somebody put it
        // there twice. A set of likes may not: liking a song again is still
        // one like.
        if (!settings.allowDuplicates) {
            if (seen.has(entry)) continue;
            seen.add(entry);
        }

        result.push(entry);
        if (result.length >= limit) break;
    }

    return result;
}

/** Text for a title or a description, trimmed and bounded. */
function normalizeLabel(value, limit) {
    const text = normalizeText(value);
    if (!text) return null;
    return text.length > limit ? text.slice(0, limit).trim() : text;
}

/** A playlist id this machine made: a plain, opaque token. */
function isPlaylistId(value) {
    return typeof value === 'string' && /^playlist:[A-Za-z0-9_-]{8,64}$/.test(value);
}

function timestampOf(value) {
    return typeof value === 'string' && value ? value : new Date().toISOString();
}

/**
 * One playlist, reduced to what a playlist is.
 *
 * A title, some words, a cover this machine can serve, and an ordered list of
 * track ids. Anything else that arrives - a copy of the songs, a picture, an
 * address that expires - is left behind here rather than being written down.
 */
function normalizePlaylist(value) {
    if (!value || typeof value !== 'object') return null;
    if (!isPlaylistId(value.id)) return null;

    const title = normalizeLabel(value.title, MAX_TITLE_LENGTH);
    if (!title) return null;

    const playlist = {
        id: value.id,
        title: title,
        description: normalizeLabel(value.description, MAX_DESCRIPTION_LENGTH),
        artwork: normalizeArtwork(value.artwork),
        trackIds: normalizeTrackIds(value.trackIds, MAX_TRACKS_PER_PLAYLIST, { allowDuplicates: true }),
        createdAt: timestampOf(value.createdAt),
        updatedAt: timestampOf(value.updatedAt)
    };

    return playlist;
}

function normalizePlaylists(value) {
    if (!Array.isArray(value)) return [];

    const result = [];
    const seen = new Set();

    for (const entry of value) {
        const playlist = normalizePlaylist(entry);
        if (!playlist || seen.has(playlist.id)) continue;
        seen.add(playlist.id);
        result.push(playlist);
        if (result.length >= MAX_PLAYLISTS) break;
    }

    return result;
}

/**
 * What was played lately, newest first.
 *
 * One entry per song: playing something again moves it to the front rather
 * than adding a second line, so a track left on repeat does not push out
 * everything else that was heard today.
 */
function normalizeRecentlyPlayed(value) {
    if (!Array.isArray(value)) return [];

    const entries = [];
    const seen = new Set();

    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        if (!isTrackId(entry.id) || seen.has(entry.id)) continue;

        seen.add(entry.id);
        entries.push({ id: entry.id, playedAt: timestampOf(entry.playedAt) });
    }

    entries.sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
    return entries.slice(0, MAX_RECENT_TRACKS);
}

/**
 * A name for a new playlist that nothing else will have.
 *
 * Random, and long enough that two made in the same instant do not collide.
 * It says nothing about the person or the songs - it is a handle, not a
 * description.
 */
function newPlaylistToken() {
    return crypto.randomBytes(12).toString('hex');
}

/** Supabase user ids are uuids; anything else is refused outright. */
function isValidUserId(userId) {
    return typeof userId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(userId);
}

class UserStateStore {
    constructor(options) {
        const settings = options || {};
        this.rootDir = settings.rootDir || path.join(DATA_DIR, 'users');
    }

    /** Absolute path of a user's state file, or null when the id is unusable. */
    stateFileFor(userId) {
        if (!isValidUserId(userId)) return null;
        const userDir = containPath(this.rootDir, userId);
        if (!userDir) return null;
        return path.join(userDir, 'state.json');
    }

    /** Read a user's state; a missing or damaged file yields empty state. */
    read(userId) {
        const file = this.stateFileFor(userId);
        if (!file) return emptyState();

        const result = readJsonSafe(file, emptyState());
        const candidate = result.value || {};

        return {
            schemaVersion: SCHEMA_VERSION,
            hiddenGlobalTrackIds: normalizeList(candidate.hiddenGlobalTrackIds),
            hiddenGlobalAlbumIds: normalizeList(candidate.hiddenGlobalAlbumIds),
            hiddenLocalTrackIds: normalizeList(candidate.hiddenLocalTrackIds),
            globalAlbumOverrides: normalizeOverrides(candidate.globalAlbumOverrides),
            globalAlbumTrackAdds: normalizeTrackAdds(candidate.globalAlbumTrackAdds),
            likedTrackIds: normalizeTrackIds(candidate.likedTrackIds, MAX_LIKED_TRACKS),
            playlists: normalizePlaylists(candidate.playlists),
            recentlyPlayed: normalizeRecentlyPlayed(candidate.recentlyPlayed),
            trackProgress: normalizeTrackProgress(candidate.trackProgress),
            updatedAt: candidate.updatedAt || null
        };
    }

    write(userId, state) {
        const file = this.stateFileFor(userId);
        if (!file) throw new Error('Invalid user id');

        const payload = {
            schemaVersion: SCHEMA_VERSION,
            hiddenGlobalTrackIds: normalizeList(state.hiddenGlobalTrackIds),
            hiddenGlobalAlbumIds: normalizeList(state.hiddenGlobalAlbumIds),
            hiddenLocalTrackIds: normalizeList(state.hiddenLocalTrackIds),
            globalAlbumOverrides: normalizeOverrides(state.globalAlbumOverrides),
            globalAlbumTrackAdds: normalizeTrackAdds(state.globalAlbumTrackAdds),
            likedTrackIds: normalizeTrackIds(state.likedTrackIds, MAX_LIKED_TRACKS),
            playlists: normalizePlaylists(state.playlists),
            recentlyPlayed: normalizeRecentlyPlayed(state.recentlyPlayed),
            trackProgress: normalizeTrackProgress(state.trackProgress),
            updatedAt: new Date().toISOString()
        };

        ensureDir(path.dirname(file));
        writeJsonAtomic(file, payload);
        return payload;
    }

    /**
     * Hide a global item for this user only.
     * Nothing here can reach Supabase - it is a local preference.
     */
    hide(userId, kind, id) {
        const state = this.read(userId);
        const key = kind === 'album' ? 'hiddenGlobalAlbumIds' : 'hiddenGlobalTrackIds';
        if (!state[key].includes(id)) {
            state[key].push(id);
        }
        return this.write(userId, state);
    }

    /** Restore a previously hidden global item for this user. */
    restore(userId, kind, id) {
        const state = this.read(userId);
        const key = kind === 'album' ? 'hiddenGlobalAlbumIds' : 'hiddenGlobalTrackIds';
        state[key] = state[key].filter((entry) => entry !== id);
        return this.write(userId, state);
    }

    restoreAll(userId) {
        const state = this.read(userId);
        return this.write(userId, {
            hiddenGlobalTrackIds: [],
            hiddenGlobalAlbumIds: [],
            hiddenLocalTrackIds: [],
            globalAlbumOverrides: state.globalAlbumOverrides,
            globalAlbumTrackAdds: state.globalAlbumTrackAdds,
            // Bringing hidden content back says nothing about what somebody
            // liked, made or listened to.
            likedTrackIds: state.likedTrackIds,
            playlists: state.playlists,
            recentlyPlayed: state.recentlyPlayed,
            trackProgress: state.trackProgress
        });
    }

    /**
     * Save this user's personal edits to a published album.
     * Fields left out are cleared; the shared album in Supabase is untouched,
     * and nothing here can reach it.
     */
    setAlbumOverride(userId, albumUuid, override) {
        const state = this.read(userId);
        const overrides = Object.assign({}, state.globalAlbumOverrides);

        const candidate = Object.assign({}, override || {}, { updatedAt: new Date().toISOString() });
        const cleaned = normalizeOverrides({ [albumUuid]: candidate })[albumUuid];

        if (cleaned) {
            overrides[albumUuid] = cleaned;
        } else {
            delete overrides[albumUuid];
        }

        state.globalAlbumOverrides = overrides;
        return this.write(userId, state);
    }

    /** Forget this user's edits to one published album. */
    clearAlbumOverride(userId, albumUuid) {
        const state = this.read(userId);
        const overrides = Object.assign({}, state.globalAlbumOverrides);
        const removed = overrides[albumUuid] || null;
        delete overrides[albumUuid];

        state.globalAlbumOverrides = overrides;
        this.write(userId, state);
        return removed;
    }

    getAlbumOverride(userId, albumUuid) {
        return this.read(userId).globalAlbumOverrides[albumUuid] || null;
    }

    /**
     * Put one of this user's own local tracks into a published album.
     * Their copy of the album only: the shared album is never written to.
     */
    addAlbumTrack(userId, albumUuid, trackId) {
        const state = this.read(userId);
        const adds = Object.assign({}, state.globalAlbumTrackAdds);
        const current = adds[albumUuid] || [];

        if (current.includes(trackId)) return current.slice();
        if (current.length >= MAX_TRACKS_PER_ALBUM) {
            throw new Error('That album already holds as many of your songs as it can');
        }

        adds[albumUuid] = current.concat([trackId]);
        state.globalAlbumTrackAdds = adds;
        const saved = this.write(userId, state);
        return (saved.globalAlbumTrackAdds[albumUuid] || []).slice();
    }

    /**
     * Take one of this user's own tracks back out of a published album.
     * Membership only: the file on this device is left where it is.
     */
    removeAlbumTrack(userId, albumUuid, trackId) {
        const state = this.read(userId);
        const adds = Object.assign({}, state.globalAlbumTrackAdds);
        const current = adds[albumUuid] || [];
        // Every record of that track goes, not the first one: an older state
        // file may hold the same id more than once, and one removal is one
        // removal.
        const next = current.filter((entry) => entry !== trackId);

        if (next.length === current.length) return { removed: false, tracks: current.slice() };

        if (next.length) {
            adds[albumUuid] = next;
        } else {
            delete adds[albumUuid];
        }

        state.globalAlbumTrackAdds = adds;
        this.write(userId, state);
        return { removed: true, tracks: next };
    }

    getAlbumTrackAdds(userId) {
        return this.read(userId).globalAlbumTrackAdds;
    }


    // ============================================
    // Liked songs
    //
    // A like is a reference to a song, kept newest first. Liking something
    // twice is still one like; unliking something that was never liked is not
    // an error, it is simply nothing to do.
    // ============================================

    /** Add a song to this person's liked songs. Answers the new list. */
    like(userId, trackId) {
        if (!isTrackId(trackId)) throw new Error('That is not a track');

        const state = this.read(userId);
        if (state.likedTrackIds.includes(trackId)) return state.likedTrackIds.slice();

        if (state.likedTrackIds.length >= MAX_LIKED_TRACKS) {
            throw new Error('Your liked songs are full');
        }

        state.likedTrackIds = [trackId].concat(state.likedTrackIds);
        return this.write(userId, state).likedTrackIds.slice();
    }

    /** Take a song back out of liked songs. The file itself is untouched. */
    unlike(userId, trackId) {
        const state = this.read(userId);
        const next = state.likedTrackIds.filter((entry) => entry !== trackId);
        if (next.length === state.likedTrackIds.length) return state.likedTrackIds.slice();

        state.likedTrackIds = next;
        return this.write(userId, state).likedTrackIds.slice();
    }

    /** Like it if it is not liked, unlike it if it is. */
    toggleLike(userId, trackId) {
        const liked = this.isLiked(userId, trackId);
        const trackIds = liked ? this.unlike(userId, trackId) : this.like(userId, trackId);
        return { liked: !liked, trackIds: trackIds };
    }

    getLiked(userId) {
        return this.read(userId).likedTrackIds.slice();
    }

    isLiked(userId, trackId) {
        return this.read(userId).likedTrackIds.includes(trackId);
    }

    // ============================================
    // Playlists
    //
    // A playlist is a name and an ordered list of track ids. The same song may
    // appear in it more than once, because somebody may have meant to put it
    // there twice; an album's membership is a different thing and stays
    // deduplicated.
    // ============================================

    /** Make a playlist. Answers the playlist as it was saved. */
    createPlaylist(userId, details) {
        const settings = details || {};
        const state = this.read(userId);

        if (state.playlists.length >= MAX_PLAYLISTS) {
            throw new Error('You have as many playlists as this can hold');
        }

        const now = new Date().toISOString();
        const playlist = normalizePlaylist({
            id: 'playlist:' + newPlaylistToken(),
            title: settings.title,
            description: settings.description,
            artwork: settings.artwork,
            trackIds: settings.trackIds,
            createdAt: now,
            updatedAt: now
        });

        if (!playlist) throw new Error('A playlist needs a name');

        state.playlists = state.playlists.concat([playlist]);
        const saved = this.write(userId, state);
        return saved.playlists.find((entry) => entry.id === playlist.id) || playlist;
    }

    /**
     * Change a playlist's name, its words, or its cover.
     *
     * Only the fields named are touched. Passing null for the description or
     * the artwork clears it; leaving it out keeps what is there.
     */
    updatePlaylist(userId, playlistId, patch) {
        const state = this.read(userId);
        const index = state.playlists.findIndex((entry) => entry.id === playlistId);
        if (index === -1) return null;

        const current = state.playlists[index];
        const changes = patch || {};

        const candidate = {
            id: current.id,
            title: 'title' in changes ? changes.title : current.title,
            description: 'description' in changes ? changes.description : current.description,
            artwork: 'artwork' in changes ? changes.artwork : current.artwork,
            trackIds: current.trackIds,
            createdAt: current.createdAt,
            updatedAt: new Date().toISOString()
        };

        const updated = normalizePlaylist(candidate);
        if (!updated) throw new Error('A playlist needs a name');

        state.playlists = state.playlists.slice();
        state.playlists[index] = updated;

        const saved = this.write(userId, state);
        return saved.playlists.find((entry) => entry.id === playlistId) || null;
    }

    /**
     * Delete a playlist.
     *
     * The list goes; every song in it stays exactly where it was. Answers what
     * was removed, so a caller can say what it was.
     */
    deletePlaylist(userId, playlistId) {
        const state = this.read(userId);
        const removed = state.playlists.find((entry) => entry.id === playlistId) || null;
        if (!removed) return null;

        state.playlists = state.playlists.filter((entry) => entry.id !== playlistId);
        this.write(userId, state);
        return removed;
    }

    getPlaylists(userId) {
        return this.read(userId).playlists.map((entry) => Object.assign({}, entry, { trackIds: entry.trackIds.slice() }));
    }

    getPlaylist(userId, playlistId) {
        const found = this.read(userId).playlists.find((entry) => entry.id === playlistId);
        return found ? Object.assign({}, found, { trackIds: found.trackIds.slice() }) : null;
    }

    /**
     * Put a song in a playlist.
     *
     * At the end by default, or at a position when one is given. A song
     * already in the list is added again rather than refused: a playlist is
     * somebody's arrangement, and repeating something in it is allowed.
     */
    addPlaylistTrack(userId, playlistId, trackId, options) {
        if (!isTrackId(trackId)) throw new Error('That is not a track');

        const settings = options || {};
        const state = this.read(userId);
        const index = state.playlists.findIndex((entry) => entry.id === playlistId);
        if (index === -1) return null;

        const playlist = state.playlists[index];
        if (playlist.trackIds.length >= MAX_TRACKS_PER_PLAYLIST) {
            throw new Error('That playlist is full');
        }

        const trackIds = playlist.trackIds.slice();
        const at = Number.isInteger(settings.position) ? Math.max(0, Math.min(settings.position, trackIds.length)) : trackIds.length;
        trackIds.splice(at, 0, trackId);

        state.playlists = state.playlists.slice();
        state.playlists[index] = Object.assign({}, playlist, {
            trackIds: trackIds,
            updatedAt: new Date().toISOString()
        });

        const saved = this.write(userId, state);
        return saved.playlists.find((entry) => entry.id === playlistId) || null;
    }

    /**
     * Take a song out of a playlist.
     *
     * A position removes exactly that entry, which is what a list holding the
     * same song twice needs. Without one, every copy of that song goes.
     */
    removePlaylistTrack(userId, playlistId, trackId, options) {
        const settings = options || {};
        const state = this.read(userId);
        const index = state.playlists.findIndex((entry) => entry.id === playlistId);
        if (index === -1) return null;

        const playlist = state.playlists[index];
        let trackIds;

        if (Number.isInteger(settings.position)) {
            if (settings.position < 0 || settings.position >= playlist.trackIds.length) return null;
            if (trackId && playlist.trackIds[settings.position] !== trackId) return null;

            trackIds = playlist.trackIds.slice();
            trackIds.splice(settings.position, 1);
        } else {
            trackIds = playlist.trackIds.filter((entry) => entry !== trackId);
            if (trackIds.length === playlist.trackIds.length) return null;
        }

        state.playlists = state.playlists.slice();
        state.playlists[index] = Object.assign({}, playlist, {
            trackIds: trackIds,
            updatedAt: new Date().toISOString()
        });

        const saved = this.write(userId, state);
        return saved.playlists.find((entry) => entry.id === playlistId) || null;
    }

    /**
     * Move one song to another place in a playlist.
     *
     * By position, not by id, because the same song may be in the list more
     * than once and only one of them is being moved.
     */
    movePlaylistTrack(userId, playlistId, from, to) {
        const state = this.read(userId);
        const index = state.playlists.findIndex((entry) => entry.id === playlistId);
        if (index === -1) return null;

        const playlist = state.playlists[index];
        const length = playlist.trackIds.length;

        if (!Number.isInteger(from) || from < 0 || from >= length) return null;
        if (!Number.isInteger(to) || to < 0 || to >= length) return null;
        if (from === to) return Object.assign({}, playlist);

        const trackIds = playlist.trackIds.slice();
        const [moved] = trackIds.splice(from, 1);
        trackIds.splice(to, 0, moved);

        state.playlists = state.playlists.slice();
        state.playlists[index] = Object.assign({}, playlist, {
            trackIds: trackIds,
            updatedAt: new Date().toISOString()
        });

        const saved = this.write(userId, state);
        return saved.playlists.find((entry) => entry.id === playlistId) || null;
    }

    /**
     * Put a playlist in a given order outright.
     *
     * Used when a whole list has been rearranged at once. Only the songs
     * already in it may appear, and each of them as many times as it was
     * there, so a reorder cannot quietly add or drop anything.
     */
    reorderPlaylist(userId, playlistId, trackIds) {
        const state = this.read(userId);
        const index = state.playlists.findIndex((entry) => entry.id === playlistId);
        if (index === -1) return null;

        const playlist = state.playlists[index];
        if (!Array.isArray(trackIds) || trackIds.length !== playlist.trackIds.length) return null;

        const before = playlist.trackIds.slice().sort();
        const after = trackIds.slice().sort();
        for (let i = 0; i < before.length; i += 1) {
            if (before[i] !== after[i]) return null;
        }

        state.playlists = state.playlists.slice();
        state.playlists[index] = Object.assign({}, playlist, {
            trackIds: trackIds.slice(),
            updatedAt: new Date().toISOString()
        });

        const saved = this.write(userId, state);
        return saved.playlists.find((entry) => entry.id === playlistId) || null;
    }

    // ============================================
    // Recently played
    // ============================================

    /**
     * Note that a song was played.
     *
     * One entry per song, moved to the front each time. A track played twice
     * in a row does not fill the list with itself, and the list is bounded, so
     * this stays a way back to something heard earlier rather than a log.
     */
    notePlayed(userId, trackId, playedAt) {
        if (!isTrackId(trackId)) throw new Error('That is not a track');

        const state = this.read(userId);
        const when = timestampOf(playedAt);

        // Already at the front and played a moment ago: nothing has changed
        // that a listener would see, so nothing is written.
        const first = state.recentlyPlayed[0];
        if (first && first.id === trackId && Date.now() - Date.parse(first.playedAt) < 30 * 1000) {
            return state.recentlyPlayed.slice();
        }

        state.recentlyPlayed = [{ id: trackId, playedAt: when }].concat(
            state.recentlyPlayed.filter((entry) => entry.id !== trackId)
        );

        return this.write(userId, state).recentlyPlayed.slice();
    }

    getRecentlyPlayed(userId) {
        return this.read(userId).recentlyPlayed.slice();
    }

    /** Forget the listening history. Nothing else is touched. */
    clearRecentlyPlayed(userId) {
        const state = this.read(userId);
        state.recentlyPlayed = [];
        return this.write(userId, state).recentlyPlayed.slice();
    }

    isTrackHidden(userId, id) {
        return this.read(userId).hiddenGlobalTrackIds.includes(id);
    }

    isAlbumHidden(userId, id) {
        return this.read(userId).hiddenGlobalAlbumIds.includes(id);
    }
}

module.exports = {
    UserStateStore,
    SCHEMA_VERSION,
    isPlaylistId,
    MAX_LIKED_TRACKS,
    MAX_PLAYLISTS,
    MAX_TRACKS_PER_PLAYLIST,
    MAX_RECENT_TRACKS,
    MAX_TITLE_LENGTH,
    MAX_DESCRIPTION_LENGTH,
    emptyState,
    isValidUserId,
    isTrackId,
    isProgressNearEnd,
    normalizeTrackProgress,
    MIN_PROGRESS_SECONDS,
    PROGRESS_END_MARGIN_SECONDS,
    MAX_PROGRESS_TRACKS
};
