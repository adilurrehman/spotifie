'use strict';

/**
 * Songs belonging to albums.
 *
 * A song can be part of an album, or it can be one a listener put there. The
 * two are different things and are removed differently, but from the person's
 * side one action always means one result: the song leaves this album, at
 * once, and stays everywhere else - in the album it came from, in the
 * library, and on disk.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { installFakeIndexedDB } = require('./helpers/fakeIndexedDB');
const { UserStateStore } = require('../lib/userState');
const { CatalogService } = require('../lib/catalogService');
const { GlobalCatalog } = require('../lib/globalCatalog');
const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { UserMediaStore } = require('../lib/userMedia');
const { MediaTickets } = require('../lib/mediaTickets');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const PLAYER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

const ALBUM_A = 'library/local-album:albumA';
const ALBUM_B = 'user_albums/my-mix';
const SONG_X = 'local:' + 'a'.repeat(64);
const SONG_Y = 'local:' + 'b'.repeat(64);

const ALBUM_UUID = '11111111-1111-4111-8111-111111111111';
const TRACK_UUID = '33333333-3333-4333-8333-333333333333';
const USER_A = 'user-alice';
const USER_B = 'user-bobby';

// ============================================
// The album membership a browser keeps
// ============================================

/** A fresh LibraryDB over an empty in-memory database. */
async function freshLibraryDB() {
    installFakeIndexedDB();
    delete require.cache[require.resolve('../js/libraryDB')];
    const LibraryDB = require('../js/libraryDB');
    await LibraryDB.init();
    return LibraryDB;
}

test('a song added from another album appears once and leaves in one action', async () => {
    const LibraryDB = await freshLibraryDB();

    // Album A holds Song X; the listener puts it in Album B as well.
    await LibraryDB.addSongToAlbum(ALBUM_B, ALBUM_A, SONG_X);

    let inB = await LibraryDB.getEffectiveSongsForAlbum(ALBUM_B, []);
    assert.deepStrictEqual(inB.allSongs.map((entry) => entry.track), [SONG_X], 'once in Album B');
    assert.strictEqual(inB.allSongs[0].isUserAdded, true);

    // One removal, and it is gone.
    await LibraryDB.removeSongFromAlbum(ALBUM_B, SONG_X);

    inB = await LibraryDB.getEffectiveSongsForAlbum(ALBUM_B, []);
    assert.deepStrictEqual(inB.allSongs, [], 'gone from Album B after one removal');

    // Album A is untouched: it never held a membership record, and the song is
    // still what that album is made of.
    const inA = await LibraryDB.getEffectiveSongsForAlbum(ALBUM_A, [SONG_X]);
    assert.deepStrictEqual(inA.allSongs.map((entry) => entry.track), [SONG_X], 'still in Album A');
    assert.strictEqual(inA.allSongs[0].isUserAdded, false);
});

test('the same song added twice is one member of the album', async () => {
    const LibraryDB = await freshLibraryDB();

    await LibraryDB.addSongToAlbum(ALBUM_B, ALBUM_A, SONG_X);
    await LibraryDB.addSongToAlbum(ALBUM_B, ALBUM_A, SONG_X);
    // And again from somewhere else, which is still the same song.
    await LibraryDB.addSongToAlbum(ALBUM_B, 'library/local-album:albumC', SONG_X);

    const stored = await LibraryDB.getUserSongsForAlbum(ALBUM_B);
    assert.strictEqual(stored.length, 1, 'one record');

    const inB = await LibraryDB.getEffectiveSongsForAlbum(ALBUM_B, []);
    assert.deepStrictEqual(inB.allSongs.map((entry) => entry.track), [SONG_X]);

    assert.strictEqual(await LibraryDB.isSongInAlbum(ALBUM_B, SONG_X), true);
    assert.strictEqual(await LibraryDB.isSongInAlbum(ALBUM_B, SONG_Y), false);
});

test('records left by older versions are all cleared by one removal', async () => {
    const database = installFakeIndexedDB();
    delete require.cache[require.resolve('../js/libraryDB')];
    const LibraryDB = require('../js/libraryDB');
    await LibraryDB.init();

    // Two records of the same song in the same album, keyed the old way: by
    // the album it came from, so the same song could be recorded twice.
    const store = database.stores.get('userSongs');
    store.records.set(ALBUM_B + '::' + ALBUM_A + '::' + SONG_X, {
        id: ALBUM_B + '::' + ALBUM_A + '::' + SONG_X,
        albumFolder: ALBUM_B,
        sourceFolder: ALBUM_A,
        track: SONG_X
    });
    store.records.set(ALBUM_B + '::library/local-album:albumC::' + SONG_X, {
        id: ALBUM_B + '::library/local-album:albumC::' + SONG_X,
        albumFolder: ALBUM_B,
        sourceFolder: 'library/local-album:albumC',
        track: SONG_X
    });

    // Even with two records, the album shows the song once.
    const before = await LibraryDB.getEffectiveSongsForAlbum(ALBUM_B, []);
    assert.deepStrictEqual(before.allSongs.map((entry) => entry.track), [SONG_X], 'listed once');

    await LibraryDB.removeSongFromAlbum(ALBUM_B, SONG_X);

    assert.strictEqual((await LibraryDB.getUserSongsForAlbum(ALBUM_B)).length, 0, 'both records went');
    const after = await LibraryDB.getEffectiveSongsForAlbum(ALBUM_B, []);
    assert.deepStrictEqual(after.allSongs, [], 'and one removal was enough');
});

test('a song that is part of an album and also added to it is shown once', async () => {
    const LibraryDB = await freshLibraryDB();

    // The catalogue says Song X is part of this album, and a stale addition
    // record says the same thing.
    await LibraryDB.addSongToAlbum(ALBUM_A, ALBUM_A, SONG_X);

    const effective = await LibraryDB.getEffectiveSongsForAlbum(ALBUM_A, [SONG_X, SONG_Y]);
    assert.deepStrictEqual(effective.allSongs.map((entry) => entry.track), [SONG_X, SONG_Y], 'no duplicate row');
});

test('removing a song from one album leaves it in every other album', async () => {
    const LibraryDB = await freshLibraryDB();

    await LibraryDB.addSongToAlbum(ALBUM_B, ALBUM_A, SONG_X);
    await LibraryDB.addSongToAlbum('user_albums/evening', ALBUM_A, SONG_X);

    await LibraryDB.removeSongFromAlbum(ALBUM_B, SONG_X);

    const other = await LibraryDB.getEffectiveSongsForAlbum('user_albums/evening', []);
    assert.deepStrictEqual(other.allSongs.map((entry) => entry.track), [SONG_X], 'the other album keeps it');

    // And hiding it in one album does not hide it in another.
    await LibraryDB.markSongAsRemoved(ALBUM_A, SONG_Y);
    const stillThere = await LibraryDB.getEffectiveSongsForAlbum('user_albums/evening', [SONG_Y]);
    assert.ok(stillThere.allSongs.some((entry) => entry.track === SONG_Y));
});

// ============================================
// The same thing for a published album
// ============================================

function makeFakeRest() {
    const state = {
        albums: [{ id: ALBUM_UUID, title: 'Afterglow', artist: 'Nova Rae', album_artist: 'Nova Rae', artwork_path: null }],
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

    function refuse(op, table) {
        state.writes.push({ op: op, table: table });
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
            return 'https://example.supabase.co/storage/v1/object/sign/' + bucket + '/' + objectPath + '?token=signed';
        }
    };
}

/** An installation with one song of this person's own on the local device. */
function buildContext() {
    const musicRoot = makeTempDir('spotifie-member-music-');
    const dataDir = makeTempDir('spotifie-member-data-');

    writeFile(
        musicRoot,
        path.join('Home Recording', 'Imports', 'night-drive.mp3'),
        buildMp3({ title: 'Night Drive', artist: 'Home Recording', album: 'Imports', filler: 'memberA' })
    );

    const library = new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    const rest = makeFakeRest();
    const userState = new UserStateStore({ rootDir: path.join(dataDir, 'users') });

    const service = new CatalogService({
        library: library,
        global: new GlobalCatalog({ rest: rest }),
        userState: userState,
        userMedia: new UserMediaStore({
            mediaRoot: path.join(dataDir, 'media'),
            stateRoot: path.join(dataDir, 'users')
        }),
        tickets: new MediaTickets({ secret: 'membership-test-secret' })
    });

    return {
        musicRoot: musicRoot,
        dataDir: dataDir,
        library: library,
        rest: rest,
        userState: userState,
        service: service,
        cleanup() {
            removeDir(musicRoot);
            removeDir(dataDir);
        }
    };
}

async function localTrackId(context) {
    await context.library.scan();
    return 'local:' + context.library.getTracks({}).items[0].id;
}

test('a song added to a published album leaves it in one action', async () => {
    const context = buildContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const trackId = await localTrackId(context);
        const ownAlbum = context.library.getTracks({}).items[0].albumId;

        context.service.addTrackToAlbumForUser(USER_A, albumId, trackId);

        let inAlbum = await context.service.getTracks({ userId: USER_A, albumId: albumId });
        assert.deepStrictEqual(inAlbum.items.map((track) => track.id).sort(), ['global:' + TRACK_UUID, trackId].sort());

        const removal = context.service.removeTrackFromAlbumForUser(USER_A, albumId, trackId);
        assert.strictEqual(removal.removed, true);

        inAlbum = await context.service.getTracks({ userId: USER_A, albumId: albumId });
        assert.deepStrictEqual(inAlbum.items.map((track) => track.id), ['global:' + TRACK_UUID], 'gone at once');

        // Still in the album it belongs to, and still in the library.
        const own = await context.service.getTracks({ userId: USER_A, albumId: 'local-album:' + ownAlbum });
        assert.deepStrictEqual(own.items.map((track) => track.id), [trackId], 'its own album keeps it');
        assert.ok(fs.existsSync(path.join(context.musicRoot, 'Home Recording', 'Imports', 'night-drive.mp3')), 'the file is untouched');

        // And nothing was written upstream by any of it.
        assert.deepStrictEqual(context.rest._state.writes, []);
        assert.strictEqual(context.rest._state.tracks.length, 1);
    } finally {
        context.cleanup();
    }
});

test('a song added twice to a published album is one member of it', async () => {
    const context = buildContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const trackId = await localTrackId(context);

        context.service.addTrackToAlbumForUser(USER_A, albumId, trackId);
        const second = context.service.addTrackToAlbumForUser(USER_A, albumId, trackId);
        assert.deepStrictEqual(second, [trackId], 'the list still names it once');

        const inAlbum = await context.service.getTracks({ userId: USER_A, albumId: albumId });
        assert.strictEqual(inAlbum.items.filter((track) => track.id === trackId).length, 1, 'listed once');
    } finally {
        context.cleanup();
    }
});

test('a state file holding the same song twice is cleaned by one removal', async () => {
    const context = buildContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const trackId = await localTrackId(context);

        // As an older version could leave it.
        const stateFile = path.join(context.dataDir, 'users', USER_A, 'state.json');
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(
            stateFile,
            JSON.stringify({
                schemaVersion: 1,
                hiddenGlobalTrackIds: [],
                hiddenGlobalAlbumIds: [],
                hiddenLocalTrackIds: [],
                globalAlbumOverrides: {},
                globalAlbumTrackAdds: { [ALBUM_UUID]: [trackId, trackId, trackId] }
            })
        );

        const inAlbum = await context.service.getTracks({ userId: USER_A, albumId: albumId });
        assert.strictEqual(inAlbum.items.filter((track) => track.id === trackId).length, 1, 'shown once even so');

        const removal = context.service.removeTrackFromAlbumForUser(USER_A, albumId, trackId);
        assert.strictEqual(removal.removed, true);
        assert.deepStrictEqual(removal.tracks, [], 'every copy went');

        const after = await context.service.getTracks({ userId: USER_A, albumId: albumId });
        assert.deepStrictEqual(after.items.map((track) => track.id), ['global:' + TRACK_UUID]);
    } finally {
        context.cleanup();
    }
});

test('a removal stays removed after a restart, and only for that listener', async () => {
    const context = buildContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const trackId = await localTrackId(context);

        context.service.addTrackToAlbumForUser(USER_A, albumId, trackId);
        context.service.addTrackToAlbumForUser(USER_B, albumId, trackId);
        context.service.removeTrackFromAlbumForUser(USER_A, albumId, trackId);

        // A fresh service over the same folders, as after a restart.
        const restarted = new CatalogService({
            library: context.library,
            global: new GlobalCatalog({ rest: context.rest }),
            userState: new UserStateStore({ rootDir: path.join(context.dataDir, 'users') }),
            userMedia: new UserMediaStore({
                mediaRoot: path.join(context.dataDir, 'media'),
                stateRoot: path.join(context.dataDir, 'users')
            }),
            tickets: new MediaTickets({ secret: 'membership-test-secret' })
        });

        const mine = await restarted.getTracks({ userId: USER_A, albumId: albumId });
        assert.deepStrictEqual(mine.items.map((track) => track.id), ['global:' + TRACK_UUID], 'still removed');

        const theirs = await restarted.getTracks({ userId: USER_B, albumId: albumId });
        assert.ok(theirs.items.some((track) => track.id === trackId), 'the other listener still has theirs');
    } finally {
        context.cleanup();
    }
});

test('taking a song out of an album is not hiding it', async () => {
    const context = buildContext();
    try {
        const albumId = 'global-album:' + ALBUM_UUID;
        const trackId = await localTrackId(context);

        context.service.addTrackToAlbumForUser(USER_A, albumId, trackId);
        context.service.removeTrackFromAlbumForUser(USER_A, albumId, trackId);

        const hidden = context.service.getHiddenForUser(USER_A);
        assert.deepStrictEqual(hidden.hiddenLocalTrackIds, [], 'nothing was hidden');
        assert.deepStrictEqual(hidden.hiddenGlobalTrackIds, []);

        const everything = await context.service.getTracks({ userId: USER_A });
        assert.ok(everything.items.some((track) => track.id === trackId), 'the song is still in the library');
    } finally {
        context.cleanup();
    }
});

// ============================================
// How the page decides
// ============================================

test('the page removes by track id and asks membership before hiding', () => {
    const handler = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function handleRemoveFromAlbum(songData)'),
        PLAYER_SOURCE.indexOf('async function refreshAfterAlbumChange(albumFolder)')
    );
    assert.ok(handler.length > 0, 'the handler was found');

    // Membership is settled first, so a song someone added is never hidden
    // instead of being taken out of the album.
    const askedMembership = handler.indexOf('const addedHere');
    const hiding = handler.indexOf("client.hide(track)");
    assert.ok(askedMembership !== -1 && hiding !== -1 && askedMembership < hiding, 'membership is decided first');

    assert.match(handler, /albumTrackAdditions\[albumFolder\] \|\| \[\]\)\.includes\(track\)/);
    assert.match(handler, /LibraryDB\.isSongInAlbum\(albumFolder, track\)/);
    assert.match(handler, /LibraryDB\.removeSongFromAlbum\(albumFolder, track\)/);
    assert.match(handler, /client\.removeTrackFromAlbum\(album\.albumId, track\)/);

    // Songs are matched by id, never by what they are called or where they
    // came from.
    assert.ok(!/fileName|\.title|sourceFolder ===|textContent/.test(handler), 'no name-based or folder-based matching');

    // One action: store, then read the catalogue and redraw once.
    assert.match(
        PLAYER_SOURCE,
        /async function refreshAfterAlbumChange\(albumFolder\) \{\s*await loadSongsConfig\(\);\s*await refreshAlbumCards\(\);\s*await getsongs\(albumFolder\);\s*\}/
    );

    // Adding asks the same question, in one place.
    assert.match(PLAYER_SOURCE, /async function albumHasTrack\(albumFolder, trackId\)/);
    assert.match(PLAYER_SOURCE, /if \(await albumHasTrack\(targetAlbum, trackId\)\) return;/);

    // And the album list is deduplicated by id.
    assert.match(PLAYER_SOURCE, /if \(!predefinedSongs\[folder\]\.includes\(track\.id\)\) predefinedSongs\[folder\]\.push\(track\.id\);/);
});
