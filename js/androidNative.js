/**
 * Spotifie inside its Android application.
 *
 * The Android app is this same web application in a Capacitor shell. There is
 * one frontend - the player, the catalogue, signing in, the library and Local
 * Music are the files every other copy runs - and this file is the one place
 * the rest of the application learns it is on Android, and what the shell can
 * do there.
 *
 * Recognised by Capacitor's own bridge (never a user-agent string), and each
 * capability is reported only when the native plugin behind it is present.
 *
 * The music on the phone is reached the way Android wants it reached: the
 * person chooses a folder in the system picker (Storage Access Framework), the
 * app keeps a persistable read grant for that folder and nothing else, and the
 * folder is walked for audio through that grant. No storage permission is
 * requested, nothing outside the chosen folders is readable, and no file is
 * ever copied, encoded, uploaded or deleted.
 *
 * The library itself is the one both native shells share (js/nativeLibrary.js),
 * with the same interface as the browser's folder library (js/browserLibrary.js),
 * so the Local Music card, Manage Local Music, playback, likes and playlists work
 * unchanged on top of it.
 */
(function (global) {
    'use strict';

    var shared = global.spotifieNativeLibrary || null;

    /** What counts as music: the same list every other adapter uses. */
    var AUDIO = shared ? shared.AUDIO : ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus'];

    var DB_NAME = 'spotifie-android-library';

    // ============================================
    // Is this the Android app, and what can it do?
    // ============================================

    function capacitor() {
        return global.Capacitor || null;
    }

    /** Running as the Android app? Asked of Capacitor's bridge. */
    function isAndroid() {
        var bridge = capacitor();
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

    /** A native plugin, when the shell carries it. */
    function plugin(name) {
        if (!isAndroid()) return null;
        var bridge = capacitor();
        return (bridge && bridge.Plugins && bridge.Plugins[name]) || null;
    }

    function AndroidNativeAdapter() {}

    AndroidNativeAdapter.prototype.name = 'android-native';

    AndroidNativeAdapter.prototype.available = function () {
        return isAndroid();
    };

    /**
     * What the app can do, one plain yes or no each. Safe to show or log.
     *
     * Background audio and system media controls need a native media service
     * the shell does not carry yet; they are reported as unavailable rather
     * than assumed from the fact that audio plays while the app is open.
     */
    AndroidNativeAdapter.prototype.capabilities = function () {
        var folders = Boolean(plugin('MusicFolders'));
        var media = Boolean(plugin('MediaSession'));
        var bridge = capacitor();

        return {
            canChooseDirectory: folders,
            canChooseFiles: false,
            canPersistFolderAccess: folders,
            canScanManagedFolders: folders,
            canReadLocalAudio: folders && Boolean(bridge && typeof bridge.convertFileSrc === 'function'),
            canUseNativeFilesystem: folders,
            canUseBackgroundAudio: media,
            canUseMediaControls: media,
            canRevealFile: false,
            canShareFile: false
        };
    };

    var adapter = new AndroidNativeAdapter();

    // ============================================
    // Local Music: the phone's folders
    // ============================================

    /**
     * The shared native library, on the phone's folders. A document is played
     * in place: Capacitor's local server answers for the content:// address on
     * the page's own origin.
     */
    var library = shared
        ? shared.create({
              dbName: DB_NAME,
              plugin: function () {
                  return plugin('MusicFolders');
              },
              fileUrl: function (uri) {
                  var bridge = capacitor();
                  return bridge && typeof bridge.convertFileSrc === 'function' ? bridge.convertFileSrc(uri) : null;
              },
              formats: function () {
                  return AUDIO;
              }
          })
        : null;

    // ============================================
    // The hardware Back button
    // ============================================

    /** Something is open on top of the page: a dialog, a menu, the drawer. */
    var OPEN_OVERLAYS = [
        '.modal:not(.hidden)',
        '#userMenu.open',
        '#userDropdown.active',
        // An album's options, opened by a long press.
        '.card-menu-dropdown:not(.hidden)'
    ];

    function overlayOpen(doc) {
        if (!doc) return false;
        if (doc.body && doc.body.classList && doc.body.classList.contains('sidebar-open')) return true;
        return OPEN_OVERLAYS.some(function (selector) {
            try {
                return Boolean(doc.querySelector(selector));
            } catch (e) {
                return false;
            }
        });
    }

    /**
     * Back, the way an Android person expects it:
     * an open dialog or menu closes, Now Playing closes, the app goes back a
     * view, and only at the root does the app step aside.
     *
     * Closing is done by the handlers that already close each of these on
     * Escape, so there is one way to close anything.
     */
    function handleBack(doc) {
        var d = doc || global.document;

        if (overlayOpen(d)) {
            d.dispatchEvent(new global.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return 'closed-overlay';
        }

        var history = global.history;
        if (history && history.state && history.state.spotifieView === 'nowPlaying') {
            history.back();
            return 'closed-now-playing';
        }

        var back = d.getElementById ? d.getElementById('navBack') : null;
        if (back && !back.disabled) {
            back.click();
            return 'navigated-back';
        }

        var app = plugin('App');
        if (app && typeof app.minimizeApp === 'function') app.minimizeApp();
        return 'minimized';
    }

    // ============================================
    // The protected admin dashboard, inside the app
    // ============================================

    /**
     * How the dashboard's in-app browser is set up.
     *
     * @capacitor/inappbrowser's own defaults, except that its cookies and
     * storage are kept between visits - so an administrator signs in there
     * once rather than every time. It shows the address it is on, runs in its
     * own process, and the hardware Back button walks its pages and then
     * closes it, returning to Spotifie.
     */
    var ADMIN_VIEW_OPTIONS = {
        showToolbar: true,
        showURL: true,
        clearCache: false,
        clearSessionCache: false,
        mediaPlaybackRequiresUserAction: false,
        closeButtonText: 'Done',
        toolbarPosition: 0,
        showNavigationButtons: false,
        leftToRight: false,
        customWebViewUserAgent: null,
        android: { allowZoom: false, hardwareBack: true, pauseMedia: true, isIsolated: true },
        iOS: {
            allowOverScroll: true,
            enableViewportScale: false,
            allowInLineMediaPlayback: false,
            surpressIncrementalRendering: false,
            viewStyle: 2,
            animationEffect: 2,
            allowsBackForwardNavigationGestures: true
        }
    };

    /**
     * Open the protected dashboard on the published site - inside Spotifie,
     * never the system browser.
     *
     * A separate in-app web view with no access to the app's native bridge,
     * so the page gets exactly the powers of a web page. The app carries no
     * dashboard: the site's worker verifies the administrator against Supabase
     * before it serves anything, as it does for everybody.
     */
    function openAdmin(url) {
        var browser = plugin('InAppBrowser');
        if (!browser || typeof browser.openInWebView !== 'function') {
            console.warn('Could not open the admin dashboard: this build has no in-app browser.');
            return false;
        }
        if (typeof url !== 'string' || url.indexOf('https://') !== 0) return false;

        return Promise.resolve(browser.openInWebView({ url: url, options: ADMIN_VIEW_OPTIONS }))
            .then(function () {
                return true;
            })
            .catch(function (error) {
                console.warn('Could not open the admin dashboard:', error && error.message);
                return false;
            });
    }

    // ============================================
    // Links from email that come back to the app
    // ============================================

    /**
     * The address a confirmation or password-reset email returns to.
     *
     * The app's own scheme (its application id), so Android hands the link to
     * Spotifie rather than to a browser. Which page it lands on is carried as
     * a parameter, from a short list - nothing else can be named.
     */
    var AUTH_CALLBACK = 'app.spotifie.android://auth/callback';
    var CALLBACK_PAGES = ['/', '/signin.html', '/reset-password.html'];

    function authCallbackUrl(path) {
        var next = CALLBACK_PAGES.indexOf(path) !== -1 ? path : '/';
        return AUTH_CALLBACK + '?next=' + encodeURIComponent(next);
    }

    /**
     * Take a link Android handed to the app and open the page it was for.
     *
     * Supabase puts the session (or the reason it could not make one) after
     * the #; the page it lands on reads it from there with the same code the
     * website uses. Nothing is read or kept here.
     */
    function handleAuthCallback(url) {
        if (typeof url !== 'string' || url.indexOf(AUTH_CALLBACK) !== 0) return false;

        var parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            return false;
        }

        var next = parsed.searchParams.get('next');
        if (CALLBACK_PAGES.indexOf(next) === -1) next = '/';
        parsed.searchParams.delete('next');

        var query = parsed.searchParams.toString();
        global.location.replace(next + (query ? '?' + query : '') + (parsed.hash || ''));
        return true;
    }

    // ============================================
    // Start
    // ============================================

    if (isAndroid()) {
        // The phone's folders take the place of the browser's folder picker,
        // behind the same interface.
        if (library && plugin('MusicFolders')) global.spotifieBrowserLibrary = library;

        var app = plugin('App');
        if (app && typeof app.addListener === 'function') {
            app.addListener('backButton', function () {
                handleBack();
            });
            app.addListener('appUrlOpen', function (event) {
                handleAuthCallback(event && event.url);
            });
        }
    }

    global.spotifieAndroid = {
        isAndroid: isAndroid,
        adapter: adapter,
        AndroidNativeAdapter: AndroidNativeAdapter,
        library: library,
        handleBack: handleBack,
        overlayOpen: overlayOpen,
        authCallbackUrl: authCallbackUrl,
        handleAuthCallback: handleAuthCallback,
        openAdmin: openAdmin,
        ADMIN_VIEW_OPTIONS: ADMIN_VIEW_OPTIONS,
        AUTH_CALLBACK: AUTH_CALLBACK,
        AUDIO: AUDIO
    };
})(typeof window !== 'undefined' ? window : globalThis);
