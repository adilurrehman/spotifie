'use strict';

/**
 * The admin dashboard on a published (Cloudflare) copy.
 *
 * The failure this rules out: the dashboard opened but showed zero albums and
 * zero songs, because it was still asking a local Node server for
 * /api/catalog/albums, /api/catalog/tracks and /api/library/rescan - routes a
 * static host does not have. On a published copy the global catalogue is read
 * from, and written to, Supabase directly, exactly like the main app.
 *
 * These hold that line: the reads go to Supabase and never to /api/catalog on a
 * published copy; the writes map onto the real catalog tables and buckets; and
 * the local-only rescan is not attempted where there is no server to answer it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const admin = require('../js/admin.js');

// ============================================
// The dashboard loads what a published copy needs
// ============================================

test('the dashboard page loads the production config and the cloud catalogue reader', () => {
    const html = source('admin-dashboard.html');

    // Everything the main app reads before it asks a question. Without these the
    // dashboard cannot tell it is published and has no reader for the catalogue.
    ['js/config.js', 'js/deployment.js', 'js/auth.js', 'js/cloudCatalog.js', 'js/catalogClient.js', 'js/admin.js'].forEach(
        (script) => {
            assert.ok(html.indexOf('src="' + script + '"') !== -1, 'the dashboard loads ' + script);
        }
    );

    // config and deployment come before auth, and the cloud reader before the
    // catalogue client that uses it. Compared by the <script src> tag, since
    // the head comments also mention some of these file names.
    var at = function (name) {
        return html.indexOf('src="' + name + '"');
    };
    assert.ok(at('js/config.js') < at('js/deployment.js'), 'config before deployment');
    assert.ok(at('js/deployment.js') < at('js/auth.js'), 'deployment before auth');
    assert.ok(at('js/cloudCatalog.js') < at('js/catalogClient.js'), 'reader before the client');
    assert.ok(at('js/cloudCatalog.js') < at('js/admin.js'), 'reader before admin');
});

test('the local library rescan is skipped on a published copy', () => {
    const adminSource = source('js', 'admin.js');

    // The rescan is a local Node server action; on a published copy it is
    // guarded out rather than fired at a route that would 404.
    assert.match(adminSource, /if \(!isCloud\(\)\) \{[\s\S]{0,200}await rescanLibrary\(\);/);

    // The maintenance audit, the other local-server route, is guarded too.
    const audit = adminSource.slice(adminSource.indexOf('async function runMaintenanceAudit'), adminSource.indexOf('function renderMaintenanceSummary'));
    assert.match(audit, /if \(isCloud\(\)\) \{[\s\S]{0,200}return;/);
    assert.ok(audit.indexOf('/api/catalog/admin/maintenance') > audit.indexOf('if (isCloud())'), 'the fetch is only reached off the cloud path');

    // Every catalogue write goes through a wrapper that chooses Supabase on a
    // published copy and the server client on a checkout.
    ['createGlobalAlbum', 'updateGlobalAlbum', 'createGlobalTrack', 'updateGlobalTrack', 'deleteGlobalTrack', 'deleteGlobalAlbum'].forEach(
        (name) => {
            const re = new RegExp('function ' + name + '\\([^)]*\\) \\{\\s*return isCloud\\(\\) \\? cloudCatalogWrites');
            assert.match(adminSource, re, name + ' branches on isCloud()');
        }
    );
});

// ============================================
// Reads go to Supabase, never to /api/catalog
// ============================================

/** A Supabase client that answers catalogue reads from rows, counting calls. */
function fakeReadClient(rows) {
    const asked = [];
    return {
        asked: asked,
        from(table) {
            const query = {
                select(columns) {
                    asked.push(table);
                    return query;
                },
                order() {
                    return query;
                },
                then(resolve) {
                    return Promise.resolve({ data: rows[table] || [], error: null }).then(resolve);
                }
            };
            return query;
        },
        storage: { from() { return { createSignedUrl() { return Promise.resolve({ data: null, error: null }); } }; } }
    };
}

function loadCatalogueClient(supabase) {
    const fetched = [];
    const sandbox = {
        console: { warn() {}, log() {}, error() {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Promise: Promise,
        Object: Object,
        Map: Map,
        Set: Set,
        Array: Array,
        Error: Error,
        String: String,
        Number: Number,
        Boolean: Boolean,
        JSON: JSON,
        Date: Date,
        encodeURIComponent: encodeURIComponent,
        __SPOTIFIE_CONFIG__: {
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'public-anon-placeholder',
            publicSiteUrl: 'https://spotifie.example',
            deployment: 'cloudflare'
        },
        fetch(url) {
            fetched.push(String(url));
            return Promise.reject(new Error('no server on a published copy'));
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.spotifieAuth = { tryGetClient: () => Promise.resolve(supabase) };

    vm.createContext(sandbox);
    vm.runInContext(source('js', 'deployment.js'), sandbox);
    vm.runInContext(source('js', 'cloudCatalog.js'), sandbox);
    vm.runInContext(source('js', 'catalogClient.js'), sandbox);

    return { client: sandbox.spotifieCatalog, fetched: fetched, deployment: sandbox.spotifieDeployment };
}

test('a published dashboard reads the catalogue from Supabase, not from /api/catalog', async () => {
    const supabase = fakeReadClient({
        catalog_albums: [{ id: 'a1', title: 'Awaken', artist: 'X', album_artist: 'X', artwork_path: null }],
        catalog_tracks: [{ id: 't1', album_id: 'a1', title: 'One', artist: 'X', audio_path: 'audio/1.mp3', duration: 100 }]
    });

    const loaded = loadCatalogueClient(supabase);
    assert.strictEqual(loaded.deployment.isPublished(), true, 'the copy knows it is published');

    const albums = await loaded.client.getAlbums();
    const tracks = await loaded.client.getTracks();

    const globalAlbums = albums.items.filter((a) => a.source === 'global');
    const globalTracks = tracks.items.filter((t) => t.source === 'global');

    assert.strictEqual(globalAlbums.length, 1, 'the album came back');
    assert.strictEqual(globalTracks.length, 1, 'the track came back');
    assert.strictEqual(globalAlbums[0].id, 'global-album:a1');
    assert.strictEqual(globalTracks[0].id, 'global:t1');

    // Supabase was asked for the two tables, and nothing on this origin was.
    assert.ok(supabase.asked.indexOf('catalog_albums') !== -1, 'catalog_albums was read');
    assert.ok(supabase.asked.indexOf('catalog_tracks') !== -1, 'catalog_tracks was read');
    assert.ok(
        !loaded.fetched.some((url) => url.indexOf('/api/catalog') !== -1),
        'nothing was asked of /api/catalog'
    );
    assert.ok(
        !loaded.fetched.some((url) => url.indexOf('/api/library') !== -1),
        'and nothing of /api/library'
    );
});

// ============================================
// Writes go to the real tables and buckets
// ============================================

/** A Supabase client that records writes against an in-memory catalogue. */
function fakeWriteClient() {
    const store = { catalog_albums: new Map(), catalog_tracks: new Map() };
    const log = { inserts: [], updates: [], deletes: [], removed: [] };
    let counter = 0;

    function builder(table) {
        const state = { table: table, op: 'select', row: null, filters: {}, single: false };
        const b = {
            insert(row) { state.op = 'insert'; state.row = row; return b; },
            update(row) { state.op = 'update'; state.row = row; return b; },
            delete() { state.op = 'delete'; return b; },
            select() { if (state.op === 'select') state.op = 'select'; return b; },
            eq(col, val) { state.filters[col] = val; return b; },
            single() { state.single = true; return b; },
            then(resolve, reject) { return run(state).then(resolve, reject); }
        };
        // insert().select() must stay the insert op.
        b.insert = function (row) { state.op = 'insert'; state.row = row; return b; };
        return b;
    }

    function run(state) {
        const table = store[state.table];
        if (state.op === 'insert') {
            counter += 1;
            const id = 'uuid-' + counter;
            const saved = Object.assign({ id: id }, state.row);
            table.set(id, saved);
            log.inserts.push({ table: state.table, row: state.row });
            return Promise.resolve({ data: [saved], error: null });
        }
        if (state.op === 'update') {
            const id = state.filters.id;
            const existing = table.get(id) || { id: id };
            const updated = Object.assign({}, existing, state.row);
            table.set(id, updated);
            log.updates.push({ table: state.table, row: state.row, filters: state.filters });
            return Promise.resolve({ data: [updated], error: null });
        }
        if (state.op === 'delete') {
            const id = state.filters.id;
            table.delete(id);
            log.deletes.push({ table: state.table, filters: state.filters });
            return Promise.resolve({ data: null, error: null });
        }
        // select
        if (state.single) {
            const row = table.get(state.filters.id) || null;
            return Promise.resolve({ data: row, error: null });
        }
        const rows = Array.from(table.values()).filter((row) => {
            return Object.keys(state.filters).every((key) => row[key] === state.filters[key]);
        });
        return Promise.resolve({ data: rows, error: null });
    }

    return {
        store: store,
        log: log,
        seedAlbum(id, row) { store.catalog_albums.set(id, Object.assign({ id: id }, row)); },
        seedTrack(id, row) { store.catalog_tracks.set(id, Object.assign({ id: id }, row)); },
        from(table) { return builder(table); },
        storage: {
            from(bucket) {
                return {
                    remove(paths) {
                        log.removed.push({ bucket: bucket, paths: paths });
                        return Promise.resolve({ error: null });
                    }
                };
            }
        }
    };
}

test('creating an album writes the mapped columns to catalog_albums', async () => {
    const client = fakeWriteClient();
    const api = admin.cloudCatalogWrites(client);

    const result = await api.createAlbum({ title: 'Awaken', artist: 'X', albumArtist: null, description: 'a note', artworkPath: 'artwork/a.jpg' });

    assert.strictEqual(client.log.inserts.length, 1);
    assert.strictEqual(client.log.inserts[0].table, 'catalog_albums');
    assert.deepStrictEqual(client.log.inserts[0].row, {
        title: 'Awaken',
        artist: 'X',
        album_artist: 'X',
        description: 'a note',
        artwork_path: 'artwork/a.jpg'
    });
    assert.match(result.id, /^global-album:/);
});

test('creating a track writes the audio path and album link to catalog_tracks', async () => {
    const client = fakeWriteClient();
    const api = admin.cloudCatalogWrites(client);

    await api.createTrack({
        title: 'One',
        artist: 'X',
        albumArtist: null,
        albumId: 'global-album:abc',
        duration: 123,
        mimeType: 'audio/mpeg',
        audioPath: 'audio/one.mp3',
        artworkPath: null
    });

    assert.strictEqual(client.log.inserts[0].table, 'catalog_tracks');
    assert.strictEqual(client.log.inserts[0].row.album_id, 'abc', 'the album id is stored as a bare uuid');
    assert.strictEqual(client.log.inserts[0].row.audio_path, 'audio/one.mp3');
    assert.strictEqual(client.log.inserts[0].row.mime_type, 'audio/mpeg');
});

test('editing an album maps its fields and removes the cover it replaced', async () => {
    const client = fakeWriteClient();
    client.seedAlbum('a1', { artwork_path: 'artwork/old.jpg', title: 'Old' });
    const api = admin.cloudCatalogWrites(client);

    await api.updateAlbum('global-album:a1', { title: 'New', artist: 'Y', albumArtist: 'Y', description: '', artworkPath: 'artwork/new.jpg' });

    const update = client.log.updates.find((u) => u.table === 'catalog_albums');
    assert.ok(update, 'the album row was updated');
    assert.strictEqual(update.row.title, 'New');
    assert.strictEqual(update.row.album_artist, 'Y');
    assert.strictEqual(update.row.description, '', 'an emptied description is written, not dropped');
    assert.strictEqual(update.row.artwork_path, 'artwork/new.jpg');

    // The replaced cover was removed from the artwork bucket.
    assert.deepStrictEqual(client.log.removed, [{ bucket: 'catalog-artwork', paths: ['artwork/old.jpg'] }]);
});

test('editing a track maps albumId to a bare album_id uuid', async () => {
    const client = fakeWriteClient();
    const api = admin.cloudCatalogWrites(client);

    await api.updateTrack('global:t1', { title: 'Renamed', albumId: 'global-album:xyz' });

    const update = client.log.updates.find((u) => u.table === 'catalog_tracks');
    assert.strictEqual(update.filters.id, 't1');
    assert.strictEqual(update.row.title, 'Renamed');
    assert.strictEqual(update.row.album_id, 'xyz');
});

test('deleting a track removes the row and its stored files', async () => {
    const client = fakeWriteClient();
    client.seedTrack('t1', { audio_path: 'audio/1.mp3', artwork_path: 'artwork/1.jpg' });
    const api = admin.cloudCatalogWrites(client);

    await api.deleteTrack('global:t1');

    assert.deepStrictEqual(client.log.deletes, [{ table: 'catalog_tracks', filters: { id: 't1' } }]);
    const buckets = client.log.removed.map((r) => r.bucket).sort();
    assert.deepStrictEqual(buckets, ['catalog-artwork', 'catalog-audio']);
    assert.ok(client.store.catalog_tracks.get('t1') === undefined, 'the row is gone');
});

test('deleting an album deletes its tracks first, then the album and its cover', async () => {
    const client = fakeWriteClient();
    client.seedAlbum('a1', { artwork_path: 'artwork/album.jpg' });
    client.seedTrack('t1', { album_id: 'a1', audio_path: 'audio/1.mp3', artwork_path: null });
    client.seedTrack('t2', { album_id: 'a1', audio_path: 'audio/2.mp3', artwork_path: null });
    const api = admin.cloudCatalogWrites(client);

    await api.deleteAlbum('global-album:a1');

    const deletedTables = client.log.deletes.map((d) => d.table);
    // Two tracks then the album.
    assert.deepStrictEqual(deletedTables, ['catalog_tracks', 'catalog_tracks', 'catalog_albums']);
    assert.ok(client.store.catalog_albums.get('a1') === undefined, 'the album is gone');
    assert.ok(client.store.catalog_tracks.get('t1') === undefined && client.store.catalog_tracks.get('t2') === undefined, 'its tracks are gone');
    // Both track audio files and the album cover were removed from storage.
    const removedPaths = client.log.removed.map((r) => r.paths[0]).sort();
    assert.deepStrictEqual(removedPaths, ['artwork/album.jpg', 'audio/1.mp3', 'audio/2.mp3']);
});

test('a row-level-security refusal reads as administrator access required', async () => {
    const client = {
        from() {
            return {
                insert() { return this; },
                select() { return Promise.resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }); }
            };
        }
    };
    const api = admin.cloudCatalogWrites(client);

    await assert.rejects(
        () => api.createAlbum({ title: 'Blocked' }),
        (err) => err.status === 403
    );
});

test('the id parsers accept only their own namespace', () => {
    assert.strictEqual(admin.parseAlbumUuid('global-album:abc'), 'abc');
    assert.strictEqual(admin.parseTrackUuid('global:xyz'), 'xyz');
    assert.strictEqual(admin.parseAlbumUuid('global:xyz'), null, 'a track id is not an album id');
    assert.strictEqual(admin.parseTrackUuid('global-album:abc'), null, 'an album id is not a track id');
    assert.strictEqual(admin.parseTrackUuid(null), null);
});
