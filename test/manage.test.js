'use strict';

/**
 * Managing a library, without ever managing somebody's files.
 *
 * The line this holds is the one that matters most in the whole feature:
 * Spotifie organises music, it does not own it. Forgetting a folder, removing
 * a song from an album, deleting a playlist - none of them touches a file on
 * anybody's disk, and there is deliberately no control anywhere that does. A
 * library manager that can delete your music is a file manager with a worse
 * interface and higher stakes.
 *
 * The second line is between what a machine has and what a person arranged.
 * Stop looking in a folder and its songs leave Local Music, because Local
 * Music is what is here. They do not leave a playlist: that is somebody's
 * arrangement, it says the song is unavailable, and it reconnects by itself.
 *
 * And the third is who may change what. A guest may look; a listener may
 * organise their own things; only a verified administrator may touch the
 * catalogue everybody shares - decided on the server, every time.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { DeviceLibrary } = require('../lib/deviceLibrary');
const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { UserStateStore } = require('../lib/userState');
const { CatalogService } = require('../lib/catalogService');
const { GlobalCatalog } = require('../lib/globalCatalog');
const { createLibraryRoutes } = require('../lib/libraryRoutes');
const { auditCatalogue } = require('../lib/adminMaintenance');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const ROOT = path.join(__dirname, '..');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
const ADMIN_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'admin.js'), 'utf8');

/**
 * A file's code, with its comments taken out.
 *
 * Several of these tests check that something is never done. The comments
 * explaining why it is never done would otherwise be read as doing it.
 */
function codeOf(file) {
    return fs
        .readFileSync(path.join(ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ============================================
// The folders Spotifie looks in
// ============================================

function buildDevice(options) {
    const settings = options || {};
    const musicRoot = makeTempDir('spotifie-manage-music-');
    const dataDir = makeTempDir('spotifie-manage-data-');

    if (settings.build) settings.build(musicRoot);

    const device = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });
    device.allowScanning();

    return {
        device: device,
        musicRoot: musicRoot,
        dataDir: dataDir,
        cleanup() {
            removeDir(musicRoot);
            removeDir(dataDir);
        }
    };
}

test('forgetting a folder stops Spotifie looking there and deletes nothing', async (t) => {
    const context = buildDevice({
        build: (root) => {
            writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }));
            writeFile(root, 'two.mp3', buildMp3({ title: 'Two', filler: 'bb' }));
        }
    });
    t.after(() => context.cleanup());

    const location = context.device.rememberLocation(context.musicRoot, { label: 'Music' });
    await context.device.libraryFor(context.musicRoot).scan();

    assert.strictEqual(context.device.getTracks().length, 2);

    const forgotten = context.device.forgetLocation(location.id);

    assert.ok(forgotten, 'the folder was forgotten');
    assert.strictEqual(forgotten.label, 'Music');
    assert.strictEqual(context.device.getTracks().length, 0, 'its songs leave Local Music');
    assert.strictEqual(context.device.listLocations().length, 0, 'and it is not searched again');

    // The whole point: the music is exactly where it was.
    const stillThere = fs.readdirSync(context.musicRoot).sort();
    assert.deepStrictEqual(stillThere, ['one.mp3', 'two.mp3'], 'every file is still on the disk');
});

test('a folder that was never known is not an error, and changes nothing', (t) => {
    const context = buildDevice({});
    t.after(() => context.cleanup());

    assert.strictEqual(context.device.forgetLocation('nothing-like-this'), null);
});

test('a forgotten folder can be added again, and its songs come back', async (t) => {
    const context = buildDevice({
        build: (root) => writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }))
    });
    t.after(() => context.cleanup());

    const first = context.device.rememberLocation(context.musicRoot, { label: 'Music' });
    await context.device.libraryFor(context.musicRoot).scan();
    const originalId = context.device.getTracks()[0].id;

    context.device.forgetLocation(first.id);
    assert.strictEqual(context.device.getTracks().length, 0);

    context.device.rememberLocation(context.musicRoot, { label: 'Music' });
    await context.device.libraryFor(context.musicRoot).scan();

    // The same id, because an id is the fingerprint of the file's contents -
    // which is why a playlist that named it reconnects by itself.
    assert.strictEqual(context.device.getTracks()[0].id, originalId, 'the same song, recognised again');
});

test('the folders are described by name, never by where they are on a disk', async (t) => {
    const context = buildDevice({
        build: (root) => writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }))
    });
    t.after(() => context.cleanup());

    context.device.rememberLocation(context.musicRoot, { label: 'Music' });
    await context.device.libraryFor(context.musicRoot).scan();

    const described = context.device.describeLocations();
    const written = JSON.stringify(described);

    assert.strictEqual(described.length, 1);
    assert.strictEqual(described[0].label, 'Music');
    assert.strictEqual(described[0].trackCount, 1);
    assert.ok(!written.includes(context.musicRoot), 'the path itself never leaves the server');
    assert.ok(!/[A-Za-z]:\\\\|\/tmp\/|\/home\//.test(written), 'and nothing that looks like one does either');
});

// ============================================
// What somebody arranged survives it
// ============================================

test('forgetting a folder leaves playlists and liked songs exactly as they were', async (t) => {
    const context = buildDevice({
        build: (root) => writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }))
    });
    t.after(() => context.cleanup());

    const location = context.device.rememberLocation(context.musicRoot, { label: 'Music' });
    await context.device.libraryFor(context.musicRoot).scan();

    const trackId = 'local:' + context.device.getTracks()[0].id;

    const store = new UserStateStore({ rootDir: path.join(context.dataDir, 'users') });
    const listener = 'listener-0001';
    store.like(listener, trackId);
    const playlist = store.createPlaylist(listener, { title: 'Kept' });
    store.addPlaylistTrack(listener, playlist.id, trackId);

    context.device.forgetLocation(location.id);

    const after = store.read(listener);
    assert.ok(after.likedTrackIds.includes(trackId), 'still liked');
    assert.deepStrictEqual(after.playlists[0].trackIds, [trackId], 'still in the playlist');
});

test('nothing in the device library can reach anybody personal state', () => {
    const device = codeOf('lib/deviceLibrary.js');

    assert.ok(!/userState|playlist|likedTrackIds/i.test(device), 'it knows about files and nothing else');

    // And there is no path from it to deleting music. The one file it removes
    // is an index it wrote itself, inside its own working folder.
    assert.ok(!/rmSync|rmdirSync|removeDir/.test(device), 'it removes no folder');

    const removals = device.match(/unlinkSync\([^)]*\)/g) || [];
    assert.deepStrictEqual(removals, ['unlinkSync(indexFile)'], 'the only thing it deletes is its own index');
});

// ============================================
// Songs that look like copies
// ============================================

test('the same file in two places is reported as certain, and left alone', async (t) => {
    const twice = buildMp3({ title: 'Twice', artist: 'Someone', filler: 'cc' });

    const context = buildDevice({
        build: (root) => {
            writeFile(root, path.join('here', 'song.mp3'), twice);
            writeFile(root, path.join('there', 'song.mp3'), twice);
        }
    });
    t.after(() => context.cleanup());

    context.device.rememberLocation(context.musicRoot, { label: 'Music' });
    await context.device.libraryFor(context.musicRoot).scan();

    const found = context.device.findDuplicates();

    assert.strictEqual(found.identical.length, 1);
    assert.strictEqual(found.identical[0].copies, 2);
    assert.strictEqual(found.identical[0].title, 'Twice');

    // Reported only. Both files are still there.
    assert.strictEqual(context.device.getTracks().length, 1, 'one song, as it always was');
    assert.ok(fs.existsSync(path.join(context.musicRoot, 'here', 'song.mp3')));
    assert.ok(fs.existsSync(path.join(context.musicRoot, 'there', 'song.mp3')));
});

test('two different files that look alike are only ever a suggestion', async (t) => {
    const context = buildDevice({
        build: (root) => {
            writeFile(root, 'a.mp3', buildMp3({ title: 'Same Name', artist: 'Someone', filler: 'aa' }));
            writeFile(root, 'b.mp3', buildMp3({ title: 'Same Name', artist: 'Someone', filler: 'bbbb' }));
        }
    });
    t.after(() => context.cleanup());

    context.device.rememberLocation(context.musicRoot, { label: 'Music' });
    await context.device.libraryFor(context.musicRoot).scan();

    const found = context.device.findDuplicates();

    assert.strictEqual(found.identical.length, 0, 'they are not the same file');
    assert.strictEqual(found.probable.length, 1, 'but they look like the same recording');
    assert.strictEqual(found.probable[0].tracks.length, 2);

    // Both remain: deciding two recordings are one is a judgement about music.
    assert.strictEqual(context.device.getTracks().length, 2);
});

// ============================================
// Over HTTP
// ============================================

function startLibrary(routes) {
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

function ask(port, pathname, method) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: method || 'GET' }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('the management routes answer with counts and names, never with paths', async (t) => {
    const dataDir = makeTempDir('spotifie-manage-routes-');
    const musicRoot = makeTempDir('spotifie-manage-routes-music-');
    t.after(() => {
        removeDir(dataDir);
        removeDir(musicRoot);
    });

    writeFile(musicRoot, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }));

    const routes = createLibraryRoutes({
        musicRoot: musicRoot,
        serviceOptions: { musicRoot: musicRoot },
        deviceOptions: { deviceDir: path.join(dataDir, 'device') }
    });

    routes.deviceLibrary.allowScanning();
    const location = routes.deviceLibrary.rememberLocation(musicRoot, { label: 'Music' });
    await routes.deviceLibrary.libraryFor(musicRoot).scan();

    const started = await startLibrary(routes);
    t.after(() => started.server.close());

    // ---- what is here ----
    const health = await ask(started.port, '/api/library/health');
    assert.strictEqual(health.status, 200);

    const summary = JSON.parse(health.body);
    assert.strictEqual(summary.permission, 'allowed');
    assert.strictEqual(summary.device.trackCount, 1);
    assert.strictEqual(summary.device.locationCount, 1);
    assert.ok(!health.body.includes(musicRoot), 'no path is reported');

    // ---- where it looks ----
    const locations = await ask(started.port, '/api/library/locations');
    assert.strictEqual(locations.status, 200);
    assert.strictEqual(JSON.parse(locations.body).locations.length, 1);
    assert.ok(!locations.body.includes(musicRoot));

    // ---- what looks like a copy ----
    assert.strictEqual((await ask(started.port, '/api/library/duplicates')).status, 200);

    // ---- forgetting one ----
    const forgotten = await ask(started.port, '/api/library/locations/' + location.id, 'DELETE');
    assert.strictEqual(forgotten.status, 200);

    const result = JSON.parse(forgotten.body);
    assert.strictEqual(result.forgotten, true);
    // Said in the answer, because it is the thing somebody wants to be sure of.
    assert.strictEqual(result.filesDeleted, 0);
    assert.ok(fs.existsSync(path.join(musicRoot, 'one.mp3')), 'and it is true');

    // A folder that is not there is a 404, not a silent success.
    assert.strictEqual((await ask(started.port, '/api/library/locations/nope', 'DELETE')).status, 404);

    // Reading is a read: these do not answer to the wrong method.
    assert.strictEqual((await ask(started.port, '/api/library/health', 'POST')).status, 405);
    assert.strictEqual((await ask(started.port, '/api/library/locations', 'POST')).status, 405);
});

// ============================================
// The shared catalogue: what an audit may and may not do
// ============================================

function fakeAudit(options) {
    const settings = options || {};

    return auditCatalogue({
        global: {
            audioBucket: 'catalog-audio',
            artworkBucket: 'catalog-artwork',
            fetchCatalog: async () => ({ available: true })
        },
        readRows: async () => settings.rows,
        listStorageObjects: async (bucket) =>
            (settings.buckets[bucket] || []).map((name) => ({ name: name, id: 'object' }))
    });
}

test('the audit finds what is broken and says how sure it is', async () => {
    const report = await fakeAudit({
        rows: {
            albums: [{ id: 'A1', title: 'Golden Hour', artwork_path: 'covers/gone.jpg' }],
            tracks: [
                { id: 'T1', album_id: 'A1', title: 'First', artist: 'X', audio_path: 'audio/first.mp3' },
                { id: 'T2', album_id: 'A1', title: 'Second', artist: 'X', audio_path: 'audio/missing.mp3' },
                { id: 'T3', album_id: 'GONE', title: 'Third', artist: 'X', audio_path: 'audio/first.mp3' },
                { id: 'T4', album_id: 'A1', title: 'Fourth', artist: 'X', audio_path: null }
            ]
        },
        buckets: { 'catalog-audio': ['audio/first.mp3', 'audio/nobody.mp3'], 'catalog-artwork': [] }
    });

    assert.strictEqual(report.available, true);

    // Certain: a row names a file the bucket does not have.
    assert.strictEqual(report.missingAudio.total, 2);
    assert.strictEqual(report.missingArtwork.total, 1);
    assert.strictEqual(report.orphanedTracks.total, 1);

    // A candidate: a file no row names. It may be an upload finishing.
    assert.strictEqual(report.orphanedAudio.total, 1);
    assert.strictEqual(report.orphanedAudio.items[0].objectPath, 'audio/nobody.mp3');

    // Two rows sharing one stored file is one upload recorded twice.
    assert.strictEqual(report.duplicates.sameFile.total, 1);
    assert.deepStrictEqual(report.duplicates.sameFile.items[0].trackIds, ['T1', 'T3']);
});

test('a bucket that could not be read is not a bucket full of orphans', async () => {
    const report = await auditCatalogue({
        global: {
            audioBucket: 'catalog-audio',
            artworkBucket: 'catalog-artwork',
            fetchCatalog: async () => ({ available: true })
        },
        readRows: async () => ({ albums: [], tracks: [{ id: 'T1', title: 'One', audio_path: 'audio/one.mp3' }] }),
        listStorageObjects: async () => {
            throw new Error('Supabase is unreachable');
        }
    });

    // Nothing is called missing and nothing is called an orphan, because
    // nothing could be seen. Saying so is the honest answer.
    assert.strictEqual(report.missingAudio.total, 0);
    assert.strictEqual(report.orphanedAudio.total, 0);
    assert.strictEqual(report.coverage.audioComplete, false);
    assert.match(report.coverage.audioError, /unreachable/);
});

test('an unreachable catalogue is reported, not guessed at', async () => {
    const report = await auditCatalogue({
        global: {
            audioBucket: 'catalog-audio',
            artworkBucket: 'catalog-artwork',
            fetchCatalog: async () => ({ available: false, error: 'Supabase could not be reached' })
        },
        readRows: async () => ({ albums: [], tracks: [] }),
        listStorageObjects: async () => []
    });

    assert.strictEqual(report.available, false);
    assert.match(report.error, /could not be reached/);
});

test('the audit has no way to delete anything', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'adminMaintenance.js'), 'utf8');

    assert.ok(!/removeStorageObject|deleteRows|deleteTrack|deleteAlbum/.test(source), 'it removes nothing');
    assert.ok(!/insertRow|updateRows/.test(source), 'and writes nothing');
    // It reads the bucket listing and the rows, and that is all it can do.
    assert.match(source, /listStorageObjects/);
});

test('the audit is administrator-only, and absent from a public build', () => {
    const admin = fs.readFileSync(path.join(ROOT, 'lib', 'adminCatalogRoutes.js'), 'utf8');

    const section = admin.slice(admin.indexOf("segments[1] === 'maintenance'"), admin.indexOf("segments[0] === 'tracks'"));
    assert.match(section, /const admin = await requireAdmin\(req\);/, 'checked on the server');
    assert.match(section, /if \(!admin\.ok\) \{/);

    // It lives in the private module, so the public release has no such route.
    const builder = fs.readFileSync(path.join(ROOT, 'tools', 'buildPublic.js'), 'utf8');
    assert.ok(!builder.includes("'lib/adminMaintenance.js'"), 'the release does not ship it');
    assert.ok(!builder.includes("'lib/adminCatalogRoutes.js'"), 'nor the routes that use it');
});

// ============================================
// The manager on the page
// ============================================

test('nothing in the manager can delete a file, and it says so', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('// Managing the music on this machine'),
        PLAYER_SOURCE.indexOf('function initBackupRestore()')
    );

    // There is no such request to make.
    assert.ok(!/DELETE.*tracks\/|deleteFile|unlink|removeFile/i.test(section), 'no path deletes a track');

    // And forgetting a folder says plainly what it costs, what it does not
    // do, and how to undo it.
    assert.match(section, /No file on your device is deleted/);
    assert.match(section, /from this folder leave Local Music/);
    assert.match(section, /count === 1 \? '1 song' : count \+ ' songs'/, 'and counts them properly');
    assert.match(section, /anything you put in a playlist stays there/);
    assert.match(section, /Rescan Local Music to look here again/, 'and how to undo it');
    assert.match(PLAYER_SOURCE, /confirmAction\(\{[\s\S]{0,700}Stop looking/);
});

test('the manager asks with the application dialog, never the browser', () => {
    assert.match(PLAYER_SOURCE, /function confirmAction\(details\)/);
    assert.match(PLAYER_SOURCE, /function chooseFromList\(details\)/);

    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('// Managing the music on this machine'),
        PLAYER_SOURCE.indexOf('function initBackupRestore()')
    );

    assert.ok(!/window\.alert|window\.confirm|window\.prompt/.test(section), 'nothing stops the page');
    assert.ok(!/\balert\(/.test(section));
});

test('the manager can search, sort and select, and says how many', () => {
    assert.match(PLAYER_SOURCE, /function visibleLocalTracks\(\)/);

    const sorting = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function visibleLocalTracks()'),
        PLAYER_SOURCE.indexOf('function renderLocalTracks()')
    );

    ['duration', 'added', 'artist', 'fileName'].forEach((by) => {
        assert.ok(sorting.includes("by === '" + by + "'") || sorting.includes(by), 'it can sort by ' + by);
    });

    // Searching looks at what somebody would search for.
    assert.match(sorting, /track\.title/);
    assert.match(sorting, /track\.artist/);
    assert.match(sorting, /fileName/);

    assert.match(PLAYER_SOURCE, /localManager\.selected\.size \+ ' selected'/);
});

test('a bulk action on an album adds each song once', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function bulkAddToAlbum()'),
        PLAYER_SOURCE.indexOf('// Searching this machine, from here')
    );

    // An album holds a song once; a playlist may repeat one, because that is
    // an arrangement rather than a membership.
    assert.match(section, /const current = new Set\(predefinedSongs\[folder\] \|\| \[\]\);/);
    assert.match(section, /if \(current\.has\(trackId\)\) continue;/);

    const playlist = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function bulkAddToPlaylist()'),
        PLAYER_SOURCE.indexOf('async function bulkAddToAlbum()')
    );
    assert.ok(!/new Set\(/.test(playlist), 'a playlist keeps what it was given');
});

test('songs the machine cannot see are shown apart, and never as playable', () => {
    assert.match(PLAYER_SOURCE, /function unavailableCollectionTracks\(\)/);

    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function unavailableCollectionTracks()'),
        PLAYER_SOURCE.indexOf('function renderLocalHealth()')
    );

    // Taken from what a person arranged, and only the ones that are missing.
    assert.match(section, /if \(!entry \|\| !entry\.missing \|\| !entry\.id\) return;/);
    assert.match(section, /personal\.getLiked\(\)\.forEach\(consider\);/);
    assert.match(section, /personal\.getPlaylists\(\)/);

    // Clicking one does nothing: there is nothing to play.
    assert.match(PLAYER_SOURCE, /if \(!row \|\| row\.classList\.contains\('is-unavailable'\)\) return;/);
});

// ============================================
// The dashboard
// ============================================

test('several tracks can be chosen, and deleting them asks first', () => {
    assert.match(ADMIN_SOURCE, /function initBulkActions\(\)/);
    assert.match(ADMIN_SOURCE, /const bulkSelection = new Set\(\);/);

    const section = ADMIN_SOURCE.slice(
        ADMIN_SOURCE.indexOf('async function bulkDeleteSelected()'),
        ADMIN_SOURCE.indexOf('async function bulkMoveSelected()')
    );

    // Asked once, with the number and the consequence spelled out.
    assert.match(section, /const agreed = await askToConfirm\(/);
    assert.match(section, /Every listener loses access and the stored audio is removed\. This cannot be undone\./);
    assert.match(section, /if \(!agreed\) return;/);

    // Each deletion is the ordinary guarded path, not a shortcut past it.
    assert.match(section, /await catalogClient\(\)\.deleteGlobalTrack\(id\)/);

    // And the copy every browser keeps is dropped afterwards.
    assert.match(section, /forgetCachedCatalogue\(\);/);
});

test('the dashboard asks in its own dialog, not the browser', () => {
    const admin = codeOf('js/admin.js');

    assert.match(admin, /function askToConfirm\(message\)/);
    assert.ok(!/window\.confirm|window\.prompt|window\.alert/.test(admin), 'nothing stops the page');
    assert.ok(!/\balert\(/.test(admin));

    // It reuses the dialog already on the page rather than adding a second
    // one, so a destructive question always looks the same.
    assert.match(admin, /document\.getElementById\('deleteModal'\)/);
});

test('the maintenance report is read-only, and reached only after the guard', () => {
    assert.match(ADMIN_SOURCE, /async function runMaintenanceAudit\(\)/);

    const section = ADMIN_SOURCE.slice(
        ADMIN_SOURCE.indexOf('async function runMaintenanceAudit()'),
        ADMIN_SOURCE.indexOf('function renderMaintenanceSummary')
    );

    assert.match(section, /_request\('\/api\/catalog\/admin\/maintenance'\)/);
    assert.ok(!/DELETE|method: 'POST'/.test(section), 'the report changes nothing');

    // And the uncertain findings are labelled as uncertain.
    assert.match(ADMIN_SOURCE, /These may be uploads still in progress/);
    assert.match(ADMIN_SOURCE, /nothing should be removed without checking/);
});

test('an ordinary listener has no way to reach any of it', () => {
    // The dashboard is the private half of the application; a listener's page
    // does not load it and could not use it if it did, because every write is
    // checked on the server.
    assert.ok(!/adminMaintenance|admin\/maintenance/.test(PLAYER_SOURCE), 'the player knows nothing about it');
    assert.ok(!/deleteGlobalTrack|deleteGlobalAlbum/.test(PLAYER_SOURCE), 'and cannot delete published content');
});

// ============================================
// Local albums stay organisation, never files
// ============================================

test('a local album is a list of ids, and deleting one deletes a list', () => {
    // Removing an album takes away the organisation and nothing else. There is
    // no request anywhere in the page that removes audio from a disk.
    assert.ok(!/api\/library\/tracks\/[^']*'\s*,\s*\{\s*method: 'DELETE'/.test(PLAYER_SOURCE));

    const routes = fs.readFileSync(path.join(ROOT, 'lib', 'libraryRoutes.js'), 'utf8');
    assert.ok(
        !/segments\[0\] === 'tracks'[\s\S]{0,400}method === 'DELETE'/.test(routes),
        'and the server offers no route to delete one'
    );
});

test('an album holds each song once, however it was added', () => {
    const service = fs.readFileSync(path.join(ROOT, 'lib', 'catalogService.js'), 'utf8');

    // Membership is deduplicated by canonical id, wherever it is assembled.
    assert.match(PLAYER_SOURCE, /if \(!predefinedSongs\[folder\]\.includes\(track\.id\)\) predefinedSongs\[folder\]\.push\(track\.id\)/);
    assert.match(service, /placed\.has\(membership\)/);
});


// ============================================
// The card that stands for this machine
// ============================================

/**
 * Local Music is a card in the library like any other, and it is not an album.
 * Nobody named it, nobody chose a cover for it and nobody put songs in it: it
 * is what this device happens to hold. So it carries what is true of a machine
 * - how much music is on it, and somewhere to go to look after it - and none
 * of the controls that belong to something a person made.
 */

test('the card for this machine offers no control that means nothing to it', () => {
    const cards = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function refreshAlbumCards()'),
        PLAYER_SOURCE.indexOf('function bindAlbumCardEvents()')
    );

    // Every card has the same menu button; what is inside the menu is what
    // makes sense for the thing it belongs to.
    assert.match(cards, /const menuOptions = isSystem \? `/);
    assert.match(cards, /const isSystem = Boolean\(info\.isSystemCollection\);/);

    // Renaming, pinning and deleting are offered to albums and to nothing
    // else, and looking after this device is offered to nothing else.
    const start = cards.indexOf('const menuOptions = isSystem ?');
    const split = cards.indexOf("` : `", start);
    const end = cards.indexOf('const menuMarkup', start);
    assert.ok(start !== -1 && split > start && end > split, 'both halves were found');

    const machine = cards.slice(start, split);
    const album = cards.slice(split, end);

    assert.match(machine, /manage-local-option/);
    assert.ok(!/edit-option|pin-option|delete-option/.test(machine), 'nothing to rename, pin or delete');

    assert.match(album, /edit-option/);
    assert.match(album, /pin-option/);
    assert.match(album, /delete-option/);
    assert.ok(!/manage-local-option/.test(album), 'and no album is asked to manage this device');

    // Which matters for more than tidiness: deleting Local Music wrote it into
    // this browser's list of removed albums, and every later load read that
    // list and took the collection away again. The list is now read without
    // system collections in it, so an entry made before this cannot survive.
    assert.match(PLAYER_SOURCE, /const removable = deletedAlbums\.filter\(\(folder\) => !isSystemFolder\(folder\)\);/);
    assert.ok(
        cards.indexOf('delete-option') > cards.indexOf('const menuMarkup = isSystem'),
        'the delete option lives inside the menu that a system collection has none of'
    );
});

test('the card says how much music is on this machine, and offers to manage it', () => {
    const cards = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function refreshAlbumCards()'),
        PLAYER_SOURCE.indexOf('function bindAlbumCardEvents()')
    );

    // In the menu, where a card keeps what can be done with it - not as a
    // button of its own stuck over the artwork.
    assert.match(cards, /<span>Manage Local Music<\/span>/);
    assert.ok(!/local-card-manage/.test(PLAYER_SOURCE), 'and not as a control of its own');

    // A guest looks after this machine exactly as an account does, so the
    // gating that hides an album's menu leaves this one alone.
    assert.match(cards, /data-system="true"/);
    assert.match(PLAYER_SOURCE, /\.cardcontainer \.card-menu:not\(\[data-system\]\)/);

    // A count, and an ordinary sentence when there is nothing to count. An
    // empty machine is a state, not a fault, and never a reason for the card
    // to go.
    const status = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function localCollectionStatus(folder)'),
        PLAYER_SOURCE.indexOf('function albumCardArtist(info)')
    );
    assert.match(status, /if \(!count\) return 'No songs yet';/);
    assert.match(status, /count \+ \(count === 1 \? ' song' : ' songs'\)/);
    assert.ok(!/return;|return null/.test(status), 'a count of zero still has something to say');
});

test('managing the machine opens the manager, and does not open the collection', () => {
    const binding = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function bindAlbumCardEvents()'),
        PLAYER_SOURCE.indexOf('function toggleCardMenu(button)')
    );

    // Answered where every other menu option is answered: the menu closes,
    // the thing happens, and the card behind it is never opened.
    const options = binding.indexOf('.manage-local-option');
    const open = binding.indexOf('await openAlbumDetail(folder)');

    assert.ok(options > -1, 'the grid knows the option');
    assert.ok(open > options, 'and answers it before it opens anything');
    assert.match(binding, /event\.stopPropagation\(\);\s*const folder = option\.dataset\.folder;\s*closeAllMenus\(\);/);
    assert.match(binding, /if \(option\.classList\.contains\('manage-local-option'\)\) await openLocalManager\(\);/);

    // And the button that opens the menu opens nothing else.
    assert.match(binding, /const menuButton = event\.target\.closest\('\.card-menu-btn'\);[\s\S]{0,200}event\.stopPropagation\(\);[\s\S]{0,80}return;/);
});

test('the surface that fills the screen cannot close the card that is playing', () => {
    const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

    // "now-playing" names two things: the full-screen surface, and the marker
    // on the card whose music is sounding. Written as a bare class, the
    // surface's own "closed until opened" rule matched the card as well - so
    // whatever was playing disappeared from the library, and Local Music
    // disappeared with it whenever local music was what was playing.
    assert.match(css, /#nowPlayingOverlay \{[\s\S]{0,400}display: none;/);
    assert.match(css, /#nowPlayingOverlay\.is-open \{\s*display: flex;/);

    const bare = css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .match(/(^|[},])\s*\.now-playing\s*(,|\{)/g);
    assert.strictEqual(bare, null, 'nothing styles a bare .now-playing any more');

    // The card's own marker is always qualified by the card.
    const markers = (css.match(/\.now-playing(?![-\w])/g) || []).length;
    const qualified = (css.match(/\.cardcontainer\.now-playing/g) || []).length;
    assert.strictEqual(markers, qualified, 'every mention of the marker names the card');
});


// ============================================
// A folder somebody said to stop looking in
// ============================================

/**
 * Forgetting a folder has to outlast the folder.
 *
 * Music, Downloads and Desktop are found again by every search that runs, so
 * taking one out of the list and nothing more meant the next automatic search
 * put it straight back - and forgetting it looked as though it had done
 * nothing at all. What somebody decided is written down at the level of the
 * installation, and only somebody asking for the whole device to be searched
 * again reconsiders it.
 */

const { DeviceMusicScanner } = require('../lib/deviceScan');

/** A search of one folder, over a device that may have been told to skip it. */
function scannerFor(context, folder) {
    return new DeviceMusicScanner({
        deviceLibrary: context.device,
        // Only the folder this test made, never the real machine.
        locations: { homeDir: null, musicRoot: folder, mediaRoot: null, extraRoots: [] },
        batchSize: 4
    });
}

async function waitFor(scanner) {
    const deadline = Date.now() + 20000;
    while (scanner.isRunning()) {
        if (Date.now() > deadline) throw new Error('the search did not finish');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return scanner.statusFor();
}

/** A file big enough for a search to treat it as a song. */
function foundSong(title, filler) {
    return Buffer.concat([
        buildMp3({ title: title, artist: 'Home Recording', album: 'Found Music', filler: filler }),
        Buffer.alloc(600 * 1024, 0x00)
    ]);
}

// ---- A: forgetting takes the songs and leaves the files ----

test('forgetting a folder takes its songs out of Local Music and nothing else', async (t) => {
    const context = buildDevice({
        build: (root) => {
            writeFile(root, 'one.mp3', foundSong('One', 'fa'));
            writeFile(root, 'two.mp3', foundSong('Two', 'fb'));
        }
    });
    t.after(() => context.cleanup());

    const scanner = scannerFor(context, context.musicRoot);
    scanner.start({});
    await waitFor(scanner);

    assert.strictEqual(context.device.getTracks().length, 2, 'both songs were found');

    const location = context.device.listLocations()[0];
    const forgotten = context.device.forgetLocation(location.id);

    assert.ok(forgotten);
    assert.strictEqual(context.device.getTracks().length, 0, 'its songs leave Local Music at once');
    assert.strictEqual(context.device.listLocations().length, 0, 'and the folder leaves the list');
    assert.deepStrictEqual(fs.readdirSync(context.musicRoot).sort(), ['one.mp3', 'two.mp3'], 'the files are untouched');

    // And it is written down, so nothing has to remember it in memory.
    const ignored = context.device.ignoredRoots();
    assert.strictEqual(ignored.length, 1);
    assert.strictEqual(ignored[0].label, path.basename(context.musicRoot));
    assert.ok(ignored[0].forgottenAt, 'with when it happened');
});

// ---- B, C, D: it stays forgotten ----

test('a search that runs by itself never brings a forgotten folder back', async (t) => {
    const context = buildDevice({
        build: (root) => writeFile(root, 'one.mp3', foundSong('One', 'fc'))
    });
    t.after(() => context.cleanup());

    const first = scannerFor(context, context.musicRoot);
    first.start({});
    await waitFor(first);
    context.device.forgetLocation(context.device.listLocations()[0].id);

    // The ordinary search: the one that runs when the page is opened.
    const again = scannerFor(context, context.musicRoot);
    again.start({});
    const finished = await waitFor(again);

    assert.strictEqual(finished.status, 'complete', 'the search finished');
    assert.strictEqual(finished.tracksFound, 0, 'and found nothing, because it looked nowhere');
    assert.strictEqual(context.device.listLocations().length, 0, 'the folder did not come back');
    assert.strictEqual(context.device.getTracks().length, 0, 'and neither did its songs');

    // The cheap check for what moved leaves it alone as well.
    await context.device.reconcile();
    assert.strictEqual(context.device.listLocations().length, 0, 'checking for changes changes nothing');

    // And so does a restart: this is on disk, not in memory.
    const restarted = new DeviceLibrary({ deviceDir: path.join(context.dataDir, 'device') });
    assert.strictEqual(restarted.isIgnoredRoot(context.musicRoot), true, 'still forgotten after a restart');
    assert.strictEqual(restarted.listLocations().length, 0);

    const afterRestart = new DeviceMusicScanner({
        deviceLibrary: restarted,
        locations: { homeDir: null, musicRoot: context.musicRoot, mediaRoot: null, extraRoots: [] }
    });
    afterRestart.start({});
    await waitFor(afterRestart);
    assert.strictEqual(restarted.getTracks().length, 0, 'and a search after a restart still leaves it alone');
});

// ---- E: asking for the whole device again reconsiders it ----

test('searching the whole device again by hand reconsiders a forgotten folder', async (t) => {
    const context = buildDevice({
        build: (root) => writeFile(root, 'one.mp3', foundSong('One', 'fd'))
    });
    t.after(() => context.cleanup());

    const first = scannerFor(context, context.musicRoot);
    first.start({});
    await waitFor(first);
    context.device.forgetLocation(context.device.listLocations()[0].id);
    assert.strictEqual(context.device.getTracks().length, 0);

    // What the Rescan button asks for, and the only thing that undoes this.
    const manual = scannerFor(context, context.musicRoot);
    manual.start({ mode: 'full' });
    await waitFor(manual);

    assert.strictEqual(context.device.ignoredRoots().length, 0, 'the decision is reconsidered');
    assert.strictEqual(context.device.listLocations().length, 1, 'the folder is looked at again');
    assert.strictEqual(context.device.getTracks().length, 1, 'and its songs come back');
});

// ---- the folder next door is a different folder ----

test('forgetting one folder does not forget the one whose name it starts with', (t) => {
    const context = buildDevice({});
    t.after(() => context.cleanup());

    const music = path.join(context.dataDir, 'Music');
    const backup = path.join(context.dataDir, 'MusicBackup');
    const inside = path.join(music, 'Albums');

    context.device.ignoreRoot(music, { label: 'Music' });

    assert.strictEqual(context.device.isIgnoredRoot(music), true, 'the folder itself');
    assert.strictEqual(context.device.isIgnoredRoot(music + path.sep), true, 'however it is written');
    assert.strictEqual(context.device.isIgnoredRoot(backup), false, 'and never the one beside it');
    assert.strictEqual(context.device.isIgnoredRoot(inside), false, 'a folder inside it is its own folder');
});

test('what a device was told to skip belongs to the device, not to an account', () => {
    const device = codeOf('lib/deviceLibrary.js');
    const scan = codeOf('lib/deviceScan.js');

    // Written into the device's own state file, beside the permission to
    // search at all - so a guest, a listener and an administrator at this
    // machine all read the same answer.
    assert.match(device, /ignoredRoots/);
    assert.ok(!/userId|uid|account|profile/i.test(device), 'no account takes part in it');

    // The search asks the device rather than deciding for itself, and only a
    // search somebody asked for in full clears the decision.
    assert.match(scan, /settings\.isIgnored\(resolved\)/);
    assert.match(scan, /const manual = settings\.mode === 'full';/);
    assert.match(scan, /if \(manual && this\.deviceLibrary\) this\.deviceLibrary\.clearIgnoredRoots\(\);/);

    // Reading the state is not permission to search: a file that will not
    // read leaves the folder alone.
    assert.match(scan, /return true;[\s\S]{0,40}\}\s*\}/);
});

// ---- the question is asked over the manager, not behind it ----

test('a question asked from inside a dialog is answered before that dialog', () => {
    const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

    // Two named layers, one step apart. Both were 2000, so whichever came
    // later in the document won - and the confirmation, written first, lost.
    assert.match(css, /--layer-modal: 2000;/);
    assert.match(css, /--layer-modal-over-modal: 2010;/);
    assert.match(css, /\.modal \{[\s\S]{0,200}z-index: var\(--layer-modal\);/);
    assert.match(css, /\.modal\.modal-confirm \{\s*z-index: var\(--layer-modal-over-modal\);/);
    assert.match(css, /\[inert\] \{[\s\S]{0,120}pointer-events: none;/);

    // Whatever asked the question waits behind it, out of reach, and the
    // keyboard stays inside the question until it is answered.
    assert.match(PLAYER_SOURCE, /function holdDialogOpen\(dialog\)/);
    assert.match(PLAYER_SOURCE, /other\.inert = true;/);
    assert.match(PLAYER_SOURCE, /if \(event\.key !== 'Tab'\) return;/);

    // Escape answers the question and stops there, so one press does not put
    // away the thing being asked about.
    assert.match(PLAYER_SOURCE, /event\.stopPropagation\(\);\s*finish\(false\);/);
    assert.match(PLAYER_SOURCE, /localManager\.open && !dialogIsAsking\(\)/);

    // And the browser's own dialogs are still nowhere near any of it.
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('// Managing the music on this machine'),
        PLAYER_SOURCE.indexOf('function initBackupRestore()')
    );
    assert.ok(!/window\.confirm|\balert\(|\bconfirm\(\)/.test(section));
});

test('saying no to the question changes nothing at all', () => {
    const forgetting = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function onLocalLocationClick(event)'),
        PLAYER_SOURCE.indexOf('// Doing one thing to several songs')
    );

    // The request is made after the answer, never before it, and a no returns
    // before anything is asked of the server.
    const asked = forgetting.indexOf('const agreed = await confirmAction(');
    const refused = forgetting.indexOf('if (!agreed) return;');
    const sent = forgetting.indexOf("method: 'DELETE'");

    assert.ok(asked > -1 && refused > asked && sent > refused, 'asked, then answered, then done');

    // And the manager is still open afterwards: the row goes, the numbers
    // change, and nothing had to be reloaded to see it.
    assert.match(forgetting, /await refreshAfterDeviceChange\(\);\s*await refreshLocalManager\(\);/);
});
