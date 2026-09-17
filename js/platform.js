/**
 * Where Spotifie is running, and what it can do there.
 *
 * Spotifie has always had two halves. One is the music on the device somebody
 * is sitting at: found by searching their own disks, indexed locally, played
 * straight off the drive, and never uploaded anywhere. The other is the
 * catalogue an administrator publishes, which is the same for everybody.
 *
 * Until now those two halves arrived through one door - the local Node server
 * on this machine - and the application simply assumed the door was there.
 * Served from a static host that assumption is false: there is no local
 * server, `/api/...` answers nothing, and an application that took the
 * assumption for granted would show an empty page and an error nobody can act
 * on.
 *
 * So the assumption is replaced by a question, asked once and answered
 * honestly: is there a helper on this machine? Everything above this file
 * works from the answer rather than from where the page came from.
 *
 * - With a helper, Spotifie is what it has always been.
 * - Without one, the published catalogue is read straight from Supabase,
 *   signing in still works, and the music on the device is reported as
 *   unavailable rather than pretended away. Nothing crashes and nothing is
 *   forgotten: what was found before is still described, and the moment a
 *   helper appears it is used again.
 *
 * Two things never change with the answer. Audio on somebody's device is
 * never uploaded - a static host is given the application and nothing else -
 * and nothing here ever holds a secret: the only Supabase values a browser
 * sees are the project URL and the anon key, which are public by design.
 */
(function (global) {
    'use strict';

    // How long any single request may take before it is abandoned. Nothing
    // waits forever: a request that hangs is a page that hangs.
    var TIMEOUTS = {
        health: 2500,
        catalogue: 12000,
        artwork: 10000,
        scan: 15000
    };

    // How long to wait before looking for a helper again, growing each time it
    // is not there and stopping at a minute. A helper that is not running is
    // not going to start because it was asked forty times a second, and the
    // asking costs a request each time.
    var RETRY_FLOOR = 2000;
    var RETRY_CEILING = 60000;

    /**
     * A fetch that gives up.
     *
     * Answers the response, or throws. A caller that wants to know why is told
     * in the message; a caller that only wants to know whether looks at the
     * capability below.
     */
    function fetchWithin(url, milliseconds, init) {
        var settings = init || {};

        if (typeof AbortController !== 'function') {
            return fetch(url, settings);
        }

        var controller = new AbortController();
        var timer = setTimeout(function () {
            controller.abort();
        }, milliseconds);

        return fetch(url, Object.assign({}, settings, { signal: controller.signal })).finally(function () {
            clearTimeout(timer);
        });
    }

    /**
     * When to try again, in milliseconds.
     *
     * Doubles each failure and stops at a minute, with up to a quarter of the
     * wait added at random - so a page with several things waiting does not
     * send all of them back at the same instant, again and again, in step.
     */
    function backoffFor(failures) {
        var base = Math.min(RETRY_FLOOR * Math.pow(2, Math.max(0, failures - 1)), RETRY_CEILING);
        return base + Math.random() * base * 0.25;
    }

    /**
     * Is this worth trying again?
     *
     * A request that was refused, or that asked for something that does not
     * exist, will be refused the same way however many times it is repeated.
     * Only the failures that might not happen next time are retried.
     */
    function worthRetrying(error) {
        if (!error) return false;
        if (error.status === undefined || error.status === null) return true; // a network failure
        if (error.status === 408 || error.status === 429) return true;
        return error.status >= 500;
    }

    // ============================================
    // What this installation can do
    // ============================================

    /**
     * The capabilities, as the rest of the application asks about them.
     *
     * Four plain questions with plain answers. Nothing here says where
     * anything is, what it is called on a disk, or who is signed in: it is a
     * description of what works, and it is safe to show or log.
     */
    function Capabilities() {
        this.online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
        // 'unknown' until asked, then 'connected' or 'disconnected'.
        this.localHelper = 'unknown';
        // 'unknown', 'available', 'cached' or 'unavailable'.
        this.cloudCatalogue = 'unknown';
        // Whether the music on this device can be reached at all.
        this.localMusic = 'unknown';
        this.listeners = new Set();
    }

    Capabilities.prototype.onChange = function (listener) {
        var self = this;
        this.listeners.add(listener);
        return function () {
            self.listeners.delete(listener);
        };
    };

    Capabilities.prototype.set = function (changes) {
        var moved = false;

        for (var key in changes || {}) {
            if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
            if (this[key] === changes[key]) continue;
            this[key] = changes[key];
            moved = true;
        }

        if (moved) this._announce();
        return moved;
    };

    Capabilities.prototype._announce = function () {
        var self = this;
        this.listeners.forEach(function (listener) {
            try {
                listener(self.describe());
            } catch (e) {
                report('capability listener failed', e);
            }
        });
    };

    /** What can be done here, as a plain object anything may read. */
    Capabilities.prototype.describe = function () {
        return {
            online: this.online,
            localHelper: this.localHelper,
            cloudCatalogue: this.cloudCatalogue,
            localMusic: this.localMusic
        };
    };

    var capabilities = new Capabilities();

    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', function () {
            capabilities.set({ online: true });
        });
        window.addEventListener('offline', function () {
            capabilities.set({ online: false });
        });
    }

    // ============================================
    // Saying what went wrong, without saying too much
    // ============================================

    /**
     * One line about something that failed, for whoever is looking at a
     * console.
     *
     * A category and a short reason. Never a token, never a password, never a
     * path on somebody's disk, and never anything out of their library: a log
     * is read by whoever is nearest, which is not always the person whose
     * library it is.
     */
    function report(category, error) {
        var reason = '';

        if (error) {
            if (error.name === 'AbortError') reason = 'timed out';
            else if (typeof error.status === 'number') reason = 'HTTP ' + error.status;
            else if (error.message) reason = String(error.message).slice(0, 120);
        }

        console.warn('Spotifie: ' + category + (reason ? ' (' + reason + ')' : ''));
    }

    // ============================================
    // The helper on this machine
    // ============================================

    /**
     * The local Node server, as one adapter behind the interface below.
     *
     * It is asked whether it is there rather than assumed to be. The answer is
     * remembered, and a helper that is not there is asked again on a schedule
     * that backs off, so a page open all day next to no helper makes a handful
     * of requests rather than thousands.
     */
    function LocalHelperAdapter(options) {
        var settings = options || {};

        // Where a helper is, which is never "wherever this page came from".
        //
        // A published copy is served from a host that has nothing to do with
        // anybody's computer, and building a helper address out of that origin
        // asked workers.dev for /api/library/health - the wrong machine, a 404,
        // and then the same question again. A helper is on loopback or it is
        // nowhere; a checkout is already on loopback and asks itself.
        var deployment = global.spotifieDeployment;
        this.baseUrl =
            settings.baseUrl !== undefined
                ? settings.baseUrl
                : (deployment && deployment.localHelperOrigin()) || '';

        this.failures = 0;
        this.checkedAt = 0;
        this.available = null;
        this.checking = null;
    }

    LocalHelperAdapter.prototype.name = 'local-helper';

    /**
     * Is a helper answering on this origin?
     *
     * Answered from the last look when that look is still fresh enough to
     * trust; otherwise by asking. Several callers asking at once share one
     * request.
     */
    LocalHelperAdapter.prototype.detectLocalCapability = function (options) {
        var self = this;
        var settings = options || {};
        var now = Date.now();

        if (this.checking) return this.checking;

        if (!settings.force && this.available !== null) {
            var wait = this.available ? 30000 : backoffFor(this.failures);
            if (now - this.checkedAt < wait) return Promise.resolve(this.available);
        }

        // A published copy does not go looking for a helper on its own.
        //
        // Most visitors have none, and a page that probed loopback would spend
        // a request per visit finding that out - blocked as mixed content on
        // an HTTPS page, or refused by the helper for not being an origin it
        // trusts, and reported in the console either way as though something
        // were broken. The answer is "no" until somebody asks for the music on
        // their device, which is the only moment asking is worth anything.
        //
        // "asked for" means exactly that: a person choosing Local Music, not a
        // timer. Nothing scheduled sets this.
        var deployment = global.spotifieDeployment;
        if (deployment && deployment.isPublished() && !settings.requested) {
            this.available = false;
            this.checkedAt = now;
            capabilities.set({ localHelper: 'disconnected' });
            return Promise.resolve(false);
        }

        this.checking = fetchWithin(this.baseUrl + '/api/library/health', TIMEOUTS.health, {
            credentials: 'same-origin',
            cache: 'no-store'
        })
            .then(function (response) {
                return response.ok;
            })
            .catch(function () {
                return false;
            })
            .then(function (ok) {
                self.checkedAt = Date.now();
                self.checking = null;

                if (ok) self.failures = 0;
                else self.failures = Math.min(self.failures + 1, 12);

                var changed = self.available !== ok;
                self.available = ok;

                capabilities.set({ localHelper: ok ? 'connected' : 'disconnected' });

                // A helper that has just come back is worth saying so about.
                if (changed && ok) capabilities._announce();
                return ok;
            });

        return this.checking;
    };

    /** The music on this device, or null when there is no helper to ask. */
    LocalHelperAdapter.prototype.getLocalLibrary = function () {
        return this._json('/api/catalog/local', TIMEOUTS.catalogue);
    };

    /** Search this device for music. Only ever from something somebody asked for. */
    LocalHelperAdapter.prototype.scanLocalMusic = function (options) {
        var settings = options || {};
        var query = settings.mode === 'full' ? '?mode=full' : '';
        return this._json('/api/library/scan' + query, TIMEOUTS.scan, { method: 'POST' });
    };

    /** Check what is already known against the disk. */
    LocalHelperAdapter.prototype.reconcileLocalMusic = function () {
        return this._json('/api/library/scan', TIMEOUTS.scan, { method: 'POST' });
    };

    /** Where one local track's audio is, as an address this origin serves. */
    LocalHelperAdapter.prototype.resolveLocalAudio = function (trackId) {
        return Promise.resolve(this.baseUrl + '/api/library/tracks/' + encodeURIComponent(bareLocalId(trackId)) + '/stream');
    };

    /** And where its picture is. */
    LocalHelperAdapter.prototype.resolveLocalArtwork = function (trackId) {
        return Promise.resolve(this.baseUrl + '/api/library/tracks/' + encodeURIComponent(bareLocalId(trackId)) + '/artwork');
    };

    /** This listener's own state, kept on this machine by the helper. */
    LocalHelperAdapter.prototype.getLocalState = function () {
        return this._json('/api/catalog/personal', TIMEOUTS.catalogue);
    };

    LocalHelperAdapter.prototype.saveLocalState = function (state) {
        return this._json('/api/catalog/personal', TIMEOUTS.catalogue, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state || {})
        });
    };

    LocalHelperAdapter.prototype._json = function (path, timeout, init) {
        var self = this;

        return fetchWithin(this.baseUrl + path, timeout, Object.assign({ credentials: 'same-origin' }, init || {}))
            .then(function (response) {
                if (!response.ok) {
                    var failure = new Error('The helper answered ' + response.status);
                    failure.status = response.status;
                    throw failure;
                }
                return response.json();
            })
            .catch(function (error) {
                // A request that could not be made at all is a helper that is
                // not there any more.
                if (error.status === undefined) {
                    self.available = false;
                    self.checkedAt = Date.now();
                    self.failures = Math.min(self.failures + 1, 12);
                    capabilities.set({ localHelper: 'disconnected' });
                }
                throw error;
            });
    };

    /** The hash inside a local track id, which is what the helper answers to. */
    function bareLocalId(trackId) {
        var value = String(trackId || '');
        return value.indexOf('local:') === 0 ? value.slice('local:'.length) : value;
    }

    // ============================================
    // Nothing on this machine
    // ============================================

    /**
     * What answers when there is no helper.
     *
     * Every question gets a truthful "not here" rather than an error, so the
     * application above can carry on drawing the half of the library that does
     * exist. Nothing throws, and nothing pretends.
     */
    function NoLocalAdapter() {}

    NoLocalAdapter.prototype.name = 'none';
    NoLocalAdapter.prototype.detectLocalCapability = function () {
        return Promise.resolve(false);
    };
    NoLocalAdapter.prototype.getLocalLibrary = function () {
        return Promise.resolve({ albums: [], tracks: [], total: 0, sources: { local: { available: false } } });
    };
    NoLocalAdapter.prototype.scanLocalMusic = function () {
        return Promise.reject(new Error('There is no Spotifie helper running on this device.'));
    };
    NoLocalAdapter.prototype.reconcileLocalMusic = NoLocalAdapter.prototype.scanLocalMusic;
    NoLocalAdapter.prototype.resolveLocalAudio = function () {
        return Promise.resolve(null);
    };
    NoLocalAdapter.prototype.resolveLocalArtwork = function () {
        return Promise.resolve(null);
    };
    NoLocalAdapter.prototype.getLocalState = function () {
        return Promise.resolve(null);
    };
    NoLocalAdapter.prototype.saveLocalState = function () {
        return Promise.resolve(false);
    };

    // ============================================
    // The one thing the rest of the application talks to
    // ============================================

    /**
     * The platform, whichever one it turns out to be.
     *
     * Every method is the same shape whether a helper answered or nothing did.
     * The player, the library and the manager call these and never ask which
     * adapter is behind them - which is the whole point: a future adapter that
     * reads a phone's own media library, or a browser's file handles, replaces
     * what is here without any of them changing.
     */
    function Platform() {
        this.local = new LocalHelperAdapter();
        this.nothing = new NoLocalAdapter();
        this.decided = null;
    }

    /**
     * Which adapter answers questions about this device right now.
     *
     * Asked afresh whenever the last answer has gone stale, so a helper
     * started after the page was opened is picked up without a reload, and one
     * that stops is noticed.
     */
    Platform.prototype.adapter = function (options) {
        var self = this;

        return this.local.detectLocalCapability(options).then(function (available) {
            self.decided = available ? self.local : self.nothing;
            return self.decided;
        });
    };

    /** True when the music on this device can be reached. */
    Platform.prototype.detectLocalCapability = function (options) {
        return this.local.detectLocalCapability(options);
    };

    /**
     * Somebody asked for the music on their device. Look properly.
     *
     * The one thing that makes a published copy reach for a helper: a person
     * choosing Local Music, rather than a timer deciding to check. Answers
     * whether one was found.
     */
    Platform.prototype.requestLocalMusic = function () {
        return this.local.detectLocalCapability({ force: true, requested: true });
    };

    /** What is known about this installation, for a decision or a log. */
    Platform.prototype.capabilities = function () {
        return capabilities.describe();
    };

    Platform.prototype.onCapabilityChange = function (listener) {
        return capabilities.onChange(listener);
    };

    /**
     * What this installation can do with the music on this device, one
     * feature at a time.
     *
     * Worked out from the adapters that are actually present, never from a
     * user-agent string:
     *
     * - the desktop shell's native commands (DesktopNativeAdapter), when the
     *   shell offers them;
     * - the local helper on this machine (LocalHelperAdapter), when it has
     *   answered;
     * - the browser's own folder picker (the browser folder adapter), when
     *   this browser has one.
     *
     * Each answer is a plain yes or no, safe to show or log. The interface
     * asks these questions rather than asking which browser or which build it
     * is running in.
     */
    Platform.prototype.localMusicFeatures = function () {
        var shell = global.spotifieDesktop;
        var native = shell && shell.isDesktop() ? shell.adapter.capabilities() : {};

        // The two phone apps answer the same questions the same way; at most
        // one of them is ever present.
        var droid = global.spotifieAndroid;
        var apple = global.spotifieIOS;
        var inAndroid = Boolean(droid && droid.isAndroid());
        var inIOS = Boolean(apple && apple.isIOS());
        var android = inAndroid ? droid.adapter.capabilities() : inIOS ? apple.adapter.capabilities() : {};

        var folders = global.spotifieBrowserLibrary;
        var picker = Boolean(folders && typeof folders.supported === 'function' && folders.supported());
        var helper = this.local.available === true;

        var adapter = 'none';
        if (native.canUseNativeFilesystem) adapter = 'desktop-native';
        else if (android.canScanManagedFolders) adapter = inIOS ? 'ios-native' : 'android-native';
        else if (helper) adapter = 'local-helper';
        else if (picker) adapter = 'browser-folders';

        // The web Media Session reaches the system's controls in a browser. In
        // the Android shell it does not - the WebView keeps it to itself - so
        // there it takes the shell's own media service to say yes.
        var webMediaSession = Boolean(global.navigator && global.navigator.mediaSession);

        var readable = Boolean(native.canOpenLocalTrack || android.canReadLocalAudio || helper || picker);

        return {
            adapter: adapter,
            canChooseDirectory: Boolean(native.canChooseDirectory || android.canChooseDirectory || picker),
            // Several songs at once from the system's file picker - where a
            // folder cannot be chosen or its provider will not list it.
            canChooseFiles: Boolean(android.canChooseFiles),
            canScanManagedFolders: Boolean(native.canScanManagedFolders || android.canScanManagedFolders || helper || picker),
            // A browser remembers the folder but may ask for permission again;
            // a native shell (a persisted grant) or the helper keeps access.
            canPersistFolderAccess: Boolean(native.canPersistFolderAccess || android.canPersistFolderAccess || helper),
            canOpenLocalTrack: readable,
            canReadLocalAudio: readable,
            // Only a native media service is counted: ordinary playback that
            // happens to continue for a while is not a guarantee.
            canUseBackgroundAudio: Boolean(android.canUseBackgroundAudio),
            // In the iOS app the web Media Session is not counted either until
            // the system's controls have been seen answering on an iPhone.
            canUseMediaControls: Boolean(android.canUseMediaControls || (!inAndroid && !inIOS && webMediaSession)),
            canRevealFile: Boolean(native.canRevealFile || android.canRevealFile),
            canShareFile: Boolean(android.canShareFile),
            canUseNativeFilesystem: Boolean(native.canUseNativeFilesystem || android.canUseNativeFilesystem)
        };
    };

    Platform.prototype.setCloudCatalogue = function (state) {
        capabilities.set({ cloudCatalogue: state });
    };

    Platform.prototype.setLocalMusic = function (state) {
        capabilities.set({ localMusic: state });
    };

    ['getLocalLibrary', 'scanLocalMusic', 'reconcileLocalMusic', 'getLocalState'].forEach(function (method) {
        Platform.prototype[method] = function (argument) {
            return this.adapter().then(function (adapter) {
                return adapter[method](argument);
            });
        };
    });

    Platform.prototype.saveLocalState = function (state) {
        return this.adapter().then(function (adapter) {
            return adapter.saveLocalState(state);
        });
    };

    Platform.prototype.resolveLocalAudio = function (trackId) {
        return this.adapter().then(function (adapter) {
            return adapter.resolveLocalAudio(trackId);
        });
    };

    Platform.prototype.resolveLocalArtwork = function (trackId) {
        return this.adapter().then(function (adapter) {
            return adapter.resolveLocalArtwork(trackId);
        });
    };

    /**
     * Watch for a helper appearing or disappearing.
     *
     * On a schedule that backs off while there is nothing there, and that
     * checks again at once when the tab is looked at - somebody who has just
     * started the helper is usually looking at the page a second later.
     */
    Platform.prototype.watch = function (onChange) {
        var self = this;
        var stopped = false;
        var timer = null;

        var stopListening = capabilities.onChange(function (state) {
            if (onChange) onChange(state);
        });

        // A published copy watches nothing.
        //
        // There is no helper to watch for on most of the machines it is read
        // on, and looking anyway - on a timer, and again whenever somebody
        // comes back to the tab - is how a page came to make hundreds of
        // requests to an address that was never going to answer it. Changes in
        // capability are still reported; they simply come from somebody asking
        // for the music on their device rather than from a clock.
        var deployment = global.spotifieDeployment;
        if (deployment && deployment.isPublished()) {
            return function () {
                stopListening();
            };
        }

        function schedule() {
            if (stopped) return;

            var wait = self.local.available ? 30000 : backoffFor(self.local.failures);
            timer = setTimeout(function () {
                self.local.detectLocalCapability({ force: true }).finally(schedule);
            }, wait);
        }

        function look() {
            if (document.visibilityState === 'visible') self.local.detectLocalCapability({ force: true });
        }

        document.addEventListener('visibilitychange', look);
        schedule();

        return function () {
            stopped = true;
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', look);
            stopListening();
        };
    };

    global.spotifiePlatform = new Platform();
    global.SpotifiePlatform = {
        Platform: Platform,
        LocalHelperAdapter: LocalHelperAdapter,
        NoLocalAdapter: NoLocalAdapter,
        Capabilities: Capabilities,
        fetchWithin: fetchWithin,
        backoffFor: backoffFor,
        worthRetrying: worthRetrying,
        report: report,
        TIMEOUTS: TIMEOUTS,
        RETRY_FLOOR: RETRY_FLOOR,
        RETRY_CEILING: RETRY_CEILING
    };
})(typeof window !== 'undefined' ? window : globalThis);
