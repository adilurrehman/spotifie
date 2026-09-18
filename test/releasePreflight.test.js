'use strict';

/**
 * The release preflight: the check that would have stopped 1.0.1.
 *
 * 1.0.1 was signed and deployed carrying a publishable key the project
 * rejects. Every static check passed, because every static check asked about
 * the shape of the key and none asked Supabase about the key itself. These
 * tests hold that check in place: a release that cannot reach its project
 * fails before anything is signed, and before any output is deployable.
 *
 * No real key appears here. The fixtures are invented, and one test exists to
 * prove that whatever key is configured never reaches the output.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const preflight = require('../tools/releasePreflight.js');

const ROOT = path.join(__dirname, '..');
const PROJECT = 'https://example-project.supabase.co';
const FAKE_KEY = 'sb_publishable_TESTONLY_not_a_real_key_000';

/** A fetch that answers with one status, and records what it was asked. */
function fetchAnswering(status, body) {
    const calls = [];
    const impl = (url, options) => {
        calls.push({ url: url, options: options });
        return Promise.resolve({ status: status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body || []) });
    };
    impl.calls = calls;
    return impl;
}

/** A fetch that cannot reach anything. */
function fetchFailing(err) {
    return () => Promise.reject(err || new Error('getaddrinfo ENOTFOUND'));
}

test('a key the project accepts lets the release continue', async () => {
    const fetchImpl = fetchAnswering(200, [{ id: 'a' }]);
    const result = await preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchImpl });

    assert.equal(result.ok, true);
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(fetchImpl.calls[0].url, /\/rest\/v1\/catalog_albums\?select=id&limit=1$/);
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
});

test('the catalogue read carries the key and changes nothing', async () => {
    const fetchImpl = fetchAnswering(200, []);
    await preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchImpl });

    const sent = fetchImpl.calls[0].options;
    assert.equal(sent.headers.apikey, FAKE_KEY);
    assert.equal(sent.headers.Authorization, 'Bearer ' + FAKE_KEY);
    assert.equal(sent.method, 'GET', 'a preflight only reads');
});

test('401 Invalid API key fails the release', async () => {
    const result = await preflight.verifySupabase(
        { url: PROJECT, key: FAKE_KEY },
        { fetch: fetchAnswering(401, { message: 'Invalid API key' }) }
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /rejected/i);
    assert.match(result.reason, /401/);
});

test('a key from another project fails rather than being accepted', async () => {
    // Supabase answers a key that is real but belongs elsewhere the same way
    // it answers a revoked one. Either way this build must not be signed.
    const result = await preflight.verifySupabase(
        { url: PROJECT, key: 'sb_publishable_TESTONLY_other_project_00' },
        { fetch: fetchAnswering(401, { message: 'Invalid API key' }) }
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /wrong, revoked, or belongs to another project/i);
});

test('a forbidden answer fails too', async () => {
    const result = await preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchAnswering(403) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /403/);
});

test('any other unhappy answer fails rather than being assumed fine', async () => {
    const result = await preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchAnswering(500) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /500/);
});

test('a release is not signed on settings that could not be checked', async () => {
    const result = await preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchFailing() });

    assert.equal(result.ok, false);
    assert.match(result.reason, /could not be reached/i);
    assert.match(result.reason, /not signed or deployed/i);
});

test('a timeout fails clearly rather than hanging the release', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const result = await preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchFailing(timeout) });

    assert.equal(result.ok, false);
    assert.match(result.reason, /timed out/);
});

test('missing settings are named, and stop the release', async () => {
    const noUrl = await preflight.verifySupabase({ url: '', key: FAKE_KEY }, { fetch: fetchAnswering(200) });
    const noKey = await preflight.verifySupabase({ url: PROJECT, key: '' }, { fetch: fetchAnswering(200) });

    assert.equal(noUrl.ok, false);
    assert.match(noUrl.reason, /SUPABASE_URL/);
    assert.equal(noKey.ok, false);
    assert.match(noKey.reason, /SUPABASE_ANON_KEY/);
});

test('a service-role key is refused before any request is made', async () => {
    const fetchImpl = fetchAnswering(200);
    const jwtShaped = await preflight.verifySupabase(
        { url: PROJECT, key: 'header.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature-service_role' },
        { fetch: fetchImpl }
    );
    const secretShaped = await preflight.verifySupabase({ url: PROJECT, key: 'sb_secret_TESTONLY_000' }, { fetch: fetchImpl });

    assert.equal(jwtShaped.ok, false);
    assert.equal(secretShaped.ok, false);
    assert.match(secretShaped.reason, /secret key/i);
    assert.equal(fetchImpl.calls.length, 0, 'a secret is never sent anywhere, not even to check it');
});

test('the configured key is never printed, passing or failing', async () => {
    const outcomes = await Promise.all([
        preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchAnswering(200) }),
        preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchAnswering(401) }),
        preflight.verifySupabase({ url: PROJECT, key: FAKE_KEY }, { fetch: fetchFailing() })
    ]);

    outcomes.forEach((result) => {
        assert.ok(!result.reason.includes(FAKE_KEY), 'the key is not in: ' + result.reason);
    });
});

test('the command says what failed, without quoting the key', async () => {
    const said = [];
    const log = console.log;
    const error = console.error;
    console.log = (line) => said.push(String(line));
    console.error = (line) => said.push(String(line));

    let code;
    try {
        const realFetch = globalThis.fetch;
        globalThis.fetch = fetchAnswering(401);
        try {
            code = await preflight.main(['node', 'releasePreflight.js', 'the signed Android APK'], {
                SUPABASE_URL: PROJECT,
                SUPABASE_ANON_KEY: FAKE_KEY
            });
        } finally {
            globalThis.fetch = realFetch;
        }
    } finally {
        console.log = log;
        console.error = error;
    }

    const output = said.join('\n');
    assert.equal(code, 1, 'a rejected key ends the command unsuccessfully');
    assert.match(output, /the signed Android APK/);
    assert.match(output, /Nothing has been signed, built or deployed\./);
    assert.ok(!output.includes(FAKE_KEY), 'the key is never printed');
});

test('a working configuration ends the command successfully', async () => {
    const said = [];
    const log = console.log;
    console.log = (line) => said.push(String(line));

    let code;
    try {
        const realFetch = globalThis.fetch;
        globalThis.fetch = fetchAnswering(200);
        try {
            code = await preflight.main(['node', 'releasePreflight.js'], { SUPABASE_URL: PROJECT, SUPABASE_ANON_KEY: FAKE_KEY });
        } finally {
            globalThis.fetch = realFetch;
        }
    } finally {
        console.log = log;
    }

    assert.equal(code, 0);
    assert.ok(!said.join('\n').includes(FAKE_KEY));
});

test('the settings come from the environment, by name', () => {
    const read = preflight.settingsFromEnv({ SUPABASE_URL: ' ' + PROJECT + ' ', SUPABASE_ANON_KEY: ' ' + FAKE_KEY + ' ' });
    assert.deepStrictEqual(read, { url: PROJECT, key: FAKE_KEY });
    assert.deepStrictEqual(preflight.settingsFromEnv({}), { url: '', key: '' });
});

test('the Android release checks its settings before it builds or signs anything', () => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'androidRelease.js'), 'utf8');

    const check = source.indexOf('releasePreflight.js');
    const frontend = source.indexOf('buildMobile.js');
    const gradle = source.indexOf('assembleRelease');

    assert.ok(check !== -1, 'the Android release runs the preflight');
    assert.ok(check < frontend, 'it runs before the frontend is built');
    assert.ok(check < gradle, 'and before Gradle signs anything');
});

test('a production website build checks its settings before writing output', () => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'buildPublic.js'), 'utf8');

    assert.match(source, /preflightOrExit/, 'the production build runs the preflight');
    const check = source.indexOf("if (detectMode() === 'production' && releaseSettingsLookReady())");
    const built = source.indexOf('build();', check);

    assert.ok(check !== -1, 'only a production build is gated');
    assert.ok(check < built, 'the check happens before the build runs');
});

test('settings that are missing or unfilled stay the build\'s own to report', () => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'buildPublic.js'), 'utf8');

    // A build with nothing configured already names every setting it wants.
    // The preflight waits until there is something real to check, so that
    // message is never replaced by one about an unreachable project.
    assert.match(source, /function releaseSettingsLookReady\(\)/);
    assert.match(source, /placeholderProblems\(\{ SUPABASE_URL: url, SUPABASE_ANON_KEY: key, PUBLIC_SITE_URL: siteUrl \}\)\.length === 0/);
});

test('an ordinary public build and a library caller are not put behind the network', () => {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'buildPublic.js'), 'utf8');

    // The gate is in the command, not in build(), so the tests and any caller
    // that builds a public release in process never reach for the network.
    const builder = source.slice(source.indexOf('function build(options)'), source.indexOf('function preflightOrExit'));
    assert.ok(!builder.includes('preflightOrExit'), 'build() itself does not preflight');
    assert.ok(!builder.includes('releasePreflight'), 'build() does not require the preflight');
});
