'use strict';

/**
 * Noticing when the music on this device changes, while Spotifie is open.
 *
 * The startup check is the one that is always right: it stats every file the
 * index names and can therefore see anything that happened, including while
 * Spotifie was closed. This is the other half - it catches changes as they
 * happen, so a song deleted in a file manager leaves the library within a
 * second or two rather than at the next launch.
 *
 * It is deliberately the lesser of the two. Watching a filesystem is not
 * reliable: events are missed under load, coalesced by the operating system,
 * reported differently on every platform, and not delivered at all when
 * nothing is running. So nothing here is trusted to be complete. A watcher
 * event only means "something changed near here" - the answer is always the
 * same cheap reconciliation the startup pass does, and if the watcher misses
 * something entirely, the next start finds it.
 *
 * Built on Node's own fs.watch, and on nothing else: a dependency that watches
 * files properly would be a large one, and this does not need to be perfect to
 * be worth having.
 */

const fs = require('fs');
const path = require('path');

/**
 * How long to wait after a change before acting.
 *
 * Copying a folder of music produces a burst of events - one per file, often
 * several per file. Waiting for the burst to stop means one reconciliation
 * afterwards instead of hundreds during.
 */
const DEBOUNCE_MS = 1500;

/** Extensions worth waking up for. Anything else near the music is not music. */
const AUDIO = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4)$/i;

class DeviceWatcher {
    constructor(options) {
        const settings = options || {};
        this.deviceLibrary = settings.deviceLibrary;
        this.debounceMs = settings.debounceMs === undefined ? DEBOUNCE_MS : settings.debounceMs;
        this.onChange = settings.onChange || null;

        this.watchers = new Map();
        this.timer = null;
        this.running = false;
    }

    /**
     * Start watching the folders this device has been told to look in.
     *
     * A folder that cannot be watched - a permission, a network drive, a
     * platform that will not do it recursively - is skipped without comment.
     * Losing the watcher on one folder costs promptness there and nothing
     * else, because the startup check still covers it.
     */
    start() {
        if (this.running || !this.deviceLibrary) return this;
        this.running = true;

        for (const location of this.deviceLibrary.listLocations()) {
            this.watchLocation(location.path);
        }

        return this;
    }

    watchLocation(directory) {
        const resolved = path.resolve(directory);
        if (this.watchers.has(resolved)) return;

        let watcher;
        try {
            // Recursive watching is supported on Windows and macOS. Where it
            // is not, only the top of the folder is watched, which is still
            // better than nothing and never worse.
            watcher = fs.watch(resolved, { recursive: true, persistent: false }, (event, name) => {
                this.noticed(name);
            });
        } catch (e) {
            try {
                watcher = fs.watch(resolved, { persistent: false }, (event, name) => {
                    this.noticed(name);
                });
            } catch (fallbackError) {
                // Not watchable. The startup check covers this folder instead.
                return;
            }
        }

        watcher.on('error', () => {
            // A watcher that has died is removed rather than left to throw.
            this.watchers.delete(resolved);
            try {
                watcher.close();
            } catch (e) {
                /* already gone */
            }
        });

        this.watchers.set(resolved, watcher);
    }

    /**
     * Something changed. Wait for the rest of the burst, then look.
     *
     * The name is only used to ignore changes that cannot be music. What
     * happened is not read from the event at all - an added file, a deleted
     * one and a renamed one are all answered by the same check, which is
     * cheaper to do than to reason about and cannot be wrong about the result.
     */
    noticed(name) {
        if (name && !AUDIO.test(String(name))) return;

        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.settle();
        }, this.debounceMs);

        // Never hold the process open for a change that has not happened yet.
        if (this.timer.unref) this.timer.unref();
    }

    /** The same cheap pass the startup check runs: stats, and nothing more. */
    async settle() {
        try {
            const result = await this.deviceLibrary.reconcile();
            if (this.onChange) this.onChange(result);
        } catch (e) {
            console.warn('Could not check this device after a change:', e.message);
        }
    }

    stop() {
        this.running = false;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.watchers.forEach((watcher) => {
            try {
                watcher.close();
            } catch (e) {
                /* already closed */
            }
        });
        this.watchers.clear();
    }
}

module.exports = { DeviceWatcher, DEBOUNCE_MS };
