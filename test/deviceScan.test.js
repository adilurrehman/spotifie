'use strict';

/**
 * Searching this device for music.
 *
 * What is found belongs to the machine, not to an account: a guest may ask for
 * it, and a guest, one signed-in listener and the next all see the same songs.
 * What stays personal is what an account does with them.
 *
 * The search looks only where it is allowed to, keeps out of system and
 * program folders, survives whatever it finds there - unreadable folders, loops
 * made of links, files that are not music - reports counts and never a path,
 * and sends nothing to Supabase.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const {
    DeviceMusicScanner,
    defaultMusicLocations,
    describeMusicLocations,
    normalizeRoot,
    rejectCandidate,
    isSkippableName
} = require('../lib/deviceScan');
const { DeviceLibrary } = require('../lib/deviceLibrary');
const { UserMediaStore } = require('../lib/userMedia');
const { MediaTickets } = require('../lib/mediaTickets');
const { UserStateStore } = require('../lib/userState');
const { CatalogService } = require('../lib/catalogService');
const { GlobalCatalog } = require('../lib/globalCatalog');
const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { createLibraryRoutes } = require('../lib/libraryRoutes');
const { createCatalogRoutes } = require('../lib/catalogRoutes');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const USER_A = 'user-alice';
const USER_B = 'user-bobby';

const PLAYER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
const SCANNER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deviceScan.js'), 'utf8');
const ROUTES_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'libraryRoutes.js'), 'utf8');

// A song big enough to look like one: the search passes over anything smaller
// than half a megabyte, because that is a sound effect, not a track.
function song(title, filler, padBytes) {
    const audio = buildMp3({ title: title, artist: 'Home Recording', album: 'Found Music', filler: filler });
    const padding = Buffer.alloc(padBytes === undefined ? 600 * 1024 : padBytes, 0x00);
    return Buffer.concat([audio, padding]);
}

/** A Supabase stand-in that refuses and records every write. */
function makeFakeRest() {
    const state = { albums: [], tracks: [], writes: [] };
    function refuse(op, what) {
        state.writes.push({ op: op, what: what });
        throw new Error('row-level security policy');
    }
    return {
        _state: state,
        async selectRows(table) {
            return (table === 'catalog_albums' ? state.albums : state.tracks).slice();
        },
        async insertRow(table) {
            return refuse('insert', table);
        },
        async updateRows(table) {
            return refuse('update', table);
        },
        async deleteRows(table) {
            return refuse('delete', table);
        },
        async uploadObject(bucket) {
            return refuse('upload', bucket);
        },
        async removeStorageObject(bucket) {
            return refuse('remove', bucket);
        },
        async createSignedUrl(bucket, objectPath) {
            return 'https://example.supabase.co/storage/v1/object/sign/' + bucket + '/' + objectPath;
        }
    };
}

function buildInstallation(options) {
    const settings = options || {};
    const musicFolder = makeTempDir('spotifie-scan-music-');
    const dataDir = makeTempDir('spotifie-scan-data-');
    const sharedRoot = makeTempDir('spotifie-scan-shared-');

    const library = new LibraryService({
        musicRoot: sharedRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: sharedRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    const deviceLibrary = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });

    const userMedia = new UserMediaStore({
        mediaRoot: path.join(dataDir, 'media'),
        stateRoot: path.join(dataDir, 'users')
    });

    const scanner = new DeviceMusicScanner(
        Object.assign(
            {
                deviceLibrary: deviceLibrary,
                // Only the folders this test made, never the real machine.
                locations: { homeDir: null, musicRoot: musicFolder, mediaRoot: null, extraRoots: [] },
                batchSize: 4
            },
            settings.scanner || {}
        )
    );

    const rest = makeFakeRest();
    const tickets = new MediaTickets({ secret: 'scan-test-secret' });

    const service = new CatalogService({
        library: library,
        global: new GlobalCatalog({ rest: rest }),
        userState: new UserStateStore({ rootDir: path.join(dataDir, 'users') }),
        userMedia: userMedia,
        deviceLibrary: deviceLibrary,
        tickets: tickets
    });

    let caller = null;
    const routes = createLibraryRoutes({
        service: library,
        userMedia: userMedia,
        deviceLibrary: deviceLibrary,
        tickets: tickets,
        scanner: scanner,
        artworkOptions: { directory: path.join(dataDir, 'user-artwork') },
        resolveCaller: () => caller
    });

    return {
        musicFolder: musicFolder,
        sharedRoot: sharedRoot,
        dataDir: dataDir,
        library: library,
        deviceLibrary: deviceLibrary,
        userMedia: userMedia,
        scanner: scanner,
        service: service,
        rest: rest,
        routes: routes,
        signIn(userId) {
            caller = userId;
        },
        signOut() {
            caller = null;
        },
        cleanup() {
            removeDir(musicFolder);
            removeDir(sharedRoot);
            removeDir(dataDir);
        }
    };
}

/** Wait for the search to finish. */
async function waitForScan(scanner, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    while (scanner.isRunning()) {
        if (Date.now() > deadline) throw new Error('the scan did not finish');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return scanner.statusFor();
}

function startServer(installation) {
    const catalogRoutes = createCatalogRoutes({ service: installation.service });

    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const query = Object.fromEntries(parsed.searchParams.entries());
        if (await installation.routes.handle(req, res, parsed.pathname, query)) return;
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
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
                );
            }
        );
        req.on('error', reject);
        req.end();
    });
}

// ============================================
// Where a search is allowed to look
// ============================================

test('a search looks in music folders and never in system or program folders', () => {
    const home = makeTempDir('spotifie-home-');
    const musicRoot = makeTempDir('spotifie-root-');
    try {
        fs.mkdirSync(path.join(home, 'Music'));
        fs.mkdirSync(path.join(home, 'AppData'));

        const locations = defaultMusicLocations({ homeDir: home, musicRoot: musicRoot, mediaRoot: null, extraRoots: [] });

        assert.ok(locations.includes(path.join(home, 'Music')), 'the music folder is searched');
        assert.ok(locations.includes(path.resolve(musicRoot)), 'and the configured music root');
        assert.ok(!locations.includes(path.join(home, 'AppData')), 'application data is not');

        for (const name of ['Windows', 'Program Files', 'node_modules', '.git', '.spotifie', '$Recycle.Bin', 'AppData']) {
            assert.strictEqual(isSkippableName(name), true, name + ' is skipped');
        }
        assert.strictEqual(isSkippableName('Albums'), false, 'an ordinary folder is not');
    } finally {
        removeDir(home);
        removeDir(musicRoot);
    }
});

test('a folder inside another that is already searched is not searched twice', () => {
    const home = makeTempDir('spotifie-home-');
    try {
        fs.mkdirSync(path.join(home, 'Music'));
        fs.mkdirSync(path.join(home, 'Music', 'Albums'));

        const locations = defaultMusicLocations({
            homeDir: home,
            musicRoot: path.join(home, 'Music', 'Albums'),
            mediaRoot: null,
            extraRoots: [path.join(home, 'Music')]
        });

        assert.deepStrictEqual(locations, [path.join(home, 'Music')], 'the folder that contains the others wins');
    } finally {
        removeDir(home);
    }
});

test('only files that could be songs are considered', () => {
    const limits = { minBytes: 512 * 1024, maxBytes: 500 * 1024 * 1024 };

    assert.strictEqual(rejectCandidate('song.mp3', 2 * 1024 * 1024, limits), null);
    for (const name of ['song.flac', 'song.wav', 'song.m4a', 'song.aac', 'song.ogg', 'song.opus']) {
        assert.strictEqual(rejectCandidate(name, 2 * 1024 * 1024, limits), null, name + ' is music');
    }

    assert.strictEqual(rejectCandidate('notes.txt', 2 * 1024 * 1024, limits), 'unsupported');
    assert.strictEqual(rejectCandidate('video.mp4', 2 * 1024 * 1024, limits), 'unsupported');
    assert.strictEqual(rejectCandidate('blip.mp3', 1024, limits), 'too-small');
    assert.strictEqual(rejectCandidate('huge.wav', 900 * 1024 * 1024, limits), 'too-large');
});

// ============================================
// The search itself
// ============================================

test('a search finds the music in a folder and leaves everything else alone', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, path.join('Albums', 'one.mp3'), song('One', 'scanA'));
    writeFile(installation.musicFolder, path.join('Albums', 'two.mp3'), song('Two', 'scanB'));
    writeFile(installation.musicFolder, 'notes.txt', Buffer.alloc(700 * 1024, 0x20));
    writeFile(installation.musicFolder, 'blip.mp3', Buffer.alloc(2048, 0x11));
    writeFile(installation.musicFolder, 'clip.mp4', Buffer.alloc(700 * 1024, 0x22));
    writeFile(installation.musicFolder, path.join('node_modules', 'library', 'bundled.mp3'), song('Bundled', 'scanC'));

    const started = installation.scanner.start({});
    assert.strictEqual(started.status, 'discovering');
    assert.strictEqual(started.total, null, 'no total is claimed before there is one');
    assert.strictEqual(started.percent, null, 'and no percentage either');

    const finished = await waitForScan(installation.scanner);

    assert.strictEqual(finished.status, 'complete');
    assert.strictEqual(finished.total, 2, 'two files were worth reading');
    assert.strictEqual(finished.processed, 2);
    assert.strictEqual(finished.tracksFound, 2);
    assert.strictEqual(finished.percent, 100);

    const titles = installation.deviceLibrary
        .getTracks()
        .map((track) => track.title)
        .sort();
    assert.deepStrictEqual(titles, ['One', 'Two'], 'the songs, and only the songs');
});

test('a file too small, too large or unreadable is passed over, and the search finishes', async (t) => {
    const installation = buildInstallation({ scanner: { maxBytes: 900 * 1024 } });
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, 'good.mp3', song('Good', 'okA'));
    writeFile(installation.musicFolder, 'tiny.mp3', Buffer.alloc(4096, 0x33));
    writeFile(installation.musicFolder, 'enormous.mp3', Buffer.alloc(2 * 1024 * 1024, 0x44));
    writeFile(installation.musicFolder, 'broken.mp3', Buffer.alloc(700 * 1024, 0x55));

    installation.scanner.start({});
    const finished = await waitForScan(installation.scanner);

    assert.strictEqual(finished.status, 'complete', 'one bad file does not end the search');
    assert.strictEqual(finished.tracksFound, 1, 'the song was found');
    assert.ok(finished.filesSkipped >= 3, 'and the rest were counted as skipped');
    assert.deepStrictEqual(installation.deviceLibrary.getTracks().map((track) => track.title), ['Good']);
});

test('a folder that cannot be read is skipped rather than ending the search', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, path.join('Albums', 'one.mp3'), song('One', 'unreadA'));

    const fsp = require('fs/promises');
    const original = fsp.readdir;
    const failing = path.join(installation.musicFolder, 'Locked');
    fs.mkdirSync(failing);

    fsp.readdir = async function (directory, options) {
        if (String(directory) === failing) {
            const error = new Error('EACCES: permission denied');
            error.code = 'EACCES';
            throw error;
        }
        return original.call(this, directory, options);
    };

    try {
        installation.scanner.start({});
        const finished = await waitForScan(installation.scanner);

        assert.strictEqual(finished.status, 'complete');
        assert.strictEqual(finished.tracksFound, 1, 'the readable music was still found');
        assert.ok(finished.filesSkipped >= 1, 'and the folder was noted as skipped');
    } finally {
        fsp.readdir = original;
    }
});

test('a loop made of links does not send the search round for ever', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, path.join('Albums', 'one.mp3'), song('One', 'loopA'));

    try {
        fs.symlinkSync(installation.musicFolder, path.join(installation.musicFolder, 'Albums', 'loop'), 'junction');
    } catch (e) {
        // Making links may not be allowed here; the walk is still checked.
    }

    installation.scanner.start({});
    const finished = await waitForScan(installation.scanner, 20000);

    assert.strictEqual(finished.status, 'complete');
    assert.strictEqual(finished.tracksFound, 1, 'the song was counted once');
});

test('the same song in two searched folders is one track', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    const audio = song('Twice', 'sameA');
    writeFile(installation.musicFolder, path.join('Albums', 'twice.mp3'), audio);
    writeFile(installation.musicFolder, path.join('Copies', 'twice-again.mp3'), audio);

    installation.scanner.start({});
    const finished = await waitForScan(installation.scanner);

    assert.strictEqual(finished.processed, 2, 'both files were read');
    assert.strictEqual(finished.tracksFound, 1, 'and they are one song');
    assert.strictEqual(installation.deviceLibrary.getTracks().length, 1);
});

test('asking twice does not start a second search', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    for (let i = 0; i < 6; i += 1) {
        writeFile(installation.musicFolder, 'song-' + i + '.mp3', song('Song ' + i, 'many' + i));
    }

    const first = installation.scanner.start({});
    const second = installation.scanner.start({});
    assert.strictEqual(second.id, first.id, 'the search already going is the answer');

    const finished = await waitForScan(installation.scanner);
    assert.strictEqual(finished.tracksFound, 6);
});

test('a search can be stopped, and keeps what it had already found', async (t) => {
    const installation = buildInstallation({ scanner: { batchSize: 1, concurrency: 1 } });
    t.after(() => installation.cleanup());

    for (let i = 0; i < 12; i += 1) {
        writeFile(installation.musicFolder, 'song-' + i + '.mp3', song('Song ' + i, 'stop' + i));
    }

    installation.scanner.start({});
    await new Promise((resolve) => setTimeout(resolve, 60));
    installation.scanner.cancel();

    const finished = await waitForScan(installation.scanner);
    assert.strictEqual(finished.status, 'cancelled');
    assert.ok(finished.processed <= 12);
});

test('a search writes nothing to Supabase', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, 'quiet.mp3', song('Quiet', 'noUpA'));

    installation.scanner.start({});
    await waitForScan(installation.scanner);

    assert.deepStrictEqual(installation.rest._state.writes, [], 'no row and no stored object');
    assert.deepStrictEqual(installation.rest._state.tracks, []);
    assert.deepStrictEqual(installation.rest._state.albums, []);
});

// ============================================
// The music belongs to the device
// ============================================

test('what a search finds is the same music for a guest and for every account', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, 'shared.mp3', song('Shared', 'deviceA'));

    installation.scanner.start({});
    await waitForScan(installation.scanner);

    const forGuest = await installation.service.getTracks({});
    const forA = await installation.service.getTracks({ userId: USER_A });
    const forB = await installation.service.getTracks({ userId: USER_B });

    const ids = (result) => result.items.map((track) => track.id).sort();
    assert.strictEqual(forGuest.items.length, 1, 'a guest sees the music on this device');
    assert.deepStrictEqual(ids(forA), ids(forGuest), 'and so does one account');
    assert.deepStrictEqual(ids(forB), ids(forGuest), 'and the next');

    // Playable by all of them, with no ticket and no account.
    const hash = installation.deviceLibrary.getTracks()[0].id;
    for (const caller of [{}, { userId: USER_A }, { userId: USER_B }]) {
        const stream = await installation.service.resolveStreamUrl('local:' + hash, caller);
        assert.strictEqual(stream.source, 'device');
        assert.strictEqual(stream.url, '/api/library/tracks/' + hash + '/stream');
    }
});

test('what an account does with that music stays that account own', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, 'shared.mp3', song('Shared', 'privA'));

    installation.scanner.start({});
    await waitForScan(installation.scanner);

    const trackId = 'local:' + installation.deviceLibrary.getTracks()[0].id;

    // One account hides it and keeps its own state; the device's music is not
    // changed by either of those things.
    installation.service.hideForUser(USER_A, trackId);

    const forA = await installation.service.getTracks({ userId: USER_A });
    const forB = await installation.service.getTracks({ userId: USER_B });
    const forGuest = await installation.service.getTracks({});

    assert.ok(!forA.items.some((track) => track.id === trackId), 'hidden for the one who hid it');
    assert.ok(forB.items.some((track) => track.id === trackId), 'still there for another account');
    assert.ok(forGuest.items.some((track) => track.id === trackId), 'and for a guest');
    assert.strictEqual(installation.deviceLibrary.getTracks().length, 1, 'the device library is untouched');
});

test('the index is read back after a restart instead of searching again', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, 'kept.mp3', song('Kept', 'keepA'));

    installation.scanner.start({});
    const finished = await waitForScan(installation.scanner);

    // A second library over the same folder, as after a restart.
    const restarted = new DeviceLibrary({ deviceDir: path.join(installation.dataDir, 'device') });
    assert.deepStrictEqual(restarted.getTracks().map((track) => track.title), ['Kept']);

    const state = restarted.readState();
    assert.strictEqual(state.permission, 'unknown', 'the scanner does not agree on anyone behalf');
    assert.strictEqual(state.lastScanAt, finished.finishedAt, 'and remembers when it last searched');
    assert.strictEqual(state.locations.length, 1);
});

// ============================================
// The API the page uses
// ============================================

test('anyone at this device can start a search and watch it, signed in or not', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    writeFile(installation.musicFolder, 'served.mp3', song('Served', 'apiA'));

    // A guest: no session, no error.
    installation.signOut();

    const before = JSON.parse((await request(started.port, '/api/library/scan')).body);
    assert.strictEqual(before.permission, 'unknown', 'nothing has been agreed to yet');
    assert.strictEqual(before.scan, null);

    const begin = await request(started.port, '/api/library/scan', { method: 'POST' });
    assert.strictEqual(begin.status, 202);
    const startedBody = JSON.parse(begin.body);
    assert.match(startedBody.scan.id, /^scan-/);
    assert.strictEqual(startedBody.permission, 'allowed', 'agreeing is remembered on this device');

    const during = await request(started.port, '/api/library/scan?playing=true');
    assert.strictEqual(during.status, 200);

    await waitForScan(installation.scanner);

    const done = JSON.parse((await request(started.port, '/api/library/scan')).body);
    assert.strictEqual(done.scan.status, 'complete');
    assert.strictEqual(done.scan.tracksFound, 1);
    assert.strictEqual(done.running, false);
    assert.strictEqual(done.trackCount, 1);
    assert.ok(done.lastScanAt, 'and when it happened');

    // A guest can see the music and play it.
    const catalog = JSON.parse((await request(started.port, '/api/catalog/tracks')).body);
    const found = catalog.items.find((track) => track.title === 'Served');
    assert.ok(found, 'a guest sees it in the catalogue');

    const stream = await request(started.port, found.streamUrl);
    assert.strictEqual(stream.status, 200, 'and can play it');
    assert.ok(stream.body.length > 0);

    // Nothing in any of those answers says where anything is.
    for (const text of [begin.body, during.body, JSON.stringify(done), JSON.stringify(found)]) {
        assert.ok(!text.includes(installation.musicFolder), 'no music folder path');
        assert.ok(!text.includes(installation.dataDir), 'no data folder path');
        assert.ok(!/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(text), 'no filesystem path at all');
        assert.ok(!/base64|data:audio/i.test(text), 'and no audio');
    }
    assert.ok(done.locations[0].label, 'a location is a name and a count');
    assert.ok(!done.locations[0].path, 'and never a path');
});

test('a caller cannot ask for a folder of their own, or for a file by path', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    const escape = makeTempDir('spotifie-elsewhere-');
    writeFile(escape, 'secret.mp3', song('Secret', 'escapeA'));

    try {
        // A folder named in the request is not searched: the approved music
        // locations are the only ones there are.
        await request(started.port, '/api/library/scan?root=' + encodeURIComponent(escape), { method: 'POST' });
        await waitForScan(installation.scanner);

        assert.deepStrictEqual(installation.deviceLibrary.getTracks(), [], 'nothing outside the approved folders');
        assert.deepStrictEqual(
            installation.deviceLibrary.listLocations().map((location) => location.path),
            [path.resolve(installation.musicFolder)]
        );

        // And music is asked for by id: a path is not a track.
        for (const attempt of [
            '/api/library/tracks/..%2F..%2Fpackage.json/stream',
            '/api/library/tracks/' + encodeURIComponent(path.join(escape, 'secret.mp3')) + '/stream',
            '/api/library/tracks/' + encodeURIComponent('../../.env') + '/stream'
        ]) {
            const response = await request(started.port, attempt);
            assert.strictEqual(response.status, 404, attempt + ' is refused');
        }
    } finally {
        removeDir(escape);
    }
});

test('the server listens on this machine only unless told otherwise', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1';/);
    assert.ok(!/'0\.0\.0\.0'/.test(server), 'nothing binds every interface by default');
});

// ============================================
// What the page does with it
// ============================================

test('the question is asked again after Not Now, and stops after Scan Device', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('// ==================== Music on this device'),
        PLAYER_SOURCE.indexOf('function libraryFolderForAlbum')
    );
    assert.ok(section.length > 0, 'the section was found');

    // Whose answer this is: the device's, either way.
    //
    // With a server running, the server keeps it, and nothing about it is
    // written in the browser. A published copy has no server to keep it and
    // still has a device to ask about, so the answer is kept where a browser
    // keeps things - once for the machine, never once per account, and never
    // anything that could grant access to anything.
    assert.ok(!/sessionStorage/.test(section), 'nothing about it is kept for one visit only');
    assert.ok(!/accountId|spotifieAuth|isSignedIn/.test(section), 'and it is not asked per account');
    assert.match(section, /const LOCAL_MUSIC_PERMISSION_KEY = 'spotifie_local_music';/);
    assert.match(section, /localStorage\.setItem\(LOCAL_MUSIC_PERMISSION_KEY, 'allowed'\)/);

    // A decision, and only that. Nothing signed, nothing a browser could use
    // to reach anything.
    const kept = section.slice(section.indexOf('const LOCAL_MUSIC_PERMISSION_KEY'), section.indexOf('function ensureLocalMusicCollection'));
    assert.ok(!/token|key:|secret|password/i.test(kept.replace(/LOCAL_MUSIC_PERMISSION_KEY/g, '')), 'nothing but the answer');

    // Not now: closed for this visit, nothing written, nothing searched.
    const later = section.slice(
        section.indexOf("document.getElementById('deviceScanLater')"),
        section.indexOf("document.getElementById('scanDeviceLink')")
    );
    assert.match(later, /deviceScanDismissedThisSession = true;/);
    assert.ok(!/startDeviceScan\(/.test(later), 'Not Now starts nothing');

    // The dismissal is remembered only in this page: a refresh asks again.
    assert.match(section, /let deviceScanDismissedThisSession = false;/);
    assert.match(section, /if \(deviceScanDismissedThisSession\) return;/);

    // Saying yes starts the search; the server records the agreement.
    const allow = section.slice(
        section.indexOf("document.getElementById('deviceScanStart')"),
        section.indexOf("document.getElementById('deviceScanLater')")
    );
    assert.match(allow, /await startDeviceScan\(\);/);
    assert.match(ROUTES_SOURCE, /deviceLibrary\.allowScanning\(\);/);

    // Opening the page again watches a search that is already going rather
    // than starting a second one, and otherwise looks for what is new.
    const startup = section.slice(
        section.indexOf('async function initDeviceMusicScan()'),
        section.indexOf('function initDeviceScanControls()')
    );
    assert.match(startup, /if \(deviceScanReport\.running\)[\s\S]{0,200}watchDeviceScan\(\);/);
    assert.match(
        startup,
        /if \(deviceScanReport\.permission === 'allowed'\) \{\s*await startDeviceScan\(\{ silent: true \}\);/,
        'an allowed device looks again by itself, and does it quietly'
    );
    // And the question is never asked again once it has been answered yes -
    // by the server that was asked, or by the device on a copy that has none.
    assert.ok(
        startup.lastIndexOf("prompt.classList.remove('hidden')") > startup.indexOf("permission === 'allowed'"),
        'the prompt is only for a device that has not agreed'
    );
    assert.match(
        startup,
        /if \(published && localMusicPermission\(\) !== 'allowed'\) \{[\s\S]{0,200}prompt\.classList\.remove\('hidden'\);/,
        'a published copy asks the device, and asks before it looks for anything'
    );
});

test('progress is honest, and the page never reads a file itself', () => {
    // Nothing is claimed before it is known: no percentage during discovery,
    // and a looking-again pass says what it is doing.
    assert.match(PLAYER_SOURCE, /if \(scan\.status === 'discovering'\)[\s\S]{0,300}'Checking for new music…'/);
    assert.match(PLAYER_SOURCE, /bar\.classList\.add\('indeterminate'\)/);

    // The counts on screen are the counts the search kept.
    assert.match(PLAYER_SOURCE, /countOf\(scan\.filesChecked\)[\s\S]{0,200}' files checked/);
    assert.match(PLAYER_SOURCE, /countOf\(scan\.newTracks\)[\s\S]{0,120}' new '/);
    assert.match(PLAYER_SOURCE, /title\.textContent = 'Local Music updated'/);
    assert.match(PLAYER_SOURCE, /title\.textContent = 'Local Music is up to date'/);
    assert.ok(!/tracksFound \+ ' songs added'/.test(PLAYER_SOURCE), 'skipped files are never called songs added');

    // Closing the notice hides it and nothing else.
    const dismiss = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf("document.getElementById('deviceScanDismiss')"),
        PLAYER_SOURCE.indexOf('/** Say when this device was last searched. */')
    );
    assert.ok(!/cancelDeviceScan|stopWatchingDeviceScan/.test(dismiss), 'closing the notice does not stop the search');

    // The search gives way to playback, and the library is redrawn in batches.
    assert.match(PLAYER_SOURCE, /client\.getDeviceScanStatus\(\{ playing: isAudioPlaying\(\) \}\)/);
    assert.match(PLAYER_SOURCE, /Date\.now\(\) - deviceScanRefreshAt > 4000/);

    // Local Music comes from the catalogue and leads the library; the page
    // invents no collection of its own.
    assert.match(PLAYER_SOURCE, /const LOCAL_MUSIC_ALBUM_ID = 'system:local-music';/);
    assert.match(PLAYER_SOURCE, /isSystemCollection: Boolean\(album\.system\)/);
    assert.match(PLAYER_SOURCE, /if \(info\.isSystemCollection\) return 0;/);
    assert.ok(!/function buildLocalMusicCollection/.test(PLAYER_SOURCE), 'the page builds no collection of its own');

    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('// ==================== Music on this device'),
        PLAYER_SOURCE.indexOf('function libraryFolderForAlbum')
    );
    assert.ok(!/FileReader|readAsDataURL|createObjectURL|btoa\(|base64/i.test(section), 'no file reading in the page');
    assert.ok(!/catalog_tracks|catalog_albums|catalog-audio|catalog-artwork/i.test(section));
});

test('the scanner is the only part that knows how a device is searched', () => {
    const code = SCANNER_SOURCE.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');

    assert.ok(!/catalog_tracks|catalog_albums|catalog-audio|catalog-artwork/i.test(SCANNER_SOURCE));
    assert.ok(!/supabaseRest|globalCatalog|uploadObject/.test(SCANNER_SOURCE));
    assert.ok(!/userId|account/i.test(code), 'and it knows nothing about accounts');

    assert.match(SCANNER_SOURCE, /library\.indexFile\(relative, \{\s*requireAudio: true,\s*force: job\.mode === 'full'\s*\}\)/);
    assert.ok(!/createHash|sha256/i.test(SCANNER_SOURCE), 'identity is left to the library');

    assert.match(SCANNER_SOURCE, /if \(entry\.isSymbolicLink\(\)\) continue;/);
    assert.match(SCANNER_SOURCE, /await fsp\.realpath\(directory\)/);
    assert.ok(!/readdirSync|statSync\(absolute\)/.test(SCANNER_SOURCE), 'no blocking walk');
    assert.match(SCANNER_SOURCE, /await new Promise\(\(resolve\) => setImmediate\(resolve\)\);/);
    assert.match(SCANNER_SOURCE, /job\.busy \? this\.limits\.busyConcurrency : this\.limits\.concurrency/);

    assert.match(SCANNER_SOURCE, /MIN_AUDIO_FILE_BYTES,\s*MAX_AUDIO_FILE_BYTES,/);
    const config = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config.js'), 'utf8');
    assert.match(config, /MIN_AUDIO_FILE_BYTES = Number\(process\.env\.SPOTIFIE_MIN_AUDIO_BYTES\) \|\| 512 \* 1024/);
    assert.match(config, /MAX_AUDIO_FILE_BYTES = Number\(process\.env\.SPOTIFIE_MAX_AUDIO_BYTES\) \|\| 500 \* 1024 \* 1024/);

    // The device's music is kept apart from anything an account owns.
    const deviceSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deviceLibrary.js'), 'utf8');
    const deviceCode = deviceSource.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/userId|supabase/i.test(deviceCode), 'the device library has no account in it');
    assert.match(deviceSource, /path\.join\(DATA_DIR, 'device'\)/);
});


// ============================================
// Looking again, cheaply
// ============================================

test('looking again reads only what changed', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    for (let i = 0; i < 5; i += 1) {
        writeFile(installation.musicFolder, 'song-' + i + '.mp3', song('Song ' + i, 'inc' + i));
    }

    installation.scanner.start({});
    const first = await waitForScan(installation.scanner);
    assert.strictEqual(first.mode, 'full', 'the first search of a device reads everything');
    assert.strictEqual(first.newTracks, 5);
    assert.strictEqual(first.existingUnchanged, 0);
    assert.strictEqual(first.totalLocalTracks, 5);

    // Count what the second pass actually reads from disk.
    const library = installation.deviceLibrary.libraryFor(installation.musicFolder);
    let hashed = 0;
    let parsed = 0;
    const hashFile = library.adapter.hashFile.bind(library.adapter);
    const readTags = library.adapter.readTags.bind(library.adapter);
    library.adapter.hashFile = (relative) => {
        hashed += 1;
        return hashFile(relative);
    };
    library.adapter.readTags = (relative) => {
        parsed += 1;
        return readTags(relative);
    };

    writeFile(installation.musicFolder, 'song-new.mp3', song('Brand New', 'incNew'));

    installation.scanner.start({});
    const second = await waitForScan(installation.scanner);

    assert.strictEqual(second.mode, 'incremental', 'and every pass after that looks for changes');
    assert.strictEqual(second.filesChecked, 6, 'every candidate was accounted for');
    assert.strictEqual(second.existingUnchanged, 5, 'five were recognised without being read');
    assert.strictEqual(second.newTracks, 1, 'and one was new');
    assert.strictEqual(second.totalLocalTracks, 6);

    assert.strictEqual(hashed, 1, 'only the new file was hashed');
    assert.strictEqual(parsed, 1, 'and only the new file had its tags read');

    // The new song is in the library without anyone asking again.
    assert.ok(installation.deviceLibrary.getTracks().some((track) => track.title === 'Brand New'));
});

test('a song that moved keeps its id, and one that is gone is only counted', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    writeFile(installation.musicFolder, 'first.mp3', song('First', 'moveA'));
    writeFile(installation.musicFolder, 'second.mp3', song('Second', 'moveB'));

    installation.scanner.start({});
    await waitForScan(installation.scanner);

    const before = installation.deviceLibrary.getTracks().find((track) => track.title === 'First');

    // One renamed, one taken away.
    fs.renameSync(path.join(installation.musicFolder, 'first.mp3'), path.join(installation.musicFolder, 'renamed.mp3'));
    fs.unlinkSync(path.join(installation.musicFolder, 'second.mp3'));

    installation.scanner.start({});
    const again = await waitForScan(installation.scanner);

    const after = installation.deviceLibrary.getTracks().find((track) => track.title === 'First');
    assert.strictEqual(after.id, before.id, 'the same song under a new name is the same song');
    assert.strictEqual(again.newTracks, 0, 'and is not counted as new');
    assert.strictEqual(again.missingTracks, 1, 'the song whose file went is counted');

    // Counted, not deleted: an album that refers to it still can.
    assert.ok(
        installation.deviceLibrary.getTracks().some((track) => track.title === 'Second'),
        'the record of the missing song is kept'
    );
});

test('a refresh during a search joins that search instead of starting another', async (t) => {
    const installation = buildInstallation({ scanner: { batchSize: 1, concurrency: 1 } });
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    for (let i = 0; i < 10; i += 1) {
        writeFile(installation.musicFolder, 'song-' + i + '.mp3', song('Song ' + i, 'tabs' + i));
    }

    // Three tabs, all asking at once.
    const answers = await Promise.all([
        request(started.port, '/api/library/scan', { method: 'POST' }),
        request(started.port, '/api/library/scan', { method: 'POST' }),
        request(started.port, '/api/library/scan', { method: 'POST' })
    ]);

    const ids = answers.map((answer) => JSON.parse(answer.body).scan.id);
    assert.strictEqual(new Set(ids).size, 1, 'one search, watched by all of them');

    // A page that opens mid-search sees the search that is running, with its
    // own progress rather than a fresh zero.
    const midway = JSON.parse((await request(started.port, '/api/library/scan')).body);
    assert.strictEqual(midway.scan.id, ids[0]);
    assert.strictEqual(midway.running, true);

    const finished = await waitForScan(installation.scanner, 30000);
    assert.strictEqual(finished.id, ids[0]);
    assert.strictEqual(finished.newTracks, 10);
});

test('what the last search found is remembered for the next page', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    writeFile(installation.musicFolder, 'remembered.mp3', song('Remembered', 'summaryA'));

    await request(started.port, '/api/library/scan', { method: 'POST' });
    await waitForScan(installation.scanner);

    const report = JSON.parse((await request(started.port, '/api/library/scan')).body);
    assert.strictEqual(report.permission, 'allowed');
    assert.ok(report.lastSuccessfulScanAt, 'when it last finished');
    assert.strictEqual(report.lastScanSummary.newTracks, 1);
    assert.strictEqual(report.lastScanSummary.filesChecked, 1);
    assert.strictEqual(report.lastScanSummary.totalLocalTracks, 1);

    // A page opening now knows what is there without searching again.
    const restarted = new DeviceLibrary({ deviceDir: path.join(installation.dataDir, 'device') });
    assert.strictEqual(restarted.readState().lastScanSummary.newTracks, 1);
    assert.strictEqual(restarted.getTracks().length, 1);
});

test('a search asked for by hand may read everything again', async (t) => {
    const installation = buildInstallation();
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        installation.cleanup();
    });

    writeFile(installation.musicFolder, 'deep.mp3', song('Deep', 'fullA'));

    await request(started.port, '/api/library/scan', { method: 'POST' });
    await waitForScan(installation.scanner);

    await request(started.port, '/api/library/scan?mode=full', { method: 'POST' });
    const full = await waitForScan(installation.scanner);

    assert.strictEqual(full.mode, 'full', 'the caller asked for a deeper pass');
    assert.strictEqual(full.existingUnchanged, 0, 'so nothing was taken on trust');
    assert.strictEqual(full.totalLocalTracks, 1, 'and the library is what it was');
});


// ============================================
// A real profile on a real computer
// ============================================

/** A home folder shaped like one, with music where people actually keep it. */
function buildHome() {
    const home = makeTempDir('spotifie-profile-');
    fs.mkdirSync(path.join(home, 'Music'));
    fs.mkdirSync(path.join(home, 'Downloads'));
    fs.mkdirSync(path.join(home, 'Documents'));
    fs.mkdirSync(path.join(home, 'AppData'));
    return home;
}

test('the folders people keep music in are the ones searched', (t) => {
    const home = buildHome();
    const musicRoot = makeTempDir('spotifie-root-');
    t.after(() => {
        removeDir(home);
        removeDir(musicRoot);
    });

    const described = describeMusicLocations({ homeDir: home, musicRoot: musicRoot, mediaRoot: null, extraRoots: [] });
    const searched = described.filter((entry) => entry.available).map((entry) => entry.path);

    for (const folder of ['Music', 'Downloads', 'Documents']) {
        assert.ok(searched.includes(path.join(home, folder)), folder + ' is searched');
    }
    assert.ok(searched.includes(path.resolve(musicRoot)), 'and the configured music root');

    // A folder that is not there is reported as not there, not pretended over.
    const desktop = described.find((entry) => entry.path === path.join(home, 'Desktop'));
    assert.ok(desktop, 'the folder was considered');
    assert.strictEqual(desktop.available, false);
    assert.strictEqual(desktop.reason, 'missing');
    assert.ok(!searched.includes(path.join(home, 'AppData')), 'application data is left alone');

    // Every one of them is a real folder, whatever else was asked for.
    for (const entry of described.filter((one) => one.available)) {
        assert.ok(fs.statSync(entry.path).isDirectory(), entry.path + ' exists');
    }
});

test('music inside a folder inside Downloads is found', async (t) => {
    const home = buildHome();
    const installation = buildInstallation({
        scanner: { locations: { homeDir: home, musicRoot: null, mediaRoot: null, extraRoots: [] } }
    });
    t.after(() => {
        removeDir(home);
        installation.cleanup();
    });

    // The case from a real machine: a browser put an album in Downloads.
    const names = [
        'last-call-in-c-minor.mp3',
        'polar-afterglow.mp3',
        'first-light-on-the-ridge.mp3',
        'stained-glass-static.mp3',
        'warm-mile-markers.mp3',
        'sea-glass-evening.mp3',
        'high-rise-haze.mp3',
        'midnight-amber-room.mp3',
        'brushstrokes-and-rain.mp3',
        'electric-puddles.mp3'
    ];

    const audio = path.join(home, 'Downloads', 'audio');
    fs.mkdirSync(audio, { recursive: true });
    names.forEach((name, index) => {
        // About the size these files really are: well over the minimum.
        fs.writeFileSync(path.join(audio, name), song('Track ' + index, 'win' + index, 1600 * 1024));
    });

    installation.scanner.start({});
    const finished = await waitForScan(installation.scanner, 60000);

    assert.strictEqual(finished.status, 'complete');
    assert.strictEqual(finished.audioCandidates, names.length, 'every file was a candidate');
    assert.strictEqual(finished.filesChecked, names.length, 'and every one was checked');
    assert.strictEqual(finished.newTracks, names.length, 'all of them are new songs');
    assert.strictEqual(finished.totalLocalTracks, names.length);
    assert.ok(finished.directoriesVisited >= 2, 'the folder inside Downloads was walked');
    assert.strictEqual(installation.deviceLibrary.getTracks().length, names.length);

    // Looking again recognises them all without reading one of them.
    installation.scanner.start({});
    const again = await waitForScan(installation.scanner, 60000);

    assert.strictEqual(again.filesChecked, names.length, 'the files are still checked');
    assert.strictEqual(again.unchangedTracks, names.length, 'and recognised');
    assert.strictEqual(again.newTracks, 0, 'with nothing new');
    assert.notStrictEqual(again.filesChecked, 0, 'nothing new never means nothing checked');

    // One more song appears; only that one is read.
    fs.writeFileSync(path.join(audio, 'new-song.mp3'), song('New Song', 'winNew', 1600 * 1024));

    installation.scanner.start({});
    const third = await waitForScan(installation.scanner, 60000);

    assert.strictEqual(third.newTracks, 1, 'one new song');
    assert.strictEqual(third.unchangedTracks, names.length, 'the rest were recognised');
    assert.strictEqual(third.totalLocalTracks, names.length + 1);
    assert.ok(
        installation.deviceLibrary.getTracks().some((track) => track.title === 'New Song'),
        'and it is in Local Music'
    );

    // None of it went anywhere near Supabase.
    assert.deepStrictEqual(installation.rest._state.writes, []);
});

test('a file is judged by its name and its size, whatever the case', async (t) => {
    const home = buildHome();
    const installation = buildInstallation({
        scanner: { locations: { homeDir: home, musicRoot: null, mediaRoot: null, extraRoots: [] } }
    });
    t.after(() => {
        removeDir(home);
        installation.cleanup();
    });

    const downloads = path.join(home, 'Downloads');
    // Shouted, spelled oddly - still an mp3.
    fs.writeFileSync(path.join(downloads, 'LAST-CALL.MP3'), song('Loud Name', 'caseA', 1600 * 1024));
    fs.writeFileSync(path.join(downloads, 'Mixed.Mp3'), song('Mixed Name', 'caseB', 1600 * 1024));
    // The sizes on either side of the limits.
    fs.writeFileSync(path.join(downloads, 'too-small.mp3'), Buffer.alloc(400 * 1024, 0x11));
    fs.writeFileSync(path.join(downloads, 'notes.txt'), Buffer.alloc(1600 * 1024, 0x22));

    installation.scanner.start({});
    const finished = await waitForScan(installation.scanner, 30000);

    const titles = installation.deviceLibrary.getTracks().map((track) => track.title).sort();
    assert.deepStrictEqual(titles, ['Loud Name', 'Mixed Name'], 'both are music whatever the case');
    assert.strictEqual(finished.skippedSmall, 1, 'the small one was counted as small');
    assert.strictEqual(finished.skippedUnsupported, 1, 'and the text file as not music');
    assert.strictEqual(finished.filesSeen, 4, 'all four files were seen');
});

test('the size limits are read as bytes, at the edges', () => {
    const limits = { minBytes: 512 * 1024, maxBytes: 500 * 1024 * 1024 };

    assert.strictEqual(rejectCandidate('a.mp3', 400 * 1024, limits), 'too-small', '400 KB is not a song');
    assert.strictEqual(rejectCandidate('a.mp3', 512 * 1024 - 1, limits), 'too-small', 'a byte under the limit');
    assert.strictEqual(rejectCandidate('a.mp3', 512 * 1024, limits), null, 'the limit itself is a song');
    assert.strictEqual(rejectCandidate('a.mp3', 1.6 * 1024 * 1024, limits), null, '1.6 MB certainly is');
    assert.strictEqual(rejectCandidate('a.mp3', 500 * 1024 * 1024, limits), null, 'and so is the top of the range');
    assert.strictEqual(rejectCandidate('a.mp3', 500 * 1024 * 1024 + 1, limits), 'too-large', 'a byte over it is not');

    // The defaults are the numbers they are meant to be.
    const config = require('../lib/config');
    assert.strictEqual(config.MIN_AUDIO_FILE_BYTES, 524288);
    assert.strictEqual(config.MAX_AUDIO_FILE_BYTES, 524288000);
    assert.strictEqual(rejectCandidate('song.mp3', 1.75 * 1024 * 1024, config === null ? limits : {
        minBytes: config.MIN_AUDIO_FILE_BYTES,
        maxBytes: config.MAX_AUDIO_FILE_BYTES
    }), null, 'a 1.75 MB song passes the defaults');
});

test('the same folder written two ways is one folder', () => {
    const home = buildHome();
    try {
        const downloads = path.join(home, 'Downloads');

        assert.strictEqual(normalizeRoot(downloads + path.sep), normalizeRoot(downloads), 'a trailing slash says nothing');
        assert.strictEqual(normalizeRoot(downloads.replace(/\\/g, '/')), normalizeRoot(downloads), 'either slash');
        if (/^[A-Za-z]:/.test(downloads)) {
            const lowered = downloads[0].toLowerCase() + downloads.slice(1);
            assert.strictEqual(normalizeRoot(lowered), normalizeRoot(downloads), 'either case of drive letter');
        }

        const described = describeMusicLocations({
            homeDir: home,
            musicRoot: downloads + path.sep,
            mediaRoot: null,
            extraRoots: [downloads, path.join(downloads, 'audio')]
        });

        const searched = described.filter((entry) => entry.available).map((entry) => entry.path);
        assert.strictEqual(searched.filter((entry) => entry === normalizeRoot(downloads)).length, 1, 'searched once');
        assert.ok(
            !searched.includes(path.join(downloads, 'audio')),
            'and a folder inside it is not searched a second time'
        );
    } finally {
        removeDir(home);
    }
});

test('a folder that cannot be read is counted and the rest is still searched', async (t) => {
    const home = buildHome();
    const installation = buildInstallation({
        scanner: { locations: { homeDir: home, musicRoot: null, mediaRoot: null, extraRoots: [] } }
    });
    t.after(() => {
        removeDir(home);
        installation.cleanup();
    });

    fs.writeFileSync(path.join(home, 'Downloads', 'reachable.mp3'), song('Reachable', 'denyA', 1600 * 1024));
    const locked = path.join(home, 'Documents', 'locked');
    fs.mkdirSync(locked);

    const fsp = require('fs/promises');
    const original = fsp.readdir;
    fsp.readdir = async function (directory, options) {
        if (String(directory) === locked) {
            const error = new Error('EPERM: operation not permitted');
            error.code = 'EPERM';
            throw error;
        }
        return original.call(this, directory, options);
    };

    try {
        installation.scanner.start({});
        const finished = await waitForScan(installation.scanner, 30000);

        assert.strictEqual(finished.status, 'complete');
        assert.strictEqual(finished.permissionErrors, 1, 'the folder that refused is counted');
        assert.strictEqual(finished.newTracks, 1, 'and the music elsewhere was still found');
    } finally {
        fsp.readdir = original;
    }
});

test('the browser is told counts, and the server log is where folders are named', async (t) => {
    const home = buildHome();
    const installation = buildInstallation({
        scanner: { locations: { homeDir: home, musicRoot: null, mediaRoot: null, extraRoots: [] } }
    });
    const started = await startServer(installation);
    t.after(() => {
        started.server.close();
        removeDir(home);
        installation.cleanup();
    });

    fs.writeFileSync(path.join(home, 'Downloads', 'counted.mp3'), song('Counted', 'countA', 1600 * 1024));

    await request(started.port, '/api/library/scan', { method: 'POST' });
    await waitForScan(installation.scanner, 30000);

    const body = (await request(started.port, '/api/library/scan')).body;
    const report = JSON.parse(body);

    assert.strictEqual(report.scan.filesChecked, 1);
    assert.strictEqual(report.scan.newTracks, 1);
    assert.ok(report.scan.directoriesVisited >= 1);

    assert.ok(!body.includes(home), 'the home folder is not named to the browser');
    assert.ok(!/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(body), 'no path of any kind');
});


// ============================================
// One collection for the music on this machine
// ============================================

test('scanned music makes one collection, not a card for every stray tag', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    // A folder of downloads: some tagged, some not, some tagged badly.
    writeFile(
        installation.musicFolder,
        path.join('audio', 'tagged.mp3'),
        Buffer.concat([
            buildMp3({ title: 'Tagged', artist: 'Someone', album: 'Their Album', filler: 'group1' }),
            Buffer.alloc(600 * 1024, 0)
        ])
    );
    for (let i = 0; i < 3; i += 1) {
        writeFile(
            installation.musicFolder,
            path.join('audio', 'untagged-' + i + '.mp3'),
            Buffer.concat([buildMp3({ filler: 'group2' + i }), Buffer.alloc(600 * 1024, 0)])
        );
    }

    installation.scanner.start({});
    await waitForScan(installation.scanner, 30000);

    const albums = await installation.service.getAlbums({});
    const localMusic = albums.items.filter((album) => album.id === 'system:local-music');

    assert.strictEqual(localMusic.length, 1, 'one collection');
    assert.strictEqual(localMusic[0].title, 'Local Music');
    assert.strictEqual(localMusic[0].artist, 'On this device', 'and never Unknown Artist');
    assert.strictEqual(localMusic[0].trackCount, 4, 'holding every song found');
    assert.strictEqual(localMusic[0].system, true);

    // Nothing was made out of the tags - not from the album one file names,
    // and not from the ones the others do not.
    assert.ok(!albums.items.some((album) => album.title === 'Unknown Album'), 'no Unknown Album card');
    assert.ok(!albums.items.some((album) => album.title === 'Their Album'), 'and no card from a tag');
    assert.strictEqual(albums.items.length, 1, 'the collection is the only local album');

    // The tags are still on the songs, for search and for later.
    const tracks = await installation.service.getTracks({});
    const tagged = tracks.items.find((track) => track.title === 'Tagged');
    assert.strictEqual(tagged.album, 'Their Album', 'the album tag is kept');
    assert.strictEqual(tagged.artist, 'Someone', 'and the artist');
    assert.strictEqual(tagged.albumId, 'system:local-music', 'while the collection is where it is shown');

    const untagged = tracks.items.filter((track) => track.album === 'Unknown Album');
    assert.strictEqual(untagged.length, 3, 'a song with no album still says so on itself');
    assert.ok(untagged.every((track) => track.albumId === 'system:local-music'), 'and is still in the collection');
});

test('the collection grows with the music, and stays one collection', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    for (let i = 0; i < 10; i += 1) {
        writeFile(installation.musicFolder, 'song-' + i + '.mp3', song('Song ' + i, 'count' + i));
    }

    installation.scanner.start({});
    await waitForScan(installation.scanner, 30000);

    let albums = await installation.service.getAlbums({});
    let collection = albums.items.find((album) => album.id === 'system:local-music');
    assert.strictEqual(collection.trackCount, 10);

    let tracks = await installation.service.getTracks({ albumId: 'system:local-music' });
    assert.strictEqual(tracks.items.length, 10, 'ten songs, listed once each');
    assert.strictEqual(new Set(tracks.items.map((track) => track.id)).size, 10, 'no duplicates');

    // Two more songs turn up.
    writeFile(installation.musicFolder, 'song-a.mp3', song('Song A', 'countA'));
    writeFile(installation.musicFolder, 'song-b.mp3', song('Song B', 'countB'));

    installation.scanner.start({});
    await waitForScan(installation.scanner, 30000);

    albums = await installation.service.getAlbums({});
    assert.strictEqual(albums.items.filter((album) => album.id === 'system:local-music').length, 1, 'still one');
    collection = albums.items.find((album) => album.id === 'system:local-music');
    assert.strictEqual(collection.trackCount, 12);

    tracks = await installation.service.getTracks({ albumId: 'system:local-music' });
    assert.strictEqual(tracks.items.length, 12);
    assert.ok(!albums.items.some((album) => album.title === 'Unknown Album'), 'and no card appeared beside it');

    // The songs themselves were never copied anywhere.
    assert.deepStrictEqual(installation.rest._state.writes, [], 'and Supabase was not written to');
});

test('a published album is still its own card, after the local music', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    // Something published, alongside music found on this machine.
    installation.rest._state.albums.push({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Afterglow',
        artist: 'Nova Rae',
        album_artist: 'Nova Rae',
        artwork_path: null
    });
    installation.rest._state.tracks.push({
        id: '33333333-3333-4333-8333-333333333333',
        album_id: '11111111-1111-4111-8111-111111111111',
        title: 'Afterglow',
        artist: 'Nova Rae',
        album_artist: 'Nova Rae',
        duration: 210,
        mime_type: 'audio/mpeg',
        audio_path: 'audio/afterglow.mp3',
        artwork_path: null
    });

    writeFile(installation.musicFolder, 'mine.mp3', song('Mine', 'mixA'));

    installation.scanner.start({});
    await waitForScan(installation.scanner, 30000);

    const albums = await installation.service.getAlbums({});
    const ids = albums.items.map((album) => album.id);

    assert.ok(ids.includes('system:local-music'), 'the music on this machine');
    assert.ok(ids.includes('global-album:11111111-1111-4111-8111-111111111111'), 'and what was published');
    assert.strictEqual(ids.indexOf('system:local-music'), 0, 'with the local music first');

    // The published album keeps its own songs; nothing was merged into it.
    const published = await installation.service.getTracks({
        albumId: 'global-album:11111111-1111-4111-8111-111111111111'
    });
    assert.deepStrictEqual(published.items.map((track) => track.title), ['Afterglow']);

    const local = await installation.service.getTracks({ albumId: 'system:local-music' });
    assert.deepStrictEqual(local.items.map((track) => track.title), ['Mine']);
});

test('the library shows the local music first, whatever else is there', () => {
    // The order is decided by what an album is, not by what it is called.
    const priority = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function albumPriority(folder)'),
        PLAYER_SOURCE.indexOf('function libraryFolderForAlbum')
    );
    assert.ok(priority.length > 0, 'the rule was found');
    assert.match(priority, /if \(info\.isSystemCollection\) return 0;/);
    assert.match(priority, /if \(info\.isUserAlbum \|\| info\.isLikedAlbum\) return 1;/);
    assert.match(priority, /if \(info\.source === 'global'\) return 2;/);
    assert.ok(!/title === 'Local Music'/.test(priority), 'not by its title');

    // And the sort puts that first, before pinning or anything else.
    assert.match(
        PLAYER_SOURCE,
        /const aPriority = albumPriority\(a\);\s*const bPriority = albumPriority\(b\);\s*if \(aPriority !== bPriority\) return aPriority - bPriority;/
    );

    // It is a collection, not an album someone made: there is nothing to edit.
    assert.match(PLAYER_SOURCE, /if \(info\.isSystemCollection\) \{[\s\S]{0,160}return;/);
});


// ============================================
// Choosing songs to put in an album
// ============================================

/**
 * The part of the page that fills "Add Songs to Album", run over a catalogue
 * of the tests' own making. The list it produces is what someone choosing
 * songs actually sees.
 */
function loadSongChooser(catalog) {
    const vm = require('vm');
    const start = PLAYER_SOURCE.indexOf('/**\n * The songs one album holds, as this person sees it.');
    const end = PLAYER_SOURCE.indexOf('function toggleSongSelection(item, song)');
    assert.ok(start !== -1 && end > start, 'the chooser was found');

    const rows = [];
    const sandbox = {
        console: console,
        window: { libraryTracks: catalog.tracks },
        predefinedSongs: catalog.predefinedSongs,
        albumInfo: catalog.albumInfo,
        albumTrackAdditions: catalog.albumTrackAdditions || {},
        LIKED_SONGS_FOLDER: '__liked_songs__',
        LIBRARY_ALBUM_PREFIX: 'library/',
        escapeHTML: (value) => String(value),
        libraryFolderForAlbum: (albumId) => 'library/' + albumId,
        getLibraryTrack: (trackId) => catalog.tracks[trackId] || null,
        albumPriority: (folder) => (catalog.albumInfo[folder] && catalog.albumInfo[folder].isSystemCollection ? 0 : 1),
        LibraryDB: {
            async getUserSongsForAlbum(folder) {
                return (catalog.memberships && catalog.memberships[folder]) || [];
            }
        },
        // The list is built into a document of the simplest possible kind: the
        // rows it appends are what the test reads.
        document: {
            getElementById: () => ({
                set innerHTML(value) {
                    if (!value) rows.length = 0;
                },
                appendChild() {}
            }),
            createElement: () => {
                const element = {
                    dataset: {},
                    classList: { add() {}, remove() {} },
                    addEventListener() {},
                    set innerHTML(value) {
                        element.html = value;
                    },
                    get innerHTML() {
                        return element.html;
                    }
                };
                rows.push(element);
                return element;
            },
            createDocumentFragment: () => ({ appendChild(child) {} })
        }
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(
        PLAYER_SOURCE.slice(start, end) +
            `
            function trackDisplayTitle(trackId) {
                const track = getLibraryTrack(trackId);
                if (track && track.title && track.title !== 'Unknown Album') return track.title;
                const fileName = track && track.metadata ? track.metadata.fileName : null;
                if (fileName) return fileName.replace(/\\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
                return String(trackId);
            }
            function trackDisplayArtist(trackId) {
                const track = getLibraryTrack(trackId);
                if (!track) return '';
                return track.artist || 'Unknown Artist';
            }`,
        sandbox
    );

    return {
        sandbox: sandbox,
        rows: rows,
        async list(targetAlbum, filter) {
            rows.length = 0;
            await sandbox.populateAddSongsList(targetAlbum, filter);
            return rows.map((row) => row.html);
        },
        async candidates(targetAlbum, filter) {
            return sandbox.libraryCandidates(targetAlbum, filter);
        }
    };
}

/** A catalogue holding scanned local music, a published album and a mix album. */
function chooserCatalogue() {
    const tracks = {};
    const local = [];

    for (let i = 0; i < 10; i += 1) {
        const id = 'local:' + String(i).repeat(8);
        tracks[id] = {
            id: id,
            source: 'local',
            title: i === 9 ? 'Unknown Album' : 'Song ' + i,
            artist: i === 8 ? null : 'Home Recording',
            album: 'Unknown Album',
            albumId: 'system:local-music',
            metadata: { fileName: 'polar-afterglow-' + i + '.mp3' }
        };
        local.push(id);
    }

    const globalId = 'global:c5f25b3b-1111-4111-8111-111111111111';
    tracks[globalId] = {
        id: globalId,
        source: 'global',
        title: 'DA ZRA GHAMUNA',
        artist: 'Adil ur Rehman',
        album: 'Afterglow',
        albumId: 'global-album:c5f25b3b-1111-4111-8111-111111111111'
    };

    return {
        tracks: tracks,
        localIds: local,
        globalId: globalId,
        predefinedSongs: {
            'library/system:local-music': local.slice(),
            'library/global-album:c5f25b3b-1111-4111-8111-111111111111': [globalId],
            'user_albums/my-mix': []
        },
        albumInfo: {
            'library/system:local-music': { title: 'Local Music', isSystemCollection: true, source: 'local' },
            'library/global-album:c5f25b3b-1111-4111-8111-111111111111': { title: 'Afterglow', source: 'global' },
            'user_albums/my-mix': { title: 'My Mix', isUserAlbum: true }
        },
        memberships: {},
        albumTrackAdditions: {}
    };
}

test('every song on this device can be chosen for an album', async () => {
    const catalogue = chooserCatalogue();
    const chooser = loadSongChooser(catalogue);

    const candidates = await chooser.candidates('user_albums/my-mix', 'all');
    const ids = candidates.map((track) => track.id);

    for (const id of catalogue.localIds) {
        assert.ok(ids.includes(id), id + ' is there to choose');
    }
    assert.ok(ids.includes(catalogue.globalId), 'and so is the published song');
    assert.strictEqual(ids.length, new Set(ids).size, 'each song once');

    // Asking for Local Music shows what is on this device, and only that.
    const localOnly = await chooser.candidates('user_albums/my-mix', 'library/system:local-music');
    assert.deepStrictEqual(Array.from(localOnly.map((track) => track.id)).sort(), catalogue.localIds.slice().sort());
});

test('a song already in the album is shown as already there, not offered twice', async () => {
    const catalogue = chooserCatalogue();
    const chosen = catalogue.localIds[0];
    catalogue.memberships['user_albums/my-mix'] = [{ track: chosen }];

    const chooser = loadSongChooser(catalogue);
    const rows = await chooser.list('user_albums/my-mix', 'all');

    const shown = rows.filter((html) => html.includes('Song 0'));
    assert.strictEqual(shown.length, 1, 'listed once');
    assert.ok(shown[0].includes('Added'), 'and marked as already in the album');
});

test('a song is shown by its name, never by its id', async () => {
    const catalogue = chooserCatalogue();
    const chooser = loadSongChooser(catalogue);
    const rows = await chooser.list('user_albums/my-mix', 'all');
    const joined = rows.join('\n');

    // The published song reads as a song, not as a uuid.
    assert.ok(joined.includes('DA ZRA GHAMUNA'), 'the title is used');
    assert.ok(joined.includes('Adil ur Rehman'), 'with the artist beside it');
    assert.ok(!joined.includes('c5f25b3b'), 'and the id is nowhere on screen');
    assert.ok(!joined.includes('local:00000000'), 'nor a local one');

    // A song with nothing but a file name is named after the file.
    assert.ok(joined.includes('polar afterglow 9'), 'the file name, tidied up');
    assert.ok(joined.includes('Unknown Artist'), 'and a song with no artist says so');

    // Where each one comes from is on the row.
    assert.ok(joined.includes('LOCAL'), 'the music on this device is marked LOCAL');
    assert.ok(joined.includes('GLOBAL'), 'and what was published, GLOBAL');
    assert.ok(!joined.includes('>User<'), 'nothing is called User');
    assert.ok(!/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(joined), 'and no path is ever shown');
});

test('a song found by a later scan can be chosen without reopening anything else', async () => {
    const catalogue = chooserCatalogue();
    const chooser = loadSongChooser(catalogue);

    let candidates = await chooser.candidates('user_albums/my-mix', 'all');
    assert.strictEqual(candidates.length, 11);

    // The catalogue is read again after a scan; the chooser follows it.
    const found = 'local:aaaaaaaa';
    catalogue.tracks[found] = {
        id: found,
        source: 'local',
        title: 'Newly Found',
        artist: 'Home Recording',
        album: 'Unknown Album',
        albumId: 'system:local-music',
        metadata: { fileName: 'newly-found.mp3' }
    };
    catalogue.predefinedSongs['library/system:local-music'].push(found);

    candidates = await chooser.candidates('user_albums/my-mix', 'all');
    assert.ok(candidates.some((track) => track.id === found), 'the new song is there to choose');

    const rows = await chooser.list('user_albums/my-mix', 'library/system:local-music');
    assert.ok(rows.join('\n').includes('Newly Found'));
});

test('the chooser reads the catalogue, and Local Music is never added to by hand', () => {
    const chooser = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function libraryCandidates(targetAlbum, sourceAlbumFilter)'),
        PLAYER_SOURCE.indexOf('function trackCollectionName(track)')
    );
    assert.ok(chooser.length > 0, 'the chooser was found');

    // One source: the catalogue the page already has.
    assert.match(chooser, /const tracks = window\.libraryTracks \|\| \{\};/);
    assert.ok(!/getEffectiveSongsForAlbum/.test(chooser), 'not album membership on its own');
    assert.ok(!/fetch\(|catalogClient/.test(chooser), 'and no store of its own');

    // Local Music is filled by the machine, not by anybody choosing songs.
    assert.match(PLAYER_SOURCE, /if \(info && info\.isSystemCollection\) return;/);
    assert.match(PLAYER_SOURCE, /if \(albumInfo\[currentFolder\] && albumInfo\[currentFolder\]\.isSystemCollection\)/);

    // The filter offers named collections, in the order the library shows them.
    assert.match(PLAYER_SOURCE, /albumFilter\.innerHTML = '<option value="all">All Music<\/option>';/);
    assert.match(PLAYER_SOURCE, /\.sort\(\(a, b\) => albumPriority\(a\) - albumPriority\(b\)\)/);
});

test('putting a scanned song in an album copies nothing and writes nothing upstream', async (t) => {
    const installation = buildInstallation();
    t.after(() => installation.cleanup());

    for (let i = 0; i < 10; i += 1) {
        writeFile(installation.musicFolder, 'song-' + i + '.mp3', song('Song ' + i, 'pick' + i));
    }

    installation.scanner.start({});
    await waitForScan(installation.scanner, 30000);

    const before = fs.readdirSync(installation.musicFolder).length;
    const trackId = 'local:' + installation.deviceLibrary.getTracks()[0].id;
    const albumId = 'global-album:11111111-1111-4111-8111-111111111111';

    installation.rest._state.albums.push({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Afterglow',
        artist: 'Nova Rae',
        album_artist: 'Nova Rae',
        artwork_path: null
    });

    // A scanned song, put into this listener's copy of a published album.
    installation.service.addTrackToAlbumForUser(USER_A, albumId, trackId);

    const inAlbum = await installation.service.getTracks({ userId: USER_A, albumId: albumId });
    assert.strictEqual(inAlbum.items.filter((track) => track.id === trackId).length, 1, 'there once');

    // Another listener's copy of that album does not have it.
    const theirs = await installation.service.getTracks({ userId: USER_B, albumId: albumId });
    assert.ok(!theirs.items.some((track) => track.id === trackId));

    // No file was copied, and nothing was written upstream.
    assert.strictEqual(fs.readdirSync(installation.musicFolder).length, before, 'no file was copied');
    assert.deepStrictEqual(installation.rest._state.writes, []);
    assert.strictEqual(installation.deviceLibrary.getTracks().length, 10, 'and the device library is as it was');
});

// ============================================
// What a refresh costs, and what it says
// ============================================

/** The part of the player that looks after searching this device. */
function deviceScanSection() {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('// ==================== Music on this device'),
        PLAYER_SOURCE.indexOf('function libraryFolderForAlbum')
    );
    assert.ok(section.length > 0, 'the section was found');
    return section;
}

test('a refresh looks for what changed without showing anything', () => {
    const section = deviceScanSection();

    // The check a refresh starts is silent: the panel is drawn only when the
    // search is one somebody is waiting on.
    assert.match(section, /if \(deviceScanReport\.permission === 'allowed'\) \{\s*await startDeviceScan\(\{ silent: true \}\);/);
    assert.match(section, /if \(!deviceScanSilent\) renderDeviceScanProgress\(result\.scan\);/);
    assert.match(section, /if \(!deviceScanSilent\) renderDeviceScanProgress\(status\.scan\);/);

    // Nothing is ever unhidden without first asking whether this search is
    // one to show.
    const shows = section.match(/renderDeviceScanProgress\(/g) || [];
    assert.ok(shows.length >= 3, 'the panel is drawn from more than one place');
    assert.ok(
        !/^\s*renderDeviceScanProgress\(/m.test(section.replace(/function renderDeviceScanProgress[\s\S]*$/, '')),
        'and never unconditionally'
    );
});

test('a search somebody asked for still shows its progress', () => {
    const section = deviceScanSection();

    // Saying yes to the question starts a visible search: no silent flag.
    const allow = section.slice(
        section.indexOf("document.getElementById('deviceScanStart')"),
        section.indexOf("document.getElementById('deviceScanLater')")
    );
    assert.match(allow, /await startDeviceScan\(\);/);

    // Rescanning by hand reads every file again, and shows that it is doing so.
    const manual = section.slice(
        section.indexOf("document.getElementById('scanDeviceLink')"),
        section.indexOf("document.getElementById('deviceScanCancel')")
    );
    assert.match(manual, /startDeviceScan\(searchedBefore \? \{ mode: 'full' \} : \{\}\)/);
    assert.ok(!/silent/.test(manual), 'a rescan asked for by hand is not a silent one');

    // A full search is never silenced, whoever started it.
    assert.match(section, /deviceScanSilent = Boolean\(settings\.silent\) && \(!result\.scan \|\| result\.scan\.mode !== 'full'\)/);
});

test('a quiet check says something only when there is something new', () => {
    const section = deviceScanSection();
    const finishing = section.slice(section.indexOf('if (!status.running)'), section.indexOf('}, DEVICE_SCAN_POLL_MS)'));

    // Nothing new: nothing said, and no panel left to hide.
    assert.match(finishing, /if \(silent\) \{[\s\S]{0,400}if \(added > 0\) \{/);
    assert.match(finishing, /return;\s*\}/);

    // Something new: one short sentence, for about two seconds.
    assert.match(finishing, /new songs added to Local Music/);
    assert.match(finishing, /new song added to Local Music/);
    assert.match(finishing, /DEVICE_SCAN_TOAST_MS/);
    assert.match(section, /const DEVICE_SCAN_TOAST_MS = 2000;/);
});

test('a library that has not changed is not reloaded', () => {
    const section = deviceScanSection();

    // Recognising a file the index already knew is not a change. Counting it
    // as one meant refetching the whole catalogue on every refresh.
    assert.match(section, /function deviceScanChanges\(scan\) \{[\s\S]{0,260}numberOf\(scan\.newTracks\) \+ numberOf\(scan\.changedTracks\) \+ numberOf\(scan\.missingTracks\)/);
    assert.match(section, /if \(deviceScanChanges\(status\.scan\) > 0 && Date\.now\(\) - deviceScanRefreshAt > 4000\)/);
    assert.match(section, /const changed = deviceScanChanges\(status\.scan\);\s*if \(changed > 0\) await refreshLibraryQuietly\(\);/);

    // tracksFound counts everything the walk recognised, unchanged included,
    // so it is not what decides whether to reload.
    assert.ok(!/tracksFound > 0/.test(section), 'a recognised file is not a change');
});

test('one device, one search, however many tabs are open', () => {
    const section = deviceScanSection();

    // A search already running is watched, not started again; the server owns
    // the job, so a second tab joins the first.
    assert.match(section, /if \(deviceScanReport\.running\)[\s\S]{0,320}watchDeviceScan\(\);\s*return;/);
    assert.match(section, /function watchDeviceScan\(\) \{\s*if \(deviceScanTimer\) return;/);
});
