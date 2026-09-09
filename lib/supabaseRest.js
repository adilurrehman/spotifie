'use strict';

/**
 * Minimal Supabase REST/Storage client.
 *
 * Every call runs as the caller: with their access token when they have one,
 * and as the anonymous role when they do not. Row Level Security decides what
 * is allowed either way. The server holds no service-role key, so neither a
 * guest nor an ordinary user can write to the global catalogue, whatever this
 * process is asked to do.
 */

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('./publicConfig');

const REQUEST_TIMEOUT_MS = 15000;

class SupabaseError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'SupabaseError';
        this.status = status;
        this.body = body;
    }
}

async function callSupabase(path, options) {
    const settings = options || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs || REQUEST_TIMEOUT_MS);

    const headers = Object.assign(
        {
            apikey: SUPABASE_ANON_KEY,
            Accept: 'application/json'
        },
        settings.headers || {}
    );

    // Supabase Storage rejects a request that carries only an apikey header
    // ("headers must have required property 'authorization'"), so a caller with
    // no session is presented as the anonymous role explicitly. The anon key is
    // public by design and grants exactly what the anon policies allow: reading
    // the published catalogue, and nothing else.
    headers.Authorization = 'Bearer ' + (settings.token || SUPABASE_ANON_KEY);

    try {
        const response = await fetch(SUPABASE_URL + path, {
            method: settings.method || 'GET',
            headers: headers,
            body: settings.body,
            signal: controller.signal
        });

        const text = settings.raw ? null : await response.text();
        let parsed = null;
        if (!settings.raw && text) {
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                parsed = null;
            }
        }

        if (!response.ok) {
            const detail = (parsed && (parsed.message || parsed.error || parsed.msg)) || text || response.statusText;
            throw new SupabaseError(detail, response.status, parsed);
        }

        return settings.raw ? response : parsed;
    } catch (err) {
        if (err instanceof SupabaseError) throw err;
        if (err.name === 'AbortError') {
            throw new SupabaseError('Supabase request timed out', 504, null);
        }
        throw new SupabaseError('Supabase is unreachable: ' + err.message, 503, null);
    } finally {
        clearTimeout(timer);
    }
}

/** Read rows from a table. `query` is a PostgREST query string. */
function selectRows(table, query, token) {
    const suffix = query ? '?' + query : '';
    return callSupabase('/rest/v1/' + table + suffix, { token: token });
}

/** Insert one row and return it. */
function insertRow(table, row, token) {
    return callSupabase('/rest/v1/' + table, {
        method: 'POST',
        token: token,
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(row)
    });
}

/** Patch rows matching `query` and return them. */
function updateRows(table, query, patch, token) {
    return callSupabase('/rest/v1/' + table + '?' + query, {
        method: 'PATCH',
        token: token,
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(patch)
    });
}

/** Delete rows matching `query` and return what was removed. */
function deleteRows(table, query, token) {
    return callSupabase('/rest/v1/' + table + '?' + query, {
        method: 'DELETE',
        token: token,
        headers: { Prefer: 'return=representation' }
    });
}

/**
 * Create a short-lived signed URL for a private Storage object.
 * The browser plays or displays that URL directly; the storage path itself
 * never has to leave the server.
 */
async function createSignedUrl(bucket, objectPath, expiresInSeconds, token) {
    const result = await callSupabase('/storage/v1/object/sign/' + bucket + '/' + encodeStoragePath(objectPath), {
        method: 'POST',
        token: token,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSeconds || 3600 })
    });

    if (!result || !result.signedURL) {
        throw new SupabaseError('Supabase did not return a signed URL', 502, result);
    }

    // Supabase returns a path relative to /storage/v1.
    const relative = String(result.signedURL).replace(/^\/+/, '');
    return SUPABASE_URL + '/storage/v1/' + relative.replace(/^storage\/v1\//, '');
}

/**
 * What is actually in a Storage bucket.
 *
 * Used by the maintenance audit to find files nothing in the catalogue points
 * at any more. Read-only: the policies allow anyone to read the catalogue
 * buckets, and nothing here removes or changes an object.
 *
 * Paged, because a bucket can hold more than one request should ask for.
 */
async function listStorageObjects(bucket, options, token) {
    const settings = options || {};

    const result = await callSupabase('/storage/v1/object/list/' + bucket, {
        method: 'POST',
        token: token,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prefix: settings.prefix || '',
            limit: settings.limit || 1000,
            offset: settings.offset || 0,
            sortBy: { column: 'name', order: 'asc' }
        })
    });

    return Array.isArray(result) ? result : [];
}

/** Remove one Storage object (used to clean up orphans). */
function removeStorageObject(bucket, objectPath, token) {
    return callSupabase('/storage/v1/object/' + bucket + '/' + encodeStoragePath(objectPath), {
        method: 'DELETE',
        token: token
    });
}

function encodeStoragePath(objectPath) {
    return String(objectPath)
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

module.exports = {
    SupabaseError,
    callSupabase,
    selectRows,
    insertRow,
    updateRows,
    deleteRows,
    createSignedUrl,
    listStorageObjects,
    removeStorageObject,
    encodeStoragePath
};
