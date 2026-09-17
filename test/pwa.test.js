'use strict';

/**
 * Spotifie as an installed application, and the desktop shell's boundary.
 *
 * The install action, the update notice and the offline word are run against
 * a small fake browser, because what matters about them is behaviour: shown
 * only when the browser offers, never after a "no", never reloading on its own.
 * The desktop adapter and the platform's feature answers are run the same way.
 * The desktop frontend build is run for real, into a throwaway directory.
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

const PWA = source('js', 'pwa.js');
const DESKTOP = source('js', 'desktopNative.js');
const PLATFORM = source('js', 'platform.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ============================================
// A browser small enough to read
// ============================================

function fakeDocument() {
    const byId = new Map();
    const listeners = {};

    function element(tag) {
        const el = {
            tagName: String(tag).toUpperCase(),
            children: [],
            attributes: {},
            listeners: {},
            hidden: false,
            className: '',
            textContent: '',
            title: '',
            type: '',
            parentNode: null,
            setAttribute(name, value) {
                this.attributes[name] = String(value);
            },
            getAttribute(name) {
                return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
            },
            appendChild(child) {
                child.parentNode = this;
                this.children.push(child);
                return child;
            },
            insertBefore(child, reference) {
                child.parentNode = this;
                const at = this.children.indexOf(reference);
                this.children.splice(at < 0 ? this.children.length : at, 0, child);
                return child;
            },
            removeChild(child) {
                this.children = this.children.filter((entry) => entry !== child);
                child.parentNode = null;
                if (child.id) byId.delete(child.id);
            },
            addEventListener(type, fn) {
                (this.listeners[type] = this.listeners[type] || []).push(fn);
            },
            click() {
                (this.listeners.click || []).forEach((fn) => fn({}));
            },
            get firstChild() {
                return this.children[0] || null;
            },
            text() {
                return [this.textContent].concat(this.children.map((child) => child.text())).join('');
            }
        };

        let id = '';
        Object.defineProperty(el, 'id', {
            get: () => id,
            set: (value) => {
                id = value;
                byId.set(value, el);
            }
        });
        return el;
    }

    const html = element('html');
    const body = element('body');
    const buttons = element('div');
    const install = element('button');
    install.id = 'installAppBtn';
    install.hidden = true;
    buttons.appendChild(install);

    // Download Android App, as index.html has it.
    const android = element('div');
    android.id = 'androidDownload';
    android.hidden = true;
    const androidButton = element('button');
    androidButton.id = 'androidDownloadBtn';
    const androidPanel = element('div');
    androidPanel.id = 'androidDownloadPanel';
    androidPanel.hidden = true;
    const androidVersion = element('p');
    androidVersion.id = 'androidDownloadVersion';
    androidVersion.hidden = true;
    const androidLink = element('a');
    androidLink.id = 'androidDownloadLink';
    androidPanel.appendChild(androidVersion);
    androidPanel.appendChild(androidLink);
    android.appendChild(androidButton);
    android.appendChild(androidPanel);
    buttons.appendChild(android);

    body.appendChild(buttons);

    return {
        readyState: 'complete',
        visibilityState: 'visible',
        documentElement: html,
        body: body,
        buttons: buttons,
        install: install,
        createElement: element,
        getElementById: (value) => byId.get(value) || null,
        querySelector: (selector) => (selector === '.header .btns' ? buttons : null),
        addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        dispatch(type) {
            (listeners[type] || []).forEach((fn) => fn({}));
        }
    };
}

function fakeStore(entries) {
    const held = new Map(entries || []);
    return {
        held: held,
        getItem: (key) => (held.has(key) ? held.get(key) : null),
        setItem: (key, value) => held.set(key, String(value)),
        removeItem: (key) => held.delete(key)
    };
}

/** js/pwa.js, running in a page with the given circumstances. */
function loadPwa(options) {
    const settings = options || {};
    const document = fakeDocument();
    const listeners = {};
    const fetched = [];
    let reloads = 0;

    const workers = settings.serviceWorker
        ? {
              controller: settings.serviceWorker.controller || null,
              listeners: {},
              addEventListener(type, fn) {
                  (this.listeners[type] = this.listeners[type] || []).push(fn);
              },
              dispatch(type) {
                  (this.listeners[type] || []).forEach((fn) => fn({}));
              },
              getRegistration: () => Promise.resolve({ update: () => Promise.resolve() })
          }
        : undefined;

    const sandbox = {
        console: { warn() {}, log() {}, error() {}, info() {} },
        setTimeout,
        clearTimeout,
        Promise,
        Date,
        JSON,
        Number,
        String,
        Boolean,
        Array,
        Object,
        document: document,
        localStorage: settings.store || fakeStore(),
        navigator: Object.assign({ onLine: settings.online !== false }, workers ? { serviceWorker: workers } : {}),
        matchMedia: (query) => ({
            matches: Boolean(settings.standalone) && /standalone/.test(query),
            addEventListener() {}
        }),
        location: {
            reload() {
                reloads += 1;
            }
        },
        addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        fetch(url) {
            fetched.push(String(url));
            return Promise.resolve({ ok: true, json: () => Promise.resolve(settings.served || {}) });
        }
    };

    if (settings.build) sandbox.__SPOTIFIE_BUILD__ = settings.build;
    if (settings.desktop) sandbox.spotifieDesktop = { isDesktop: () => true };
    // The Android app: Capacitor's bridge on its own (a page without the
    // adapter), or the adapter as index.html loads it.
    if (settings.capacitor) sandbox.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    if (settings.androidAdapter) sandbox.spotifieAndroid = { isAndroid: () => true };

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(PWA, sandbox);

    return {
        pwa: sandbox.spotifiePwa,
        document: document,
        sandbox: sandbox,
        workers: workers,
        fetched: fetched,
        reloads: () => reloads,
        fire(type, event) {
            (listeners[type] || []).forEach((fn) => fn(event || {}));
        }
    };
}

function promptEvent(outcome) {
    const event = {
        prevented: false,
        prompted: 0,
        preventDefault() {
            this.prevented = true;
        },
        prompt() {
            this.prompted += 1;
            return Promise.resolve();
        },
        userChoice: Promise.resolve({ outcome: outcome || 'accepted' })
    };
    return event;
}

// ============================================
// Installing
// ============================================

test('the install action appears only once the browser offers it, and is gone once installed', async () => {
    const page = loadPwa();
    assert.strictEqual(page.document.install.hidden, true, 'nothing offered before the browser says so');

    const event = promptEvent('accepted');
    page.fire('beforeinstallprompt', event);
    assert.strictEqual(event.prevented, true, "the browser's own banner is held back");
    assert.strictEqual(page.document.install.hidden, false, 'one Install action is shown');

    page.document.install.click();
    await tick();
    await tick();
    assert.strictEqual(event.prompted, 1, 'the browser dialog opens when it is pressed, and not before');
    assert.strictEqual(page.document.install.hidden, true, 'a prompt is used once');

    page.fire('appinstalled');
    assert.strictEqual(page.document.install.hidden, true, 'and nothing is offered once installed');
});

test('a "not now" is respected for two weeks, and only for two weeks', async () => {
    const store = fakeStore();
    const first = loadPwa({ store: store });
    first.fire('beforeinstallprompt', promptEvent('dismissed'));
    assert.strictEqual(await first.pwa.install(), 'dismissed');
    assert.ok(store.held.has(first.pwa.DISMISS_KEY), 'the answer is remembered');

    // The next visit, and the browser offers again: not shown.
    const next = loadPwa({ store: store });
    next.fire('beforeinstallprompt', promptEvent());
    assert.strictEqual(next.document.install.hidden, true, 'no second ask within two weeks');

    // Long after: offered again.
    store.setItem(first.pwa.DISMISS_KEY, String(Date.now() - 15 * 24 * 60 * 60 * 1000));
    const later = loadPwa({ store: store });
    later.fire('beforeinstallprompt', promptEvent());
    assert.strictEqual(later.document.install.hidden, false, 'offered again after two weeks');
});

test('installed, in the desktop shell, or in a browser that cannot install: no action at all', () => {
    const installed = loadPwa({ standalone: true });
    installed.fire('beforeinstallprompt', promptEvent());
    assert.strictEqual(installed.document.install.hidden, true, 'not inside the installed app');
    assert.strictEqual(installed.document.documentElement.getAttribute('data-display-mode'), 'standalone');

    const shell = loadPwa({ desktop: true });
    shell.fire('beforeinstallprompt', promptEvent());
    assert.strictEqual(shell.document.install.hidden, true, 'not inside the desktop shell');
    assert.strictEqual(shell.document.documentElement.getAttribute('data-display-mode'), 'desktop');

    // Safari and Firefox never send the event, so nothing is ever faked.
    const safari = loadPwa();
    assert.strictEqual(safari.document.install.hidden, true);
    assert.strictEqual(safari.document.documentElement.getAttribute('data-display-mode'), 'browser');
});

// ============================================
// A newer version
// ============================================

test('a newer build is announced, and reloading is left to the person', async () => {
    const page = loadPwa({ build: { commit: 'aaaaaaa' }, served: { commit: 'bbbbbbb' } });

    assert.strictEqual(await page.pwa.checkForUpdate(Date.now()), true);
    assert.deepStrictEqual(page.fetched, ['/build-info.json']);

    const notice = page.document.getElementById('updateNotice');
    assert.ok(notice, 'the notice is shown');
    assert.strictEqual(notice.getAttribute('role'), 'status', 'announced politely');
    assert.match(notice.text(), /Update available/);
    assert.strictEqual(page.reloads(), 0, 'nothing reloads by itself');

    const reload = notice.children.find((child) => child.textContent === 'Reload');
    reload.click();
    assert.strictEqual(page.reloads(), 1, 'the person chose to reload');

    // Asked again at once: not asked at all.
    assert.strictEqual(await page.pwa.checkForUpdate(Date.now()), false);
    assert.strictEqual(page.fetched.length, 1, 'no more than once every half hour');
});

test('the same build, or a copy that does not know its build, shows nothing', async () => {
    const same = loadPwa({ build: { commit: 'aaaaaaa' }, served: { commit: 'aaaaaaa' } });
    assert.strictEqual(await same.pwa.checkForUpdate(Date.now()), false);
    assert.strictEqual(same.document.getElementById('updateNotice'), null);

    const checkout = loadPwa({ served: { commit: 'bbbbbbb' } });
    assert.strictEqual(await checkout.pwa.checkForUpdate(Date.now()), false);
    assert.deepStrictEqual(checkout.fetched, [], 'a checkout never asks');

    const offline = loadPwa({ online: false, build: { commit: 'aaaaaaa' }, served: { commit: 'bbbbbbb' } });
    assert.strictEqual(await offline.pwa.checkForUpdate(Date.now()), false);
    assert.deepStrictEqual(offline.fetched, [], 'and nothing is asked while offline');
});

test('a worker replacing the one a page started under means an update; the first one does not', () => {
    const fresh = loadPwa({ serviceWorker: { controller: null } });
    fresh.workers.dispatch('controllerchange');
    assert.strictEqual(fresh.document.getElementById('updateNotice'), null, 'the first worker is not an update');
    fresh.workers.dispatch('controllerchange');
    assert.ok(fresh.document.getElementById('updateNotice'), 'the next one is');

    const returning = loadPwa({ serviceWorker: { controller: {} } });
    returning.workers.dispatch('controllerchange');
    assert.ok(returning.document.getElementById('updateNotice'));
    assert.strictEqual(returning.reloads(), 0);
});

// ============================================
// Offline
// ============================================

test('offline, the header says so in one word and says what still works', () => {
    const page = loadPwa({ online: false });

    const pill = page.document.getElementById('connectionStatus');
    assert.ok(pill, 'shown');
    assert.strictEqual(pill.getAttribute('role'), 'status');
    assert.strictEqual(page.document.buttons.firstChild, pill, 'in the header, beside the other controls');
    assert.match(pill.text(), /Offline/);
    assert.match(pill.title, /Music on this device keeps playing/);
    assert.match(pill.title, /signing in/);

    page.sandbox.navigator.onLine = true;
    page.fire('online');
    assert.strictEqual(pill.hidden, true, 'and gone when the connection is back');
});

// ============================================
// The desktop shell, as an adapter
// ============================================

function loadDesktop(globals) {
    const sandbox = Object.assign({ Array, Boolean }, globals || {});
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(DESKTOP, sandbox);
    return sandbox;
}

test('the desktop shell is recognised by its bridge, and offers nothing it has not announced', () => {
    const browser = loadDesktop();
    assert.strictEqual(browser.spotifieDesktop.isDesktop(), false);
    assert.ok(Object.values(browser.spotifieDesktop.adapter.capabilities()).every((value) => value === false));

    const shell = loadDesktop({ __TAURI_INTERNALS__: {} });
    assert.strictEqual(shell.spotifieDesktop.isDesktop(), true);
    assert.ok(
        Object.values(shell.spotifieDesktop.adapter.capabilities()).every((value) => value === false),
        'this shell grants no native capability'
    );

    const future = loadDesktop({
        __TAURI_INTERNALS__: {},
        __SPOTIFIE_DESKTOP__: { commands: ['choose_music_folders', 'scan_music_folders'] }
    });
    const capabilities = future.spotifieDesktop.adapter.capabilities();
    assert.strictEqual(capabilities.canChooseDirectory, true);
    assert.strictEqual(capabilities.canScanManagedFolders, true);
    assert.strictEqual(capabilities.canUseNativeFilesystem, true);
    assert.strictEqual(capabilities.canRevealFile, false, 'only what was announced');

    // An announcement outside the shell is ignored.
    const pretend = loadDesktop({ __SPOTIFIE_DESKTOP__: { commands: ['scan_music_folders'] } });
    assert.strictEqual(pretend.spotifieDesktop.adapter.capabilities().canUseNativeFilesystem, false);
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
            navigator: { onLine: true },
            document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
            fetch: () => Promise.reject(new Error('no network in a test')),
            addEventListener() {}
        },
        globals || {}
    );
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(DESKTOP, sandbox);
    vm.runInContext(PLATFORM, sandbox);
    return sandbox.spotifiePlatform;
}

test('what can be done with music on this device is detected, never guessed from a browser name', () => {
    const bare = loadPlatform().localMusicFeatures();
    assert.strictEqual(bare.adapter, 'none');
    assert.ok(Object.keys(bare).filter((key) => key !== 'adapter').every((key) => bare[key] === false));

    const chromium = loadPlatform({ spotifieBrowserLibrary: { supported: () => true } }).localMusicFeatures();
    assert.strictEqual(chromium.adapter, 'browser-folders');
    assert.strictEqual(chromium.canChooseDirectory, true);
    assert.strictEqual(chromium.canScanManagedFolders, true);
    assert.strictEqual(chromium.canPersistFolderAccess, false, 'a browser may ask for permission again');
    assert.strictEqual(chromium.canUseNativeFilesystem, false);

    const native = loadPlatform({
        __TAURI_INTERNALS__: {},
        __SPOTIFIE_DESKTOP__: { commands: ['choose_music_folders', 'scan_music_folders'] },
        spotifieBrowserLibrary: { supported: () => true }
    }).localMusicFeatures();
    assert.strictEqual(native.adapter, 'desktop-native', 'the shell wins when it offers native folders');
    assert.strictEqual(native.canPersistFolderAccess, true);

    // Nothing here reads a user agent.
    assert.ok(!/userAgent/.test(DESKTOP) && !/userAgent/.test(PLATFORM) && !/userAgent/.test(PWA));
});

// ============================================
// What the browser installs from
// ============================================

function pngSize(file) {
    const data = fs.readFileSync(path.join(ROOT, file));
    assert.strictEqual(data.slice(1, 4).toString('ascii'), 'PNG', file + ' is a PNG');
    return data.readUInt32BE(16) + 'x' + data.readUInt32BE(20);
}

test('the manifest names install-size icons, maskable ones included, and each file is what it says', () => {
    const manifest = JSON.parse(source('manifest.webmanifest'));
    const by = (size, purpose) =>
        manifest.icons.find((icon) => icon.sizes === size && (icon.purpose || 'any').split(' ').indexOf(purpose) !== -1);

    ['192x192', '512x512'].forEach((size) => {
        ['any', 'maskable'].forEach((purpose) => {
            const icon = by(size, purpose);
            assert.ok(icon, size + ' ' + purpose + ' icon is named');
            assert.strictEqual(pngSize(icon.src), size, icon.src + ' really is ' + size);
        });
    });

    manifest.icons.forEach((icon) => assert.strictEqual(pngSize(icon.src), icon.sizes, icon.src));
});

test('the page offers one Install action, and loads the shell modules in the right order', () => {
    const index = source('index.html');

    assert.match(index, /<button type="button" class="install-app-btn" id="installAppBtn" aria-label="Install Spotifie as a web app" hidden>/);
    assert.strictEqual((index.match(/id="installAppBtn"/g) || []).length, 1, 'one action');

    const at = (name) => index.indexOf('<script src="' + name + '"></script>');
    assert.ok(at('js/desktopNative.js') !== -1 && at('js/desktopNative.js') < at('js/platform.js'), 'the shell is known before the platform asks');
    assert.ok(at('js/pwa.js') > at('js/script.js'), 'the installed-application module comes last');
});

test('the service worker keeps the new modules for an offline start, and still never answers admin or API requests', () => {
    const sw = source('sw.js');
    const shell = sw.slice(sw.indexOf('const SHELL_ASSETS'), sw.indexOf('];', sw.indexOf('const SHELL_ASSETS')));

    ['/js/pwa.js', '/js/desktopNative.js', '/js/config.js', '/js/cloudCatalog.js', '/manifest.webmanifest'].forEach((asset) => {
        assert.ok(shell.indexOf("'" + asset + "'") !== -1, asset + ' is kept');
    });
    assert.ok(!/\.mp3|\/api\/|signed/i.test(shell), 'still no audio, API or signed address');

    const body = /function isAlwaysLive\(url\) \{[\s\S]*?\n\}/.exec(sw)[0];
    // eslint-disable-next-line no-new-func
    const isAlwaysLive = new Function(body + '\nreturn isAlwaysLive;')();
    assert.strictEqual(isAlwaysLive(new URL('https://s.test/admin-dashboard')), true);
    assert.strictEqual(isAlwaysLive(new URL('https://s.test/api/admin/enter')), true);
    assert.strictEqual(isAlwaysLive(new URL('https://s.test/downloads/spotifie-android.apk')), true, 'the APK is never cached');
});

// ============================================
// Download Android App
// ============================================

const WITH_APP = {
    commit: 'abc1234',
    version: '1.0.0-rc.1',
    androidApp: { url: '/downloads/spotifie-android.apk', bytes: 13800000 }
};

test('the website offers the Android app when the build carries it, with its version', () => {
    const page = loadPwa({ build: WITH_APP });
    const get = (id) => page.document.getElementById(id);

    assert.strictEqual(get('androidDownload').hidden, false, 'shown');
    assert.strictEqual(get('androidDownloadLink').getAttribute('href'), '/downloads/spotifie-android.apk');
    assert.strictEqual(get('androidDownloadLink').getAttribute('download'), 'Spotifie-Android.apk');
    assert.strictEqual(get('androidDownloadVersion').textContent, 'Spotifie 1.0.0-rc.1 · 13.2 MB', 'the version and size the build carries');
    assert.strictEqual(get('androidDownloadVersion').hidden, false);

    // The button opens the note and the link, and closes them again.
    assert.strictEqual(get('androidDownloadPanel').hidden, true);
    get('androidDownloadBtn').click();
    assert.strictEqual(get('androidDownloadPanel').hidden, false);
    assert.strictEqual(get('androidDownloadBtn').getAttribute('aria-expanded'), 'true');
    get('androidDownloadBtn').click();
    assert.strictEqual(get('androidDownloadPanel').hidden, true);
    assert.strictEqual(get('androidDownloadBtn').getAttribute('aria-expanded'), 'false');

    // The browser downloads the file itself; the page never reads it.
    assert.ok(!page.fetched.some((url) => /\.apk/i.test(url)), 'no fetch of the APK');
});

test('an installed web app still offers it; the Android app and the desktop app never do', () => {
    const installed = loadPwa({ build: WITH_APP, standalone: true });
    assert.strictEqual(installed.document.getElementById('androidDownload').hidden, false, 'installed web app');

    [{ capacitor: true }, { androidAdapter: true }, { desktop: true }].forEach((shell) => {
        const page = loadPwa(Object.assign({ build: WITH_APP }, shell));
        const name = JSON.stringify(shell);
        assert.strictEqual(page.pwa.canOfferAndroidApp(), false, name);
        assert.strictEqual(page.document.getElementById('androidDownload').hidden, true, name + ' hides it');
        assert.strictEqual(page.document.getElementById('androidDownloadLink').getAttribute('href'), null, name + ' gives no link');
    });
});

test('a build without the Android app offers no download, so there is never a broken link', () => {
    [
        undefined,
        { commit: 'abc1234', version: '1.0.0-rc.1' },
        { commit: 'abc1234', androidApp: { url: 'https://elsewhere.example/app.apk' } }
    ].forEach((build) => {
        const page = loadPwa(build ? { build: build } : {});
        assert.strictEqual(page.document.getElementById('androidDownload').hidden, true, JSON.stringify(build));
        assert.strictEqual(page.document.getElementById('androidDownloadLink').getAttribute('href'), null);
    });
});

test('Install Web App and Download Android App are two separate, clearly named actions', () => {
    const index = source('index.html');
    assert.match(index, /<span class="install-app-label">Install Web App<\/span>/);
    assert.match(index, /<div class="android-download" id="androidDownload" hidden>/);
    assert.match(index, /<span class="android-download-label">Download Android App<\/span>/);
    assert.strictEqual((index.match(/>Install</g) || []).length, 0, 'no second bare "Install"');

    const block = index.slice(index.indexOf('id="androidDownload"'), index.indexOf('</a>', index.indexOf('id="androidDownloadLink"')));
    assert.match(block, /Android APK &mdash; direct installation\. Your browser may ask permission to install apps from this source\./);
    assert.ok(!/Play Store|Google Play|automatic update|signed/i.test(block), 'claims nothing it cannot keep');
    // The page names no address: only a build that carries the app gives the link one.
    assert.ok(!/href=/.test(block), 'no link until the build says there is a file');
    assert.ok(!/1\.0\.0/.test(block), 'the version comes from the build, not a second copy');
});

test('the offline shell is registered even when start-up finishes after the page has loaded', () => {
    const script = source('js', 'script.js');
    const start = script.indexOf('function initAppShellCache()');
    const body = script.slice(start, script.indexOf('\n}\n', start) + 2);

    // Run the real function against a page whose load event has already
    // happened - the usual case, since it is called late in start-up.
    const registered = [];
    const waiting = [];
    const sandbox = {
        console: { warn() {} },
        navigator: { serviceWorker: { register: (url) => (registered.push(url), Promise.resolve({})) } },
        window: { isSecureContext: true, addEventListener: (type) => waiting.push(type) },
        document: { readyState: 'complete' }
    };
    vm.createContext(sandbox);
    vm.runInContext(body + '\ninitAppShellCache();', sandbox);
    assert.deepStrictEqual(registered, ['/sw.js'], 'registered at once');
    assert.deepStrictEqual(waiting, [], 'not left waiting for a load that has already happened');

    // And a page still loading waits for its load event.
    const early = { registered: [], waiting: [] };
    const loading = {
        console: { warn() {} },
        navigator: { serviceWorker: { register: (url) => (early.registered.push(url), Promise.resolve({})) } },
        window: { isSecureContext: true, addEventListener: (type) => early.waiting.push(type) },
        document: { readyState: 'loading' }
    };
    vm.createContext(loading);
    vm.runInContext(body + '\ninitAppShellCache();', loading);
    assert.deepStrictEqual(early.registered, []);
    assert.deepStrictEqual(early.waiting, ['load']);
});

// ============================================
// The desktop frontend and shell
// ============================================

const REAL = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_desktoptestvalue0123456789',
    PUBLIC_SITE_URL: 'https://spotifie-desktop-test.pages.dev'
};

function buildDesktop(env) {
    const out = path.join(os.tmpdir(), 'spotifie-desktop-test-' + process.pid);
    fs.rmSync(out, { recursive: true, force: true });
    const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'buildDesktop.js')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { WORKERS_CI: '', SPOTIFIE_DESKTOP_OUT: out }, env)
    });
    return { out: out, status: result.status, output: String(result.stdout || '') + String(result.stderr || '') };
}

function files(directory) {
    const found = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(full);
            else found.push(path.relative(directory, full).split(path.sep).join('/'));
        }
    };
    visit(directory);
    return found;
}

test('the desktop frontend is the web app, without the server, the admin half or the service worker', () => {
    const built = buildDesktop(REAL);
    assert.strictEqual(built.status, 0, built.output);

    try {
        const names = files(built.out);

        ['index.html', 'js/script.js', 'js/auth.js', 'js/pwa.js', 'js/desktopNative.js', 'js/config.js', 'css/style.css', 'manifest.webmanifest'].forEach(
            (name) => assert.ok(names.indexOf(name) !== -1, name + ' is in the frontend')
        );

        ['js/admin.js', 'admin-dashboard.html', 'server.js', 'sw.js', 'supabase-setup.sql', 'package.json', '_headers', 'README.md'].forEach(
            (name) => assert.ok(names.indexOf(name) === -1, name + ' is not')
        );
        assert.ok(!names.some((name) => /^lib\//.test(name)), 'no server modules');

        const index = fs.readFileSync(path.join(built.out, 'index.html'), 'utf8');
        const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(index);
        assert.ok(csp, 'each page carries its own policy');
        assert.match(csp[1], /connect-src 'self' https:\/\/abcdefghijklmnopqrst\.supabase\.co wss:\/\/abcdefghijklmnopqrst\.supabase\.co/);
        assert.match(csp[1], /ipc: http:\/\/ipc\.localhost/);
        assert.match(csp[1], /object-src 'none'/);
        assert.ok(!/id="dashboardLink"/.test(index), 'no admin link in the markup');

        // The public settings are in, and nothing secret.
        const config = fs.readFileSync(path.join(built.out, 'js', 'config.js'), 'utf8');
        assert.match(config, /"deployment": "cloudflare"/);
        assert.ok(!/service_role|sb_secret_/.test(config));
    } finally {
        fs.rmSync(built.out, { recursive: true, force: true });
    }
});

test('the desktop frontend refuses placeholder settings, naming them and never their values', () => {
    const built = buildDesktop({
        SUPABASE_URL: REAL.SUPABASE_URL,
        SUPABASE_ANON_KEY: 'PASTE_YOUR_PUBLISHABLE_KEY',
        PUBLIC_SITE_URL: ''
    });

    assert.notStrictEqual(built.status, 0);
    assert.match(built.output, /PUBLIC_SITE_URL/);
    assert.ok(built.output.indexOf('PASTE_YOUR_PUBLISHABLE_KEY') === -1, 'the value is never printed');
    assert.ok(!fs.existsSync(path.join(built.out, 'index.html')), 'and nothing was written to package');
});

test('the desktop shell asks for nothing but a window', () => {
    const capability = JSON.parse(source('src-tauri', 'capabilities', 'default.json'));
    assert.deepStrictEqual(capability.permissions, ['core:default'], 'core only: no fs, shell, process, dialog or http');
    assert.deepStrictEqual(capability.windows, ['main']);
    assert.ok(!('remote' in capability), 'no remote page is granted anything');

    const cargo = source('src-tauri', 'Cargo.toml');
    const dependencies = cargo.slice(cargo.indexOf('[dependencies]'), cargo.indexOf('[profile.release]'));
    assert.ok(!/tauri-plugin-/.test(dependencies), 'no plugin');

    const main = source('src-tauri', 'src', 'main.rs');
    assert.ok(!/invoke_handler|\.plugin\(/.test(main), 'no command and no plugin registered');

    const config = JSON.parse(source('src-tauri', 'tauri.conf.json'));
    assert.strictEqual(config.build.frontendDist, '../desktop/dist', 'the shell loads the one frontend');
    assert.strictEqual(config.app.withGlobalTauri, false);
    assert.strictEqual(config.identifier, 'app.spotifie.desktop');
    assert.ok(!/admin/i.test(JSON.stringify(config)), 'nothing administrative is bundled');
});
