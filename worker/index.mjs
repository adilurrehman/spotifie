/**
 * The Cloudflare entry in front of Spotifie's static assets.
 *
 * Almost everything Spotifie publishes is a static file, and Cloudflare serves
 * those directly - the assets layer answers a request that matches a file
 * before this worker is ever consulted. So this worker sees only what is not a
 * file: the two addresses that must be decided rather than served, and the
 * occasional genuine 404, which it hands straight back to the assets layer.
 *
 * The two it decides are the administrator dashboard.
 *
 * The dashboard page is not a public file. It is held inside this worker and
 * served only to an administrator who has just proven it, so that typing its
 * address - or guessing at the old .html one - opens nothing. That is access
 * control for the page shell, and no more than that: the page carries no
 * secret, and every privileged thing done inside it is authorised again by
 * Supabase's row-level policies against the app_admins table, which is where
 * the real protection has always been and stays. A visible dashboard changes
 * nothing a browser is allowed to write.
 *
 * How the proof works, without this worker holding any secret of its own:
 *
 *   POST /api/admin/enter carries the caller's Supabase access token. The
 *   worker asks Supabase who that token belongs to and whether that account is
 *   an administrator - the same two questions the database answers for anyone,
 *   with only the public anon key, which this worker reads from the config the
 *   build already wrote beside the assets. An administrator gets a short-lived,
 *   HttpOnly cookie scoped to the dashboard route; nobody else gets anything.
 *
 *   GET /admin-dashboard re-asks those same two questions about the token in
 *   that cookie, live, on every visit. A cookie somebody forged with their own
 *   token fails the administrator check; an expired token fails the identity
 *   check; a missing cookie is simply not an administrator. Any of those is
 *   answered by sending the visitor back to the application. Only a live,
 *   still-valid administrator is served the page.
 *
 * Nothing here is signed with a private key, because nothing here needs to be:
 * the authority is re-derived from Supabase each time rather than trusted from
 * a token this worker minted. The cookie is a convenience that carries the
 * proof between the two requests, not the proof itself.
 */

import ADMIN_DOCUMENT from './generated/adminDocument.mjs';

const ENTRY_COOKIE = 'spotifie_admin_entry';

// Long enough to open the dashboard and work in it, short enough that a shared
// or forgotten browser does not stay a way in. The Supabase token in the
// cookie has its own, shorter life on top of this.
const ENTRY_MAX_AGE = 15 * 60;

/**
 * The worker, bound to the dashboard document it serves.
 *
 * Production binds the document the build wrote (see the default export). The
 * factory exists so a test can bind a known document - or none - and drive the
 * same routing and the same gate without a build in the loop.
 */
export function createWorker(documentOverride) {
    const document = documentOverride === undefined ? ADMIN_DOCUMENT : documentOverride;
    return {
        fetch(request, env) {
            return route(request, env, document);
        }
    };
}

export default createWorker();

async function route(request, env, document) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // The raw dashboard file is never an address. It is not among the published
    // assets either, so this only makes the intent explicit and catches a
    // request that guessed at the old name.
    if (pathname === '/admin-dashboard.html' || pathname === '/admin-dashboard.html/') {
        return notFound();
    }

    if (pathname === '/api/admin/enter') {
        if (request.method !== 'POST') return methodNotAllowed(['POST']);
        return handleEnter(request, env, url);
    }

    if (pathname === '/admin-dashboard' || pathname === '/admin-dashboard/') {
        return handleDashboard(request, env, url, document);
    }

    // Everything else is a static asset, or a genuine miss the assets layer
    // answers as one.
    return env.ASSETS.fetch(request);
}

// ============================================
// Granting entry
// ============================================

/**
 * Verify the caller is an administrator and, if so, hand back a short-lived
 * entry cookie. Verified against Supabase, never against anything the browser
 * can set for itself.
 */
async function handleEnter(request, env, url) {
    note('[admin-worker] enter request');

    const token = bearerToken(request.headers.get('Authorization'));
    note('[admin-worker] bearer present: ' + (token ? 'yes' : 'no'));
    if (!token) return json({ error: 'not-signed-in' }, 401);

    const config = await publicConfig(env, url);
    if (!config) {
        note('[admin-worker] denied: settings unavailable');
        return json({ error: 'unconfigured' }, 503);
    }

    const admin = await adminFromToken(config, token);
    note('[admin-worker] is_admin: ' + admin);
    if (admin === null) return json({ error: 'not-signed-in' }, 401);
    if (admin !== true) {
        note('[admin-worker] denied: not an administrator');
        return json({ error: 'not-an-administrator' }, 403);
    }

    note('[admin-worker] issuing cookie');
    note('[admin-worker] response status: 204');
    return new Response(null, {
        status: 204,
        headers: {
            'Set-Cookie': entryCookie(token, url),
            'Cache-Control': 'no-store'
        }
    });
}

// ============================================
// Serving the dashboard, or sending the visitor away
// ============================================

async function handleDashboard(request, env, url, document) {
    note('[admin-route] request');

    // A checkout built without the private half carries no dashboard to serve.
    if (!document) return backToApp(url, 'no dashboard here');

    const token = cookieValue(request.headers.get('Cookie'), ENTRY_COOKIE);
    note('[admin-route] entry cookie present: ' + (token ? 'yes' : 'no'));
    if (!token) return backToApp(url, 'no entry cookie');

    const config = await publicConfig(env, url);
    if (!config) return backToApp(url, 'settings unavailable');

    // Re-derived live, every time: an entry cookie is only ever as good as the
    // account it still belongs to. One question - the database verifies the
    // token and answers whether it is an administrator's.
    const admin = await adminFromToken(config, token);
    note('[admin-route] is_admin: ' + admin);
    if (admin === null) return backToApp(url, 'token not valid');
    if (admin !== true) return backToApp(url, 'not an administrator');

    note('[admin-route] serving dashboard');
    return new Response(document, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            // An authorised page is never cached: the next visitor must be
            // proven again rather than handed what this one was shown.
            'Cache-Control': 'no-store',
            'Content-Security-Policy': dashboardCsp(config),
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Cross-Origin-Opener-Policy': 'same-origin'
        }
    });
}

/**
 * Back to the application, and take the entry cookie with you.
 *
 * A visitor who is not (or is no longer) an administrator has no use for the
 * cookie, and clearing it here means an expired one does not sit in the browser
 * being re-checked on every navigation.
 */
function backToApp(url, reason) {
    note('[admin-route] denied: ' + (reason || 'not allowed'));

    // The reason travels back in the address as a plain slug - no token, no
    // secret - so the application can say in the console why the dashboard did
    // not open, rather than the visitor only finding themselves back at the
    // start with no explanation.
    const home = new URL('/', url);
    if (reason) home.searchParams.set('ad', String(reason).replace(/[^a-z0-9 ]/gi, '').trim().replace(/\s+/g, '-').slice(0, 40));

    return new Response(null, {
        status: 302,
        headers: {
            Location: home.toString(),
            'Set-Cookie': clearedCookie(url),
            'Cache-Control': 'no-store'
        }
    });
}

/**
 * A safe line for the log. What was asked and what was decided - never a
 * token, never a cookie value, never a secret. Visible with `wrangler tail`
 * and in the observability that wrangler.jsonc turns on.
 */
function note(message) {
    try {
        console.log(message);
    } catch (e) {
        /* a worker that cannot log still answers */
    }
}

// ============================================
// Asking Supabase the one question that matters
// ============================================

/**
 * Is the account this token belongs to an administrator? true, false, or null.
 *
 * One question, asked of the one thing that both proves who the caller is and
 * whether they are an administrator: the database, under the caller's own
 * token. PostgREST verifies that token's signature and expiry itself and sets
 * auth.uid() from it, so is_admin() - which reads auth.uid() - is asked about a
 * proven identity, not one this worker took on trust.
 *
 * There is deliberately no separate call to the auth user endpoint. That
 * endpoint reads differently under the newer publishable keys, and a worker
 * that gated on it would turn away an administrator whose token it could not
 * read there even though the same token authorises everything at PostgREST.
 * The authorisation lives where it is enforced.
 *
 *   true  - a valid token belonging to an administrator.
 *   false - a valid token belonging to somebody who is not one.
 *   null  - no usable answer: the token was rejected, or the database could not
 *           be reached. Treated as "not allowed", and, for entry, as "sign in".
 */
async function adminFromToken(config, token) {
    const headers = {
        apikey: config.supabaseAnonKey,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
    };

    // is_admin() - about auth.uid(), so nothing the request carries says who is
    // being asked about.
    const viaFunction = await rpcBoolean(config.supabaseUrl + '/rest/v1/rpc/is_admin', headers, {});
    if (viaFunction !== null) return viaFunction;

    // Fallback for a project that only has the older is_admin(uid): the id from
    // the token, and the account's own row, which its policy lets it read and
    // nobody else's. The read is still authenticated by the same token, so an
    // id the token does not own reads nothing.
    const uid = jwtSubject(token);
    if (!uid) return null;

    const byId = await rpcBoolean(config.supabaseUrl + '/rest/v1/rpc/is_admin', headers, { uid: uid });
    if (byId !== null) return byId;

    try {
        const row = await fetch(
            config.supabaseUrl + '/rest/v1/app_admins?select=user_id&user_id=eq.' + encodeURIComponent(uid),
            { headers: headers }
        );
        if (!row.ok) return null;

        const rows = await row.json();
        return Array.isArray(rows) && rows.length > 0;
    } catch (e) {
        return null;
    }
}

/** Call an is_admin RPC and read a plain boolean, or null when it could not. */
async function rpcBoolean(endpoint, headers, body) {
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
        });
        if (!response.ok) return null;

        const answer = await response.json();
        return answer === true;
    } catch (e) {
        return null;
    }
}

/**
 * The account id inside a Supabase token, read without trusting it.
 *
 * Only used to name the row the account then reads for itself - a read the
 * token still has to authenticate at PostgREST, which is where the signature is
 * checked. So this reads the claim, it does not rely on it: a forged id names a
 * row the forger cannot read.
 */
function jwtSubject(token) {
    try {
        const payload = String(token).split('.')[1];
        if (!payload) return null;
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        const claims = JSON.parse(json);
        return claims && claims.sub ? String(claims.sub) : null;
    } catch (e) {
        return null;
    }
}

// ============================================
// The public settings, read from what the build already wrote
// ============================================

const configByOrigin = new Map();

/**
 * The two public Supabase values, taken from the config.json the build wrote
 * beside the assets.
 *
 * The same file the browser reads, and the same two values - the project URL
 * and the anon key, both public by design. This worker holds no Supabase
 * settings of its own and no secret at all; it reuses what is already there.
 */
async function publicConfig(env, url) {
    const origin = url.origin;
    if (configByOrigin.has(origin)) return configByOrigin.get(origin);

    let config = null;
    try {
        const response = await env.ASSETS.fetch(new Request(new URL('/config.json', url)));
        if (response.ok) {
            const settings = await response.json();
            if (settings && settings.supabaseUrl && settings.supabaseAnonKey) {
                config = {
                    supabaseUrl: String(settings.supabaseUrl).replace(/\/+$/, ''),
                    supabaseAnonKey: String(settings.supabaseAnonKey)
                };
            }
        }
    } catch (e) {
        config = null;
    }

    configByOrigin.set(origin, config);
    return config;
}

/** What the served dashboard is allowed to load. */
function dashboardCsp(config) {
    let origin = '';
    try {
        origin = new URL(config.supabaseUrl).origin;
    } catch (e) {
        origin = '';
    }
    const socket = origin.replace(/^https:/, 'wss:');

    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        ["img-src 'self'", origin, 'data:', 'blob:', 'https://ui-avatars.com'].filter(Boolean).join(' '),
        ["media-src 'self'", origin, 'blob:'].filter(Boolean).join(' '),
        ["connect-src 'self'", origin, socket].filter(Boolean).join(' '),
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');
}

// ============================================
// Small HTTP helpers
// ============================================

function bearerToken(header) {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
}

/** Read one cookie by name from a Cookie header. */
function cookieValue(header, name) {
    if (!header) return null;
    const parts = header.split(';');
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            return decodeURIComponent(part.slice(eq + 1).trim());
        }
    }
    return null;
}

function entryCookie(token, url) {
    const attributes = [
        ENTRY_COOKIE + '=' + encodeURIComponent(token),
        'HttpOnly',
        'SameSite=Strict',
        // Path=/, on purpose, so it is unambiguously sent on the navigation to
        // /admin-dashboard that follows entry. Scoping it to /admin-dashboard
        // read cleanly but left the cookie's delivery to that one route as the
        // last untested link, and the symptom - a verified administrator sent
        // straight back to / - is exactly what a cookie that did not arrive
        // produces. It stays HttpOnly, so no script reads it, and only the
        // dashboard route ever looks at it; being sent on other requests costs
        // a header and grants nothing.
        'Path=/',
        'Max-Age=' + ENTRY_MAX_AGE
    ];
    // Secure everywhere it can be honoured. `wrangler dev` serves over http on
    // loopback, where a Secure cookie would simply be dropped, so it is left
    // off there and set on the https deployment - which is the only place it
    // protects anything.
    if (url.protocol === 'https:') attributes.push('Secure');
    return attributes.join('; ');
}

function clearedCookie(url) {
    const attributes = [ENTRY_COOKIE + '=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
    if (url.protocol === 'https:') attributes.push('Secure');
    return attributes.join('; ');
}

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}

function notFound() {
    return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}

function methodNotAllowed(allowed) {
    return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: allowed.join(', '), 'Cache-Control': 'no-store' }
    });
}
