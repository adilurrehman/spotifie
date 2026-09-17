'use strict';

/**
 * Keeping Local Music honest, cheaply.
 *
 * Local Music is meant to be what is on this machine right now. A file deleted
 * in a file manager has to leave it, and it has to leave it before somebody
 * presses Play and gets an error - that is the whole point of the collection.
 *
 * The expensive way to guarantee that is to search the disk again on every
 * start, reading tags and hashing files. These tests hold the cheap way in
 * place instead: one stat per known file, nothing read, nothing hashed,
 * nothing walked. A library that has not changed costs a stat per song and
 * produces no work at all.
 *
 * And the line that matters most: what a machine has is not the same question
 * as what somebody arranged. A deleted file leaves Local Music. It does not
 * leave their playlist.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { DeviceLibrary } = require('../lib/deviceLibrary');
const { DeviceWatcher } = require('../lib/deviceWatcher');
const { UserStateStore } = require('../lib/userState');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const ROOT = path.join(__dirname, '..');

function buildLibrary(options) {
    const settings = options || {};
    const musicRoot = makeTempDir('spotifie-rec-music-');
    const dataDir = makeTempDir('spotifie-rec-data-');

    if (settings.build) settings.build(musicRoot);

    const service = new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    return {
        service: service,
        musicRoot: musicRoot,
        dataDir: dataDir,
        cleanup() {
            removeDir(musicRoot);
            removeDir(dataDir);
        }
    };
}

function song(name, filler) {
    return { name: name, data: buildMp3({ title: name, artist: 'Someone', album: 'Somewhere', filler: filler }) };
}

// ============================================
// A file that has gone
// ============================================

test('a deleted file leaves the library at the next check', async (t) => {
    const context = buildLibrary({
        build: (root) => {
            writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }));
            writeFile(root, 'two.mp3', buildMp3({ title: 'Two', filler: 'bb' }));
        }
    });
    t.after(() => context.cleanup());

    await context.service.scan();
    assert.strictEqual(context.service.getTracks({}).total, 2);

    const gone = context.service.getTracks({}).items.find((track) => track.title === 'One');
    fs.unlinkSync(path.join(context.musicRoot, 'one.mp3'));

    const result = await context.service.reconcile();

    assert.strictEqual(result.checked, 2, 'every known file was looked at');
    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(result.removedTrackIds, [gone.id], 'and it says which one');

    // Gone from the library itself, not merely marked.
    assert.strictEqual(context.service.getTracks({}).total, 1);
    assert.strictEqual(context.service.getTrack(gone.id), null);
});

test('what is gone stays gone across a restart, because the index was saved', async (t) => {
    const context = buildLibrary({
        build: (root) => writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }))
    });
    t.after(() => context.cleanup());

    await context.service.scan();
    fs.unlinkSync(path.join(context.musicRoot, 'one.mp3'));
    await context.service.reconcile();

    // A second service reading the same file on disk sees the same thing: the
    // cleaned index was written, not merely held in memory.
    const reopened = new LibraryService({
        musicRoot: context.musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: context.musicRoot }),
        index: new LibraryIndex(path.join(context.dataDir, 'library.json')),
        artworkDir: path.join(context.dataDir, 'artwork'),
        dataDir: context.dataDir
    });

    assert.strictEqual(reopened.getTracks({}).total, 0);
});

test('the same audio in two places only goes when both have gone', async (t) => {
    const twice = buildMp3({ title: 'Twice', artist: 'Someone', filler: 'cc' });

    const context = buildLibrary({
        build: (root) => {
            writeFile(root, path.join('here', 'song.mp3'), twice);
            writeFile(root, path.join('there', 'song.mp3'), twice);
        }
    });
    t.after(() => context.cleanup());

    await context.service.scan();
    // The same contents, so one track under one id.
    assert.strictEqual(context.service.getTracks({}).total, 1);

    fs.unlinkSync(path.join(context.musicRoot, 'here', 'song.mp3'));
    const first = await context.service.reconcile();

    assert.strictEqual(first.removed, 1, 'one file went');
    assert.deepStrictEqual(first.removedTrackIds, [], 'but the song is still here');
    assert.strictEqual(context.service.getTracks({}).total, 1);

    fs.unlinkSync(path.join(context.musicRoot, 'there', 'song.mp3'));
    const second = await context.service.reconcile();

    assert.strictEqual(second.removedTrackIds.length, 1, 'now it has gone');
    assert.strictEqual(context.service.getTracks({}).total, 0);
});

// ============================================
// The cost of being right
// ============================================

test('checking an unchanged library reads no tags and hashes nothing', async (t) => {
    const context = buildLibrary({
        build: (root) => {
            for (let i = 0; i < 40; i += 1) {
                writeFile(root, 'song-' + i + '.mp3', buildMp3({ title: 'Song ' + i, filler: 'f' + i }));
            }
        }
    });
    t.after(() => context.cleanup());

    await context.service.scan();
    assert.strictEqual(context.service.getTracks({}).total, 40);

    // Count what the expensive operations are asked to do.
    let tagReads = 0;
    let hashes = 0;
    let artworkReads = 0;

    const adapter = context.service.adapter;
    const readTags = adapter.readTags.bind(adapter);
    const hashFile = adapter.hashFile.bind(adapter);
    const readArtwork = adapter.readArtwork.bind(adapter);

    adapter.readTags = (...args) => {
        tagReads += 1;
        return readTags(...args);
    };
    adapter.hashFile = (...args) => {
        hashes += 1;
        return hashFile(...args);
    };
    adapter.readArtwork = (...args) => {
        artworkReads += 1;
        return readArtwork(...args);
    };

    const result = await context.service.reconcile();

    assert.strictEqual(result.checked, 40, 'every file was checked');
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.changed.length, 0);

    assert.strictEqual(tagReads, 0, 'nothing was parsed');
    assert.strictEqual(hashes, 0, 'nothing was hashed');
    assert.strictEqual(artworkReads, 0, 'no artwork was extracted');
});

test('a changed file is named, and only that one', async (t) => {
    const context = buildLibrary({
        build: (root) => {
            writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }));
            writeFile(root, 'two.mp3', buildMp3({ title: 'Two', filler: 'bb' }));
            writeFile(root, 'three.mp3', buildMp3({ title: 'Three', filler: 'cc' }));
        }
    });
    t.after(() => context.cleanup());

    await context.service.scan();

    // One file is rewritten: different size, different modification time.
    writeFile(context.musicRoot, 'two.mp3', buildMp3({ title: 'Two, again', filler: 'bbbbbbbbbbbbbbbb' }));

    const result = await context.service.reconcile();

    assert.strictEqual(result.removed, 0, 'nothing was deleted');
    assert.deepStrictEqual(result.changed, ['two.mp3'], 'one file to look at again');

    // And it is only named, not read: reconciliation reports, the scanner acts.
    assert.strictEqual(context.service.getTracks({}).total, 3, 'the library is untouched until it is rescanned');
});

test('a library with nothing in it is checked instantly', async (t) => {
    const context = buildLibrary({});
    t.after(() => context.cleanup());

    const result = await context.service.reconcile();
    assert.deepStrictEqual(result, { checked: 0, removed: 0, removedTrackIds: [], changed: [] });
});

test('the stats are bounded, so a large library never blocks starting up', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'libraryService.js'), 'utf8');

    assert.match(source, /const RECONCILE_CONCURRENCY = \d+;/);
    assert.match(source, /Array\.from\(\{ length: Math\.min\(concurrency, paths\.length\) \}, worker\)/);
    // And it stands aside periodically, so nothing else waits behind it.
    assert.match(source, /if \(next % 200 === 0\) await new Promise\(\(resolve\) => setImmediate\(resolve\)\);/);
});

// ============================================
// Everything this device knows about
// ============================================

test('every searched folder is checked, and the answer is about the device', async (t) => {
    const first = makeTempDir('spotifie-rec-a-');
    const second = makeTempDir('spotifie-rec-b-');
    const dataDir = makeTempDir('spotifie-rec-device-');

    t.after(() => {
        removeDir(first);
        removeDir(second);
        removeDir(dataDir);
    });

    writeFile(first, 'a.mp3', buildMp3({ title: 'A', filler: 'aa' }));
    writeFile(second, 'b.mp3', buildMp3({ title: 'B', filler: 'bb' }));

    const device = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });
    device.allowScanning();
    device.rememberLocation(first, { label: 'First' });
    device.rememberLocation(second, { label: 'Second' });

    // Index both folders the way a search would.
    for (const location of device.listLocations()) {
        await device.libraryFor(location.path).scan();
    }
    assert.strictEqual(device.getTracks().length, 2);

    fs.unlinkSync(path.join(first, 'a.mp3'));
    const result = await device.reconcile();

    assert.strictEqual(result.checked, 2, 'both folders were checked');
    assert.strictEqual(result.removedTrackIds.length, 1);
    assert.strictEqual(device.getTracks().length, 1, 'and Local Music is what is left');
});

// ============================================
// What somebody arranged is not the disk's to change
// ============================================

test('a deleted file leaves Local Music and stays in the playlist that named it', async (t) => {
    const context = buildLibrary({
        build: (root) => writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }))
    });
    const stateDir = makeTempDir('spotifie-rec-state-');
    t.after(() => {
        context.cleanup();
        removeDir(stateDir);
    });

    await context.service.scan();
    const track = context.service.getTracks({}).items[0];
    const trackId = 'local:' + track.id;

    const store = new UserStateStore({ rootDir: path.join(stateDir, 'users') });
    const listener = 'listener-0001';
    store.like(listener, trackId);
    const playlist = store.createPlaylist(listener, { title: 'Kept' });
    store.addPlaylistTrack(listener, playlist.id, trackId);

    fs.unlinkSync(path.join(context.musicRoot, 'one.mp3'));
    await context.service.reconcile();

    // The source library says what is on the machine.
    assert.strictEqual(context.service.getTracks({}).total, 0, 'Local Music holds only what is here');

    // What somebody arranged is still theirs. A file disappearing is not their
    // decision to change it, and the id is a fingerprint of the contents - so
    // the same music turning up again reconnects by itself.
    const after = store.read(listener);
    assert.ok(after.likedTrackIds.includes(trackId), 'still liked');
    assert.deepStrictEqual(after.playlists[0].trackIds, [trackId], 'still in the playlist');
});

test('nothing in reconciliation can reach somebody personal state', () => {
    const service = fs.readFileSync(path.join(ROOT, 'lib', 'libraryService.js'), 'utf8');
    const section = service.slice(service.indexOf('async reconcile(options)'), service.indexOf('countMissingFiles()'));

    assert.ok(!/userState|playlist|liked|likedTrackIds/i.test(section), 'it only knows about files and tracks');
});

// ============================================
// Local Music is this machine, not its contents
// ============================================

test('Local Music is there when this machine is searched, whatever it holds', async (t) => {
    const musicRoot = makeTempDir('spotifie-empty-music-');
    const dataDir = makeTempDir('spotifie-empty-data-');
    t.after(() => {
        removeDir(musicRoot);
        removeDir(dataDir);
    });

    const { CatalogService } = require('../lib/catalogService');
    const { GlobalCatalog } = require('../lib/globalCatalog');

    const library = new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    const device = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });
    const service = new CatalogService({
        library: library,
        global: new GlobalCatalog({
            rest: {
                selectRows: async () => [],
                createSignedUrl: async () => null,
                insertRow: async () => [],
                updateRows: async () => [],
                deleteRows: async () => [],
                removeStorageObject: async () => ({})
            }
        }),
        userState: new UserStateStore({ rootDir: path.join(dataDir, 'users') }),
        deviceLibrary: device
    });

    // Never asked, nothing found: there is no collection for a machine
    // Spotifie has not been allowed to look at.
    const before = service.getLocalCatalog({ userId: null });
    assert.strictEqual(
        before.albums.filter((album) => album.id === 'system:local-music').length,
        0,
        'no permission, no collection'
    );

    // Allowed, and still nothing found - the search has not run, or the
    // machine genuinely holds no music. The collection exists either way.
    device.allowScanning();

    const after = service.getLocalCatalog({ userId: null });
    const collection = after.albums.filter((album) => album.id === 'system:local-music')[0];

    assert.ok(collection, 'allowed means the collection is there');
    assert.strictEqual(collection.trackCount, 0, 'holding nothing');
    assert.strictEqual(collection.title, 'Local Music');
    assert.strictEqual(collection.system, true, 'and it is a system collection, not an album');

    // The merged catalogue says the same, so the card is on the page whether
    // the page draws from the local half or from the whole thing.
    const merged = await service.getAlbums({ userId: null });
    assert.ok(
        merged.items.some((album) => album.id === 'system:local-music'),
        'and it survives the merge'
    );
});

test('the collection keeps its place when every file has gone', async (t) => {
    const musicRoot = makeTempDir('spotifie-vanish-music-');
    const dataDir = makeTempDir('spotifie-vanish-data-');
    t.after(() => {
        removeDir(musicRoot);
        removeDir(dataDir);
    });

    writeFile(musicRoot, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }));

    const device = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });
    device.allowScanning();
    device.rememberLocation(musicRoot, { label: 'Music' });
    await device.libraryFor(musicRoot).scan();

    assert.strictEqual(device.getTracks().length, 1);

    // The one file goes, and reconciliation takes it out of the index.
    fs.unlinkSync(path.join(musicRoot, 'one.mp3'));
    await device.reconcile();

    assert.strictEqual(device.getTracks().length, 0, 'nothing left on the machine');
    assert.strictEqual(device.isAllowed(), true, 'but it is still a machine Spotifie searches');
});

test('the collection has one permanent id and is never made up afresh', () => {
    const service = fs.readFileSync(path.join(ROOT, 'lib', 'catalogService.js'), 'utf8');

    // One constant, used everywhere.
    assert.match(service, /const LOCAL_MUSIC_ALBUM_ID = 'system:local-music';/);
    assert.match(service, /id: LOCAL_MUSIC_ALBUM_ID,/);
    assert.ok(!/'system:local-music-' \+|localMusicId\(\)|Math\.random/.test(service), 'no id is invented per request');

    // Existence follows whether this machine is searched, never a count.
    assert.match(service, /const searchesThisDevice = this\.searchesThisDevice\(\) \|\| onThisDevice\.length > 0;/);
    assert.ok(
        !/onThisDevice\.length \? localMusicAlbum/.test(service),
        'a count no longer decides whether the collection exists'
    );

    // And nothing empty is filtered away underneath it.
    assert.match(service, /album\.system \|\| visibleLocalAlbumIds\.has\(album\.id\)/);
    assert.match(service, /album\.system \|\| albumIds\.has\(album\.id\)/);
});

test('the library grid is swapped in one go, never emptied and refilled', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const start = player.indexOf('async function refreshAlbumCards()');
    const section = player.slice(start, player.indexOf('\nasync function ', start + 1));

    // Built away from the page, then put in place at once: a background
    // refresh must not leave a frame with an empty library in it.
    assert.match(section, /const grid = document\.createDocumentFragment\(\);/);
    assert.match(section, /cardsArea\.replaceChildren\(grid\);/);
    assert.ok(!/cardsArea\.innerHTML = ''/.test(section), 'the grid is never blanked first');

    // Local Music leads the library, whoever is using it and whatever is
    // pinned.
    assert.match(player, /if \(info\.isSystemCollection\) return 0;/);
});

test('a machine holding no music says so, and is not called an empty album', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    assert.match(player, /emptyLibraryCard\('No local songs found', 'Music on this device will appear here'\)/);

    // It is a state, not a fault: nothing about it is an error.
    const section = player.slice(
        player.indexOf("emptyLibraryCard('No local songs found'"),
        player.indexOf("emptyLibraryCard('No local songs found'") + 400
    );
    assert.ok(!/error|failed|problem/i.test(section), 'nothing is reported as wrong');
});

test('the same Local Music is answered to a guest, a listener and an administrator', async (t) => {
    const musicRoot = makeTempDir('spotifie-role-music-');
    const dataDir = makeTempDir('spotifie-role-data-');
    t.after(() => {
        removeDir(musicRoot);
        removeDir(dataDir);
    });

    const { CatalogService } = require('../lib/catalogService');
    const { GlobalCatalog } = require('../lib/globalCatalog');

    writeFile(musicRoot, 'one.mp3', buildMp3({ title: 'One', filler: 'aa' }));

    const device = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });
    device.allowScanning();
    device.rememberLocation(musicRoot, { label: 'Music' });
    await device.libraryFor(musicRoot).scan();

    const service = new CatalogService({
        library: new LibraryService({
            musicRoot: path.join(dataDir, 'empty'),
            adapter: new LocalFileSystemAdapter({ musicRoot: path.join(dataDir, 'empty') }),
            index: new LibraryIndex(path.join(dataDir, 'library.json')),
            artworkDir: path.join(dataDir, 'artwork'),
            dataDir: dataDir
        }),
        global: new GlobalCatalog({
            rest: {
                selectRows: async () => [],
                createSignedUrl: async () => null,
                insertRow: async () => [],
                updateRows: async () => [],
                deleteRows: async () => [],
                removeStorageObject: async () => ({})
            }
        }),
        userState: new UserStateStore({ rootDir: path.join(dataDir, 'users') }),
        deviceLibrary: device
    });

    // The music on this machine belongs to the machine. Who is looking at it -
    // nobody, a listener, an administrator - changes nothing about what is
    // there, so all three are answered identically.
    const seen = [];
    for (const who of [null, 'listener-00000001', 'administrator-0001']) {
        const local = service.getLocalCatalog({ userId: who });
        const merged = await service.getAlbums({ userId: who });

        const fromLocal = local.albums.filter((album) => album.id === 'system:local-music')[0];
        const fromMerged = merged.items.filter((album) => album.id === 'system:local-music')[0];

        assert.ok(fromLocal, 'the local half has it for ' + (who || 'a guest'));
        assert.ok(fromMerged, 'and so does the merged catalogue for ' + (who || 'a guest'));
        assert.strictEqual(merged.items[0].id, 'system:local-music', 'and it leads for ' + (who || 'a guest'));

        seen.push(fromMerged.trackCount);
    }

    assert.strictEqual(seen[0], seen[1], 'a listener sees what a guest sees');
    assert.strictEqual(seen[1], seen[2], 'and an administrator sees the same again');
});

test('nothing about Local Music is decided by who is signed in', () => {
    const service = fs.readFileSync(path.join(ROOT, 'lib', 'catalogService.js'), 'utf8');
    const section = service.slice(service.indexOf('readLocal(userId) {'), service.indexOf('readDeviceMusic(sharedTracks)'));

    // The collection is built from the device, and the account only decides
    // which imported music is added to it.
    assert.match(section, /const searchesThisDevice = this\.searchesThisDevice\(\) \|\| onThisDevice\.length > 0;/);
    assert.match(section, /searchesThisDevice\(\) \{[\s\S]{0,200}this\.deviceLibrary\.isAllowed\(\)/);
    assert.ok(!/isAdmin|admin|role/i.test(section), 'no role takes part in it');

    // And each of the three sources is read on its own, so a failure in the
    // account's half cannot answer for the machine's half.
    assert.strictEqual((section.match(/this\.readSafely\(/g) || []).length, 3, 'read apart');

    // And the permission is read from the device, never from an account.
    const device = fs.readFileSync(path.join(ROOT, 'lib', 'deviceLibrary.js'), 'utf8');
    assert.match(device, /isAllowed\(\) \{[\s\S]{0,120}readState\(\)\.permission === 'allowed'/);
    assert.ok(!/userId|uid|profile/i.test(device.slice(device.indexOf('isAllowed()'), device.indexOf('listLocations()'))));
});

test('a library drawn from the copy is never drawn without its local half', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const section = player.slice(
        player.indexOf('async function loadCatalogFromCache()'),
        player.indexOf('function personalStateFrom(local)')
    );

    // The music on this machine could not be read: drawing anyway would put up
    // a library with no Local Music in it, and the check that follows would
    // find the published half unchanged and leave it that way.
    assert.match(section, /if \(!local \|\| !Array\.isArray\(local\.albums\)\) \{/);
    assert.match(section, /return false;/);

    // Both halves are remembered, so the check afterwards can see either move.
    assert.match(section, /renderedCatalogFingerprint = snapshot\.fingerprint;/);
    assert.match(section, /renderedLocalFingerprint = localFingerprint\(local\.albums, local\.tracks\);/);
});

test('the check that follows watches this machine as well as the catalogue', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const section = player.slice(
        player.indexOf('async function revalidateCatalog()'),
        player.indexOf('/** Throw away the copy')
    );

    // A song deleted from the disk moves the local half and leaves the
    // published half exactly as it was. One number cannot answer for both.
    assert.match(section, /const localPrint = localFingerprint\(localAlbums, localTracks\);/);
    assert.match(
        section,
        /if \(fingerprint === renderedCatalogFingerprint && localPrint === renderedLocalFingerprint\)/
    );
    assert.match(section, /renderedLocalFingerprint = localPrint;/);

    // The two are kept apart deliberately.
    assert.match(player, /let renderedLocalFingerprint = null;/);
    assert.match(player, /function localFingerprint\(albums, tracks\)/);
});

// ============================================
// Opening an album
// ============================================

test('the grid is wired once, from the container, so a rerender cannot lose it', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const binding = player.slice(
        player.indexOf('function bindAlbumCardEvents()'),
        player.indexOf('function toggleCardMenu(')
    );

    // Delegated from the container, which outlives every render.
    assert.match(binding, /cardsArea\.addEventListener\('click'/);
    assert.match(binding, /cardsArea\.dataset\.bound = 'yes';/);
    assert.strictEqual((player.match(/cardsArea\.addEventListener\('click'/g) || []).length, 1, 'one listener, one place');

    // Nothing binds per card any more, which is what a rerender used to lose.
    assert.ok(
        !/document\.querySelectorAll\('\.cardcontainer'\)\.forEach\(card => \{\s*\n\s*card\.addEventListener/.test(player),
        'no per-card listeners'
    );
});

test('the controls on a card each do their own thing, and only that', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const binding = player.slice(
        player.indexOf('function bindAlbumCardEvents()'),
        player.indexOf('function toggleCardMenu(')
    );

    // Play plays and does not also open the album.
    assert.match(binding, /if \(event\.target\.closest\('\.play'\)\) \{[\s\S]{0,200}return;/);

    // The three-dot button opens its menu and does not open the album.
    assert.match(binding, /const menuButton = event\.target\.closest\('\.card-menu-btn'\);/);
    assert.match(binding, /toggleCardMenu\(menuButton\);[\s\S]{0,40}return;/);

    // Neither does anything inside an open menu.
    assert.match(binding, /if \(event\.target\.closest\('\.card-menu'\)\) return;/);

    // Everything else on the card opens it.
    assert.match(binding, /await openAlbumDetail\(folder\);/);
});

test('every kind of album reaches the same place by the same id', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const binding = player.slice(
        player.indexOf('function bindAlbumCardEvents()'),
        player.indexOf('function toggleCardMenu(')
    );

    // The id is taken as it was rendered and passed on untouched: no prefix
    // stripped, nothing read as a number. A published album, one somebody
    // made, Local Music and a playlist all travel the same way.
    assert.match(binding, /const folder = card\.dataset\.folder;/);
    assert.match(binding, /if \(!folder\) return;/);
    assert.ok(!/parseInt|parseFloat|Number\(folder\)|folder\.replace|folder\.split/.test(binding));
});

// ============================================
// Noticing while the page is open
// ============================================

test('the watcher is a convenience, and the check at startup is the authority', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    // Run at every start, before the watcher is set up at all.
    assert.match(server, /function reconcileDeviceLibrary\(\)/);
    assert.match(server, /deviceLibrary\s*\n?\s*\.reconcile\(\)/);

    const boot = server.indexOf('reconcileDeviceLibrary();');
    assert.ok(boot !== -1, 'it is called when the server starts');

    const body = server.slice(server.indexOf('function reconcileDeviceLibrary()'), server.indexOf('server.listen(PORT, HOST'));
    const reconciles = body.indexOf('.reconcile()');
    const watches = body.indexOf('new DeviceWatcher(');
    assert.ok(reconciles !== -1 && reconciles < watches, 'the check comes first, the watcher after');

    // Nothing waits for it.
    assert.ok(!/await deviceLibrary\.reconcile/.test(server), 'the page is not held up by it');
});

test('the watcher coalesces a burst and answers it with the same cheap check', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'deviceWatcher.js'), 'utf8');

    // Copying a folder of music is hundreds of events and one answer.
    assert.match(source, /const DEBOUNCE_MS = /);
    assert.match(source, /if \(this\.timer\) clearTimeout\(this\.timer\);/);

    // The event is not trusted to say what happened; the index is checked.
    assert.match(source, /await this\.deviceLibrary\.reconcile\(\)/);
    assert.ok(!/unlink|rename|'add'|'delete'/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'no event kind is acted on directly');

    // Built on what Node already has.
    assert.match(source, /fs\.watch\(/);
    assert.ok(!/require\('chokidar'\)|require\("chokidar"\)/.test(source), 'no heavy dependency');

    // A folder that cannot be watched costs promptness there and nothing else.
    assert.match(source, /catch \(fallbackError\) \{[\s\S]*?return;/);
});

test('a watcher wakes for music and ignores everything else', async (t) => {
    const dataDir = makeTempDir('spotifie-watch-data-');
    const musicRoot = makeTempDir('spotifie-watch-music-');
    t.after(() => {
        removeDir(dataDir);
        removeDir(musicRoot);
    });

    let checks = 0;
    const watcher = new DeviceWatcher({
        deviceLibrary: {
            listLocations: () => [{ path: musicRoot }],
            reconcile: async () => {
                checks += 1;
                return { checked: 0, removed: 0, removedTrackIds: [], changed: [] };
            }
        },
        debounceMs: 20
    });

    t.after(() => watcher.stop());
    watcher.start();

    // A text file near the music is not music.
    watcher.noticed('notes.txt');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(checks, 0, 'nothing to wake up for');

    // A burst of audio changes is one check, not one per file.
    watcher.noticed('a.mp3');
    watcher.noticed('b.flac');
    watcher.noticed('c.m4a');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(checks, 1, 'one answer to the whole burst');
});

// ============================================
// The page is told, quietly
// ============================================

test('the server checks before it searches, and says what it removed', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'lib', 'libraryRoutes.js'), 'utf8');
    const section = routes.slice(routes.indexOf("if (method === 'POST') {", routes.indexOf("segments[0] === 'scan'")));

    // The cheap check runs first, then the search.
    const reconciles = section.indexOf('await deviceLibrary.reconcile()');
    const scans = section.indexOf('scanner.start(');
    assert.ok(reconciles !== -1 && reconciles < scans, 'checked before searched');

    // And the answer says how much went, so the page can redraw.
    assert.match(section, /reconciled: reconciled\s*\n?\s*\?/);
    assert.match(section, /removed: reconciled\.removedTrackIds\.length/);

    // A check that fails is not a request that fails.
    assert.match(section, /catch \(err\) \{[\s\S]*?Could not check the device index/);
});

test('songs disappearing because their files did is not announced', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const section = player.slice(player.indexOf('const result = await client.startDeviceScan('), player.indexOf('function watchDeviceScan'));

    // The library is redrawn without them, and nothing is said.
    assert.match(section, /if \(result\.reconciled && result\.reconciled\.removed > 0\) \{\s*\n\s*await refreshAfterDeviceChange\(\);/);

    const upTo = section.slice(0, section.indexOf('deviceScanSilent'));
    assert.ok(!/showToast/.test(upTo), 'no message about songs that have gone');

    // Redrawing rebuilds the library and the collections, and leaves playback
    // alone.
    const refresh = player.slice(
        player.indexOf('async function refreshAfterDeviceChange()'),
        player.indexOf('async function startDeviceScan(options)')
    );
    assert.match(refresh, /await loadSongsConfig\(\);/);
    assert.match(refresh, /await refreshAlbumCards\(\);/);
    assert.match(refresh, /await refreshPersonalViews\(\);/);
    assert.ok(!/playmusic|currentsong|\.play\(\)|\.pause\(\)/.test(refresh), 'playback is not touched');
});
