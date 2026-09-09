'use strict';

/**
 * Where a listener stopped, on this machine.
 *
 * A position belongs to whoever was listening: a signed-in person's goes into
 * their own state file, a guest's into this device's. These tests hold both
 * apart, check that a track heard to the end starts again, and confirm that
 * nothing here has anywhere else to go - the store writes files under
 * .spotifie and knows nothing about Supabase.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PlaybackProgressStore } = require('../lib/playbackProgress');
const { UserStateStore } = require('../lib/userState');
const { makeTempDir, removeDir } = require('./helpers/fixtures');

const http = require('http');
const { CatalogService } = require('../lib/catalogService');
const { createCatalogRoutes } = require('../lib/catalogRoutes');
const { DeviceLibrary } = require('../lib/deviceLibrary');

const TRACK_A = 'global:abc12345-1111-4111-8111-111111111111';
const TRACK_B = 'local:def456789abcdef0';

/** A store writing into a temporary .spotifie of its own. */
function makeStore() {
    const root = makeTempDir('spotifie-progress-');
    const usersDir = path.join(root, 'users');
    const deviceDir = path.join(root, 'device');

    const store = new PlaybackProgressStore({
        userState: new UserStateStore({ rootDir: usersDir }),
        deviceDir: deviceDir
    });

    return { root: root, usersDir: usersDir, deviceDir: deviceDir, store: store };
}

// ============================================
// Coming back to a track
// ============================================

test('a track is remembered where it was left, and answered from there', () => {
    const setup = makeStore();
    try {
        setup.store.save('user-one', TRACK_A, 103.4, 240);
        setup.store.save('user-one', TRACK_B, 52.8, 180);

        assert.strictEqual(setup.store.positionFor('user-one', TRACK_A), 103.4);
        assert.strictEqual(setup.store.positionFor('user-one', TRACK_B), 52.8);
        assert.strictEqual(setup.store.positionFor('user-one', 'local:0000000000000000'), 0);
    } finally {
        removeDir(setup.root);
    }
});

test('a position survives a refresh, because it is on disk', () => {
    const setup = makeStore();
    try {
        setup.store.save('user-one', TRACK_A, 61.5, 240);

        // A new store is the same thing a reloaded page gets.
        const again = new PlaybackProgressStore({
            userState: new UserStateStore({ rootDir: setup.usersDir }),
            deviceDir: setup.deviceDir
        });

        assert.strictEqual(again.positionFor('user-one', TRACK_A), 61.5);
    } finally {
        removeDir(setup.root);
    }
});

test('a track heard to its end starts again next time', () => {
    const setup = makeStore();
    try {
        setup.store.save('user-one', TRACK_A, 120, 240);
        assert.strictEqual(setup.store.positionFor('user-one', TRACK_A), 120);

        // Played to the end: the position it had is no longer worth keeping.
        const result = setup.store.save('user-one', TRACK_A, 240, 240);
        assert.strictEqual(result.cleared, true);
        assert.strictEqual(setup.store.positionFor('user-one', TRACK_A), 0);
    } finally {
        removeDir(setup.root);
    }
});

test('all but the last seconds of a track counts as the end', () => {
    const setup = makeStore();
    try {
        setup.store.save('user-one', TRACK_A, 236, 240);
        assert.strictEqual(setup.store.positionFor('user-one', TRACK_A), 0);
    } finally {
        removeDir(setup.root);
    }
});

test('the first few seconds of a track are not a place to come back to', () => {
    const setup = makeStore();
    try {
        setup.store.save('user-one', TRACK_A, 2.1, 240);
        assert.strictEqual(setup.store.positionFor('user-one', TRACK_A), 0);
    } finally {
        removeDir(setup.root);
    }
});

test('only a canonical track id can be remembered', () => {
    const setup = makeStore();
    try {
        assert.throws(() => setup.store.save('user-one', 'songs/My Song.mp3', 30, 200), /canonical track id/);
        assert.throws(() => setup.store.save('user-one', 'My Song.mp3', 30, 200), /canonical track id/);
    } finally {
        removeDir(setup.root);
    }
});

// ============================================
// One machine, several listeners
// ============================================

test('two accounts on one machine never hear each other', () => {
    const setup = makeStore();
    try {
        setup.store.save('user-one', TRACK_A, 100, 240);
        setup.store.save('user-two', TRACK_A, 30, 240);

        assert.strictEqual(setup.store.positionFor('user-one', TRACK_A), 100);
        assert.strictEqual(setup.store.positionFor('user-two', TRACK_A), 30);

        // Each one is in that account's own state file, and nowhere else.
        const first = JSON.parse(fs.readFileSync(path.join(setup.usersDir, 'user-one', 'state.json'), 'utf8'));
        const second = JSON.parse(fs.readFileSync(path.join(setup.usersDir, 'user-two', 'state.json'), 'utf8'));
        assert.strictEqual(first.trackProgress[TRACK_A].position, 100);
        assert.strictEqual(second.trackProgress[TRACK_A].position, 30);
    } finally {
        removeDir(setup.root);
    }
});

test('a guest is remembered too, by this device rather than by an account', () => {
    const setup = makeStore();
    try {
        setup.store.save(null, TRACK_B, 45, 180);

        assert.strictEqual(setup.store.positionFor(null, TRACK_B), 45);
        assert.strictEqual(setup.store.positionFor('user-one', TRACK_B), 0, 'an account does not inherit it');

        const file = path.join(setup.deviceDir, 'playback.json');
        assert.ok(fs.existsSync(file), 'a guest position lives with the device');
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.trackProgress[TRACK_B].position, 45);

        // Signing in does not empty it: the machine keeps what it had.
        setup.store.save('user-one', TRACK_B, 90, 180);
        assert.strictEqual(setup.store.positionFor(null, TRACK_B), 45);
    } finally {
        removeDir(setup.root);
    }
});

test('forgetting a track forgets only that track, for only that listener', () => {
    const setup = makeStore();
    try {
        setup.store.save('user-one', TRACK_A, 100, 240);
        setup.store.save('user-one', TRACK_B, 50, 180);
        setup.store.save('user-two', TRACK_A, 70, 240);

        setup.store.clear('user-one', TRACK_A);

        assert.strictEqual(setup.store.positionFor('user-one', TRACK_A), 0);
        assert.strictEqual(setup.store.positionFor('user-one', TRACK_B), 50);
        assert.strictEqual(setup.store.positionFor('user-two', TRACK_A), 70);
    } finally {
        removeDir(setup.root);
    }
});

test('remembering a position leaves the rest of a person\'s state alone', () => {
    const setup = makeStore();
    try {
        const users = new UserStateStore({ rootDir: setup.usersDir });
        users.hide('user-one', 'album', 'global-album:11111111-1111-4111-8111-111111111111');
        users.setAlbumOverride('user-one', '11111111-1111-4111-8111-111111111111', { title: 'My name for it' });

        setup.store.save('user-one', TRACK_A, 100, 240);

        const state = users.read('user-one');
        assert.deepStrictEqual(state.hiddenGlobalAlbumIds, ['global-album:11111111-1111-4111-8111-111111111111']);
        assert.strictEqual(state.globalAlbumOverrides['11111111-1111-4111-8111-111111111111'].title, 'My name for it');
        assert.strictEqual(state.trackProgress[TRACK_A].position, 100);
    } finally {
        removeDir(setup.root);
    }
});

// ============================================
// It stays here
// ============================================

test('nothing in the position store knows how to reach Supabase', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'playbackProgress.js'), 'utf8');

    assert.ok(!/require\(['"][^'"]*supabase/i.test(source), 'it does not reach for Supabase');
    assert.ok(!/fetch\(|https?:\/\//.test(source), 'it makes no requests of its own');
    assert.ok(!/base64|Buffer\.from\([^)]*base64/i.test(source), 'a position is a number, not encoded audio');
});

// ============================================
// Over HTTP
// ============================================

/** The catalogue routes, on a port of their own, over temporary state. */
function startProgressRoutes(setup) {
    const service = new CatalogService({
        library: { getTracks: () => ({ items: [] }), getAlbums: () => ({ items: [] }) },
        global: { isConfigured: () => false, getTracks: async () => [], getAlbums: async () => [] },
        userState: new UserStateStore({ rootDir: setup.usersDir }),
        deviceLibrary: new DeviceLibrary({ deviceDir: setup.deviceDir }),
        progress: setup.store
    });

    const routes = createCatalogRoutes({ service: service });
    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const query = Object.fromEntries(parsed.searchParams.entries());
        const handled = await routes.handle(req, res, parsed.pathname, query);
        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        }
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server: server, port: server.address().port }));
    });
}

function request(port, pathname, options) {
    const settings = options || {};
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: port,
                path: pathname,
                method: settings.method || 'GET',
                headers: { 'Content-Type': 'application/json' }
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
            }
        );
        req.on('error', reject);
        req.end(settings.body ? JSON.stringify(settings.body) : undefined);
    });
}

test('a guest keeps their place through the API, on this device', async (t) => {
    const setup = makeStore();
    const started = await startProgressRoutes(setup);
    t.after(() => {
        started.server.close();
        removeDir(setup.root);
    });

    const saved = await request(started.port, '/api/catalog/progress', {
        method: 'PUT',
        body: { id: TRACK_B, position: 63.2, duration: 200 }
    });
    assert.strictEqual(saved.status, 200, 'listening without an account is still listening');

    const read = JSON.parse((await request(started.port, '/api/catalog/progress')).body);
    assert.strictEqual(read.signedIn, false);
    assert.strictEqual(read.scope, 'this device');
    assert.strictEqual(read.trackProgress[TRACK_B].position, 63.2);
});

test('the API refuses anything that is not a canonical track id', async (t) => {
    const setup = makeStore();
    const started = await startProgressRoutes(setup);
    t.after(() => {
        started.server.close();
        removeDir(setup.root);
    });

    const rejected = await request(started.port, '/api/catalog/progress', {
        method: 'PUT',
        body: { id: '../../songs/secret.mp3', position: 30 }
    });
    assert.strictEqual(rejected.status, 400);
});
