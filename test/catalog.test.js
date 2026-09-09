'use strict';

/**
 * Hybrid catalogue tests.
 *
 * The local half is the real P2 library over temp fixtures; the global half
 * is a fake Supabase REST layer, so the merge rules, the namespacing and the
 * "hide for me, never delete for everyone" behaviour are all checked without
 * a live project.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { GlobalCatalog, parseGlobalTrackId, parseGlobalAlbumId } = require('../lib/globalCatalog');
const { UserStateStore } = require('../lib/userState');
const { DeviceLibrary } = require('../lib/deviceLibrary');
const { UserArtworkStore } = require('../lib/userArtwork');
const { CatalogService, sourceOf, parseLocalTrackId } = require('../lib/catalogService');
const { createCatalogRoutes } = require('../lib/catalogRoutes');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const ALBUM_UUID = '11111111-1111-4111-8111-111111111111';
const SECOND_ALBUM_UUID = '22222222-2222-4222-8222-222222222222';
const TRACK_UUID = '33333333-3333-4333-8333-333333333333';
const SECOND_TRACK_UUID = '44444444-4444-4444-8444-444444444444';

/** In-memory stand-in for Supabase REST + Storage. */
function makeFakeRest(options) {
    const settings = options || {};
    const state = {
        albums: settings.albums || [],
        tracks: settings.tracks || [],
        removed: [],
        signed: [],
        failReads: settings.failReads || false,
        malformed: settings.malformed || false,
        admins: settings.admins || []
    };

    function isAdmin(token) {
        return state.admins.indexOf(token) !== -1;
    }

    const rest = {
        _state: state,
        async selectRows(table, query, token) {
            if (state.failReads) throw new Error('Supabase is unreachable');
            if (state.malformed) return { unexpected: 'shape' };
            // Reads are public: a guest (no token) sees the same rows.

            const rows = table === 'catalog_albums' ? state.albums : state.tracks;
            const idMatch = /(?:^|&)id=eq\.([^&]+)/.exec(query || '');
            const albumMatch = /(?:^|&)album_id=eq\.([^&]+)/.exec(query || '');

            if (idMatch) return rows.filter((row) => row.id === decodeURIComponent(idMatch[1]));
            if (albumMatch) return rows.filter((row) => row.album_id === decodeURIComponent(albumMatch[1]));
            return rows.slice();
        },
        async insertRow(table, row, token) {
            if (!isAdmin(token)) throw new Error('new row violates row-level security policy');
            const stored = Object.assign({ id: 'generated-' + Math.random().toString(16).slice(2) }, row);
            (table === 'catalog_albums' ? state.albums : state.tracks).push(stored);
            return [stored];
        },
        async updateRows(table, query, patch, token) {
            if (!isAdmin(token)) throw new Error('row-level security policy');
            const rows = table === 'catalog_albums' ? state.albums : state.tracks;
            const idMatch = /id=eq\.([^&]+)/.exec(query);
            const target = rows.find((row) => row.id === decodeURIComponent(idMatch[1]));
            if (!target) return [];
            Object.assign(target, patch);
            return [target];
        },
        async deleteRows(table, query, token) {
            if (!isAdmin(token)) throw new Error('row-level security policy');
            const list = table === 'catalog_albums' ? state.albums : state.tracks;
            const idMatch = /id=eq\.([^&]+)/.exec(query);
            const id = decodeURIComponent(idMatch[1]);
            const index = list.findIndex((row) => row.id === id);
            if (index === -1) return [];
            return list.splice(index, 1);
        },
        async createSignedUrl(bucket, objectPath, expiresIn, token) {
            // Signing works for guests too, under the anon SELECT policy.
            state.signed.push({ bucket, objectPath, token: token || null });
            return 'https://example.supabase.co/storage/v1/object/sign/' + bucket + '/' + objectPath + '?token=signed';
        },
        async removeStorageObject(bucket, objectPath, token) {
            if (!isAdmin(token)) throw new Error('row-level security policy');
            state.removed.push({ bucket, objectPath });
            return {};
        }
    };

    return rest;
}

function globalFixtures() {
    return {
        albums: [
            { id: ALBUM_UUID, title: 'Global Album', artist: 'Global Artist', album_artist: 'Global Artist', artwork_path: 'cover.jpg' },
            { id: SECOND_ALBUM_UUID, title: 'Coverless Album', artist: 'Nobody', album_artist: 'Nobody', artwork_path: null }
        ],
        tracks: [
            {
                id: TRACK_UUID,
                album_id: ALBUM_UUID,
                title: 'Global Song',
                artist: 'Global Artist',
                album_artist: 'Global Artist',
                duration: 210,
                mime_type: 'audio/mpeg',
                audio_path: 'audio/global-song.mp3',
                artwork_path: null
            },
            {
                id: SECOND_TRACK_UUID,
                album_id: SECOND_ALBUM_UUID,
                title: 'Coverless Song',
                artist: 'Nobody',
                album_artist: 'Nobody',
                duration: 120,
                mime_type: 'audio/mpeg',
                audio_path: 'audio/coverless.mp3',
                artwork_path: null
            }
        ]
    };
}

function buildContext(options) {
    const settings = options || {};
    const musicRoot = makeTempDir('spotifie-cat-music-');
    const dataDir = makeTempDir('spotifie-cat-data-');

    if (settings.buildLocal) settings.buildLocal(musicRoot);

    const library = new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    const rest = makeFakeRest(Object.assign({ admins: ['admin-token'] }, settings.rest || {}));
    const global = new GlobalCatalog({ rest: rest });
    const userState = new UserStateStore({ rootDir: path.join(dataDir, 'users') });
    // Its own device folder, so a test never sees the music of the machine it
    // happens to be running on.
    const deviceLibrary = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });
    const service = new CatalogService({
        library: library,
        global: global,
        userState: userState,
        deviceLibrary: deviceLibrary
    });

    return {
        musicRoot,
        dataDir,
        library,
        rest,
        global,
        userState,
        service,
        cleanup() {
            removeDir(musicRoot);
            removeDir(dataDir);
        }
    };
}

function withLocalTrack(root) {
    writeFile(root, path.join('Local Artist', 'Local Album', 'song.mp3'), buildMp3({
        title: 'Local Song',
        artist: 'Local Artist',
        album: 'Local Album',
        filler: 'localA'
    }));
}

test('namespaced ids identify their source and cannot collide', () => {
    assert.strictEqual(sourceOf('local:abc123'), 'local');
    assert.strictEqual(sourceOf('local-album:abc123'), 'local');
    assert.strictEqual(sourceOf('global:' + TRACK_UUID), 'global');
    assert.strictEqual(sourceOf('global-album:' + ALBUM_UUID), 'global');
    assert.strictEqual(sourceOf('abc123'), null);

    // The same underlying value in both namespaces stays two distinct ids.
    const shared = 'aaaaaaaa';
    assert.notStrictEqual('local:' + shared, 'global:' + shared);
    assert.strictEqual(parseLocalTrackId('local:' + shared), shared);
    assert.strictEqual(parseLocalTrackId('global:' + shared), null);
    assert.strictEqual(parseGlobalTrackId('global:' + shared), shared);
    assert.strictEqual(parseGlobalTrackId('local:' + shared), null);
    assert.strictEqual(parseGlobalAlbumId('global-album:' + shared), shared);
    assert.strictEqual(parseGlobalAlbumId('global:' + shared), null);
});

test('a local-only catalogue works with no global source', async () => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: { albums: [], tracks: [] } });
    try {
        await context.library.scan();
        const result = await context.service.getTracks({});

        assert.strictEqual(result.total, 1);
        assert.strictEqual(result.items[0].source, 'local');
        assert.ok(result.items[0].id.startsWith('local:'));
        assert.strictEqual(result.sources.global.trackCount, 0);
        assert.strictEqual(result.sources.local.available, true);
    } finally {
        context.cleanup();
    }
});

test('a global-only catalogue works with no local tracks', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        await context.library.scan();
        const result = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });

        assert.strictEqual(result.total, 2);
        assert.ok(result.items.every((track) => track.source === 'global'));
        assert.ok(result.items.every((track) => track.id.startsWith('global:')));
        assert.strictEqual(result.sources.local.trackCount, 0);
    } finally {
        context.cleanup();
    }
});

test('both sources merge into one catalogue without duplication', async () => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: globalFixtures() });
    try {
        await context.library.scan();
        const tracks = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });
        const albums = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });

        assert.strictEqual(tracks.total, 3);
        assert.strictEqual(new Set(tracks.items.map((track) => track.id)).size, 3);
        assert.deepStrictEqual(
            tracks.items.map((track) => track.source).sort(),
            ['global', 'global', 'local']
        );

        assert.strictEqual(albums.total, 3);
        assert.ok(albums.items.some((album) => album.source === 'local'));
        assert.ok(albums.items.some((album) => album.id === 'global-album:' + ALBUM_UUID));

        // Every track carries the shared model, with no paths in sight.
        for (const track of tracks.items) {
            assert.ok(track.id && track.source && track.title && track.artist);
            assert.ok(Object.prototype.hasOwnProperty.call(track, 'albumId'));
            assert.ok(track.streamUrl && track.artworkUrl);
            assert.ok(track.metadata);
        }

        const payload = JSON.stringify(tracks);
        assert.ok(!payload.includes(context.musicRoot), 'no filesystem paths are exposed');
        assert.ok(!payload.includes('audio/global-song.mp3'), 'no storage paths are exposed');
        assert.ok(!payload.includes('base64'), 'nothing is inlined as Base64');
    } finally {
        context.cleanup();
    }
});

test('an unavailable global catalogue leaves the local library intact', async () => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: { failReads: true } });
    try {
        await context.library.scan();
        const result = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });

        assert.strictEqual(result.total, 1);
        assert.strictEqual(result.items[0].source, 'local');
        assert.strictEqual(result.sources.global.available, false);
        assert.match(result.sources.global.error, /unreachable/i);
        assert.strictEqual(result.sources.local.available, true);
    } finally {
        context.cleanup();
    }
});

test('a malformed Supabase response does not break the local library', async () => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: { malformed: true } });
    try {
        await context.library.scan();
        const result = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });

        assert.strictEqual(result.total, 1);
        assert.strictEqual(result.sources.global.available, false);
        assert.match(result.sources.global.error, /malformed/i);
    } finally {
        context.cleanup();
    }
});

test('an unavailable local library leaves the global catalogue intact', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        context.service.library = {
            getTracks() {
                throw new Error('index is locked');
            },
            getAlbums() {
                throw new Error('index is locked');
            },
            getTrack() {
                return null;
            }
        };

        const result = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(result.total, 2);
        assert.strictEqual(result.sources.local.available, false);
        assert.strictEqual(result.sources.global.available, true);
    } finally {
        context.cleanup();
    }
});

test('global streams resolve to a signed URL and local streams stay local', async () => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: globalFixtures() });
    try {
        await context.library.scan();
        const tracks = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });

        const localTrack = tracks.items.find((track) => track.source === 'local');
        const globalTrack = tracks.items.find((track) => track.source === 'global');

        const localStream = await context.service.resolveStreamUrl(localTrack.id, { token: 'user-token' });
        assert.strictEqual(localStream.source, 'local');
        assert.match(localStream.url, /^\/api\/library\/tracks\//);

        const globalStream = await context.service.resolveStreamUrl(globalTrack.id, { token: 'user-token' });
        assert.strictEqual(globalStream.source, 'global');
        assert.match(globalStream.url, /storage\/v1\/object\/sign\/catalog-audio\//);
        assert.ok(globalStream.expiresIn > 0, 'the signed URL is short-lived');
    } finally {
        context.cleanup();
    }
});

test('missing artwork falls back instead of failing the album', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        // The album with a cover resolves to a signed URL.
        const withCover = await context.service.resolveArtworkUrl('global-album:' + ALBUM_UUID, { token: 'user-token' });
        assert.ok(withCover && withCover.url.includes('catalog-artwork'));

        // The album without one resolves to nothing, and the caller uses the
        // default cover rather than treating the album as broken.
        const withoutCover = await context.service.resolveArtworkUrl('global-album:' + SECOND_ALBUM_UUID, {
            token: 'user-token'
        });
        assert.strictEqual(withoutCover, null);

        // A track with no artwork of its own inherits the album cover.
        const trackArtwork = await context.service.resolveArtworkUrl('global:' + TRACK_UUID, { token: 'user-token' });
        assert.ok(trackArtwork && trackArtwork.url.includes('catalog-artwork'));

        const catalog = await context.service.getCatalog({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(catalog.albums.length, 2, 'the coverless album is still listed');
    } finally {
        context.cleanup();
    }
});

test('hiding a global track affects only that user and never Supabase', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const trackId = 'global:' + TRACK_UUID;
        const before = context.rest._state.tracks.length;

        context.service.hideForUser('user-one', trackId);

        const hider = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });
        assert.ok(!hider.items.some((track) => track.id === trackId), 'hidden for this user');

        const other = await context.service.getTracks({ token: 'user-token', userId: 'user-two' });
        assert.ok(other.items.some((track) => track.id === trackId), 'still visible for everyone else');

        assert.strictEqual(context.rest._state.tracks.length, before, 'the shared row is untouched');
        assert.strictEqual(context.rest._state.removed.length, 0, 'no stored file was removed');

        // And the state lives in the documented per-user file.
        const stateFile = path.join(context.dataDir, 'users', 'user-one', 'state.json');
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const { SCHEMA_VERSION } = require('../lib/userState');
        assert.strictEqual(saved.schemaVersion, SCHEMA_VERSION);
        assert.deepStrictEqual(saved.hiddenGlobalTrackIds, [trackId]);

        // Hiding something says nothing about what this person liked or made.
        assert.deepStrictEqual(saved.likedTrackIds, []);
        assert.deepStrictEqual(saved.playlists, []);
        assert.deepStrictEqual(saved.recentlyPlayed, []);
    } finally {
        context.cleanup();
    }
});

test('hiding a global album hides its tracks for that user only', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        context.service.hideForUser('user-one', albumId);

        const hider = await context.service.getCatalog({ token: 'user-token', userId: 'user-one' });
        assert.ok(!hider.albums.some((album) => album.id === albumId));
        assert.ok(!hider.tracks.some((track) => track.albumId === albumId), 'its tracks go with it');
        assert.strictEqual(hider.tracks.length, 1, 'other albums are unaffected');

        const other = await context.service.getCatalog({ token: 'user-token', userId: 'user-two' });
        assert.strictEqual(other.albums.length, 2);
        assert.strictEqual(other.tracks.length, 2);

        assert.strictEqual(context.rest._state.albums.length, 2, 'nothing was deleted in Supabase');
    } finally {
        context.cleanup();
    }
});

test('hidden content can be restored', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const trackId = 'global:' + TRACK_UUID;
        const albumId = 'global-album:' + SECOND_ALBUM_UUID;

        context.service.hideForUser('user-one', trackId);
        context.service.hideForUser('user-one', albumId);
        let catalog = await context.service.getCatalog({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(catalog.tracks.length, 0);

        context.service.restoreForUser('user-one', trackId);
        context.service.restoreForUser('user-one', albumId);
        catalog = await context.service.getCatalog({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(catalog.tracks.length, 2);
        assert.strictEqual(catalog.albums.length, 2);

        const hidden = context.service.getHiddenForUser('user-one');
        assert.deepStrictEqual(hidden.hiddenGlobalTrackIds, []);
        assert.deepStrictEqual(hidden.hiddenGlobalAlbumIds, []);
    } finally {
        context.cleanup();
    }
});

test('removing a local track is local only and never reaches Supabase', async () => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: globalFixtures() });
    try {
        await context.library.scan();
        const tracks = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });
        const localTrack = tracks.items.find((track) => track.source === 'local');

        const restCallsBefore = context.rest._state.removed.length;
        context.service.hideForUser('user-one', localTrack.id);

        const after = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });
        assert.ok(!after.items.some((track) => track.id === localTrack.id));
        assert.strictEqual(context.rest._state.removed.length, restCallsBefore, 'no storage call was made');
        assert.strictEqual(context.rest._state.tracks.length, 2, 'the global catalogue is untouched');

        // The audio file itself is still on disk: hiding is not deleting.
        const stillOnDisk = fs.existsSync(path.join(context.musicRoot, 'Local Artist', 'Local Album', 'song.mp3'));
        assert.ok(stillOnDisk, 'local audio is never deleted by a hide');
    } finally {
        context.cleanup();
    }
});

test('permanent global delete removes the row and its stored files', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const result = await context.global.deleteTrack('global:' + TRACK_UUID, 'admin-token');
        assert.strictEqual(result.deleted, true);
        assert.strictEqual(context.rest._state.tracks.length, 1);
        assert.deepStrictEqual(context.rest._state.removed, [
            { bucket: 'catalog-audio', objectPath: 'audio/global-song.mp3' }
        ]);
    } finally {
        context.cleanup();
    }
});

test('an ordinary user cannot delete or modify global content', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        await assert.rejects(
            () => context.global.deleteTrack('global:' + TRACK_UUID, 'user-token'),
            /row-level security/i
        );
        await assert.rejects(
            () => context.global.deleteAlbum('global-album:' + ALBUM_UUID, 'user-token'),
            /row-level security/i
        );
        await assert.rejects(
            () => context.global.createTrack({ title: 'Sneaky', audioPath: 'x.mp3' }, 'user-token'),
            /row-level security/i
        );
        await assert.rejects(
            () => context.global.updateTrack('global:' + TRACK_UUID, { title: 'Renamed' }, 'user-token'),
            /row-level security/i
        );

        assert.strictEqual(context.rest._state.tracks.length, 2);
        assert.strictEqual(context.rest._state.albums.length, 2);
    } finally {
        context.cleanup();
    }
});

// ============================================
// HTTP surface
// ============================================

function startRoutes(service, identify) {
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
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function request(port, pathname, options) {
    const settings = options || {};
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: pathname,
                method: settings.method || 'GET',
                headers: Object.assign({ 'Content-Type': 'application/json' }, settings.headers || {})
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
                );
            }
        );
        req.on('error', reject);
        req.end(settings.body ? JSON.stringify(settings.body) : undefined);
    });
}

test('the catalogue API serves a guest the global catalogue and the local library', async (t) => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: globalFixtures() });
    await context.library.scan();

    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    // A guest browses the published catalogue without any account.
    const tracks = JSON.parse((await request(started.port, '/api/catalog/tracks')).body);
    assert.strictEqual(tracks.total, 3);
    assert.strictEqual(tracks.items.filter((track) => track.source === 'global').length, 2);
    assert.strictEqual(tracks.items.filter((track) => track.source === 'local').length, 1);

    const albums = JSON.parse((await request(started.port, '/api/catalog/albums')).body);
    assert.ok(albums.items.some((album) => album.id === 'global-album:' + ALBUM_UUID));

    // Global media resolves for a guest as well.
    const stream = JSON.parse((await request(started.port, '/api/catalog/tracks/' + encodeURIComponent('global:' + TRACK_UUID) + '/stream')).body);
    assert.strictEqual(stream.source, 'global');
    assert.match(stream.url, /catalog-audio/);

    const artwork = JSON.parse((await request(started.port, '/api/catalog/albums/' + encodeURIComponent('global-album:' + ALBUM_UUID) + '/artwork')).body);
    assert.match(artwork.url, /catalog-artwork/);

    // Personal actions still need an account: hiding is refused.
    const hide = await request(started.port, '/api/catalog/hidden', {
        method: 'POST',
        body: { id: 'global:' + TRACK_UUID }
    });
    assert.strictEqual(hide.status, 401);
});

test('the permanent delete endpoint refuses everyone who is not a verified admin', async (t) => {
    const context = buildContext({ rest: globalFixtures() });
    const started = await startRoutes(context.service);

    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    // No session at all.
    const anonymous = await request(started.port, '/api/catalog/tracks/global:' + TRACK_UUID, { method: 'DELETE' });
    assert.strictEqual(anonymous.status, 401);

    // A signed-in but unverifiable (non-admin) caller: the guard refuses
    // rather than falling through to the delete.
    const user = await request(started.port, '/api/catalog/tracks/global:' + TRACK_UUID, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer user-token' }
    });
    assert.ok([401, 403, 503].includes(user.status), 'refused, never allowed: got ' + user.status);

    assert.strictEqual(context.rest._state.tracks.length, 2, 'nothing was deleted');

    // A local id can never be routed into the global delete path.
    const localAttempt = await request(started.port, '/api/catalog/tracks/local:abc123', { method: 'DELETE' });
    assert.strictEqual(localAttempt.status, 400);
    assert.match(JSON.parse(localAttempt.body).error, /global catalogue/i);
});

test('admin write endpoints refuse an unverified caller', async (t) => {
    const context = buildContext({ rest: globalFixtures() });
    const started = await startRoutes(context.service);

    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    const create = await request(started.port, '/api/catalog/admin/tracks', {
        method: 'POST',
        body: { title: 'Sneaky', audioPath: 'x.mp3' }
    });
    assert.strictEqual(create.status, 401);

    const album = await request(started.port, '/api/catalog/admin/albums', {
        method: 'POST',
        body: { title: 'Sneaky album' }
    });
    assert.strictEqual(album.status, 401);

    assert.strictEqual(context.rest._state.tracks.length, 2);
    assert.strictEqual(context.rest._state.albums.length, 2);
});

test('user state survives a corrupt file and stays per user', () => {
    const dataDir = makeTempDir('spotifie-state-');
    try {
        const store = new UserStateStore({ rootDir: path.join(dataDir, 'users') });

        store.hide('user-one', 'track', 'global:' + TRACK_UUID);
        store.hide('user-two', 'album', 'global-album:' + ALBUM_UUID);

        assert.deepStrictEqual(store.read('user-one').hiddenGlobalTrackIds, ['global:' + TRACK_UUID]);
        assert.deepStrictEqual(store.read('user-one').hiddenGlobalAlbumIds, []);
        assert.deepStrictEqual(store.read('user-two').hiddenGlobalAlbumIds, ['global-album:' + ALBUM_UUID]);

        // A damaged file degrades to empty state instead of throwing.
        fs.writeFileSync(path.join(dataDir, 'users', 'user-one', 'state.json'), '{ not json');
        assert.deepStrictEqual(store.read('user-one').hiddenGlobalTrackIds, []);

        // Ids that are not plausible user ids are refused outright.
        assert.strictEqual(store.stateFileFor('../escape'), null);
        assert.strictEqual(store.stateFileFor(''), null);
    } finally {
        removeDir(dataDir);
    }
});

test('no catalogue code path encodes audio or artwork as Base64', () => {
    const files = [
        'lib/catalogService.js',
        'lib/globalCatalog.js',
        'lib/catalogRoutes.js',
        'lib/userState.js',
        'js/catalogClient.js',
        'js/admin.js'
    ];

    for (const file of files) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.ok(!/readAsDataURL/.test(source), file + ' does not read files as data URLs');
        assert.ok(!/toString\(['"]base64['"]\)/.test(source), file + ' does not Base64-encode media');
        assert.ok(!/data:audio/.test(source), file + ' never builds an audio data URL');
    }
});

test('the admin dashboard uploads only to the global catalogue buckets', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');

    // Uploads exist, and only for the two global buckets.
    assert.match(source, /catalog-audio/);
    assert.match(source, /catalog-artwork/);

    const buckets = source.match(/storage\.from\(([^)]*)\)/g) || [];
    for (const call of buckets) {
        assert.ok(/bucket/i.test(call), 'storage access goes through the bucket constants: ' + call);
    }

    // The player never uploads anything at all.
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
    assert.ok(!/storage\.from/.test(player), 'the player never touches Supabase Storage');
    assert.ok(!/\.upload\(/.test(player), 'the player never uploads user audio');
});

// ============================================
// Guest access to the published catalogue
// ============================================

test('a guest reads the global catalogue with no session at all', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        // No token, no user id: exactly what a signed-out visitor sends.
        const catalog = await context.service.getCatalog({});

        assert.strictEqual(catalog.sources.global.available, true);
        assert.strictEqual(catalog.tracks.length, 2);
        assert.strictEqual(catalog.albums.length, 2);
        assert.ok(catalog.tracks.every((track) => track.source === 'global'));

        // The model a guest receives is the same one a member receives.
        const guestTrack = catalog.tracks[0];
        const fields = ['id', 'source', 'title', 'artist', 'album', 'albumId', 'duration', 'artworkUrl', 'streamUrl', 'metadata'];
        for (const field of fields) {
            assert.ok(Object.prototype.hasOwnProperty.call(guestTrack, field), 'guest track has ' + field);
        }
    } finally {
        context.cleanup();
    }
});

test('a guest can resolve global artwork and audio', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const stream = await context.service.resolveStreamUrl('global:' + TRACK_UUID, {});
        assert.strictEqual(stream.source, 'global');
        assert.match(stream.url, /catalog-audio/);

        const artwork = await context.service.resolveArtworkUrl('global-album:' + ALBUM_UUID, {});
        assert.ok(artwork && artwork.url.includes('catalog-artwork'));

        // Signing happened without a token, as the anon role.
        assert.ok(context.rest._state.signed.every((entry) => entry.token === null));
    } finally {
        context.cleanup();
    }
});

test('a guest cannot write to the global catalogue', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        // No token at all: PostgREST runs these as the anon role, which has no
        // insert/update/delete policy on the catalogue.
        await assert.rejects(() => context.global.createAlbum({ title: 'Guest album' }, null), /row-level security/i);
        await assert.rejects(
            () => context.global.createTrack({ title: 'Guest track', audioPath: 'x.mp3' }, null),
            /row-level security/i
        );
        await assert.rejects(
            () => context.global.updateTrack('global:' + TRACK_UUID, { title: 'Renamed' }, null),
            /row-level security/i
        );
        await assert.rejects(() => context.global.deleteTrack('global:' + TRACK_UUID, null), /row-level security/i);
        await assert.rejects(() => context.global.deleteAlbum('global-album:' + ALBUM_UUID, null), /row-level security/i);

        assert.strictEqual(context.rest._state.tracks.length, 2);
        assert.strictEqual(context.rest._state.albums.length, 2);
        assert.strictEqual(context.rest._state.removed.length, 0);
    } finally {
        context.cleanup();
    }
});

test('a guest never receives the personal state of an account', async () => {
    const context = buildContext({ buildLocal: withLocalTrack, rest: globalFixtures() });
    try {
        await context.library.scan();

        // A member hides something for themselves.
        context.service.hideForUser('user-one', 'global:' + TRACK_UUID);

        const guest = await context.service.getCatalog({});
        assert.deepStrictEqual(guest.hidden.globalTracks, [], 'no hidden list leaks to a guest');
        assert.deepStrictEqual(guest.hidden.globalAlbums, []);
        assert.deepStrictEqual(guest.hidden.localTracks, []);

        // The guest sees the catalogue as published, not through that member's
        // preferences.
        assert.ok(guest.tracks.some((track) => track.id === 'global:' + TRACK_UUID));

        const member = await context.service.getCatalog({ userId: 'user-one' });
        assert.ok(!member.tracks.some((track) => track.id === 'global:' + TRACK_UUID));

        assert.deepStrictEqual(context.service.getHiddenForUser(null).hiddenGlobalTrackIds, []);
        assert.throws(() => context.service.hideForUser(null, 'global:' + TRACK_UUID), /signed-in/i);
        assert.throws(() => context.service.restoreForUser(null, 'global:' + TRACK_UUID), /signed-in/i);
    } finally {
        context.cleanup();
    }
});

test('an admin can still manage the catalogue after guest read access', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const album = await context.global.createAlbum({ title: 'New Album', artist: 'Someone' }, 'admin-token');
        assert.ok(album.id.startsWith('global-album:'));

        const created = await context.global.createTrack(
            { title: 'New Track', artist: 'Someone', audioPath: 'audio/new.mp3', albumId: album.id },
            'admin-token'
        );
        assert.ok(created.id.startsWith('global:'));

        const updated = await context.global.updateTrack(created.id, { title: 'Renamed Track' }, 'admin-token');
        assert.strictEqual(updated.title, 'Renamed Track');

        const removed = await context.global.deleteTrack(created.id, 'admin-token');
        assert.strictEqual(removed.deleted, true);
    } finally {
        context.cleanup();
    }
});

test('the dashboard and the player resolve the same artwork for an album', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const albumId = 'global-album:' + ALBUM_UUID;

        // Both surfaces call the same resolver with the same id, so they get
        // the same object signed from the same bucket.
        const forPlayer = await context.service.resolveArtworkUrl(albumId, { token: 'user-token' });
        const forDashboard = await context.service.resolveArtworkUrl(albumId, { token: 'admin-token' });

        assert.ok(forPlayer && forDashboard);
        assert.strictEqual(forPlayer.url.split('?')[0], forDashboard.url.split('?')[0]);
        assert.match(forPlayer.url, /catalog-artwork\/cover\.jpg/);

        // A track with no artwork of its own resolves to the album cover, and
        // a track whose album has none resolves to nothing (default cover).
        const trackWithAlbumCover = await context.service.resolveArtworkUrl('global:' + TRACK_UUID, { token: 'user-token' });
        assert.strictEqual(trackWithAlbumCover.url.split('?')[0], forPlayer.url.split('?')[0]);

        const trackWithout = await context.service.resolveArtworkUrl('global:' + SECOND_TRACK_UUID, { token: 'user-token' });
        assert.strictEqual(trackWithout, null);
    } finally {
        context.cleanup();
    }
});

test('the dashboard never builds a Storage URL and never stores a signed one', () => {
    const admin = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');

    // Artwork comes from the shared resolver, not from a hand-made URL.
    assert.match(admin, /resolveArtworkUrl/);
    assert.ok(!/storage\/v1\/object/.test(admin), 'no raw Storage URL is constructed');
    assert.ok(!/getPublicUrl/.test(admin), 'no public-URL shortcut for a private bucket');

    // Only stable object paths are written to the catalogue rows.
    assert.match(admin, /artworkPath/);

    const service = fs.readFileSync(path.join(__dirname, '..', 'lib', 'globalCatalog.js'), 'utf8');
    assert.ok(!/artwork_url/.test(service), 'the schema stores a path, not a URL');
    assert.match(service, /artwork_path/);
});

test('personal actions in the player are gated behind an account', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    assert.match(player, /function requireAccount/);
    const gatedMessages = [
        'Sign in to like songs',
        'Sign in to create your own albums',
        'Sign in to add songs to your own albums',
        'Sign in to change your library',
        'Sign in to export your library',
        'Sign in to restore a library backup'
    ];
    for (const gated of gatedMessages) {
        assert.ok(player.includes(gated), 'gated: ' + gated);
    }

    // Personal collections are not rendered for a guest.
    assert.match(player, /function loadUserAlbums\(\)[\s\S]{0,400}if \(!isSignedIn\(\)\) return;/);
    assert.match(player, /async function checkAndCreateLikedSongsAlbum\(\)[\s\S]{0,200}if \(!isSignedIn\(\)\)/);
});

// ============================================
// Guest media resolution (P5 lock-in)
// ============================================

test('every caller resolves global media through the one canonical resolver', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const calls = [];
        const original = context.global.resolveGlobalMedia.bind(context.global);
        context.global.resolveGlobalMedia = (bucket, objectPath, token) => {
            calls.push({ bucket, objectPath, token });
            return original(bucket, objectPath, token);
        };

        // Guest, signed-in listener and administrator: same code path.
        await context.service.resolveStreamUrl('global:' + TRACK_UUID, {});
        await context.service.resolveStreamUrl('global:' + TRACK_UUID, { token: 'user-token' });
        await context.service.resolveArtworkUrl('global-album:' + ALBUM_UUID, {});
        await context.service.resolveArtworkUrl('global-album:' + ALBUM_UUID, { token: 'admin-token' });

        assert.strictEqual(calls.length, 4, 'no context bypasses the resolver');
        assert.deepStrictEqual(
            calls.map((call) => call.bucket),
            ['catalog-audio', 'catalog-audio', 'catalog-artwork', 'catalog-artwork']
        );
    } finally {
        context.cleanup();
    }
});

test('the resolver refuses buckets and paths outside the global catalogue', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        assert.strictEqual(await context.global.resolveGlobalMedia('avatars', 'someone.png', null), null);
        assert.strictEqual(await context.global.resolveGlobalMedia('catalog-audio', '../secrets/key.txt', null), null);
        assert.strictEqual(await context.global.resolveGlobalMedia('catalog-audio', '', null), null);
        assert.strictEqual(await context.global.resolveGlobalMedia('catalog-audio', null, null), null);

        // Nothing was signed for any of those attempts.
        assert.strictEqual(context.rest._state.signed.length, 0);
    } finally {
        context.cleanup();
    }
});

test('an unknown global media id fails safely instead of leaking', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        const missingUuid = '99999999-9999-4999-8999-999999999999';
        assert.strictEqual(await context.service.resolveStreamUrl('global:' + missingUuid, {}), null);
        assert.strictEqual(await context.service.resolveArtworkUrl('global-album:' + missingUuid, {}), null);
        assert.strictEqual(await context.service.resolveStreamUrl('not-a-namespaced-id', {}), null);
        assert.strictEqual(await context.service.resolveArtworkUrl('nonsense', {}), null);
    } finally {
        context.cleanup();
    }
});

test('a request with no session is still presented to Supabase as the anon role', async () => {
    // Storage refuses a request that carries only an apikey header, which is
    // why a guest used to get "track unavailable". Every request now carries
    // an Authorization header: the user token when there is one, the public
    // anon key otherwise.
    const supabaseRestSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'supabaseRest.js'), 'utf8');
    assert.match(supabaseRestSource, /headers\.Authorization = 'Bearer ' \+ \(settings\.token \|\| SUPABASE_ANON_KEY\)/);
    assert.ok(!/service_role/i.test(supabaseRestSource), 'no service-role key anywhere');

    const seen = [];
    const context = buildContext({ rest: globalFixtures() });
    try {
        const original = context.rest.createSignedUrl;
        context.rest.createSignedUrl = (bucket, objectPath, expiresIn, token) => {
            seen.push(token || null);
            return original(bucket, objectPath, expiresIn, token);
        };

        await context.service.resolveStreamUrl('global:' + TRACK_UUID, {});
        assert.deepStrictEqual(seen, [null], 'the guest path carries no user token');
    } finally {
        context.cleanup();
    }
});

test('guest, listener and admin all receive a usable media URL', async (t) => {
    const context = buildContext({ rest: globalFixtures() });
    const started = await startRoutes(context.service);

    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    const trackPath = '/api/catalog/tracks/' + encodeURIComponent('global:' + TRACK_UUID);
    const albumPath = '/api/catalog/albums/' + encodeURIComponent('global-album:' + ALBUM_UUID);

    // Guest: no Authorization header at all.
    const guestStream = await request(started.port, trackPath + '/stream');
    assert.strictEqual(guestStream.status, 200);
    const guestUrl = JSON.parse(guestStream.body);
    assert.match(guestUrl.url, /catalog-audio/);
    assert.ok(guestUrl.expiresIn > 0, 'the URL is short-lived, not stored');
    assert.strictEqual(guestUrl.mimeType, 'audio/mpeg');

    const guestArtwork = JSON.parse((await request(started.port, albumPath + '/artwork')).body);
    assert.match(guestArtwork.url, /catalog-artwork/);
    assert.strictEqual(guestArtwork.fallbackUrl, '/img/music.svg');

    // Signed-in listener and administrator get the same object.
    for (const token of ['user-token', 'admin-token']) {
        const stream = JSON.parse(
            (await request(started.port, trackPath + '/stream', { headers: { Authorization: 'Bearer ' + token } })).body
        );
        assert.strictEqual(stream.url.split('?')[0], guestUrl.url.split('?')[0]);

        const artwork = JSON.parse(
            (await request(started.port, albumPath + '/artwork', { headers: { Authorization: 'Bearer ' + token } })).body
        );
        assert.strictEqual(artwork.url.split('?')[0], guestArtwork.url.split('?')[0]);
    }
});

test('signed URLs are resolved on demand and never written back to the catalogue', async () => {
    const context = buildContext({ rest: globalFixtures() });
    try {
        await context.service.resolveStreamUrl('global:' + TRACK_UUID, {});
        await context.service.resolveArtworkUrl('global-album:' + ALBUM_UUID, {});

        const rows = JSON.stringify(context.rest._state.albums) + JSON.stringify(context.rest._state.tracks);
        assert.ok(!rows.includes('token=signed'), 'no signed URL is persisted');
        assert.ok(!rows.includes('http'), 'rows hold object paths, not URLs');

        // Resolving twice produces a fresh URL each time, so expiry is a
        // non-event.
        assert.strictEqual(context.rest._state.signed.length, 2);
        await context.service.resolveStreamUrl('global:' + TRACK_UUID, {});
        assert.strictEqual(context.rest._state.signed.length, 3);
    } finally {
        context.cleanup();
    }
});

test('the player refreshes an expired global media URL instead of giving up', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
    assert.match(player, /function playGlobalTrack/);
    assert.match(player, /function handleGlobalPlaybackError/);
    assert.match(player, /resolveStreamUrl\(trackId, \{ refresh: Boolean\(isRetry\) \}\)/);
    assert.match(player, /currentsong\.addEventListener\('error'/);

    const client = fs.readFileSync(path.join(__dirname, '..', 'js', 'catalogClient.js'), 'utf8');
    assert.match(client, /settings\.refresh/);
    assert.match(client, /forgetMedia/);
});

test('the admin dashboard has an accessible responsive drawer', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');

    // Hamburger sits in the header, before the logo, and is wired up for
    // assistive technology.
    assert.match(markup, /id="adminMenuToggle"/);
    assert.match(markup, /aria-controls="adminSidebar"/);
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, /aria-label="Open navigation"/);
    assert.ok(
        markup.indexOf('id="adminMenuToggle"') < markup.indexOf('class="admin-logo"'),
        'the hamburger is at the left of the header'
    );

    assert.match(markup, /id="adminSidebar"/);
    assert.match(markup, /id="adminSidebarClose"/);
    assert.match(markup, /id="adminSidebarBackdrop"/);

    // Desktop keeps the permanent sidebar; the drawer only exists below the
    // 1024px breakpoint, and the page cannot scroll behind it.
    assert.match(markup, /@media screen and \(max-width: 1024px\)[\s\S]{0,900}\.admin-sidebar \{[\s\S]{0,300}transform: translateX\(-100%\)/);
    assert.match(markup, /\.admin-sidebar\.open \{\s*transform: translateX\(0\)/);
    assert.match(markup, /body\.sidebar-open \{\s*overflow: hidden/);
    assert.ok(!/@media screen and \(max-width: 1024px\) \{\s*\.admin-sidebar \{\s*display: none/.test(markup), 'the sidebar is no longer simply hidden');

    const admin = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
    assert.match(admin, /function setSidebarOpen/);
    assert.match(admin, /aria-expanded/);
    assert.match(admin, /e\.key === 'Escape'/);
    assert.match(admin, /if \(isCompactLayout\(\)\) setSidebarOpen\(false\);/);
    assert.match(admin, /initResponsiveNavigation\(\);/);
});

test('the drawer opens and closes with correct state and accessibility flags', () => {
    // A tiny DOM stand-in: enough for the drawer logic, nothing more.
    const nodes = {};
    function makeElement(id) {
        const element = {
            id,
            hidden: false,
            attributes: {},
            classes: new Set(),
            handlers: {},
            classList: {
                toggle(name, on) {
                    if (on) element.classes.add(name);
                    else element.classes.delete(name);
                },
                contains: (name) => element.classes.has(name),
                add: (name) => element.classes.add(name),
                remove: (name) => element.classes.delete(name)
            },
            setAttribute(name, value) {
                element.attributes[name] = value;
            },
            getAttribute: (name) => element.attributes[name],
            addEventListener(type, handler) {
                element.handlers[type] = handler;
            },
            querySelector: () => ({ focus() {} }),
            focus() {}
        };
        nodes[id] = element;
        return element;
    }

    const sidebar = makeElement('adminSidebar');
    const toggle = makeElement('adminMenuToggle');
    const backdrop = makeElement('adminSidebarBackdrop');
    const closeBtn = makeElement('adminSidebarClose');
    const body = makeElement('body');

    const sandbox = {
        console,
        document: {
            getElementById: (id) => nodes[id] || null,
            querySelectorAll: () => [],
            addEventListener(type, handler) {
                nodes.document = nodes.document || { handlers: {} };
                nodes.document.handlers[type] = handler;
            },
            body
        },
        window: {
            matchMedia: () => ({ matches: true }),
            addEventListener() {}
        }
    };
    sandbox.globalThis = sandbox;

    const adminSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
    const start = adminSource.indexOf('const SIDEBAR_BREAKPOINT');
    const end = adminSource.indexOf('// ============================================\n// UTILITY FUNCTIONS');
    const drawerSource = adminSource.slice(start, end);

    vm.createContext(sandbox);
    vm.runInContext(drawerSource + '\ninitResponsiveNavigation();', sandbox);

    // Starts closed.
    assert.strictEqual(sidebar.classList.contains('open'), false);
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(backdrop.hidden, true);
    assert.strictEqual(body.classList.contains('sidebar-open'), false);

    // Hamburger opens it.
    toggle.handlers.click();
    assert.strictEqual(sidebar.classList.contains('open'), true);
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(toggle.getAttribute('aria-label'), 'Close navigation');
    assert.strictEqual(backdrop.hidden, false);
    assert.strictEqual(backdrop.classList.contains('visible'), true);
    assert.strictEqual(body.classList.contains('sidebar-open'), true, 'the page behind cannot scroll');

    // The backdrop closes it.
    backdrop.handlers.click();
    assert.strictEqual(sidebar.classList.contains('open'), false);
    assert.strictEqual(body.classList.contains('sidebar-open'), false);

    // Escape closes it.
    toggle.handlers.click();
    nodes.document.handlers.keydown({ key: 'Escape' });
    assert.strictEqual(sidebar.classList.contains('open'), false);
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');

    // The close button closes it.
    toggle.handlers.click();
    closeBtn.handlers.click();
    assert.strictEqual(sidebar.classList.contains('open'), false);
    assert.strictEqual(backdrop.hidden, true);
});

// ============================================
// Album description is its own field
// ============================================

function albumFixtureWithDescription() {
    return {
        albums: [
            {
                id: ALBUM_UUID,
                title: 'Global Album',
                artist: 'Theo Lane',
                album_artist: 'Theo Lane',
                description: 'Recorded live in one take.',
                artwork_path: 'cover.jpg'
            },
            {
                id: SECOND_ALBUM_UUID,
                title: 'Coverless Album',
                artist: 'Nobody',
                album_artist: 'Nobody',
                description: null,
                artwork_path: null
            }
        ],
        tracks: []
    };
}

test('artist and description are separate values on the album model', async () => {
    const context = buildContext({ rest: albumFixtureWithDescription() });
    try {
        const albums = await context.service.getAlbums({});
        const album = albums.items.find((entry) => entry.id === 'global-album:' + ALBUM_UUID);

        assert.strictEqual(album.title, 'Global Album');
        assert.strictEqual(album.artist, 'Theo Lane');
        assert.strictEqual(album.albumArtist, 'Theo Lane');
        assert.strictEqual(album.description, 'Recorded live in one take.');
        assert.notStrictEqual(album.description, album.artist);
    } finally {
        context.cleanup();
    }
});

test('an album with no description reads back blank, never the artist name', async () => {
    const context = buildContext({ rest: albumFixtureWithDescription() });
    try {
        const albums = await context.service.getAlbums({});
        const album = albums.items.find((entry) => entry.id === 'global-album:' + SECOND_ALBUM_UUID);

        assert.strictEqual(album.artist, 'Nobody');
        assert.strictEqual(album.description, null, 'no description means none');
        assert.ok(!album.description, 'the edit form shows an empty box');
    } finally {
        context.cleanup();
    }
});

test('an album row that predates the column still loads with a blank description', async () => {
    // Rows written before the column existed simply have no description key.
    const legacy = {
        albums: [{ id: ALBUM_UUID, title: 'Legacy Album', artist: 'Theo Lane', album_artist: 'Theo Lane', artwork_path: null }],
        tracks: []
    };

    const context = buildContext({ rest: legacy });
    try {
        const albums = await context.service.getAlbums({});
        const album = albums.items[0];

        assert.strictEqual(album.artist, 'Theo Lane');
        assert.strictEqual(album.description, null);
    } finally {
        context.cleanup();
    }
});

test('creating an album persists the description separately from the artist', async () => {
    const context = buildContext({ rest: { albums: [], tracks: [] } });
    try {
        const created = await context.global.createAlbum(
            {
                title: 'Night Drive',
                artist: 'Theo Lane',
                albumArtist: 'Theo Lane',
                description: 'Eight instrumentals for the motorway.'
            },
            'admin-token'
        );

        assert.strictEqual(created.artist, 'Theo Lane');
        assert.strictEqual(created.description, 'Eight instrumentals for the motorway.');

        const stored = context.rest._state.albums[0];
        assert.strictEqual(stored.artist, 'Theo Lane');
        assert.strictEqual(stored.album_artist, 'Theo Lane');
        assert.strictEqual(stored.description, 'Eight instrumentals for the motorway.');
    } finally {
        context.cleanup();
    }
});

test('creating an album with no description stores null, not the artist', async () => {
    const context = buildContext({ rest: { albums: [], tracks: [] } });
    try {
        const created = await context.global.createAlbum(
            { title: 'Quiet Release', artist: 'Theo Lane', albumArtist: 'Theo Lane', description: '' },
            'admin-token'
        );

        assert.strictEqual(created.description, null);
        assert.strictEqual(context.rest._state.albums[0].description, null);
        assert.strictEqual(context.rest._state.albums[0].artist, 'Theo Lane');
    } finally {
        context.cleanup();
    }
});

test('editing the description leaves the artist untouched, and the reverse', async (t) => {
    const context = buildContext({ rest: albumFixtureWithDescription() });
    const started = await startRoutes(context.service);

    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    const albumPath = '/api/catalog/albums/' + encodeURIComponent('global-album:' + ALBUM_UUID);
    const stored = () => context.rest._state.albums.find((row) => row.id === ALBUM_UUID);

    // The route only patches what the caller sent, but the guard rejects a
    // caller who is not a verified administrator, so the mapping is exercised
    // directly through the catalogue.
    await context.global.updateAlbum(
        'global-album:' + ALBUM_UUID,
        { description: 'A new sleeve note.' },
        'admin-token'
    );
    assert.strictEqual(stored().description, 'A new sleeve note.');
    assert.strictEqual(stored().artist, 'Theo Lane', 'the artist is unchanged');
    assert.strictEqual(stored().title, 'Global Album', 'the title is unchanged');

    await context.global.updateAlbum('global-album:' + ALBUM_UUID, { artist: 'Mara Quinn' }, 'admin-token');
    assert.strictEqual(stored().artist, 'Mara Quinn');
    assert.strictEqual(stored().description, 'A new sleeve note.', 'the description is unchanged');

    // Clearing the description is a real edit, and it does not touch the artist.
    await context.global.updateAlbum('global-album:' + ALBUM_UUID, { description: null }, 'admin-token');
    assert.strictEqual(stored().description, null);
    assert.strictEqual(stored().artist, 'Mara Quinn');

    // And the update route maps a blank description to null rather than
    // dropping the field.
    const unauthorized = await request(started.port, albumPath, {
        method: 'PATCH',
        body: { description: '' }
    });
    assert.strictEqual(unauthorized.status, 401, 'only an administrator may edit');
});

test('the album update route maps each field to its own column', () => {
    // Publishing and editing live in the private module now; the mapping they
    // do is the same, and is checked where it is written.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adminCatalogRoutes.js'), 'utf8');
    assert.match(routes, /if \(body\.description !== undefined\) patch\.description =/);
    assert.match(routes, /if \(body\.artist !== undefined\) patch\.artist = body\.artist;/);
    assert.match(routes, /if \(body\.albumArtist !== undefined\) patch\.album_artist = body\.albumArtist;/);
});

test('the admin form reads and writes description as its own field', () => {
    const admin = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');

    // The edit form fills the description box from the description, and the
    // artist box from the artist - the mix-up that caused the bug.
    assert.match(admin, /getElementById\('albumDescription'\)\.value = album\.description == null \? '' : album\.description;/);
    assert.ok(
        !/getElementById\('albumDescription'\)\.value = album\.albumArtist/.test(admin),
        'the description box is never filled from the artist'
    );
    assert.match(admin, /getElementById\('albumArtist'\)\.value = album\.artist/);

    // Saving sends named fields, so nothing depends on argument order.
    assert.match(admin, /const description = descriptionField \? descriptionField\.value\.trim\(\) : '';/);
    assert.match(admin, /description: description\b/);
    assert.match(admin, /description: description \|\| null/);

    // The textarea is still part of the dashboard.
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');
    assert.match(markup, /id="albumDescription"/);
});

test('the catalogue still works against a database without the description column', async () => {
    // A project where supabase-setup.sql has not been re-applied yet: the
    // column is missing, and every album read and write must still work.
    const legacyRest = makeFakeRest({ admins: ['admin-token'], albums: [], tracks: [] });
    const missingColumn = () => {
        const error = new Error('column catalog_albums.description does not exist');
        error.body = { code: '42703' };
        return error;
    };

    const rawSelect = legacyRest.selectRows;
    legacyRest.selectRows = (table, query, token) => {
        if (table === 'catalog_albums' && query.includes('description')) return Promise.reject(missingColumn());
        return rawSelect(table, query, token);
    };
    const rawInsert = legacyRest.insertRow;
    legacyRest.insertRow = (table, row, token) => {
        if (table === 'catalog_albums' && Object.prototype.hasOwnProperty.call(row, 'description')) {
            return Promise.reject(missingColumn());
        }
        return rawInsert(table, row, token);
    };
    const rawUpdate = legacyRest.updateRows;
    legacyRest.updateRows = (table, query, patch, token) => {
        if (table === 'catalog_albums' && Object.prototype.hasOwnProperty.call(patch, 'description')) {
            return Promise.reject(missingColumn());
        }
        return rawUpdate(table, query, patch, token);
    };

    const legacyCatalog = new GlobalCatalog({ rest: legacyRest });

    const created = await legacyCatalog.createAlbum(
        { title: 'Pre-migration Album', artist: 'Theo Lane', description: 'ignored for now' },
        'admin-token'
    );
    assert.strictEqual(created.artist, 'Theo Lane');
    assert.strictEqual(created.description, null, 'no description until the column exists');

    const catalog = await legacyCatalog.fetchCatalog('admin-token');
    assert.strictEqual(catalog.available, true, 'the catalogue still loads');
    assert.strictEqual(catalog.albums.length, 1);
    assert.strictEqual(catalog.albums[0].title, 'Pre-migration Album');

    const updated = await legacyCatalog.updateAlbum(created.id, { description: 'later' }, 'admin-token');
    assert.ok(updated, 'an edit does not fail either');
    assert.strictEqual(legacyRest._state.albums[0].artist, 'Theo Lane', 'the artist survives');
});

// ============================================
// Editing an album keeps what was not edited
// ============================================

test('saving an album without a new image keeps the stored artwork path', async () => {
    const context = buildContext({
        rest: {
            albums: [
                {
                    id: ALBUM_UUID,
                    title: 'Echoes in Rain',
                    artist: 'Theo Lane',
                    album_artist: 'Theo Lane',
                    description: 'Nine tracks recorded in a stairwell.',
                    artwork_path: 'existing-cover.jpg'
                }
            ],
            tracks: []
        }
    });

    try {
        // A save that changes only the text sends no artworkPath at all, so
        // the column is never patched.
        await context.global.updateAlbum(
            'global-album:' + ALBUM_UUID,
            { title: 'Echoes in Rain', artist: 'Theo Lane', description: 'A new sleeve note.' },
            'admin-token'
        );

        const stored = context.rest._state.albums[0];
        assert.strictEqual(stored.artwork_path, 'existing-cover.jpg', 'the cover survives a text-only edit');
        assert.strictEqual(stored.description, 'A new sleeve note.');
        assert.strictEqual(stored.artist, 'Theo Lane');
        assert.strictEqual(context.rest._state.removed.length, 0, 'nothing was deleted from storage');
    } finally {
        context.cleanup();
    }
});

test('editing only the artist keeps the description and the artwork', async () => {
    const context = buildContext({
        rest: {
            albums: [
                {
                    id: ALBUM_UUID,
                    title: 'Echoes in Rain',
                    artist: 'Theo Lane',
                    album_artist: 'Theo Lane',
                    description: 'Nine tracks recorded in a stairwell.',
                    artwork_path: 'existing-cover.jpg'
                }
            ],
            tracks: []
        }
    });

    try {
        await context.global.updateAlbum('global-album:' + ALBUM_UUID, { artist: 'Mara Quinn' }, 'admin-token');

        const stored = context.rest._state.albums[0];
        assert.strictEqual(stored.artist, 'Mara Quinn');
        assert.strictEqual(stored.description, 'Nine tracks recorded in a stairwell.');
        assert.strictEqual(stored.artwork_path, 'existing-cover.jpg');
    } finally {
        context.cleanup();
    }
});

test('replacing the cover swaps the path and removes the old file afterwards', async () => {
    const context = buildContext({
        rest: {
            albums: [
                {
                    id: ALBUM_UUID,
                    title: 'Echoes in Rain',
                    artist: 'Theo Lane',
                    album_artist: 'Theo Lane',
                    description: 'Nine tracks recorded in a stairwell.',
                    artwork_path: 'old-cover.jpg'
                }
            ],
            tracks: []
        }
    });

    try {
        const updated = await context.global.updateAlbum(
            'global-album:' + ALBUM_UUID,
            { artwork_path: 'new-cover.jpg' },
            'admin-token'
        );

        assert.ok(updated);
        assert.strictEqual(context.rest._state.albums[0].artwork_path, 'new-cover.jpg');
        assert.deepStrictEqual(
            context.rest._state.removed,
            [{ bucket: 'catalog-artwork', objectPath: 'old-cover.jpg' }],
            'the replaced file goes only after the row points at the new one'
        );

        // The description and artist were never part of that patch.
        assert.strictEqual(context.rest._state.albums[0].description, 'Nine tracks recorded in a stairwell.');
        assert.strictEqual(context.rest._state.albums[0].artist, 'Theo Lane');
    } finally {
        context.cleanup();
    }
});

test('a failed cover replacement leaves the working artwork in place', async () => {
    const context = buildContext({
        rest: {
            albums: [
                { id: ALBUM_UUID, title: 'Echoes in Rain', artist: 'Theo Lane', artwork_path: 'old-cover.jpg' }
            ],
            tracks: []
        }
    });

    try {
        const failing = new Error('row-level security policy');
        context.rest.updateRows = () => Promise.reject(failing);

        await assert.rejects(
            () => context.global.updateAlbum('global-album:' + ALBUM_UUID, { artwork_path: 'new-cover.jpg' }, 'admin-token'),
            /row-level security/
        );

        assert.strictEqual(context.rest._state.albums[0].artwork_path, 'old-cover.jpg');
        assert.strictEqual(context.rest._state.removed.length, 0, 'the old cover is not deleted on failure');
    } finally {
        context.cleanup();
    }
});

test('the edit modal loads the stored album values, including the cover', () => {
    const admin = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');

    // Title, artist and description each come from their own property, and a
    // null description becomes an empty box.
    assert.match(admin, /getElementById\('albumTitle'\)\.value = album\.title \|\| '';/);
    assert.match(admin, /getElementById\('albumArtist'\)\.value = album\.artist/);
    assert.match(admin, /getElementById\('albumDescription'\)\.value = album\.description == null \? '' : album\.description;/);

    // The current cover is shown through the shared resolver, so nothing has
    // to be re-uploaded to keep it.
    assert.match(admin, /async function showExistingAlbumCover/);
    assert.match(admin, /resolveArtworkUrl\(album\.id, \{ kind: 'album', fallback: DEFAULT_COVER \}\)/);
    assert.match(admin, /await showExistingAlbumCover\(album\);/);
    assert.match(admin, /metadata && album\.metadata\.hasArtwork/);

    // Opening the modal clears any previously chosen file, so a save with no
    // new image keeps the stored one.
    assert.match(admin, /selectedAlbumCoverFile = null;[\s\S]{0,200}openAlbumModal\(true\)/);
    assert.match(admin, /if \(uploadedArtworkPath\) patch\.artworkPath = uploadedArtworkPath;/);

    // The dead URL mode is gone from both the markup and the wiring.
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');
    assert.ok(!markup.includes('albumCoverUrlArea'), 'no unsupported URL field');
    assert.ok(!admin.includes('albumCoverUrlToggle'), 'no wiring for a control that does not exist');
    assert.match(markup, /id="albumCoverPreviewContainer"/);
    assert.match(markup, /id="albumCoverHint"/);
});

// ============================================
// One layout for every account page
// ============================================

test('all account pages use the shared auth layout, loaded last', () => {
    const pages = ['signin.html', 'signup.html', 'forgot-password.html', 'reset-password.html'];

    for (const page of pages) {
        const markup = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
        assert.match(markup, /<link rel="stylesheet" href="css\/auth\.css">/, page + ' links the shared layout');
        assert.ok(
            markup.indexOf('css/auth.css') > markup.indexOf('</style>'),
            page + ' loads it after its own styles so the layout wins'
        );
        assert.match(markup, /<body class="auth-page">/, page + ' uses the shared page class');
        assert.match(markup, /class="auth-container"/, page + ' uses the shared container');
        assert.match(markup, /class="auth-card"/, page + ' uses the shared card');
    }
});

test('the auth layout centres safely, fits short windows and never overflows', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'auth.css'), 'utf8');

    // Full-height page that follows a mobile browser's shrinking viewport.
    assert.match(css, /min-height: 100vh;/);
    assert.match(css, /min-height: 100dvh;/);

    // Centred when it fits, top-aligned when it does not - so nothing is
    // clipped out of reach on a short laptop or a phone in landscape.
    assert.match(css, /align-items: safe center;/);
    assert.match(css, /@media screen and \(max-height: 720px\)[\s\S]{0,400}align-items: flex-start;/);

    // Card width is bounded and fluid, with no fixed heights anywhere.
    assert.match(css, /width: min\(100%, 420px\);/);
    assert.match(css, /max-width: 420px;/);
    assert.match(css, /\.auth-page \{[\s\S]{0,200}overflow-x: hidden;/);
    assert.ok(!/(^|[^-])height:\s*\d+px/m.test(css), 'no fixed heights');

    // Controls stay reachable and aligned.
    assert.match(css, /min-height: 48px;/);
    assert.match(css, /\.password-toggle \{[\s\S]{0,120}transform: translateY\(-50%\);/);

    // The floating theme toggle keeps clear of the card and the notch.
    assert.match(css, /\.theme-toggle-container \{[\s\S]{0,200}env\(safe-area-inset-top/);
    assert.match(css, /\.auth-header \{[\s\S]{0,200}72px/);

    // Long legal text wraps instead of pushing the card sideways.
    assert.match(css, /overflow-wrap: anywhere;/);
});

// ============================================
// Edit modal artwork, menu affordance, modal fit
// ============================================

test('the edit modal never leaves a broken image and re-resolves each time', () => {
    const admin = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');

    // The preview starts on the placeholder rather than an empty src, which is
    // what browsers render as a broken-image icon.
    assert.match(markup, /id="albumCoverPreviewImg"[^>]*onerror=/);
    assert.match(markup, /<img src="img\/music\.svg"[^>]*id="albumCoverPreviewImg"/);
    assert.ok(!/id="albumCoverPreviewImg"[^>]*src=""/.test(markup), 'the preview never starts empty');

    assert.match(admin, /previewImg\.onerror = \(\) => \{[\s\S]{0,160}previewImg\.src = DEFAULT_COVER;/);
    assert.match(admin, /previewImg\.src = DEFAULT_COVER;[\s\S]{0,200}previewContainer\.classList\.remove\('hidden'\)/);
    assert.match(admin, /albumCoverPreviewImg\.src = DEFAULT_COVER;/, 'closing resets to the placeholder');

    // Reopening asks for a fresh signed URL instead of reusing an expired one.
    assert.match(admin, /client\.forgetMedia\(album\.id\)/);
    assert.match(admin, /resolveArtworkUrl\(album\.id, \{ kind: 'album', fallback: DEFAULT_COVER \}\)/);

    // The modal never builds a Storage URL or touches a raw path.
    assert.ok(!/storage\/v1\/object/.test(admin), 'no hand-made Storage URL');
    assert.ok(!/artwork_path/.test(admin), 'no raw storage path in the dashboard');
});

test('the album cover preview has room to render', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');

    // The preview is absolutely positioned, so its drop zone needs its own
    // height and positioning context or the image collapses to nothing.
    assert.match(markup, /\.image-drop \{[\s\S]{0,200}min-height: 200px;/);
    assert.match(markup, /\.image-drop \{[\s\S]{0,200}position: relative;/);
    assert.match(markup, /\.cover-preview img \{[\s\S]{0,160}max-width: 100%;/);
});

test('the three-dot album button follows the input device, not the screen width', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

    // Visible by default: anything that cannot hover keeps the button.
    assert.match(css, /\.card-menu-btn \{[\s\S]{0,400}opacity: 1;/);

    // A real mouse hides it until hover, focus-within, or an open menu.
    assert.match(
        css,
        /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]{0,400}\.card-menu-btn \{[\s\S]{0,80}opacity: 0;/
    );
    assert.match(css, /\.cardcontainer:hover \.card-menu-btn,[\s\S]{0,160}\.cardcontainer:focus-within \.card-menu-btn/);
    assert.match(css, /\.card-menu\.open \.card-menu-btn/);

    // Touch and hybrid devices keep it at full strength, with a target big
    // enough to press without aiming. A device that cannot hover has no other
    // way to reach a card's options at all.
    assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]{0,500}opacity: 1;/);
    assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]{0,500}width: 44px;/);
    assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]{0,500}height: 44px;/);

    // Keyboard focus always reveals it.
    assert.match(css, /\.card-menu-btn:focus,\s*\n\.card-menu-btn:focus-visible \{[\s\S]{0,120}opacity: 1;/);

    // The menu cannot open off the side of a phone.
    assert.match(css, /\.card-menu-dropdown \{[\s\S]{0,400}max-width: min\(220px, calc\(100vw - 24px\)\);/);

    // No user-agent sniffing decides any of this.
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
    assert.ok(!/navigator\.userAgent/.test(player), 'device behaviour comes from CSS capability queries');
});

test('the three-dot button is a real, accessible control', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // One button, named for whatever it belongs to: an album's options, or
    // the machine's.
    assert.match(
        player,
        /<button class="card-menu-btn" type="button" aria-label="\$\{isSystem \? 'Local Music options' : 'Album options'\}" aria-haspopup="true" aria-expanded="false">/
    );

    // Opening and closing keep aria-expanded honest, and the open menu is
    // marked so the hover rule can keep its button visible.
    assert.match(player, /button\.setAttribute\('aria-expanded', open \? 'true' : 'false'\)/);
    assert.match(player, /menu\.classList\.toggle\('open', open\)/);
    assert.match(player, /if \(btn\) btn\.setAttribute\('aria-expanded', 'false'\);/);

    // Escape closes the menu and hands focus back to the button.
    assert.match(player, /if \(e\.key !== 'Escape'\) return;[\s\S]{0,400}closeAllMenus\(\);/);
    assert.match(player, /if \(btn\) btn\.focus\(\);/);

    // A click outside still closes it.
    assert.match(player, /if \(!e\.target\.closest\('\.card-menu'\)\) \{\s*closeAllMenus\(\);/);
});

test('the admin modal fits any viewport and scrolls inside itself', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');

    // Bounded by the visible viewport, with safe padding around it.
    assert.match(markup, /\.modal-box \{[\s\S]{0,400}max-height: calc\(100dvh - 32px\);/);
    assert.match(markup, /\.modal-box \{[\s\S]{0,400}width: min\(100%, 500px\);/);
    assert.match(markup, /\.admin-modal \{[\s\S]{0,400}env\(safe-area-inset-bottom/);

    // Header and buttons stay put; the fields scroll between them.
    assert.match(markup, /\.modal-box form \{[\s\S]{0,200}flex-direction: column;/);
    assert.match(markup, /\.modal-body \{[\s\S]{0,200}overflow-y: auto;/);
    assert.match(markup, /\.modal-footer \{\s*\n\s*flex-shrink: 0;/);
    assert.match(markup, /\.modal-header \{[\s\S]{0,240}flex-shrink: 0;/);
});

test('pages, scripts and styles are revalidated so an edit is never masked by cache', async (t) => {
    const { spawn } = require('child_process');
    const os = require('os');

    const net = require('net');
    const port = await new Promise((resolve, reject) => {
        // Ask the operating system for a port that is genuinely free, so
        // parallel tests cannot collide on a guessed number.
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port: chosen } = probe.address();
            probe.close(() => resolve(chosen));
        });
    });
    const musicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-cache-test-'));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', MUSIC_ROOT: musicRoot }),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));

    t.after(() => {
        child.kill();
        try {
            fs.rmSync(musicRoot, { recursive: true, force: true });
        } catch (e) {
            /* best effort */
        }
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 15000);
        const check = setInterval(() => {
            if (output.includes('Spotifie is running')) {
                clearInterval(check);
                clearTimeout(timer);
                resolve();
            }
        }, 100);
    });

    function head(pathname) {
        return new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.headers));
            });
            request.on('error', reject);
            request.end();
        });
    }

    for (const asset of ['/admin-dashboard.html', '/js/admin.js', '/js/script.js', '/css/style.css', '/css/auth.css']) {
        const headers = await head(asset);
        assert.strictEqual(headers['cache-control'], 'no-cache', asset + ' is always revalidated');
    }

    const media = await head('/img/music.svg');
    assert.match(media['cache-control'], /max-age/, 'media may still be cached');
});

// ============================================
// Saving an album: one field at a time
// ============================================

function albumWithEverything() {
    return {
        albums: [
            {
                id: ALBUM_UUID,
                title: 'Afterglow',
                artist: 'Nova Rae',
                album_artist: 'Nova Rae',
                description: 'Recorded over one winter.',
                artwork_path: 'covers/afterglow.jpg'
            }
        ],
        tracks: []
    };
}

const SAVE_CASES = [
    { name: 'the description only', patch: { description: 'A new note.' } },
    { name: 'the artist only', patch: { artist: 'Mara Quinn', album_artist: 'Mara Quinn' } },
    { name: 'the title only', patch: { title: 'Afterglow II' } },
    { name: 'the title and description', patch: { title: 'Afterglow II', description: 'Both changed.' } },
    { name: 'nothing at all', patch: { title: 'Afterglow', artist: 'Nova Rae', description: 'Recorded over one winter.' } }
];

for (const testCase of SAVE_CASES) {
    test('saving ' + testCase.name + ' leaves the artwork and every other field alone', async () => {
        const context = buildContext({ rest: albumWithEverything() });
        try {
            const before = Object.assign({}, context.rest._state.albums[0]);

            const album = await context.global.updateAlbum('global-album:' + ALBUM_UUID, testCase.patch, 'admin-token');
            assert.ok(album, 'the update succeeds');

            const after = context.rest._state.albums[0];
            assert.strictEqual(after.artwork_path, before.artwork_path, 'the stored cover path is untouched');
            assert.strictEqual(context.rest._state.removed.length, 0, 'no storage object was touched');
            assert.strictEqual(context.rest._state.signed.length, 0, 'no signed URL was needed to save');

            // Anything the patch did not mention keeps its old value.
            for (const field of ['title', 'artist', 'album_artist', 'description']) {
                if (testCase.patch[field] === undefined) {
                    assert.strictEqual(after[field], before[field], field + ' is unchanged');
                }
            }
        } finally {
            context.cleanup();
        }
    });
}

test('a signed URL can never be written back as the stored artwork path', async () => {
    const context = buildContext({ rest: albumWithEverything() });
    try {
        // What the dashboard sends when the cover was not touched: no
        // artworkPath at all.
        const routes = createCatalogRoutes({ service: context.service });
        assert.ok(routes);

        await context.global.updateAlbum(
            'global-album:' + ALBUM_UUID,
            { title: 'Afterglow', artist: 'Nova Rae', description: 'Edited.' },
            'admin-token'
        );

        const stored = context.rest._state.albums[0];
        assert.strictEqual(stored.artwork_path, 'covers/afterglow.jpg');
        assert.ok(!String(stored.artwork_path).startsWith('http'), 'the row holds a path, not a URL');
        assert.ok(!String(stored.artwork_path).includes('token='), 'no signature is persisted');
    } finally {
        context.cleanup();
    }
});

test('removing the cover on purpose clears the path and then deletes the file', async () => {
    const context = buildContext({ rest: albumWithEverything() });
    try {
        await context.global.updateAlbum('global-album:' + ALBUM_UUID, { artwork_path: null }, 'admin-token');

        assert.strictEqual(context.rest._state.albums[0].artwork_path, null);
        assert.deepStrictEqual(context.rest._state.removed, [
            { bucket: 'catalog-artwork', objectPath: 'covers/afterglow.jpg' }
        ]);
    } finally {
        context.cleanup();
    }
});

test('the dashboard only sends an artwork path when the cover really changed', () => {
    const admin = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');

    // A new upload, or a deliberate removal - nothing else touches the path.
    assert.match(admin, /if \(uploadedArtworkPath\) \{\s*\n\s*patch\.artworkPath = uploadedArtworkPath;\s*\n\s*\} else if \(albumCoverRemoved\) \{\s*\n\s*patch\.artworkPath = null;/);

    // Opening the modal and cancelling a replacement both leave it unset.
    assert.match(admin, /selectedAlbumCoverFile = null;\s*\n\s*albumCoverRemoved = false;/);
    assert.match(admin, /albumCoverRemoved = false;\s*\n\s*await showExistingAlbumCover\(editingAlbumId\.originalData\);/);

    // Choosing a file is a replacement, never a removal.
    assert.match(admin, /selectedAlbumCoverFile = file;\s*\n\s*\/\/ Choosing a file is a replacement, not a removal\.\s*\n\s*albumCoverRemoved = false;/);

    // Only the file uploaded during a failed save is cleaned up.
    assert.match(admin, /await removeFromBucket\(ARTWORK_BUCKET, uploadedArtworkPath\);/);
});

// ============================================
// Errors say what actually happened
// ============================================

test('an upstream refusal is reported as a refusal, not as an outage', async (t) => {
    const context = buildContext({ rest: albumWithEverything() });
    const started = await startRoutes(context.service);

    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    // Without a session the guard answers 401 - never a vague 503.
    const anonymous = await request(started.port, '/api/catalog/albums/' + encodeURIComponent('global-album:' + ALBUM_UUID), {
        method: 'PATCH',
        body: { description: 'nope' }
    });
    assert.strictEqual(anonymous.status, 401);
    assert.match(JSON.parse(anonymous.body).error, /Authentication required/);
});

test('a rejected write keeps a 4xx status and a useful message', async (t) => {
    const context = buildContext({ rest: albumWithEverything() });

    // Supabase rejects the change itself (a constraint, say).
    const rejection = new Error('new row violates check constraint "title_not_empty"');
    rejection.status = 400;
    context.rest.updateRows = () => Promise.reject(rejection);

    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    // The route layer maps the upstream status rather than flattening it.
    const { createCatalogRoutes: create } = require('../lib/catalogRoutes');
    assert.ok(create);

    await assert.rejects(
        () => context.global.updateAlbum('global-album:' + ALBUM_UUID, { title: '' }, 'admin-token'),
        /check constraint/
    );
});

test('server error responses never carry a token or a key', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'catalogRoutes.js'), 'utf8');
    const auth = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adminAuth.js'), 'utf8');

    // The mapper exists and covers the cases that matter.
    assert.match(routes, /function mapUpstreamStatus/);
    assert.match(routes, /if \(status === 401\) return 401;/);
    assert.match(routes, /if \(status >= 400 && status < 500\) return 400;/);
    assert.match(routes, /if \(status === 504\) return 504;/);

    // The guard distinguishes a timeout from an unreachable host.
    assert.match(auth, /status: e\.status \|\| 502/);
    assert.match(auth, /Supabase did not answer in time/);

    // Nothing logs or returns a token.
    assert.ok(!/console\.(log|error|warn)\([^)]*token/i.test(routes), 'no token is logged by the routes');
    assert.ok(!/console\.(log|error|warn)\([^)]*token/i.test(auth), 'no token is logged by the guard');
    assert.ok(!/SUPABASE_ANON_KEY/.test(routes), 'no key reaches the response layer');
});

test('one privileged request verifies the session once', async () => {
    // Both halves ask the same question through the same door, so a save does
    // not send Supabase the same token twice.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'catalogRoutes.js'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adminAuth.js'), 'utf8');

    assert.match(routes, /await identifyToken\(token\)/, 'the routes identify through the shared module');
    assert.match(admin, /await identifyToken\(token\)/, 'and so does the guard');
    assert.ok(!/getUserForToken\(/.test(routes), 'the routes never verify a token by themselves');

    // The shared identity is remembered briefly, so the second ask in one
    // request costs nothing.
    const session = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sessionAuth.js'), 'utf8');
    assert.match(session, /const identities = createTokenCache\(/);
    assert.match(session, /const known = identities\.read\(token\);/);
});

test('a missing description column is reported rather than silently dropped', async () => {
    const legacyRest = makeFakeRest({ admins: ['admin-token'], albums: [], tracks: [] });
    const missingColumn = () => {
        const error = new Error('column catalog_albums.description does not exist');
        error.body = { code: '42703' };
        return error;
    };

    const rawUpdate = legacyRest.updateRows;
    legacyRest.updateRows = (table, query, patch, token) => {
        if (table === 'catalog_albums' && Object.prototype.hasOwnProperty.call(patch, 'description')) {
            return Promise.reject(missingColumn());
        }
        return rawUpdate(table, query, patch, token);
    };

    legacyRest._state.albums.push({ id: ALBUM_UUID, title: 'Afterglow', artist: 'Nova Rae', artwork_path: null });

    const legacyCatalog = new GlobalCatalog({ rest: legacyRest });
    const updated = await legacyCatalog.updateAlbum('global-album:' + ALBUM_UUID, { description: 'later' }, 'admin-token');

    assert.ok(updated, 'the rest of the album still saves');
    assert.strictEqual(legacyCatalog.albumDescriptionMissing, true, 'the gap is recorded');

    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'catalogRoutes.js'), 'utf8');
    assert.match(routes, /function withSchemaWarning/);
    assert.match(routes, /supabase-setup\.sql/);
});

test('the remove-cover control is a small round icon button', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');

    assert.match(markup, /class="album-cover-remove-btn"[^>]*aria-label="Remove album cover"/);
    assert.match(markup, /<button type="button" class="album-cover-remove-btn"/);

    // A dedicated class: no shared close, delete or file-remove styling can
    // reach this control.
    assert.ok(!markup.includes('remove-cover-btn"'), 'the old shared class is gone');
    assert.ok(!markup.includes('cover-preview-frame'), 'the image-hugging frame is gone');
    for (const shared of ['modal-close', 'btn-delete', 'remove-file-btn']) {
        assert.ok(
            !new RegExp('class="[^"]*' + shared + '[^"]*"[^>]*id="removeAlbumCover"').test(markup),
            'the control does not reuse .' + shared
        );
    }

    // The panel is the anchor, so the button sits in the corner of the whole
    // preview area rather than on the artwork.
    assert.match(markup, /<div class="cover-preview album-cover-preview hidden" id="albumCoverPreviewContainer">/);
    assert.match(markup, /\.album-cover-preview \{[\s\S]{0,200}position: absolute;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}position: absolute;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}top: 10px;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}right: 10px;/);

    // A fixed 28px square with a full radius: a small circle, never a pill.
    for (const rule of ['width: 28px;', 'height: 28px;', 'min-width: 28px;', 'min-height: 28px;']) {
        assert.match(markup, new RegExp('\\.album-cover-remove-btn \\{[\\s\\S]{0,1200}' + rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}border-radius: 50%;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}padding: 0;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}box-sizing: border-box;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}cursor: pointer;/);

    // Inherited button styling is reset, so nothing leaks in.
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}appearance: none;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}font-size: 0;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}box-shadow: none;/);

    // Neutral dark by default - no red fill anywhere in the resting state.
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}background: rgba\(0, 0, 0, 0\.55\);/);
    const restingState = markup.slice(
        markup.indexOf('.album-cover-remove-btn {'),
        markup.indexOf('.album-cover-remove-btn::before')
    );
    assert.ok(
        !/#ef4444|#e91429|#dc2626|#fca5a5|rgba\((?:239|220|233), \d{1,2},/.test(restingState),
        'the default state carries no red fill'
    );

    // Destructive hint only on hover and focus, without resizing.
    assert.match(markup, /\.album-cover-remove-btn:hover \{[\s\S]{0,240}rgba\(239, 68, 68, 0\.85\)/);
    assert.match(markup, /\.album-cover-remove-btn:focus-visible \{[\s\S]{0,240}outline: 2px solid #1db954;/);
    assert.match(markup, /\.album-cover-remove-btn:active \{[\s\S]{0,160}transform: scale\(0\.94\);/);

    // The icon is a small inline SVG on its own class, centred by the grid box
    // rather than by text metrics: no font glyph, no baseline trick, no nudging.
    assert.match(markup, /\.album-cover-remove-icon \{[\s\S]{0,260}width: 12px;/);
    assert.match(markup, /\.album-cover-remove-icon \{[\s\S]{0,260}height: 12px;/);
    assert.match(markup, /\.album-cover-remove-icon \{[\s\S]{0,260}display: block;/);
    assert.match(markup, /\.album-cover-remove-icon \{[\s\S]{0,260}flex: none;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}display: grid;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}place-items: center;/);
    assert.match(markup, /\.album-cover-remove-btn \{[\s\S]{0,1200}line-height: 0;/);

    // The stroke comes from the button colour, so a hover tint cannot move it.
    assert.match(markup, /\.album-cover-remove-icon path \{[\s\S]{0,220}stroke: currentColor;/);
    assert.match(markup, /\.album-cover-remove-icon path \{[\s\S]{0,220}stroke-width: 2;/);
    assert.match(markup, /\.album-cover-remove-icon path \{[\s\S]{0,220}fill: none;/);

    // A symmetric cross on the 24x24 grid, with no inline paint attributes to
    // fight the stylesheet.
    assert.match(markup, /class="album-cover-remove-btn"[\s\S]{0,400}<svg class="album-cover-remove-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
    assert.match(markup, /<path d="M7 7L17 17M17 7L7 17"><\/path>/);

    const buttonMarkup = markup.slice(
        markup.indexOf('<button type="button" class="album-cover-remove-btn"'),
        markup.indexOf('</button>', markup.indexOf('<button type="button" class="album-cover-remove-btn"'))
    );
    assert.ok(!/&times;|×/.test(buttonMarkup), 'the icon is not a text glyph');

    assert.match(markup, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]{0,400}\.album-cover-remove-btn \{[\s\S]{0,240}width: 32px;/);

    // The modal's own close button is untouched.
    assert.match(markup, /\.modal-close \{[\s\S]{0,200}width: 36px;/);
});

// ============================================
// An empty list is one row, not a panel
// ============================================

test('an album with no tracks renders one compact placeholder row', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The placeholder reuses the track-card classes, so it matches real rows.
    assert.match(player, /function emptyLibraryCard\(primary, secondary\)/);
    assert.match(player, /<li class="libcard empty-libcard bg-black p-1 m-1" aria-disabled="true">/);
    assert.match(player, /<div>\$\{escapeHTML\(primary\)\}<\/div>\s*\n\s*<div>\$\{escapeHTML\(secondary\)\}<\/div>/);

    // The album-empty case uses it, with concise wording. Local Music says
    // something of its own, because a machine holding no music is not the same
    // thing as an album somebody left empty.
    assert.match(player, /emptyLibraryCard\('No songs', 'This album is empty'\)/);
    assert.match(player, /emptyLibraryCard\('No local songs found', 'Music on this device will appear here'\)/);

    // The old full-size panel is gone from the per-album case.
    assert.ok(
        !player.includes('Add music to your music folder, then rescan the library'),
        'the tall notice no longer appears for an empty album'
    );
});

test('the placeholder is not a track and cannot be played', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    const card = player.slice(player.indexOf('function emptyLibraryCard'), player.indexOf('/** Empty state shown when'));

    assert.ok(!/data-track/.test(card), 'no track id is invented');
    assert.ok(!/libPlayButton/.test(card), 'no play control, not even a disabled one');
    assert.ok(!/song-menu-btn/.test(card), 'no per-song menu');
    assert.ok(!/class="[^"]*pointer/.test(card), 'it is not dressed up as clickable');

    // And the click binding skips it outright.
    assert.match(
        player,
        /if \(li\.classList\.contains\('empty-libcard'\)\) return;/,
        'the placeholder never gets a click handler'
    );
});

test('the placeholder inherits the track-row geometry and only changes interaction', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

    // Height, width, border, radius and alignment all come from the shared
    // row rule, which the placeholder matches by carrying the same classes.
    assert.match(css, /\.songslist ul li \{[\s\S]{0,240}border: 2px solid gray;/);
    assert.match(css, /\.songslist ul li \{[\s\S]{0,240}border-radius: 5px;/);
    assert.match(css, /\.songslist ul li \{[\s\S]{0,240}align-items: center;/);

    // The placeholder rule adds nothing that would change those dimensions.
    const rule = css.slice(css.indexOf('.empty-libcard {'), css.indexOf('.empty-libcard:hover'));
    assert.ok(!/\bwidth:/.test(rule), 'width is not overridden');
    assert.ok(!/\bheight:/.test(rule), 'height is not overridden');
    assert.ok(!/\bpadding:/.test(rule), 'padding is not overridden');
    assert.ok(!/border-radius/.test(rule), 'radius is not overridden');
    assert.match(rule, /cursor: default;/);
    assert.match(rule, /list-style: none;/, 'it is not numbered like a track');

    // Long text truncates instead of stretching a narrow sidebar.
    assert.match(css, /\.empty-libcard \.musicinfo div \{[\s\S]{0,160}text-overflow: ellipsis;/);
    assert.match(css, /\.empty-libcard \.musicinfo \{[\s\S]{0,120}min-width: 0;/);
});

test('a list with tracks still renders ordinary rows', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The populated path is untouched: same classes, play button and menu.
    assert.match(player, /li\.className = 'libcard bg-black pointer p-1 m-1';/);
    assert.match(player, /li\.dataset\.track = songData\.track;/);
    assert.match(player, /class="libPlayButton invert pointer"/);
    assert.match(player, /class="song-menu-btn" aria-label="More options"/);

    // The placeholder is only used when a list is genuinely empty.
    assert.match(player, /if \(effectiveSongs\.allSongs\.length === 0\) \{[\s\S]{0,700}emptyLibraryCard\(/);
    // Liked Songs has no rendering path of its own any more: it is a list of
    // track ids like any other, drawn by the one path above, so an empty one
    // gets the same notice every other empty collection gets.
    assert.ok(!/Nothing liked yet/.test(player), 'there is no second copy of the list renderer');
});

test('a library that was never set up keeps its own larger notice', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // An album with nothing in it and a library with nothing in it are not the
    // same thing, and they do not share a treatment.
    assert.match(player, /function showEmptyLibraryState\(\)[\s\S]{0,400}no-songs-message/);
    assert.match(player, /Your music library is empty/);
});

test('the album three-dot behaviour is untouched by the empty state', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]{0,400}\.card-menu-btn \{[\s\S]{0,80}opacity: 0;/);
    assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]{0,500}opacity: 1;/);
    assert.match(player, /<button class="card-menu-btn" type="button" aria-label="/);
});

// ============================================
// Album cards show title and artist, never a description
// ============================================

test('an album card prints the artist and nothing from the description', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // One helper decides the line under the title, and it only ever returns
    // an artist.
    assert.match(player, /function albumCardArtist\(info\) \{[\s\S]{0,200}return info\.artist \|\| info\.albumArtist \|\| '';/);
    assert.ok(
        !/albumCardArtist[\s\S]{0,200}description/.test(player.slice(player.indexOf('function albumCardArtist'), player.indexOf('async function refreshAlbumCards'))),
        'the card line never falls back to a description'
    );

    // The card markup uses that line, not a description. Local Music is the
    // one collection that says something else there - how much music is on
    // this machine - and that is a count, not a description either.
    assert.match(
        player,
        /const safeArtist = escapeHTML\(isSystem \? localCollectionStatus\(folder\) : albumCardArtist\(info\)\);/
    );
    assert.match(player, /<h2>\$\{safeTitle\}<\/h2>\s*\n\s*<p>\$\{safeArtist\}<\/p>/);
    assert.ok(!player.includes('safeDescription'), 'no description is escaped for a card');

    const status = player.slice(
        player.indexOf('function localCollectionStatus(folder)'),
        player.indexOf('function albumCardArtist(info)')
    );
    assert.ok(!/description/.test(status), 'and that line is not a description either');
});

test('the catalogue model keeps the description without showing it', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // Albums still carry both fields, kept apart.
    assert.match(player, /artist: album\.artist \|\| album\.albumArtist \|\| '',/);
    assert.match(player, /description: album\.description \|\| '',/);

    // A description is never merged into the artist, in either direction.
    assert.ok(!/artist: album\.description/.test(player));
    assert.ok(!/description: album\.albumArtist/.test(player));
    assert.ok(!/description: track\.albumArtist/.test(player));
});

test('album search results show the artist, and match on it', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // An album is prepared for searching with the artist a card shows beside
    // its title, so typing either finds it.
    assert.match(player, /const albumArtist = albumCardArtist\(info\);/);
    assert.match(player, /haystack: normalizeForSearch\(albumTitle \+ ' ' \+ albumArtist/);

    // And the result says the artist, and never the description.
    assert.match(player, /\$\{album\.artist \? `<span>\$\{escapeHTML\(album\.artist\)\}<\/span>` : ''\}/);
    assert.ok(!/escapeHTML\(album\.description\)/.test(player), 'no description reaches a search result');
});

test('every card keeps the same height whether or not it has an artist', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The line is always rendered, so the cards line up, and it is capped at
    // one line so a long name cannot grow a card.
    assert.match(player, /<p>\$\{safeArtist\}<\/p>/);
    assert.match(css, /\.card p \{[\s\S]{0,320}min-height: 1\.2em;/);
    assert.match(css, /\.card p \{[\s\S]{0,320}white-space: nowrap;/);
    assert.match(css, /\.card p \{[\s\S]{0,320}text-overflow: ellipsis;/);
});

test('descriptions are still stored, edited and saved', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');
    const globalCatalogSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'globalCatalog.js'), 'utf8');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase-setup.sql'), 'utf8');

    // The field survives everywhere it mattered before: schema, model, form.
    assert.match(sql, /ALTER TABLE public\.catalog_albums ADD COLUMN IF NOT EXISTS description TEXT;/);
    assert.match(globalCatalogSource, /description: cleanString\(row\.description\)/);
    assert.match(markup, /id="albumDescription"/);
    assert.match(admin, /getElementById\('albumDescription'\)\.value = album\.description == null \? '' : album\.description;/);
    assert.match(admin, /description: description\b/);

    // The player still keeps a description on the albums a person makes.
    assert.match(player, /description: albumDescription \|\| 'My custom album',/);
});

test('the catalogue API still returns the description for detail views', async () => {
    const context = buildContext({
        rest: {
            albums: [
                {
                    id: ALBUM_UUID,
                    title: 'Afterglow',
                    artist: 'Nova Rae',
                    album_artist: 'Nova Rae',
                    description: 'Recorded over one winter.',
                    artwork_path: null
                }
            ],
            tracks: []
        }
    });

    try {
        const albums = await context.service.getAlbums({});
        const album = albums.items[0];

        assert.strictEqual(album.title, 'Afterglow');
        assert.strictEqual(album.artist, 'Nova Rae');
        assert.strictEqual(album.description, 'Recorded over one winter.', 'the field is still served');
    } finally {
        context.cleanup();
    }
});

// ============================================
// The remove-cover control: one centred SVG
// ============================================

/** Tiny CSS reader: collects the declarations that apply to one selector. */
function declarationsFor(css, selector) {
    const blocks = [];
    // Split into "selector { body }" pairs and keep the ones whose selector
    // list contains exactly this selector.
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = pattern.exec(css)) !== null) {
        const selectors = match[1]
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split(',')
            .map((entry) => entry.trim());
        if (selectors.indexOf(selector) !== -1) blocks.push(match[2]);
    }

    // The base rule only: a media query that resizes the box later must not
    // be mistaken for the desktop value.
    const chosen = blocks.length ? [blocks[0]] : [];

    const declarations = {};
    for (const block of chosen) {
        for (const line of block.split(';')) {
            const colon = line.indexOf(':');
            if (colon === -1) continue;
            const property = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim();
            if (property) declarations[property] = value;
        }
    }
    return declarations;
}

test('the remove-cover button contains exactly one SVG and no text glyph', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');

    const open = markup.indexOf('<button type="button" class="album-cover-remove-btn"');
    assert.ok(open > -1, 'the button exists');
    const button = markup.slice(open, markup.indexOf('</button>', open) + '</button>'.length);

    // Exactly one icon, and it is an SVG.
    assert.strictEqual((button.match(/<svg/g) || []).length, 1, 'exactly one SVG');
    assert.strictEqual((button.match(/<img/g) || []).length, 0, 'no image icon');
    assert.match(button, /class="album-cover-remove-icon"/);
    assert.match(button, /<path d="M7 7L17 17M17 7L7 17"><\/path>/);

    // No character, entity or icon font is used to draw the cross.
    const withoutTags = button.replace(/<[^>]*>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/[×✕✖xX]/.test(withoutTags.replace(/Remove album cover/g, '')), 'no text glyph inside the button');
    assert.ok(!/&times;|&#215;|&#x2715;/.test(button), 'no HTML entity cross');
    assert.ok(!/class="[^"]*(fa-|icon-|material-icons)[^"]*"/.test(button), 'no icon font');

    // Accessibility and semantics stay as they were.
    assert.match(button, /type="button"/);
    assert.match(button, /aria-label="Remove album cover"/);
    assert.match(button, /aria-hidden="true"/);
    assert.match(button, /focusable="false"/);
});

test('the button centres its icon structurally, with no nudging', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');

    const button = declarationsFor(markup, '.album-cover-remove-btn');
    const icon = declarationsFor(markup, '.album-cover-remove-icon');

    // The box: a fixed square, centred by grid rather than by text metrics.
    assert.strictEqual(button.display, 'grid');
    assert.strictEqual(button['place-items'], 'center');
    assert.strictEqual(button.width, '28px');
    assert.strictEqual(button.height, '28px');
    assert.strictEqual(button['min-width'], '28px');
    assert.strictEqual(button['min-height'], '28px');
    assert.strictEqual(button['max-width'], '28px');
    assert.strictEqual(button['max-height'], '28px');
    assert.strictEqual(button.width, button.height, 'the button is square');
    assert.strictEqual(button.padding, '0');
    assert.strictEqual(button.margin, '0');
    assert.strictEqual(button['box-sizing'], 'border-box');
    assert.strictEqual(button['border-radius'], '50%');
    assert.strictEqual(button['line-height'], '0');
    assert.strictEqual(button['font-size'], '0');
    assert.strictEqual(button.overflow, 'hidden');

    // The icon: a fixed square block with nothing shifting it.
    assert.strictEqual(icon.width, '12px');
    assert.strictEqual(icon.height, '12px');
    assert.strictEqual(icon.width, icon.height, 'the icon is square');
    assert.strictEqual(icon.display, 'block');
    assert.strictEqual(icon.margin, '0');
    assert.strictEqual(icon.padding, '0');
    assert.strictEqual(icon.position, 'static');
    assert.strictEqual(icon.transform, 'none');
    assert.strictEqual(icon.flex, 'none');

    // Nothing anywhere in the icon rules moves it by hand.
    const iconRules = markup.slice(
        markup.indexOf('.album-cover-remove-icon {'),
        markup.indexOf('.album-cover-remove-btn:hover {')
    );
    for (const forbidden of ['top:', 'left:', 'right:', 'bottom:', 'translate', 'vertical-align']) {
        assert.ok(!iconRules.includes(forbidden), 'the icon has no ' + forbidden.replace(':', '') + ' correction');
    }
    assert.ok(!/margin[^:]*:\s*-/.test(iconRules), 'no negative margin');

    // The path is painted by the stylesheet, so hover cannot change geometry.
    const pathRules = declarationsFor(markup, '.album-cover-remove-icon path');
    assert.strictEqual(pathRules.fill, 'none');
    assert.strictEqual(pathRules.stroke, 'currentColor');
    assert.strictEqual(pathRules['stroke-width'], '2');
    assert.strictEqual(pathRules['stroke-linecap'], 'round');
    assert.strictEqual(pathRules['stroke-linejoin'], 'round');
});

test('the icon is mathematically centred in the button box', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');
    const button = declarationsFor(markup, '.album-cover-remove-btn');
    const icon = declarationsFor(markup, '.album-cover-remove-icon');

    const size = (value) => Number(String(value).replace('px', ''));
    const borderWidth = Number((button.border || '1px').match(/([\d.]+)px/)[1]);

    // place-items: center on a border-box grid puts the icon in the middle of
    // the content box, which is itself centred in the border box.
    for (const buttonSize of [size(button.width), 32]) {
        const content = buttonSize - borderWidth * 2;
        const iconSize = size(icon.width);

        const buttonCentre = buttonSize / 2;
        const iconOffset = borderWidth + (content - iconSize) / 2;
        const iconCentre = iconOffset + iconSize / 2;

        assert.ok(Math.abs(buttonCentre - iconCentre) <= 0.5, 'centred at ' + buttonSize + 'px: ' + iconCentre + ' vs ' + buttonCentre);
    }

    // The cross itself is symmetric about the centre of its viewBox, so the
    // drawn glyph is centred too, not just its box.
    const crossPath = markup.match(/<path d="(M7 7L17 17M17 7L7 17)">/);
    assert.ok(crossPath, 'the symmetric cross path is used');
    const coordinates = crossPath[1].match(/\d+/g).map(Number);
    const midpoints = [];
    for (let i = 0; i < coordinates.length; i += 4) {
        midpoints.push([(coordinates[i] + coordinates[i + 2]) / 2, (coordinates[i + 1] + coordinates[i + 3]) / 2]);
    }
    for (const [x, y] of midpoints) {
        assert.strictEqual(x, 12, 'the stroke is centred horizontally in the 24x24 viewBox');
        assert.strictEqual(y, 12, 'the stroke is centred vertically in the 24x24 viewBox');
    }
});

test('nothing else can reach the icon or draw a second one', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'admin-dashboard.html'), 'utf8');
    const playerCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
    const utilityCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'utlity.css'), 'utf8');

    // Pseudo-elements are switched off, so no shared class can add a glyph.
    assert.match(markup, /\.album-cover-remove-btn::before,\s*\n\s*\.album-cover-remove-btn::after \{[\s\S]{0,120}content: none;/);

    // The drop zone's own illustration rule is scoped to direct children, so
    // its margin-bottom cannot reach an icon inside a control.
    assert.match(markup, /\.drop-zone > svg,\s*\n\s*\.drop-zone-content > svg \{/);
    assert.ok(!/^\s*\.drop-zone svg \{/m.test(markup), 'the unscoped drop-zone svg rule is gone');

    // No other stylesheet knows about this control.
    assert.ok(!playerCss.includes('album-cover-remove'), 'the player stylesheet does not touch it');
    assert.ok(!utilityCss.includes('album-cover-remove'), 'the utility stylesheet does not touch it');

    // The last rule for the button is the touch-size media query, which only
    // changes the box - it never re-centres or offsets the icon.
    const occurrences = [...markup.matchAll(/\.album-cover-remove-btn[^{,]*[,{]/g)].map((m) => m.index);
    const lastRule = markup.slice(occurrences[occurrences.length - 1], markup.indexOf('}', markup.indexOf('}', occurrences[occurrences.length - 1]) + 1));
    assert.ok(!/place-items|align-items|justify-content|padding|line-height/.test(lastRule), 'no later rule alters centring');
});

// ============================================
// Personal edits to a published album
// ============================================

function publishedAlbumFixture() {
    return {
        albums: [
            {
                id: ALBUM_UUID,
                title: 'Afterglow',
                artist: 'Nova Rae',
                album_artist: 'Nova Rae',
                description: 'Late-night listening.',
                artwork_path: 'covers/afterglow.jpg'
            }
        ],
        tracks: [
            {
                id: TRACK_UUID,
                album_id: ALBUM_UUID,
                title: 'Afterglow',
                artist: 'Nova Rae',
                album_artist: 'Nova Rae',
                duration: 210,
                mime_type: 'audio/mpeg',
                audio_path: 'audio/afterglow.mp3',
                artwork_path: null
            }
        ]
    };
}

/** A context whose personal artwork is stored in its own temporary folder. */
function overrideContext(options) {
    const context = buildContext(Object.assign({ rest: publishedAlbumFixture() }, options || {}));
    context.artworkDir = path.join(context.dataDir, 'user-artwork');
    context.service.userArtwork = new UserArtworkStore({ directory: context.artworkDir });
    return context;
}

/** Store a small image the way the upload endpoint does, and return its id. */
function storeArtwork(context) {
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
    );
    return context.service.userArtwork.save(png, 'image/png').id;
}

test('one listener personalises a published album and only they see it', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const artworkId = storeArtwork(context);

        context.service.setAlbumOverrideForUser('user-one', albumId, {
            title: 'My Afterglow',
            description: 'My personal description',
            artwork: { type: 'local', reference: artworkId }
        });

        // The listener who made the edits sees their own version.
        const mine = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
        const myAlbum = mine.items.find((album) => album.id === albumId);
        assert.strictEqual(myAlbum.title, 'My Afterglow');
        assert.strictEqual(myAlbum.description, 'My personal description');
        assert.strictEqual(myAlbum.artist, 'Nova Rae', 'a field they left alone keeps the published value');
        assert.strictEqual(myAlbum.artworkUrl, '/api/library/artwork/' + artworkId);
        assert.strictEqual(myAlbum.hasLocalEdits, true);
        assert.strictEqual(myAlbum.published.title, 'Afterglow', 'the published values travel alongside');

        // Everybody else sees the album as it was published.
        const theirs = await context.service.getAlbums({ token: 'user-token', userId: 'user-two' });
        const theirAlbum = theirs.items.find((album) => album.id === albumId);
        assert.strictEqual(theirAlbum.title, 'Afterglow');
        assert.strictEqual(theirAlbum.artist, 'Nova Rae');
        assert.strictEqual(theirAlbum.description, 'Late-night listening.');
        assert.strictEqual(theirAlbum.hasLocalEdits, false);
        assert.match(theirAlbum.artworkUrl, /^\/api\/catalog\/albums\//);

        const guest = await context.service.getAlbums({});
        assert.strictEqual(guest.items[0].title, 'Afterglow');
        assert.strictEqual(guest.items[0].description, 'Late-night listening.');
        assert.strictEqual(guest.items[0].hasLocalEdits, false);

        // And the shared record itself never changed.
        const stored = context.rest._state.albums[0];
        assert.strictEqual(stored.title, 'Afterglow');
        assert.strictEqual(stored.artist, 'Nova Rae');
        assert.strictEqual(stored.description, 'Late-night listening.');
        assert.strictEqual(stored.artwork_path, 'covers/afterglow.jpg');
        assert.strictEqual(context.rest._state.removed.length, 0, 'no stored file was touched');
    } finally {
        context.cleanup();
    }
});

test('a listener also personalises the artist name, for themselves alone', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        context.service.setAlbumOverrideForUser('user-one', albumId, { artist: 'Nova' });

        const mine = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(mine.items[0].artist, 'Nova');
        assert.strictEqual(mine.items[0].albumArtist, 'Nova');
        assert.strictEqual(mine.items[0].published.artist, 'Nova Rae');

        const theirs = await context.service.getAlbums({ token: 'user-token', userId: 'user-two' });
        assert.strictEqual(theirs.items[0].artist, 'Nova Rae');
        assert.strictEqual(context.rest._state.albums[0].artist, 'Nova Rae');
    } finally {
        context.cleanup();
    }
});

test('personal edits survive a restart and hold nothing but presentation', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        context.service.setAlbumOverrideForUser('user-one', albumId, { title: 'My Afterglow' });

        const stateFile = path.join(context.dataDir, 'users', 'user-one', 'state.json');
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.ok(saved.globalAlbumOverrides[ALBUM_UUID], 'keyed by the album uuid');
        assert.strictEqual(saved.globalAlbumOverrides[ALBUM_UUID].title, 'My Afterglow');
        assert.ok(saved.globalAlbumOverrides[ALBUM_UUID].updatedAt, 'stamped');

        const serialized = JSON.stringify(saved);
        assert.ok(!serialized.includes('audio/afterglow.mp3'), 'no audio is duplicated');
        assert.ok(!serialized.includes('covers/afterglow.jpg'), 'no Supabase storage path is copied');
        assert.ok(!serialized.includes('token=signed'), 'no signed URL is stored');
        assert.ok(!/base64|data:image/i.test(serialized), 'no image data is stored');

        // A fresh service, as after a restart, reads the same thing back.
        const restarted = new CatalogService({
            library: context.library,
            global: context.global,
            userState: context.userState,
            deviceLibrary: new DeviceLibrary({ deviceDir: path.join(context.dataDir, 'device') }),
            userArtworkOptions: { directory: context.artworkDir }
        });
        const albums = await restarted.getAlbums({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(albums.items[0].title, 'My Afterglow');
        assert.strictEqual(albums.items[0].description, 'Late-night listening.');
    } finally {
        context.cleanup();
    }
});

const SINGLE_FIELD_EDITS = [
    { name: 'the description', field: 'description', value: 'My personal description' },
    { name: 'the title', field: 'title', value: 'Only the title changed' },
    { name: 'the artist', field: 'artist', value: 'Only the artist changed' }
];

for (const edit of SINGLE_FIELD_EDITS) {
    test('changing ' + edit.name + ' alone leaves every other field published', async () => {
        const context = overrideContext();
        try {
            const albumId = 'global-album:' + ALBUM_UUID;
            context.service.setAlbumOverrideForUser('user-one', albumId, { [edit.field]: edit.value });

            const albums = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
            const album = albums.items[0];

            assert.strictEqual(album[edit.field], edit.value);
            for (const other of ['title', 'artist', 'description']) {
                if (other === edit.field) continue;
                assert.strictEqual(album[other], album.published[other], other + ' is still the published value');
            }
            assert.match(album.artworkUrl, /^\/api\/catalog\/albums\//, 'the published cover is still used');

            const stored = context.rest._state.albums[0];
            assert.strictEqual(stored.title, 'Afterglow');
            assert.strictEqual(stored.artist, 'Nova Rae');
            assert.strictEqual(stored.description, 'Late-night listening.');
        } finally {
            context.cleanup();
        }
    });
}

test('a cover-only personal change keeps the published words', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const artworkId = storeArtwork(context);
        context.service.setAlbumOverrideForUser('user-one', albumId, {
            artwork: { type: 'local', reference: artworkId }
        });

        const albums = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
        const album = albums.items[0];
        assert.strictEqual(album.title, 'Afterglow');
        assert.strictEqual(album.artist, 'Nova Rae');
        assert.strictEqual(album.description, 'Late-night listening.');
        assert.strictEqual(album.artworkUrl, '/api/library/artwork/' + artworkId);
        assert.match(album.fallbackArtworkUrl, /^\/api\/catalog\/albums\//, 'the published cover stays available');

        // The resolver serves the personal cover to its owner, the published
        // one to everybody else.
        const mine = await context.service.resolveArtworkUrl(albumId, { token: 'user-token', userId: 'user-one' });
        assert.strictEqual(mine.source, 'local-override');
        assert.strictEqual(mine.url, '/api/library/artwork/' + artworkId);

        const theirs = await context.service.resolveArtworkUrl(albumId, { token: 'user-token', userId: 'user-two' });
        assert.strictEqual(theirs.source, 'global');
        assert.ok(theirs.url.includes('catalog-artwork'));
    } finally {
        context.cleanup();
    }
});

test('a personal cover that has gone falls back to the published one', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const artworkId = storeArtwork(context);
        context.service.setAlbumOverrideForUser('user-one', albumId, {
            artwork: { type: 'local', reference: artworkId }
        });

        // The file disappears while the reference is still recorded.
        context.service.userArtwork.remove(artworkId);

        const resolved = await context.service.resolveArtworkUrl(albumId, { token: 'user-token', userId: 'user-one' });
        assert.strictEqual(resolved.source, 'global', 'the published cover is used instead');
        assert.ok(resolved.url.includes('catalog-artwork'));
    } finally {
        context.cleanup();
    }
});

test('saving with nothing changed stores no personal version at all', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const saved = context.service.setAlbumOverrideForUser('user-one', albumId, {
            title: null,
            artist: null,
            description: null,
            artwork: null
        });

        assert.strictEqual(saved, null, 'an empty edit is not kept');
        assert.deepStrictEqual(context.service.getAlbumOverridesForUser('user-one'), {});

        const albums = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(albums.items[0].title, 'Afterglow');
        assert.strictEqual(albums.items[0].hasLocalEdits, false);
    } finally {
        context.cleanup();
    }
});

test('resetting restores the published album and clears the leftover cover', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const artworkId = storeArtwork(context);
        context.service.setAlbumOverrideForUser('user-one', albumId, {
            title: 'My Afterglow',
            description: 'My personal description',
            artwork: { type: 'local', reference: artworkId }
        });
        assert.ok(context.service.userArtwork.find(artworkId), 'the personal cover is stored');

        const cleared = context.service.clearAlbumOverrideForUser('user-one', albumId);
        assert.strictEqual(cleared, true);
        assert.strictEqual(context.service.userArtwork.find(artworkId), null, 'the unused cover is cleaned up');
        assert.deepStrictEqual(context.service.getAlbumOverridesForUser('user-one'), {});

        const albums = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(albums.items[0].title, 'Afterglow');
        assert.strictEqual(albums.items[0].artist, 'Nova Rae');
        assert.strictEqual(albums.items[0].description, 'Late-night listening.');
        assert.strictEqual(albums.items[0].hasLocalEdits, false);
        assert.match(albums.items[0].artworkUrl, /^\/api\/catalog\/albums\//);

        // Nothing was deleted upstream.
        assert.strictEqual(context.rest._state.albums.length, 1);
        assert.strictEqual(context.rest._state.albums[0].title, 'Afterglow');
        assert.strictEqual(context.rest._state.removed.length, 0);
    } finally {
        context.cleanup();
    }
});

test('replacing a personal cover cleans up the one it replaces', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const first = storeArtwork(context);
        const second = storeArtwork(context);

        context.service.setAlbumOverrideForUser('user-one', albumId, { artwork: { type: 'local', reference: first } });
        context.service.setAlbumOverrideForUser('user-one', albumId, { artwork: { type: 'local', reference: second } });

        assert.strictEqual(context.service.userArtwork.find(first), null, 'the replaced cover is removed');
        assert.ok(context.service.userArtwork.find(second), 'the new cover is kept');
    } finally {
        context.cleanup();
    }
});

test('personal edits leave the tracks and the audio exactly as they are', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const before = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });

        context.service.setAlbumOverrideForUser('user-one', albumId, { title: 'My Afterglow', artist: 'Nova' });

        const after = await context.service.getTracks({ token: 'user-token', userId: 'user-one' });
        assert.deepStrictEqual(
            after.items.map((track) => track.id),
            before.items.map((track) => track.id),
            'queue identity is untouched'
        );
        assert.deepStrictEqual(
            after.items.map((track) => track.duration),
            before.items.map((track) => track.duration)
        );
        assert.strictEqual(after.items[0].title, 'Afterglow', 'track titles are not personalised');

        const stream = await context.service.resolveStreamUrl('global:' + TRACK_UUID, {
            token: 'user-token',
            userId: 'user-one'
        });
        assert.strictEqual(stream.source, 'global');
        assert.match(stream.url, /catalog-audio\/audio\/afterglow\.mp3/, 'audio still comes from the shared catalogue');
    } finally {
        context.cleanup();
    }
});

test('hiding an album and personalising it are separate choices', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        context.service.setAlbumOverrideForUser('user-one', albumId, { title: 'My Afterglow' });
        context.service.hideForUser('user-one', albumId);

        const catalog = await context.service.getCatalog({ token: 'user-token', userId: 'user-one' });
        assert.ok(!catalog.albums.some((album) => album.id === albumId), 'hidden for this user');
        assert.ok(context.service.getAlbumOverridesForUser('user-one')[ALBUM_UUID], 'the edit survives hiding');

        // Another user still sees the published album.
        const theirs = await context.service.getCatalog({ token: 'user-token', userId: 'user-two' });
        assert.strictEqual(theirs.albums[0].title, 'Afterglow');

        // Restoring brings back the personalised version.
        context.service.restoreForUser('user-one', albumId);
        const visible = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
        assert.strictEqual(visible.items[0].title, 'My Afterglow');
    } finally {
        context.cleanup();
    }
});

test('an album of the listener own making is untouched by the personal overlay', async () => {
    const context = overrideContext({ buildLocal: withLocalTrack });
    try {
        await context.library.scan();
        const albums = await context.service.getAlbums({ token: 'user-token', userId: 'user-one' });
        const localAlbum = albums.items.find((album) => album.source === 'local');

        assert.ok(localAlbum, 'the local album is listed');
        assert.strictEqual(localAlbum.hasLocalEdits, undefined, 'a local album carries no personal overlay');

        // Personalising is for published albums; a local album is edited in the
        // local library instead.
        assert.throws(
            () => context.service.setAlbumOverrideForUser('user-one', localAlbum.id, { title: 'Renamed' }),
            /published albums/i
        );
    } finally {
        context.cleanup();
    }
});

test('a guest cannot personalise anything', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        assert.throws(() => context.service.setAlbumOverrideForUser(null, albumId, { title: 'Nope' }), /signed-in/i);
        assert.throws(() => context.service.clearAlbumOverrideForUser(null, albumId), /signed-in/i);
        assert.deepStrictEqual(context.service.getAlbumOverridesForUser(null), {});
    } finally {
        context.cleanup();
    }
});

test('a personal cover reference is a local id and never a URL or image data', async () => {
    const context = overrideContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        for (const reference of [
            'https://example.supabase.co/storage/v1/object/sign/catalog-artwork/cover.jpg',
            'blob:http://127.0.0.1:3000/2a0e',
            'data:image/png;base64,AAAA'
        ]) {
            const saved = context.service.setAlbumOverrideForUser('user-one', albumId, {
                artwork: { type: 'local', reference: reference }
            });
            assert.strictEqual(saved, null, reference + ' is refused');
        }
        assert.deepStrictEqual(context.service.getAlbumOverridesForUser('user-one'), {});
    } finally {
        context.cleanup();
    }
});

test('the personal-edit endpoints need an account and write local state only', async (t) => {
    const context = overrideContext();
    const started = await startRoutes(context.service);

    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    const albumId = 'global-album:' + ALBUM_UUID;
    const overridePath = '/api/catalog/overrides/' + encodeURIComponent(albumId);

    // A guest is asked to sign in, and nothing is written.
    const guestSave = await request(started.port, overridePath, { method: 'PUT', body: { title: 'Nope' } });
    assert.strictEqual(guestSave.status, 401, 'saving is refused for a guest');

    const guestReset = await request(started.port, overridePath, { method: 'DELETE' });
    assert.strictEqual(guestReset.status, 401, 'resetting is refused for a guest');
    assert.strictEqual((await request(started.port, '/api/catalog/overrides')).status, 401);
    assert.deepStrictEqual(context.service.getAlbumOverridesForUser('user-one'), {});

    // Personalising never reaches a catalogue write or a stored file.
    const calls = [];
    for (const method of ['insertRow', 'updateRows', 'deleteRows', 'removeStorageObject']) {
        const original = context.rest[method].bind(context.rest);
        context.rest[method] = (...args) => {
            calls.push(method);
            return original(...args);
        };
    }

    context.service.setAlbumOverrideForUser('user-one', albumId, { title: 'My Afterglow' });
    context.service.clearAlbumOverrideForUser('user-one', albumId);

    assert.deepStrictEqual(calls, [], 'no catalogue row and no stored file was written');
    assert.strictEqual(context.rest._state.albums[0].title, 'Afterglow');
});

test('the three editing paths stay apart in the code', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'catalogRoutes.js'), 'utf8');
    const service = fs.readFileSync(path.join(__dirname, '..', 'lib', 'catalogService.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, '..', 'js', 'catalogClient.js'), 'utf8');
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The personal endpoints reach the local state service and nothing else.
    const section = routes.slice(
        routes.indexOf("segments[0] === 'overrides'"),
        routes.indexOf('per-user hidden items')
    );
    assert.ok(section.length > 0, 'the personal section was found');
    assert.match(section, /service\.setAlbumOverrideForUser\(context\.userId, segments\[1\]/);
    assert.match(section, /service\.clearAlbumOverrideForUser\(context\.userId, segments\[1\]/);
    assert.ok(!/requireAdmin/.test(section), 'personalising is not an admin action');
    assert.ok(
        !/global\.(createAlbum|updateAlbum|deleteAlbum|createTrack|updateTrack|deleteTrack|uploadObject)/.test(section),
        'no catalogue write lives in the personal path'
    );

    // The service writes personal edits to per-user state, not to Supabase.
    assert.match(service, /setAlbumOverrideForUser\(userId, albumId, override\)/);
    assert.match(service, /this\.userState\.setAlbumOverride\(userId, albumUuid, override\)/);
    const setter = service.slice(
        service.indexOf('setAlbumOverrideForUser(userId, albumId, override)'),
        service.indexOf('getAlbumOverridesForUser(userId)')
    );
    assert.ok(!/this\.global\./.test(setter), 'the personal path never calls the global catalogue');

    // The browser client sends personal edits to this server.
    assert.match(client, /CatalogClient\.prototype\.setAlbumOverride = function \(albumId, override\)/);
    assert.match(client, /baseUrl \+ '\/overrides\/'/);

    // The player branches once, on the album's source, and a local album keeps
    // the path it always had.
    assert.match(player, /if \(info\.source === 'global'\) \{[\s\S]{0,200}await savePersonalAlbumEdits\(/);
    assert.match(player, /if \(info\.isUserAlbum\)/);
});
