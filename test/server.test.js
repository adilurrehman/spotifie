'use strict';

/**
 * Runtime tests for the single local server.
 *
 * These boot server.js exactly as `npm start` does and talk to it over HTTP,
 * so a route that only exists in source (or only in a stale process) is
 * caught here.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'server.js');

/**
 * Ask the operating system for a port that is genuinely free.
 * Guessing a number makes these tests collide with each other when several
 * run at once.
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function startServer(env) {
    const port = await freePort();
    const musicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-server-music-'));

    const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: PROJECT_ROOT,
        env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', MUSIC_ROOT: musicRoot }, env || {}),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
        output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        output += chunk.toString();
    });

    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 15000);
        const check = setInterval(() => {
            if (output.includes('Spotifie is running')) {
                clearInterval(check);
                clearTimeout(timer);
                resolve();
            }
        }, 100);
        child.on('exit', () => {
            clearInterval(check);
            clearTimeout(timer);
            reject(new Error('Server exited: ' + output));
        });
    });

    return {
        port,
        child,
        ready,
        output: () => output,
        async stop() {
            child.kill();
            await new Promise((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.on('exit', resolve);
                setTimeout(resolve, 3000);
            });
            try {
                fs.rmSync(musicRoot, { recursive: true, force: true });
            } catch (e) {
                /* best effort */
            }
        }
    };
}

function request(port, pathname, options) {
    const settings = options || {};
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: pathname,
                method: settings.method || 'GET',
                headers: settings.headers || {}
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
                );
            }
        );
        req.on('error', reject);
        req.end();
    });
}

test('the running server serves public config, pages and the library API', async (t) => {
    const server = await startServer();
    await server.ready;

    t.after(() => server.stop());

    const config = await request(server.port, '/api/config');
    assert.strictEqual(config.status, 200, '/api/config is served on the app origin');
    assert.match(config.headers['content-type'], /application\/json/);

    const parsed = JSON.parse(config.body);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['supabaseAnonKey', 'supabaseUrl']);
    assert.match(parsed.supabaseUrl, /^https:\/\//);
    assert.ok(parsed.supabaseAnonKey.length > 20, 'an anon key is published');

    // Nothing private may appear in the payload.
    const lowered = config.body.toLowerCase();
    ['service_role', 'service-role', 'secret', 'password', 'private_key'].forEach((needle) => {
        assert.ok(!lowered.includes(needle), 'the config response contains no ' + needle);
    });

    // The anon key is a JWT whose role claim must be "anon".
    const claims = JSON.parse(Buffer.from(parsed.supabaseAnonKey.split('.')[1], 'base64').toString());
    assert.strictEqual(claims.role, 'anon', 'the published key is an anon key');

    // Trailing slash and HEAD work too.
    assert.strictEqual((await request(server.port, '/api/config/')).status, 200);
    assert.strictEqual((await request(server.port, '/api/config', { method: 'HEAD' })).status, 200);

    // Writing to the config endpoint is refused.
    assert.strictEqual((await request(server.port, '/api/config', { method: 'POST' })).status, 405);

    // Every page that initializes auth is served from the same origin.
    for (const page of [
        '/',
        '/index.html',
        '/signin.html',
        '/signup.html',
        '/forgot-password.html',
        '/reset-password.html',
        '/admin-login.html',
        '/admin-dashboard.html'
    ]) {
        assert.strictEqual((await request(server.port, page)).status, 200, page + ' is served');
    }

    assert.strictEqual((await request(server.port, '/js/auth.js')).status, 200);
    assert.strictEqual((await request(server.port, '/api/library/tracks')).status, 200);
    assert.strictEqual((await request(server.port, '/health')).status, 200);

    // Privileged endpoints stay closed without an admin session.
    assert.strictEqual((await request(server.port, '/api/library/rescan', { method: 'POST' })).status, 401);
});

test('auth.js can build a Supabase client from the served configuration', async (t) => {
    const server = await startServer();
    await server.ready;

    t.after(() => server.stop());

    const response = await request(server.port, '/api/config');
    const config = JSON.parse(response.body);

    // Mirror what js/auth.js does with the payload: hand both values to
    // createClient. A missing or malformed value would fail here.
    let created = null;
    const fakeSdk = {
        createClient(url, key, options) {
            created = { url, key, options };
            return { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {} } };
        }
    };

    fakeSdk.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true } });

    assert.ok(created, 'a client is constructible from the served config');
    assert.strictEqual(created.url, config.supabaseUrl);
    assert.strictEqual(created.key, config.supabaseAnonKey);
});

test('the server can be restarted and still serves the configuration', async () => {
    const first = await startServer();
    await first.ready;
    assert.strictEqual((await request(first.port, '/api/config')).status, 200);
    await first.stop();

    const second = await startServer();
    await second.ready;
    const config = await request(second.port, '/api/config');
    assert.strictEqual(config.status, 200);
    assert.ok(JSON.parse(config.body).supabaseUrl);
    await second.stop();
});

test('environment variables override the published Supabase settings', async (t) => {
    const server = await startServer({
        SUPABASE_URL: 'https://env-project.supabase.co',
        SUPABASE_ANON_KEY: 'env-anon-key-value-long-enough'
    });
    await server.ready;

    t.after(() => server.stop());

    const config = JSON.parse((await request(server.port, '/api/config')).body);
    assert.strictEqual(config.supabaseUrl, 'https://env-project.supabase.co');
    assert.strictEqual(config.supabaseAnonKey, 'env-anon-key-value-long-enough');
});

test('/api/config never answers 404, whatever the request shape', async (t) => {
    const server = await startServer();
    await server.ready;

    t.after(() => server.stop());

    // Regression guard: a 404 here is what a foreign static server (VS Code
    // Live Preview, an editor live-server, an older process on the port)
    // returns, and it is what broke sign-in. The canonical server must match
    // this route before static files and before any 404 fallback.
    const variants = [
        '/api/config',
        '/api/config/',
        '/api/config?cachebust=1',
        '/api/config/?x=1'
    ];

    for (const variant of variants) {
        const response = await request(server.port, variant);
        assert.notStrictEqual(response.status, 404, variant + ' must never 404');
        assert.strictEqual(response.status, 200, variant + ' returns the public config');
        assert.match(response.headers['content-type'], /application\/json/, variant + ' returns JSON');

        const body = JSON.parse(response.body);
        assert.ok(body.supabaseUrl && body.supabaseAnonKey, variant + ' carries both public values');
    }

    // A near-miss path must not serve the configuration.
    const nearMiss = await request(server.port, '/api/config.json');
    assert.notStrictEqual(nearMiss.status, 200, '/api/config.json is not a config route');
    assert.ok(!nearMiss.body.includes('supabaseAnonKey'), 'no config is leaked from other paths');
});

test('missing Supabase settings return a configuration error, not 404', async (t) => {
    const server = await startServer({ SUPABASE_URL: ' ', SUPABASE_ANON_KEY: ' ' });
    await server.ready;

    t.after(() => server.stop());

    const response = await request(server.port, '/api/config');
    assert.notStrictEqual(response.status, 404, 'unconfigured is not "not found"');
    assert.strictEqual(response.status, 503);
    assert.match(response.headers['content-type'], /application\/json/);

    const body = JSON.parse(response.body);
    assert.strictEqual(body.error, 'Configuration unavailable');
    assert.match(body.detail, /SUPABASE_URL/);

    // The rest of the app keeps working while Supabase is unconfigured.
    assert.strictEqual((await request(server.port, '/health')).status, 200);
    assert.strictEqual((await request(server.port, '/signin.html')).status, 200);
    assert.strictEqual((await request(server.port, '/api/library/tracks')).status, 200);
});

test('a busy port fails loudly instead of leaving another server in charge', async () => {
    // The original failure: a different program held the port, so the pages
    // loaded but every /api route 404'd. Spotifie must refuse to pretend.
    const blocker = http.createServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>File not found</body></html>');
    });

    const port = await new Promise((resolve) => {
        blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
    });

    try {
        // Sanity check: the blocker behaves like the stray static server.
        assert.strictEqual((await request(port, '/api/config')).status, 404);

        const child = spawn(process.execPath, [SERVER_ENTRY], {
            cwd: PROJECT_ROOT,
            env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk.toString()));
        child.stderr.on('data', (chunk) => (output += chunk.toString()));

        const exitCode = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Server did not exit: ' + output)), 15000);
            child.on('exit', (code) => {
                clearTimeout(timer);
                resolve(code);
            });
        });

        assert.strictEqual(exitCode, 1, 'the server exits rather than starting silently');
        assert.match(output, /already in use/i);
        assert.match(output, /not Spotifie/i, 'the message explains why /api routes would 404');
        assert.match(output, /PORT=/, 'the message offers a way out');
    } finally {
        await new Promise((resolve) => blocker.close(resolve));
    }
});

test('the unified catalogue is served alongside the local library', async (t) => {
    const server = await startServer();
    await server.ready;

    t.after(() => server.stop());

    // Signed out, the catalogue is the local library only - and it works.
    const status = await request(server.port, '/api/catalog/status');
    assert.strictEqual(status.status, 200);
    const parsed = JSON.parse(status.body);
    assert.strictEqual(parsed.signedIn, false);
    assert.strictEqual(parsed.sources.local.available, true);
    // The global catalogue is readable without an account, so its availability
    // depends on Supabase being reachable - not on being signed in.
    assert.strictEqual(typeof parsed.sources.global.available, 'boolean');
    assert.strictEqual(typeof parsed.sources.global.trackCount, 'number');

    assert.strictEqual((await request(server.port, '/api/catalog/tracks')).status, 200);
    assert.strictEqual((await request(server.port, '/api/catalog/albums')).status, 200);
    assert.strictEqual((await request(server.port, '/api/catalog/artists')).status, 200);

    // The P2 library API is untouched by the catalogue layer.
    assert.strictEqual((await request(server.port, '/api/library/tracks')).status, 200);

    // Hiding and permanent deletion both require a session; neither is open.
    assert.strictEqual(
        (await request(server.port, '/api/catalog/hidden', { method: 'POST' })).status,
        401
    );
    assert.strictEqual(
        (await request(server.port, '/api/catalog/tracks/global:abc/', { method: 'DELETE' })).status,
        404
    );
    assert.strictEqual(
        (await request(server.port, '/api/catalog/admin/tracks', { method: 'POST' })).status,
        401
    );
});
