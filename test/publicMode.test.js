'use strict';

/**
 * Which Spotifie this is, and what it therefore asks for.
 *
 * This is the file that would have caught the deployment being broken.
 *
 * The browser assumed the Spotifie server sat on the same origin as the page.
 * That is true of a checkout somebody is running and false of a copy published
 * to a static host, where every /api request collected a 404 - including the
 * one that carries the Supabase settings, so the application then told people
 * that Supabase was not configured and refused to sign anybody in.
 *
 * The separation these hold in place has three parts. The question is answered
 * from what the build wrote rather than from the address bar. A published copy
 * asks a static host for no API at all, and gets the catalogue, the artwork,
 * the audio and its own settings elsewhere. And the helper that serves the
 * music on somebody's machine is looked for at loopback, when somebody asks
 * for it, and never on a timer.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const DEPLOYMENT = source('js', 'deployment.js');
const PLATFORM = source('js', 'platform.js');

/** The settings a published build writes into the page. */
function publishedSettings(extra) {
    return Object.assign(
        {
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'public-anon-placeholder',
            publicSiteUrl: 'https://spotifie.example',
            deployment: 'cloudflare'
        },
        extra || {}
    );
}

/**
 * A browser with nothing in it but the parts these modules actually touch,
 * with the deployment module and, if asked, the platform on top of it.
 */
function load(options) {
    const settings = options || {};
    const calls = [];
    const timers = [];

    const sandbox = {
        console: { warn() {}, log() {}, error() {} },
        setTimeout(fn, wait) {
            timers.push(wait);
            return setTimeout(fn, 1000000);
        },
        clearTimeout: clearTimeout,
        Promise: Promise,
        Math: Math,
        Date: Date,
        Object: Object,
        Set: Set,
        Map: Map,
        Error: Error,
        String: String,
        Boolean: Boolean,
        JSON: JSON,
        navigator: { onLine: true },
        AbortController: AbortController,
        document: {
            visibilityState: 'visible',
            addEventListener() {},
            removeEventListener() {}
        },
        fetch(url, init) {
            calls.push(String(url));
            return (settings.fetch || (() => Promise.reject(new Error('Failed to fetch'))))(String(url), init || {});
        }
    };

    sandbox.window = sandbox;
    sandbox.window.addEventListener = () => {};
    sandbox.globalThis = sandbox;
    if (settings.config) sandbox.__SPOTIFIE_CONFIG__ = settings.config;

    vm.createContext(sandbox);
    vm.runInContext(DEPLOYMENT, sandbox);
    if (settings.platform) vm.runInContext(PLATFORM, sandbox);

    return {
        deployment: sandbox.spotifieDeployment,
        platform: sandbox.spotifiePlatform,
        calls: calls,
        timers: timers
    };
}

// ============================================
// Which copy is this
// ============================================

test('a checkout knows it has a server, and a published copy knows it has none', () => {
    const checkout = load().deployment;

    assert.strictEqual(checkout.isPublished(), false);
    assert.strictEqual(checkout.hasLocalApi(), true, 'a checkout asks its own server');
    assert.strictEqual(checkout.supabase(), null, 'and gets its settings from it');
    assert.strictEqual(checkout.siteUrl(), null, 'and is published nowhere');

    const copy = load({ config: publishedSettings() }).deployment;

    assert.strictEqual(copy.isPublished(), true);
    assert.strictEqual(copy.hasLocalApi(), false, 'a published copy has no API on its origin');
    // Compared by what it says rather than by identity: it was made inside
    // the sandbox, so it is not this file's idea of an object.
    const carried = copy.supabase();
    assert.strictEqual(carried.url, 'https://example.supabase.co');
    assert.strictEqual(carried.anonKey, 'public-anon-placeholder');
    assert.strictEqual(copy.siteUrl(), 'https://spotifie.example');
});

test('the answer comes from the build, never from the address bar', () => {
    // A copy is what it was built as, wherever it is read. That is what lets
    // somebody test a published build on localhost without it being mistaken
    // for a checkout, and a checkout behind a tunnel without the reverse.
    // Read as code rather than as prose: the comments in there describe the
    // mistake this replaced, and naming it is the whole point of them.
    const code = DEPLOYMENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    assert.ok(!/location\.(hostname|host|origin)/.test(code), 'nothing sniffs the address');
    assert.ok(!/workers\.dev|pages\.dev/.test(code), 'and nothing is keyed to a particular host');

    // A build that writes deployment: "local" is a local one, whatever else it
    // carries - so the settings can be generated the same way in both.
    const local = load({ config: publishedSettings({ deployment: 'local' }) }).deployment;
    assert.strictEqual(local.isPublished(), false);
    assert.strictEqual(local.hasLocalApi(), true);

    // Settings with no key in them are not settings. A published copy missing
    // half of them is reported as unconfigured rather than half-working.
    const half = load({ config: { deployment: 'cloudflare', supabaseUrl: 'https://example.supabase.co' } }).deployment;
    assert.strictEqual(half.isPublished(), true);
    assert.strictEqual(half.supabase(), null);
    assert.strictEqual(half.describe().configured, false);
});

test('a helper is looked for at loopback, and never at the page origin', () => {
    // Building this address out of the page origin is exactly what sent
    // /api/library/health to a static host and had it answered 404.
    assert.match(DEPLOYMENT, /var LOCAL_HELPER_ORIGIN = 'http:\/\/127\.0\.0\.1:3000';/);

    const copy = load({ config: publishedSettings() }).deployment;
    assert.strictEqual(copy.localHelperOrigin(), 'http://127.0.0.1:3000');

    // A checkout is already on the helper's origin, so it asks for a path.
    assert.strictEqual(load().deployment.localHelperOrigin(), '');
});

// ============================================
// What a published copy asks for
// ============================================

test('a published copy does not look for a helper until somebody asks', async () => {
    const copy = load({ config: publishedSettings(), platform: true });

    const found = await copy.platform.local.detectLocalCapability({ force: true });

    assert.strictEqual(found, false, 'the answer is no');
    assert.deepStrictEqual(copy.calls, [], 'and nothing was asked of anybody to arrive at it');
    assert.strictEqual(copy.platform.capabilities().localHelper, 'disconnected');
});

test('somebody asking for the music on their device asks loopback for it', async () => {
    const copy = load({
        config: publishedSettings(),
        platform: true,
        fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    });

    const found = await copy.platform.requestLocalMusic();

    assert.strictEqual(found, true);
    assert.strictEqual(copy.calls.length, 1);
    assert.strictEqual(copy.calls[0], 'http://127.0.0.1:3000/api/library/health', 'the machine, not the host');
});

test('a published copy watches for a helper on no timer at all', () => {
    const copy = load({ config: publishedSettings(), platform: true });

    const stop = copy.platform.watch(() => {});

    assert.strictEqual(typeof stop, 'function', 'there is still something to unsubscribe');
    assert.deepStrictEqual(copy.timers, [], 'but nothing is scheduled');
    assert.deepStrictEqual(copy.calls, [], 'and nothing is asked');

    stop();

    // Watching on a schedule is what turned a page open beside no helper into
    // hundreds of requests to an address that was never going to answer.
    assert.deepStrictEqual(copy.calls, []);
});

test('a checkout still watches its own helper, on its own origin', async () => {
    const checkout = load({
        platform: true,
        fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    });

    await checkout.platform.local.detectLocalCapability({ force: true });

    assert.strictEqual(checkout.calls[0], '/api/library/health', 'the same origin the page came from');

    const stop = checkout.platform.watch(() => {});
    assert.ok(checkout.timers.length > 0, 'and it keeps looking');
    stop();
});

test('everything a published copy needs has an answer that is not an API call', () => {
    const client = source('js', 'catalogClient.js');
    const auth = source('js', 'auth.js');
    const platform = source('js', 'platform.js');

    // The catalogue comes from Supabase directly.
    assert.match(client, /CatalogClient\.prototype\._published = function/);
    assert.match(client, /if \(self\._published\(\)\) return self\._fromCloud\(kind\);/);

    // The local half answers itself: empty, rather than pending on a request
    // to an origin that will never answer it.
    assert.match(client, /if \(this\._published\(\)\) \{[\s\S]{0,400}albums: \[\],/);

    // Where somebody stopped listening stays on their own machine.
    assert.match(
        client,
        /if \(this\._published\(\)\) return Promise\.resolve\(\{ trackProgress: this\._localProgress\(\) \}\);/
    );

    // The settings are in the page before it loads, so nothing fetches them.
    assert.match(auth, /if \(deployment && deployment\.isPublished\(\)\) \{[\s\S]{0,400}deployment\.supabase\(\)/);

    // And the helper is asked for only when somebody asks for it.
    assert.match(platform, /deployment\.isPublished\(\) && !settings\.requested/);
    assert.match(platform, /Platform\.prototype\.requestLocalMusic = function/);
});

test('nothing in the browser builds an address out of the page it was served from', () => {
    const scripts = fs.readdirSync(path.join(ROOT, 'js')).filter((name) => /\.js$/.test(name) && name !== 'admin.js');

    scripts.forEach((name) => {
        const text = source('js', name);

        // location.origin joined to a path is the mistake this whole change
        // exists to undo: on a static host it names the static host.
        assert.ok(!/location\.origin\s*\+\s*['"]\/api/.test(text), name + ' builds an API address from the page');
        assert.ok(!/\$\{location\.origin\}\/api/.test(text), name + ' builds an API address from the page');
        assert.ok(!/\$\{window\.location\.origin\}\/api/.test(text), name + ' builds an API address from the page');
    });
});

// ============================================
// What a published copy is allowed to load
// ============================================

test('the fonts the pages ask for are named exactly, and nothing else is', () => {
    // Both halves say the same thing: the local server's own header, and the
    // one the build writes for a static host.
    [source('server.js'), source('tools', 'buildPublic.js')].forEach((text) => {
        assert.match(text, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
        assert.match(text, /font-src 'self' data: https:\/\/fonts\.gstatic\.com/);

        // The stylesheet comes from one host and the font files from another.
        // "any" for either would open far more than a typeface.
        assert.ok(!/style-src [^\n]*\*/.test(text), 'stylesheets do not come from anywhere');
        assert.ok(!/font-src [^\n]*\*/.test(text), 'nor do fonts');
    });
});

test('the helper answers pages it was told to trust, and no others', () => {
    const server = source('server.js');

    // This server holds somebody's music and can be told to search their
    // disks. Loopback keeps it off the network; this keeps it away from every
    // page that has not been named, published copy included.
    assert.match(server, /function allowedOrigins\(\)/);
    assert.match(server, /SPOTIFIE_ALLOWED_ORIGINS/);
    assert.match(server, /if \(!origin \|\| trustedOrigins\(\)\.indexOf\(origin\) === -1\) return \{\};/);

    // Never a wildcard - and one written in configuration is refused rather
    // than honoured.
    assert.ok(!/Allow-Origin['"]?\s*:\s*['"]\*/.test(server), 'never a wildcard');

    // An answer that differs by who asked must not be cached for everybody.
    assert.match(server, /Vary: 'Origin'/);
});

// ============================================
// A build that cannot work is a build that fails
// ============================================

test('a deploying build without its settings fails instead of shipping broken', () => {
    const out = path.join(os.tmpdir(), 'spotifie-release-public-mode-test');

    let failure = null;
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'tools', 'buildPublic.js')], {
            cwd: ROOT,
            stdio: 'pipe',
            encoding: 'utf8',
            env: Object.assign({}, process.env, {
                SPOTIFIE_RELEASE_OUT: out,
                WORKERS_CI: '1',
                SUPABASE_URL: '',
                SUPABASE_ANON_KEY: '',
                PUBLIC_SITE_URL: ''
            })
        });
    } catch (error) {
        failure = error;
    }

    // A broken deployment is worse than a failed build: the failure is seen by
    // whoever ran it, and the breakage by everybody else.
    assert.ok(failure, 'the build refused');
    assert.notStrictEqual(failure.status, 0);

    const said = String(failure.stderr || '') + String(failure.stdout || '');
    ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUBLIC_SITE_URL'].forEach((name) => {
        assert.ok(said.indexOf(name) !== -1, 'it names ' + name);
    });

    // The names are reported so somebody can act. The values never are.
    const builder = source('tools', 'buildPublic.js');
    assert.match(builder, /missing\.join\(', '\)/);
    assert.ok(!/console\.(log|warn|error)\((url|anonKey|siteUrl)\)/.test(builder), 'no value is printed');

    fs.rmSync(out, { recursive: true, force: true });
});

test('a build outside that builder says so and carries on', () => {
    // Somebody building locally to look at the result is not deploying, and
    // stopping them would help nobody.
    const out = path.join(os.tmpdir(), 'spotifie-release-public-mode-local');

    const built = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'buildPublic.js')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            SPOTIFIE_RELEASE_OUT: out,
            WORKERS_CI: '',
            SUPABASE_URL: '',
            SUPABASE_ANON_KEY: '',
            PUBLIC_SITE_URL: ''
        })
    });

    assert.strictEqual(built.status, 0, 'the build finished');
    assert.ok(fs.existsSync(path.join(out, 'index.html')), 'a release was built');

    // A warning is a warning wherever it is written.
    const said = String(built.stdout || '') + String(built.stderr || '');
    assert.ok(/SUPABASE_URL/.test(said), 'and it says what it was built without');

    // And what it wrote says it is not a published copy, so nothing reads it
    // as one and starts asking Supabase with no key.
    const script = fs.readFileSync(path.join(out, 'js', 'config.js'), 'utf8');
    assert.ok(!/"deployment": "cloudflare"/.test(script));

    fs.rmSync(out, { recursive: true, force: true });
});


// ============================================
// The covers a published copy shows, and keeps
// ============================================

/**
 * The regression these hold shut.
 *
 * A returning visit draws the library from the copy this device kept, before
 * Supabase is asked anything at all. The reader that signs an address for a
 * published cover knew where nothing was kept until the catalogue had been
 * read again - so every card on that first paint asked for a picture, was told
 * there was none, and showed the default one. The catalogue then came back
 * unchanged, nothing was redrawn, and a library of default covers stayed on
 * screen for the whole visit.
 *
 * Two things fix it and both are checked here: the paths come with the copy,
 * and the pictures themselves are kept under a name that does not change.
 */

const ARTWORK_PATH = 'albums/one/cover.jpg';
const OTHER_PATH = 'albums/one/cover-2.jpg';

/** A Supabase client that answers from rows, and counts what it was asked. */
function fakeSupabase(options) {
    const settings = options || {};
    const asked = { tables: [], signed: [] };

    return {
        asked: asked,
        from(table) {
            const query = {
                select(columns) {
                    asked.tables.push(table + ':' + columns);
                    return query;
                },
                order() {
                    return query;
                },
                then(resolve, reject) {
                    return Promise.resolve({ data: settings[table] || [], error: null }).then(resolve, reject);
                }
            };
            return query;
        },
        storage: {
            from(bucket) {
                return {
                    createSignedUrl(objectPath, seconds) {
                        asked.signed.push(bucket + '/' + objectPath);
                        return Promise.resolve({
                            data: {
                                signedUrl:
                                    'https://example.supabase.co/storage/v1/object/sign/' +
                                    bucket +
                                    '/' +
                                    objectPath +
                                    '?token=' +
                                    asked.signed.length
                            },
                            error: null
                        });
                    }
                };
            }
        }
    };
}

/** A store shaped like the browser's, kept in memory. */
function fakeCaches() {
    const held = new Map();

    const store = {
        held: held,
        match(key) {
            const found = held.get(String(key));
            return Promise.resolve(found ? found.response() : undefined);
        },
        put(key, response) {
            held.set(String(key), { response: () => response });
            return Promise.resolve();
        },
        keys() {
            return Promise.resolve(Array.from(held.keys()).map((url) => ({ url: url })));
        },
        delete(request) {
            held.delete(typeof request === 'string' ? request : request.url);
            return Promise.resolve(true);
        }
    };

    return { store: store, open: () => Promise.resolve(store) };
}

/** A picture, as a response the store can hold. */
function imageResponse(body) {
    return {
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        clone() {
            return imageResponse(body);
        },
        blob() {
            return Promise.resolve({ size: body.length, body: body });
        }
    };
}

/**
 * The catalogue client of a published copy, with the reader it uses and a
 * browser made of the few things they touch.
 */
function loadCatalogue(options) {
    const settings = options || {};
    const caches = settings.caches || fakeCaches();
    const supabase = settings.supabase || fakeSupabase({});
    const fetched = [];

    const sandbox = {
        console: { warn() {}, log() {}, error() {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Promise: Promise,
        Math: Math,
        Date: Date,
        Object: Object,
        Map: Map,
        Set: Set,
        Error: Error,
        String: String,
        Number: Number,
        Boolean: Boolean,
        JSON: JSON,
        encodeURIComponent: encodeURIComponent,
        decodeURIComponent: decodeURIComponent,
        caches: caches,
        URL: {
            createObjectURL: (blob) => 'blob:kept/' + (blob && blob.size),
            revokeObjectURL() {}
        },
        fetch(url) {
            fetched.push(String(url));
            const answer = settings.fetch ? settings.fetch(String(url)) : imageResponse('picture-bytes');
            return Promise.resolve(answer);
        },
        __SPOTIFIE_CONFIG__: publishedSettings()
    };

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.spotifieAuth = { tryGetClient: () => Promise.resolve(supabase) };

    vm.createContext(sandbox);
    vm.runInContext(DEPLOYMENT, sandbox);
    vm.runInContext(source('js', 'cloudCatalog.js'), sandbox);
    vm.runInContext(source('js', 'catalogClient.js'), sandbox);

    return {
        client: sandbox.spotifieCatalog,
        supabase: supabase,
        caches: caches,
        fetched: fetched,
        sandbox: sandbox
    };
}

/** One published album, as the copy on a device keeps it. */
function keptAlbum(extra) {
    return Object.assign(
        {
            id: 'global-album:one',
            source: 'global',
            title: 'Awaken',
            metadata: { hasArtwork: true, artworkVersion: 'v1', artworkPath: ARTWORK_PATH }
        },
        extra || {}
    );
}

test('a cover is signed from what the copy remembered, without reading the catalogue', async () => {
    const loaded = loadCatalogue();

    // What a returning visit has before it asks Supabase anything: the album,
    // and where its picture is kept.
    loaded.client.rememberArtworkPaths([keptAlbum()]);

    const url = await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });

    assert.match(url, /storage\/v1\/object\/sign\/catalog-artwork\/albums\/one\/cover\.jpg/);
    assert.deepStrictEqual(loaded.supabase.asked.tables, [], 'no table was read to find that out');
});

test('an album the copy said nothing about is asked after, not given up on', async () => {
    const loaded = loadCatalogue({
        supabase: fakeSupabase({
            catalog_albums: [{ id: 'one', artwork_path: ARTWORK_PATH }],
            catalog_tracks: []
        })
    });

    const url = await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });

    assert.match(url, /cover\.jpg/, 'the picture was found');
    assert.ok(
        loaded.supabase.asked.tables.some((asked) => asked.indexOf('artwork_path') !== -1),
        'by asking where it is'
    );

    // And asked once. A library of thirty cards is not thirty questions.
    const before = loaded.supabase.asked.tables.length;
    await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });
    assert.strictEqual(loaded.supabase.asked.tables.length, before);
});

test('a picture this device already has is painted without signing anything', async () => {
    const first = loadCatalogue();
    first.client.rememberArtworkPaths([keptAlbum()]);

    const signed = await first.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });
    assert.match(signed, /token=/, 'the first visit signs an address');

    // The picture at that address is kept, under a name made of the album and
    // which version of its cover this is.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const names = Array.from(first.caches.store.held.keys());
    assert.strictEqual(names.length, 1);
    assert.match(names[0], /global-album%3Aone\/v1$/, 'named by the album and the cover, not by the address');
    assert.ok(!/token=/.test(names[0]), 'and never by an address that expires');

    // The next visit finds it there and paints it without asking Supabase.
    const next = loadCatalogue({ caches: first.caches });
    next.client.rememberArtworkPaths([keptAlbum()]);

    const kept = await next.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });
    assert.match(kept, /^blob:/, 'the picture came from this device');
    assert.deepStrictEqual(next.supabase.asked.signed, [], 'nothing was signed for it');
});

test('a cover that has been replaced is fetched again, and the old one is dropped', async () => {
    const loaded = loadCatalogue();
    loaded.client.rememberArtworkPaths([keptAlbum()]);
    await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // An administrator replaces the cover: a different path, so a different
    // version, so a different name.
    loaded.client.rememberArtworkPaths([
        keptAlbum({ metadata: { hasArtwork: true, artworkVersion: 'v2', artworkPath: OTHER_PATH } })
    ]);

    const url = await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v2' });
    assert.match(url, /cover-2\.jpg/, 'the new cover is what gets signed');

    await new Promise((resolve) => setTimeout(resolve, 10));
    const names = Array.from(loaded.caches.store.held.keys());
    assert.strictEqual(names.length, 1, 'one cover an album, not one per version ever published');
    assert.match(names[0], /\/v2$/);
});

test('an address that expired is not handed back a second time', async () => {
    const loaded = loadCatalogue();
    loaded.client.rememberArtworkPaths([keptAlbum()]);

    const first = await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });

    // What the page does when a picture fails to load: forget the address that
    // failed, then ask again. Without the reader forgetting too, the same
    // expired address comes back and the retry fails the same way.
    loaded.client.forgetArtwork('global-album:one');

    const second = await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });
    assert.notStrictEqual(second, first, 'a fresh address');
    assert.strictEqual(loaded.supabase.asked.signed.length, 2, 'signed again rather than reused');
});

test('a picture that cannot be fetched changes nothing on screen', async () => {
    const loaded = loadCatalogue({
        fetch: () => {
            throw new Error('Failed to fetch');
        }
    });
    loaded.client.rememberArtworkPaths([keptAlbum()]);

    const url = await loaded.client.resolveArtworkUrl('global-album:one', { kind: 'album', version: 'v1' });

    assert.match(url, /token=/, 'the signed address is still what goes up');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(loaded.caches.store.held.size, 0, 'and nothing was kept');
});

test('the music on a device is asked of that device, never of the host', async () => {
    const loaded = loadCatalogue();

    await loaded.client.getDeviceScanStatus().catch(() => null);

    assert.strictEqual(loaded.fetched.length, 1);
    assert.strictEqual(loaded.fetched[0], 'http://127.0.0.1:3000/api/library/scan', 'the machine, not the host');
});

// ============================================
// A page always opens
// ============================================

/**
 * The worst thing a published copy did.
 *
 * A service worker answers navigation, and this one answered it from the
 * cache first and, when the cache had nothing and the network did not reply,
 * with a rejected response. Chrome renders that as ERR_FAILED: the site is
 * simply gone, and the way back is the Back button, which reaches the copy of
 * the page that is still in memory and makes the whole thing look intermittent.
 *
 * Two rules fix it and both are held here. A page is fetched before it is
 * remembered, and every path through opening a page ends in a real response.
 */

const WORKER = source('sw.js');

test('a page is asked of the network first, and answered whatever happens', () => {
    const opening = WORKER.slice(WORKER.indexOf('function openApplication'), WORKER.indexOf('function openCode'));

    // The network first. A document answered from a cache is how an
    // application ends up asking for scripts that a deploy has replaced.
    assert.ok(
        opening.indexOf('fetch(request)') < opening.indexOf('.match(request)'),
        'the network is asked before the cache'
    );

    // Then, in order, three answers - and all three are answers.
    assert.match(opening, /cached \|\| cache\.match\(APP_SHELL\)/);
    assert.match(opening, /cached \|\| offlinePage\(\)/);
    assert.ok(!/Response\.error\(\)/.test(opening), 'a page is never answered with a failure');
    assert.ok(!/return undefined|return null/.test(opening), 'nor with nothing at all');

    // A page, with a status that says what happened.
    assert.match(WORKER, /function offlinePage\(\)/);
    assert.match(WORKER, /status: 503/);
    assert.match(WORKER, /'Content-Type': 'text\/html; charset=utf-8'/);
});

test('navigation is handled before anything else the worker does', () => {
    const handler = WORKER.slice(WORKER.indexOf("self.addEventListener('fetch'"));

    // Anything privileged or personal is never this worker's to answer, and
    // that comes first of all: a navigation to the protected admin route is
    // decided live by the server on every visit and must reach the network
    // untouched, never a page this worker cached a moment access was allowed.
    const alwaysLive = handler.indexOf('isAlwaysLive(url)');
    const navigation = handler.indexOf("request.mode === 'navigate'");
    const audio = handler.indexOf('isAudio(url, request)');

    assert.ok(alwaysLive !== -1 && navigation !== -1 && audio !== -1, 'all three checks are present');
    assert.ok(alwaysLive < navigation, 'the privileged and personal bypass comes before pages');

    // And an ordinary page is still answered as a page, before any rule about
    // what may be cached can decide it: the navigation branch comes before the
    // audio and asset branches.
    assert.ok(navigation < audio, 'ordinary pages come before the caching rules');

    // And nothing that belongs to somebody else is touched: Supabase, the
    // fonts, the helper at its own address. A worker that answered those is a
    // worker that breaks signing in.
    assert.match(handler, /if \(url\.origin !== self\.location\.origin\) return;/);
    assert.match(WORKER, /url\.pathname\.startsWith\('\/api\/'\)/);
});

test('a new worker retires what the old one kept', () => {
    // The broken cache is on the machines of everybody who has opened the
    // site. Retiring it is the version, and taking over at once is what stops
    // a page from being answered by the old worker one more time.
    assert.match(WORKER, /const CACHE_VERSION = 'v6';/);
    assert.match(WORKER, /\.filter\(\(name\) => name\.startsWith\('spotifie-shell-'\) && name !== SHELL_CACHE\)/);
    assert.match(WORKER, /self\.skipWaiting\(\)/);
    assert.match(WORKER, /self\.clients\.claim\(\)/);

    // Neither install nor activate can fail in a way that leaves a worker
    // that never starts.
    const install = WORKER.slice(WORKER.indexOf("addEventListener('install'"), WORKER.indexOf("addEventListener('activate'"));
    const activate = WORKER.slice(WORKER.indexOf("addEventListener('activate'"), WORKER.indexOf('function openApplication'));
    assert.match(install, /\.catch\(/, 'a cache that will not open is not a worker that will not install');
    assert.match(activate, /\.catch\(/);
});

test('the application has one address, and it is the root', () => {
    const auth = source('js', 'auth.js');

    // Everything that sends somebody back into Spotifie sends them to the
    // same place. Two addresses for one page is two entries in a cache, two
    // in the history, and a Back button that lands on whichever was used.
    assert.match(auth, /function homeUrl\(\)/);
    assert.match(auth, /return siteUrlFor\('\/'\);/);
    assert.ok(!/'index\.html'/.test(auth), 'nothing in the session code names the file');

    // A published copy knows where it was published, so a link Supabase
    // sends by email comes back to the site rather than to the machine the
    // build happened on.
    assert.match(auth, /function siteOrigin\(\)/);
    assert.match(auth, /deployment\.siteUrl\(\)/);
    assert.match(auth, /emailRedirectTo: siteUrlFor\('\/signin\.html'\)/);
    assert.match(auth, /redirectTo: siteUrlFor\('\/reset-password\.html'\)/);
});

test('signing in and out lands on the application, not on a second copy of it', () => {
    ['signin.html', 'signup.html'].forEach((page) => {
        const text = source(page);
        assert.match(text, /auth\.homeUrl\(\) \|\| '\/'/, page + ' goes home');
        assert.match(text, /window\.location\.replace\(target\)/, page + ' replaces rather than pushes');
        assert.ok(!/location\.href = 'index\.html'/.test(text), page + ' does not name the file');
    });

    // Replaced rather than pushed: the page somebody has just signed in from
    // is not somewhere Back should take them, and it is the intermediate page
    // that made this look broken.
    const auth = source('js', 'auth.js');
    assert.match(auth, /global\.location\.replace\(homeUrl\(\)\)/);

    const manifest = JSON.parse(source('manifest.webmanifest'));
    assert.strictEqual(manifest.start_url, '/');
    assert.strictEqual(manifest.scope, '/');
});

// ============================================
// The music on this device, read by the browser
// ============================================

/**
 * The other half of what was broken: a published copy could not reach anybody's
 * own music at all.
 *
 * It looked for a Spotifie running on the machine, which almost nobody reading
 * a website has. What their browser does have - Chrome and Edge - is a picker
 * that hands a page one folder, chosen by the person reading, and that is what
 * this reads now.
 *
 * The line these hold: one folder somebody chose, never a device; the file
 * itself opened only to play it; and nothing about it sent anywhere.
 */

const LIBRARY = source('js', 'browserLibrary.js');

test('a folder is read only after somebody chooses it', () => {
    // The picker, and nothing that opens it on its own. A browser refuses any
    // other way, and the interface should not be trying.
    assert.match(LIBRARY, /\.showDirectoryPicker\(\{ id: 'spotifie-music', mode: 'read', startIn: 'music' \}\)/);

    const player = source('js', 'script.js');
    const opens = player.slice(player.indexOf('async function chooseMusicFolder()'), player.indexOf('/** Say when this device was last searched. */'));
    assert.match(opens, /library\.chooseFolder\(\)/);

    // Both ways of asking are clicks, and neither spends the click on
    // anything else first.
    const controls = player.slice(player.indexOf('function initDeviceScanControls()'), player.indexOf('/** Tell the platform what the music'));
    assert.match(controls, /deviceScanStart[\s\S]{0,1400}chooseMusicFolder\(\)/);
    assert.match(controls, /scanDeviceLink[\s\S]{0,1400}chooseMusicFolder\(\)/);
});

test('what a browser can do is what the interface offers', () => {
    const player = source('js', 'script.js');
    const label = player.slice(player.indexOf('function updateScanMenuLabel()'), player.indexOf('function updateScanMenuLabel()') + 1400);

    // A page cannot look through a device and this does not say it can.
    assert.match(label, /'Choose music folder'/);
    assert.match(label, /'Choose another music folder'/);
    assert.ok(
        label.indexOf('Choose music folder') < label.indexOf('Scan device for music'),
        'the honest wording is what a published copy shows'
    );
});

test('nothing is kept but a reference and a few words about each song', () => {
    // The handle the browser gave, which is worthless without the permission
    // that goes with it, and a short row per song. Never audio, never a
    // picture, and never an address that means something only in this page.
    assert.match(LIBRARY, /var DB_NAME = 'spotifie-device-library';/);
    assert.ok(!/base64|btoa|arrayBuffer\(\)\.then[\s\S]{0,80}put\(/.test(LIBRARY), 'no audio is written down');
    assert.ok(!/createObjectURL[\s\S]{0,200}(put|setItem)\(/.test(LIBRARY), 'and no address into memory is either');

    // An address for a song exists while it plays and is dropped when the
    // next one starts.
    assert.match(LIBRARY, /function releasePlaying\(\)/);
    assert.match(LIBRARY, /global\.URL\.revokeObjectURL\(playing\.url\)/);

    // And none of it goes anywhere: no upload, no Supabase, no network at all.
    // Read as code: the comments there say what this must never do, and
    // searching the prose for those words would find the promise rather than a
    // breach of it.
    const code = LIBRARY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/supabase|fetch\(|XMLHttpRequest|upload/i.test(code), 'nothing leaves this machine');
});

test('a song keeps its name between visits, and an unchanged one is not read again', () => {
    // The id is made of where the file is and how big it is, so a like or a
    // place in a playlist still points at the same song tomorrow. It is not a
    // fingerprint of the audio: reading every byte of a thousand files on
    // every refresh is minutes nobody has.
    assert.match(LIBRARY, /function trackIdFor\(folderId, path, size\)/);
    assert.match(LIBRARY, /return 'local:' \+ out;/);

    // A song whose name, size and modified time have not moved is the same
    // song, kept exactly as it was.
    assert.match(
        LIBRARY,
        /known\.size === real\.size &&\s*known\.lastModified === real\.lastModified/,
        'unchanged files are not opened again'
    );

    // And what is no longer in the folder is no longer in the library.
    assert.match(LIBRARY, /function writeFolder\(folder, rows\)/);
});

test('a folder that would need asking again is left alone, and its songs stay', () => {
    // Permission belongs to the browser and can be taken back at any time.
    // When it has been, the songs stay listed from what was written down and
    // the question waits for somebody to ask for their music - rather than a
    // prompt on every page load, or a library that empties itself.
    assert.match(LIBRARY, /function permissionFor\(folder\)/);
    assert.match(LIBRARY, /queryPermission\(\{ mode: 'read' \}\)/);

    const refresh = LIBRARY.slice(LIBRARY.indexOf('function refresh()'), LIBRARY.indexOf('function reconnect()'));
    assert.match(refresh, /if \(permission !== 'granted'\) \{[\s\S]{0,400}needsPermission \+= 1;/);
    assert.ok(!/requestPermission/.test(refresh), 'nothing asks by itself');

    const reconnect = LIBRARY.slice(LIBRARY.indexOf('function reconnect()'), LIBRARY.indexOf('function forget('));
    assert.match(reconnect, /requestPermission/);
});

test('a copy with no server reaches its own device without asking any host', () => {
    const client = source('js', 'catalogClient.js');

    // The local half of the library comes from the browser itself. No
    // request to the host the page came from, and none to a helper that is
    // usually not running.
    assert.match(client, /CatalogClient\.prototype\._browserLibrary = function/);
    assert.match(client, /window\.spotifieBrowserLibrary/);

    const local = client.slice(client.indexOf('CatalogClient.prototype.getLocalCatalog'), client.indexOf('CatalogClient.prototype.getArtists'));
    assert.match(local, /this\._browserLibrary\(\)/);
    assert.ok(!/fetch\(|_request\(url\)[\s\S]{0,40}published/.test(local.slice(0, local.indexOf('return this._shared'))), 'nothing is fetched for it');

    // And the two halves are joined the way a server joins them, so
    // everything that draws a library works the same either way.
    const cloud = client.slice(client.indexOf('CatalogClient.prototype._fromCloud'), client.indexOf('CatalogClient.prototype._cloudCatalogue'));
    assert.match(cloud, /here\.albums\.concat\(answer\.albums\)/);
    assert.match(cloud, /here\.tracks\.concat\(answer\.tracks\)/);
});

// ============================================
// Signing in ends somewhere
// ============================================

/**
 * "Sign in successful! Redirecting..." and then nothing, forever.
 *
 * The page asked the session code where the application was, a second later,
 * inside a timer - and when that answer was not there, the exception went
 * nowhere and the person was left reading a sentence about a redirect that was
 * never going to happen. A page newer than the script cached beside it is all
 * it took.
 *
 * So leaving is immediate, has an answer of its own to fall back on, and
 * happens once however many things ask for it.
 */

['signin.html', 'signup.html'].forEach((page) => {
    test('signing in from ' + page + ' always arrives somewhere', () => {
        const text = source(page);

        // One way out, and it knows where to go without being told.
        assert.match(text, /function goToApp\(\)/);
        assert.match(text, /let target = '\/';/, page + ' has an answer of its own');
        assert.match(text, /typeof auth\.homeUrl === \x27function\x27/);
        assert.match(text, /window\.location\.replace\(target\)/);

        // Once. The form and the session check both reach it, and two
        // navigations would leave a dead page in somebody\x27s history.
        assert.match(text, /if \(leavingForApp\) return;/);

        // And immediately: nothing is waited for that may already have
        // happened, and nothing is waited on forever.
        assert.ok(
            !/setTimeout\([\s\S]{0,80}location\.replace\(window\.spotifieAuth/.test(text),
            page + ' does not put the redirect behind a timer'
        );
        assert.match(text, /setTimeout\(\(\) => \{\s*if \(window\.location\.href !== target\)/);
    });
});

test('a page and the code it loads come from the same release', () => {
    // A new page beside an old script is what broke signing in: the page
    // called something the script did not have. Both are fetched, and the
    // cached copy is what a device with no network falls back on.
    assert.match(WORKER, /function openCode\(request\)/);
    assert.match(WORKER, /request\.destination === 'script' \|\| request\.destination === 'style'/);

    const code = WORKER.slice(WORKER.indexOf('function openCode'), WORKER.indexOf('function openAsset'));
    assert.ok(code.indexOf('fetch(request)') < code.indexOf('cache.match(request)'), 'the network first');

    // And a version that retires what the broken one kept.
    assert.match(WORKER, /const CACHE_VERSION = 'v6';/);
});

// ============================================
// Managing the folders somebody chose
// ============================================

/**
 * One model, in every part of the interface.
 *
 * On a published copy the music on this device is the folders somebody handed
 * over - not folders a helper found, and never both at once. The manager shows
 * those folders and the songs in them, rescanning means choosing a folder, and
 * checking for changes means looking again at what is already known.
 */

const PLAYER_SOURCE = source('js', 'script.js');

test('the manager reads this device the way the rest of the copy does', () => {
    const refresh = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function refreshLocalManager()'),
        PLAYER_SOURCE.indexOf('async function refreshBrowserManager()')
    );

    // The browser first, and no helper looked for before it - looking would
    // be a request to a machine that is usually not there, and the message
    // about Spotifie not running here answers a question nobody asked.
    const browser = refresh.indexOf('getBrowserLibrary()');
    const helper = refresh.indexOf('requestLocalMusic()');
    assert.ok(browser !== -1 && helper !== -1 && browser < helper, 'the browser is asked first');
    assert.match(refresh, /if \(getBrowserLibrary\(\)\) \{[\s\S]{0,120}refreshBrowserManager\(\);\s*return;/);
});

test('the manager lists the folders and their songs', () => {
    const manager = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function refreshBrowserManager()'),
        PLAYER_SOURCE.indexOf('function unavailableCollectionTracks()')
    );

    // Every folder chosen, with what it holds and when it was last read.
    assert.match(manager, /library\.folders\(\)/);
    assert.match(manager, /label: folder\.name/);
    assert.match(manager, /trackCount: folder\.trackCount/);
    assert.match(manager, /lastScanAt: folder\.lastScanAt/);
    assert.match(manager, /needsPermission: folder\.needsPermission/);

    // And every song from every one of them - the library the page is
    // already holding, which is the union of the managed folders.
    assert.match(manager, /source === 'local'/);
    assert.match(manager, /locationCount: folders\.length/);

    // A folder that would need asking again says so rather than vanishing.
    assert.match(PLAYER_SOURCE, /location\.needsPermission \? ' · needs reconnecting' : ''/);
});

test('rescanning asks which folder, and checking for changes does not', () => {
    const scan = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function runLocalScan(options)'),
        PLAYER_SOURCE.indexOf('async function cancelLocalScan()')
    );

    // Rescan: the picker, every time. A page cannot look anywhere it has
    // not been pointed at, and a button that quietly does nothing is worse
    // than one that asks.
    assert.match(scan, /if \(settings\.mode === 'full'\) \{\s*await rescanBrowserFolder\(\);/);
    const rescan = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function rescanBrowserFolder()'),
        PLAYER_SOURCE.indexOf('async function checkBrowserFolders()')
    );
    assert.match(rescan, /library\.chooseFolder\(\)/);

    // Check for changes: the folders already handed over, no picker.
    const check = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function checkBrowserFolders()'),
        PLAYER_SOURCE.indexOf('async function cancelLocalScan()')
    );
    assert.match(check, /library\.refresh\(\)/);
    assert.ok(!/chooseFolder\(\)/.test(check), 'nothing is asked for that was already given');
    assert.match(check, /needsPermission/);
});

test('forgetting a folder is done here, not asked of a server', () => {
    const forget = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function onLocalLocationClick(event)'),
        PLAYER_SOURCE.indexOf('function selectedLocalTracks()')
    );

    assert.match(forget, /library\.forget\(location\.id\)/);

    // The files themselves are never touched, and what somebody put in a
    // playlist stays in it.
    assert.match(forget, /No file on your device is deleted/);
});

test('a rescan of one folder leaves every other folder alone', () => {
    const scan = LIBRARY.slice(LIBRARY.indexOf('function scanFolder(folder)'), LIBRARY.indexOf('function refresh()'));

    // Only this folder\x27s rows are replaced. A song still there keeps the
    // name it had, one that has gone goes, and the other folders are not
    // part of the comparison at all.
    assert.match(scan, /row\.folderId !== folder\.id/);
    assert.match(scan, /added: added/);
    assert.match(scan, /removed: Math\.max\(0, existing\.length - \(rows\.length - added\)\)/);

    // And every song knows which folder it came out of, so it can leave
    // with that folder and be counted under it.
    assert.match(LIBRARY, /folderId: row\.folderId/);
    assert.match(LIBRARY, /folderName: folder \? folder\.name : null/);
});

// ============================================
// Who the database says you are
// ============================================

/**
 * An administrator signing in to the published copy saw no way to reach the
 * dashboard.
 *
 * Two things were wrong and both are held here. The build took the link out of
 * the page, so there was nothing to show however the question was answered.
 * And the question itself is worth asking carefully: it is answered by the
 * database, from the account's id, never from an address or an email or
 * anything a browser can write.
 */

const AUTH = source('js', 'auth.js');

test('being an administrator is something the database says, about an id', () => {
    const check = AUTH.slice(AUTH.indexOf('async function isAdmin(options)'), AUTH.indexOf('async function signUp('));

    // The function the database already has, asked about this session\x27s
    // own id - the same function every admin-only policy calls.
    assert.match(check, /client\.rpc\('is_admin', \{ uid: userId \}\)/);

    // And the account's own row as the second way, which is the one thing
    // the policy on that table lets it read.
    assert.match(check, /\.from\('app_admins'\)[\s\S]{0,160}\.eq\('user_id', userId\)/);

    // Never an email, never anything a browser could write for itself.
    assert.ok(!/email/i.test(check), 'no email decides this');
    assert.ok(!/localStorage|sessionStorage|location\.search|isAdmin=true/.test(check), 'and nothing a page holds');
});

test('an answer that never arrived is not remembered as a no', () => {
    const check = AUTH.slice(AUTH.indexOf('async function isAdmin(options)'), AUTH.indexOf('async function signUp('));

    // A session still settling is the usual reason, and it is worth exactly
    // one more attempt - never a loop.
    assert.match(check, /if \(verified === null\) \{[\s\S]{0,400}retried: true/);
    assert.match(check, /if \(settings\.retried\) \{[\s\S]{0,160}return false;/);

    // Only a real answer is kept, and only for the account it was about.
    assert.match(check, /adminAnswer = \{ userId: userId, verified: verified \};/);
    assert.match(AUTH, /if \(userId !== previousUserId\) adminAnswer = \{ userId: null, verified: null \};/);
});

test('the menu corrects itself when the answer arrives', () => {
    const render = AUTH.slice(AUTH.indexOf('async function renderAuthUI()'), AUTH.indexOf('function initAuthUI()'));

    // What is known goes up with the rest of the menu, and the menu is drawn
    // again when the answer arrives - no refresh, and nothing waiting on a
    // question before anything appears at all.
    assert.match(render, /applyAdminUI\(\);/);
    assert.match(render, /isAdmin\(\)[\s\S]{0,400}applyAdminUI\(\);/);

    // The item follows the answer this session has about the account this
    // session has, so an answer about somebody who has since signed out, or
    // been replaced, cannot put it on anybody else's menu.
    assert.match(
        AUTH,
        /const verified = Boolean\(user && adminAnswer\.userId === user\.id && adminAnswer\.verified === true\);/
    );

    // And the whole header is drawn again whenever the session changes, so
    // signing in and signing out both recalculate this.
    assert.match(AUTH, /notify\(event\);\s*renderAuthUI\(\);/);
});

test('the dashboard is held by the worker, not published as a file', () => {
    const build = source('tools', 'buildPublic.js');

    // The page is not in the list of static pages any more: it is written into
    // the worker instead, so no address serves it as a file.
    const pages = /const PAGES = \[([\s\S]*?)\];/.exec(build)[1];
    assert.ok(!/admin-dashboard\.html/.test(pages), 'the dashboard is not a published page');

    // Its script still is - the gated page loads it, and it carries no secret.
    assert.match(build, /'js\/admin\.js'/);

    // The build writes the document into the worker, and only when this copy
    // has it; a checkout without the private half writes a worker that serves
    // nothing and strips the link.
    assert.match(build, /const ADMIN_FILES = \['admin-dashboard\.html', 'js\/admin\.js'\];/);
    assert.match(build, /const dashboard = ADMIN_FILES\.every\(\(file\) => fs\.existsSync/);
    assert.match(build, /function writeAdminDocument\(present\)/);
    assert.match(build, /writeAdminDocument\(dashboard\)/);

    // What decides anything is still absent, so a released server has no
    // privileged route at all.
    ['adminAuth.js', 'adminCatalogRoutes.js', 'adminAlbumRoutes.js', 'admin-login.html'].forEach((name) => {
        assert.ok(build.indexOf("'" + name + "'") === -1, name + ' is not published');
    });
});

test('the worker gates the dashboard and holds no secret of its own', () => {
    const worker = source('worker', 'index.mjs');

    // The dashboard opens through the worker or not at all: a POST that grants
    // entry, and a GET that serves the held document.
    assert.match(worker, /\/api\/admin\/enter/);
    assert.match(worker, /pathname === '\/admin-dashboard'/);

    // The raw file address never opens it.
    assert.match(worker, /pathname === '\/admin-dashboard\.html'[\s\S]{0,120}notFound\(\)/);

    // Entry is granted only after Supabase confirms the caller is an
    // administrator - never from anything the browser sets for itself.
    assert.match(worker, /supabaseUser\(config, token\)/);
    assert.match(worker, /supabaseIsAdmin\(config, token, user\.id\)/);

    // And it is re-checked, live, on every visit to the page.
    const dashboard = worker.slice(worker.indexOf('async function handleDashboard'), worker.indexOf('function backToApp'));
    assert.match(dashboard, /supabaseUser\(config, token\)/);
    assert.match(dashboard, /supabaseIsAdmin\(config, token, user\.id\)/);

    // The cookie it sets is not readable by script, is confined to the
    // dashboard route, and is short-lived.
    assert.match(worker, /HttpOnly/);
    assert.match(worker, /SameSite=Strict/);
    assert.match(worker, /Path=\/admin-dashboard/);
    assert.match(worker, /ENTRY_MAX_AGE/);

    // No secret of its own: it reads the two public Supabase values from the
    // config the build wrote, and signs nothing with a private key.
    assert.match(worker, /publicConfig\(env, url\)/);
    assert.ok(!/service_role|sb_secret_|JWT_SECRET|SIGNING/i.test(worker), 'the worker holds no secret');
});

test('the dashboard decides nothing on its own', () => {
    const admin = source('js', 'admin.js');

    // It asks for a session and for administrator rights before it shows
    // anything, and sends everybody else back to the application.
    assert.match(admin, /requireSession|isAdmin\(\)/);
    assert.match(admin, /redirectToHome/);

    // And it names no page that a published copy does not have.
    assert.ok(!/admin-login\.html/.test(admin), 'nothing points at a page that is not published');
});


/**
 * The session code, running, with a database that answers.
 *
 * The parts of this that could go wrong are all timing and all invisible from
 * the outside: an answer that arrives after the menu is drawn, an answer about
 * an account that has since been replaced, a question asked again on every
 * render. So it is run rather than read - a real session, a real answer, and
 * the menu inspected afterwards.
 */

/** A page with the few elements the header touches. */
function fakeHeaderPage() {
    const made = new Map();

    const element = (id) => ({
        id: id,
        style: { display: '' },
        textContent: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        contains: () => false,
        querySelectorAll: () => [],
        appendChild() {},
        append() {},
        replaceChildren() {}
    });

    ['dashboardLink', 'userMenuBtn', 'userDropdown', 'authSkeleton', 'userName', 'libraryTitle'].forEach((id) => {
        made.set(id, element(id));
    });

    return {
        elements: made,
        createElement: (tag) => element(tag),
        createTextNode: (text) => ({ text: text }),
        getElementById: (id) => made.get(id) || null,
        querySelector: (selector) => {
            const match = /#([A-Za-z]+)/.exec(selector);
            return match ? made.get(match[1]) || null : null;
        },
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {}
    };
}

/** Supabase, as far as this file is concerned. */
function fakeSessionDatabase(options) {
    const settings = options || {};
    const asked = [];
    let listener = null;

    const answer = (value) => Promise.resolve(value);

    const client = {
        asked: asked,
        currentUserId: () => (settings.session && settings.session.user ? settings.session.user.id : null),
        signIn(session) {
            settings.session = session;
            if (listener) listener(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
        },
        auth: {
            getSession: () => answer({ data: { session: settings.session || null } }),
            onAuthStateChange(handler) {
                listener = handler;
                return { data: { subscription: { unsubscribe() {} } } };
            }
        },
        rpc(name, args) {
            asked.push(name + (args ? '(' + Object.keys(args).join(',') + ')' : '()'));
            const reply = settings.rpc ? settings.rpc(name, args) : null;
            if (reply) return answer(reply);
            return answer({ data: null, error: { message: 'Could not find the function' } });
        },
        from(table) {
            const query = {
                select() {
                    return query;
                },
                eq() {
                    return query;
                },
                upsert() {
                    return query;
                },
                insert() {
                    return query;
                },
                update() {
                    return query;
                },
                then(resolve) {
                    return Promise.resolve({ data: null, error: null }).then(resolve);
                },
                maybeSingle() {
                    asked.push(table + ' row');
                    if (table === 'app_admins') {
                        return answer(settings.row || { data: null, error: null });
                    }
                    return answer({ data: null, error: null });
                }
            };
            return query;
        }
    };

    return client;
}

/** The session module, running against that. */
function loadAuth(options) {
    const settings = options || {};
    const client = settings.client || fakeSessionDatabase({});
    const logs = [];

    const sandbox = {
        console: {
            info: (...parts) => logs.push(parts.join(' ')),
            warn: () => {},
            error: () => {},
            log: () => {}
        },
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout: clearTimeout,
        Promise: Promise,
        Object: Object,
        JSON: JSON,
        Set: Set,
        Map: Map,
        Boolean: Boolean,
        String: String,
        Error: Error,
        Date: Date,
        URL: URL,
        localStorage: {
            store: new Map(),
            getItem(key) {
                return this.store.has(key) ? this.store.get(key) : null;
            },
            setItem(key, value) {
                this.store.set(key, value);
            },
            removeItem(key) {
                this.store.delete(key);
            }
        },
        document: settings.document,
        supabase: { createClient: () => client },
        __SPOTIFIE_CONFIG__: publishedSettings()
    };

    sandbox.sessionStorage = sandbox.localStorage;
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.location = { origin: 'https://spotifie.example', href: 'https://spotifie.example/' };

    vm.createContext(sandbox);
    vm.runInContext(DEPLOYMENT, sandbox);
    vm.runInContext(AUTH, sandbox);

    return { auth: sandbox.spotifieAuth, client: client, logs: logs, sandbox: sandbox };
}

const ADMIN_SESSION = { user: { id: 'admin-0001', email: 'someone@example.test', user_metadata: { username: 'Someone' } } };
const LISTENER_SESSION = { user: { id: 'listener-0002', email: 'other@example.test', user_metadata: { username: 'Other' } } };

test('an administrator gets the item, and it does not wait for a refresh', async () => {
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({
        session: ADMIN_SESSION,
        rpc: (name, args) => (name === 'is_admin' && !args ? { data: true, error: null } : null)
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'flex', 'the item is there');

    // Asked the narrowest question there is: about whoever is calling, with no
    // id to ask about anybody else and nothing but true or false coming back.
    assert.ok(client.asked.indexOf('is_admin()') !== -1, 'the narrowest question was the one asked');
    assert.ok(client.asked.indexOf('is_admin(uid)') === -1, 'and once it answered, nothing else was');

    // And said what happened, in the safe diagnostic shape: the session, the
    // account id, the answer the database gave, and the decision - never a
    // token, a key or anything that could be used to sign in.
    assert.ok(loaded.logs.some((line) => line === '[admin] session: yes'), 'the session is reported');
    assert.ok(loaded.logs.some((line) => line === '[admin] uid: admin-0001'), 'the account is reported');
    assert.ok(loaded.logs.some((line) => line === '[admin] rpc data: true (is_admin())'), 'the answer is reported');
    assert.ok(loaded.logs.some((line) => line === '[admin] verifiedAdmin: true'), 'the decision is reported');
    assert.ok(loaded.logs.some((line) => line === '[admin] menu rerender'), 'the rerender is reported');
    assert.ok(!loaded.logs.some((line) => /token|apikey|Bearer|eyJ/i.test(line)), 'and nothing that could be used');
});

test('an ordinary account never sees it', async () => {
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({
        session: LISTENER_SESSION,
        rpc: (name, args) => (name === 'is_admin' && !args ? { data: false, error: null } : null)
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'none');
    assert.strictEqual(await loaded.auth.isAdmin(), false);
});

test('a project without the newer function is asked the older way', async () => {
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({
        session: ADMIN_SESSION,
        // The function that takes no argument does not exist here yet.
        rpc: (name, args) => (args && args.uid === 'admin-0001' ? { data: true, error: null } : null)
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const admin = client.asked.filter((what) => what.indexOf('is_admin') === 0);
    assert.deepStrictEqual(admin, ['is_admin()', 'is_admin(uid)']);
    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'flex', 'and the answer is the same');
});

test('a project with neither is asked for the one row it may read', async () => {
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({
        session: ADMIN_SESSION,
        rpc: () => null,
        row: { data: { user_id: 'admin-0001' }, error: null }
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tried = client.asked.filter((what) => what.indexOf('is_admin') === 0 || what === 'app_admins row');
    assert.deepStrictEqual(tried, ['is_admin()', 'is_admin(uid)', 'app_admins row']);
    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'flex');
});

test('the answer is asked once, and again for the next account', async () => {
    const page = fakeHeaderPage();

    // A database that answers about whoever is asking, which is the whole
    // point of the question having no argument.
    const client = fakeSessionDatabase({
        session: ADMIN_SESSION,
        rpc: (name, args) => {
            if (name !== 'is_admin' || args) return null;
            return { data: client.currentUserId() === ADMIN_SESSION.user.id, error: null };
        }
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const asked = client.asked.filter((what) => what.indexOf('is_admin') === 0).length;

    // Drawing the header again reads what is known rather than asking again.
    await loaded.auth.renderAuthUI();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(client.asked.filter((what) => what.indexOf('is_admin') === 0).length, asked, 'nothing is asked twice');
    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'flex');

    // Somebody else signing in is a different question, and the item goes
    // until the database says otherwise about them.
    client.signIn(LISTENER_SESSION);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(client.asked.filter((what) => what.indexOf('is_admin') === 0).length > asked, 'the new account is asked about');
    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'none');
});

test('signing out takes it away', async () => {
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({
        session: ADMIN_SESSION,
        rpc: (name, args) => (name === 'is_admin' && !args ? { data: true, error: null } : null)
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'flex');

    client.signIn(null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'none');
    assert.strictEqual(await loaded.auth.isAdmin(), false);
});

test('a session restored after the first render brings the item in, without a refresh', async () => {
    // The order incognito actually produces: the page renders before Supabase
    // has restored the session, so the header is drawn signed-out, and the
    // session (and the admin answer) arrive a moment later. The item must
    // appear then, on its own.
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({
        session: null,
        rpc: (name, args) => (name === 'is_admin' && !args ? { data: true, error: null } : null)
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'none', 'signed out at first');

    // Supabase restores the session and announces it, exactly as it does on a
    // real load once storage has been read.
    client.signIn(ADMIN_SESSION);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'flex', 'and the item arrives on its own');
});

test('a guest never sees the item', async () => {
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({ session: null });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'none');
    assert.strictEqual(await loaded.auth.isAdmin(), false);
});

test('the diagnostics say what happened and never a token', async () => {
    // The failure was impossible to see from outside, so the worker of last
    // resort is a clear line in the console. These are the lines, and the one
    // thing that must never be among them.
    const page = fakeHeaderPage();
    const client = fakeSessionDatabase({
        session: ADMIN_SESSION,
        // The zero-argument function is missing, as on a database that has not
        // had the current schema applied; the fallback by id answers.
        rpc: (name, args) => {
            if (name !== 'is_admin') return null;
            if (!args) return { data: null, error: { message: 'Could not find the function public.is_admin' } };
            return { data: args.uid === 'admin-0001', error: null };
        }
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(loaded.logs.some((line) => line === '[admin] session: yes'));
    assert.ok(loaded.logs.some((line) => line === '[admin] uid: admin-0001'));
    assert.ok(loaded.logs.some((line) => /^\[admin\] rpc error: is_admin\(\):/.test(line)), 'the missing function is named');
    assert.ok(loaded.logs.some((line) => line === '[admin] rpc data: true (is_admin(uid))'), 'the fallback answered');
    assert.ok(loaded.logs.some((line) => line === '[admin] verifiedAdmin: true'));
    assert.ok(!loaded.logs.some((line) => /token|apikey|Bearer|eyJ|access_token/i.test(line)), 'never a token');

    assert.strictEqual(page.elements.get('dashboardLink').style.display, 'flex');
});

test('the menu item is the Admin Dashboard, in order, opened through enterAdmin', () => {
    const index = source('index.html');
    const auth = source('js', 'auth.js');

    // The item is a menu button - the same kind as its neighbours, not a link -
    // named as it should be, marked with a stable action hook, and hidden until
    // the database says the account is an administrator.
    const button = /<button[^>]*id="dashboardLink"[^>]*>[\s\S]*?<\/button>/.exec(index);
    assert.ok(button, 'the item is in the menu');
    assert.match(button[0], /class="[^"]*admin-link/);
    assert.match(button[0], /data-action="admin-dashboard"/);
    assert.match(button[0], /style="display: none;"/);
    assert.match(button[0], /Admin Dashboard/);

    // Never a raw navigation: no href to the dashboard address, which the
    // worker would only bounce.
    assert.ok(!/id="dashboardLink"[^>]*href=/.test(index), 'the item is not a link');

    // In order: after the account's own things, before Log out.
    const dashboardAt = index.indexOf('id="dashboardLink"');
    const logoutAt = index.indexOf('id="logoutBtn"');
    assert.ok(dashboardAt !== -1 && logoutAt !== -1 && dashboardAt < logoutAt, 'the item sits above Log out');

    // The click is handed to enterAdmin - the entry flow - wherever the item
    // came from: the static one is wired, and one the code has to create is
    // wired when it is made.
    assert.match(auth, /function wireDashboardItem\(item\)/);
    assert.match(auth, /function ensureDashboardItem\(\)/);

    const wire = auth.slice(auth.indexOf('function wireDashboardItem'), auth.indexOf('function applyAdminUI'));
    assert.match(wire, /addEventListener\('click'/);
    assert.match(wire, /e\.preventDefault\(\);/);
    assert.match(wire, /enterAdmin\(\);/);
});

test('the item is put into the visible menu, not just shown or hidden', () => {
    const auth = source('js', 'auth.js');

    // The bug this closes: showing a static element that a stale page never
    // carried, so nothing appeared. Now the item is ensured inside the real
    // dropdown for a verified administrator, created there if it is missing.
    const apply = auth.slice(auth.indexOf('function applyAdminUI()'), auth.indexOf('function initAuthUI()'));
    assert.match(apply, /const item = verified \? ensureDashboardItem\(\) : findDashboardItem\(\);/);

    const ensure = auth.slice(auth.indexOf('function ensureDashboardItem()'), auth.indexOf('function wireDashboardItem'));
    assert.match(ensure, /document\.getElementById\('userDropdown'\)/, 'into the visible dropdown');
    assert.match(ensure, /document\.createElement\('button'\)/, 'made when it is missing');
    assert.match(ensure, /data-action', 'admin-dashboard'/);
    assert.match(ensure, /getElementById\('logoutBtn'\)/, 'placed above Log out');

    // Driven by the one canonical answer, not a second admin flag.
    assert.match(apply, /adminAnswer\.userId === user\.id && adminAnswer\.verified === true/);
});

test('the built release carries the current admin JS, byte for byte', () => {
    // The failure this rules out: a release that shipped an older auth.js than
    // the working copy, so the fix was in the source and never in production.
    const out = path.join(os.tmpdir(), 'spotifie-release-admin-js-test');

    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'buildPublic.js')], {
        cwd: ROOT,
        stdio: 'ignore',
        env: Object.assign({}, process.env, {
            SPOTIFIE_RELEASE_OUT: out,
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_ANON_KEY: 'public-anon-placeholder',
            PUBLIC_SITE_URL: 'https://spotifie.example'
        })
    });

    const builtAuth = fs.readFileSync(path.join(out, 'js', 'auth.js'), 'utf8');
    assert.strictEqual(builtAuth, source('js', 'auth.js'), 'the release ships this auth.js, not an older one');

    // And it is the code that decides and shows the item.
    assert.match(builtAuth, /client\.rpc\('is_admin'\)/, 'the admin RPC is in the release');
    assert.match(builtAuth, /function enterAdmin\(\)/, 'the entry flow is in the release');
    assert.match(builtAuth, /function applyAdminUI\(\)/, 'the menu update is in the release');
    assert.match(builtAuth, /\[admin\] verifiedAdmin/, 'the diagnostics are in the release');

    const builtIndex = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(builtIndex, /id="dashboardLink"/);
    assert.match(builtIndex, /Admin Dashboard/);

    fs.rmSync(out, { recursive: true, force: true });
});

/** A menu with no admin item in it yet, rich enough for one to be made. */
function menuDocument() {
    const all = [];

    function element(tag) {
        const el = {
            tagName: String(tag || '').toUpperCase(),
            style: { display: '' },
            dataset: {},
            children: [],
            parentNode: null,
            previousElementSibling: null,
            _attrs: {},
            classList: {
                _set: new Set(),
                add(name) {
                    this._set.add(name);
                },
                remove(name) {
                    this._set.delete(name);
                },
                contains(name) {
                    return this._set.has(name);
                },
                toggle(name) {
                    if (this._set.has(name)) this._set.delete(name);
                    else this._set.add(name);
                    return this._set.has(name);
                }
            },
            setAttribute(name, value) {
                this._attrs[name] = value;
                if (name === 'class') {
                    String(value)
                        .split(/\s+/)
                        .forEach((c) => c && this.classList.add(c));
                }
            },
            getAttribute(name) {
                return name in this._attrs ? this._attrs[name] : null;
            },
            addEventListener() {},
            insertBefore(node, before) {
                node.parentNode = this;
                const at = this.children.indexOf(before);
                if (at === -1) this.children.push(node);
                else this.children.splice(at, 0, node);
                return node;
            },
            appendChild(node) {
                node.parentNode = this;
                this.children.push(node);
                return node;
            },
            set className(value) {
                this._attrs.class = value;
                String(value)
                    .split(/\s+/)
                    .forEach((c) => c && this.classList.add(c));
            },
            get className() {
                return this._attrs.class || '';
            }
        };
        all.push(el);
        return el;
    }

    const made = new Map();
    ['userMenu', 'userDropdown', 'userMenuBtn', 'userName', 'libraryTitle', 'authSkeleton', 'logoutBtn'].forEach(
        (id) => {
            const el = element('div');
            el.id = id;
            made.set(id, el);
            all.push(el);
        }
    );

    // The logout button sits inside the dropdown; the item must land above it.
    made.get('logoutBtn').parentNode = made.get('userDropdown');
    made.get('userDropdown').children.push(made.get('logoutBtn'));

    return {
        elements: made,
        createElement: element,
        getElementById: (id) => made.get(id) || all.filter((el) => el.id === id)[0] || null,
        querySelector: (selector) => {
            const byId = /#([A-Za-z][\w-]*)/.exec(selector);
            if (byId) return made.get(byId[1]) || null;
            const byAction = /\[data-action="([^"]+)"\]/.exec(selector);
            if (byAction) return all.filter((el) => el.getAttribute('data-action') === byAction[1])[0] || null;
            return null;
        },
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {}
    };
}

test('a verified administrator has the item made inside the visible dropdown', async () => {
    const page = menuDocument();
    const client = fakeSessionDatabase({
        session: ADMIN_SESSION,
        rpc: (name, args) => (name === 'is_admin' && !args ? { data: true, error: null } : null)
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const item = page.getElementById('dashboardLink');
    assert.ok(item, 'the item was created');
    assert.strictEqual(item.parentNode, page.getElementById('userDropdown'), 'inside the real dropdown');
    assert.strictEqual(item.getAttribute('data-action'), 'admin-dashboard');
    assert.strictEqual(item.style.display, 'flex', 'and shown');

    // Above Log out.
    const children = page.getElementById('userDropdown').children;
    assert.ok(children.indexOf(item) < children.indexOf(page.getElementById('logoutBtn')), 'above Log out');
});

test('an ordinary account has no item made in the visible dropdown', async () => {
    const page = menuDocument();
    const client = fakeSessionDatabase({
        session: LISTENER_SESSION,
        rpc: (name, args) => (name === 'is_admin' && !args ? { data: false, error: null } : null)
    });

    const loaded = loadAuth({ document: page, client: client });
    await loaded.auth.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(page.getElementById('dashboardLink'), null, 'nothing was created for a non-administrator');
});

test('a published copy reads no personal library over the network', () => {
    const fetched = [];
    const sandbox = {
        console: { warn() {}, log() {}, info() {}, error() {} },
        Promise: Promise,
        Object: Object,
        Set: Set,
        Array: Array,
        Boolean: Boolean,
        JSON: JSON,
        Error: Error,
        fetch: (url) => {
            fetched.push(String(url));
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        },
        __SPOTIFIE_CONFIG__: publishedSettings()
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(DEPLOYMENT, sandbox);
    vm.runInContext(source('js', 'personalClient.js'), sandbox);

    const personal = new sandbox.PersonalClient();

    return personal.load().then((result) => {
        assert.strictEqual(result, personal, 'load resolves rather than rejecting');
        assert.strictEqual(personal.loaded, true, 'and settles into a state');
        assert.strictEqual(personal.signedIn, false, 'the empty, signed-out library');
        assert.deepStrictEqual(fetched, [], 'and asked the origin for nothing - no /api/catalog/me');

        // A like on a published copy touches no network either, so nothing 404s.
        return personal.toggleLike('global:track').catch(() => {}).then(() => {
            assert.deepStrictEqual(fetched, [], 'a like asked the origin for nothing');
        });
    });
});

test('the database answers this about the caller, and says nothing else', () => {
    const sql = source('supabase-setup.sql');

    // No argument, so nobody can ask about anybody but themselves, and the
    // answer is one boolean - the administrator list is not readable through
    // it in any shape.
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.is_admin\(\)\s*\nRETURNS BOOLEAN/);
    assert.match(sql, /SELECT EXISTS \(SELECT 1 FROM public\.app_admins a WHERE a\.user_id = auth\.uid\(\)\);/);

    // Callable by a signed-in account, and by nobody else.
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.is_admin\(\) FROM public;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.is_admin\(\) TO authenticated;/);

    // The table underneath is untouched: one row readable by the account it
    // belongs to, and no write of any kind from a browser.
    assert.match(sql, /USING \(auth\.uid\(\) = user_id\);/);
    assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON public\.app_admins FROM anon, authenticated;/);
});
