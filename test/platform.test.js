'use strict';

/**
 * Spotifie in two places at once.
 *
 * It has always run from a server somebody starts on their own machine. It now
 * also runs from a published copy on a static host, where there is no such
 * server and never will be - and the difference has to be something the
 * application asks about rather than something it assumes.
 *
 * These hold the line that follows from that. With a helper, everything about
 * the music on the device works. Without one, the application still loads, the
 * published catalogue and signing in still work, and the music on the device
 * is reported as out of reach rather than pretended away or quietly emptied.
 * Nothing crashes either way, and nothing waits forever.
 *
 * The other half of the file is what happens when things fail: a helper that
 * disappears mid-request, a request that never answers, a network that comes
 * and goes. The answer is always the same shape - say what is true, keep what
 * is known, and try again on a schedule that does not become a flood.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'platform.js'), 'utf8');

/**
 * The platform module, running, with a browser made of nothing but what it
 * actually touches.
 */
function loadPlatform(options) {
    const settings = options || {};
    const calls = [];

    const listeners = {};
    const sandbox = {
        console: { warn() {}, log() {}, error() {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Promise: Promise,
        Math: Math,
        Date: Date,
        Object: Object,
        Set: Set,
        Map: Map,
        Error: Error,
        String: String,
        Boolean: Boolean,
        JSON: JSON,
        navigator: { onLine: settings.online === undefined ? true : settings.online },
        AbortController: settings.noAbort ? undefined : AbortController,
        document: {
            visibilityState: 'visible',
            addEventListener(name, handler) {
                listeners[name] = handler;
            },
            removeEventListener() {}
        },
        fetch(url, init) {
            calls.push({ url: String(url), init: init || {} });
            return (settings.fetch || (() => Promise.reject(new Error('Failed to fetch'))))(String(url), init || {});
        }
    };

    sandbox.window = sandbox;
    sandbox.window.addEventListener = (name, handler) => {
        listeners[name] = handler;
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    return { platform: sandbox.spotifiePlatform, api: sandbox.SpotifiePlatform, calls: calls, listeners: listeners };
}

/** A helper that answers everything. */
function helperAnswering(body) {
    return () =>
        Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(body || {})
        });
}

/** A machine with nothing listening on it. */
function nothingListening() {
    return () => Promise.reject(new Error('Failed to fetch'));
}

// ============================================
// Is there a helper here?
// ============================================

test('a helper that answers is used, and said to be connected', async () => {
    const { platform } = loadPlatform({ fetch: helperAnswering({ permission: 'allowed' }) });

    assert.strictEqual(await platform.detectLocalCapability(), true);
    assert.strictEqual(platform.capabilities().localHelper, 'connected');

    const adapter = await platform.adapter();
    assert.strictEqual(adapter.name, 'local-helper');
});

test('no helper is an ordinary answer, not a failure', async () => {
    const { platform } = loadPlatform({ fetch: nothingListening() });

    assert.strictEqual(await platform.detectLocalCapability(), false);
    assert.strictEqual(platform.capabilities().localHelper, 'disconnected');

    const adapter = await platform.adapter();
    assert.strictEqual(adapter.name, 'none');

    // Every question about this device still answers, and none of them throws:
    // an application that has to catch an exception to draw a page is an
    // application that will one day fail to catch it.
    const library = await platform.getLocalLibrary();
    assert.strictEqual(library.albums.length, 0);
    assert.strictEqual(library.tracks.length, 0);
    assert.strictEqual(library.sources.local.available, false);

    assert.strictEqual(await platform.resolveLocalAudio('local:abc'), null);
    assert.strictEqual(await platform.resolveLocalArtwork('local:abc'), null);
    assert.strictEqual(await platform.getLocalState(), null);
    assert.strictEqual(await platform.saveLocalState({}), false);
});

test('searching a device there is no helper for is refused, and says why', async () => {
    const { platform } = loadPlatform({ fetch: nothingListening() });

    await assert.rejects(() => platform.scanLocalMusic(), /no Spotifie helper running on this device/);
});

// ============================================
// Nothing waits forever, and nothing floods
// ============================================

test('every request gives up rather than hanging', async () => {
    let signals = 0;

    const { platform, api } = loadPlatform({
        fetch: (url, init) => {
            if (init && init.signal) signals += 1;
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        }
    });

    await platform.detectLocalCapability();
    assert.strictEqual(signals, 1, 'the health check can be abandoned');

    await platform.getLocalLibrary();
    assert.ok(signals >= 2, 'and so can reading the library');

    // Each kind of request has a limit, and none of them is unbounded.
    Object.keys(api.TIMEOUTS).forEach((kind) => {
        assert.ok(api.TIMEOUTS[kind] > 0 && api.TIMEOUTS[kind] <= 20000, kind + ' has a sensible limit');
    });
});

test('looking for a helper that is not there backs off instead of flooding', async () => {
    const { api } = loadPlatform({ fetch: nothingListening() });

    const first = api.backoffFor(1);
    const third = api.backoffFor(3);
    const far = api.backoffFor(50);

    assert.ok(first >= api.RETRY_FLOOR, 'it waits at all');
    assert.ok(third > first, 'and waits longer each time');
    assert.ok(far <= api.RETRY_CEILING * 1.25, 'up to a ceiling, and no further');

    // Two pages waiting on the same helper do not come back in step.
    const spread = new Set([api.backoffFor(4), api.backoffFor(4), api.backoffFor(4)]);
    assert.ok(spread.size > 1, 'the wait is jittered');
});

test('a helper checked a moment ago is not checked again', async () => {
    const { platform, calls } = loadPlatform({ fetch: helperAnswering({}) });

    await platform.detectLocalCapability();
    await platform.detectLocalCapability();
    await platform.detectLocalCapability();

    const health = calls.filter((call) => call.url.indexOf('/api/library/health') !== -1);
    assert.strictEqual(health.length, 1, 'one question, one request');
});

test('only what might succeed next time is worth retrying', () => {
    const { api } = loadPlatform({ fetch: nothingListening() });

    // A network that was not there might be there in a moment.
    assert.strictEqual(api.worthRetrying(new Error('Failed to fetch')), true);
    assert.strictEqual(api.worthRetrying(Object.assign(new Error('busy'), { status: 503 })), true);
    assert.strictEqual(api.worthRetrying(Object.assign(new Error('slow'), { status: 429 })), true);

    // A refusal is a refusal however many times it is asked.
    assert.strictEqual(api.worthRetrying(Object.assign(new Error('no'), { status: 401 })), false);
    assert.strictEqual(api.worthRetrying(Object.assign(new Error('no'), { status: 403 })), false);
    assert.strictEqual(api.worthRetrying(Object.assign(new Error('gone'), { status: 404 })), false);
    assert.strictEqual(api.worthRetrying(Object.assign(new Error('bad'), { status: 400 })), false);
});

// ============================================
// A helper that goes away, and comes back
// ============================================

test('a helper disappearing mid-request is noticed, and nothing crashes', async () => {
    let alive = true;

    const { platform } = loadPlatform({
        fetch: (url) => {
            if (!alive) return Promise.reject(new Error('Failed to fetch'));
            if (url.indexOf('/api/library/health') !== -1) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
            }
            alive = false;
            return Promise.reject(new Error('Failed to fetch'));
        }
    });

    assert.strictEqual(await platform.detectLocalCapability(), true);

    await assert.rejects(() => platform.getLocalLibrary());
    assert.strictEqual(platform.capabilities().localHelper, 'disconnected', 'the loss is recorded');
});

test('a helper coming back is used again, without anything being reloaded', async () => {
    let running = false;

    const { platform } = loadPlatform({
        fetch: () =>
            running
                ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
                : Promise.reject(new Error('Failed to fetch'))
    });

    assert.strictEqual(await platform.detectLocalCapability(), false);

    running = true;
    assert.strictEqual(await platform.detectLocalCapability({ force: true }), true);
    assert.strictEqual(platform.capabilities().localHelper, 'connected');
    assert.strictEqual((await platform.adapter()).name, 'local-helper');
});

// ============================================
// What can be done here, said plainly
// ============================================

test('the capabilities are four plain answers and nothing private', async () => {
    const { platform } = loadPlatform({ fetch: nothingListening() });

    await platform.detectLocalCapability();
    platform.setCloudCatalogue('cached');
    platform.setLocalMusic('unavailable');

    const state = platform.capabilities();
    assert.deepStrictEqual(Object.keys(state).sort(), ['cloudCatalogue', 'localHelper', 'localMusic', 'online']);
    assert.strictEqual(state.localHelper, 'disconnected');
    assert.strictEqual(state.cloudCatalogue, 'cached');
    assert.strictEqual(state.localMusic, 'unavailable');

    // Nothing here says where anything is, what it is called, or who is using
    // it. This is safe to show and safe to log.
    const text = JSON.stringify(state);
    assert.ok(!/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(text), 'no path');
    assert.ok(!/token|password|secret|key/i.test(text), 'nothing secret');
});

test('a change of capability is announced once, to whoever asked', async () => {
    const { platform } = loadPlatform({ fetch: nothingListening() });

    const seen = [];
    platform.onCapabilityChange((state) => seen.push(state.localMusic));

    platform.setLocalMusic('unavailable');
    platform.setLocalMusic('unavailable');
    platform.setLocalMusic('available');

    assert.deepStrictEqual(seen, ['unavailable', 'available'], 'said when it moved, and not when it did not');
});

test('losing the network is noticed without asking anybody', () => {
    const { platform, listeners } = loadPlatform({ fetch: nothingListening() });

    assert.strictEqual(platform.capabilities().online, true);

    listeners.offline();
    assert.strictEqual(platform.capabilities().online, false);

    listeners.online();
    assert.strictEqual(platform.capabilities().online, true);
});

// ============================================
// What the module may and may not do
// ============================================

test('nothing here holds a secret or a path', () => {
    // The only Supabase values a browser ever sees are the project URL and the
    // anon key, and neither is this module's business.
    assert.ok(!/service_role|sb_secret|SUPABASE_/.test(SOURCE), 'no Supabase settings');
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(SOURCE), 'no key');

    // It speaks in canonical ids. A path never crosses this boundary in either
    // direction: the browser asks for a track by its id, and the helper is the
    // only thing that knows where that is on a disk.
    assert.ok(!/musicRoot|\/Users\/|[A-Za-z]:\\\\/.test(SOURCE), 'no filesystem path');
    assert.match(SOURCE, /function bareLocalId\(trackId\)/);
    assert.match(SOURCE, /encodeURIComponent\(bareLocalId\(trackId\)\)/);
});

test('the helper is only ever asked on this origin', () => {
    // Every address is relative, so a published copy asks the machine the page
    // is being read on and never some other host that happens to answer.
    const addresses = Array.from(SOURCE.matchAll(/['"](\/api\/[^'"]*)['"]/g)).map((m) => m[1]);
    assert.ok(addresses.length > 0, 'it does ask for things');
    addresses.forEach((address) => {
        assert.ok(address.startsWith('/api/'), address + ' is relative to this origin');
    });

    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(SOURCE), 'no other host is named');
});

test('the interface is the one the rest of the application was promised', () => {
    // A future adapter - a phone's own media library, a browser's file handles
    // - replaces the one below by answering these. Nothing above this file
    // knows which is behind them, which is what makes that replacement
    // possible.
    const required = [
        'detectLocalCapability',
        'getLocalLibrary',
        'scanLocalMusic',
        'reconcileLocalMusic',
        'resolveLocalAudio',
        'resolveLocalArtwork',
        'getLocalState',
        'saveLocalState'
    ];

    const { api } = loadPlatform({ fetch: nothingListening() });

    required.forEach((method) => {
        assert.strictEqual(typeof api.LocalHelperAdapter.prototype[method], 'function', 'the helper answers ' + method);
        assert.strictEqual(typeof api.NoLocalAdapter.prototype[method], 'function', 'and so does nothing at all');
        assert.strictEqual(typeof api.Platform.prototype[method], 'function', 'and the platform passes it on');
    });
});
