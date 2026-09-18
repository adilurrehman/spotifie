'use strict';

/**
 * Prove the configured Supabase settings actually work, before anything is
 * signed or deployed.
 *
 * Spotifie 1.0.1 shipped a publishable key the project rejects. Every static
 * check passed: the key was present, was not a secret, was not a placeholder,
 * and was the right shape. Nothing asked Supabase whether it was real, so a
 * signed APK, a signed App Bundle and a live website all went out unable to
 * load the catalogue or sign anybody in.
 *
 * So a release now asks. One harmless read of the published catalogue - the
 * same request a guest's browser makes on the first screen - answers the only
 * question that matters: can this build reach this project with this key?
 *
 *     valid            continue
 *     401 / 403        fail before signing or deployment
 *     unreachable      fail; a signed release nobody could verify is worse
 *                      than a release that did not happen
 *
 * The key is public browser configuration, not a secret, but it is never
 * printed: a build log is copied into issues and chats, and a value nobody
 * needs to read does not belong there. Only names are reported.
 *
 * A service-role key is refused outright. It would pass this check and would
 * be a catastrophe in a client.
 */

const REQUEST_TIMEOUT_MS = 15000;

/** The settings a release needs, read from the environment. Values are never logged. */
function settingsFromEnv(env) {
    return {
        url: String((env || {}).SUPABASE_URL || '').trim(),
        key: String((env || {}).SUPABASE_ANON_KEY || '').trim()
    };
}

/** True for a key that must never reach a client, whatever else is true of it. */
function looksLikeSecret(key) {
    return /service.role/i.test(key) || /^sb_secret_/.test(key);
}

/**
 * Ask Supabase whether these settings work.
 *
 * Returns { ok, reason }. `reason` is a sentence for a person, and never
 * contains the key.
 */
async function verifySupabase(settings, options) {
    const opts = options || {};
    const fetchImpl = opts.fetch || globalThis.fetch;
    const url = (settings || {}).url;
    const key = (settings || {}).key;

    if (!url) return { ok: false, reason: 'SUPABASE_URL is not set.' };
    if (!key) return { ok: false, reason: 'SUPABASE_ANON_KEY is not set.' };
    if (looksLikeSecret(key)) {
        return { ok: false, reason: 'SUPABASE_ANON_KEY looks like a secret key. Use the anon/publishable key.' };
    }
    if (typeof fetchImpl !== 'function') {
        return { ok: false, reason: 'This Node has no fetch, so the release settings could not be checked.' };
    }

    // The catalogue a guest sees. Reading one id changes nothing and needs no
    // account, so it tells us about the key and about nothing else.
    const endpoint = url.replace(/\/+$/, '') + '/rest/v1/catalog_albums?select=id&limit=1';

    // The timer and the connection are both closed by hand. Node on Windows
    // aborts if the process ends while either is still open, and a preflight
    // that crashes on success would fail every release it just approved.
    const controller = opts.signal ? null : new AbortController();
    const timer = controller
        ? setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), opts.timeoutMs || REQUEST_TIMEOUT_MS)
        : null;
    if (timer && typeof timer.unref === 'function') timer.unref();

    let response;
    try {
        response = await fetchImpl(endpoint, {
            method: 'GET',
            headers: { apikey: key, Authorization: 'Bearer ' + key },
            signal: opts.signal || controller.signal
        });
        // Nothing here reads the rows; letting the body go unread would hold
        // the socket open past the answer we came for.
        if (response && response.body && typeof response.body.cancel === 'function') {
            await response.body.cancel().catch(() => {});
        }
    } catch (err) {
        return {
            ok: false,
            reason:
                'Supabase could not be reached to check the release settings (' +
                shortError(err) +
                '). A release is not signed or deployed on an unverified key.'
        };
    } finally {
        if (timer) clearTimeout(timer);
    }

    const status = Number(response && response.status);

    if (status === 401 || status === 403) {
        return {
            ok: false,
            reason:
                'Supabase rejected SUPABASE_ANON_KEY for SUPABASE_URL (HTTP ' +
                status +
                '). The key is wrong, revoked, or belongs to another project.'
        };
    }
    if (!(status >= 200 && status < 300)) {
        return { ok: false, reason: 'Supabase answered HTTP ' + status + ' when the release settings were checked.' };
    }
    return { ok: true, reason: 'Supabase accepted the configured project and publishable key.' };
}

/** A short description of a failed request, with nothing sensitive in it. */
function shortError(err) {
    const name = err && err.name ? String(err.name) : 'error';
    if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
    const message = err && err.message ? String(err.message) : '';
    return message ? name + ': ' + message.split('\n')[0].slice(0, 120) : name;
}

/** Run the check for a named release step, and stop that step if it fails. */
async function main(argv, env) {
    const label = (argv || []).slice(2).join(' ').trim() || 'this release';
    const result = await verifySupabase(settingsFromEnv(env || process.env));

    if (!result.ok) {
        console.error('Release preflight failed for ' + label + '.');
        console.error('  ' + result.reason);
        console.error('  Nothing has been signed, built or deployed.');
        return 1;
    }
    console.log('Release preflight: ' + result.reason);
    return 0;
}

if (require.main === module) {
    // The exit code is set rather than forced: Node is left to close its own
    // handles, which is what keeps a successful check from aborting on exit.
    main(process.argv, process.env).then(
        (code) => {
            process.exitCode = code;
        },
        (err) => {
            console.error('Release preflight could not run: ' + shortError(err));
            process.exitCode = 1;
        }
    );
}

module.exports = { verifySupabase, settingsFromEnv, looksLikeSecret, shortError, main, REQUEST_TIMEOUT_MS };
