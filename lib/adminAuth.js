'use strict';

/**
 * Server-side admin authorization.
 *
 * Hiding a dashboard link is not security. Every privileged endpoint verifies
 * the caller's Supabase access token against the Supabase Auth API, takes the
 * user id from that verified answer, and then checks that the id appears in
 * the `app_admins` table. Nothing the browser can write - a localStorage flag,
 * a request body, a header of its own choosing - takes any part in that
 * decision, so editing the page's JavaScript changes nothing here.
 *
 * Only the public anon key is used; this server holds no service-role key, so
 * the admin lookup runs under the caller's own token and Row Level Security.
 * `app_admins` grants no writes to anon or authenticated, so no account can
 * add itself to it: promotion is a database action, done by hand.
 *
 * This module is the private half of the server. The public release does not
 * ship it, and the routes that require it are simply absent there.
 */

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./publicConfig');
const { bearerToken, getUserForToken, identifyToken, fetchJson, createTokenCache } = require('./sessionAuth');

// Short-lived cache so a burst of requests does not hammer Supabase.
const cache = createTokenCache(30 * 1000);

/**
 * Is this token's user an admin?
 * The query runs as the caller, so RLS only ever returns their own row.
 * The answer is cached briefly, so one request never asks Supabase twice.
 */
async function isAdminToken(token) {
    const cached = cache.read(token);
    if (cached) return cached;

    const user = await identifyToken(token);
    if (!user) {
        const value = { authenticated: false, admin: false, user: null };
        cache.write(token, value);
        return value;
    }

    const url =
        SUPABASE_URL +
        '/rest/v1/app_admins?select=user_id&user_id=eq.' +
        encodeURIComponent(user.id) +
        '&limit=1';

    const result = await fetchJson(url, {
        method: 'GET',
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + token,
            Accept: 'application/json'
        }
    });

    const admin = Boolean(result.ok && Array.isArray(result.body) && result.body.length > 0);
    const value = { authenticated: true, admin, user };
    cache.write(token, value);
    return value;
}

/**
 * Guard a request. Returns { ok: true, user } or { ok: false, status, error }.
 * Callers must stop handling the request when ok is false.
 *
 * No token at all, or one Supabase does not recognise, is 401. A real session
 * belonging to somebody who is not an administrator is 403. The two are kept
 * apart deliberately: one says sign in, the other says this is not yours.
 *
 * A failure to reach Supabase is reported as such (502/504) rather than as a
 * bare "unavailable", and never as success: an unreachable check refuses the
 * request. The detail is logged here without ever including a token.
 */
async function requireAdmin(req) {
    const token = bearerToken(req);
    if (!token) {
        return { ok: false, status: 401, error: 'Authentication required' };
    }

    let result;
    try {
        result = await isAdminToken(token);
    } catch (e) {
        console.error('Admin check failed:', e.message);
        return {
            ok: false,
            status: e.status || 502,
            error:
                e.status === 504
                    ? 'Supabase did not answer in time. Check your connection and try again.'
                    : 'Could not reach Supabase to verify your session. Check your connection and try again.'
        };
    }

    if (!result.authenticated) {
        return { ok: false, status: 401, error: 'Invalid or expired session' };
    }
    if (!result.admin) {
        return { ok: false, status: 403, error: 'Administrator access required' };
    }

    return { ok: true, user: result.user };
}

module.exports = { requireAdmin, isAdminToken, bearerToken, getUserForToken };
