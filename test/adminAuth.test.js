'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { requireAdmin, bearerToken } = require('../lib/adminAuth');
const { getPublicConfig } = require('../lib/publicConfig');

function fakeRequest(headers) {
    return { headers: headers || {} };
}

test('bearer tokens are read only from a well-formed Authorization header', () => {
    assert.strictEqual(bearerToken(fakeRequest({})), null);
    assert.strictEqual(bearerToken(fakeRequest({ authorization: 'Basic abc' })), null);
    assert.strictEqual(bearerToken(fakeRequest({ authorization: 'Bearer  token-value ' })), 'token-value');
    assert.strictEqual(bearerToken(fakeRequest({ authorization: 'bearer lower-case' })), 'lower-case');
});

test('privileged requests without a session are refused before any lookup', async () => {
    const result = await requireAdmin(fakeRequest({}));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
});

test('cookies and custom headers cannot stand in for a bearer token', async () => {
    // Nothing a browser can set on its own - a cookie, a spoofed admin header,
    // a stale storage value echoed back - is accepted as authorization.
    const spoofed = fakeRequest({
        cookie: 'spotifie_admin=true',
        'x-admin': 'true',
        'x-spotifie-admin': JSON.stringify({ email: 'someone@example.com' })
    });
    const result = await requireAdmin(spoofed);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 401);
});

test('public configuration exposes only browser-safe Supabase values', () => {
    const config = getPublicConfig();
    assert.deepStrictEqual(Object.keys(config).sort(), ['supabaseAnonKey', 'supabaseUrl']);
    assert.ok(config.supabaseUrl.startsWith('https://'));

    const serialized = JSON.stringify(config).toLowerCase();
    assert.ok(!serialized.includes('service_role'), 'no service-role key is published');
    assert.ok(!serialized.includes('secret'), 'no secret is published');
});
