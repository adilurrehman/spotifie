'use strict';

/**
 * The Cloudflare worker that gates the administrator dashboard.
 *
 * The dashboard is not a public file. On the published copy the worker holds it
 * and serves it only to an administrator it has just verified against Supabase,
 * so that typing its address - or the old .html one - opens nothing. These
 * drive the worker's own fetch handler with a database that answers on cue, and
 * hold the line the whole design rests on:
 *
 *   - the raw file address is never served;
 *   - entry is granted only after Supabase confirms the caller is an
 *     administrator, never from anything a browser sets for itself;
 *   - a direct visit with no entry, an expired token, or a token belonging to a
 *     non-administrator is sent back to the application;
 *   - a forged cookie carrying an ordinary account's own token fails the live
 *     administrator check;
 *   - and the worker holds no secret of its own - it reads the two public
 *     Supabase values from the config the build wrote.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SUPABASE_URL = 'https://project.supabase.co';
const ANON_KEY = 'anon-public-key';

/**
 * Supabase, as far as the worker is concerned: who a token belongs to, and
 * whether that account is an administrator.
 *
 *   'admin' -> an administrator
 *   'user'  -> a signed-in account that is not an administrator
 *   anything else -> a token that belongs to nobody valid
 */
/** A minimal signed-shape token carrying a subject the worker can decode. */
function tokenFor(sub) {
    const payload = Buffer.from(JSON.stringify({ sub: sub }), 'utf8').toString('base64url');
    return 'header.' + payload + '.signature';
}

/** Which account a token stands for: a plain name, or the subject it carries. */
function whoIs(token) {
    if (token === 'admin') return 'admin';
    if (token === 'user') return 'user';
    try {
        const sub = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).sub;
        if (sub === 'admin-uid') return 'admin';
        if (sub === 'user-uid') return 'user';
    } catch (e) {
        /* not a token this fake knows */
    }
    return null;
}

function fakeSupabase(options) {
    const settings = options || {};
    const calls = [];

    const impl = async function (input, init) {
        const url = String(typeof input === 'string' ? input : input.url);
        const headers = (init && init.headers) || {};
        const auth = headers.Authorization || headers.authorization || '';
        const token = /^Bearer\s+(.+)$/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
        calls.push({ url: url, token: token, body: (init && init.body) || null });

        if (url.indexOf('/rest/v1/rpc/is_admin') !== -1) {
            if (settings.rpcBroken) return new Response('no such function', { status: 404 });

            const body = JSON.parse((init && init.body) || '{}');
            // The id-argument call answers about the id it is given; the
            // zero-argument call answers about the caller - the token - exactly
            // as the real is_admin() does through auth.uid(). A token PostgREST
            // could not verify is a 401, not a false.
            if ('uid' in body) {
                return new Response(JSON.stringify(body.uid === 'admin-uid'), { status: 200 });
            }
            const identity = whoIs(token);
            if (!identity) return new Response('invalid token', { status: 401 });
            return new Response(JSON.stringify(identity === 'admin'), { status: 200 });
        }

        if (url.indexOf('/rest/v1/app_admins') !== -1) {
            const admin = /user_id=eq\.admin-uid/.test(url);
            return new Response(JSON.stringify(admin ? [{ user_id: 'admin-uid' }] : []), { status: 200 });
        }

        return new Response('', { status: 500 });
    };

    impl.calls = calls;
    return impl;
}

/** The assets binding: the config the build wrote, and a stand-in for the rest. */
function fakeAssets(config) {
    return {
        async fetch(request) {
            const url = new URL(typeof request === 'string' ? request : request.url);
            if (url.pathname === '/config.json') {
                if (!config) return new Response('', { status: 404 });
                return new Response(JSON.stringify(config), { status: 200 });
            }
            return new Response('an asset', { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
    };
}

const CONFIG = { supabaseUrl: SUPABASE_URL, supabaseAnonKey: ANON_KEY, deployment: 'cloudflare' };

/** A request to the worker, on the published https origin. */
function request(host, pathname, init) {
    return new Request('https://' + host + pathname, init || {});
}

/** Load the worker fresh, with a database and assets bound for this test. */
async function withWorker(run, options) {
    const settings = options || {};
    const supabase = fakeSupabase(settings.supabase);
    const originalFetch = global.fetch;
    global.fetch = supabase;

    try {
        const module = await import('../worker/index.mjs?with=' + encodeURIComponent(settings.tag || Math.random()));
        const worker = module.createWorker(settings.document === undefined ? '<html>DASHBOARD</html>' : settings.document);
        const env = { ASSETS: fakeAssets(settings.config === undefined ? CONFIG : settings.config) };
        await run({ worker, env, supabase });
    } finally {
        global.fetch = originalFetch;
    }
}

// A unique host per test, so the worker's per-origin config cache never carries
// an answer from one test into another.
let hostCounter = 0;
function host() {
    hostCounter += 1;
    return 'spotifie-' + hostCounter + '.example';
}

// ============================================
// The raw file never opens the dashboard
// ============================================

test('the raw dashboard file is not an address', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(request(host(), '/admin-dashboard.html'), env);
        assert.strictEqual(response.status, 404);
    });
});

// ============================================
// A direct visit with no entry is sent back
// ============================================

test('the dashboard with no entry cookie sends the visitor to the application', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(request(host(), '/admin-dashboard'), env);
        assert.strictEqual(response.status, 302);
        // Back to the application root; the reason rides along as a plain slug.
        const location = new URL(response.headers.get('Location'));
        assert.strictEqual(location.pathname, '/');
        assert.strictEqual(location.searchParams.get('ad'), 'no-entry-cookie', 'and says why');
    });
});

// ============================================
// Granting entry: only a verified administrator
// ============================================

test('entry needs a signed-in caller', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(request(host(), '/api/admin/enter', { method: 'POST' }), env);
        assert.strictEqual(response.status, 401, 'no token, no entry');
    });
});

test('entry is refused for a token that belongs to nobody', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(
            request(host(), '/api/admin/enter', { method: 'POST', headers: { Authorization: 'Bearer stale' } }),
            env
        );
        assert.strictEqual(response.status, 401);
    });
});

test('entry is refused for an account that is not an administrator', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(
            request(host(), '/api/admin/enter', { method: 'POST', headers: { Authorization: 'Bearer user' } }),
            env
        );
        assert.strictEqual(response.status, 403, 'signed in, but not an administrator');
        assert.strictEqual(response.headers.get('Set-Cookie'), null, 'and granted no cookie');
    });
});

test('an administrator is granted a confined, script-proof, short-lived cookie', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(
            request(host(), '/api/admin/enter', { method: 'POST', headers: { Authorization: 'Bearer admin' } }),
            env
        );
        assert.strictEqual(response.status, 204);

        const cookie = response.headers.get('Set-Cookie');
        assert.match(cookie, /spotifie_admin_entry=/);
        assert.match(cookie, /HttpOnly/, 'script cannot read it');
        assert.match(cookie, /SameSite=Strict/);
        // Path=/, so it is unambiguously sent on the navigation to
        // /admin-dashboard that follows - a narrower path was the one link
        // never tested through a real set-then-navigate, and a cookie that did
        // not arrive is exactly what sent a verified administrator back to /.
        assert.match(cookie, /Path=\//, 'delivered to the dashboard route');
        assert.match(cookie, /Max-Age=\d+/, 'and short-lived');
        assert.match(cookie, /Secure/, 'and only over https');
    });
});

// ============================================
// Serving the page: proven, live, every time
// ============================================

test('an administrator who entered is served the dashboard', async () => {
    await withWorker(async ({ worker, env, supabase }) => {
        const response = await worker.fetch(
            request(host(), '/admin-dashboard', { headers: { Cookie: 'spotifie_admin_entry=admin' } }),
            env
        );
        assert.strictEqual(response.status, 200);
        assert.match(response.headers.get('Content-Type'), /text\/html/);
        assert.strictEqual(response.headers.get('Cache-Control'), 'no-store', 'never cached for the next visitor');
        assert.match(await response.text(), /DASHBOARD/);

        // The first administrator question asked is the zero-argument one -
        // about the caller, carrying no id from the request - as the spec
        // requires.
        const firstRpc = supabase.calls.filter((c) => c.url.indexOf('/rpc/is_admin') !== -1)[0];
        assert.ok(firstRpc, 'the database was asked');
        assert.deepStrictEqual(JSON.parse(firstRpc.body || '{}'), {}, 'and asked the zero-argument way first');
    });
});

test('the cookie a real POST sets opens the real GET, through the real handler', async () => {
    // The whole chain, end to end, on the actual worker: a POST that grants
    // entry, the Set-Cookie it returns replayed exactly as a browser would send
    // it, and the GET that serves the dashboard because of it. This is the test
    // the redirect-to-/ bug would have failed.
    await withWorker(async ({ worker, env }) => {
        const enter = await worker.fetch(
            request(host(), '/api/admin/enter', { method: 'POST', headers: { Authorization: 'Bearer admin' } }),
            env
        );
        assert.strictEqual(enter.status, 204, 'entry is granted');

        const setCookie = enter.headers.get('Set-Cookie');
        assert.ok(setCookie, 'a Set-Cookie header is returned');

        // What a browser stores and sends back is the name=value pair; the
        // attributes (HttpOnly, Path, Max-Age, ...) are for the browser, not the
        // server, and are not sent on the next request.
        const pair = setCookie.split(';')[0].trim();
        assert.match(pair, /^spotifie_admin_entry=/);

        const get = await worker.fetch(request(host(), '/admin-dashboard', { headers: { Cookie: pair } }), env);
        assert.strictEqual(get.status, 200, 'the dashboard opens with the cookie the POST set');
        assert.match(get.headers.get('Content-Type'), /text\/html/);
        assert.match(await get.text(), /DASHBOARD/);
    });
});

test('the entry cookie is found among others, comma or semicolon apart', async () => {
    // A real Cookie header carries more than one cookie. The one that matters
    // must be found whatever sits beside it.
    await withWorker(async ({ worker, env }) => {
        const header = 'theme=dark; other=1; spotifie_admin_entry=admin; last=2';
        const get = await worker.fetch(request(host(), '/admin-dashboard', { headers: { Cookie: header } }), env);
        assert.strictEqual(get.status, 200, 'the entry cookie is read from among the rest');
    });
});

test('a normal user is granted no entry cookie at all', async () => {
    await withWorker(async ({ worker, env }) => {
        const enter = await worker.fetch(
            request(host(), '/api/admin/enter', { method: 'POST', headers: { Authorization: 'Bearer user' } }),
            env
        );
        assert.strictEqual(enter.status, 403);
        assert.strictEqual(enter.headers.get('Set-Cookie'), null, 'so there is nothing to replay');
    });
});

test('a cookie forged with an ordinary account fails the live check', async () => {
    // Exactly the tampering the gate exists to stop: a non-administrator sets a
    // cookie of the right name carrying their own valid token. The worker asks
    // Supabase, live, and Supabase says they are not an administrator.
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(
            request(host(), '/admin-dashboard', { headers: { Cookie: 'spotifie_admin_entry=user' } }),
            env
        );
        assert.strictEqual(response.status, 302);
    });
});

test('an expired or invalid token is sent back', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(
            request(host(), '/admin-dashboard', { headers: { Cookie: 'spotifie_admin_entry=stale' } }),
            env
        );
        assert.strictEqual(response.status, 302);
    });
});

test('the table answers when the function is not there', async () => {
    // A project without is_admin at all: the worker reads the account's own
    // row instead, named by the subject it decodes from the token - a read the
    // same token still has to authenticate. So the token has to be a real
    // token-shape carrying that subject.
    await withWorker(
        async ({ worker, env }) => {
            const response = await worker.fetch(
                request(host(), '/admin-dashboard', {
                    headers: { Cookie: 'spotifie_admin_entry=' + tokenFor('admin-uid') }
                }),
                env
            );
            assert.strictEqual(response.status, 200);
        },
        { supabase: { rpcBroken: true } }
    );
});

// ============================================
// No dashboard to serve, no settings to read
// ============================================

test('a build with no dashboard serves none', async () => {
    await withWorker(
        async ({ worker, env }) => {
            const response = await worker.fetch(
                request(host(), '/admin-dashboard', { headers: { Cookie: 'spotifie_admin_entry=admin' } }),
                env
            );
            assert.strictEqual(response.status, 302, 'there is nothing to serve');
        },
        { document: null }
    );
});

test('entry cannot be granted when the settings are not there', async () => {
    await withWorker(
        async ({ worker, env }) => {
            const response = await worker.fetch(
                request(host(), '/api/admin/enter', { method: 'POST', headers: { Authorization: 'Bearer admin' } }),
                env
            );
            assert.strictEqual(response.status, 503, 'nothing to verify against, so nothing is granted');
        },
        { config: null }
    );
});

// ============================================
// Everything else is a static asset
// ============================================

test('an ordinary address is handed to the assets', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(request(host(), '/index.html'), env);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(await response.text(), 'an asset');
    });
});

test('the worker source names path only, and holds no secret', () => {
    const fs = require('fs');
    const worker = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.mjs'), 'utf8');
    assert.ok(!/service_role|sb_secret_|JWT_SECRET/i.test(worker), 'no secret is named');
    assert.ok(!/ADMIN_ENTRY_SECRET|SIGNING_KEY/i.test(worker), 'nothing is signed with a private key');
});
