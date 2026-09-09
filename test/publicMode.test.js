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
