'use strict';

/**
 * A personal music library on top of a shared one.
 *
 * Liked songs, playlists and listening history belong to one account and live
 * on this machine, in that account's own file. What these tests hold in place
 * is what makes that true rather than merely intended:
 *
 * - what is written down is references. Ids and an artwork id this machine
 *   serves; never audio, never a picture, never an address that expires;
 * - two people at the same machine share the music and share nothing else. A
 *   guest has none of it and is refused rather than given somebody's;
 * - a collection is resolved against the library every time it is shown, so a
 *   song that has gone is a missing row and not a broken page;
 * - nothing personal goes to Supabase. Not a like, not a playlist, not a play.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { UserStateStore, SCHEMA_VERSION, MAX_RECENT_TRACKS } = require('../lib/userState');
const { LibraryService } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { GlobalCatalog } = require('../lib/globalCatalog');
const { DeviceLibrary } = require('../lib/deviceLibrary');
const { UserArtworkStore } = require('../lib/userArtwork');
const { CatalogService } = require('../lib/catalogService');
const { createCatalogRoutes } = require('../lib/catalogRoutes');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

const ROOT = path.join(__dirname, '..');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
const PERSONAL_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'personalClient.js'), 'utf8');

const ALBUM_UUID = '11111111-1111-4111-8111-111111111111';
const SECOND_ALBUM_UUID = '22222222-2222-4222-8222-222222222222';
const TRACK_UUID = '33333333-3333-4333-8333-333333333333';
const SECOND_TRACK_UUID = '44444444-4444-4444-8444-444444444444';

const GLOBAL_TRACK = 'global:' + TRACK_UUID;
const SECOND_GLOBAL_TRACK = 'global:' + SECOND_TRACK_UUID;

const ALICE = 'alice-00000001';
const BOB = 'bob-000000002';

// ============================================
// A place to keep somebody's own library
// ============================================

function makeStore() {
    const dir = makeTempDir('spotifie-personal-');
    const store = new UserStateStore({ rootDir: path.join(dir, 'users') });
    return { store: store, dir: dir, cleanup: () => removeDir(dir) };
}

function localTrackId(seed) {
    return 'local:' + String(seed).repeat(64).slice(0, 64);
}

test('liking a song writes down the song, and nothing else about it', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const result = context.store.toggleLike(ALICE, GLOBAL_TRACK);
    assert.strictEqual(result.liked, true);
    assert.deepStrictEqual(result.trackIds, [GLOBAL_TRACK]);

    const file = path.join(context.dir, 'users', ALICE, 'state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.strictEqual(saved.schemaVersion, SCHEMA_VERSION);
    assert.deepStrictEqual(saved.likedTrackIds, [GLOBAL_TRACK]);

    // A reference and nothing more: no title, no artist, no picture, no audio.
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(!/base64|data:|blob:/i.test(written), 'nothing is inlined into the file');
    assert.ok(!/supabase\.co|storage\/v1|token=/i.test(written), 'no address that expires is kept');
});

test('a song on this device is liked the same way as a published one', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const local = localTrackId('a');

    assert.strictEqual(context.store.toggleLike(ALICE, local).liked, true);
    assert.strictEqual(context.store.toggleLike(ALICE, GLOBAL_TRACK).liked, true);
    assert.strictEqual(context.store.getLiked(ALICE).length, 2);

    // Newest first, so the most recently liked reads first.
    assert.strictEqual(context.store.getLiked(ALICE)[0], GLOBAL_TRACK);
});

test('unliking takes the song out and leaves the song alone', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    context.store.like(ALICE, GLOBAL_TRACK);
    assert.strictEqual(context.store.isLiked(ALICE, GLOBAL_TRACK), true);

    assert.strictEqual(context.store.toggleLike(ALICE, GLOBAL_TRACK).liked, false);
    assert.strictEqual(context.store.isLiked(ALICE, GLOBAL_TRACK), false);
    assert.deepStrictEqual(context.store.getLiked(ALICE), []);

    // Unliking something that was never liked is nothing to do, not an error.
    assert.deepStrictEqual(context.store.unlike(ALICE, GLOBAL_TRACK), []);
});

test('liking the same song twice is still one like', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    context.store.like(ALICE, GLOBAL_TRACK);
    context.store.like(ALICE, GLOBAL_TRACK);

    assert.deepStrictEqual(context.store.getLiked(ALICE), [GLOBAL_TRACK]);
});

test('liked songs are still there when the file is read again', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    context.store.like(ALICE, GLOBAL_TRACK);
    context.store.like(ALICE, localTrackId('b'));

    // A new store over the same folder is what a refresh looks like.
    const reopened = new UserStateStore({ rootDir: path.join(context.dir, 'users') });
    assert.strictEqual(reopened.getLiked(ALICE).length, 2);
    assert.strictEqual(reopened.isLiked(ALICE, GLOBAL_TRACK), true);
});

test('anything that is not a track id never gets into a collection', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    [
        'C:/Users/me/song.mp3',
        '/etc/passwd',
        'https://example.test/song.mp3',
        'data:audio/mpeg;base64,AAAA',
        'blob:http://localhost/1',
        'album:something',
        ''
    ].forEach((value) => {
        assert.throws(() => context.store.like(ALICE, value), /not a track/, value + ' is refused');
    });
});

// ============================================
// Playlists
// ============================================

test('a playlist is made, renamed, described and deleted', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const playlist = context.store.createPlaylist(ALICE, { title: 'Road trip', description: 'for driving' });
    assert.match(playlist.id, /^playlist:[A-Za-z0-9_-]{8,64}$/);
    assert.strictEqual(playlist.title, 'Road trip');
    assert.strictEqual(playlist.description, 'for driving');
    assert.deepStrictEqual(playlist.trackIds, []);

    const renamed = context.store.updatePlaylist(ALICE, playlist.id, { title: 'Long drive' });
    assert.strictEqual(renamed.title, 'Long drive');
    assert.strictEqual(renamed.description, 'for driving', 'what was not named is left alone');

    const cleared = context.store.updatePlaylist(ALICE, playlist.id, { description: null });
    assert.strictEqual(cleared.description, null, 'and naming it as nothing clears it');

    assert.ok(context.store.deletePlaylist(ALICE, playlist.id));
    assert.deepStrictEqual(context.store.getPlaylists(ALICE), []);
    assert.strictEqual(context.store.deletePlaylist(ALICE, playlist.id), null, 'and again is nothing to do');
});

test('a playlist needs a name', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    assert.throws(() => context.store.createPlaylist(ALICE, { title: '   ' }), /needs a name/);
    assert.throws(() => context.store.createPlaylist(ALICE, {}), /needs a name/);
});

test('songs go into a playlist, come out of it, and move within it', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const first = localTrackId('a');
    const second = localTrackId('b');

    const playlist = context.store.createPlaylist(ALICE, { title: 'Evening' });

    context.store.addPlaylistTrack(ALICE, playlist.id, first);
    context.store.addPlaylistTrack(ALICE, playlist.id, GLOBAL_TRACK);
    const filled = context.store.addPlaylistTrack(ALICE, playlist.id, second);

    assert.deepStrictEqual(filled.trackIds, [first, GLOBAL_TRACK, second]);

    // Somewhere in particular, when somewhere in particular is asked for.
    const inserted = context.store.addPlaylistTrack(ALICE, playlist.id, SECOND_GLOBAL_TRACK, { position: 1 });
    assert.deepStrictEqual(inserted.trackIds, [first, SECOND_GLOBAL_TRACK, GLOBAL_TRACK, second]);

    const moved = context.store.movePlaylistTrack(ALICE, playlist.id, 0, 3);
    assert.deepStrictEqual(moved.trackIds, [SECOND_GLOBAL_TRACK, GLOBAL_TRACK, second, first]);

    const removed = context.store.removePlaylistTrack(ALICE, playlist.id, GLOBAL_TRACK);
    assert.deepStrictEqual(removed.trackIds, [SECOND_GLOBAL_TRACK, second, first]);
});

test('a playlist may name the same song twice, and one of them can be removed', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const track = localTrackId('a');
    const playlist = context.store.createPlaylist(ALICE, { title: 'On repeat' });

    context.store.addPlaylistTrack(ALICE, playlist.id, track);
    context.store.addPlaylistTrack(ALICE, playlist.id, GLOBAL_TRACK);
    const twice = context.store.addPlaylistTrack(ALICE, playlist.id, track);

    // Somebody put it there twice, so it is there twice.
    assert.deepStrictEqual(twice.trackIds, [track, GLOBAL_TRACK, track]);

    // Taking out one entry takes out that entry, not every copy of the song.
    const once = context.store.removePlaylistTrack(ALICE, playlist.id, track, { position: 2 });
    assert.deepStrictEqual(once.trackIds, [track, GLOBAL_TRACK]);

    // Without a position, every copy goes.
    context.store.addPlaylistTrack(ALICE, playlist.id, track);
    const none = context.store.removePlaylistTrack(ALICE, playlist.id, track);
    assert.deepStrictEqual(none.trackIds, [GLOBAL_TRACK]);
});

test('a whole playlist can be rearranged, and only rearranged', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const a = localTrackId('a');
    const b = localTrackId('b');

    const playlist = context.store.createPlaylist(ALICE, { title: 'Order' });
    context.store.addPlaylistTrack(ALICE, playlist.id, a);
    context.store.addPlaylistTrack(ALICE, playlist.id, b);
    context.store.addPlaylistTrack(ALICE, playlist.id, GLOBAL_TRACK);

    const reordered = context.store.reorderPlaylist(ALICE, playlist.id, [GLOBAL_TRACK, a, b]);
    assert.deepStrictEqual(reordered.trackIds, [GLOBAL_TRACK, a, b]);

    // A rearrangement that adds, drops or substitutes anything is not one.
    assert.strictEqual(context.store.reorderPlaylist(ALICE, playlist.id, [GLOBAL_TRACK, a]), null);
    assert.strictEqual(context.store.reorderPlaylist(ALICE, playlist.id, [GLOBAL_TRACK, a, b, b]), null);
    assert.strictEqual(context.store.reorderPlaylist(ALICE, playlist.id, [GLOBAL_TRACK, a, SECOND_GLOBAL_TRACK]), null);

    // And the list is exactly as it was left.
    assert.deepStrictEqual(context.store.getPlaylist(ALICE, playlist.id).trackIds, [GLOBAL_TRACK, a, b]);
});

test('a playlist keeps a cover this machine serves, and refuses anything else', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const playlist = context.store.createPlaylist(ALICE, {
        title: 'With a cover',
        artwork: { type: 'local', reference: 'abc123def456' }
    });
    assert.deepStrictEqual(playlist.artwork, { type: 'local', reference: 'abc123def456' });

    ['https://example.test/cover.jpg', 'data:image/png;base64,iVBORw0KGgo=', 'blob:http://localhost/1'].forEach(
        (reference) => {
            const refused = context.store.updatePlaylist(ALICE, playlist.id, {
                artwork: { type: 'local', reference: reference }
            });
            assert.strictEqual(refused.artwork, null, reference + ' is not a cover this machine holds');
        }
    );
});

// ============================================
// Recently played
// ============================================

test('what was played is noted once per song, newest first', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    const a = localTrackId('a');

    context.store.notePlayed(ALICE, a, '2026-01-01T10:00:00.000Z');
    context.store.notePlayed(ALICE, GLOBAL_TRACK, '2026-01-01T11:00:00.000Z');

    const recent = context.store.getRecentlyPlayed(ALICE);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].id, GLOBAL_TRACK, 'the most recent reads first');

    // Playing something again moves it to the front rather than adding a
    // second line, so a track on repeat does not fill the list with itself.
    context.store.notePlayed(ALICE, a, '2026-01-01T12:00:00.000Z');
    const after = context.store.getRecentlyPlayed(ALICE);
    assert.strictEqual(after.length, 2);
    assert.strictEqual(after[0].id, a);
});

test('the history is bounded, so it stays a way back and not a record', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    for (let i = 0; i < MAX_RECENT_TRACKS + 40; i += 1) {
        const id = 'global:' + String(i).padStart(8, '0') + '-1111-4111-8111-111111111111';
        context.store.notePlayed(ALICE, id, new Date(Date.now() + i * 1000).toISOString());
    }

    assert.strictEqual(context.store.getRecentlyPlayed(ALICE).length, MAX_RECENT_TRACKS);
});

test('the history can be forgotten without losing anything else', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    context.store.like(ALICE, GLOBAL_TRACK);
    const playlist = context.store.createPlaylist(ALICE, { title: 'Kept' });
    context.store.notePlayed(ALICE, GLOBAL_TRACK);

    assert.deepStrictEqual(context.store.clearRecentlyPlayed(ALICE), []);
    assert.deepStrictEqual(context.store.getLiked(ALICE), [GLOBAL_TRACK]);
    assert.strictEqual(context.store.getPlaylist(ALICE, playlist.id).title, 'Kept');
});

// ============================================
// Two people, one machine
// ============================================

test('two accounts on one machine share the music and nothing else', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    context.store.like(ALICE, GLOBAL_TRACK);
    const hers = context.store.createPlaylist(ALICE, { title: "Alice's list" });
    context.store.addPlaylistTrack(ALICE, hers.id, GLOBAL_TRACK);
    context.store.notePlayed(ALICE, GLOBAL_TRACK);

    // Bob has been given none of it.
    assert.deepStrictEqual(context.store.getLiked(BOB), []);
    assert.deepStrictEqual(context.store.getPlaylists(BOB), []);
    assert.deepStrictEqual(context.store.getRecentlyPlayed(BOB), []);
    assert.strictEqual(context.store.isLiked(BOB, GLOBAL_TRACK), false);
    assert.strictEqual(context.store.getPlaylist(BOB, hers.id), null);

    // And what Bob does is his own.
    context.store.like(BOB, SECOND_GLOBAL_TRACK);
    assert.deepStrictEqual(context.store.getLiked(ALICE), [GLOBAL_TRACK]);
    assert.deepStrictEqual(context.store.getLiked(BOB), [SECOND_GLOBAL_TRACK]);

    // Two files, one each.
    assert.ok(fs.existsSync(path.join(context.dir, 'users', ALICE, 'state.json')));
    assert.ok(fs.existsSync(path.join(context.dir, 'users', BOB, 'state.json')));
});

test('bringing hidden content back leaves the rest of a library alone', (t) => {
    const context = makeStore();
    t.after(context.cleanup);

    context.store.like(ALICE, GLOBAL_TRACK);
    const playlist = context.store.createPlaylist(ALICE, { title: 'Kept' });
    context.store.notePlayed(ALICE, GLOBAL_TRACK);
    context.store.hide(ALICE, 'track', SECOND_GLOBAL_TRACK);

    context.store.restoreAll(ALICE);

    assert.deepStrictEqual(context.store.getLiked(ALICE), [GLOBAL_TRACK]);
    assert.strictEqual(context.store.getPlaylist(ALICE, playlist.id).title, 'Kept');
    assert.strictEqual(context.store.getRecentlyPlayed(ALICE).length, 1);
});

// ============================================
// Resolved against the library, every time
// ============================================

function globalFixtures() {
    return {
        albums: [
            {
                id: ALBUM_UUID,
                title: 'Golden Hour',
                artist: 'Nova Rae',
                album_artist: 'Nova Rae',
                artwork_path: 'covers/golden.jpg',
                created_at: '2026-03-01T00:00:00.000Z',
                updated_at: '2026-03-01T00:00:00.000Z'
            },
            {
                id: SECOND_ALBUM_UUID,
                title: 'Quiet Rooms',
                artist: null,
                album_artist: null,
                artwork_path: null,
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z'
            }
        ],
        tracks: [
            {
                id: TRACK_UUID,
                album_id: ALBUM_UUID,
                title: 'First Light',
                artist: 'Nova Rae',
                album_artist: 'Nova Rae',
                duration: 210,
                mime_type: 'audio/mpeg',
                audio_path: 'audio/first.mp3',
                artwork_path: null,
                created_at: '2026-03-01T00:00:00.000Z',
                updated_at: '2026-03-01T00:00:00.000Z'
            },
            {
                id: SECOND_TRACK_UUID,
                album_id: SECOND_ALBUM_UUID,
                title: 'Untitled',
                artist: null,
                album_artist: null,
                duration: 120,
                mime_type: 'audio/mpeg',
                audio_path: 'audio/untitled.mp3',
                artwork_path: null,
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z'
            }
        ]
    };
}

function makeRest(fixtures) {
    const state = Object.assign({ writes: [], signed: 0 }, fixtures);

    return {
        _state: state,
        async selectRows(table) {
            return (table === 'catalog_albums' ? state.albums : state.tracks).slice();
        },
        async insertRow(table, row) {
            state.writes.push({ table: table, row: row });
            return [row];
        },
        async updateRows(table, query, patch) {
            state.writes.push({ table: table, patch: patch });
            return [];
        },
        async deleteRows(table) {
            state.writes.push({ table: table, deleted: true });
            return [];
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

function buildContext(options) {
    const settings = options || {};
    const musicRoot = makeTempDir('spotifie-personal-music-');
    const dataDir = makeTempDir('spotifie-personal-data-');

    if (settings.buildLocal) settings.buildLocal(musicRoot);

    const library = new LibraryService({
        musicRoot: musicRoot,
        adapter: new LocalFileSystemAdapter({ musicRoot: musicRoot }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });

    const rest = makeRest(globalFixtures());
    const userState = new UserStateStore({ rootDir: path.join(dataDir, 'users') });

    const service = new CatalogService({
        library: library,
        global: new GlobalCatalog({ rest: rest }),
        userState: userState,
        deviceLibrary: new DeviceLibrary({ deviceDir: path.join(dataDir, 'device') }),
        userArtwork: new UserArtworkStore({ rootDir: path.join(dataDir, 'user-artwork') })
    });

    return {
        service: service,
        library: library,
        userState: userState,
        rest: rest,
        dataDir: dataDir,
        cleanup() {
            removeDir(musicRoot);
            removeDir(dataDir);
        }
    };
}

function withLocalTrack(root) {
    writeFile(
        root,
        path.join('Rowan Vale', 'Field Notes', 'morning.mp3'),
        buildMp3({ title: 'Morning', artist: 'Rowan Vale', album: 'Field Notes', filler: 'p7one' })
    );
}

test('a collection comes back as the songs it names', async (t) => {
    const context = buildContext({ buildLocal: withLocalTrack });
    t.after(context.cleanup);
    await context.library.scan();

    const local = context.service.readLocal(ALICE).tracks[0];
    assert.ok(local, 'there is a song on this machine');

    context.userState.like(ALICE, local.id);
    context.userState.like(ALICE, GLOBAL_TRACK);

    const collections = await context.service.getPersonalCollections({ userId: ALICE });

    assert.strictEqual(collections.signedIn, true);
    assert.strictEqual(collections.liked.total, 2);
    assert.deepStrictEqual(collections.liked.missing, []);

    // Whole songs, from both halves of the library.
    const sources = collections.liked.items.map((track) => track.source).sort();
    assert.deepStrictEqual(sources, ['global', 'local']);
    assert.ok(collections.liked.items.every((track) => track.title), 'each one has its own title');
});

test('a song that has gone is a missing row, not a broken page', async (t) => {
    const context = buildContext({});
    t.after(context.cleanup);

    const gone = localTrackId('z');
    const playlist = context.userState.createPlaylist(ALICE, { title: 'Old favourites' });
    context.userState.addPlaylistTrack(ALICE, playlist.id, GLOBAL_TRACK);
    context.userState.addPlaylistTrack(ALICE, playlist.id, gone);

    const described = await context.service.getPlaylist(playlist.id, { userId: ALICE });

    // Still two entries: the one that is missing is shown, because it is still
    // in the playlist and its owner may want to take it out.
    assert.strictEqual(described.trackCount, 2);
    assert.strictEqual(described.playableCount, 1, 'and only one of them can be played');
    assert.deepStrictEqual(described.missing, [gone]);

    const missing = described.tracks.find((track) => track.missing);
    assert.strictEqual(missing.id, gone);
    assert.strictEqual(missing.streamUrl, undefined, 'nothing is invented for it to play');

    // And the entry can be taken out.
    const trimmed = context.userState.removePlaylistTrack(ALICE, playlist.id, gone);
    assert.deepStrictEqual(trimmed.trackIds, [GLOBAL_TRACK]);
});

test('a playlist says how many songs it holds and how long they run', async (t) => {
    const context = buildContext({});
    t.after(context.cleanup);

    const playlist = context.userState.createPlaylist(ALICE, { title: 'Two songs' });
    context.userState.addPlaylistTrack(ALICE, playlist.id, GLOBAL_TRACK);
    context.userState.addPlaylistTrack(ALICE, playlist.id, SECOND_GLOBAL_TRACK);

    const described = await context.service.getPlaylist(playlist.id, { userId: ALICE });

    assert.strictEqual(described.trackCount, 2);
    assert.strictEqual(described.duration, 330, '210 and 120 seconds');
    assert.strictEqual(described.source, 'playlist');
    assert.strictEqual(described.artworkUrl, null, 'and no cover until one is chosen');
});

test('a guest is given empty collections, never somebody else s', async (t) => {
    const context = buildContext({});
    t.after(context.cleanup);

    context.userState.like(ALICE, GLOBAL_TRACK);
    context.userState.createPlaylist(ALICE, { title: 'Private' });
    context.userState.notePlayed(ALICE, GLOBAL_TRACK);

    const guest = await context.service.getPersonalCollections({ userId: null });

    assert.strictEqual(guest.signedIn, false);
    assert.strictEqual(guest.liked.total, 0);
    assert.deepStrictEqual(guest.playlists, []);
    assert.strictEqual(guest.recentlyPlayed.total, 0);

    // And nothing of Alice's appears anywhere in the answer.
    assert.ok(!JSON.stringify(guest).includes('Private'));
});

test('a guest cannot make anything personal', (t) => {
    const context = buildContext({});
    t.after(context.cleanup);

    assert.throws(() => context.service.toggleLikeForUser(null, GLOBAL_TRACK), /signed in/);
    assert.throws(() => context.service.createPlaylistForUser(null, { title: 'No' }), /signed in/);
    assert.throws(() => context.service.deletePlaylistForUser(null, 'playlist:abcdefgh'), /signed in/);
    assert.throws(() => context.service.clearRecentlyPlayedForUser(null), /signed in/);

    // Listening is not personal: a guest plays music, and there is simply
    // nowhere of their own to write it down.
    assert.deepStrictEqual(context.service.notePlayedForUser(null, GLOBAL_TRACK), []);
});

// ============================================
// Recently added, and artists
// ============================================

test('the newest music reads first, and nothing is given a date it does not have', async (t) => {
    const context = buildContext({ buildLocal: withLocalTrack });
    t.after(context.cleanup);
    await context.library.scan();

    const recent = await context.service.getRecentlyAdded({ userId: ALICE });

    assert.ok(recent.items.length >= 2, 'there is music with a date');
    for (let i = 1; i < recent.items.length; i += 1) {
        assert.ok(
            Date.parse(recent.items[i - 1].addedAt) >= Date.parse(recent.items[i].addedAt),
            'newest first'
        );
    }

    // The published album from March comes before the one from January.
    const global = recent.items.filter((track) => track.source === 'global');
    assert.strictEqual(global[0].title, 'First Light');

    // A file's date is when the file was written, read from the index. No tag
    // was touched to find it.
    const local = recent.items.filter((track) => track.source === 'local')[0];
    assert.ok(local && local.addedAt, 'a file on this machine has one too');
});

test('artists are the tracks themselves, grouped', async (t) => {
    const context = buildContext({ buildLocal: withLocalTrack });
    t.after(context.cleanup);
    await context.library.scan();

    const artists = await context.service.getArtists({ userId: ALICE });
    const names = artists.items.map((artist) => artist.name);

    assert.ok(names.indexOf('Nova Rae') !== -1, 'a published artist');
    assert.ok(names.indexOf('Rowan Vale') !== -1, 'and one on this machine');

    // A track that says nothing about who it is by belongs to Unknown Artist,
    // which is a real group of real tracks - never an artist invented from an
    // id or a file name.
    assert.ok(names.indexOf('Unknown Artist') !== -1);
    assert.ok(
        !names.some((name) => /^(global|local):/.test(name)),
        'no artist is made out of an id'
    );

    const nova = artists.items.find((artist) => artist.name === 'Nova Rae');
    assert.strictEqual(nova.trackCount, 1);
    assert.ok(nova.albums.length >= 1, 'and the albums they appear on');
    assert.ok(nova.albums.every((album) => album.id && album.title));

    // Naming one brings back that artist alone, with their songs.
    const one = await context.service.getArtists({ userId: ALICE, artistName: 'Nova Rae' });
    assert.strictEqual(one.items.length, 1);
    assert.strictEqual(one.items[0].tracks.length, 1);
});

// ============================================
// Over HTTP
// ============================================

function startRoutes(service, identify) {
    const routes = createCatalogRoutes({ service: service });

    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const query = Object.fromEntries(parsed.searchParams.entries());

        // Who the caller is, decided before the routes see the request, the
        // way the real identification does.
        if (identify) req.headers.authorization = identify;

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

function ask(port, pathname, options) {
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
                res.on('end', () =>
                    resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
                );
            }
        );
        req.on('error', reject);
        req.end(settings.body ? JSON.stringify(settings.body) : undefined);
    });
}

test('a guest is refused every personal write, and told to sign in', async (t) => {
    const context = buildContext({});
    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    const writes = [
        ['POST', '/api/catalog/liked', { id: GLOBAL_TRACK }],
        ['POST', '/api/catalog/playlists', { title: 'No' }],
        ['DELETE', '/api/catalog/playlists/playlist:abcdefghij', null],
        ['PATCH', '/api/catalog/playlists/playlist:abcdefghij', { title: 'No' }],
        ['POST', '/api/catalog/playlists/playlist:abcdefghij/tracks', { id: GLOBAL_TRACK }],
        ['DELETE', '/api/catalog/recent', null]
    ];

    for (const [method, route, body] of writes) {
        const response = await ask(started.port, route, { method: method, body: body });
        assert.strictEqual(response.status, 401, method + ' ' + route + ' needs an account');
    }

    // Reading is allowed and answers with nothing personal.
    const me = JSON.parse((await ask(started.port, '/api/catalog/me')).body);
    assert.strictEqual(me.signedIn, false);
    assert.strictEqual(me.liked.total, 0);
});

test('a personal collection is never kept by any cache', async (t) => {
    const context = buildContext({});
    const started = await startRoutes(context.service);
    t.after(() => {
        started.server.close();
        context.cleanup();
    });

    for (const route of ['/api/catalog/me', '/api/catalog/liked', '/api/catalog/playlists', '/api/catalog/recent']) {
        const response = await new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port: started.port, path: route, method: 'GET' },
                (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.headers));
                }
            );
            req.on('error', reject);
            req.end();
        });

        assert.strictEqual(response['cache-control'], 'no-store', route + ' belongs to one person');
    }
});

// ============================================
// Nothing personal reaches Supabase
// ============================================

test('liking, listing and listening write nothing upstream', async (t) => {
    const context = buildContext({});
    t.after(context.cleanup);

    context.service.toggleLikeForUser(ALICE, GLOBAL_TRACK);
    const playlist = context.service.createPlaylistForUser(ALICE, { title: 'Mine', description: 'private' });
    context.service.addPlaylistTrackForUser(ALICE, playlist.id, GLOBAL_TRACK);
    context.service.notePlayedForUser(ALICE, GLOBAL_TRACK);
    context.service.updatePlaylistForUser(ALICE, playlist.id, { title: 'Still mine' });
    context.service.deletePlaylistForUser(ALICE, playlist.id);

    // Not one write to a Supabase table or bucket.
    assert.deepStrictEqual(context.rest._state.writes, []);

    // And nothing personal is anywhere in what Supabase holds.
    const upstream = JSON.stringify(context.rest._state);
    assert.ok(!upstream.includes('Mine'));
    assert.ok(!upstream.includes('Still mine'));
    assert.ok(!upstream.includes(ALICE));
});

test('the modules that hold personal state cannot reach Supabase at all', () => {
    // The comments in that file discuss Supabase at length, because saying
    // what does not happen is half of what they are for. The code must not
    // touch it, so the comments come out before the code is read.
    const state = fs
        .readFileSync(path.join(ROOT, 'lib', 'userState.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    assert.ok(!/supabase|catalog_albums|catalog_tracks|catalog-audio|catalog-artwork/i.test(state));
    assert.ok(!/require\('\.\/(globalCatalog|supabaseRest)'\)/.test(state), 'and it loads nothing that could');

    // Nor does it hold anything but references.
    assert.ok(!/base64|toDataURL/i.test(state), 'no picture or audio is ever encoded into it');
});

// ============================================
// What the page does with all of this
// ============================================

test('every heart on the page is drawn from one answer', () => {
    // Nothing works out for itself whether a song is liked; each asks, and is
    // redrawn when the answer changes, so two of them cannot disagree.
    assert.match(PLAYER_SOURCE, /function isTrackLiked\(trackId\)/);
    assert.match(PLAYER_SOURCE, /function syncLikeStates\(\)/);
    assert.match(PLAYER_SOURCE, /personal\.onChange\(\(\) => \{\s*\n\s*syncLikeStates\(\);/);

    // The playbar, the expanded player and every row that shows one.
    assert.match(PLAYER_SOURCE, /updateLikeButtonState\(isTrackLiked\(playing\)\)/);
    assert.match(PLAYER_SOURCE, /document\.querySelectorAll\('\[data-like-track\]'\)/);
    assert.match(PLAYER_SOURCE, /row\.dataset\.likeTrack = entry\.track;/);

    // And one path changes it, whichever heart was clicked.
    assert.match(PLAYER_SOURCE, /async function toggleTrackLike\(trackId\)/);
    assert.ok(!/LibraryDB\.toggleLikeSong/.test(PLAYER_SOURCE), 'the browser store no longer decides');
    assert.ok(!/LibraryDB\.isSongLiked/.test(PLAYER_SOURCE), 'nor is it asked');
});

test('signing out empties the library before the next person sees it', () => {
    const handler = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('window.spotifieAuth.onAuthChange'),
        PLAYER_SOURCE.indexOf('// Catalogue state, loaded from the unified catalogue service')
    );

    // Cleared first, then drawn. Two people share this machine, and neither
    // may see the other's liked songs, playlists or history.
    const cleared = handler.indexOf('personal.clear()');
    const loaded = handler.indexOf('personal.load({ force: true })');
    assert.ok(cleared !== -1, 'what was held is thrown away');
    assert.ok(loaded > cleared, 'and only then is the next account read');

    assert.match(PERSONAL_SOURCE, /PersonalClient\.prototype\.clear = function \(\)/);
    assert.match(PERSONAL_SOURCE, /this\.liked = new Set\(\);/);
});

test('a play is written down when a song starts, not while it runs', () => {
    // On 'playing', once per song. Recording that somebody listened to
    // something is one fact, not four a second.
    assert.match(PLAYER_SOURCE, /currentsong\.addEventListener\('playing', \(\) => \{/);
    assert.match(PLAYER_SOURCE, /if \(!track \|\| track === lastNotedPlay\) return;/);
    assert.match(PLAYER_SOURCE, /personal\.notePlayed\(track\)/);

    // And never from the handler that runs continuously.
    const timeupdate = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf("currentsong.addEventListener('timeupdate'"),
        PLAYER_SOURCE.indexOf("currentsong.addEventListener('playing'")
    );
    assert.ok(!/notePlayed/.test(timeupdate), 'not on every tick of the clock');
});

test('searching is a pass over a prepared list, and never a request', () => {
    assert.match(PLAYER_SOURCE, /function ensureSearchIndex\(\)/);
    assert.match(PLAYER_SOURCE, /function normalizeForSearch\(value\)/);
    assert.match(PLAYER_SOURCE, /if \(searchIndex && stamp === searchIndexStamp\) return searchIndex;/);

    const search = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function performSearch(query)'),
        PLAYER_SOURCE.indexOf('function calculateMatchScore')
    );

    assert.ok(!/fetch\(|await .*Client\.|supabase/i.test(search), 'nothing is fetched while somebody types');
    assert.ok(!/LibraryDB\./.test(search), 'and storage is not walked on every keystroke');

    // Songs, albums, playlists and artists all come out of the same pass.
    assert.match(search, /entry\.kind === 'song'/);
    assert.match(search, /entry\.kind === 'artist'/);
    assert.match(PLAYER_SOURCE, /kind: info\.isPlaylist \? 'playlist' : 'album'/);
});

test('a playlist keeps its own order, and an album keeps one of each song', () => {
    // A collection somebody arranged is shown as they arranged it, repeats
    // and all. An album's membership is deduplicated, because an album holds
    // each song once.
    assert.match(PLAYER_SOURCE, /const effectiveSongs = isPersonalFolder\(folder\)/);
    assert.match(PLAYER_SOURCE, /: await LibraryDB\.getEffectiveSongsForAlbum\(folder, serverSongs\)/);

    const db = fs.readFileSync(path.join(ROOT, 'js', 'libraryDB.js'), 'utf8');
    assert.match(db, /One row per track\./, 'the album path still deduplicates');
});

test('a cover is kept as an id this machine serves, and never as a picture', () => {
    assert.match(PLAYER_SOURCE, /function artworkReferenceFrom\(cover\)/);
    assert.match(PLAYER_SOURCE, /\^\\\/api\\\/library\\\/artwork\\\/\(\[A-Za-z0-9_-\]\+\)\$/);

    // Nothing about a playlist is ever encoded into the page or the state.
    assert.ok(!/artworkReference: .*(base64|dataUrl|toDataURL)/i.test(PLAYER_SOURCE));
    assert.ok(!/base64/i.test(PERSONAL_SOURCE), 'and the client encodes nothing either');
});

test('the library has a way into each of its parts', () => {
    assert.match(PLAYER_SOURCE, /const LIBRARY_VIEWS = \['all', 'albums', 'playlists', 'artists', 'liked', 'recent', 'local'\];/);
    assert.match(PLAYER_SOURCE, /async function setLibraryView\(view\)/);
    assert.match(PLAYER_SOURCE, /function belongsToLibraryView\(folder, info\)/);

    // Choosing a view filters the cards that are already there rather than
    // rebuilding the library underneath them.
    assert.match(PLAYER_SOURCE, /Object\.keys\(predefinedSongs\)\.filter\(\(folder\) =>\s*\n\s*belongsToLibraryView/);
});

test('what belongs to an account is removed from the page when they leave', () => {
    assert.match(PLAYER_SOURCE, /function applyPersonalCollections\(\)/);
    assert.match(PLAYER_SOURCE, /\.filter\(isPersonalFolder\)/);
    assert.match(PLAYER_SOURCE, /if \(!personal \|\| !personal\.signedIn\) return;/);
});
