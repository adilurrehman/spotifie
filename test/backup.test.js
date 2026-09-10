'use strict';

/**
 * Taking a library with you, and being able to open it without the network.
 *
 * Three claims, each checked rather than asserted:
 *
 * - a backup carries references and nothing else. No audio, no pictures,
 *   nothing Base64-encoded, no address that expires, nothing about an account
 *   beyond what that account arranged;
 * - importing one is reading untrusted input. A file that is not a backup, or
 *   is too large, or carries keys that would reach through an object rather
 *   than into it, changes nothing - and a library that fails to import is the
 *   library that was there before;
 * - music on this device plays from this device. Not through Supabase, not
 *   behind an account check, and so not dependent on the internet.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const { LibraryBackup, readBackup, BACKUP_FORMAT, BACKUP_SCHEMA_VERSION } = require('../lib/libraryBackup');
const { UserStateStore } = require('../lib/userState');

const ROOT = path.join(__dirname, '..');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

const GLOBAL_TRACK = 'global:11111111-1111-4111-8111-111111111111';
const SECOND_GLOBAL = 'global:22222222-2222-4222-8222-222222222222';
const LOCAL_TRACK = 'local:' + 'a'.repeat(64);
const SECOND_LOCAL = 'local:' + 'b'.repeat(64);

const OWNER = 'listener-0001';
const OTHER = 'listener-0002';

function buildStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-backup-'));
    const store = new UserStateStore({ rootDir: path.join(dir, 'users') });
    return { dir: dir, store: store, backup: new LibraryBackup({ userState: store }) };
}

function cleanup(context) {
    fs.rmSync(context.dir, { recursive: true, force: true });
}

/** A library with something of everything in it. */
function fillLibrary(store) {
    store.like(OWNER, GLOBAL_TRACK);
    store.like(OWNER, LOCAL_TRACK);

    const playlist = store.createPlaylist(OWNER, { title: 'Road trip', description: 'for driving' });
    store.addPlaylistTrack(OWNER, playlist.id, LOCAL_TRACK);
    store.addPlaylistTrack(OWNER, playlist.id, GLOBAL_TRACK);
    // The same song twice, on purpose.
    store.addPlaylistTrack(OWNER, playlist.id, LOCAL_TRACK);

    store.notePlayed(OWNER, GLOBAL_TRACK);
    store.hide(OWNER, 'track', SECOND_GLOBAL);
    store.setAlbumOverride(OWNER, '33333333-3333-4333-8333-333333333333', { title: 'My name for it' });

    return playlist;
}

// ============================================
// What a backup carries
// ============================================

test('a backup is a document of references, and carries nothing else', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    fillLibrary(context.store);

    const document = context.backup.export(OWNER, {
        tracks: [
            {
                id: LOCAL_TRACK,
                source: 'local',
                title: 'First Light',
                artist: 'Someone',
                album: 'Golden Hour',
                duration: 211,
                metadata: { fileName: 'C:/Users/someone/Music/First Light.mp3', size: 5123456 }
            }
        ]
    });

    assert.strictEqual(document.format, BACKUP_FORMAT);
    assert.strictEqual(document.schemaVersion, BACKUP_SCHEMA_VERSION);
    assert.ok(Date.parse(document.exportedAt) > 0, 'it says when it was taken');

    const written = JSON.stringify(document);

    // None of the things a backup must never be.
    assert.doesNotMatch(written, /base64|data:image|data:audio/i, 'nothing is encoded into it');
    assert.doesNotMatch(written, /blob:/, 'no handle from a previous visit');
    assert.doesNotMatch(written, /token=|X-Amz|Signature|storage\/v1\/object\/sign/i, 'nothing signed');
    assert.doesNotMatch(written, /access_token|refresh_token|password|apikey|service_role/i, 'nothing about an account');

    // And nothing describing the machine it was made on.
    assert.doesNotMatch(written, /C:\/Users|\/home\/|\\\\Users\\\\/, 'no path out of this machine');
    assert.strictEqual(document.trackHints[LOCAL_TRACK].fileName, 'First Light.mp3', 'a name, not a location');

    // What it does carry.
    assert.deepStrictEqual(document.library.likedTrackIds.sort(), [GLOBAL_TRACK, LOCAL_TRACK].sort());
    assert.strictEqual(document.library.playlists.length, 1);
    assert.strictEqual(document.library.playlists[0].trackIds.length, 3, 'a repeated song stays repeated');
    assert.deepStrictEqual(document.library.hiddenGlobalTrackIds, [SECOND_GLOBAL]);
    assert.ok(document.library.globalAlbumOverrides['33333333-3333-4333-8333-333333333333']);
});

test('a backup stays small however much music it names', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    // A thousand liked songs.
    for (let i = 0; i < 1000; i += 1) {
        context.store.like(OWNER, 'local:' + String(i).padStart(64, '0'));
    }

    const size = Buffer.byteLength(JSON.stringify(context.backup.export(OWNER, {})));
    assert.ok(size < 200 * 1024, 'a thousand songs is kilobytes, not megabytes (' + size + ')');
});

test('the albums somebody made travel with it, checked on the way out', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    const document = context.backup.export(OWNER, {
        localAlbums: [
            {
                folder: 'user_albums/late-nights',
                title: 'Late nights',
                artist: 'Various',
                description: 'for the small hours',
                artworkReference: 'abc123',
                trackIds: [LOCAL_TRACK, GLOBAL_TRACK]
            },
            // Not an album key: refused rather than carried.
            { folder: '../../etc/passwd', title: 'Nope' },
            { folder: 'user_albums/no-name' }
        ]
    });

    assert.strictEqual(document.library.localAlbums.length, 1);
    assert.strictEqual(document.library.localAlbums[0].folder, 'user_albums/late-nights');
    assert.strictEqual(document.library.localAlbums[0].artworkReference, 'abc123');
});

// ============================================
// Reading one back
// ============================================

test('a backup restores into a library that had nothing', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    const playlist = fillLibrary(context.store);
    const document = context.backup.export(OWNER, {});

    const result = context.backup.import(OTHER, document, {
        knownTrackIds: new Set([GLOBAL_TRACK, LOCAL_TRACK])
    });

    const restored = context.store.read(OTHER);
    assert.strictEqual(restored.likedTrackIds.length, 2);
    assert.strictEqual(restored.playlists.length, 1);
    assert.strictEqual(restored.playlists[0].title, playlist.title);
    assert.strictEqual(restored.playlists[0].trackIds.length, 3, 'the arrangement is kept exactly');
    assert.deepStrictEqual(restored.hiddenGlobalTrackIds, [SECOND_GLOBAL]);

    assert.strictEqual(result.summary.playlistsRestored, 1);
    assert.strictEqual(result.summary.tracksConnected, 2);
    assert.strictEqual(result.summary.tracksUnavailable, 0);
});

test('restoring the same backup twice changes nothing the second time', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    fillLibrary(context.store);
    const document = context.backup.export(OWNER, {});

    context.backup.import(OTHER, document, {});
    const after = context.store.read(OTHER);

    const second = context.backup.import(OTHER, document, {});
    const again = context.store.read(OTHER);

    assert.strictEqual(second.summary.playlistsRestored, 0, 'no second copy of the playlist');
    assert.strictEqual(second.summary.playlistsAlreadyPresent, 1);
    assert.strictEqual(again.playlists.length, after.playlists.length);
    assert.strictEqual(again.likedTrackIds.length, after.likedTrackIds.length);
});

test('restoring keeps what is already there', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    // Somebody has been using this machine already.
    context.store.like(OTHER, SECOND_LOCAL);
    const mine = context.store.createPlaylist(OTHER, { title: 'Mine' });

    fillLibrary(context.store);
    context.backup.import(OTHER, context.backup.export(OWNER, {}), {});

    const merged = context.store.read(OTHER);
    assert.ok(merged.likedTrackIds.includes(SECOND_LOCAL), 'what was liked before is still liked');
    assert.ok(merged.playlists.some((entry) => entry.id === mine.id), 'the playlist they had is still there');
    assert.strictEqual(merged.playlists.length, 2, 'and the restored one is beside it');
});

test('a library that fails to import is the library that was there before', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    context.store.like(OTHER, SECOND_LOCAL);
    const before = context.store.read(OTHER);

    assert.throws(() => context.backup.import(OTHER, { format: 'something-else' }, {}));
    assert.throws(() => context.backup.import(OTHER, 'not an object', {}));
    assert.throws(() => context.backup.import(OTHER, null, {}));

    const after = context.store.read(OTHER);
    assert.deepStrictEqual(after.likedTrackIds, before.likedTrackIds);
    assert.deepStrictEqual(after.playlists, before.playlists);
});

// ============================================
// A backup is untrusted input
// ============================================

test('a file that is not a backup is refused, with a reason', () => {
    assert.throws(() => readBackup(null), /not a Spotifie backup/);
    assert.throws(() => readBackup([]), /not a Spotifie backup/);
    assert.throws(() => readBackup({ format: 'other' }), /not a Spotifie backup/);
    assert.throws(
        () => readBackup({ format: BACKUP_FORMAT, schemaVersion: 0 }),
        /cannot read/
    );
    assert.throws(
        () => readBackup({ format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION + 5 }),
        /newer version/
    );
});

test('nothing in a backup can reach through an object rather than into it', () => {
    // A parsed document can carry these keys, and assigning one in the
    // ordinary way changes what every object in the process inherits.
    const hostile = JSON.parse(
        JSON.stringify({
            format: BACKUP_FORMAT,
            schemaVersion: 1,
            library: {
                globalAlbumOverrides: { '33333333-3333-4333-8333-333333333333': { title: 'ok' } },
                playlists: []
            }
        }).replace('"library":{', '"library":{"__proto__":{"polluted":true},')
    );

    const result = readBackup(hostile);

    assert.strictEqual({}.polluted, undefined, 'nothing was polluted');
    assert.strictEqual(Object.prototype.polluted, undefined);
    assert.ok(result.library.globalAlbumOverrides['33333333-3333-4333-8333-333333333333'], 'the real content survived');
});

test('a backup cannot smuggle markup, an address or a path into the library', () => {
    const result = readBackup({
        format: BACKUP_FORMAT,
        schemaVersion: 1,
        library: {
            playlists: [
                {
                    id: 'playlist:aaaaaaaaaaaa',
                    title: '<img src=x onerror=alert(1)>',
                    description: '</div><script>alert(1)</script>',
                    artworkReference: 'https://example.test/cover.jpg',
                    trackIds: ['local:' + 'c'.repeat(64), 'not-a-track', 'javascript:alert(1)']
                }
            ],
            localAlbums: [
                { folder: 'user_albums/../../etc', title: 'Escape' },
                { folder: 'user_albums/ok', title: 'Fine', artworkReference: '../../secret' }
            ],
            likedTrackIds: ['local:' + 'd'.repeat(64), { evil: true }, 'global:x']
        },
        trackHints: {
            'local:': { fileName: '../../etc/passwd' },
            ['local:' + 'd'.repeat(64)]: { fileName: '../../etc/passwd', title: '<b>x</b>' }
        }
    });

    const playlist = result.library.playlists[0];
    assert.doesNotMatch(playlist.title, /[<>]/, 'no markup survives a title');
    assert.doesNotMatch(playlist.description, /[<>]/, 'nor a description');
    assert.strictEqual(playlist.artwork, null, 'an address is not an artwork id');
    assert.deepStrictEqual(playlist.trackIds, ['local:' + 'c'.repeat(64)], 'only real track ids');

    assert.strictEqual(result.library.localAlbums.length, 1, 'a folder that climbs out is refused');
    assert.strictEqual(result.library.localAlbums[0].artworkReference, null);

    assert.deepStrictEqual(result.library.likedTrackIds, ['local:' + 'd'.repeat(64)]);

    const hint = result.trackHints['local:' + 'd'.repeat(64)];
    assert.strictEqual(hint.fileName, 'passwd', 'a hint is a name, never a path');
    assert.doesNotMatch(hint.title, /[<>]/);
});

test('a backup naming more than a library could hold is cut to size', () => {
    const many = [];
    for (let i = 0; i < 30000; i += 1) many.push('local:' + String(i).padStart(64, '0'));

    const result = readBackup({
        format: BACKUP_FORMAT,
        schemaVersion: 1,
        library: { likedTrackIds: many }
    });

    assert.ok(result.library.likedTrackIds.length <= 10000, 'bounded (' + result.library.likedTrackIds.length + ')');
});

// ============================================
// Songs that are not here
// ============================================

test('a song this machine does not have is kept, counted, and not invented', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    fillLibrary(context.store);
    const document = context.backup.export(OWNER, {});

    // Only the global track exists on the machine being restored to.
    const result = context.backup.import(OTHER, document, { knownTrackIds: new Set([GLOBAL_TRACK]) });

    assert.strictEqual(result.summary.tracksConnected, 1);
    assert.strictEqual(result.summary.tracksUnavailable, 1);

    // The reference stays: the playlist is still the playlist somebody made.
    const restored = context.store.read(OTHER);
    assert.ok(restored.playlists[0].trackIds.includes(LOCAL_TRACK), 'the missing song keeps its place');
    assert.ok(restored.likedTrackIds.includes(LOCAL_TRACK));

    // Nothing was fabricated to stand in for it.
    assert.strictEqual(
        restored.playlists[0].trackIds.filter((id) => id === LOCAL_TRACK).length,
        2,
        'exactly the entries that were there'
    );
});

test('a song reconnects by itself when the machine has it again', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    fillLibrary(context.store);
    context.backup.import(OTHER, context.backup.export(OWNER, {}), { knownTrackIds: new Set() });

    // Nothing about the stored state changes when the music turns up: the id
    // is the fingerprint of the file's contents, so the same audio anywhere on
    // the machine answers to the same id.
    const stored = context.store.read(OTHER);
    assert.ok(stored.likedTrackIds.includes(LOCAL_TRACK));
    assert.ok(stored.likedTrackIds.includes(GLOBAL_TRACK));
});

test('a cover that is gone leaves the album, and the album shows the default', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    const document = context.backup.export(OWNER, {
        localAlbums: [{ folder: 'user_albums/gone', title: 'Still here', artworkReference: 'missing123' }]
    });

    const result = context.backup.import(OTHER, document, {});
    assert.strictEqual(result.localAlbums.length, 1, 'the album is restored');
    assert.strictEqual(result.localAlbums[0].artworkReference, 'missing123', 'the id is kept, not the picture');

    // Nothing anywhere carries the picture itself.
    assert.doesNotMatch(JSON.stringify(result), /base64|data:image/i);
});

// ============================================
// One library belongs to one account
// ============================================

test('a backup restores into the account that asked for it and no other', (t) => {
    const context = buildStore();
    t.after(() => cleanup(context));

    fillLibrary(context.store);
    context.backup.import(OTHER, context.backup.export(OWNER, {}), {});

    const third = context.store.read('listener-0003');
    assert.deepStrictEqual(third.likedTrackIds, [], 'nobody else inherits it');
    assert.deepStrictEqual(third.playlists, []);
    assert.deepStrictEqual(third.recentlyPlayed, []);
});

test('the export and import routes both require an account', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'lib', 'catalogRoutes.js'), 'utf8');

    const section = routes.slice(routes.indexOf("segments[0] === 'backup'"), routes.indexOf("segments[0] === 'resolve'"));
    assert.match(section, /if \(!context\.userId\) return unauthorized\(res\);/, 'a guest has no library to export');

    // And a backup is read with its own, larger, bound.
    assert.match(section, /readJsonBody\(req, MAX_BACKUP_BYTES\)/);
    assert.match(section, /BODY_TOO_LARGE/);
});

test('nothing personal is ever sent to Supabase', () => {
    const backup = fs.readFileSync(path.join(ROOT, 'lib', 'libraryBackup.js'), 'utf8');

    assert.ok(!/supabase/i.test(backup), 'the backup module knows nothing about Supabase');
    assert.ok(!/globalCatalog|supabaseRest|createSignedUrl|uploadObject/.test(backup), 'and calls nothing upstream');
});

// ============================================
// The opening screen
// ============================================

test('the opening screen is only for a browser that has never had Spotifie', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    // Hidden by default, and shown only when the head script says this browser
    // has nothing set up. A returning visitor's page has no opening screen to
    // paint, so there is no frame in which one could appear.
    assert.match(index, /\.splash \{ display: none; \}/);
    assert.match(index, /:root\[data-first-run="yes"\] \.splash \{/);

    // Decided in the head, before the first paint - not by a script that
    // arrives later and takes it away again.
    const decision = index.indexOf("document.documentElement.setAttribute('data-first-run', 'yes')");
    const markup = index.indexOf('id="appSplash"');
    assert.ok(decision !== -1 && decision < markup, 'decided before the splash is even in the document');

    // A refresh must stay splash-free, so what is looked at is persisted -
    // never a session flag.
    assert.ok(!/sessionStorage/.test(index), 'nothing about this is per-session');
    assert.match(index, /'spotifie_ready'/, 'the marker written after a first successful load');

    // And the ordinary traces of having used Spotifie count too, so somebody
    // upgrading from before that marker existed is not shown it again.
    ['spotify_theme', 'lastFolder', 'spotify_user_albums'].forEach((trace) => {
        assert.ok(index.includes("'" + trace + "'"), trace + ' counts as having been here');
    });

    // Storage that cannot be read is treated as a first run rather than
    // crashing the page.
    assert.match(index, /catch \(e\) \{[\s\S]*?used = false;/);
});

test('a returning visitor waits for nothing, and the marker is written either way', () => {
    // The floor exists so a first run does not flash past. It is not a delay
    // to impose on somebody who has been here before.
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function hideSplash()'),
        PLAYER_SOURCE.indexOf('// Where a track')
    );

    assert.match(section, /rememberFirstRunComplete\(\);/);
    assert.match(section, /if \(!isFirstRun\(\)\) \{[\s\S]*?splash\.hidden = true;[\s\S]*?return Promise\.resolve\(\);/);

    // The marker is written before that decision, so a first run that has just
    // finished is remembered as finished.
    const remembered = section.indexOf('rememberFirstRunComplete()');
    const returning = section.indexOf('if (!isFirstRun())');
    assert.ok(remembered !== -1 && remembered < returning, 'remembered before anything returns');

    // Read from the root element rather than decided a second time, so the
    // script and the stylesheet cannot disagree.
    assert.match(PLAYER_SOURCE, /function isFirstRun\(\) \{[\s\S]*?getAttribute\('data-first-run'\) === 'yes'/);

    // Persisted, so a refresh and a reopened browser both stay splash-free.
    assert.match(PLAYER_SOURCE, /const SPLASH_READY_KEY = 'spotifie_ready';/);
    assert.match(PLAYER_SOURCE, /localStorage\.setItem\(SPLASH_READY_KEY/);
    assert.ok(!/sessionStorage\.setItem\(SPLASH_READY_KEY/.test(PLAYER_SOURCE), 'never a session flag');
});

test('there is exactly one loading bar, and it counts nothing', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const splash = index.slice(index.indexOf('id="appSplash"'), index.indexOf('<div class="container">'));

    // One track, one segment inside it.
    assert.strictEqual((splash.match(/class="splash-progress"/g) || []).length, 1, 'one track');
    assert.strictEqual((splash.match(/class="splash-progress-bar"/g) || []).length, 1, 'one segment');

    // The decorative rules are gone: anything else running horizontally here
    // would read as a second loader.
    assert.ok(!/splash-rule/.test(index), 'no decorative lines anywhere');

    // Nothing counted, nothing spelled out, no dots.
    assert.ok(!/%|Loading|percent/i.test(splash), 'no percentage and no word for it');
    assert.ok(!/splash-dot|\u2022/.test(splash), 'no dots');

    // The branding it sits under is unchanged.
    assert.match(splash, /class="splash-logo"/);
    // Named, but not the page's heading: the heading is the library
    // underneath, which is what this page is.
    assert.match(splash, /<p class="splash-title">Spotifie<\/p>/);
    assert.match(splash, /class="splash-tagline">Music for everyone</);
});

test('the loading bar is a dark track that fills, not a loop', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const styles = index.slice(index.indexOf('.splash-progress {'), index.indexOf('@media (prefers-reduced-motion'));

    // A subtle track, rounded, with the fill clipped inside it.
    assert.match(styles, /background: rgba\(255, 255, 255, 0\.1\)/);
    assert.match(styles, /border-radius: 999px/);
    assert.match(styles, /overflow: hidden/);

    // Comfortable on a desktop, narrower on a phone, never wider than either.
    assert.match(styles, /width: clamp\(140px, 52vw, 200px\)/);

    // Spotifie's green, starting at nothing and widened as work finishes.
    assert.match(styles, /#1db954/);
    assert.match(styles, /width: 0%;/, 'it starts empty');
    assert.match(styles, /transition: width 420ms cubic-bezier/, 'and grows smoothly');

    // Nothing loops: a repeating animation would be a bar pretending to be
    // progress rather than reporting it.
    assert.ok(!/@keyframes splash-progress/.test(index), 'no looping animation');
    assert.ok(!/animation:[^;]*infinite/.test(styles), 'nothing repeats');

    // It reaches the end before the screen goes.
    assert.match(index, /\.splash\.is-leaving \.splash-progress-bar \{[\s\S]*?width: 100%;/);
});

test('the bar is driven by what has actually finished starting up', () => {
    // Real milestones, weighted roughly by what a first run spends its time
    // on. The numbers decide a width and are never shown to anybody.
    assert.match(PLAYER_SOURCE, /const SPLASH_STEPS = \{/);
    ['bootstrap', 'storage', 'catalogue', 'library', 'player', 'content', 'artwork', 'ready'].forEach((step) => {
        assert.ok(PLAYER_SOURCE.includes("splashReached('" + step + "')"), step + ' reports itself');
    });

    // Only ever forwards: a step finishing out of order cannot send it back.
    assert.match(PLAYER_SOURCE, /if \(target === undefined \|\| target <= splashProgress\) return;/);

    // The width is the only thing set. No text, no number, no percentage
    // anywhere on the screen.
    assert.match(PLAYER_SOURCE, /bar\.style\.width = Math\.round\(splashProgress \* 100\) \+ '%';/);
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('const SPLASH_STEPS'),
        PLAYER_SOURCE.indexOf('const SPLASH_MINIMUM_MOBILE_MS')
    );
    assert.ok(!/textContent|innerHTML|aria-valuenow/.test(section), 'nothing is written out as a number');

    // The order the milestones are reached in is the order they happen in.
    const order = ['bootstrap', 'storage', 'catalogue', 'library', 'player', 'content', 'artwork'];
    let previous = -1;
    order.forEach((step) => {
        const at = PLAYER_SOURCE.indexOf("splashReached('" + step + "')", PLAYER_SOURCE.indexOf('async function main()'));
        assert.ok(at > previous, step + ' is reported in order');
        previous = at;
    });

    // Reaching the end is its own moment: the bar completes, then the screen
    // fades.
    assert.match(PLAYER_SOURCE, /const SPLASH_COMPLETE_MS = /);
    const hiding = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function hideSplash()'),
        PLAYER_SOURCE.indexOf('// Where a track')
    );
    const completes = hiding.indexOf("splashReached('ready')");
    const fades = hiding.indexOf("classList.add('is-leaving')");
    assert.ok(completes !== -1 && completes < fades, 'the bar finishes before the fade begins');
});

test('the opening screen is in the page before any script runs', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    // In the document, not built by a script: whatever is still loading, this
    // is already on screen.
    const splash = index.indexOf('id="appSplash"');
    const container = index.indexOf('<div class="container">');
    assert.ok(splash !== -1, 'the splash is in the markup');
    assert.ok(splash < container, 'and before the application it covers');

    // Styled by rules that come with the page, so the first paint is the
    // splash rather than an unstyled player.
    const styles = index.indexOf('.splash {');
    assert.ok(styles !== -1 && styles < splash, 'its rules arrive with it');

    // Spotifie's own identity, and none of anybody else's.
    assert.match(index, /<p class="splash-title">Spotifie<\/p>/);
    assert.match(index, /class="splash-tagline">Music for everyone</);
    assert.ok(!/WMC/i.test(index), 'no borrowed branding');
});

test('the opening screen fits every width and clears the notches', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const styles = index.slice(index.indexOf('.splash {'), index.indexOf('</style>'));

    // Full viewport, and never wider than it.
    assert.match(styles, /position: fixed;\s*\n\s*inset: 0;/);
    assert.match(styles, /max-width: min\(420px, 100%\)/, 'never wider than the screen');
    assert.match(styles, /min-width: 0;/);
    assert.match(styles, /overflow: hidden;/);

    // Under a notch and above a home bar.
    assert.match(styles, /env\(safe-area-inset-top/);
    assert.match(styles, /env\(safe-area-inset-bottom/);
    assert.match(styles, /env\(safe-area-inset-left/);
    assert.match(styles, /env\(safe-area-inset-right/);

    // Sized in proportion rather than at one size, so 320px and a large
    // desktop both read.
    assert.match(styles, /font-size: clamp\(28px, 8vw, 42px\)/, 'the name scales');
    assert.match(styles, /width: clamp\(56px, 16vw, 76px\)/, 'and so does the mark');

    // Dark at startup whatever theme is set.
    assert.match(styles, /background: radial-gradient\([^;]*#0b0b0b/);

    // Asked for less motion, it stops moving.
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('the opening screen waits for the library, never for the network', () => {
    // Two floors: a phone is opened for a moment, a desktop is settled into.
    assert.match(PLAYER_SOURCE, /const SPLASH_MINIMUM_MOBILE_MS = 2000;/);
    assert.match(PLAYER_SOURCE, /const SPLASH_MINIMUM_DESKTOP_MS = 3000;/);
    assert.match(PLAYER_SOURCE, /width < SPLASH_MOBILE_WIDTH \? SPLASH_MINIMUM_MOBILE_MS : SPLASH_MINIMUM_DESKTOP_MS/);

    // Measured from when the page opened, not from when this line ran.
    assert.match(PLAYER_SOURCE, /const splashStartedAt = Date\.now\(\);/);
    assert.match(PLAYER_SOURCE, /Math\.max\(0, splashMinimumMs\(\) - \(Date\.now\(\) - splashStartedAt\)\)/);

    // It goes when the library is drawn - before the device search, and before
    // the catalogue is checked.
    const drawn = PLAYER_SOURCE.indexOf('await getAlbums();');
    const hidden = PLAYER_SOURCE.indexOf('hideSplash();');
    const scan = PLAYER_SOURCE.indexOf('await initDeviceMusicScan();');

    assert.ok(drawn !== -1 && hidden > drawn, 'the library is up first');
    assert.ok(hidden < scan, 'and nobody waits for the device search');

    // Nothing about it waits on the published catalogue.
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function hideSplash()'),
        PLAYER_SOURCE.indexOf('// Where a track')
    );
    assert.ok(!/supabase|revalidate|getAlbums|fetch\(/i.test(section), 'it waits on nothing remote');

    // Removed from the page, not merely made transparent.
    assert.match(section, /splash\.hidden = true;/);
    // Shown once per launch: nothing brings it back.
    assert.strictEqual((PLAYER_SOURCE.match(/splash\.classList\.remove\('is-leaving'\)/g) || []).length, 0);
});

// ============================================
// Music on this device, without the internet
// ============================================

test('a song on this device is played from this device', () => {
    // One seam, named once. The player asks for audio and is given audio; what
    // reads the file is replaceable without the player knowing.
    assert.match(PLAYER_SOURCE, /function resolveLocalStreamUrl\(track\)/);
    assert.match(PLAYER_SOURCE, /window\.spotifieMediaAdapter/);
    assert.match(PLAYER_SOURCE, /const local = resolveLocalStreamUrl\(track\);/);

    // A file the browser has to open first arrives a moment later than an
    // address a server already knows. Both go through the same seam, and the
    // one that takes a moment is only used if it is still the song somebody
    // asked for.
    assert.match(PLAYER_SOURCE, /if \(local && typeof local\.then === 'function'\)/);
    assert.match(PLAYER_SOURCE, /window\.currentPlayingTrack !== trackId\) return;/);

    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function resolveLocalStreamUrl(track)'),
        PLAYER_SOURCE.indexOf('let networkAvailable')
    );

    // Nothing remote takes part in playing a local file.
    assert.ok(!/supabase|signed|token|fetch\(/i.test(section), 'no journey anywhere to play a local file');
});

test('a local track resolves to this origin and never to storage', () => {
    const sandbox = {
        window: { spotifieMediaAdapter: null },
        console: { warn() {}, log() {}, error() {} }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    const start = PLAYER_SOURCE.indexOf('function getMediaAdapter()');
    const end = PLAYER_SOURCE.indexOf('// ============================================\n// Being offline');
    vm.runInContext(PLAYER_SOURCE.slice(start, end), sandbox);

    const url = sandbox.resolveLocalStreamUrl({
        id: LOCAL_TRACK,
        source: 'local',
        streamUrl: '/api/library/tracks/abc/stream'
    });

    assert.strictEqual(url, '/api/library/tracks/abc/stream');
    assert.ok(url.startsWith('/api/library/'), 'this machine answers for it');

    // A packaged build can answer instead, and the player does not change.
    sandbox.window.spotifieMediaAdapter = {
        resolveStreamUrl: (track) => 'spotifie-media://' + track.id
    };
    assert.strictEqual(sandbox.resolveLocalStreamUrl({ id: LOCAL_TRACK }), 'spotifie-media://' + LOCAL_TRACK);
});

test('losing the connection is said once, and disables nothing', () => {
    assert.match(PLAYER_SOURCE, /function initOfflineState\(\)/);
    assert.match(PLAYER_SOURCE, /window\.addEventListener\('online'/);
    assert.match(PLAYER_SOURCE, /window\.addEventListener\('offline'/);

    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function initOfflineState()'),
        PLAYER_SOURCE.indexOf('async function main()')
    );

    // One message per change of state, not one per failed request.
    assert.match(section, /if \(networkAvailable === online\) return;/);
    assert.strictEqual((section.match(/showToast\(/g) || []).length, 1, 'said once');

    // Nothing is turned off because the internet went away.
    assert.ok(!/disabled = true|classList\.add\('disabled'\)/.test(section), 'nothing is disabled');
});

test('a song whose file has gone is checked for, not merely complained about', () => {
    const section = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function handlePlaybackFailure'),
        PLAYER_SOURCE.indexOf('// ==================== Artwork for a track')
    );

    // Said once per track, and the row is marked while it is being sorted out.
    assert.match(section, /if \(window\.playbackFailureFor === trackId\) return;/);
    assert.match(section, /classList\.add\('is-unavailable'\)/);

    // A local file that will not play sends the server to check its index
    // rather than leaving the row sitting there with a message on it.
    assert.match(section, /if \(track && track\.source === 'local'\) \{[\s\S]*?reconcileAfterMissingLocalTrack\(trackId\);/);
    assert.match(PLAYER_SOURCE, /async function reconcileAfterMissingLocalTrack\(trackId\)/);

    // Gone means gone from the library and moved on from, quietly.
    const recovery = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function reconcileAfterMissingLocalTrack'),
        PLAYER_SOURCE.indexOf('// ==================== Artwork for a track')
    );
    assert.match(recovery, /await startDeviceScan\(\{ silent: true \}\);/, 'the check is silent');
    assert.match(recovery, /await refreshAfterDeviceChange\(\);/);
    assert.match(recovery, /if \(wasPlaying && songs\.length\) playNextTrack/);

    // The old message is gone: a row that disappears needs no explanation, and
    // saying a song is missing while still showing it was the fault.
    assert.ok(
        !/This song is not on this device any more/.test(PLAYER_SOURCE),
        'nothing is announced about a stale Local Music row'
    );
});

// ============================================
// The application, kept so it opens offline
// ============================================

test('the app shell is kept, and no audio is', () => {
    const worker = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

    // Versioned, so a new release retires the old copy outright.
    assert.match(worker, /const CACHE_VERSION = '/);
    assert.match(worker, /const SHELL_CACHE = 'spotifie-shell-' \+ CACHE_VERSION;/);
    assert.match(worker, /\.filter\(\(name\) => name\.startsWith\('spotifie-shell-'\) && name !== SHELL_CACHE\)/);

    // The interface, and only the interface - under the one address the
    // application has, rather than under both of the two it answers at.
    assert.match(worker, /const APP_SHELL = '\/';/);
    ['/css/style.css', '/js/script.js', '/img/music.svg'].forEach((asset) => {
        assert.ok(worker.includes("'" + asset + "'"), asset + ' is kept');
    });

    // Audio, from either source, is never put in browser storage.
    assert.match(worker, /function isAudio\(url, request\)/);
    assert.match(worker, /request\.destination === 'audio'/);
    assert.match(worker, /mp3\|m4a\|aac\|flac\|wav\|ogg\|opus/);
    // The privileged and personal bypass runs before the navigation branch, so
    // a page on the protected admin route is decided live rather than served
    // from cache; audio bypasses after it. Two guards now, not one.
    assert.match(worker, /if \(isAlwaysLive\(url\)\) return;/);
    assert.match(worker, /if \(isAudio\(url, request\)\) return;/);

    // Nothing personal and nothing privileged is cached either.
    assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
    assert.match(worker, /url\.pathname\.startsWith\('\/admin'\)/);

    // Somebody else's origin is somebody else's business.
    assert.match(worker, /if \(url\.origin !== self\.location\.origin\) return;/);

    // An offline launch still opens Spotifie.
    assert.match(worker, /request\.mode === 'navigate'/);

    // And a page always gets a page.
    //
    // A worker answers navigation, so a worker that answers one badly is the
    // whole site failing to open - the browser shows ERR_FAILED and somebody
    // has to press Back to get Spotifie to appear again. Every path through
    // opening a page ends in a real response: the network, then the copy of
    // that page, then the copy of the application, then a page saying it is
    // offline. Never a rejection, and never nothing at all.
    const opening = worker.slice(worker.indexOf('function openApplication'), worker.indexOf('function openCode'));
    assert.match(opening, /cached \|\| cache\.match\(APP_SHELL\)/);
    assert.match(opening, /cached \|\| offlinePage\(\)/);
    assert.ok(!/Response\.error\(\)/.test(opening), 'a page is never answered with a failure');
    assert.match(worker, /function offlinePage\(\)/);
    assert.match(worker, /status: 503/);
});

test('the worker is served from the root, where it can do its job', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /const STATIC_ROOT_FILES = new Set\(\[[^\]]*'sw\.js'/);

    // Registered after the page is up, and only where it can work.
    assert.match(PLAYER_SOURCE, /function initAppShellCache\(\)/);
    assert.match(PLAYER_SOURCE, /if \(!\('serviceWorker' in navigator\)\) return;/);
    assert.match(PLAYER_SOURCE, /if \(!window\.isSecureContext\) return;/);
    assert.match(PLAYER_SOURCE, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
});

test('the release carries the worker too', () => {
    const builder = fs.readFileSync(path.join(ROOT, 'tools', 'buildPublic.js'), 'utf8');
    assert.match(builder, /copyFile\('sw\.js'\);/);
    assert.match(builder, /'lib\/libraryBackup\.js'/);
});
