/**
 * Spotifie as an installed application.
 *
 * Four small jobs, all about the application rather than the music:
 *
 * - offering to install it, once, where the browser supports that, and never
 *   when it is already installed or somebody has just said no;
 * - saying when a newer version is available, and letting the person choose
 *   when to reload - never reloading on its own in the middle of a song;
 * - saying, quietly, when the device is offline and what still works;
 * - telling the stylesheet how it is being displayed (a browser tab, an
 *   installed window, or the desktop shell), for layout only. Nothing here is a
 *   security decision.
 *
 * Nothing here reads a token, a key or anything out of a library.
 */
(function (global) {
    'use strict';

    // How long a "not now" on the install prompt is respected.
    var DISMISS_KEY = 'spotifie_install_dismissed_at';
    var DISMISS_DAYS = 14;

    // How often a published copy asks whether a newer build exists. It is
    // asked when somebody comes back to the tab, never more often than this.
    var BUILD_CHECK_EVERY = 30 * 60 * 1000;

    var state = {
        deferredPrompt: null,
        updateShown: false,
        lastBuildCheck: 0
    };

    function doc() {
        return global.document || null;
    }

    function store() {
        try {
            return global.localStorage || null;
        } catch (e) {
            return null;
        }
    }

    // ============================================
    // How the application is displayed
    // ============================================

    function matches(query) {
        try {
            return Boolean(global.matchMedia && global.matchMedia(query).matches);
        } catch (e) {
            return false;
        }
    }

    /** Installed and opened in its own window, rather than in a browser tab. */
    function standalone() {
        if (matches('(display-mode: standalone)') || matches('(display-mode: window-controls-overlay)')) return true;
        // Safari on iOS says so its own way.
        return Boolean(global.navigator && global.navigator.standalone === true);
    }

    function desktopShell() {
        return Boolean(global.spotifieDesktop && global.spotifieDesktop.isDesktop());
    }

    function androidShell() {
        if (global.spotifieAndroid && global.spotifieAndroid.isAndroid()) return true;
        // Capacitor's bridge is in every page of the Android app, whether or
        // not that page loaded Spotifie's own adapter.
        var bridge = global.Capacitor;
        try {
            return Boolean(
                bridge &&
                    typeof bridge.isNativePlatform === 'function' &&
                    bridge.isNativePlatform() &&
                    typeof bridge.getPlatform === 'function' &&
                    bridge.getPlatform() === 'android'
            );
        } catch (e) {
            return false;
        }
    }

    function iosShell() {
        if (global.spotifieIOS && global.spotifieIOS.isIOS()) return true;
        var bridge = global.Capacitor;
        try {
            return Boolean(
                bridge &&
                    typeof bridge.isNativePlatform === 'function' &&
                    bridge.isNativePlatform() &&
                    typeof bridge.getPlatform === 'function' &&
                    bridge.getPlatform() === 'ios'
            );
        } catch (e) {
            return false;
        }
    }

    function displayMode() {
        if (desktopShell()) return 'desktop';
        if (androidShell()) return 'android';
        if (iosShell()) return 'ios';
        return standalone() ? 'standalone' : 'browser';
    }

    function applyDisplayMode() {
        var d = doc();
        var mode = displayMode();
        if (d && d.documentElement && d.documentElement.setAttribute) {
            d.documentElement.setAttribute('data-display-mode', mode);
        }
        return mode;
    }

    // ============================================
    // Installing
    // ============================================

    function dismissedRecently(now) {
        var saved = store();
        var at = saved ? Number(saved.getItem(DISMISS_KEY)) || 0 : 0;
        return at > 0 && now - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
    }

    function installButton() {
        var d = doc();
        return d && d.getElementById ? d.getElementById('installAppBtn') : null;
    }

    /**
     * Offered only when the browser has said it can install Spotifie, the
     * application is not already running installed, and nobody declined in the
     * last two weeks. A browser that never says so - Safari, Firefox - simply
     * never shows the action: there is no fake prompt.
     */
    function canOfferInstall(now) {
        return Boolean(state.deferredPrompt) && displayMode() === 'browser' && !dismissedRecently(now || Date.now());
    }

    function renderInstall() {
        var button = installButton();
        if (button) button.hidden = !canOfferInstall();
    }

    function onBeforeInstallPrompt(event) {
        // The browser's own infobar would appear on its own schedule. There is
        // one Install action instead, shown in the header and used only when
        // somebody presses it.
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        state.deferredPrompt = event;
        renderInstall();
    }

    /** Show the browser's install dialog. Answers 'accepted', 'dismissed' or 'unavailable'. */
    function install() {
        var prompt = state.deferredPrompt;
        if (!prompt || typeof prompt.prompt !== 'function') return Promise.resolve('unavailable');

        // A prompt can be shown once; the browser offers another if it will.
        state.deferredPrompt = null;
        renderInstall();

        return Promise.resolve(prompt.prompt())
            .then(function () {
                return prompt.userChoice;
            })
            .then(function (choice) {
                var outcome = (choice && choice.outcome) || 'unknown';
                if (outcome === 'dismissed') {
                    var saved = store();
                    try {
                        if (saved) saved.setItem(DISMISS_KEY, String(Date.now()));
                    } catch (e) {
                        /* a browser that keeps nothing asks again next time */
                    }
                }
                renderInstall();
                return outcome;
            })
            .catch(function () {
                return 'unknown';
            });
    }

    function onInstalled() {
        state.deferredPrompt = null;
        var saved = store();
        try {
            if (saved) saved.removeItem(DISMISS_KEY);
        } catch (e) {
            /* nothing to forget */
        }
        applyDisplayMode();
        renderInstall();
    }

    // ============================================
    // The Android app
    // ============================================

    var ANDROID_APP_PATH = '/downloads/spotifie-android.apk';
    var ANDROID_APP_FILENAME = 'Spotifie-Android.apk';

    /**
     * The Android app this website offers, as the build recorded it, or null.
     * Only a production build that actually carried the APK records it, so a
     * page is never given a link to a file that is not there.
     */
    function androidApp() {
        var build = global.__SPOTIFIE_BUILD__;
        var app = build && build.androidApp;
        return app && app.url === ANDROID_APP_PATH ? app : null;
    }

    /**
     * Offered on the website - a browser tab or an installed web app - when
     * this build carries the Android app. Never inside a native shell: the
     * Android app has no reason to offer itself, and the desktop app is not
     * where a phone's app is fetched.
     */
    function canOfferAndroidApp() {
        return Boolean(androidApp()) && !androidShell() && !iosShell() && !desktopShell();
    }

    function androidElement(id) {
        var d = doc();
        return d && d.getElementById ? d.getElementById(id) : null;
    }

    /**
     * Keep the open panel on the screen. The header wraps differently at each
     * width, so the button can sit at either edge; the panel is moved sideways
     * just enough to stay 16px inside the viewport.
     */
    function keepPanelOnScreen(panel) {
        if (!panel.style || typeof panel.getBoundingClientRect !== 'function' || !global.innerWidth) return;
        panel.style.transform = '';
        var rect = panel.getBoundingClientRect();
        var gutter = 16;
        var shift = 0;
        if (rect.left < gutter) shift = gutter - rect.left;
        else if (rect.right > global.innerWidth - gutter) shift = global.innerWidth - gutter - rect.right;
        if (shift) panel.style.transform = 'translateX(' + Math.round(shift) + 'px)';
    }

    function setAndroidPanel(open) {
        var button = androidElement('androidDownloadBtn');
        var panel = androidElement('androidDownloadPanel');
        if (!button || !panel) return false;
        panel.hidden = !open;
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) keepPanelOnScreen(panel);
        return Boolean(open);
    }

    function renderAndroidApp() {
        var wrapper = androidElement('androidDownload');
        if (!wrapper) return false;

        var offer = canOfferAndroidApp();
        wrapper.hidden = !offer;

        // The address is given only when there is something at it. The file
        // is downloaded by the browser itself, never read into this page.
        var link = androidElement('androidDownloadLink');
        if (link) {
            if (offer) {
                link.setAttribute('href', ANDROID_APP_PATH);
                link.setAttribute('download', ANDROID_APP_FILENAME);
            } else if (typeof link.removeAttribute === 'function') {
                link.removeAttribute('href');
                link.removeAttribute('download');
            }
        }

        // Which version and how large, from the release itself - never a
        // second copy of either.
        var build = global.__SPOTIFIE_BUILD__;
        var app = androidApp();
        var version = androidElement('androidDownloadVersion');
        if (version) {
            var name = offer ? (app && app.version) || (build && build.version) : null;
            var size = offer && app && app.bytes ? ' · ' + (app.bytes / (1024 * 1024)).toFixed(1) + ' MB' : '';
            version.textContent = name ? 'Spotifie ' + name + size : '';
            version.hidden = !name;
        }

        // The checksum, for anyone who wants to check the file they got.
        var checksum = androidElement('androidDownloadChecksum');
        var sha = androidElement('androidDownloadSha');
        var digest = offer && app && /^[0-9a-f]{64}$/.test(String(app.sha256 || '')) ? app.sha256 : '';
        if (sha) sha.textContent = digest;
        if (checksum) checksum.hidden = !digest;

        if (!offer) setAndroidPanel(false);
        return offer;
    }

    function bindAndroidApp() {
        var d = doc();
        var wrapper = androidElement('androidDownload');
        var button = androidElement('androidDownloadBtn');
        var panel = androidElement('androidDownloadPanel');
        if (!d || !wrapper || !button || !panel) return;

        button.addEventListener('click', function (event) {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            setAndroidPanel(panel.hidden);
        });

        // Closed by a click anywhere else, by Escape, and once the download
        // has been chosen.
        if (typeof d.addEventListener === 'function') {
            d.addEventListener('click', function (event) {
                if (panel.hidden) return;
                var target = event && event.target;
                if (target && typeof wrapper.contains === 'function' && wrapper.contains(target)) return;
                setAndroidPanel(false);
            });
            d.addEventListener('keydown', function (event) {
                if (!event || event.key !== 'Escape' || panel.hidden) return;
                setAndroidPanel(false);
                if (typeof button.focus === 'function') button.focus();
            });
        }

        if (typeof global.addEventListener === 'function') {
            global.addEventListener('resize', function () {
                if (!panel.hidden) keepPanelOnScreen(panel);
            });
        }

        var link = androidElement('androidDownloadLink');
        if (link) {
            link.addEventListener('click', function () {
                setTimeout(function () {
                    setAndroidPanel(false);
                }, 0);
            });
        }
    }

    // ============================================
    // A newer version
    // ============================================

    /**
     * "Update available", once, with the choice left to the person.
     *
     * The service worker fetches pages and code from the network first, so
     * the next load is always current. What this adds is saying so for a page
     * that has been open a long time - without reloading it for them, which
     * would stop whatever they are listening to.
     */
    function showUpdateNotice() {
        var d = doc();
        if (state.updateShown || !d || !d.body || typeof d.createElement !== 'function') return false;
        state.updateShown = true;

        var notice = d.createElement('div');
        notice.className = 'update-notice';
        notice.id = 'updateNotice';
        notice.setAttribute('role', 'status');

        var text = d.createElement('span');
        text.textContent = 'Update available';

        var reload = d.createElement('button');
        reload.type = 'button';
        reload.className = 'update-notice-action';
        reload.textContent = 'Reload';
        reload.addEventListener('click', function () {
            // Chosen, not forced. Where a track stopped is saved as the page
            // goes, the same as any other reload.
            if (global.location && typeof global.location.reload === 'function') global.location.reload();
        });

        var later = d.createElement('button');
        later.type = 'button';
        later.className = 'update-notice-dismiss';
        later.textContent = 'Later';
        later.addEventListener('click', function () {
            if (notice.parentNode) notice.parentNode.removeChild(notice);
        });

        notice.appendChild(text);
        notice.appendChild(reload);
        notice.appendChild(later);
        d.body.appendChild(notice);
        return true;
    }

    /** A worker replacing the one this page started under means new code is live. */
    function watchServiceWorker() {
        var workers = global.navigator && global.navigator.serviceWorker;
        if (!workers || typeof workers.addEventListener !== 'function') return;

        // The first worker taking over a fresh visit is not an update.
        var hadController = Boolean(workers.controller);
        workers.addEventListener('controllerchange', function () {
            if (!hadController) {
                hadController = true;
                return;
            }
            showUpdateNotice();
        });
    }

    /**
     * Ask a published copy whether a newer build is being served.
     *
     * Only a build that knows which build it is can ask: the settings script a
     * published copy carries says so. A copy run from a checkout has nothing
     * to compare with and never asks.
     */
    function checkForUpdate(now) {
        var build = global.__SPOTIFIE_BUILD__;
        var at = now || Date.now();

        if (!build || !build.commit || build.commit === 'unknown') return Promise.resolve(false);
        if (typeof global.fetch !== 'function') return Promise.resolve(false);
        if (state.lastBuildCheck && at - state.lastBuildCheck < BUILD_CHECK_EVERY) return Promise.resolve(false);
        if (global.navigator && global.navigator.onLine === false) return Promise.resolve(false);

        state.lastBuildCheck = at;

        return global
            .fetch('/build-info.json', { cache: 'no-store', credentials: 'same-origin' })
            .then(function (response) {
                return response && response.ok ? response.json() : null;
            })
            .then(function (info) {
                if (!info || !info.commit || info.commit === build.commit) return false;

                // Let the worker fetch itself again too, so the shell it keeps
                // offline is the new one.
                var workers = global.navigator && global.navigator.serviceWorker;
                if (workers && typeof workers.getRegistration === 'function') {
                    workers
                        .getRegistration()
                        .then(function (registration) {
                            if (registration && typeof registration.update === 'function') return registration.update();
                            return null;
                        })
                        .catch(function () {
                            /* the notice still stands */
                        });
                }

                return showUpdateNotice();
            })
            .catch(function () {
                return false;
            });
    }

    // ============================================
    // Offline
    // ============================================

    /**
     * One small, lasting word in the header while there is no connection, with
     * what still works in its description. The one-off message the player
     * shows when the connection drops is separate; this is what is still there
     * when somebody looks up a minute later.
     */
    function renderConnection() {
        var d = doc();
        if (!d || !d.body || typeof d.createElement !== 'function') return;

        var online = !global.navigator || global.navigator.onLine !== false;
        var pill = d.getElementById('connectionStatus');

        if (online) {
            if (pill) pill.hidden = true;
            return;
        }

        if (!pill) {
            pill = d.createElement('span');
            pill.id = 'connectionStatus';
            pill.className = 'connection-status';
            pill.setAttribute('role', 'status');
            pill.title =
                'Music on this device keeps playing. Published songs, signing in and account changes need a connection.';

            var word = d.createElement('span');
            word.textContent = 'Offline';
            var detail = d.createElement('span');
            detail.className = 'connection-status-detail';
            detail.textContent = ' - music on this device still plays';
            pill.appendChild(word);
            pill.appendChild(detail);

            var buttons = d.querySelector ? d.querySelector('.header .btns') : null;
            if (buttons && buttons.firstChild) buttons.insertBefore(pill, buttons.firstChild);
            else if (buttons) buttons.appendChild(pill);
            else d.body.appendChild(pill);
        }

        pill.hidden = false;
    }

    // ============================================
    // Start
    // ============================================

    // Listened for at once: the browser may decide Spotifie is installable
    // before the page has finished starting.
    if (global.addEventListener) {
        global.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
        global.addEventListener('appinstalled', onInstalled);
    }

    function start() {
        var d = doc();
        applyDisplayMode();

        try {
            var query = global.matchMedia && global.matchMedia('(display-mode: standalone)');
            if (query && typeof query.addEventListener === 'function') {
                query.addEventListener('change', function () {
                    applyDisplayMode();
                    renderInstall();
                });
            }
        } catch (e) {
            /* an older browser simply never changes mode while open */
        }

        var button = installButton();
        if (button) {
            button.addEventListener('click', function () {
                install();
            });
        }
        renderInstall();

        bindAndroidApp();
        renderAndroidApp();

        watchServiceWorker();

        if (global.addEventListener) {
            global.addEventListener('online', renderConnection);
            global.addEventListener('offline', renderConnection);
        }
        renderConnection();

        if (d && typeof d.addEventListener === 'function') {
            d.addEventListener('visibilitychange', function () {
                if (d.visibilityState === 'visible') checkForUpdate(Date.now());
            });
        }
    }

    var d0 = doc();
    if (d0 && d0.readyState === 'loading' && typeof d0.addEventListener === 'function') {
        d0.addEventListener('DOMContentLoaded', start);
    } else if (d0) {
        start();
    }

    global.spotifiePwa = {
        displayMode: displayMode,
        applyDisplayMode: applyDisplayMode,
        canOfferInstall: canOfferInstall,
        install: install,
        renderInstall: renderInstall,
        androidApp: androidApp,
        canOfferAndroidApp: canOfferAndroidApp,
        renderAndroidApp: renderAndroidApp,
        ANDROID_APP_PATH: ANDROID_APP_PATH,
        showUpdateNotice: showUpdateNotice,
        checkForUpdate: checkForUpdate,
        renderConnection: renderConnection,
        DISMISS_KEY: DISMISS_KEY,
        DISMISS_DAYS: DISMISS_DAYS,
        BUILD_CHECK_EVERY: BUILD_CHECK_EVERY
    };
})(typeof window !== 'undefined' ? window : globalThis);
