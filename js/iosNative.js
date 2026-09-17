/**
 * Spotifie inside its iOS application.
 *
 * The iOS app is this same web application in a Capacitor shell, exactly as the
 * Android app is. There is one frontend - the player, the catalogue, signing
 * in, the library and Local Music are the files every other copy runs - and
 * this file is the one place the rest of the application learns it is on iOS,
 * and what the shell can do there.
 *
 * Recognised by Capacitor's own bridge (never a user-agent string), and each
 * capability is reported only when the native code behind it is present.
 *
 * The music on the phone is reached the way iOS allows it: the person chooses a
 * folder - or, where a Files provider will not list a folder, some songs - in
 * the system document picker. The shell keeps a security-scoped bookmark for
 * exactly what was chosen and nothing else, in the app's own container; it is
 * never sent anywhere. No permission prompt is involved, nothing outside what
 * was chosen is readable, and no file is ever copied, encoded, uploaded or
 * deleted.
 *
 * The library is the one both native shells share (js/nativeLibrary.js).
 *
 * What cannot be checked from here: all of the native side runs only on a Mac,
 * in Xcode, and on an iPhone. See SPOTIFIE_OPERATIONS.private.md.
 */
(function (global) {
    'use strict';

    var shared = global.spotifieNativeLibrary || null;

    var DB_NAME = 'spotifie-ios-library';

    /**
     * Formats WebKit on iOS plays everywhere Spotifie runs (iOS 15 and later).
     * The rest of Spotifie's list is asked of the player itself before a file
     * of that kind is offered - see formats().
     */
    var ALWAYS_PLAYABLE = ['mp3', 'm4a', 'aac', 'wav'];

    /** For each other format, the types the player is asked about. */
    var PROBED = {
        flac: ['audio/flac', 'audio/x-flac'],
        ogg: ['audio/ogg; codecs="vorbis"', 'audio/ogg; codecs="opus"'],
        opus: ['audio/ogg; codecs="opus"', 'audio/webm; codecs="opus"']
    };

    // ============================================
    // Is this the iOS app, and what can it do?
    // ============================================

    function capacitor() {
        return global.Capacitor || null;
    }

    /** Running as the iOS app? Asked of Capacitor's bridge. */
    function isIOS() {
        var bridge = capacitor();
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

    /** A native plugin, when the shell carries it. */
    function plugin(name) {
        if (!isIOS()) return null;
        var bridge = capacitor();
        return (bridge && bridge.Plugins && bridge.Plugins[name]) || null;
    }

    /**
     * The file types this app offers as Local Music: the ones WebKit always
     * plays, plus each other one the player says it can play. A format the
     * player cannot play is not offered, rather than listed and then failing.
     */
    function formats() {
        var found = ALWAYS_PLAYABLE.slice();
        var probe = null;
        try {
            probe = global.document && typeof global.document.createElement === 'function' ? global.document.createElement('audio') : null;
        } catch (e) {
            probe = null;
        }
        if (!probe || typeof probe.canPlayType !== 'function') return found;

        Object.keys(PROBED).forEach(function (format) {
            var playable = PROBED[format].some(function (type) {
                try {
                    return probe.canPlayType(type) !== '';
                } catch (e) {
                    return false;
                }
            });
            if (playable) found.push(format);
        });
        return found;
    }

    function IOSNativeAdapter() {}

    IOSNativeAdapter.prototype.name = 'ios-native';

    IOSNativeAdapter.prototype.available = function () {
        return isIOS();
    };

    /**
     * What the app can do, one plain yes or no each. Safe to show or log.
     *
     * Background audio is configured natively (the audio background mode and
     * a playback audio session), but it is not counted until it has been seen
     * working on an iPhone: ordinary playback that happens to continue for a
     * while is not a guarantee.
     */
    IOSNativeAdapter.prototype.capabilities = function () {
        var folders = plugin('MusicFolders');
        var bridge = capacitor();

        return {
            canChooseDirectory: Boolean(folders),
            canChooseFiles: Boolean(folders && typeof folders.pickFiles === 'function'),
            canPersistFolderAccess: Boolean(folders),
            canScanManagedFolders: Boolean(folders),
            canReadLocalAudio: Boolean(folders) && Boolean(bridge && typeof bridge.convertFileSrc === 'function'),
            canUseNativeFilesystem: Boolean(folders),
            canUseBackgroundAudio: false,
            canUseMediaControls: false,
            canRevealFile: false,
            canShareFile: false
        };
    };

    var adapter = new IOSNativeAdapter();

    // ============================================
    // Local Music: what the person chose in Files
    // ============================================

    /**
     * The shared native library, on what the person chose. A file is played
     * in place: Capacitor's local server answers for it on the page's own
     * origin while the shell holds its security-scoped access open.
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
              formats: formats
          })
        : null;

    // ============================================
    // The protected admin dashboard, inside the app
    // ============================================

    /**
     * The dashboard's in-app browser: a separate web view with no bridge to
     * the app, keeping its own cookies between visits so an administrator signs
     * in there once. Closed with its Done button; iOS has no Back button.
     */
    var ADMIN_VIEW_OPTIONS = {
        showToolbar: true,
        showURL: true,
        clearCache: false,
        clearSessionCache: false,
        mediaPlaybackRequiresUserAction: false,
        closeButtonText: 'Done',
        toolbarPosition: 0,
        showNavigationButtons: true,
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
     * Open the protected dashboard on the published site, inside Spotifie. The
     * app carries no dashboard: the site's worker verifies the administrator
     * against Supabase before it serves anything, as it does for everybody.
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
     * The address a confirmation or password-reset email returns to: the iOS
     * app's own URL scheme, which is its bundle identifier (app.spotifie.ios),
     * registered in Info.plist. Which page it lands on is carried as a
     * parameter, from a short list - nothing else can be named.
     */
    var AUTH_CALLBACK = 'app.spotifie.ios://auth/callback';
    var CALLBACK_PAGES = ['/', '/signin.html', '/reset-password.html'];

    // Whether this web view session has already followed the link the app was
    // launched with. A yes or no only - the link itself carries a session and
    // is never written down.
    var LAUNCH_HANDLED_KEY = 'spotifie_ios_launch_link_handled';

    function authCallbackUrl(path) {
        var next = CALLBACK_PAGES.indexOf(path) !== -1 ? path : '/';
        return AUTH_CALLBACK + '?next=' + encodeURIComponent(next);
    }

    /**
     * Take a link iOS handed to the app and open the page it was for.
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

    function launchLinkHandled() {
        try {
            return global.sessionStorage && global.sessionStorage.getItem(LAUNCH_HANDLED_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function markLaunchLinkHandled() {
        try {
            if (global.sessionStorage) global.sessionStorage.setItem(LAUNCH_HANDLED_KEY, '1');
        } catch (e) {
            /* a web view that keeps nothing follows the link once per page */
        }
    }

    /**
     * The link the app was opened with, when an email link started it from
     * cold. Followed once per session: the app keeps reporting its launch link
     * for as long as it runs, and following it again on every return to the
     * home page would send the person back to it each time.
     */
    function followLaunchLink(app) {
        if (!app || typeof app.getLaunchUrl !== 'function' || launchLinkHandled()) return Promise.resolve(false);

        return Promise.resolve(app.getLaunchUrl())
            .then(function (launch) {
                var url = launch && launch.url;
                if (typeof url !== 'string' || url.indexOf(AUTH_CALLBACK) !== 0) return false;
                markLaunchLinkHandled();
                return handleAuthCallback(url);
            })
            .catch(function () {
                return false;
            });
    }

    // ============================================
    // Start
    // ============================================

    if (isIOS()) {
        // What the person chose in Files takes the place of the browser's
        // folder picker, behind the same interface.
        if (library && plugin('MusicFolders')) global.spotifieBrowserLibrary = library;

        var app = plugin('App');
        if (app && typeof app.addListener === 'function') {
            app.addListener('appUrlOpen', function (event) {
                if (handleAuthCallback(event && event.url)) markLaunchLinkHandled();
            });
        }
        followLaunchLink(app);
    }

    global.spotifieIOS = {
        isIOS: isIOS,
        adapter: adapter,
        IOSNativeAdapter: IOSNativeAdapter,
        library: library,
        formats: formats,
        authCallbackUrl: authCallbackUrl,
        handleAuthCallback: handleAuthCallback,
        followLaunchLink: followLaunchLink,
        openAdmin: openAdmin,
        ADMIN_VIEW_OPTIONS: ADMIN_VIEW_OPTIONS,
        AUTH_CALLBACK: AUTH_CALLBACK,
        ALWAYS_PLAYABLE: ALWAYS_PLAYABLE
    };
})(typeof window !== 'undefined' ? window : globalThis);
