'use strict';

/**
 * Local Music belongs to the machine.
 *
 * Once somebody at this device has agreed to have it searched, the collection
 * exists. Not "exists while a scan is running", not "exists if the index has
 * something in it", and not "exists for the account that happened to allow
 * it": it is a fact about the installation, written down where the
 * installation keeps its facts, and true again the moment Spotifie starts.
 *
 * These tests exist because it kept not being true. The collection would be
 * there, a page would be refreshed, and it would be gone until somebody
 * pressed Rescan - which rebuilt it and hid the real fault, because the fault
 * was never in the searching. It was in everything else being allowed to speak
 * for the machine: an account's imported music failing to list, a state file
 * that would not read, a published catalogue arriving late. Each of those used
 * to take Local Music down with it.
 *
 * So the shape of this file is one question asked many ways: the machine was
 * allowed, and then something unrelated went wrong or arrived late. Is the
 * collection still there?
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { DeviceMusicScanner } = require('../lib/deviceScan');
const { DeviceLibrary } = require('../lib/deviceLibrary');
const { UserMediaStore } = require('../lib/userMedia');
const { MediaTickets } = require('../lib/mediaTickets');
const { UserStateStore } = require('../lib/userState');
const { CatalogService } = require('../lib/catalogService');
const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const ROOT = path.join(__dirname, '..');
const LOCAL_MUSIC = 'system:local-music';
const LISTENER = 'user-listener';
const OTHER = 'user-other';

/** A file big enough for the search to treat it as a song. */
function song(title, filler) {
    const audio = buildMp3({ title: title, artist: 'Home Recording', album: 'Found Music', filler: filler });
    return Buffer.concat([audio, Buffer.alloc(600 * 1024, 0x00)]);
}

/** A published catalogue that answers whatever a test wants it to answer. */
function fakeGlobal(answer) {
    return {
        async fetchCatalog() {
            const result = typeof answer === 'function' ? answer() : answer;
            return result || { available: true, albums: [], tracks: [], error: null };
        }
    };
}

/**
 * One installation, startable as many times as a test likes.
 *
 * The folders stay put between starts; everything that reads them is built
 * again from nothing. That is what a refresh is from the server's side, and
 * what "it came back only after a rescan" was really a complaint about.
 */
function installation(options) {
    const settings = options || {};
    const deviceMusic = makeTempDir('spotifie-lm-device-');
    const sharedRoot = makeTempDir('spotifie-lm-shared-');
    const dataDir = makeTempDir('spotifie-lm-data-');

    let starts = 0;

    function start(overrides) {
        const extra = overrides || {};
        starts += 1;

        const library = new LibraryService({
            musicRoot: sharedRoot,
            adapter: new LocalFileSystemAdapter({ musicRoot: sharedRoot }),
            index: new LibraryIndex(path.join(dataDir, 'library.json')),
            artworkDir: path.join(dataDir, 'artwork'),
            dataDir: dataDir
        });

        const deviceLibrary = new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') });

        const userMedia =
            extra.userMedia ||
            new UserMediaStore({
                mediaRoot: path.join(dataDir, 'media'),
                stateRoot: path.join(dataDir, 'users')
            });

        const scanner = new DeviceMusicScanner({
            deviceLibrary: deviceLibrary,
            // Only the folder this test made, never the real machine.
            locations: { homeDir: null, musicRoot: deviceMusic, mediaRoot: null, extraRoots: [] },
            batchSize: 4
        });

        const service = new CatalogService({
            library: library,
            global: extra.global || settings.global || fakeGlobal(),
            userState: extra.userState || new UserStateStore({ rootDir: path.join(dataDir, 'users') }),
            userMedia: userMedia,
            tickets: extra.tickets || new MediaTickets({ secret: 'local-music-test-secret' }),
            deviceLibrary: deviceLibrary
        });

        return {
            library: library,
            deviceLibrary: deviceLibrary,
            scanner: scanner,
            service: service
        };
    }

    return {
        deviceMusic: deviceMusic,
        sharedRoot: sharedRoot,
        dataDir: dataDir,
        start: start,
        startCount() {
            return starts;
        },
        cleanup() {
            removeDir(deviceMusic);
            removeDir(sharedRoot);
            removeDir(dataDir);
        }
    };
}

async function waitForScan(scanner) {
    const deadline = Date.now() + 20000;
    while (scanner.isRunning()) {
        if (Date.now() > deadline) throw new Error('the scan did not finish');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return scanner.statusFor();
}

/** The collection, out of whichever catalogue was asked for, or null. */
function collectionOf(catalogue) {
    const albums = (catalogue && catalogue.albums) || (catalogue && catalogue.items) || [];
    return albums.filter((album) => album.id === LOCAL_MUSIC)[0] || null;
}

// ============================================
// A. It survives a restart, with no rescan
// ============================================

test('music found once is there on the next start, without searching again', async (t) => {
    const install = installation();
    t.after(() => install.cleanup());

    writeFile(install.deviceMusic, 'one.mp3', song('One', 'lmA1'));
    writeFile(install.deviceMusic, 'two.mp3', song('Two', 'lmA2'));

    const first = install.start();
    first.deviceLibrary.allowScanning();
    first.scanner.start({});
    const finished = await waitForScan(first.scanner);
    assert.strictEqual(finished.tracksFound, 2, 'the search found the two songs');

    // Everything is built again, the way it is when the page is refreshed or
    // Spotifie is started tomorrow. Nothing searches; nothing is asked to.
    const next = install.start();
    assert.strictEqual(next.scanner.isRunning(), false, 'nothing searches on a start');

    const collection = collectionOf(next.service.getLocalCatalog({ userId: null }));
    assert.ok(collection, 'the collection is there before anything is searched');
    assert.strictEqual(collection.trackCount, 2, 'holding what the last search found');

    const merged = collectionOf(await next.service.getAlbums({ userId: null }));
    assert.ok(merged, 'and in the merged catalogue too');
    assert.strictEqual(merged.trackCount, 2);
});

// ============================================
// B. Allowed and empty is still allowed
// ============================================

test('allowed with nothing found is a collection holding nothing', async (t) => {
    const install = installation();
    t.after(() => install.cleanup());

    const before = install.start();
    assert.strictEqual(collectionOf(before.service.getLocalCatalog({ userId: null })), null, 'never asked, no collection');

    before.deviceLibrary.allowScanning();

    const after = install.start();
    const collection = collectionOf(after.service.getLocalCatalog({ userId: null }));

    assert.ok(collection, 'permission alone is enough');
    assert.strictEqual(collection.trackCount, 0, 'and it says so honestly');
    assert.strictEqual(collection.title, 'Local Music');
    assert.strictEqual(collection.system, true, 'a system collection, not an album made from tags');
});

// ============================================
// C, F. The published catalogue arrives later, or not at all
// ============================================

test('the published catalogue arriving afterwards does not displace it', async (t) => {
    const globalAlbum = {
        id: 'global-album:11111111-1111-4111-8111-111111111111',
        source: 'global',
        title: 'Published',
        artist: 'Someone',
        trackCount: 1
    };

    let published = { available: false, albums: [], tracks: [], error: 'unreachable' };
    const install = installation({ global: fakeGlobal(() => published) });
    t.after(() => install.cleanup());

    writeFile(install.deviceMusic, 'found.mp3', song('Found', 'lmC1'));

    const first = install.start();
    first.deviceLibrary.allowScanning();
    first.scanner.start({});
    await waitForScan(first.scanner);

    const app = install.start();

    // Supabase is down, which is not a reason to lose the music on the disk.
    const offline = await app.service.getAlbums({ userId: LISTENER });
    assert.ok(collectionOf(offline), 'unavailable published catalogue, collection still there');

    // And then it answers, with a catalogue of its own.
    published = { available: true, albums: [globalAlbum], tracks: [], error: null };

    const online = await app.service.getAlbums({ userId: LISTENER });
    const collection = collectionOf(online);
    assert.ok(collection, 'the published half is added to the local half, never put in its place');
    assert.strictEqual(collection.trackCount, 1, 'and the local half is unchanged');
    assert.ok(
        online.items.some((album) => album.id === globalAlbum.id),
        'with the published album alongside it'
    );
    assert.strictEqual(online.items[0].id, LOCAL_MUSIC, 'the machine own music is listed first');
});

// ============================================
// D, E. Somebody signs in, or turns out to be an administrator
// ============================================

test('a guest, a listener and an administrator are shown the same collection', async (t) => {
    const install = installation();
    t.after(() => install.cleanup());

    writeFile(install.deviceMusic, 'shared.mp3', song('Shared', 'lmD1'));

    const first = install.start();
    first.deviceLibrary.allowScanning();
    first.scanner.start({});
    await waitForScan(first.scanner);

    const app = install.start();

    // A guest, then the account that signs in a moment later, then the same
    // account carrying a token an administrator would carry. One machine, one
    // answer - whoever is looking, and whatever they are allowed to do.
    const guest = collectionOf(app.service.getLocalCatalog({ userId: null }));
    const listener = collectionOf(app.service.getLocalCatalog({ userId: LISTENER }));
    const admin = collectionOf(await app.service.getAlbums({ userId: LISTENER, token: 'an-admin-token' }));
    const somebodyElse = collectionOf(app.service.getLocalCatalog({ userId: OTHER }));

    for (const [who, collection] of [
        ['guest', guest],
        ['listener', listener],
        ['administrator', admin],
        ['a second account', somebodyElse]
    ]) {
        assert.ok(collection, who + ' sees the collection');
        assert.strictEqual(collection.trackCount, 1, who + ' sees the same song');
    }
});

// ============================================
// The fault itself: an account failing must cost only that account
// ============================================

test('imported music that will not list does not take the machine music with it', async (t) => {
    const install = installation();
    t.after(() => install.cleanup());

    writeFile(install.deviceMusic, 'device.mp3', song('Device', 'lmE1'));

    const first = install.start();
    first.deviceLibrary.allowScanning();
    first.scanner.start({});
    await waitForScan(first.scanner);

    // This is what was happening in the wild: a ticket could not be issued for
    // this account's own imported music, and the whole local half came back
    // empty and unavailable - the machine's music included.
    const app = install.start({
        tickets: {
            issue() {
                throw new Error('tickets unavailable');
            },
            verify() {
                return null;
            }
        },
        userMedia: {
            getTracks() {
                return [{ id: 'abc', title: 'Imported', streamUrl: '/x', artworkUrl: '/y' }];
            },
            getTrack() {
                return null;
            }
        }
    });

    const local = app.service.getLocalCatalog({ userId: LISTENER });
    const collection = collectionOf(local);

    assert.ok(collection, 'the collection is still there');
    assert.strictEqual(collection.trackCount, 1, 'holding the song found on the machine');
    assert.strictEqual(local.sources.local.available, true, 'and the local half is not called unavailable');
});

test('an unreadable account state does not empty the library', async (t) => {
    const install = installation();
    t.after(() => install.cleanup());

    writeFile(install.deviceMusic, 'device.mp3', song('Device', 'lmE2'));

    const first = install.start();
    first.deviceLibrary.allowScanning();
    first.scanner.start({});
    await waitForScan(first.scanner);

    const app = install.start({
        userState: {
            read() {
                throw new Error('state file is not readable');
            }
        }
    });

    const collection = collectionOf(app.service.getLocalCatalog({ userId: LISTENER }));
    assert.ok(collection, 'their likes are missing for the moment; their music is not');
    assert.strictEqual(collection.trackCount, 1);
});

// ============================================
// G. Every file deleted
// ============================================

test('deleting every song leaves the collection holding nothing', async (t) => {
    const install = installation();
    t.after(() => install.cleanup());

    writeFile(install.deviceMusic, 'gone-one.mp3', song('Gone One', 'lmG1'));
    writeFile(install.deviceMusic, 'gone-two.mp3', song('Gone Two', 'lmG2'));

    const first = install.start();
    first.deviceLibrary.allowScanning();
    first.scanner.start({});
    await waitForScan(first.scanner);

    fs.unlinkSync(path.join(install.deviceMusic, 'gone-one.mp3'));
    fs.unlinkSync(path.join(install.deviceMusic, 'gone-two.mp3'));

    const app = install.start();
    const result = await app.deviceLibrary.reconcile();
    assert.strictEqual(result.removed, 2, 'both are taken out of the index');

    const collection = collectionOf(app.service.getLocalCatalog({ userId: LISTENER }));
    assert.ok(collection, 'an empty machine is still a machine Spotifie searches');
    assert.strictEqual(collection.trackCount, 0);
});

// ============================================
// H. Again, and again, and again
// ============================================

test('ten starts in a row, present every time', async (t) => {
    const install = installation();
    t.after(() => install.cleanup());

    writeFile(install.deviceMusic, 'steady.mp3', song('Steady', 'lmH1'));

    const first = install.start();
    first.deviceLibrary.allowScanning();
    first.scanner.start({});
    await waitForScan(first.scanner);

    for (let cycle = 1; cycle <= 10; cycle += 1) {
        const app = install.start();

        // Alternating between a guest and a signed-in listener, because the
        // fault only ever showed itself for one of the two.
        const userId = cycle % 2 === 0 ? LISTENER : null;
        const collection = collectionOf(app.service.getLocalCatalog({ userId: userId }));

        assert.ok(collection, 'start ' + cycle + ': the collection is there');
        assert.strictEqual(collection.trackCount, 1, 'start ' + cycle + ': holding the song');

        const merged = collectionOf(await app.service.getAlbums({ userId: userId }));
        assert.ok(merged, 'start ' + cycle + ': and in the merged catalogue');
    }
});

// ============================================
// The rules the code has to keep
// ============================================

test('existence is decided by the permission, and by nothing else', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'catalogService.js'), 'utf8');
    const readLocal = source.slice(source.indexOf('    readLocal(userId) {'), source.indexOf('    readSafely(what, read) {'));

    // The three sources are read apart, so one failing is one failing.
    assert.strictEqual((readLocal.match(/this\.readSafely\(/g) || []).length, 3, 'each source is read on its own');
    assert.ok(!/try\s*{/.test(readLocal), 'and no single catch stands over all of them');

    // The permission is a device fact, asked of the device.
    assert.match(readLocal, /this\.searchesThisDevice\(\)/);
    assert.ok(!/userId\s*&&|isAdmin|admin/i.test(readLocal), 'who is asking does not come into it');
});

test('the permission is kept with the installation, not with an account', () => {
    // Comments explain where an account's own things are kept; the code below
    // is what must never go near them.
    const device = fs
        .readFileSync(path.join(ROOT, 'lib', 'deviceLibrary.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Written to this device's own state file the moment it is given, so a
    // refresh, a restart or a different account all read the same answer.
    assert.match(device, /allowScanning\(\)\s*{\s*return this\.writeState\(\{ permission: 'allowed' \}\);/);
    assert.match(device, /isAllowed\(\)\s*{\s*return this\.readState\(\)\.permission === 'allowed';/);
    assert.ok(!/userId|uid|session|token/i.test(device), 'it knows nothing about accounts');

    const state = fs.readFileSync(path.join(ROOT, 'lib', 'catalogService.js'), 'utf8');
    assert.ok(
        !/permission[^\n]*userState|userState[^\n]*permission/i.test(state),
        'and the permission is never read out of somebody state'
    );
});

test('the browser adds the published catalogue to the library rather than replacing it', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    // Everything the page draws is arranged in one place, from both halves at
    // once. A second path that built the library from the published half alone
    // is how the collection used to be drawn and then quietly taken away.
    assert.match(player, /function applyCatalogData\(catalogue\)/);

    const local = player.slice(player.indexOf('async function loadCatalogFromCache()'), player.indexOf('function personalStateFrom(local)'));
    assert.match(local, /if \(!local \|\| !Array\.isArray\(local\.albums\)\) \{/, 'a local half that did not arrive is not drawn around');

    // And the check that follows watches both halves, so a library missing its
    // local music cannot be mistaken for one that is up to date.
    const revalidate = player.slice(player.indexOf('async function revalidateCatalog()'), player.indexOf('function forgetPublishedCatalogue()'));
    assert.match(revalidate, /renderedLocalFingerprint/, 'the local half is compared too');
});


// ============================================
// Playing something adds a collection; it replaces none
// ============================================

/**
 * The library is a set of collections, each one known by its own name.
 *
 * Playing a song writes it into Recently Played. That is an addition, and the
 * one thing it must never be is a substitution: for a while, playing a song
 * from Local Music took the Local Music card off the library and left Recently
 * Played standing where it had been. Two collections, one slot.
 *
 * These run the real code that builds the personal collections, against a
 * library that already holds Local Music, and ask the only question that
 * matters afterwards: is it still there, under its own name, with its own
 * contents?
 */

const vm = require('node:vm');

const PLAYER = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

/** One region of the player's source, named by the lines that open and close it. */
function sourceBetween(from, to) {
    const start = PLAYER.indexOf(from);
    const end = PLAYER.indexOf(to);
    assert.ok(start !== -1 && end > start, 'the source region ' + from + ' was found');
    return PLAYER.slice(start, end);
}

/**
 * The part of the player that decides which collections the library holds,
 * running for real, over a library made by hand.
 */
function loadCollectionModel(library) {
    const sandbox = {
        console: console,
        window: { libraryTracks: {} },
        predefinedSongs: library.predefinedSongs,
        albumInfo: library.albumInfo,
        likedSongsAlbumConfig: null,
        LIKED_SONGS_FOLDER: '__liked_songs__',
        LIBRARY_ALBUM_PREFIX: 'library/',
        getPersonal: () => library.personal
    };

    vm.createContext(sandbox);
    vm.runInContext(
        [
            sourceBetween('const RECENTLY_PLAYED_FOLDER', 'function initLibraryManagement()'),
            sourceBetween('function isSystemFolder(folder)', '// ---- Like Button in Playbar ----'),
            sourceBetween('function albumPriority(folder)', 'function libraryFolderForAlbum(albumId)')
        ].join('\n'),
        sandbox
    );

    return sandbox;
}

/** A library holding the music on this machine and a published album. */
function libraryWithLocalMusic(trackCount) {
    const tracks = [];
    for (let index = 0; index < (trackCount === undefined ? 3 : trackCount); index += 1) {
        tracks.push('local:track-' + index);
    }

    return {
        predefinedSongs: {
            'library/system:local-music': tracks,
            'library/global-album:published': ['global:one']
        },
        albumInfo: {
            'library/system:local-music': { title: 'Local Music', isSystemCollection: true },
            'library/global-album:published': { title: 'Published', source: 'global' }
        },
        personal: null
    };
}

/** Somebody's own library, as the page's personal client answers it. */
function personalHolding(recent) {
    return {
        signedIn: true,
        getLiked: () => [],
        getPlaylists: () => [],
        getRecentlyPlayed: () => (recent || []).map((id) => ({ id: id, title: id, missing: false }))
    };
}

// ---- A, B: a local song is played, and played again ----

test('playing local music adds Recently Played and leaves Local Music alone', () => {
    const library = libraryWithLocalMusic();
    const model = loadCollectionModel(library);

    // Nothing played yet: one machine, one published album, no history.
    library.personal = personalHolding([]);
    model.applyPersonalCollections();

    assert.deepStrictEqual(
        Object.keys(library.albumInfo).sort(),
        ['library/global-album:published', 'library/system:local-music'],
        'no history, no Recently Played'
    );

    // One song from Local Music is played.
    library.personal = personalHolding(['local:track-0']);
    model.applyPersonalCollections();

    assert.ok(library.albumInfo['library/system:local-music'], 'Local Music is still there');
    assert.ok(library.albumInfo['system:recently-played'], 'and Recently Played is there too');
    assert.deepStrictEqual(
        library.predefinedSongs['library/system:local-music'],
        ['local:track-0', 'local:track-1', 'local:track-2'],
        'holding what the machine holds'
    );
    assert.deepStrictEqual(library.predefinedSongs['system:recently-played'], ['local:track-0']);

    // And again, with more of them. Recently Played changes; Local Music does
    // not, because nothing about the machine changed.
    library.personal = personalHolding(['local:track-2', 'local:track-1', 'local:track-0']);
    model.applyPersonalCollections();

    assert.ok(library.albumInfo['library/system:local-music'], 'still there after several plays');
    assert.strictEqual(library.predefinedSongs['library/system:local-music'].length, 3);
    assert.strictEqual(library.predefinedSongs['system:recently-played'].length, 3);
});

// ---- C: a published song is played ----

test('playing a published song leaves the music on this machine where it is', () => {
    const library = libraryWithLocalMusic();
    const model = loadCollectionModel(library);

    library.personal = personalHolding(['global:one']);
    model.applyPersonalCollections();

    assert.ok(library.albumInfo['library/system:local-music'], 'Local Music is untouched');
    assert.deepStrictEqual(library.predefinedSongs['system:recently-played'], ['global:one']);
});

// ---- E: nothing on the machine, something in the history ----

test('an empty machine still has its collection, beside Recently Played', () => {
    const library = libraryWithLocalMusic(0);
    const model = loadCollectionModel(library);

    library.personal = personalHolding(['global:one']);
    model.applyPersonalCollections();

    const collection = library.albumInfo['library/system:local-music'];
    assert.ok(collection, 'holding nothing is not the same as being gone');
    assert.deepStrictEqual(library.predefinedSongs['library/system:local-music'], []);
    assert.ok(library.albumInfo['system:recently-played'], 'and the history is its own card');
});

// ---- F: signing out takes the history, never the machine ----

test('signing out takes what belonged to the account and nothing else', () => {
    const library = libraryWithLocalMusic();
    const model = loadCollectionModel(library);

    library.personal = personalHolding(['local:track-0']);
    model.applyPersonalCollections();
    assert.ok(library.albumInfo['system:recently-played']);

    // A guest, or the next person to use this machine.
    library.personal = { signedIn: false };
    model.applyPersonalCollections();

    assert.ok(!library.albumInfo['system:recently-played'], 'their history goes with them');
    assert.ok(library.albumInfo['library/system:local-music'], 'the machine is not theirs to take');
    assert.strictEqual(library.predefinedSongs['library/system:local-music'].length, 3);
});

// ---- the identities themselves ----

test('the two system collections share no name, key or object', () => {
    const library = libraryWithLocalMusic();
    const model = loadCollectionModel(library);

    // Read out of the running code rather than out of the source, so this is
    // the name the page actually uses.
    const recentKey = vm.runInContext('RECENTLY_PLAYED_FOLDER', model);
    assert.strictEqual(recentKey, 'system:recently-played');
    assert.notStrictEqual(recentKey, 'library/system:local-music');

    library.personal = personalHolding(['local:track-0']);
    model.applyPersonalCollections();

    const machine = library.albumInfo['library/system:local-music'];
    const history = library.albumInfo['system:recently-played'];

    assert.notStrictEqual(machine, history, 'two objects, not one shared between them');
    assert.notStrictEqual(
        library.predefinedSongs['library/system:local-music'],
        library.predefinedSongs['system:recently-played'],
        'and two lists'
    );
    assert.strictEqual(machine.title, 'Local Music');
    assert.strictEqual(history.title, 'Recently Played');
    assert.ok(!machine.isRecentlyPlayed, 'neither has turned into the other');
    assert.ok(!history.isSystemCollection);

    // And the machine leads the library, whatever else is in it.
    assert.strictEqual(model.albumPriority('library/system:local-music'), 0);
    assert.ok(model.albumPriority('system:recently-played') > 0);
});

test('a system collection is known by its name, and is nobody album to remove', () => {
    const model = loadCollectionModel(libraryWithLocalMusic());

    assert.strictEqual(model.isSystemFolder('library/system:local-music'), true);
    assert.strictEqual(model.isSystemFolder('system:recently-played'), true);
    assert.strictEqual(model.isSystemFolder('library/global-album:published'), false);
    assert.strictEqual(model.isSystemFolder('user_albums/mine'), false);
    assert.strictEqual(model.isSystemFolder(null), false);

    // The two paths that could take a collection off the library ask first.
    const removing = PLAYER.slice(PLAYER.indexOf('async function deleteAlbum(folder)'), PLAYER.indexOf('function togglePinAlbum(folder)'));
    assert.match(removing, /if \(isSystemFolder\(folder\) \|\| info\.isSystemCollection\) \{/);
    assert.ok(
        removing.indexOf('isSystemFolder') < removing.indexOf('spotify_deleted_albums'),
        'and ask before writing anything down'
    );

    const pinning = PLAYER.slice(PLAYER.indexOf('function togglePinAlbum(folder)'), PLAYER.indexOf('async function openEditAlbumModal(folder)'));
    assert.match(pinning, /if \(isSystemFolder\(folder\) \|\| info\.isSystemCollection\) return;/);
});

test('nothing this browser remembers can take the machine music away', () => {
    // A browser that recorded Local Music as a deleted album kept deleting it
    // on every load afterwards, and no rescan brought it back. The stored list
    // is now read without system collections in it, and written back without
    // them, so an entry made before this cannot outlive one load.
    const loading = PLAYER.slice(PLAYER.indexOf('function loadUserAlbums()'), PLAYER.indexOf('function saveUserAlbums()'));

    assert.match(loading, /const removable = deletedAlbums\.filter\(\(folder\) => !isSystemFolder\(folder\)\);/);
    assert.match(loading, /removable\.forEach\(folder => \{\s*delete predefinedSongs\[folder\];/);
    assert.match(loading, /localStorage\.setItem\('spotify_deleted_albums', JSON\.stringify\(removable\)\);/);
});

test('the library grid is drawn from collection names, never from positions', () => {
    const cards = PLAYER.slice(
        PLAYER.indexOf('async function refreshAlbumCards()'),
        PLAYER.indexOf('function bindAlbumCardEvents()')
    );

    // Each card carries the name of what it is, and the grid's listener reads
    // that name back. Nothing anywhere is addressed by where it happens to sit.
    assert.match(cards, /cardDiv\.dataset\.folder = folder;/);
    assert.ok(!/albums\[0\]\s*=/.test(PLAYER), 'no collection is assigned into a position');
    assert.ok(!/albumInfo\[0\]|predefinedSongs\[0\]/.test(PLAYER), 'and none is read out of one');

    // Coming back from an album re-shows the library; it does not rebuild it
    // out of whatever happens to be playing.
    const back = PLAYER.slice(PLAYER.indexOf('async function navRenderEntry(entry)'), PLAYER.indexOf('async function navForgetAlbum(albumId)'));
    assert.ok(!/currentPlayingAlbum|currentSongsMeta/.test(back), 'playback is not the source of the library');
    assert.ok(!/predefinedSongs\s*=|albumInfo\s*=[^=]/.test(back), 'and nothing is rebuilt on the way back');
});


// ============================================
// The same question, asked by a copy with no server
// ============================================

/**
 * Where the answer lives when there is nothing to keep it.
 *
 * Everything above is about a machine running Spotifie: the server is asked
 * whether this device may be searched, and it remembers. A published copy has
 * no server on its origin, and the question is still worth asking - somebody
 * reading it on the computer their music is on can have all of it, through the
 * helper on that machine.
 *
 * It stopped being asked at all. The copy looked for a helper first, found
 * none, and returned before the question could be put - so the one thing that
 * would have started a helper conversation never appeared.
 *
 * These hold the order right: the device is asked first, the answer is kept
 * for the device rather than for whoever is signed in, and the collection
 * exists from the moment somebody agrees whether or not anything answers.
 */

// The player source is read once, above.

/** The part of the player that deals with the music on this device. */
function deviceSection() {
    return PLAYER.slice(
        PLAYER.indexOf('// ==================== Music on this device'),
        PLAYER.indexOf('function libraryFolderForAlbum')
    );
}

test('the question is put before anything is looked for', () => {
    const startup = PLAYER.slice(
        PLAYER.indexOf('async function initDeviceMusicScan()'),
        PLAYER.indexOf('function initDeviceScanControls()')
    );

    // Asked, and only then looked into. The other way round is the regression:
    // no helper, an early return, and a question nobody ever saw.
    const asked = startup.indexOf("localMusicPermission() !== 'allowed'");
    const looked = startup.indexOf('requestLocalMusic()');

    assert.ok(asked !== -1 && looked !== -1, 'both happen');
    assert.ok(asked < looked, 'the device is asked before a helper is looked for');

    // And it does not wait to find out who is reading. Whether somebody wants
    // their own music looked at is not a question about an account.
    const upToPrompt = startup.slice(0, startup.indexOf("prompt.classList.remove('hidden')"));
    assert.ok(!/spotifieAuth|getSession|signedIn/i.test(upToPrompt), 'nothing about signing in comes first');
});

test('the answer belongs to the device, and every account on it reads the same one', () => {
    const section = deviceSection();

    // One key for the machine. Nothing in it names an account, so a guest, a
    // listener and an administrator at the same computer are answering - and
    // reading - the same question.
    assert.match(section, /const LOCAL_MUSIC_PERMISSION_KEY = 'spotifie_local_music';/);
    assert.ok(!/uid|userId|accountId|session/i.test(section.slice(section.indexOf('const LOCAL_MUSIC_PERMISSION_KEY'), section.indexOf('function ensureLocalMusicCollection'))));

    // A browser that refuses storage asks again rather than assuming an
    // agreement nobody gave.
    assert.match(section, /catch \(e\) \{[\s\S]{0,200}return null;/);
});

test('agreeing makes the collection exist, before anything has been found', () => {
    const allow = PLAYER.slice(
        PLAYER.indexOf("document.getElementById('deviceScanStart')"),
        PLAYER.indexOf("document.getElementById('deviceScanLater')")
    );

    // In this order: remember, show the collection, then go looking. A
    // collection that appeared only once a search succeeded would vanish on
    // every machine with no helper on it.
    const remembered = allow.indexOf('rememberLocalMusicPermission()');
    const created = allow.indexOf('ensureLocalMusicCollection()');
    const looked = allow.indexOf('requestLocalMusic()');

    assert.ok(remembered !== -1 && created !== -1 && looked !== -1);
    assert.ok(remembered < created, 'the answer is kept first');
    assert.ok(created < looked, 'and the collection exists before anything is asked');

    // Nothing answering is one sentence, not a broken application.
    assert.match(allow, /showToast\('Local Music helper is not available on this device'\)/);
    assert.match(allow, /markLocalMusicUnavailable\(\);/);
});

test('a device that agreed keeps its collection through every redraw', () => {
    const apply = PLAYER.slice(
        PLAYER.indexOf('function applyCatalogData(catalogue)'),
        PLAYER.indexOf('let renderedCatalogFingerprint')
    );

    // The library is built again from scratch on every catalogue, including
    // one from a copy with no local half in it. This is what puts the
    // collection back each time.
    assert.match(apply, /if \(localMusicPermission\(\) === 'allowed'\) ensureLocalMusicCollection\(\);/);

    // And it only ever adds: a real Local Music, with songs in it, is left
    // exactly as the catalogue gave it.
    const ensure = PLAYER.slice(
        PLAYER.indexOf('function ensureLocalMusicCollection()'),
        PLAYER.indexOf('async function initDeviceMusicScan()')
    );
    assert.match(ensure, /if \(albumInfo\[LOCAL_MUSIC_FOLDER\]\) return false;/);
    assert.match(ensure, /isSystemCollection: true/, 'and it is the machine own collection, first in the library');
});

test('saying not now is for this visit, and nothing is written down', () => {
    const later = PLAYER.slice(
        PLAYER.indexOf("document.getElementById('deviceScanLater')"),
        PLAYER.indexOf("document.getElementById('scanDeviceLink')")
    );

    assert.match(later, /deviceScanDismissedThisSession = true;/);
    assert.ok(!/localStorage|rememberLocalMusicPermission/.test(later), 'a refusal is not kept');
    assert.ok(!/startDeviceScan|requestLocalMusic/.test(later), 'and nothing is searched or asked');
});
