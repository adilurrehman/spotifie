'use strict';

/**
 * Drawing the library before the catalogue arrives.
 *
 * A refresh used to wait on Supabase before it could show anything, every
 * time, for a catalogue that had usually not changed at all. Now the copy this
 * device kept is drawn first and the real catalogue is checked afterwards.
 *
 * What these tests hold in place is the part that could go quietly wrong:
 * that the copy never holds audio, never holds an address that expires and
 * never holds anything belonging to a person; that a check finding nothing new
 * redraws nothing; that a catalogue nobody can reach leaves what is on screen
 * alone; and that a cover replaced by an administrator is a different picture
 * rather than the old one shown again.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { GlobalCatalog } = require('../lib/globalCatalog');
const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { UserStateStore } = require('../lib/userState');
const { DeviceLibrary } = require('../lib/deviceLibrary');
const { CatalogService } = require('../lib/catalogService');
const { createCatalogRoutes } = require('../lib/catalogRoutes');
const { installFakeIndexedDB } = require('./helpers/fakeIndexedDB');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const ROOT = path.join(__dirname, '..');
const CACHE_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'catalogCache.js'), 'utf8');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

const ALBUM_UUID = '11111111-1111-4111-8111-111111111111';
const TRACK_UUID = '33333333-3333-4333-8333-333333333333';

// ============================================
// The copy this device keeps
// ============================================

/** Load the cache with a fresh empty store behind it. */
function buildCache() {
    const database = installFakeIndexedDB();

    const sandbox = { console: { warn() {}, error() {}, log() {} }, indexedDB: globalThis.indexedDB };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CACHE_SOURCE, sandbox);

    return { cache: sandbox.spotifieCatalogCache, database: database, sandbox: sandbox };
}

/** What the store actually holds, read behind the cache's back. */
function storedRecord(database) {
    const store = database.stores.get('snapshots');
    return store ? store.records.get('global') || null : null;
}

function publishedAlbum(overrides) {
    return Object.assign(
        {
            id: 'global-album:' + ALBUM_UUID,
            source: 'global',
            title: 'Golden Hour',
            artist: 'Someone',
            albumArtist: 'Someone',
            description: null,
            artworkUrl: '/api/catalog/albums/global-album%3A' + ALBUM_UUID + '/artwork',
            trackCount: 1,
            duration: 210,
            metadata: { hasArtwork: true, artworkVersion: 'v1', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
        },
        overrides || {}
    );
}

function publishedTrack(overrides) {
    return Object.assign(
        {
            id: 'global:' + TRACK_UUID,
            source: 'global',
            title: 'First Light',
            artist: 'Someone',
            albumArtist: 'Someone',
            album: 'Golden Hour',
            albumId: 'global-album:' + ALBUM_UUID,
            duration: 210,
            artworkUrl: '/api/catalog/tracks/global%3A' + TRACK_UUID + '/artwork',
            streamUrl: '/api/catalog/tracks/global%3A' + TRACK_UUID + '/stream',
            metadata: { hasArtwork: false, artworkVersion: null, updatedAt: '2026-01-01' }
        },
        overrides || {}
    );
}

test('a catalogue written on one visit is there for the next one', async () => {
    const built = buildCache();

    await built.cache.write({ albums: [publishedAlbum()], tracks: [publishedTrack()] });
    const snapshot = await built.cache.read();

    assert.ok(snapshot, 'there is a copy');
    assert.strictEqual(snapshot.albums.length, 1);
    assert.strictEqual(snapshot.tracks.length, 1);
    assert.strictEqual(snapshot.albums[0].title, 'Golden Hour');
    assert.ok(snapshot.cachedAt > 0, 'and it says when it was taken');
});

test('there is no copy before there has been a visit', async () => {
    const built = buildCache();
    assert.strictEqual(await built.cache.read(), null);
});

test('nothing temporary and nothing signed is ever written down', async () => {
    const built = buildCache();

    await built.cache.write({
        albums: [
            publishedAlbum({
                // Every shape an address that expires arrives in.
                artworkUrl: 'https://project.supabase.co/storage/v1/object/sign/art/a.jpg?token=abc'
            })
        ],
        tracks: [
            publishedTrack({
                artworkUrl: 'blob:http://localhost/9a8b',
                streamUrl: '/api/catalog/tracks/one/stream?ticket=secret'
            })
        ]
    });

    const record = storedRecord(built.database);
    const written = JSON.stringify(record);

    assert.doesNotMatch(written, /token=|ticket=|X-Amz|Signature/i, 'no signature and no ticket is kept');
    assert.doesNotMatch(written, /blob:|data:|https?:/, 'no address from anywhere but this origin is kept');
    assert.strictEqual(record.albums[0].artworkUrl, null, 'a signed cover is dropped, not stored');
    assert.strictEqual(record.tracks[0].streamUrl, null, 'and so is a ticketed stream');
});

test('no audio and no picture is ever put in the copy', async () => {
    const built = buildCache();

    await built.cache.write({
        albums: [publishedAlbum({ coverImage: 'data:image/png;base64,iVBORw0KGgo=' })],
        tracks: [
            publishedTrack({
                audio: Buffer.from('not audio').toString('base64'),
                artworkData: 'data:image/jpeg;base64,/9j/4AAQ'
            })
        ]
    });

    const written = JSON.stringify(storedRecord(built.database));
    assert.doesNotMatch(written, /base64|audio"|coverImage|artworkData/, 'only descriptions are kept');
});

test('nothing belonging to a person can get into a copy the machine shares', async () => {
    const built = buildCache();

    await built.cache.write({
        albums: [
            publishedAlbum({
                // What the merge adds for a signed-in listener. None of it
                // belongs on a machine other people use.
                hasLocalEdits: true,
                localEdits: { title: 'My name for it', artwork: 'abc' },
                published: { title: 'Golden Hour' }
            })
        ],
        tracks: [publishedTrack({ addedToAlbum: true, personal: true })]
    });

    const record = storedRecord(built.database);
    assert.strictEqual(record.albums[0].hasLocalEdits, undefined);
    assert.strictEqual(record.albums[0].localEdits, undefined);
    assert.strictEqual(record.albums[0].published, undefined);
    assert.strictEqual(record.tracks[0].addedToAlbum, undefined);
    assert.strictEqual(record.tracks[0].personal, undefined);
});

test('only the published catalogue is kept; this device s own music is not', async () => {
    const built = buildCache();

    await built.cache.write({
        albums: [publishedAlbum(), { id: 'system:local-music', source: 'local', title: 'Local Music' }],
        tracks: [publishedTrack(), { id: 'local:abc', source: 'local', title: 'A file on this machine' }]
    });

    const record = storedRecord(built.database);
    assert.strictEqual(record.albums.length, 1, 'the published album, and only it');
    assert.strictEqual(record.tracks.length, 1);
    assert.doesNotMatch(JSON.stringify(record), /local:abc|Local Music/, 'the local half is not copied');
});

// ============================================
// A copy that cannot be understood is no copy
// ============================================

test('a copy written by an older version is dropped rather than read', async () => {
    const built = buildCache();

    await built.cache.write({ albums: [publishedAlbum()], tracks: [publishedTrack()] });

    // A version from before some change to the shape.
    const record = storedRecord(built.database);
    record.schemaVersion = built.cache.SCHEMA_VERSION - 1;

    assert.strictEqual(await built.cache.read(), null, 'not read');

    // And cleared away, so it is not looked at again.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(storedRecord(built.database), null, 'and not left behind');
});

test('a copy that does not read back as a catalogue cannot break the page', async () => {
    const built = buildCache();

    await built.cache.write({ albums: [publishedAlbum()], tracks: [publishedTrack()] });
    const record = storedRecord(built.database);
    record.albums = 'this is not a list of albums';

    assert.strictEqual(await built.cache.read(), null);
});

test('a browser that keeps nothing is answered, not broken', async () => {
    const sandbox = { console: { warn() {}, error() {}, log() {} } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CACHE_SOURCE, sandbox);

    // No indexedDB at all: a private window, or storage turned off.
    const cache = sandbox.spotifieCatalogCache;
    assert.strictEqual(await cache.read(), null);
    assert.strictEqual(await cache.write({ albums: [], tracks: [] }), null);
    assert.doesNotReject(() => cache.clear());
});

// ============================================
// Telling whether anything moved
// ============================================

test('a catalogue that has not changed reads as the same catalogue', () => {
    const built = buildCache();
    const cache = built.cache;

    const albums = [publishedAlbum()];
    const tracks = [publishedTrack()];

    assert.strictEqual(cache.fingerprint(albums, tracks), cache.fingerprint(albums, tracks));

    // The same catalogue, listed in another order, is the same catalogue.
    const second = publishedAlbum({ id: 'global-album:second' });
    assert.strictEqual(
        cache.fingerprint([albums[0], second], tracks),
        cache.fingerprint([second, albums[0]], tracks)
    );
});

test('an edit, a new album, a withdrawn one: each is seen for what it is', () => {
    const cache = buildCache().cache;
    const before = [publishedAlbum()];

    assert.strictEqual(cache.diff(before, before).changed, false, 'nothing at all changed');

    // Somebody renamed it: the row says when it last changed.
    const edited = cache.diff(before, [publishedAlbum({ metadata: { updatedAt: '2026-06-01', artworkVersion: 'v1' } })]);
    assert.strictEqual(edited.changed, true);
    assert.strictEqual(edited.updated.length, 1);
    assert.strictEqual(edited.added.length, 0);
    assert.strictEqual(edited.removed.length, 0);

    // A new one.
    const added = cache.diff(before, before.concat(publishedAlbum({ id: 'global-album:new' })));
    assert.strictEqual(added.added.length, 1);
    assert.strictEqual(added.updated.length, 0);

    // One that is gone.
    const removed = cache.diff(before, []);
    assert.strictEqual(removed.removed.length, 1);
    assert.strictEqual(removed.changed, true);
});

test('a replaced cover is seen even when nothing else about the album moved', () => {
    const cache = buildCache().cache;

    const before = [publishedAlbum()];
    const after = [publishedAlbum({ metadata: { hasArtwork: true, artworkVersion: 'v2', updatedAt: '2026-01-01' } })];

    const result = cache.diff(before, after);
    assert.strictEqual(result.changed, true, 'a different picture is a change');
    assert.strictEqual(result.updated.length, 1);
    assert.notStrictEqual(cache.fingerprint(before, []), cache.fingerprint(after, []));
});

// ============================================
// The catalogue, read once
// ============================================

/** A Supabase stand-in that counts how often it is actually read. */
function countingRest(options) {
    const settings = options || {};
    const state = { reads: 0, albums: settings.albums || [], tracks: settings.tracks || [], signed: 0 };

    return {
        _state: state,
        async selectRows(table) {
            state.reads += 1;
            return (table === 'catalog_albums' ? state.albums : state.tracks).slice();
        },
        async insertRow(table, row) {
            const stored = Object.assign({ id: 'new-' + state.albums.length }, row);
            (table === 'catalog_albums' ? state.albums : state.tracks).push(stored);
            return [stored];
        },
        async updateRows(table, query, patch) {
            const rows = table === 'catalog_albums' ? state.albums : state.tracks;
            Object.assign(rows[0], patch);
            return [rows[0]];
        },
        async deleteRows(table) {
            return (table === 'catalog_albums' ? state.albums : state.tracks).splice(0, 1);
        },
        async createSignedUrl(bucket, objectPath) {
            state.signed += 1;
            return 'https://project.supabase.co/storage/v1/object/sign/' + bucket + '/' + objectPath + '?token=x';
        },
        async removeStorageObject() {
            return {};
        }
    };
}

function catalogRows() {
    return {
        albums: [
            {
                id: ALBUM_UUID,
                title: 'Golden Hour',
                artist: 'Someone',
                album_artist: 'Someone',
                artwork_path: 'covers/golden.jpg',
                created_at: '2026-01-01',
                updated_at: '2026-01-01'
            }
        ],
        tracks: [
            {
                id: TRACK_UUID,
                album_id: ALBUM_UUID,
                title: 'First Light',
                artist: 'Someone',
                album_artist: 'Someone',
                duration: 210,
                mime_type: 'audio/mpeg',
                audio_path: 'audio/first.mp3',
                artwork_path: null,
                created_at: '2026-01-01',
                updated_at: '2026-01-01'
            }
        ]
    };
}

test('an album says which picture it carries, and never where it is kept', async () => {
    const rest = countingRest(catalogRows());
    const catalog = new GlobalCatalog({ rest: rest });

    const result = await catalog.fetchCatalog(null);
    const album = result.albums[0];

    assert.ok(album.metadata.artworkVersion, 'there is a name for the picture');
    assert.notStrictEqual(album.metadata.artworkVersion, 'covers/golden.jpg', 'and it is not the path');
    assert.doesNotMatch(JSON.stringify(result), /covers\/golden\.jpg|audio\/first\.mp3/, 'no storage path gets out');

    // The same file keeps the same name, so an address built from it does not
    // change and the browser keeps what it already fetched.
    const again = await new GlobalCatalog({ rest: countingRest(catalogRows()) }).fetchCatalog(null);
    assert.strictEqual(again.albums[0].metadata.artworkVersion, album.metadata.artworkVersion);
});

test('a cover that has been replaced gets a different name', async () => {
    const rows = catalogRows();
    const first = await new GlobalCatalog({ rest: countingRest(rows) }).fetchCatalog(null);

    rows.albums[0].artwork_path = 'covers/golden-2.jpg';
    const second = await new GlobalCatalog({ rest: countingRest(rows) }).fetchCatalog(null);

    assert.notStrictEqual(
        second.albums[0].metadata.artworkVersion,
        first.albums[0].metadata.artworkVersion,
        'a new picture is a new name, so the old one is never shown for it'
    );
});

test('two questions at the same moment make one journey', async () => {
    const rest = countingRest(catalogRows());
    const catalog = new GlobalCatalog({ rest: rest });

    await Promise.all([catalog.fetchCatalog(null), catalog.fetchCatalog(null), catalog.fetchCatalog(null)]);

    // Two reads: the albums and the tracks, once each - not once per caller.
    assert.strictEqual(rest._state.reads, 2, 'one journey, however many asked');
});

test('a page that asks for albums and songs does not fetch the catalogue twice', async () => {
    const rest = countingRest(catalogRows());
    const service = new CatalogService({
        global: new GlobalCatalog({ rest: rest }),
        library: makeEmptyLibrary(),
        userState: makeUserState(),
        deviceLibrary: makeDeviceLibrary()
    });

    await Promise.all([service.getAlbums({}), service.getTracks({})]);
    assert.strictEqual(rest._state.reads, 2, 'the two questions share one read');
});

test('a catalogue that could not be reached is not remembered as an empty one', async () => {
    const rest = countingRest(catalogRows());
    let failing = true;
    const original = rest.selectRows;
    rest.selectRows = async function (table) {
        if (failing) throw new Error('Supabase is unreachable');
        return original.call(rest, table);
    };

    const catalog = new GlobalCatalog({ rest: rest });

    const outage = await catalog.fetchCatalog(null);
    assert.strictEqual(outage.available, false);
    assert.strictEqual(outage.albums.length, 0);

    // The next caller tries again rather than inheriting the outage.
    failing = false;
    const recovered = await catalog.fetchCatalog(null);
    assert.strictEqual(recovered.available, true);
    assert.strictEqual(recovered.albums.length, 1);
});

test('an administrator s change is not hidden behind what was read a moment ago', async () => {
    const rest = countingRest(catalogRows());
    const catalog = new GlobalCatalog({ rest: rest, catalogTtlMs: 60000 });

    const before = await catalog.fetchCatalog(null);
    assert.strictEqual(before.albums.length, 1);

    await catalog.createAlbum({ title: 'Just published' }, 'admin-token');

    // Without forgetting what it read, the new album would not appear for a
    // minute - including for the administrator who just published it.
    const after = await catalog.fetchCatalog(null);
    assert.strictEqual(after.albums.length, 2, 'the new album is there at once');
});

// ============================================
// The half this machine answers by itself
// ============================================

function makeEmptyLibrary() {
    const musicRoot = makeTempDir('spotifie-cache-music-');
    const dataDir = makeTempDir('spotifie-cache-data-');

    return new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });
}

function makeUserState() {
    return new UserStateStore({ rootDir: path.join(makeTempDir('spotifie-cache-users-'), 'users') });
}

function makeDeviceLibrary() {
    return new DeviceLibrary({ deviceDir: path.join(makeTempDir('spotifie-cache-device-'), 'device') });
}

function buildLocalContext(options) {
    const settings = options || {};
    const musicRoot = makeTempDir('spotifie-local-music-');
    const dataDir = makeTempDir('spotifie-local-data-');

    if (settings.buildLocal) settings.buildLocal(musicRoot);

    const library = new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    const rest = countingRest(catalogRows());
    const userState = new UserStateStore({ rootDir: path.join(dataDir, 'users') });
    const service = new CatalogService({
        library: library,
        global: new GlobalCatalog({ rest: rest }),
        userState: userState,
        deviceLibrary: new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') })
    });

    return {
        service,
        rest,
        userState,
        library,
        cleanup() {
            removeDir(musicRoot);
            removeDir(dataDir);
        }
    };
}

function withLocalTrack(root) {
    writeFile(
        root,
        path.join('Local Artist', 'Local Album', 'song.mp3'),
        buildMp3({ title: 'Local Song', artist: 'Local Artist', album: 'Local Album', filler: 'cacheA' })
    );
}

test('the local half comes back without Supabase being asked at all', async (t) => {
    const context = buildLocalContext({ buildLocal: withLocalTrack });
    t.after(() => context.cleanup());
    await context.library.scan();

    const before = context.rest._state.reads;
    const local = context.service.getLocalCatalog({ userId: null });

    assert.strictEqual(context.rest._state.reads, before, 'the published catalogue was not read');
    assert.strictEqual(local.tracks.length, 1, 'the music on this machine is there');
    assert.strictEqual(local.tracks[0].source, 'local');
    assert.ok(local.albums.length >= 1);

    // Saying it was not asked about is not saying it is gone.
    assert.strictEqual(local.sources.global.available, null);
    assert.strictEqual(local.sources.global.skipped, true);
});

test('the local half carries this listener s own state, and a guest gets none of it', async (t) => {
    const context = buildLocalContext({ buildLocal: withLocalTrack });
    t.after(() => context.cleanup());
    await context.library.scan();

    const listener = 'listener-0001';
    context.service.setAlbumOverrideForUser(listener, 'global-album:' + ALBUM_UUID, { title: 'My name for it' });

    const mine = context.service.getLocalCatalog({ userId: listener });
    assert.strictEqual(mine.overrides[ALBUM_UUID].title, 'My name for it');

    // Someone else at the same machine sees nothing of it.
    const guest = context.service.getLocalCatalog({ userId: null });
    assert.deepStrictEqual(guest.overrides, {});
    assert.deepStrictEqual(guest.hidden.globalAlbums, []);
});

// ============================================
// Over HTTP
// ============================================

function startRoutes(service) {
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
                headers: settings.headers || {}
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
                );
            }
        );
        req.on('error', reject);
        req.end();
    });
}

test('the local half is served on its own, and is never offered to a shared cache', async (t) => {
    const context = buildLocalContext({ buildLocal: withLocalTrack });
    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });
    await context.library.scan();

    const response = await request(started.port, '/api/catalog/local');
    assert.strictEqual(response.status, 200);

    const body = JSON.parse(response.body.toString());
    assert.strictEqual(body.tracks.length, 1);
    assert.strictEqual(body.sources.global.skipped, true);

    // It carries one person's state, so no cache anywhere may keep it.
    assert.strictEqual(response.headers['cache-control'], 'no-store');
});

test('the merged catalogue is never kept by a cache, because it is one person s view', async (t) => {
    const context = buildLocalContext({ buildLocal: withLocalTrack });
    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    for (const route of ['/api/catalog/albums', '/api/catalog/tracks', '/api/catalog/status']) {
        const response = await request(started.port, route);
        assert.strictEqual(response.headers['cache-control'], 'no-store', route + ' is never cached');
    }
});

test('a published cover is served from this origin and may be kept for good', async (t) => {
    const context = buildLocalContext({});
    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    // The picture itself, wherever the signed address happens to point.
    const bytes = Buffer.from('a picture', 'utf8');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    });
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const catalogue = await context.service.getAlbums({});
    const album = catalogue.items.find((entry) => entry.source === 'global');
    const version = album.metadata.artworkVersion;

    const response = await request(
        started.port,
        '/api/catalog/albums/' + encodeURIComponent(album.id) + '/artwork/image?v=' + version
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers['content-type'], 'image/jpeg');
    assert.strictEqual(response.body.toString(), 'a picture');

    // Named by which picture it is, so it may be kept indefinitely: a
    // different cover would be a different address.
    assert.match(response.headers['cache-control'], /public/);
    assert.match(response.headers['cache-control'], /immutable/);
    assert.strictEqual(response.headers.etag, '"' + version + '"');

    // And a browser that already has it is told so without the file being
    // fetched again.
    const again = await request(
        started.port,
        '/api/catalog/albums/' + encodeURIComponent(album.id) + '/artwork/image?v=' + version,
        { headers: { 'If-None-Match': '"' + version + '"' } }
    );
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.body.length, 0);
});

test('nothing signed reaches the page through the picture address', async (t) => {
    const context = buildLocalContext({});
    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    const catalogue = await context.service.getAlbums({});
    const album = catalogue.items.find((entry) => entry.source === 'global');

    const response = await request(started.port, '/api/catalog/albums');
    const body = response.body.toString();

    assert.doesNotMatch(body, /storage\/v1\/object\/sign|token=/, 'no signed address is in the catalogue');
    assert.match(album.artworkUrl, /^\/api\/catalog\//, 'covers are named by this origin');
});

// ============================================
// What the page does with all of this
// ============================================

test('the library is drawn from the copy before the catalogue is checked', () => {
    // The order matters: the copy first, the check afterwards, and the check
    // only when there was a copy to draw.
    assert.match(PLAYER_SOURCE, /const drewFromCache = await loadCatalogFromCache\(\);/);
    // A visit with nothing kept reads the catalogue, and holds the library's
    // shape while it does. A visit that drew from the copy does neither: real
    // cards are already on screen, and covering them would be a step back.
    assert.match(
        PLAYER_SOURCE,
        /if \(!drewFromCache\) \{[\s\S]{0,800}showLibrarySkeleton\(\);\s*await loadSongsConfig\(\);/
    );
    assert.match(PLAYER_SOURCE, /if \(drewFromCache\) scheduleCatalogRevalidation\(\);/);

    // The check happens after the library is on screen, not before it.
    const drawn = PLAYER_SOURCE.indexOf('await getAlbums();');
    const checked = PLAYER_SOURCE.indexOf('scheduleCatalogRevalidation();');
    assert.ok(drawn !== -1 && checked > drawn, 'nothing waits on the check');
});

test('a check that finds nothing new redraws nothing', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function revalidateCatalog()'),
        PLAYER_SOURCE.indexOf('/** Throw away the copy')
    );

    // The comparison, and the early return that follows it. Both halves are
    // checked: the published catalogue can be perfectly unchanged while the
    // music on this machine is not, and a check that watched only one of them
    // would leave the other stale.
    assert.match(section, /if \(fingerprint === renderedCatalogFingerprint && localPrint === renderedLocalFingerprint\) \{/);
    assert.match(section, /return false;/);

    // Nothing is redrawn before that comparison has been made.
    const compared = section.indexOf('fingerprint === renderedCatalogFingerprint');
    const applied = section.indexOf('applyCatalogData(');
    assert.ok(compared !== -1 && applied > compared, 'the catalogue is only arranged again once it has to be');
});

test('a catalogue nobody can reach leaves the library exactly as it is', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function revalidateCatalog()'),
        PLAYER_SOURCE.indexOf('/** Throw away the copy')
    );

    // A failed read returns without touching what is on screen, and without
    // touching the copy that is making it work.
    assert.match(section, /catch \(error\) \{[\s\S]*?return false;/);
    assert.match(section, /sources\.global\.available === false/);
    assert.ok(!/cache\.clear\(\)/.test(section), 'an outage never throws the copy away');

    // And a catalogue that could not be read is never written down as an
    // empty one.
    const remember = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function rememberPublishedCatalogue('),
        PLAYER_SOURCE.indexOf('async function loadCatalogFromCache()')
    );
    assert.match(remember, /if \(sources\.global && sources\.global\.available === false\) return;/);
});

test('a listener s own edits are put back on top of the copy', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function loadCatalogFromCache()'),
        PLAYER_SOURCE.indexOf('async function revalidateCatalog()')
    );

    // Their state comes from this machine, not from the shared copy.
    assert.match(section, /personalStateFrom\(local\)/);
    assert.match(section, /applyPersonalState\(snapshot\.albums, snapshot\.tracks, personal/);

    // Hidden albums, renamed albums, and songs they put into published ones.
    assert.match(section, /personal\.hiddenAlbums\.has\(album\.id\)/);
    assert.match(section, /applyAlbumOverrideLocally\(album/);
    assert.match(section, /attachPersonalTracksLocally\(/);
});

test('an administrator s change drops the copy this machine keeps', () => {
    const admin = fs.readFileSync(path.join(ROOT, 'js', 'admin.js'), 'utf8');

    assert.match(admin, /function forgetCachedCatalogue\(\)/);

    // Every path that changes the published catalogue drops the copy:
    // publishing a song, saving an album, deleting either, and the two bulk
    // actions that do the same thing to several at once.
    const calls = (admin.match(/forgetCachedCatalogue\(\);/g) || []).length;
    assert.strictEqual(calls, 5, 'every write invalidates the copy (' + calls + ')');

    // Including after a bulk change, which is where forgetting is easiest.
    const bulk = admin.slice(admin.indexOf('async function bulkDeleteSelected'), admin.indexOf('function initMaintenance'));
    assert.strictEqual((bulk.match(/forgetCachedCatalogue\(\);/g) || []).length, 2, 'both bulk actions invalidate it');
});

test('a first visit reads the catalogue and keeps what it read', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function loadSongsConfig()'),
        PLAYER_SOURCE.indexOf('function applyCatalogData(')
    );

    // The ordinary read, and the copy taken from it. Without this a first
    // visit would leave nothing behind and every visit would be a first one.
    assert.match(section, /await Promise\.all\(\[client\.getAlbums\(\), client\.getTracks\(\)\]\)/);
    assert.match(section, /rememberPublishedCatalogue\(albums\.items \|\| \[\], tracks\.items \|\| \[\]\)/);

    // And only the published half of it is kept.
    const remember = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function rememberPublishedCatalogue('),
        PLAYER_SOURCE.indexOf('async function loadCatalogFromCache()')
    );
    assert.match(remember, /album\.source === 'global'/);
    assert.match(remember, /track\.source === 'global'/);
});

test('two parts of the page asking at once make one request', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'catalogClient.js'), 'utf8');

    let calls = 0;
    const sandbox = {
        console: { warn() {}, error() {}, log() {} },
        fetch: () => {
            calls += 1;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ total: 0, items: [], sources: {} })
            });
        }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    const client = new sandbox.CatalogClient({});

    // The library asks for albums and songs, and something else asks for the
    // same albums in the same moment: two requests, not three.
    await Promise.all([client.getAlbums(), client.getTracks(), client.getAlbums()]);
    assert.strictEqual(calls, 2, 'the repeated question shared the journey already going');

    // Asking again afterwards is a fresh request: the sharing lasts as long as
    // the journey, not longer, so nothing is ever answered with stale rows.
    await client.getAlbums();
    assert.strictEqual(calls, 3);
});

test('the address of a published cover names the picture, not the moment', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'catalogClient.js'), 'utf8');

    const sandbox = { console: { warn() {}, error() {}, log() {} }, fetch: () => Promise.reject(new Error('no')) };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    const client = new sandbox.CatalogClient({});

    assert.strictEqual(
        client.artworkImageUrl('global-album:one', { kind: 'album', version: 'abc' }),
        '/api/catalog/albums/global-album%3Aone/artwork/image?v=abc'
    );
    assert.strictEqual(
        client.artworkImageUrl('global:two', { kind: 'track', version: null }),
        '/api/catalog/tracks/global%3Atwo/artwork/image'
    );
    assert.strictEqual(client.artworkImageUrl(null, { kind: 'album' }), null);
});

test('the page loads the cache before it loads the player', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    const cache = index.indexOf('js/catalogCache.js');
    const client = index.indexOf('js/catalogClient.js');
    const player = index.indexOf('js/script.js');

    assert.ok(cache !== -1, 'the cache is loaded');
    assert.ok(cache < client && client < player, 'and before the things that use it');
});
