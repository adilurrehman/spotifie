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
function fakeSupabase(options) {
    const settings = options || {};
    const calls = [];

    return async function (input, init) {
        const url = String(typeof input === 'string' ? input : input.url);
        const headers = (init && init.headers) || {};
        const auth = headers.Authorization || headers.authorization || '';
        const token = /^Bearer\s+(.+)$/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
        calls.push({ url: url, token: token });

        const identity = { admin: 'admin-uid', user: 'user-uid' };

        if (url.indexOf('/auth/v1/user') !== -1) {
            const id = identity[token];
            if (!id) return new Response('', { status: 401 });
            return new Response(JSON.stringify({ id: id }), { status: 200 });
        }

        if (url.indexOf('/rest/v1/rpc/is_admin') !== -1) {
            if (settings.rpcBroken) return new Response('no such function', { status: 404 });
            const body = JSON.parse((init && init.body) || '{}');
            return new Response(JSON.stringify(body.uid === 'admin-uid'), { status: 200 });
        }

        if (url.indexOf('/rest/v1/app_admins') !== -1) {
            const admin = /user_id=eq\.admin-uid/.test(url);
            return new Response(JSON.stringify(admin ? [{ user_id: 'admin-uid' }] : []), { status: 200 });
        }

        return new Response('', { status: 500 });
    };
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
        assert.match(response.headers.get('Location'), /\/$/);
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
        assert.match(cookie, /Path=\/admin-dashboard/, 'confined to the dashboard route');
        assert.match(cookie, /Max-Age=\d+/, 'and short-lived');
        assert.match(cookie, /Secure/, 'and only over https');
    });
});

// ============================================
// Serving the page: proven, live, every time
// ============================================

test('an administrator who entered is served the dashboard', async () => {
    await withWorker(async ({ worker, env }) => {
        const response = await worker.fetch(
            request(host(), '/admin-dashboard', { headers: { Cookie: 'spotifie_admin_entry=admin' } }),
            env
        );
        assert.strictEqual(response.status, 200);
        assert.match(response.headers.get('Content-Type'), /text\/html/);
        assert.strictEqual(response.headers.get('Cache-Control'), 'no-store', 'never cached for the next visitor');
        assert.match(await response.text(), /DASHBOARD/);
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
    // Older projects have is_admin(uid) but not the argumentless one; the worker
    // falls back to the account's own row, which its policy lets it read.
    await withWorker(
        async ({ worker, env }) => {
            const response = await worker.fetch(
                request(host(), '/admin-dashboard', { headers: { Cookie: 'spotifie_admin_entry=admin' } }),
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
