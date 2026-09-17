'use strict';

/**
 * Opening Spotifie without waiting, and using it without a connection.
 *
 * Two promises are held here. The first is that a return visit draws the
 * library from what this device already has rather than from a journey to
 * Supabase - so what somebody sees when they open the app does not depend on
 * how good their network is that morning. The second is that losing the
 * connection loses only what genuinely needs one: the music on the device
 * plays, the library it is in works, the published albums stay on screen from
 * the copy, and the published *audio* says it needs a connection instead of
 * failing at somebody.
 *
 * The copy itself is exercised for real, against a stand-in IndexedDB. What
 * cannot be run - the order the page starts in, and which paths are allowed to
 * reach the network - is read where it is written.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { installFakeIndexedDB } = require('./helpers/fakeIndexedDB');

const ROOT = path.join(__dirname, '..');
const CACHE_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'catalogCache.js'), 'utf8');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

const ALBUM_UUID = '11111111-1111-4111-8111-111111111111';
const TRACK_UUID = '33333333-3333-4333-8333-333333333333';

/** The copy, with a fresh empty store behind it. */
function buildCache() {
    const database = installFakeIndexedDB();

    const sandbox = { console: { warn() {}, error() {}, log() {} }, indexedDB: globalThis.indexedDB };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CACHE_SOURCE, sandbox);

    return { cache: sandbox.spotifieCatalogCache, database: database };
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
            description: 'Published for everyone',
            artworkUrl: '/api/catalog/albums/global-album%3A' + ALBUM_UUID + '/artwork',
            trackCount: 1,
            duration: 210,
            metadata: { hasArtwork: true, artworkVersion: 'v1', artworkPath: 'covers/one.jpg', updatedAt: '2026-01-01' }
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
            album: 'Golden Hour',
            albumId: 'global-album:' + ALBUM_UUID,
            duration: 210,
            metadata: { updatedAt: '2026-01-01' }
        },
        overrides || {}
    );
}

/** One named part of the player, so a rule is read where it is written. */
function section(from, to) {
    const start = PLAYER_SOURCE.indexOf(from);
    const end = PLAYER_SOURCE.indexOf(to);
    assert.ok(start !== -1, 'found: ' + from);
    assert.ok(end > start, 'found after it: ' + to);
    return PLAYER_SOURCE.slice(start, end);
}

// ============================================
// The copy this device keeps
// ============================================

test('a catalogue that arrived is kept, and is there to be drawn next time', async () => {
    const { cache, database } = buildCache();

    await cache.write({ albums: [publishedAlbum()], tracks: [publishedTrack()] });

    const kept = await cache.read();
    assert.ok(kept, 'there is a copy');
    assert.strictEqual(kept.albums.length, 1);
    assert.strictEqual(kept.tracks.length, 1);
    assert.strictEqual(kept.albums[0].title, 'Golden Hour');
    assert.strictEqual(kept.albums[0].description, 'Published for everyone');

    // Enough to draw a card with, and stamped so a later visit can tell in one
    // comparison whether anything moved.
    assert.strictEqual(kept.schemaVersion, cache.SCHEMA_VERSION);
    assert.ok(kept.cachedAt > 0);
    assert.ok(kept.fingerprint);

    // And it really is on the device, not merely in memory.
    assert.ok(storedRecord(database), 'written down');
});

test('a copy written by a version that is gone is dropped, not read', async () => {
    const { cache, database } = buildCache();

    await cache.write({ albums: [publishedAlbum()], tracks: [publishedTrack()] });

    const record = storedRecord(database);
    record.schemaVersion = cache.SCHEMA_VERSION + 7;

    // Not migrated and not guessed at: there is nothing in it that cannot be
    // fetched again, so it is thrown away and the visit loads the usual way.
    assert.strictEqual(await cache.read(), null);
});

test('a copy that does not read back as a catalogue cannot break opening the app', async () => {
    const { cache, database } = buildCache();

    await cache.write({ albums: [publishedAlbum()], tracks: [publishedTrack()] });

    const record = storedRecord(database);
    record.albums = 'not a list';

    assert.strictEqual(await cache.read(), null, 'answered as no copy at all');

    // And the store is left clean, so the next visit is a first visit rather
    // than a broken one.
    assert.strictEqual(await cache.read(), null);
});

test('no audio, and nothing signed, is ever written down', async () => {
    const { cache } = buildCache();

    await cache.write({
        albums: [publishedAlbum({ artworkUrl: 'https://project.supabase.co/storage/v1/object/sign/art.jpg?token=abc' })],
        tracks: [
            publishedTrack({
                streamUrl: 'https://project.supabase.co/storage/v1/object/sign/audio/one.mp3?token=abc',
                artworkUrl: 'https://project.supabase.co/storage/v1/object/sign/art.jpg?token=abc'
            })
        ]
    });

    const kept = await cache.read();
    const written = JSON.stringify(kept);

    // An address that expires, stored, becomes a picture that loads once and
    // is broken ever after - and an audio address is not kept at all.
    assert.strictEqual(kept.albums[0].artworkUrl, null);
    assert.strictEqual(kept.tracks[0].streamUrl, null);
    assert.ok(!/token=|\/object\/sign\//.test(written), 'nothing signed');
    assert.ok(!/\.mp3|\.m4a|\.flac|base64|data:/i.test(written), 'and no audio, of any kind');

    // What is kept instead is where the cover lives, which does not change.
    assert.strictEqual(kept.albums[0].metadata.artworkPath, 'covers/one.jpg');
});

// ============================================
// A refresh that fails changes nothing
// ============================================

test('a refresh that could not be made leaves the copy exactly where it was', async () => {
    const { cache } = buildCache();

    await cache.write({ albums: [publishedAlbum()], tracks: [publishedTrack()] });
    const before = await cache.read();

    // The player's own rule: a catalogue that could not be reached is not a
    // catalogue that is empty, and neither is one whose source said so.
    const refresh = section('async function revalidateCatalog()', '/** Throw away the copy');
    assert.match(refresh, /catch \(error\) \{[\s\S]*?return false;/);
    assert.match(refresh, /sources\.global\.available === false/);
    assert.ok(!/cache\.clear\(\)/.test(refresh), 'an outage never throws the copy away');

    const after = await cache.read();
    assert.deepStrictEqual(after.albums, before.albums, 'still there');
});

test('an empty answer never replaces a copy that has something in it', () => {
    // An empty catalogue is a real state - everything can be withdrawn - but it
    // is also the shape a failed read takes once its error has been swallowed.
    // It is written down only when the read positively said so.
    const remember = section('function rememberPublishedCatalogue(', 'async function loadCatalogFromCache()');

    assert.match(remember, /if \(sources\.global && sources\.global\.available === false\) return;/);
    assert.match(
        remember,
        /if \(!published\.albums\.length && !published\.tracks\.length && !\(sources\.global && sources\.global\.available === true\)\) \{\s*return;/
    );

    // And only the published half is ever kept: this machine's own music is
    // not somebody else's to read off a shared device.
    assert.match(remember, /album\.source === 'global'/);
    assert.match(remember, /track\.source === 'global'/);
});

// ============================================
// Opening the app
// ============================================

test('a returning visitor sees their library before Supabase is asked anything', () => {
    // The copy is drawn first. The catalogue is checked afterwards, and only
    // when there was a copy to draw.
    assert.match(PLAYER_SOURCE, /const drewFromCache = await loadCatalogFromCache\(\);/);
    assert.match(PLAYER_SOURCE, /if \(drewFromCache\) scheduleCatalogRevalidation\(\);/);

    // A visit that drew from the copy does not then wait on the network before
    // the library is on screen.
    assert.match(PLAYER_SOURCE, /if \(!drewFromCache\) \{[\s\S]{0,800}await loadSongsConfig\(\);/);

    const drawn = PLAYER_SOURCE.indexOf('await getAlbums();');
    const gone = PLAYER_SOURCE.indexOf('hideSplash();');
    const checked = PLAYER_SOURCE.indexOf('if (drewFromCache) scheduleCatalogRevalidation();');

    assert.ok(drawn !== -1 && gone > drawn, 'the opening screen goes once the library is up');
    assert.ok(checked > gone, 'and the check happens after that, not before it');
});

test('the half of the library this machine owns never waits on the network', () => {
    const drawing = section('async function loadCatalogFromCache()', 'async function revalidateCatalog()');

    // The copy, and this machine's own music, read side by side. Neither is a
    // journey to Supabase.
    assert.match(drawing, /cache\.read\(\)/);
    assert.match(drawing, /client\.getLocalCatalog\(\)/);
    assert.ok(!/supabase|getAlbums\(\)|getTracks\(\)/i.test(drawing), 'nothing published is fetched to draw the copy');

    // Local Music that could not be read is not drawn around: the ordinary
    // path runs instead, rather than a library quietly missing half of itself.
    assert.match(drawing, /if \(!local \|\| !Array\.isArray\(local\.albums\)\) \{/);

    // Playing a file on this device reaches nothing but this device.
    const playing = section('function resolveLocalStreamUrl(track)', 'let networkAvailable');
    assert.ok(!/fetch\(|supabase|signed|token/i.test(playing), 'no journey anywhere to play a local file');
});

// ============================================
// Without a connection
// ============================================

test('being offline is decided by what requests actually do, not only by the browser', () => {
    // navigator.onLine is true on a network with nothing behind it, true when a
    // name will not resolve, and true when Supabase itself is down.
    const noting = section('function noteNetworkOutcome(reachable)', 'function looksLikeNetworkFailure(error)');
    assert.match(noting, /navigator\.onLine === false/, 'the browser is believed in one direction only');
    assert.match(noting, /if \(networkAvailable === online\) return;/, 'and a state that has not changed says nothing');

    // A failure carrying a status is an answer from a server that was reached.
    // Anything else - refused, unresolved, abandoned for taking too long - is
    // the connection.
    const telling = section('function looksLikeNetworkFailure(error)', '/**\n * Keep the application itself');
    assert.match(telling, /error\.status === undefined \|\| error\.status === null/);

    // The catalogue is the request worth believing: Spotifie actually needed it.
    const refresh = section('async function revalidateCatalog()', '/** Throw away the copy');
    assert.match(refresh, /if \(looksLikeNetworkFailure\(error\)\) noteNetworkOutcome\(false\);/);
    assert.match(refresh, /noteNetworkOutcome\(true\);/);
});

test('a published song is not attempted without a connection, and says why', () => {
    const playing = section('function playGlobalTrack(trackId, pause, isRetry)', 'function playDeviceTrack(');

    // Nothing is attempted: no request that will fail, and no expired address
    // handed to the player to choke on.
    assert.match(playing, /if \(!isOnline\(\)\) \{/);
    assert.match(playing, /showToast\('Connect to the internet to play published songs'\)/);

    // The refusal comes before anything is resolved or played.
    const refused = playing.indexOf('if (!isOnline())');
    const resolved = playing.indexOf('client.resolveStreamUrl');
    assert.ok(refused !== -1 && resolved > refused, 'the check is the first thing that happens');

    // And a resolve that failed because of the connection is not retried into
    // the same failure.
    assert.match(playing, /if \(looksLikeNetworkFailure\(error\)\) \{[\s\S]*?noteNetworkOutcome\(false\);/);

    // A song on this device is not affected by any of this.
    const local = section('function playDeviceTrack(', 'function handleGlobalPlaybackError()');
    assert.ok(!/isOnline\(\)|noteNetworkOutcome/.test(local), 'local playback asks nothing about the internet');
});

test('a published album kept from last time opens, and says its songs need a connection', () => {
    const detail = section('function renderAlbumDetail(folder)', 'async function openAlbumDetail(folder)');

    // The album itself is there - its cover, its words, its rows - because this
    // device wrote them down.
    assert.match(detail, /const needsConnection = info\.source === 'global' && !isOnline\(\);/);

    // One restrained line, in the album, rather than a failure when somebody
    // taps a row. Nothing invented: no fake tracks, and no stale address.
    assert.match(detail, /Connect to the internet to load this album’s songs\./);
    assert.match(detail, /Connect to the internet to play this album/);
    assert.match(detail, /notice\.textContent =/, 'set as text, never as markup');

    // The cards themselves are drawn from the copy, so an unreachable Supabase
    // is not an empty screen.
    const drawing = section('async function loadCatalogFromCache()', 'async function revalidateCatalog()');
    assert.match(drawing, /global: \{ available: null, cached: true/, 'shown as kept, not as known to be there');
});

test('when the connection comes back the catalogue is checked again, without a restart', () => {
    const watching = section('function initOfflineState()', 'async function main()');

    // Nobody has to reopen the app to see what was published while they were
    // away.
    assert.match(watching, /if \(online\) scheduleCatalogRevalidation\(\);/);

    // An album that is already open is drawn again, so the line saying its
    // songs need a connection does not outlive the outage that made it true -
    // sitting there contradicting the music it would now happily play.
    assert.match(watching, /if \(albumDetailFolder\) renderAlbumDetail\(albumDetailFolder\);/);

    // One check at a time, so a connection that comes and goes cannot turn
    // into a loop of them.
    const scheduling = section('function scheduleCatalogRevalidation()', 'async function redrawAfterCatalogChange()');
    assert.match(scheduling, /if \(catalogRevalidation\) return catalogRevalidation;/);

    // Still one message per change of state, and nothing is disabled because
    // the internet went away.
    assert.strictEqual((watching.match(/showToast\(/g) || []).length, 1, 'said once');
    assert.ok(!/disabled = true/.test(watching), 'nothing is turned off');
});

test('nothing published is ever downloaded to be played offline', () => {
    // This phase caches what a library is drawn from, and not one second of
    // audio. The worker keeps the application shell; the copy keeps
    // descriptions; neither keeps a song.
    const worker = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    assert.ok(!/\.mp3|\.m4a|\.flac|\.wav|\/stream/.test(worker), 'the app shell holds no audio');

    const cacheSource = CACHE_SOURCE;
    assert.ok(!/fetch\(/.test(cacheSource), 'the copy downloads nothing at all');
    assert.ok(!/base64|Blob|arrayBuffer/i.test(cacheSource), 'and stores no bytes');

    // No download system was added to the player either.
    assert.ok(!/downloadTrack|offlineDownload|prefetchAudio/.test(PLAYER_SOURCE));
});
