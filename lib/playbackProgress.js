'use strict';

/**
 * Where a listener stopped, per track.
 *
 * Coming back to a song should carry on where it was left, so the position is
 * kept against the canonical track id (`global:<uuid>`, `local:<hash>`) and
 * nothing else - no path, no file name, no album.
 *
 * Two places hold it, and only two:
 *   signed in - that person's own state file, .spotifie/users/<uid>/state.json,
 *               so two accounts on one machine never see each other's listening
 *   guest     - this machine's own file, .spotifie/device/playback.json, which
 *               is the device library's scope: whoever opens Spotifie here
 *               without signing in shares it
 *
 * It never reaches Supabase. It is fully rebuildable: losing it costs a
 * listener nothing but the place they were up to.
 */

const path = require('path');

const { DATA_DIR } = require('./config');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('./safeFs');
const {
    UserStateStore,
    isTrackId,
    isProgressNearEnd,
    normalizeTrackProgress,
    MIN_PROGRESS_SECONDS
} = require('./userState');

class PlaybackProgressStore {
    constructor(options) {
        const settings = options || {};
        this.userState = settings.userState || new UserStateStore(settings.userStateOptions);
        this.deviceDir = settings.deviceDir || path.join(DATA_DIR, 'device');
        this.guestFile = settings.guestFile || path.join(this.deviceDir, 'playback.json');
    }

    /** Everything remembered for this listener, signed in or not. */
    read(userId) {
        if (userId) return normalizeTrackProgress(this.userState.read(userId).trackProgress);

        const result = readJsonSafe(this.guestFile, { trackProgress: {} });
        return normalizeTrackProgress((result.value || {}).trackProgress);
    }

    write(userId, progress) {
        const cleaned = normalizeTrackProgress(progress);

        if (userId) {
            const state = this.userState.read(userId);
            state.trackProgress = cleaned;
            this.userState.write(userId, state);
            return cleaned;
        }

        ensureDir(path.dirname(this.guestFile));
        writeJsonAtomic(this.guestFile, { trackProgress: cleaned, updatedAt: new Date().toISOString() });
        return cleaned;
    }

    /**
     * Remember where a track was left.
     *
     * A track heard to its end, or all but its end, is forgotten instead: the
     * next time it is chosen it starts from the beginning.
     */
    save(userId, trackId, position, duration) {
        if (!isTrackId(trackId)) throw new Error('A canonical track id is required');
        if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) {
            throw new Error('A playback position is required');
        }

        const progress = this.read(userId);
        const cleared = { trackId: trackId, position: 0, cleared: true };

        if (position < MIN_PROGRESS_SECONDS || isProgressNearEnd(position, duration)) {
            if (!progress[trackId]) return cleared;
            delete progress[trackId];
            this.write(userId, progress);
            return cleared;
        }

        const entry = { position: position, updatedAt: new Date().toISOString() };
        if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
            entry.duration = duration;
        }
        progress[trackId] = entry;

        const saved = this.write(userId, progress);
        return Object.assign({ trackId: trackId, cleared: false }, saved[trackId]);
    }

    /** Where to start this track, in seconds. Zero when there is nothing kept. */
    positionFor(userId, trackId) {
        if (!isTrackId(trackId)) return 0;
        const entry = this.read(userId)[trackId];
        return entry ? entry.position : 0;
    }

    /** Forget one track, or everything when no track is named. */
    clear(userId, trackId) {
        if (!trackId) return this.write(userId, {});

        const progress = this.read(userId);
        if (!progress[trackId]) return progress;
        delete progress[trackId];
        return this.write(userId, progress);
    }
}

module.exports = { PlaybackProgressStore, isTrackId, isProgressNearEnd, MIN_PROGRESS_SECONDS };
