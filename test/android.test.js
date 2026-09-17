'use strict';

/**
 * The Android app: the adapter, its Local Music, the Back button, and the
 * boundary of what the native project may ask for.
 *
 * The adapter is run against a fake Capacitor bridge and a fake MusicFolders
 * plugin, so what is checked is behaviour: a folder chosen, walked, rescanned
 * without re-reading unchanged songs, and forgotten without touching a file.
 * The native project is read where it is written.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const ANDROID_JS = source('js', 'androidNative.js');
// The Local Music library both phone apps share, loaded first as index.html does.
const NATIVE_LIBRARY_JS = source('js', 'nativeLibrary.js');

// ============================================
// An IndexedDB small enough to reason about
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
        open() {
            const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
            setTimeout(() => {
                if (req.onupgradeneeded) req.onupgradeneeded();
                if (req.onsuccess) req.onsuccess();
            }, 0);
            return req;
        }
    };
}

/** A folder on a "phone": documents with a path, a size and a modified time. */
function fakeMusicFolders(files) {
    const calls = { readTags: [], released: [], scans: 0 };
    let granted = new Set();
    const tree = 'content://com.android.externalstorage.documents/tree/primary%3AMusic';

    const plugin = {
        calls: calls,
        tree: tree,
        files: files,
        grant(uri) {
            granted.add(uri);
        },
        revokeAll() {
            granted = new Set();
        },
        pickFolder() {
            granted.add(tree);
            return Promise.resolve({ uri: tree, name: 'Music' });
        },
        listFolders() {
            return Promise.resolve({ folders: Array.from(granted).map((uri) => ({ uri: uri, name: 'Music' })) });
        },
        scanFolder({ uri }) {
            calls.scans += 1;
            if (!granted.has(uri)) return Promise.reject(new Error('NOT_GRANTED'));
            return Promise.resolve({
                files: plugin.files.map((file) => ({
                    uri: tree + '/document/primary%3AMusic%2F' + encodeURIComponent(file.path),
                    path: file.path,
                    name: file.path.split('/').pop(),
                    size: file.size,
                    lastModified: file.lastModified
                }))
            });
        },
        readTags({ uri }) {
            calls.readTags.push(uri);
            return Promise.resolve({ title: 'Tagged ' + calls.readTags.length, artist: 'Someone', duration: 180 });
        },
        releaseFolder({ uri }) {
            calls.released.push(uri);
            granted.delete(uri);
            return Promise.resolve();
        }
    };
    return plugin;
}

/** js/androidNative.js in an Android WebView, or in an ordinary browser. */
function loadAndroid(options) {
    const settings = options || {};
    const listeners = {};

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
        Uint8Array,
        TextEncoder,
        Date,
        Math,
        crypto: require('crypto').webcrypto,
        indexedDB: fakeIndexedDB(),
        KeyboardEvent: function (type, init) {
            this.type = type;
            this.key = init && init.key;
        },
        history: { state: settings.historyState || null, backs: 0, back() { this.backs += 1; } },
        document: settings.document || null
    };

    if (settings.android !== false) {
        const plugins = {};
        if (settings.folders) plugins.MusicFolders = settings.folders;
        plugins.App = {
            minimized: 0,
            addListener(event, fn) {
                listeners[event] = fn;
            },
            minimizeApp() {
                this.minimized += 1;
            }
        };
        sandbox.Capacitor = {
            isNativePlatform: () => true,
            getPlatform: () => 'android',
            Plugins: plugins,
            convertFileSrc: (uri) => 'https://localhost/_capacitor_content_/' + uri.replace('content://', '')
        };
    }

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(NATIVE_LIBRARY_JS, sandbox);
    vm.runInContext(ANDROID_JS, sandbox);
    return { sandbox: sandbox, android: sandbox.spotifieAndroid, listeners: listeners };
}

// ============================================
// Recognising the app, and what it can do
// ============================================

test('the Android app is recognised by its bridge; a browser is left alone', () => {
    const browser = loadAndroid({ android: false });
    assert.strictEqual(browser.android.isAndroid(), false);
    assert.strictEqual(browser.sandbox.spotifieBrowserLibrary, undefined, 'nothing replaced in a browser');

    const app = loadAndroid({ folders: fakeMusicFolders([]) });
    assert.strictEqual(app.android.isAndroid(), true);
    assert.strictEqual(app.sandbox.spotifieBrowserLibrary, app.android.library, "the phone's folders stand behind the same interface");

    const capabilities = app.android.adapter.capabilities();
    assert.strictEqual(capabilities.canChooseDirectory, true);
    assert.strictEqual(capabilities.canPersistFolderAccess, true);
    assert.strictEqual(capabilities.canScanManagedFolders, true);
    assert.strictEqual(capabilities.canReadLocalAudio, true);
    assert.strictEqual(capabilities.canUseBackgroundAudio, false, 'not claimed without a native media service');
    assert.strictEqual(capabilities.canUseMediaControls, false);
    assert.strictEqual(capabilities.canRevealFile, false);
    assert.strictEqual(capabilities.canShareFile, false);

    assert.ok(!/userAgent/.test(ANDROID_JS), 'no user-agent sniffing');
});

test('the library interface is the browser one, method for method', () => {
    const browser = source('js', 'browserLibrary.js');
    const exported = /global\.spotifieBrowserLibrary = \{([\s\S]*?)\};/.exec(browser)[1];
    const names = (exported.match(/^\s{8}([a-zA-Z_]+):/gm) || []).map((line) => line.trim().replace(':', ''));

    const app = loadAndroid({ folders: fakeMusicFolders([]) });
    names.forEach((name) => {
        assert.ok(name in app.android.library, 'Android library offers ' + name);
    });
});

// ============================================
// Local Music on the phone
// ============================================

test('a chosen folder is walked, played in place, and rescanned without re-reading unchanged songs', async () => {
    const folders = fakeMusicFolders([
        { path: 'Album/01 One.mp3', size: 1000, lastModified: 1 },
        { path: 'Album/02 Two.flac', size: 2000, lastModified: 1 },
        { path: 'notes.txt', size: 10, lastModified: 1 }
    ]);
    const app = loadAndroid({ folders: folders });
    const library = app.android.library;

    const result = await library.chooseFolder();
    assert.strictEqual(result.trackCount, 2, 'only audio');
    assert.strictEqual(result.added, 2);
    assert.strictEqual(folders.calls.readTags.length, 2, 'tags read for new songs');

    const catalogue = library.catalogue();
    assert.strictEqual(catalogue.albums[0].id, 'system:local-music');
    assert.strictEqual(catalogue.tracks.length, 2);
    catalogue.tracks.forEach((track) => {
        assert.match(track.id, /^local:[0-9a-f]{64}$/, 'a stable, namespaced id');
        assert.strictEqual(track.source, 'local');
    });

    // Played from the document itself, through the app's own server - no copy.
    const url = await library.trackUrl(catalogue.tracks[0].id);
    assert.match(url, /^https:\/\/localhost\/_capacitor_content_\//);

    // Nothing changed: the same ids, and no tags read again.
    const ids = catalogue.tracks.map((track) => track.id).sort();
    const again = await library.refresh();
    assert.strictEqual(again.scanned, 1);
    assert.strictEqual(folders.calls.readTags.length, 2, 'unchanged songs are not opened again');
    assert.deepStrictEqual(library.catalogue().tracks.map((track) => track.id).sort(), ids);

    // One song changed, one deleted, one added.
    folders.files = [
        { path: 'Album/01 One.mp3', size: 1500, lastModified: 2 },
        { path: 'Album/03 Three.opus', size: 3000, lastModified: 1 }
    ];
    const changed = await library.refresh();
    assert.strictEqual(library.catalogue().tracks.length, 2, 'the deleted song has gone');
    assert.strictEqual(folders.calls.readTags.length, 4, 'only the changed and the new song were read');
    assert.ok(changed.added >= 1);
});

test('a folder whose grant was taken back keeps its songs and asks to be chosen again', async () => {
    const folders = fakeMusicFolders([{ path: 'a.mp3', size: 1, lastModified: 1 }]);
    const app = loadAndroid({ folders: folders });

    await app.android.library.chooseFolder();
    folders.revokeAll();

    const summary = await app.android.library.refresh();
    assert.strictEqual(summary.needsPermission, 1);
    assert.strictEqual(app.android.library.folders()[0].needsPermission, true);
    assert.strictEqual(app.android.library.catalogue().tracks.length, 1, 'the song is still listed');
});

test('forgetting a folder releases the grant and removes its songs; no file is touched', async () => {
    const folders = fakeMusicFolders([{ path: 'a.mp3', size: 1, lastModified: 1 }]);
    const app = loadAndroid({ folders: folders });

    await app.android.library.chooseFolder();
    const id = app.android.library.folders()[0].id;

    assert.strictEqual(await app.android.library.forget(id), true);
    assert.deepStrictEqual(folders.calls.released, [id], 'the grant was released');
    // Compared as data: the objects were made inside the page's own realm.
    assert.strictEqual(JSON.stringify(app.android.library.folders()), '[]');
    assert.strictEqual(JSON.stringify(app.android.library.catalogue()), JSON.stringify({ albums: [], tracks: [] }));
    assert.deepStrictEqual(folders.files.length, 1, 'the files themselves are untouched');

    // And the plugin offers nothing that could write, move or delete a file.
    const plugin = source('android', 'app', 'src', 'main', 'java', 'app', 'spotifie', 'android', 'MusicFoldersPlugin.java');
    assert.ok(!/deleteDocument|renameDocument|moveDocument|openOutputStream|FLAG_GRANT_WRITE_URI_PERMISSION/.test(plugin), 'read only');
    assert.match(plugin, /takePersistableUriPermission\(tree, Intent\.FLAG_GRANT_READ_URI_PERMISSION\)/);
    assert.match(plugin, /ACTION_OPEN_DOCUMENT_TREE/);
});

test('a cancelled picker is a cancel, not a failure', async () => {
    const folders = fakeMusicFolders([]);
    folders.pickFolder = () => Promise.reject(new Error('CANCELLED'));
    const app = loadAndroid({ folders: folders });

    await assert.rejects(app.android.library.chooseFolder(), (error) => error.name === 'AbortError');
});

// ============================================
// The Back button
// ============================================

function fakePage(state) {
    const dispatched = [];
    const back = { disabled: !state.canGoBack, clicks: 0, click() { this.clicks += 1; } };
    return {
        dispatched: dispatched,
        back: back,
        body: { classList: { contains: (name) => name === 'sidebar-open' && Boolean(state.sidebar) } },
        querySelector: (selector) => (state.open && state.open.indexOf(selector) !== -1 ? {} : null),
        getElementById: (id) => (id === 'navBack' ? back : null),
        dispatchEvent: (event) => dispatched.push(event.key)
    };
}

test('Back closes what is open, then Now Playing, then goes back a view, and only then steps aside', () => {
    const app = loadAndroid({ folders: fakeMusicFolders([]) });

    const modal = fakePage({ open: ['.modal:not(.hidden)'], canGoBack: true });
    assert.strictEqual(app.android.handleBack(modal), 'closed-overlay');
    assert.deepStrictEqual(modal.dispatched, ['Escape'], 'closed by the handler that already closes it');
    assert.strictEqual(modal.back.clicks, 0, 'and nothing else happens');

    const menu = fakePage({ open: ['#userDropdown.active'] });
    assert.strictEqual(app.android.handleBack(menu), 'closed-overlay');

    const drawer = fakePage({ sidebar: true });
    assert.strictEqual(app.android.handleBack(drawer), 'closed-overlay');

    app.sandbox.history.state = { spotifieView: 'nowPlaying' };
    assert.strictEqual(app.android.handleBack(fakePage({})), 'closed-now-playing');
    assert.strictEqual(app.sandbox.history.backs, 1);
    app.sandbox.history.state = null;

    const album = fakePage({ canGoBack: true });
    assert.strictEqual(app.android.handleBack(album), 'navigated-back');
    assert.strictEqual(album.back.clicks, 1);

    const root = fakePage({});
    assert.strictEqual(app.android.handleBack(root), 'minimized');
    assert.strictEqual(app.sandbox.Capacitor.Plugins.App.minimized, 1, 'the app steps aside rather than closing');

    assert.strictEqual(typeof app.listeners.backButton, 'function', 'wired to the hardware button');
});

// ============================================
// The native project asks for as little as possible
// ============================================

test('the Android manifest asks for the network, background playback, and nothing else', () => {
    const manifest = source('android', 'app', 'src', 'main', 'AndroidManifest.xml');
    const lines = manifest.match(/<uses-permission [^>]*\/>/g) || [];
    const nameOf = (line) => line.replace(/.*android:name="([^"]+)".*/, '$1');
    const permissions = lines.filter((line) => !/tools:node="remove"/.test(line)).map(nameOf);

    assert.deepStrictEqual(
        permissions,
        [
            'android.permission.INTERNET',
            // Playing while the app is in the background, and keeping a
            // stream alive with the screen off. Nothing else.
            'android.permission.FOREGROUND_SERVICE',
            'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
            'android.permission.WAKE_LOCK'
        ],
        'the network and background playback only'
    );
    assert.ok(
        !permissions.some((name) => /POST_NOTIFICATIONS/.test(name)),
        "a media session's notification needs no permission"
    );

    // What the in-app browser library would add is taken out of the merge.
    const removed = lines.filter((line) => /tools:node="remove"/.test(line)).map(nameOf).sort();
    assert.deepStrictEqual(removed, [
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.CAMERA',
        'android.permission.MODIFY_AUDIO_SETTINGS',
        'android.permission.RECORD_AUDIO'
    ]);

    // And the built APK is checked after the merge, where a plugin adds them.
    const builder = source('tools', 'androidBuild.js');
    assert.match(builder, /mergedPermissions\(APK, env\)\.filter\(\(name\) => ALLOWED_PERMISSIONS\.indexOf\(name\) === -1\)/);
    assert.ok(!/MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|READ_MEDIA_AUDIO|WRITE_EXTERNAL_STORAGE/.test(manifest), 'no storage permission: SAF needs none');
    assert.match(manifest, /android:allowBackup="false"/, 'no Android backup of the session or the index');
    assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
    assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
    assert.match(manifest, /android:usesCleartextTraffic="false"/);

    const network = source('android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml');
    assert.match(network, /<base-config cleartextTrafficPermitted="false">/);
    assert.ok(!/cleartextTrafficPermitted="true"/.test(network), 'no plain HTTP anywhere');
});

test('the app is Spotifie, versioned with the release, and registers only its own plugin', () => {
    const config = JSON.parse(source('capacitor.config.json'));
    assert.strictEqual(config.appId, 'app.spotifie.android');
    assert.strictEqual(config.appName, 'Spotifie');
    assert.strictEqual(config.webDir, 'mobile/www', 'the one frontend, as built for the app');
    assert.strictEqual(config.server.androidScheme, 'https');
    assert.strictEqual(config.server.cleartext, false);
    assert.ok(!config.server.url, 'never loads a remote page into the shell');

    const gradle = source('android', 'app', 'build.gradle');
    const pkg = JSON.parse(source('package.json'));
    assert.match(gradle, /applicationId "app\.spotifie\.android"/);
    // Both come from package.json, derived by Gradle, never written by hand.
    assert.match(gradle, /versionName spotifieVersion/, 'versionName follows package.json');
    assert.match(gradle, /versionCode spotifieVersionCode/);
    assert.ok(require('../tools/releaseVersion.js').androidVersionCode(pkg.version) > 1);

    const main = source('android', 'app', 'src', 'main', 'java', 'app', 'spotifie', 'android', 'MainActivity.java');
    assert.match(main, /registerPlugin\(MusicFoldersPlugin\.class\)/);

    const strings = source('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
    assert.match(strings, /<string name="app_name">Spotifie<\/string>/);
    assert.ok(!/Spotify</.test(strings), 'no borrowed name');
});

// ============================================
// The frontend the app carries
// ============================================

test('the Android frontend is the web app, without the admin half, the server or the service worker', () => {
    const out = path.join(os.tmpdir(), 'spotifie-mobile-test-' + process.pid);
    fs.rmSync(out, { recursive: true, force: true });

    const built = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'buildMobile.js')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            WORKERS_CI: '',
            SPOTIFIE_MOBILE_OUT: out,
            SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
            SUPABASE_ANON_KEY: 'sb_publishable_androidtestvalue0123456789',
            PUBLIC_SITE_URL: 'https://spotifie-android-test.pages.dev'
        })
    });
    assert.strictEqual(built.status, 0, String(built.stdout) + String(built.stderr));

    try {
        const has = (name) => fs.existsSync(path.join(out, name));
        ['index.html', 'js/androidNative.js', 'js/script.js', 'js/config.js'].forEach((name) => assert.ok(has(name), name));
        ['js/admin.js', 'admin-dashboard.html', 'server.js', 'sw.js', 'lib'].forEach((name) => assert.ok(!has(name), name + ' is not carried'));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }

    const placeholder = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'buildMobile.js')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            WORKERS_CI: '',
            SPOTIFIE_MOBILE_OUT: out,
            SUPABASE_URL: 'https://your-project-ref.supabase.co',
            SUPABASE_ANON_KEY: 'YOUR_PUBLISHABLE_KEY_HERE',
            PUBLIC_SITE_URL: 'https://example.com'
        })
    });
    assert.notStrictEqual(placeholder.status, 0, 'placeholder settings are refused');
    const said = String(placeholder.stdout) + String(placeholder.stderr);
    assert.match(said, /SUPABASE_URL/);
    assert.ok(said.indexOf('YOUR_PUBLISHABLE_KEY_HERE') === -1, 'and the value is never printed');
});

test('the APK inspector reads an archive and names anything that must not be in it', () => {
    const inspector = require('../tools/androidBuild.js');
    assert.strictEqual(typeof inspector.inspectApk, 'function');
    assert.ok(inspector.FORBIDDEN_NAMES.some((pattern) => pattern.test('assets/public/js/admin.js')));
    assert.ok(inspector.FORBIDDEN_NAMES.some((pattern) => pattern.test('assets/public/admin-dashboard.html')));
    assert.ok(inspector.FORBIDDEN_NAMES.some((pattern) => pattern.test('assets/public/music/song.mp3')));
    assert.ok(!inspector.FORBIDDEN_NAMES.some((pattern) => pattern.test('assets/public/js/androidNative.js')));

    // A built APK, when there is one, is checked for real.
    if (fs.existsSync(inspector.APK)) {
        assert.deepStrictEqual(inspector.inspectApk(inspector.APK), [], 'the built APK is clean');
    }
});
