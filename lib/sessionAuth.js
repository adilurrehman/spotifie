'use strict';

/**
 * Who is calling.
 *
 * One place asks Supabase who a bearer token belongs to, and everything that
 * needs to know a caller's identity asks here. Nothing in this module knows
 * what an administrator is: that is a separate question, asked in adminAuth,
 * and keeping the two apart is what lets a build ship the user-facing app
 * without shipping the privileged half of it.
 *
 * The token is verified against the Supabase Auth API on every check that is
 * not already cached. The user id comes back from that answer and from nowhere
 * else - never from the request body, never from a header the caller chose,
 * never from anything the browser could have written.
 *
 * Only the public anon key is used. This server holds no service-role key, so
 * every request it makes on a caller's behalf runs as that caller, under Row
 * Level Security.
 */

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./publicConfig');

const AUTH_TIMEOUT_MS = 8000;

/** Read the bearer token from a request, or null. */
function bearerToken(req) {
    const header = req.headers.authorization || req.headers.Authorization;
    if (!header || typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : null;
}

/**
 * One request to Supabase, with a short timeout and a single retry.
 *
 * A dropped connection should not read as an outage to the person who just
 * clicked something. Nothing here logs the token, and nothing returns it.
 */
async function fetchJson(url, options) {
    const settings = options || {};
    const attempts = settings.attempts || 2;
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
        try {
            const response = await fetch(url, Object.assign({}, settings, { signal: controller.signal }));
            const text = await response.text();
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch (e) {
                body = null;
            }
            return { ok: response.ok, status: response.status, body };
        } catch (err) {
            lastError = err;
        } finally {
            clearTimeout(timer);
        }
    }

    const timedOut = lastError && lastError.name === 'AbortError';
    const error = new Error(timedOut ? 'Supabase did not answer in time' : 'Supabase could not be reached');
    error.status = timedOut ? 504 : 502;
    throw error;
}

/**
 * The authenticated user for an access token, or null.
 *
 * Supabase decides. A token that is expired, revoked, forged or simply wrong
 * comes back as null, and the caller is treated as a guest.
 */
async function getUserForToken(token) {
    const result = await fetchJson(SUPABASE_URL + '/auth/v1/user', {
        method: 'GET',
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + token
        }
    });

    if (!result.ok || !result.body || !result.body.id) return null;
    return { id: result.body.id, email: result.body.email };
}

/**
 * A tiny cache keyed by the tail of a token.
 *
 * Tokens are already opaque and only the last characters are kept, so the
 * store holds nothing that could be replayed. Entries are short-lived: a
 * signed-out session stops working within the window, not eventually.
 */
function createTokenCache(ttlMs) {
    const entries = new Map();
    const ttl = ttlMs || 30 * 1000;

    function keyFor(token) {
        return token.slice(-32);
    }

    return {
        read(token) {
            const entry = entries.get(keyFor(token));
            if (!entry) return null;
            if (Date.now() > entry.expiresAt) {
                entries.delete(keyFor(token));
                return null;
            }
            return entry.value;
        },
        write(token, value) {
            entries.set(keyFor(token), { value: value, expiresAt: Date.now() + ttl });
        },
        clear() {
            entries.clear();
        }
    };
}

// The one place a token becomes a person, for every part of the server.
const identities = createTokenCache(30 * 1000);

/**
 * The authenticated user for a token, asked once.
 *
 * A single request often needs to know who is calling more than once - the
 * catalogue wants their personal state, the guard wants to check their rights
 * - and each of those would otherwise be its own journey to Supabase. Sharing
 * the answer here means one verification per token per window, whichever part
 * asks first.
 *
 * A token Supabase rejects is remembered as "nobody" for the same short
 * window, so a page hammering with a stale token does not hammer Supabase.
 */
async function identifyToken(token) {
    if (!token) return null;

    const known = identities.read(token);
    if (known) return known.user;

    const user = await getUserForToken(token);
    identities.write(token, { user: user });
    return user;
}

/** Forget every remembered identity. Used by tests. */
function forgetIdentities() {
    identities.clear();
}

module.exports = {
    bearerToken,
    getUserForToken,
    identifyToken,
    forgetIdentities,
    fetchJson,
    createTokenCache,
    AUTH_TIMEOUT_MS
};
