'use strict';

/**
 * The iOS app, as far as it can be checked without a Mac.
 *
 * The adapter is run against a fake Capacitor bridge and a fake MusicFolders
 * plugin shaped like the Swift one, so what is checked is behaviour: the app
 * recognised by its bridge, a folder or some songs chosen, walked, rescanned
 * without re-reading unchanged songs, forgotten without touching a file; only
 * formats the player can play offered; email links followed back into the app.
 *
 * The native project is read where it is written: what it asks of iOS, what it
 * declares, and what its web assets carry. Whether it compiles, signs and runs
 * is not something a test on Windows can say - that is P15_IOS_QA.private.md.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const NATIVE_LIBRARY_JS = source('js', 'nativeLibrary.js');
const ANDROID_JS = source('js', 'androidNative.js');
const IOS_JS = source('js', 'iosNative.js');
const PLATFORM_JS = source('js', 'platform.js');
const DESKTOP_JS = source('js', 'desktopNative.js');
const PWA_JS = source('js', 'pwa.js');

const iosBuild = require('../tools/iosBuild.js');
const checker = require('../tools/releaseCheck.js');

const IOS_PROJECT = path.join(ROOT, 'ios', 'App');

// ============================================
// A small IndexedDB, and a small Files app
// ============================================

function fakeIndexedDB() {
    const stores = new Map();

    function storeFor(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    }

    function request(result) {
        const req = { result: result, onsuccess: null, onerror: null, transaction: { oncomplete: null } };
        setTimeout(() => {
            if (req.onsuccess) req.onsuccess();
            if (req.transaction.oncomplete) req.transaction.oncomplete();
        }, 0);
        return req;
    }

    function transaction() {
        const tx = { oncomplete: null, onerror: null };
        tx.objectStore = (name) => {
            const map = storeFor(name);
            return {
                getAll: () => request(Array.from(map.values())),
                put: (value) => map.set(value.id, JSON.parse(JSON.stringify(value))),
                delete: (key) => map.delete(key),
                index: () => ({
                    getAllKeys: (folderId) =>
                        request(
                            Array.from(map.values())
                                .filter((row) => row.folderId === folderId)
                                .map((row) => row.id)
                        )
                })
            };
        };
        setTimeout(() => setTimeout(() => tx.oncomplete && tx.oncomplete(), 0), 0);
        return tx;
    }

    const db = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore: (name) => {
            storeFor(name);
            return { createIndex() {} };
        },
        transaction: transaction,
        close() {}
    };

    return {
        stores: stores,
        open(name) {
            const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, name: name };
            setTimeout(() => {
                if (req.onupgradeneeded) req.onupgradeneeded();
                if (req.onsuccess) req.onsuccess();
            }, 0);
            return req;
        }
    };
}

const ICLOUD = 'file:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/Music/';

/** The Swift MusicFolders plugin, as the page sees it. */
function fakeMusicFolders(files) {
    const calls = { readTags: [], released: [], scans: 0, picks: [] };
    const granted = new Set();
    const folder = 'ios-folder:5B1D';
    const chosen = 'ios-files:77AC';

    const plugin = {
        calls: calls,
        files: files,
        folder: folder,
        chosen: chosen,
        cancelNext: false,
        pickFolder() {
            calls.picks.push('folder');
            if (plugin.cancelNext) return Promise.reject(new Error('CANCELLED'));
            granted.add(folder);
            return Promise.resolve({ uri: folder, name: 'Music' });
        },
        pickFiles() {
            calls.picks.push('files');
            granted.add(chosen);
            return Promise.resolve({ uri: chosen, name: '2 chosen songs' });
        },
        listFolders() {
            return Promise.resolve({ folders: Array.from(granted).map((uri) => ({ uri: uri, name: 'Music' })) });
        },
        scanFolder({ uri }) {
            calls.scans += 1;
            if (!granted.has(uri)) return Promise.reject(new Error('NOT_GRANTED'));
            return Promise.resolve({
                files: plugin.files.map((file) => ({
                    uri: ICLOUD + encodeURI(file.path),
                    path: file.path,
                    name: file.path.split('/').pop(),
                    size: file.size,
                    lastModified: file.lastModified
                }))
            });
        },
        readTags({ uri }) {
            calls.readTags.push(uri);
            return Promise.resolve({ title: 'Tagged ' + calls.readTags.length, artist: 'Someone', duration: 200 });
        },
        releaseFolder({ uri }) {
            calls.released.push(uri);
            granted.delete(uri);
            return Promise.resolve();
        }
    };
    return plugin;
}

function fakeStore() {
    const held = new Map();
    return {
        held: held,
        getItem: (key) => (held.has(key) ? held.get(key) : null),
        setItem: (key, value) => held.set(key, String(value)),
        removeItem: (key) => held.delete(key)
    };
}

/**
 * The shared library and both phone adapters, in a page. `platform` is 'ios',
 * 'android' or null (a browser); `playable` lists the MIME types the fake
 * player says it can play.
 */
function loadShell(options) {
    const settings = options || {};
    const listeners = {};
    const opened = [];
    const playable = settings.playable || [];

    const sandbox = {
        console: { warn() {}, log() {} },
        setTimeout,
        clearTimeout,
        Promise,
        Map,
        Set,
        Array,
        Object,
        String,
        Boolean,
        Error,
        JSON,
        URL,
        Uint8Array,
        TextEncoder,
        Date,
        Math,
        crypto: require('crypto').webcrypto,
        indexedDB: fakeIndexedDB(),
        sessionStorage: settings.sessionStorage || fakeStore(),
        document: {
            createElement: () => ({
                canPlayType: (type) => (playable.some((kind) => type.indexOf(kind) === 0) ? 'maybe' : '')
            })
        },
        location: {
            replaced: [],
            replace(url) {
                this.replaced.push(url);
            }
        }
    };

    if (settings.platform) {
        const plugins = {};
        if (settings.folders) plugins.MusicFolders = settings.folders;
        plugins.App = {
            addListener(event, fn) {
                listeners[event] = fn;
            },
            getLaunchUrl: () => Promise.resolve(settings.launchUrl ? { url: settings.launchUrl } : undefined),
            minimizeApp() {}
        };
        if (settings.inAppBrowser !== false) {
            plugins.InAppBrowser = {
                openInWebView: (model) => {
                    opened.push(model);
                    return Promise.resolve();
                }
            };
        }
        sandbox.Capacitor = {
            isNativePlatform: () => true,
            getPlatform: () => settings.platform,
            Plugins: plugins,
            convertFileSrc: (uri) => uri.replace('file://', 'capacitor://localhost/_capacitor_file_')
        };
    }

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(NATIVE_LIBRARY_JS, sandbox);
    vm.runInContext(ANDROID_JS, sandbox);
    vm.runInContext(IOS_JS, sandbox);
    return { sandbox: sandbox, ios: sandbox.spotifieIOS, listeners: listeners, opened: opened };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ============================================
// Recognising the app
// ============================================

test('the iOS app is recognised by its bridge, and never mistaken for Android or a browser', () => {
    const browser = loadShell({});
    assert.strictEqual(browser.ios.isIOS(), false);
    assert.strictEqual(browser.sandbox.spotifieBrowserLibrary, undefined, 'nothing replaced in a browser');

    const android = loadShell({ platform: 'android' });
    assert.strictEqual(android.ios.isIOS(), false);
    assert.strictEqual(android.sandbox.spotifieAndroid.isAndroid(), true);

    const app = loadShell({ platform: 'ios', folders: fakeMusicFolders([]) });
    assert.strictEqual(app.ios.isIOS(), true);
    assert.strictEqual(app.sandbox.spotifieAndroid.isAndroid(), false, 'the Android adapter stands aside');
    assert.strictEqual(app.sandbox.spotifieBrowserLibrary, app.ios.library, 'Files stands behind the same interface');

    // Asked of the bridge, never of a browser name.
    assert.ok(!/userAgent|navigator\.platform/.test(IOS_JS), 'no user-agent sniffing');
});

test('the iOS app reports what it can do, and does not claim what has not been seen working', () => {
    const app = loadShell({ platform: 'ios', folders: fakeMusicFolders([]) });
    const capabilities = app.ios.adapter.capabilities();
    assert.strictEqual(capabilities.canChooseDirectory, true);
    assert.strictEqual(capabilities.canChooseFiles, true);
    assert.strictEqual(capabilities.canPersistFolderAccess, true);
    assert.strictEqual(capabilities.canReadLocalAudio, true);
    assert.strictEqual(capabilities.canUseBackgroundAudio, false, 'not until verified on an iPhone');
    assert.strictEqual(capabilities.canUseMediaControls, false, 'not until verified on an iPhone');

    const bare = loadShell({ platform: 'ios' });
    assert.ok(Object.values(bare.ios.adapter.capabilities()).every((value) => value === false), 'no plugin, no claims');
});

// ============================================
// Formats
// ============================================

test('only formats the player can play are offered as Local Music', async () => {
    const files = [
        { path: 'a.mp3', size: 1, lastModified: 1 },
        { path: 'b.m4a', size: 2, lastModified: 1 },
        { path: 'c.flac', size: 3, lastModified: 1 },
        { path: 'd.ogg', size: 4, lastModified: 1 },
        { path: 'e.opus', size: 5, lastModified: 1 },
        { path: 'f.wav', size: 6, lastModified: 1 },
        { path: 'g.aac', size: 7, lastModified: 1 },
        { path: 'notes.txt', size: 8, lastModified: 1 }
    ];

    const plain = loadShell({ platform: 'ios', folders: fakeMusicFolders(files) });
    assert.deepStrictEqual(Array.from(plain.ios.formats()), ['mp3', 'm4a', 'aac', 'wav']);
    const summary = await plain.ios.library.chooseFolder();
    assert.strictEqual(summary.trackCount, 4, 'FLAC, Ogg and Opus are not offered when the player says no');

    const capable = loadShell({ platform: 'ios', folders: fakeMusicFolders(files), playable: ['audio/flac', 'audio/ogg'] });
    assert.deepStrictEqual(Array.from(capable.ios.formats()), ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus']);
    assert.strictEqual((await capable.ios.library.chooseFolder()).trackCount, 7, 'offered when it says it can');

    // The web and Android lists are untouched.
    assert.deepStrictEqual(Array.from(capable.sandbox.spotifieAndroid.AUDIO), ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus']);
});

// ============================================
// Local Music
// ============================================

test('a folder chosen in Files becomes Local Music, and a rescan reads only what changed', async () => {
    const folders = fakeMusicFolders([
        { path: 'Album/01 - One.mp3', size: 100, lastModified: 1 },
        { path: 'Album/02 - Two.m4a', size: 200, lastModified: 1 }
    ]);
    const app = loadShell({ platform: 'ios', folders: folders });
    const library = app.ios.library;

    const first = await library.chooseFolder();
    assert.strictEqual(first.trackCount, 2);
    assert.strictEqual(folders.calls.readTags.length, 2);
    const ids = library.catalogue().tracks.map((track) => track.id);

    const again = await library.refresh();
    assert.strictEqual(again.scanned, 1);
    assert.strictEqual(folders.calls.readTags.length, 2, 'unchanged songs are not read again');
    assert.deepStrictEqual(
        library.catalogue().tracks.map((track) => track.id),
        ids,
        'ids do not move'
    );

    folders.files[1].lastModified = 2;
    await library.refresh();
    assert.strictEqual(folders.calls.readTags.length, 3, 'a changed song is read again');

    // Played in place, through the app's own origin.
    const url = await library.trackUrl(ids[0]);
    assert.ok(url.indexOf('capacitor://localhost/_capacitor_file_/private/var/mobile/') === 0, url);
});

test('songs chosen one by one are the fallback where a folder cannot be listed', async () => {
    const folders = fakeMusicFolders([
        { path: 'One.mp3', size: 1, lastModified: 1 },
        { path: 'Two.mp3', size: 2, lastModified: 1 }
    ]);
    const app = loadShell({ platform: 'ios', folders: folders });

    assert.strictEqual(app.ios.library.canChooseFiles(), true);
    const summary = await app.ios.library.chooseFiles();
    assert.strictEqual(summary.trackCount, 2);
    assert.deepStrictEqual(folders.calls.picks, ['files']);
    assert.strictEqual(app.ios.library.folders()[0].id, folders.chosen);

    // The Android plugin has no file picker, and its library says so.
    const javaShaped = fakeMusicFolders([]);
    delete javaShaped.pickFiles;
    const android = loadShell({ platform: 'android', folders: javaShaped });
    assert.strictEqual(android.sandbox.spotifieAndroid.library.canChooseFiles(), false);
    assert.strictEqual(android.sandbox.spotifieAndroid.adapter.capabilities().canChooseFiles, false);
});

test('forgetting a source gives the grant back and touches no file; a cancel is not an error', async () => {
    const folders = fakeMusicFolders([{ path: 'One.mp3', size: 1, lastModified: 1 }]);
    const app = loadShell({ platform: 'ios', folders: folders });
    await app.ios.library.chooseFolder();

    await app.ios.library.forget(folders.folder);
    assert.deepStrictEqual(folders.calls.released, [folders.folder]);
    assert.strictEqual(app.ios.library.trackCount(), 0);
    assert.ok(!('deleteFile' in folders) && !('removeFile' in folders), 'there is nothing that deletes');

    folders.cancelNext = true;
    await assert.rejects(app.ios.library.chooseFolder(), (error) => error.name === 'AbortError');
});

// ============================================
// Email links
// ============================================

test('email links use the iOS app\'s own scheme and open only the pages they may', () => {
    const app = loadShell({ platform: 'ios' });
    assert.strictEqual(app.ios.AUTH_CALLBACK, 'app.spotifie.ios://auth/callback');
    assert.strictEqual(app.ios.authCallbackUrl('/signin.html'), 'app.spotifie.ios://auth/callback?next=%2Fsignin.html');
    assert.strictEqual(app.ios.authCallbackUrl('/admin-dashboard'), 'app.spotifie.ios://auth/callback?next=%2F');
    assert.notStrictEqual(app.ios.AUTH_CALLBACK, app.sandbox.spotifieAndroid.AUTH_CALLBACK, 'not the Android scheme');

    assert.strictEqual(
        app.ios.handleAuthCallback('app.spotifie.ios://auth/callback?next=%2Freset-password.html#access_token=x&type=recovery'),
        true
    );
    assert.deepStrictEqual(app.sandbox.location.replaced, ['/reset-password.html#access_token=x&type=recovery']);

    assert.strictEqual(app.ios.handleAuthCallback('app.spotifie.android://auth/callback?next=%2F'), false);
    assert.strictEqual(app.ios.handleAuthCallback('https://evil.example/?next=%2F'), false);
    app.ios.handleAuthCallback('app.spotifie.ios://auth/callback?next=https%3A%2F%2Fevil.example');
    assert.strictEqual(app.sandbox.location.replaced[1], '/', 'nowhere but the short list');

    // The session module names the same address.
    assert.match(source('js', 'auth.js'), /ios: 'app\.spotifie\.ios:\/\/auth\/callback'/);
});

test('a link that opens the app is followed; the launch link only once, and never written down', async () => {
    const store = fakeStore();
    const launch = 'app.spotifie.ios://auth/callback?next=%2Fsignin.html#access_token=secret';

    const cold = loadShell({ platform: 'ios', launchUrl: launch, sessionStorage: store });
    await settle();
    assert.deepStrictEqual(cold.sandbox.location.replaced, ['/signin.html#access_token=secret']);
    assert.deepStrictEqual(Array.from(store.held.values()), ['1'], 'a yes, not the link');

    // Back on the home page later in the same session: not followed again.
    const later = loadShell({ platform: 'ios', launchUrl: launch, sessionStorage: store });
    await settle();
    assert.deepStrictEqual(later.sandbox.location.replaced, []);

    // A link arriving while the app runs.
    later.listeners.appUrlOpen({ url: 'app.spotifie.ios://auth/callback?next=%2F#type=signup' });
    assert.deepStrictEqual(later.sandbox.location.replaced, ['/#type=signup']);
});

// ============================================
// The admin dashboard
// ============================================

test('the admin dashboard opens in the in-app browser on the protected site, HTTPS only', async () => {
    const app = loadShell({ platform: 'ios' });
    assert.strictEqual(await app.ios.openAdmin('https://spotifie.adilurrehmanofficial.workers.dev/?admin=enter'), true);
    assert.strictEqual(app.opened.length, 1);
    assert.strictEqual(app.opened[0].options.clearSessionCache, false);
    assert.strictEqual(app.ios.openAdmin('http://insecure.example/'), false);

    const none = loadShell({ platform: 'ios', inAppBrowser: false });
    assert.strictEqual(none.ios.openAdmin('https://spotifie.adilurrehmanofficial.workers.dev/'), false);
    assert.ok(!/openInSystemBrowser|openInExternalBrowser|window\.open/.test(IOS_JS), 'never Safari');
});

// ============================================
// One frontend
// ============================================

test('the iOS app runs the same frontend, with its adapter in the same place as the others', () => {
    const index = source('index.html');
    const at = (name) => index.indexOf('<script src="' + name + '"></script>');
    assert.ok(at('js/nativeLibrary.js') !== -1 && at('js/nativeLibrary.js') < at('js/androidNative.js'));
    assert.ok(at('js/iosNative.js') > at('js/androidNative.js') && at('js/iosNative.js') < at('js/script.js'));

    const builder = require('../tools/buildPublic.js');
    ['js/nativeLibrary.js', 'js/iosNative.js'].forEach((file) => {
        assert.ok(builder.BROWSER_SCRIPTS.indexOf(file) !== -1, file + ' is published');
        assert.ok(source('sw.js').indexOf("'/" + file + "'") !== -1, file + ' is kept for an offline start');
    });

    // No second interface: nothing iOS-specific in the player or its pages.
    assert.ok(!/spotifieIOS/.test(source('js', 'script.js').replace(/if \(window\.spotifieIOS && window\.spotifieIOS\.isIOS\(\)\) return;/, '')));
    ['index.html', 'signin.html', 'signup.html', 'forgot-password.html', 'reset-password.html'].forEach((page) => {
        assert.match(source(page), /viewport-fit=cover/, page + ' draws edge to edge, with the safe areas kept clear');
    });
});

function loadPlatform(globals) {
    const sandbox = Object.assign(
        {
            Array,
            Boolean,
            Object,
            Promise,
            Math,
            Date,
            Set,
            Error,
            String,
            setTimeout,
            clearTimeout,
            console: { warn() {} },
            navigator: { onLine: true, mediaSession: {} },
            document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
            fetch: () => Promise.reject(new Error('no network in a test')),
            addEventListener() {}
        },
        globals || {}
    );
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(DESKTOP_JS, sandbox);
    vm.runInContext(PLATFORM_JS, sandbox);
    return sandbox.spotifiePlatform;
}

test('the platform reports the iOS adapter from its capabilities, not from a name', () => {
    const features = loadPlatform({
        spotifieIOS: {
            isIOS: () => true,
            adapter: {
                capabilities: () => ({
                    canChooseDirectory: true,
                    canChooseFiles: true,
                    canPersistFolderAccess: true,
                    canScanManagedFolders: true,
                    canReadLocalAudio: true,
                    canUseNativeFilesystem: true,
                    canUseBackgroundAudio: false,
                    canUseMediaControls: false
                })
            }
        },
        spotifieBrowserLibrary: { supported: () => true }
    }).localMusicFeatures();

    assert.strictEqual(features.adapter, 'ios-native');
    assert.strictEqual(features.canChooseFiles, true);
    assert.strictEqual(features.canPersistFolderAccess, true);
    assert.strictEqual(features.canUseBackgroundAudio, false);
    assert.strictEqual(features.canUseMediaControls, false, 'the web Media Session is not counted in the app yet');

    const web = loadPlatform({ spotifieBrowserLibrary: { supported: () => true } }).localMusicFeatures();
    assert.strictEqual(web.canChooseFiles, false);
    assert.strictEqual(web.canUseMediaControls, true, 'a browser keeps its Media Session');
});

test('inside the iOS app there is no install offer, no Android download and no offline worker', () => {
    const sandbox = {
        console: { warn() {}, log() {}, info() {} },
        setTimeout,
        clearTimeout,
        Promise,
        Date,
        JSON,
        document: null,
        localStorage: fakeStore(),
        navigator: { onLine: true },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        addEventListener() {},
        __SPOTIFIE_BUILD__: { commit: 'abc1234', version: '1.0.0-rc.1', androidApp: { url: '/downloads/spotifie-android.apk' } },
        Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(PWA_JS, sandbox);

    assert.strictEqual(sandbox.spotifiePwa.displayMode(), 'ios');
    assert.strictEqual(sandbox.spotifiePwa.canOfferAndroidApp(), false);
    assert.strictEqual(sandbox.spotifiePwa.canOfferInstall(), false);
    assert.match(source('js', 'script.js'), /if \(window\.spotifieIOS && window\.spotifieIOS\.isIOS\(\)\) return;/);
});

// ============================================
// The native project
// ============================================

test('the iOS project asks for nothing Spotifie does not use, and declares what it does', () => {
    assert.deepStrictEqual(iosBuild.inspectNativeProject(IOS_PROJECT), []);

    const plist = source('ios', 'App', 'App', 'Info.plist');
    iosBuild.FORBIDDEN_PLIST_KEYS.forEach((key) => assert.ok(plist.indexOf(key) === -1, key));
    assert.match(plist, /<string>app\.spotifie\.ios<\/string>/, 'the email-link scheme is the bundle id');
    assert.match(plist, /<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>\s*<\/array>/);
    assert.match(plist, /<string>\$\(MARKETING_VERSION\)<\/string>/, 'the version comes from the build settings');

    const pbx = source('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    // Taken from package.json rather than written here: iOS allows only x.y.z,
    // so a release candidate keeps the release's own three numbers. A literal
    // pinned here goes stale the next time the version moves.
    const marketing = iosBuild.marketingVersion(require('../package.json').version);
    assert.ok(
        pbx.indexOf('MARKETING_VERSION = ' + marketing + ';') !== -1,
        'the Xcode project carries the version package.json names (' + marketing + ')'
    );
    assert.ok(!/DEVELOPMENT_TEAM/.test(pbx), 'no Team ID is invented');

    // The Android app keeps its own identity.
    assert.strictEqual(JSON.parse(source('capacitor.config.json')).appId, 'app.spotifie.android');

    const delegate = source('ios', 'App', 'App', 'AppDelegate.swift');
    assert.match(delegate, /setCategory\(\.playback, mode: \.default\)/, 'a music player\'s audio session');
    assert.match(source('ios', 'App', 'App', 'SceneDelegate.swift'), /SpotifieBridgeViewController\(\)/);
});

test('a project that asks for a camera, names a team or tracks is refused', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-ios-project-'));
    try {
        fs.mkdirSync(path.join(temp, 'App'), { recursive: true });
        fs.mkdirSync(path.join(temp, 'App.xcodeproj'), { recursive: true });
        fs.writeFileSync(
            path.join(temp, 'App', 'Info.plist'),
            source('ios', 'App', 'App', 'Info.plist').replace('<dict>', '<dict>\n\t<key>NSCameraUsageDescription</key>\n\t<string>x</string>')
        );
        fs.writeFileSync(
            path.join(temp, 'App', 'PrivacyInfo.xcprivacy'),
            source('ios', 'App', 'App', 'PrivacyInfo.xcprivacy').replace(/<key>NSPrivacyTracking<\/key>\s*<false\/>/, '<key>NSPrivacyTracking</key>\n\t<true/>')
        );
        fs.writeFileSync(
            path.join(temp, 'App.xcodeproj', 'project.pbxproj'),
            source('ios', 'App', 'App.xcodeproj', 'project.pbxproj').replace('CODE_SIGN_STYLE = Automatic;', 'CODE_SIGN_STYLE = Automatic;\n\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;')
        );
        fs.writeFileSync(path.join(temp, 'App', 'dist.p12'), 'x');

        const problems = iosBuild.inspectNativeProject(temp).join('\n');
        assert.match(problems, /NSCameraUsageDescription/);
        assert.match(problems, /does not say Spotifie does not track/);
        assert.match(problems, /names a Team ID/);
        assert.match(problems, /signing material/);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('the version and bundle id follow package.json and the chosen identity', () => {
    assert.strictEqual(iosBuild.marketingVersion('1.0.0-rc.1'), '1.0.0');
    assert.strictEqual(iosBuild.marketingVersion('2.3.4'), '2.3.4');
    assert.throws(() => iosBuild.marketingVersion('rc'));

    const text = 'PRODUCT_BUNDLE_IDENTIFIER = app.spotifie.android;\nMARKETING_VERSION = 1.0;\nCURRENT_PROJECT_VERSION = 1;';
    const synced = iosBuild.syncProjectSettings(text, '1.0.0-rc.1');
    assert.match(synced, /PRODUCT_BUNDLE_IDENTIFIER = app\.spotifie\.ios;/);
    assert.match(synced, /MARKETING_VERSION = 1\.0\.0;/);
    assert.match(synced, /CURRENT_PROJECT_VERSION = 1;/, 'the build number is left to whoever uploads');
    assert.match(iosBuild.syncProjectSettings(text, '1.0.0', '7'), /CURRENT_PROJECT_VERSION = 7;/);
    assert.throws(() => iosBuild.syncProjectSettings(text, '1.0.0', 'seven'));
});

test('the Swift plugin offers what the page calls, keeps only bookmarks, and never deletes', () => {
    const swift = source('ios', 'App', 'App', 'MusicFoldersPlugin.swift');
    const java = source('android', 'app', 'src', 'main', 'java', 'app', 'spotifie', 'android', 'MusicFoldersPlugin.java');

    assert.match(swift, /public let jsName = "MusicFolders"/);
    const swiftMethods = (swift.match(/CAPPluginMethod\(name: "(\w+)"/g) || []).map((line) => /"(\w+)"/.exec(line)[1]);
    const javaMethods = (java.match(/@PluginMethod\s+public void (\w+)/g) || []).map((line) => /void (\w+)/.exec(line)[1]);
    javaMethods.forEach((name) => assert.ok(swiftMethods.indexOf(name) !== -1, name + ' is on iOS too'));
    ['pickFolder', 'listFolders', 'releaseFolder', 'scanFolder', 'readTags', 'pickFiles'].forEach((name) => {
        assert.match(NATIVE_LIBRARY_JS, new RegExp('\\.' + name + '\\('), 'the library calls ' + name);
    });

    assert.ok(!/removeItem|moveItem|copyItem|replaceItem|trashItem/.test(swift), 'no file is ever deleted, moved or copied');
    assert.ok(!/UserDefaults|URLSession|http/.test(swift.replace(/https?:\/\/[^\s]*/g, '')), 'bookmarks stay on the device, nothing is sent');
    assert.match(swift, /isExcludedFromBackup = true/);
    assert.match(swift, /startAccessingSecurityScopedResource/);
    assert.match(swift, /UIDocumentPickerViewController\(forOpeningContentTypes: types, asCopy: false\)/, 'opened in place, never copied in');

    // What it reads is what the privacy manifest declares.
    assert.match(swift, /contentModificationDateKey/);
    assert.match(source('ios', 'App', 'App', 'PrivacyInfo.xcprivacy'), /NSPrivacyAccessedAPICategoryFileTimestamp[\s\S]*3B52\.1/);
});

// ============================================
// What an iOS build carries
// ============================================

function tempRelease(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-ios-web-'));
    Object.keys(files).forEach((name) => {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), files[name]);
    });
    return dir;
}

test('the iOS web assets are refused if they carry an APK, admin source, private docs or a service key', () => {
    const clean = tempRelease({ 'index.html': '<!doctype html>', 'js/app.js': 'console.log(1);' });
    try {
        assert.deepStrictEqual(iosBuild.inspectWebAssets(clean), []);
    } finally {
        fs.rmSync(clean, { recursive: true, force: true });
    }

    const serviceKey = [
        Buffer.from('{"alg":"HS256"}').toString('base64url'),
        Buffer.from('{"role":"service_role","iss":"supabase"}').toString('base64url'),
        'signaturesignaturesig'
    ].join('.');
    const dirty = tempRelease({
        'index.html': '<!doctype html>',
        'downloads/spotifie-android.apk': 'PK',
        'admin-dashboard.html': '<html>',
        'P15_MAC_HANDOFF.private.md': '# private',
        'js/config.js': 'window.x = "' + serviceKey + '";'
    });
    try {
        const problems = iosBuild.inspectWebAssets(dirty).join('\n');
        assert.match(problems, /spotifie-android\.apk/);
        assert.match(problems, /admin-dashboard\.html/);
        assert.match(problems, /private document/);
        assert.match(problems, /js\/config\.js contains a service-role key/);
    } finally {
        fs.rmSync(dirty, { recursive: true, force: true });
    }

    const anon = [
        Buffer.from('{"alg":"HS256"}').toString('base64url'),
        Buffer.from('{"role":"anon","iss":"supabase"}').toString('base64url'),
        'signaturesignaturesig'
    ].join('.');
    assert.strictEqual(iosBuild.carriesServiceRoleJwt('key: "' + anon + '"'), false, 'the anon key is meant for a browser');
});

test('the built iOS assets, when present, are the shared frontend and carry nothing forbidden', () => {
    const www = path.join(ROOT, 'mobile', 'www');
    const bundled = path.join(IOS_PROJECT, 'App', 'public');
    [www, bundled].filter((dir) => fs.existsSync(path.join(dir, 'index.html'))).forEach((dir) => {
        assert.deepStrictEqual(iosBuild.inspectWebAssets(dir), [], dir);
    });
    if (fs.existsSync(path.join(www, 'index.html')) && fs.existsSync(path.join(bundled, 'index.html'))) {
        assert.strictEqual(fs.readFileSync(path.join(bundled, 'js', 'iosNative.js'), 'utf8'), source('js', 'iosNative.js'));
    }
});

test('a public release never carries the iOS project', () => {
    const dist = tempRelease({ 'index.html': '<!doctype html>', 'ios/App/App/Info.plist': '<plist/>' });
    try {
        const failures = [];
        checker.checkDownloads(dist, 'production', failures);
        assert.ok(failures.some((failure) => /^ios\/App\/App\/Info\.plist belongs to the iOS project/.test(failure)), failures.join('\n'));
    } finally {
        fs.rmSync(dist, { recursive: true, force: true });
    }
    assert.ok(require('../tools/buildPublic.js').BROWSER_SCRIPTS.every((file) => !/^ios\//.test(file)));
});
