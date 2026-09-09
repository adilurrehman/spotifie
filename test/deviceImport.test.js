'use strict';

/**
 * Music imported from a person's own device.
 *
 * The audio is written to this machine, under that account, and stays there:
 * these tests check that it plays for its owner, that nobody else can see or
 * fetch it, that a published album can hold it for one listener without the
 * shared catalogue changing, and that not one byte of it is ever sent to
 * Supabase.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { GlobalCatalog } = require('../lib/globalCatalog');
const { UserStateStore } = require('../lib/userState');
const { UserMediaStore } = require('../lib/userMedia');
const { DeviceLibrary } = require('../lib/deviceLibrary');
const { MediaTickets } = require('../lib/mediaTickets');
const { CatalogService } = require('../lib/catalogService');
const { createLibraryRoutes } = require('../lib/libraryRoutes');
const { createCatalogRoutes } = require('../lib/catalogRoutes');
const { buildMp3, makeTempDir, removeDir } = require('./helpers/fixtures');

const USER_A = 'user-alice';
const USER_B = 'user-bobby';
const ALBUM_UUID = '11111111-1111-4111-8111-111111111111';
const TRACK_UUID = '33333333-3333-4333-8333-333333333333';

// ============================================
// Harness
// ============================================

/** A Supabase stand-in that records every write it is asked to make. */
function makeFakeRest() {
    const state = {
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
        ],
        writes: []
    };

    return {
        _state: state,
        async selectRows(table) {
            return (table === 'catalog_albums' ? state.albums : state.tracks).slice();
        },
        async insertRow(table, row) {
            state.writes.push({ op: 'insert', table: table, row: row });
            throw new Error('row-level security policy');
        },
        async updateRows(table, query) {
            state.writes.push({ op: 'update', table: table, query: query });
            throw new Error('row-level security policy');
        },
        async deleteRows(table, query) {
            state.writes.push({ op: 'delete', table: table, query: query });
            throw new Error('row-level security policy');
        },
        async uploadObject(bucket, objectPath) {
            state.writes.push({ op: 'upload', bucket: bucket, objectPath: objectPath });
            throw new Error('row-level security policy');
        },
        async createSignedUrl(bucket, objectPath) {
            return 'https://example.supabase.co/storage/v1/object/sign/' + bucket + '/' + objectPath + '?token=signed';
        },
        async removeStorageObject(bucket, objectPath) {
            state.writes.push({ op: 'remove', bucket: bucket, objectPath: objectPath });
            throw new Error('row-level security policy');
        }
    };
}

/**
 * A whole local installation: shared music root, per-account media, catalogue
 * and the two HTTP surfaces, with the caller's account supplied by the test
 * instead of by Supabase.
 */
function buildInstallation() {
    const musicRoot = makeTempDir('spotifie-import-music-');
    const dataDir = makeTempDir('spotifie-import-data-');

    const library = new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    const userMedia = new UserMediaStore({
        mediaRoot: path.join(dataDir, 'media'),
        stateRoot: path.join(dataDir, 'users')
    });
    const tickets = new MediaTickets({ secret: 'test-secret-for-media-tickets' });
    const userState = new UserStateStore({ rootDir: path.join(dataDir, 'users') });
    const rest = makeFakeRest();

    // Its own device folder, so a test never sees the music of the machine it
    // happens to be running on.
    const deviceLibrary = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });

    const service = new CatalogService({
        library: library,
        global: new GlobalCatalog({ rest: rest }),
        userState: userState,
        userMedia: userMedia,
        deviceLibrary: deviceLibrary,
        tickets: tickets
    });

    // Who the caller is, as the tests decide; the routes never take it from
    // the request body or a query parameter.
    let caller = null;

    const libraryRoutes = createLibraryRoutes({
        service: library,
        userMedia: userMedia,
        deviceLibrary: deviceLibrary,
        tickets: tickets,
        artworkOptions: { directory: path.join(dataDir, 'user-artwork') },
        resolveCaller: () => caller
    });

    return {
        musicRoot: musicRoot,
        dataDir: dataDir,
        library: library,
        userMedia: userMedia,
        tickets: tickets,
        userState: userState,
        rest: rest,
        service: service,
        libraryRoutes: libraryRoutes,
        signIn(userId) {
            caller = userId;
        },
        signOut() {
            caller = null;
        },
        cleanup() {
            removeDir(musicRoot);
            removeDir(dataDir);
        }
    };
}

function startServer(installation) {
    const catalogRoutes = createCatalogRoutes({ service: installation.service });

    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const query = Object.fromEntries(parsed.searchParams.entries());

        if (await installation.libraryRoutes.handle(req, res, parsed.pathname, query)) return;
        if (await catalogRoutes.handle(req, res, parsed.pathname, query)) return;

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
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
                headers: settings.headers || {}
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks)
                    })
                );
            }
        );
        req.on('error', reject);
        if (settings.body) req.write(settings.body);
        req.end();
    });
}

/** Send one audio file the way the browser does: the file itself, as the body. */
function upload(port, name, body, contentType) {
    return request(port, '/api/library/imports?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': contentType || 'audio/mpeg' },
        body: body
    });
}

function song(title, filler) {
    return buildMp3({ title: title, artist: 'Home Recording', album: 'Imports', filler: filler });
}

// ============================================
// Tests
// ============================================

test('a file from this device is saved locally and indexed like any other track', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);
    const response = await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'importA'));
    assert.strictEqual(response.status, 201);

    const payload = JSON.parse(response.body.toString());
    assert.match(payload.track.id, /^[0-9a-f]{64}$/, 'a content-hash id, as the scanner makes');
    assert.strictEqual(payload.track.title, 'Night Drive');
    assert.strictEqual(payload.track.artist, 'Home Recording');
    assert.strictEqual(payload.duplicate, false);

    // The file is on this machine, under this account.
    const stored = fs.readdirSync(path.join(installation.dataDir, 'media', USER_A));
    assert.deepStrictEqual(stored, ['Night Drive.mp3']);

    // Nothing in the answer says where.
    const text = response.body.toString();
    assert.ok(!text.includes(installation.dataDir), 'no filesystem path is returned');
    assert.ok(!text.includes('media'), 'no folder is named');
    assert.ok(!/base64|data:audio/i.test(text), 'no audio is inlined');
});

test('imported music plays for its owner and for nobody else', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);
    const imported = JSON.parse((await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'importA'))).body.toString());
    const trackId = imported.track.id;

    // The owner's URL carries a ticket, and it plays - including a byte range.
    assert.match(imported.track.streamUrl, /\/api\/library\/tracks\/[0-9a-f]{64}\/stream\?ticket=/);
    const stream = await request(started.port, imported.track.streamUrl);
    assert.strictEqual(stream.status, 200);
    assert.ok(stream.body.length > 0);

    const ranged = await request(started.port, imported.track.streamUrl, { headers: { Range: 'bytes=0-49' } });
    assert.strictEqual(ranged.status, 206);
    assert.strictEqual(ranged.body.length, 50);

    const plainPath = '/api/library/tracks/' + trackId + '/stream';

    // Another signed-in person cannot fetch it, with or without the ticket.
    installation.signIn(USER_B);
    assert.strictEqual((await request(started.port, plainPath)).status, 404);
    const borrowed = await request(started.port, imported.track.streamUrl);
    assert.strictEqual(borrowed.status, 200, 'a ticket is what grants access');
    assert.strictEqual(
        installation.tickets.verify(new URL('http://x' + imported.track.streamUrl).searchParams.get('ticket'), trackId),
        USER_A,
        'and the ticket names its owner'
    );

    // A guest gets nothing, and is told nothing about whether it exists.
    installation.signOut();
    assert.strictEqual((await request(started.port, plainPath)).status, 404);
    assert.strictEqual((await request(started.port, '/api/library/tracks/' + trackId)).status, 404);
    assert.strictEqual((await request(started.port, '/api/library/imports')).status, 401);
});

test('one account never sees another account imported music', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);
    await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'importA'));

    const mine = await installation.service.getTracks({ userId: USER_A });
    assert.strictEqual(mine.items.filter((track) => track.title === 'Night Drive').length, 1);

    const theirs = await installation.service.getTracks({ userId: USER_B });
    assert.ok(!theirs.items.some((track) => track.title === 'Night Drive'), 'not in another account catalogue');

    const guest = await installation.service.getTracks({});
    assert.ok(!guest.items.some((track) => track.title === 'Night Drive'), 'not in the guest catalogue');

    installation.signIn(USER_B);
    const listed = JSON.parse((await request(started.port, '/api/library/imports')).body.toString());
    assert.strictEqual(listed.total, 0, 'another account lists none of it');
});

test('importing music writes nothing at all to Supabase', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);
    const imported = JSON.parse((await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'importA'))).body.toString());

    // Put it in a published album as well: still nothing upstream.
    await request(started.port, '/api/catalog/albums/' + encodeURIComponent('global-album:' + ALBUM_UUID) + '/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'local:' + imported.track.id })
    });
    installation.service.addTrackToAlbumForUser(USER_A, 'global-album:' + ALBUM_UUID, 'local:' + imported.track.id);

    assert.deepStrictEqual(installation.rest._state.writes, [], 'no row and no stored object was written');
    assert.strictEqual(installation.rest._state.tracks.length, 1, 'catalog_tracks is unchanged');
    assert.strictEqual(installation.rest._state.albums.length, 1, 'catalog_albums is unchanged');
    assert.strictEqual(installation.rest._state.albums[0].title, 'Afterglow');
});

test('a published album can hold one listener own song without changing for anyone else', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    const albumId = 'global-album:' + ALBUM_UUID;

    installation.signIn(USER_A);
    const imported = JSON.parse((await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'importA'))).body.toString());
    const trackId = 'local:' + imported.track.id;

    installation.service.addTrackToAlbumForUser(USER_A, albumId, trackId);

    // For this listener the album holds both: the published song and theirs.
    const mine = await installation.service.getTracks({ userId: USER_A, albumId: albumId });
    const ids = mine.items.map((track) => track.id);
    assert.ok(ids.includes('global:' + TRACK_UUID), 'the published track is still there');
    assert.ok(ids.includes(trackId), 'and their own song is too');
    assert.strictEqual(mine.items.find((track) => track.id === trackId).source, 'local');

    // For everybody else the album is exactly as published.
    const theirs = await installation.service.getTracks({ userId: USER_B, albumId: albumId });
    assert.deepStrictEqual(theirs.items.map((track) => track.id), ['global:' + TRACK_UUID]);

    const guest = await installation.service.getTracks({ albumId: albumId });
    assert.deepStrictEqual(guest.items.map((track) => track.id), ['global:' + TRACK_UUID]);

    // The published tracks keep playing from the shared catalogue.
    const globalStream = await installation.service.resolveStreamUrl('global:' + TRACK_UUID, { userId: USER_A });
    assert.strictEqual(globalStream.source, 'global');
    assert.match(globalStream.url, /catalog-audio\/audio\/afterglow\.mp3/);

    // And the added song plays from this device, for its owner only.
    const localStream = await installation.service.resolveStreamUrl(trackId, { userId: USER_A });
    assert.strictEqual(localStream.source, 'local-personal');
    assert.match(localStream.url, /^\/api\/library\/tracks\/[0-9a-f]{64}\/stream\?ticket=/);
    assert.strictEqual(await installation.service.resolveStreamUrl(trackId, { userId: USER_B }), null);
    assert.strictEqual(await installation.service.resolveStreamUrl(trackId, {}), null);
});

test('taking a song out of an album leaves the file on this device', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    const albumId = 'global-album:' + ALBUM_UUID;

    installation.signIn(USER_A);
    const imported = JSON.parse((await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'importA'))).body.toString());
    const trackId = 'local:' + imported.track.id;

    installation.service.addTrackToAlbumForUser(USER_A, albumId, trackId);
    const removal = installation.service.removeTrackFromAlbumForUser(USER_A, albumId, trackId);
    assert.strictEqual(removal.removed, true);

    const inAlbum = await installation.service.getTracks({ userId: USER_A, albumId: albumId });
    assert.deepStrictEqual(inAlbum.items.map((track) => track.id), ['global:' + TRACK_UUID]);

    // The song itself is untouched: still on disk, still in their library.
    assert.deepStrictEqual(fs.readdirSync(path.join(installation.dataDir, 'media', USER_A)), ['Night Drive.mp3']);
    const all = await installation.service.getTracks({ userId: USER_A });
    assert.ok(all.items.some((track) => track.id === trackId), 'the track is still in their library');
});

test('imported music and its album membership survive a restart', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    const albumId = 'global-album:' + ALBUM_UUID;

    installation.signIn(USER_A);
    const imported = JSON.parse((await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'importA'))).body.toString());
    const trackId = 'local:' + imported.track.id;
    installation.service.addTrackToAlbumForUser(USER_A, albumId, trackId);

    // Everything a restart needs is on disk, and it is metadata only.
    const stateFile = path.join(installation.dataDir, 'users', USER_A, 'state.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepStrictEqual(saved.globalAlbumTrackAdds[ALBUM_UUID], [trackId]);
    assert.ok(!/base64|blob:|data:audio/i.test(JSON.stringify(saved)), 'no audio and no temporary URL is stored');

    // A second installation over the same folders, as after a restart.
    const restartedMedia = new UserMediaStore({
        mediaRoot: path.join(installation.dataDir, 'media'),
        stateRoot: path.join(installation.dataDir, 'users')
    });
    const restarted = new CatalogService({
        library: installation.library,
        global: new GlobalCatalog({ rest: installation.rest }),
        userState: new UserStateStore({ rootDir: path.join(installation.dataDir, 'users') }),
        userMedia: restartedMedia,
        tickets: new MediaTickets({ secret: 'test-secret-for-media-tickets' })
    });

    const tracks = await restarted.getTracks({ userId: USER_A, albumId: albumId });
    assert.ok(tracks.items.some((track) => track.id === trackId), 'the song is still in the album');
    assert.strictEqual(restartedMedia.getTracks(USER_A).length, 1, 'and still in their library');
});

test('the album a listener sees counts their own songs too', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    const albumId = 'global-album:' + ALBUM_UUID;
    installation.signIn(USER_A);

    const first = JSON.parse((await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'countA'))).body.toString());
    const second = JSON.parse((await upload(started.port, 'Morning.mp3', song('Morning', 'countB'))).body.toString());

    installation.service.addTrackToAlbumForUser(USER_A, albumId, 'local:' + first.track.id);
    installation.service.addTrackToAlbumForUser(USER_A, albumId, 'local:' + second.track.id);

    const catalog = await installation.service.getCatalog({ userId: USER_A });
    const inAlbum = catalog.tracks.filter((track) => track.albumId === albumId);
    assert.strictEqual(inAlbum.length, 3, 'the published song and both of theirs');
    assert.deepStrictEqual(catalog.addedToGlobalAlbums[ALBUM_UUID], [
        'local:' + first.track.id,
        'local:' + second.track.id
    ]);

    // Music someone imported is music on this machine: it joins Local Music
    // rather than becoming an album of its own from whatever its tags say.
    const albums = await installation.service.getAlbums({ userId: USER_A });
    const localMusic = albums.items.find((album) => album.id === 'system:local-music');
    assert.ok(localMusic, 'Local Music is listed');
    assert.strictEqual(localMusic.title, 'Local Music');
    assert.strictEqual(localMusic.trackCount, 2, 'holding both imported songs');
    assert.ok(!albums.items.some((album) => album.title === 'Imports'), 'and no album made from their tags');

    // The tags themselves are untouched, so search still has them.
    const mine = await installation.service.getTracks({ userId: USER_A });
    assert.ok(
        mine.items.filter((track) => track.source === 'local').every((track) => track.album === 'Imports'),
        'each song keeps the album it says it is from'
    );

    // A guest has none of it: imported music belongs to the account that
    // imported it.
    const guestAlbums = await installation.service.getAlbums({});
    assert.ok(!guestAlbums.items.some((album) => album.id === 'system:local-music'), 'and only for them');
});

test('the same file twice is one song, and a name already taken is not overwritten', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);
    const audio = song('Night Drive', 'sameA');

    const first = await upload(started.port, 'Night Drive.mp3', audio);
    const again = await upload(started.port, 'Night Drive.mp3', audio);

    assert.strictEqual(first.status, 201);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(JSON.parse(again.body.toString()).duplicate, true);
    assert.deepStrictEqual(fs.readdirSync(path.join(installation.dataDir, 'media', USER_A)), ['Night Drive.mp3']);

    // A different song under a name already taken keeps both files.
    const other = await upload(started.port, 'Night Drive.mp3', song('Another Night', 'sameB'));
    assert.strictEqual(other.status, 201);
    const files = fs.readdirSync(path.join(installation.dataDir, 'media', USER_A)).sort();
    assert.deepStrictEqual(files, ['Night Drive (2).mp3', 'Night Drive.mp3']);
    assert.strictEqual(installation.userMedia.getTracks(USER_A).length, 2);
});

test('a file the library cannot use is refused, and nothing is kept', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);

    const wrongType = await upload(started.port, 'notes.txt', Buffer.from('not audio'), 'text/plain');
    assert.strictEqual(wrongType.status, 415);
    assert.strictEqual(JSON.parse(wrongType.body.toString()).code, 'unsupported-type');

    const corrupt = await upload(started.port, 'broken.mp3', Buffer.from('this is not an mp3 at all'));
    assert.strictEqual(corrupt.status, 415);
    assert.strictEqual(JSON.parse(corrupt.body.toString()).code, 'unreadable');

    const empty = await upload(started.port, 'silence.mp3', Buffer.alloc(0));
    assert.strictEqual(empty.status, 400);

    assert.deepStrictEqual(fs.readdirSync(path.join(installation.dataDir, 'media', USER_A)), [], 'nothing was left behind');
    assert.strictEqual(installation.userMedia.getTracks(USER_A).length, 0);

    // A good file still imports afterwards: one refusal costs only that file.
    const good = await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'afterFail'));
    assert.strictEqual(good.status, 201);
    assert.strictEqual(installation.userMedia.getTracks(USER_A).length, 1);
});

test('a file bigger than this device accepts is refused before it is kept', async (t) => {
    const installation = buildInstallation();
    installation.userMedia.maxFileBytes = 4096;
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);
    const big = Buffer.concat([song('Long One', 'big'), Buffer.alloc(8192, 0x55)]);
    const response = await upload(started.port, 'Long One.mp3', big);

    assert.strictEqual(response.status, 413);
    assert.strictEqual(JSON.parse(response.body.toString()).code, 'too-large');
    assert.deepStrictEqual(fs.readdirSync(path.join(installation.dataDir, 'media', USER_A)), []);
});

test('a name cannot choose where the file lands', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signIn(USER_A);

    const escapes = [
        '../../escaped.mp3',
        '..\\..\\escaped.mp3',
        '/etc/passwd.mp3',
        'C:/Windows/System32/evil.mp3',
        '../../../package.json.mp3'
    ];

    for (const name of escapes) {
        const response = await upload(started.port, name, song('Contained', name));
        assert.ok(response.status === 200 || response.status === 201, name + ' was handled');
    }

    // Everything landed in this account's own folder, and nowhere else.
    const inside = fs.readdirSync(path.join(installation.dataDir, 'media', USER_A));
    assert.strictEqual(inside.length, escapes.length);
    for (const name of inside) {
        assert.ok(!name.includes('..'), name + ' has no traversal left');
        assert.ok(!name.includes('/') && !name.includes('\\'), name + ' is a plain name');
    }
    assert.ok(!fs.existsSync(path.join(installation.dataDir, 'escaped.mp3')), 'nothing escaped the media folder');
    assert.ok(!fs.existsSync(path.join(installation.dataDir, 'media', 'escaped.mp3')));
});

test('a guest cannot import anything', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    installation.signOut();
    const response = await upload(started.port, 'Night Drive.mp3', song('Night Drive', 'guest'));
    assert.strictEqual(response.status, 401);
    assert.ok(!fs.existsSync(path.join(installation.dataDir, 'media')), 'no folder was made for a guest');

    const albumId = 'global-album:' + ALBUM_UUID;
    const added = await request(started.port, '/api/catalog/albums/' + encodeURIComponent(albumId) + '/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'local:' + 'a'.repeat(64) })
    });
    assert.strictEqual(added.status, 401);
});

test('only music this account has can be put into an album', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    const albumId = 'global-album:' + ALBUM_UUID;

    assert.throws(
        () => installation.service.addTrackToAlbumForUser(USER_A, albumId, 'local:' + 'b'.repeat(64)),
        /not in your library/i,
        'a track nobody has cannot be added'
    );
    assert.throws(
        () => installation.service.addTrackToAlbumForUser(USER_A, albumId, 'global:' + TRACK_UUID),
        /music on this device/i,
        'a published track is not copied into an album'
    );
    assert.throws(
        () => installation.service.addTrackToAlbumForUser(null, albumId, 'local:' + 'b'.repeat(64)),
        /signed-in/i
    );
    assert.deepStrictEqual(installation.service.getAlbumTrackAddsForUser(USER_A), {});
});

test('a batch stops at the limit the modal states', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    assert.match(player, /if \(deviceFilesToImport\.length >= MAX_SONGS_PER_BATCH\)/, 'the picker stops at the batch limit');
    assert.match(player, /const files = deviceFilesToImport\.slice\(0, MAX_SONGS_PER_BATCH\);/, 'and so does the import');
    assert.match(player, /DEVICE_AUDIO_EXTENSIONS = \['\.mp3', '\.flac', '\.wav', '\.m4a', '\.aac', '\.ogg', '\.opus'\]/);
});

test('the device flow keeps audio on this device and away from Supabase', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, '..', 'js', 'catalogClient.js'), 'utf8');
    const media = fs.readFileSync(path.join(__dirname, '..', 'lib', 'userMedia.js'), 'utf8');
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'libraryRoutes.js'), 'utf8');

    // The file goes to this server, as the file itself.
    assert.match(client, /CatalogClient\.prototype\.importDeviceTrack = function \(file\)/);
    assert.match(client, /'\/api\/library\/imports\?name='/);
    assert.match(client, /body: file/);

    // Not through Base64, a blob: URL, or the browser's own storage.
    const deviceSection = player.slice(
        player.indexOf('const DEVICE_AUDIO_EXTENSIONS'),
        player.indexOf('function showAddSongsModal')
    );
    assert.ok(deviceSection.length > 0, 'the device section was found');
    assert.ok(!/FileReader|readAsDataURL|btoa\(|createObjectURL|base64/i.test(deviceSection), 'no encoding and no blob URL');
    assert.ok(!/localStorage|indexedDB|IDBDatabase/.test(deviceSection), 'no audio kept in the browser');
    assert.ok(!/supabase|catalog_tracks|catalog_albums|catalog-audio|catalog-artwork/i.test(deviceSection));

    // Neither the store nor the endpoints can reach the shared catalogue.
    assert.ok(!/catalog_tracks|catalog_albums|catalog-audio|catalog-artwork/i.test(media), 'the media store names no upstream table or bucket');
    assert.ok(!/globalCatalog|supabaseRest|createSignedUrl|uploadObject/.test(media), 'and calls nothing upstream');
    assert.ok(!/uploadObject|catalog-audio|catalog-artwork/.test(routes), 'the library routes upload nothing upstream');

    // The account comes from the session, never from the request.
    assert.match(routes, /const token = bearerToken\(req\);/);
    assert.match(routes, /const user = await identifyToken\(token\);/);
    assert.ok(!/query\.userId|body\.userId|headers\['x-user/i.test(routes), 'the caller cannot name themselves');
});
