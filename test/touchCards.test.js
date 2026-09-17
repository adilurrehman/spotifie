'use strict';

/**
 * Album options on a touch screen, and signing in inside the Android app.
 *
 * The long press is run against fake pointer events and a fake clock, because
 * what matters is behaviour: it opens after holding still, never after a
 * scroll, once, and the tap that ends it does not also open the album.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

// ============================================
// The long press
// ============================================

function loadLongPress() {
    const sandbox = { setTimeout, clearTimeout, Date, Math };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source('js', 'longPress.js'), sandbox);
    return sandbox.spotifieLongPress;
}

/** A grid with one card, a clock we move by hand, and timers that obey it. */
function harness(options) {
    const settings = options || {};
    const listeners = {};
    const area = {
        addEventListener(type, fn, capture) {
            (listeners[type] = listeners[type] || []).push({ fn: fn, capture: Boolean(capture) });
        }
    };

    const card = { id: 'card', closest: (selector) => (selector === '.cardcontainer' ? card : null) };
    const outside = { closest: () => null };

    let clock = 1000;
    let pending = [];
    const timers = {
        set(fn, ms) {
            const timer = { fn: fn, at: clock + ms };
            pending.push(timer);
            return timer;
        },
        clear(timer) {
            pending = pending.filter((entry) => entry !== timer);
        }
    };
    const advance = (ms) => {
        clock += ms;
        const due = pending.filter((timer) => timer.at <= clock);
        pending = pending.filter((timer) => timer.at > clock);
        due.forEach((timer) => timer.fn());
    };

    const opened = [];
    loadLongPress().bind(area, {
        selector: '.cardcontainer',
        accept: settings.accept,
        now: () => clock,
        timers: timers,
        onLongPress: (element, point) => opened.push({ element: element, point: point })
    });

    function dispatch(type, init) {
        const event = Object.assign(
            {
                type: type,
                target: card,
                defaultPrevented: false,
                stopped: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
                stopImmediatePropagation() {
                    this.stopped = true;
                }
            },
            init || {}
        );
        (listeners[type] || []).forEach((entry) => entry.fn(event));
        return event;
    }

    return { dispatch: dispatch, advance: advance, opened: opened, card: card, outside: outside };
}

test('holding a finger still on a card opens its options, at the finger', () => {
    const h = harness();
    h.dispatch('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 80 });
    h.advance(499);
    assert.strictEqual(h.opened.length, 0, 'not before half a second');
    h.advance(1);
    assert.strictEqual(h.opened.length, 1, 'then once');
    assert.strictEqual(h.opened[0].element, h.card);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.opened[0].point)), { x: 50, y: 80 });

    // The tap that ends the press is not a tap on the card.
    const click = h.dispatch('click');
    assert.ok(click.stopped && click.defaultPrevented, 'the album does not also open');
});

test('a scroll, a lift or a mouse never becomes a long press', () => {
    const scrolled = harness();
    scrolled.dispatch('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 80 });
    scrolled.dispatch('pointermove', { clientX: 51, clientY: 120 });
    scrolled.advance(1000);
    assert.strictEqual(scrolled.opened.length, 0, 'moving is scrolling');

    const cancelled = harness();
    cancelled.dispatch('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 80 });
    cancelled.dispatch('pointercancel');
    cancelled.advance(1000);
    assert.strictEqual(cancelled.opened.length, 0, 'the browser took over for a scroll');

    const tapped = harness();
    tapped.dispatch('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 80 });
    tapped.advance(200);
    tapped.dispatch('pointerup');
    tapped.advance(1000);
    assert.strictEqual(tapped.opened.length, 0, 'a tap is a tap');
    const click = tapped.dispatch('click');
    assert.ok(!click.stopped, 'and it still opens the album');

    const mouse = harness();
    mouse.dispatch('pointerdown', { pointerType: 'mouse', clientX: 50, clientY: 80 });
    mouse.advance(1000);
    assert.strictEqual(mouse.opened.length, 0, 'a mouse keeps its hover button');

    const small = harness();
    small.dispatch('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 80 });
    small.dispatch('pointermove', { clientX: 55, clientY: 84 });
    small.advance(500);
    assert.strictEqual(small.opened.length, 1, 'a finger that trembles is still holding still');
});

test("the browser's own long press, a right click and the menu key open the same menu, once", () => {
    const h = harness();

    // The browser's long press arrives after the timer already opened it.
    h.dispatch('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
    h.advance(500);
    const late = h.dispatch('contextmenu', { clientX: 10, clientY: 10 });
    assert.ok(late.defaultPrevented, "not the browser's menu");
    assert.strictEqual(h.opened.length, 1, 'no second copy');

    // A right click (or a long press where the browser reports it first).
    h.advance(2000);
    const right = h.dispatch('contextmenu', { clientX: 30, clientY: 40 });
    assert.ok(right.defaultPrevented);
    assert.strictEqual(h.opened.length, 2);

    // The keyboard's menu key has no point; the caller anchors to the card.
    h.advance(2000);
    h.dispatch('contextmenu', { clientX: 0, clientY: 0 });
    assert.strictEqual(h.opened[2].point, null);
});

test('a card with no options is left to the browser', () => {
    const h = harness({ accept: () => false });
    h.dispatch('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 80 });
    h.advance(1000);
    const menu = h.dispatch('contextmenu', { clientX: 50, clientY: 80 });
    assert.strictEqual(h.opened.length, 0);
    assert.ok(!menu.defaultPrevented);
});

test('touch screens show no button over the artwork; a mouse keeps the hover button', () => {
    const css = source('css', 'style.css');
    const touch = /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(touch, 'the touch rule exists');
    assert.match(touch[1], /\.card-menu-btn \{\s*display: none;/, 'no circle, and no space kept for one');
    assert.match(touch[1], /-webkit-touch-callout: none/, 'no browser callout on a long press');

    // The card's own mouse rule (the stylesheet has other hover blocks).
    assert.match(
        css,
        /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.card-menu-btn \{\s*opacity: 0;\s*\}\s*\.cardcontainer:hover \.card-menu-btn,/,
        'the hover button stays for a mouse'
    );

    const script = source('js', 'script.js');
    assert.match(script, /window\.spotifieLongPress\.bind\(cardsArea, \{/, 'the grid listens for a long press');
    assert.match(script, /onLongPress: \(card, point\) => openCardMenuAt\(card\.querySelector\('\.card-menu-btn'\), point\)/, 'and opens the same menu');

    const index = source('index.html');
    assert.ok(index.indexOf('js/longPress.js') < index.indexOf('js/script.js'), 'loaded before the player');
});

// ============================================
// Signing in inside the Android app
// ============================================

function loadAuthIn(options) {
    const settings = options || {};
    const sandbox = {
        console: { info() {}, warn() {}, error() {}, log() {} },
        setTimeout,
        clearTimeout,
        Promise,
        Object,
        JSON,
        Set,
        Map,
        Boolean,
        String,
        Error,
        Date,
        URL,
        URLSearchParams,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        // A page with nothing on it: the session module is asked about
        // addresses only.
        document: {
            readyState: 'complete',
            addEventListener() {},
            removeEventListener() {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        addEventListener() {},
        removeEventListener() {},
        location: { origin: settings.origin, href: settings.origin + '/signin.html', pathname: '/signin.html', search: '' },
        __SPOTIFIE_CONFIG__: {
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'public-anon-placeholder',
            publicSiteUrl: 'https://spotifie.adilurrehmanofficial.workers.dev',
            deployment: 'cloudflare'
        }
    };
    sandbox.sessionStorage = sandbox.localStorage;
    if (settings.android) {
        sandbox.spotifieAndroid = {
            isAndroid: () => true,
            authCallbackUrl: (next) => 'app.spotifie.android://auth/callback?next=' + encodeURIComponent(next)
        };
    }
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source('js', 'deployment.js'), sandbox);
    vm.runInContext(source('js', 'auth.js'), sandbox);
    return sandbox.spotifieAuth;
}

test('after signing in, the Android app stays in the app; the website stays on the website', () => {
    // The fault: the app is served from https://localhost, and "home" was the
    // published site - a different host, which Android hands to Chrome.
    const app = loadAuthIn({ android: true, origin: 'https://localhost' });
    assert.strictEqual(app.homeUrl(), 'https://localhost/', 'the app goes home to itself');
    assert.ok(app.homeUrl().indexOf('workers.dev') === -1, 'never to the published site');

    const web = loadAuthIn({ android: false, origin: 'https://spotifie.adilurrehmanofficial.workers.dev' });
    assert.strictEqual(web.homeUrl(), 'https://spotifie.adilurrehmanofficial.workers.dev/', 'the website is unchanged');

    // The sign-in and sign-up pages leave through homeUrl, and nothing else.
    ['signin.html', 'signup.html'].forEach((page) => {
        const text = source(page);
        assert.match(text, /auth\.homeUrl\(\) \|\| '\/'/);
        assert.ok(!/workers\.dev|PUBLIC_SITE_URL/.test(text), page + ' names no published address');
    });
});

function loadAndroidShell(plugins) {
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
        location: {
            replaced: [],
            replace(url) {
                this.replaced.push(url);
            }
        },
        Capacitor: {
            isNativePlatform: () => true,
            getPlatform: () => 'android',
            Plugins: plugins || {},
            convertFileSrc: (uri) => uri
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source('js', 'androidNative.js'), sandbox);
    return sandbox;
}

test('a link from an email reopens the app on the page it was for, and only on a known page', () => {
    const app = loadAndroidShell();
    const android = app.spotifieAndroid;

    assert.strictEqual(android.authCallbackUrl('/reset-password.html'), 'app.spotifie.android://auth/callback?next=%2Freset-password.html');
    assert.strictEqual(android.authCallbackUrl('/elsewhere'), 'app.spotifie.android://auth/callback?next=%2F');

    assert.strictEqual(
        android.handleAuthCallback('app.spotifie.android://auth/callback?next=%2Freset-password.html#access_token=a&type=recovery'),
        true
    );
    assert.strictEqual(app.location.replaced[0], '/reset-password.html#access_token=a&type=recovery', 'the page reads the session from the #');

    android.handleAuthCallback('app.spotifie.android://auth/callback?next=https%3A%2F%2Fevil.example#x');
    assert.strictEqual(app.location.replaced[1], '/#x', 'nowhere but the app');

    assert.strictEqual(android.handleAuthCallback('https://evil.example/auth/callback'), false, 'other links are not ours');

    const manifest = source('android', 'app', 'src', 'main', 'AndroidManifest.xml');
    assert.match(manifest, /<data android:scheme="app\.spotifie\.android" android:host="auth" android:pathPrefix="\/callback" \/>/);
});

test('the admin dashboard opens inside the app, on the protected site, without a bridge to the phone', async () => {
    const opened = [];
    const app = loadAndroidShell({
        InAppBrowser: {
            openInWebView: (model) => {
                opened.push(model);
                return Promise.resolve();
            }
        }
    });

    assert.strictEqual(await app.spotifieAndroid.openAdmin('https://spotifie.adilurrehmanofficial.workers.dev/?admin=enter'), true);
    assert.strictEqual(opened.length, 1, 'the in-app web view, not Chrome');
    assert.strictEqual(opened[0].url, 'https://spotifie.adilurrehmanofficial.workers.dev/?admin=enter');
    assert.strictEqual(opened[0].options.clearSessionCache, false, 'an administrator signs in there once');
    assert.strictEqual(opened[0].options.android.hardwareBack, true, 'Back walks it and then returns to Spotifie');

    assert.strictEqual(app.spotifieAndroid.openAdmin('http://insecure.example/'), false, 'HTTPS only');

    // The app carries no dashboard, and asks the site to enter it.
    const auth = source('js', 'auth.js');
    assert.match(auth, /return shell\.openAdmin\(siteUrlFor\('\/\?admin=enter'\)\);/);
    const js = source('js', 'androidNative.js');
    assert.ok(!/openInSystemBrowser|openInExternalBrowser|window\.open/.test(js), 'never the system browser');
});

// ============================================
// The real sign-in page, signing in
// ============================================

const PUBLISHED = 'https://spotifie.adilurrehmanofficial.workers.dev';

/** A page element that answers whatever the page scripts ask of it. */
function fakeElement() {
    const handlers = {};
    return {
        handlers,
        value: '',
        type: 'password',
        textContent: '',
        className: '',
        innerHTML: '',
        disabled: false,
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener(type, handler) {
            handlers[type] = handler;
        },
        removeEventListener() {},
        setAttribute() {},
        getAttribute: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild() {},
        focus() {}
    };
}

/**
 * Open one of the sign-in pages as it ships: its own inline script, run beside
 * the real deployment and session modules, against a Supabase that answers
 * like the real one - SIGNED_IN goes out before signInWithPassword resolves.
 * Everything that could leave the page is recorded: navigations, window.open,
 * and the Capacitor plugins that open a browser.
 */
function openAuthPage(page, options) {
    const settings = options || {};
    // Android's WebView serves the app at https://localhost; iOS's at
    // capacitor://localhost.
    const origin = settings.ios ? 'capacitor://localhost' : settings.android ? 'https://localhost' : PUBLISHED;
    const record = { navigations: [], opened: [], timers: [], emailLinks: [] };

    const user = { id: 'user-1', email: 'listener@example.com', user_metadata: { username: 'listener' } };
    const session = { access_token: 'token', user: user };
    let current = settings.signedIn ? session : null;
    const authListeners = [];
    const query = {
        select: () => query,
        eq: () => query,
        upsert: () => query,
        insert: () => query,
        update: () => query,
        maybeSingle: async () => ({ data: { id: user.id, email: user.email, username: 'listener' }, error: null }),
        single: async () => ({ data: { id: user.id, email: user.email, username: 'listener' }, error: null }),
        then: (resolve) => resolve({ data: null, error: null })
    };
    const client = {
        auth: {
            getSession: async () => ({ data: { session: current }, error: null }),
            onAuthStateChange(listener) {
                authListeners.push(listener);
                return { data: { subscription: { unsubscribe() {} } } };
            },
            async signInWithPassword() {
                current = session;
                authListeners.forEach((listener) => listener('SIGNED_IN', session));
                return { data: { session: session, user: user }, error: null };
            },
            signOut: async () => ({ error: null }),
            // Where the confirmation and reset emails would send somebody.
            async signUp(args) {
                record.emailLinks.push(args && args.options ? args.options.emailRedirectTo : null);
                return { data: { user: user, session: null }, error: null };
            },
            async resetPasswordForEmail(email, options) {
                record.emailLinks.push(options ? options.redirectTo : null);
                return { data: {}, error: null };
            }
        },
        from: () => query,
        rpc: async () => ({ data: false, error: null })
    };

    const elements = {};
    const documentHandlers = {};
    let href = origin + '/' + page;
    const location = {
        origin: origin,
        pathname: '/' + page,
        search: '',
        hash: '',
        get href() {
            return href;
        },
        set href(value) {
            record.navigations.push(String(value));
            href = String(value);
        },
        replace(value) {
            record.navigations.push(String(value));
            href = String(value);
        },
        assign(value) {
            record.navigations.push(String(value));
            href = String(value);
        },
        reload() {}
    };
    const opener = (via) => (url) => {
        record.opened.push({ via: via, url: url && url.url ? url.url : url });
        return Promise.resolve();
    };

    const sandbox = {
        console: { info() {}, warn() {}, error() {}, log() {} },
        setTimeout: (fn) => record.timers.push(fn),
        clearTimeout() {},
        URL,
        URLSearchParams,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: {
            readyState: 'loading',
            documentElement: { getAttribute: () => 'dark', setAttribute() {} },
            body: fakeElement(),
            getElementById(id) {
                if (!elements[id]) elements[id] = fakeElement();
                return elements[id];
            },
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => fakeElement(),
            addEventListener(type, handler) {
                documentHandlers[type] = handler;
            },
            removeEventListener() {}
        },
        addEventListener() {},
        removeEventListener() {},
        location: location,
        open: opener('window.open'),
        supabase: { createClient: () => client },
        __SPOTIFIE_CONFIG__: {
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'public-anon-placeholder',
            publicSiteUrl: PUBLISHED,
            deployment: 'cloudflare'
        }
    };
    sandbox.sessionStorage = sandbox.localStorage;
    if (settings.android || settings.ios) {
        // What Capacitor puts into every page of the app. No Spotifie adapter:
        // the sign-in pages do not load one.
        sandbox.Capacitor = {
            isNativePlatform: () => true,
            getPlatform: () => (settings.ios ? 'ios' : 'android'),
            Plugins: {
                InAppBrowser: {
                    openInWebView: opener('InAppBrowser.openInWebView'),
                    openInSystemBrowser: opener('InAppBrowser.openInSystemBrowser'),
                    openInExternalBrowser: opener('InAppBrowser.openInExternalBrowser')
                },
                Browser: { open: opener('Browser.open') }
            }
        };
    }
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    const html = source(page);
    const inline = html.split('<script src="js/auth.js"></script>')[1].split('<script>')[1].split('</script>')[0];
    vm.runInContext(source('js', 'deployment.js'), sandbox);
    vm.runInContext(source('js', 'auth.js'), sandbox);
    vm.runInContext(inline, sandbox);

    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return {
        record,
        sandbox,
        async loaded() {
            if (documentHandlers.DOMContentLoaded) await documentHandlers.DOMContentLoaded();
            await settle();
        },
        async signIn() {
            elements.email.value = user.email;
            elements.password.value = 'correct horse battery staple';
            await elements.signinForm.handlers.submit({ preventDefault() {} });
            await settle();
        },
        fireAuthEvent(event) {
            authListeners.forEach((listener) => listener(event, current));
        },
        async runTimers() {
            record.timers.splice(0).forEach((fn) => fn());
            await settle();
        }
    };
}

function assertStaysInApp(record, origin) {
    const home = (origin || 'https://localhost') + '/';
    assert.deepStrictEqual(record.opened, [], 'no browser, in-app or otherwise');
    record.navigations.forEach((url) => {
        assert.ok(url.indexOf(PUBLISHED) === -1 && url.indexOf('workers.dev') === -1, url + ' leaves the app');
        const absolute = url.charAt(0) === '/' ? home.slice(0, -1) + url : url;
        assert.ok(absolute.indexOf(home) === 0, url + ' is not inside the app');
    });
}

test('signing in on the Android app lands on the app itself, not the website in Chrome', async () => {
    const page = openAuthPage('signin.html', { android: true });
    await page.loaded();
    assert.deepStrictEqual(page.record.navigations, [], 'nobody is signed in yet');

    await page.signIn();
    assert.deepStrictEqual(page.record.navigations, ['https://localhost/'], 'one navigation, to the app root');
    assertStaysInApp(page.record);

    // Supabase's own SIGNED_IN (and a later refresh) must not start a second,
    // external navigation, nor may the page's safety-net timer.
    page.fireAuthEvent('SIGNED_IN');
    page.fireAuthEvent('TOKEN_REFRESHED');
    await page.runTimers();
    assert.deepStrictEqual(page.record.navigations, ['https://localhost/']);
    assertStaysInApp(page.record);
});

test('a session restored on the Android sign-in pages goes to the app root too', async () => {
    for (const name of ['signin.html', 'signup.html']) {
        const page = openAuthPage(name, { android: true, signedIn: true });
        await page.loaded();
        await page.runTimers();
        assert.deepStrictEqual(page.record.navigations, ['https://localhost/'], name);
        assertStaysInApp(page.record);
    }
});

test('signing in on the website still lands on the published site', async () => {
    const page = openAuthPage('signin.html', { android: false });
    await page.loaded();
    await page.signIn();
    page.fireAuthEvent('SIGNED_IN');
    await page.runTimers();
    assert.deepStrictEqual(page.record.navigations, [PUBLISHED + '/']);
    assert.deepStrictEqual(page.record.opened, []);
});

// ============================================
// The same, in the iOS app
// ============================================

const IOS_HOME = 'capacitor://localhost/';

test('signing in on the iOS app lands on the app itself, never Safari or the website', async () => {
    const page = openAuthPage('signin.html', { ios: true });
    await page.loaded();
    await page.signIn();
    page.fireAuthEvent('SIGNED_IN');
    page.fireAuthEvent('TOKEN_REFRESHED');
    await page.runTimers();

    assert.deepStrictEqual(page.record.navigations, [IOS_HOME], 'one navigation, to the app root');
    assertStaysInApp(page.record, 'capacitor://localhost');
});

test('a session restored on the iOS sign-in pages goes to the app root', async () => {
    for (const name of ['signin.html', 'signup.html']) {
        const page = openAuthPage(name, { ios: true, signedIn: true });
        await page.loaded();
        await page.runTimers();
        assert.deepStrictEqual(page.record.navigations, [IOS_HOME], name);
        assertStaysInApp(page.record, 'capacitor://localhost');
    }
});

test('confirmation and reset emails return to the app that asked for them', async () => {
    const iosPage = openAuthPage('signup.html', { ios: true });
    await iosPage.sandbox.spotifieAuth.signUp('listener@example.com', 'correct horse battery staple', 'listener');
    await iosPage.sandbox.spotifieAuth.resetPassword('listener@example.com');
    assert.deepStrictEqual(iosPage.record.emailLinks, [
        'app.spotifie.ios://auth/callback?next=%2Fsignin.html',
        'app.spotifie.ios://auth/callback?next=%2Freset-password.html'
    ]);

    // The Android app's own scheme, from its bridge alone - these pages load no adapter.
    const androidPage = openAuthPage('signup.html', { android: true });
    await androidPage.sandbox.spotifieAuth.signUp('listener@example.com', 'correct horse battery staple', 'listener');
    assert.deepStrictEqual(androidPage.record.emailLinks, ['app.spotifie.android://auth/callback?next=%2Fsignin.html']);

    // The website is unchanged.
    const web = openAuthPage('signup.html', {});
    await web.sandbox.spotifieAuth.signUp('listener@example.com', 'correct horse battery staple', 'listener');
    assert.deepStrictEqual(web.record.emailLinks, [PUBLISHED + '/signin.html']);
});
