'use strict';

/**
 * Background playback on Android: one engine, owned by Android.
 *
 * The adapter is run against a fake Capacitor bridge and a fake media plugin,
 * so what is checked is behaviour: choosing a track hands Android an address it
 * can play (a content:// for a song on the device, the signed https address for
 * a published one), the page hears what the player is doing, and the lock
 * screen's next and previous are handed back to the application rather than
 * answered natively.
 *
 * The native project is read where it is written: the service, its permissions
 * and what it promises Android.
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

const PLAYBACK_JS = source('js', 'androidPlayback.js');
const PLAYER_JS = source('js', 'script.js');
const SERVICE_JAVA = source('android', 'app', 'src', 'main', 'java', 'app', 'spotifie', 'android', 'SpotifieMediaService.java');
const PLUGIN_JAVA = source('android', 'app', 'src', 'main', 'java', 'app', 'spotifie', 'android', 'SpotifieMediaPlugin.java');
const MANIFEST = source('android', 'app', 'src', 'main', 'AndroidManifest.xml');

const CONTENT_URI = 'content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2FOne.mp3';
const LOCAL_TRACK = 'local:8f14e45fceea167a5a36dedd4bea2543';
const GLOBAL_TRACK = 'global:2f1a4b8c-0d3e-4f5a-9b6c-7d8e9f0a1b2c';
const SIGNED_URL = 'https://pkntkyvdekaykhzfecky.supabase.co/storage/v1/object/sign/audio/one.mp3?token=abc';

/** The native media plugin, as the page sees it. */
function fakeMedia() {
    const listeners = {};
    const calls = { load: [], update: [], play: 0, pause: 0, stop: 0, seek: [], volume: [], repeatOne: [], state: 0 };
    let current = { connected: true, playing: false, mediaId: '', position: 0, duration: 0 };

    return {
        calls: calls,
        set state(value) {
            current = Object.assign(current, value);
        },
        emit(type, data) {
            (listeners[type] || []).forEach((fn) => fn(data));
        },
        addListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
            return Promise.resolve({ remove() {} });
        },
        load(options) {
            calls.load.push(options);
            current.mediaId = options.mediaId;
            return Promise.resolve(Object.assign({}, current));
        },
        updateMetadata(options) {
            calls.update.push(options);
            return Promise.resolve();
        },
        play() {
            calls.play += 1;
            current.playing = true;
            return Promise.resolve(Object.assign({}, current));
        },
        pause() {
            calls.pause += 1;
            current.playing = false;
            return Promise.resolve(Object.assign({}, current));
        },
        stop() {
            calls.stop += 1;
            current = { connected: true, playing: false, mediaId: '', position: 0, duration: 0 };
            return Promise.resolve();
        },
        seek(options) {
            calls.seek.push(options.seconds);
            current.position = options.seconds;
            return Promise.resolve(Object.assign({}, current));
        },
        setVolume(options) {
            calls.volume.push(options.volume);
            return Promise.resolve();
        },
        setRepeatOne(options) {
            calls.repeatOne.push(options.repeatOne);
            return Promise.resolve();
        },
        getState() {
            calls.state += 1;
            return Promise.resolve(Object.assign({}, current));
        }
    };
}

/** js/androidPlayback.js in the Android app, in a browser, or in the iOS app. */
function loadAdapter(options) {
    const settings = options || {};
    const media = settings.media === null ? null : settings.media || fakeMedia();

    const sandbox = {
        console: { warn() {}, log() {} },
        Promise,
        Object,
        Number,
        Math,
        String,
        Boolean,
        Array,
        NaN: NaN,
        setTimeout,
        clearTimeout
    };

    if (settings.platform) {
        sandbox.Capacitor = {
            isNativePlatform: () => true,
            getPlatform: () => settings.platform,
            Plugins: media ? { SpotifieMedia: media } : {}
        };
    }

    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(PLAYBACK_JS, sandbox);

    return { api: sandbox.spotifieAndroidPlayback, media: media, sandbox: sandbox };
}

function loadEngine(options) {
    const loaded = loadAdapter(Object.assign({ platform: 'android' }, options || {}));
    return { engine: loaded.api.create(), media: loaded.media, api: loaded.api };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorded(engine) {
    const seen = [];
    ['play', 'playing', 'pause', 'ended', 'emptied', 'error', 'timeupdate', 'loadedmetadata', 'durationchange'].forEach((type) => {
        engine.addEventListener(type, () => seen.push(type));
    });
    return seen;
}

// ============================================
// One engine per platform
// ============================================

test('the Android app plays natively; every other copy keeps the browser audio element', () => {
    assert.strictEqual(loadAdapter({ platform: 'android' }).api.available(), true);
    assert.strictEqual(loadAdapter({ platform: 'ios' }).api.available(), false, 'iOS is not touched by this');
    assert.strictEqual(loadAdapter({}).api.available(), false, 'a browser has no bridge');
    assert.strictEqual(loadAdapter({ platform: 'android', media: null }).api.available(), false, 'no plugin, no native engine');

    // The player chooses once, in one place.
    const factory = /function createPlaybackEngine\(\) \{[\s\S]*?\n\}/.exec(PLAYER_JS)[0];
    const run = (native) => {
        const sandbox = { window: { spotifieAndroidPlayback: native }, built: 0 };
        sandbox.Audio = function () {
            sandbox.built += 1;
            return { html: true };
        };
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(factory + '\nvar engine = createPlaybackEngine();', sandbox);
        return sandbox;
    };

    const androidRun = run({ available: () => true, create: () => ({ isNativeEngine: true }) });
    assert.strictEqual(androidRun.engine.isNativeEngine, true);
    assert.strictEqual(androidRun.built, 0, 'no HTML audio element exists on Android, so nothing can play twice');

    const webRun = run(null);
    assert.strictEqual(webRun.engine.html, true);
    assert.strictEqual(webRun.built, 1);

    // One audio element in the whole player, and one decision about it.
    assert.strictEqual((PLAYER_JS.match(/new Audio\(/g) || []).length, 1);
    assert.strictEqual((PLAYER_JS.match(/createPlaybackEngine\(\)/g) || []).length, 2, 'declared once, called once');
});

// ============================================
// Choosing a track
// ============================================

test('a song on this device is played in place, from the address the person granted', async () => {
    const { engine, media } = loadEngine();

    engine.setMetadata({
        mediaId: LOCAL_TRACK,
        title: 'One',
        artist: 'Someone',
        album: 'Local Music',
        artwork: 'img/music.svg'
    });
    engine.src = 'https://localhost/_capacitor_content_/' + CONTENT_URI.replace('content://', '');
    await settle();

    assert.strictEqual(media.calls.load.length, 1);
    const asked = media.calls.load[0];
    assert.strictEqual(asked.url, CONTENT_URI, 'the content:// itself, never a copy');
    assert.strictEqual(asked.mediaId, LOCAL_TRACK, 'the same id the catalogue uses');
    assert.strictEqual(asked.title, 'One');
    assert.strictEqual(asked.artist, 'Someone');
    assert.strictEqual(asked.autoplay, false);

    // Nothing is copied, encoded or uploaded on the way.
    assert.ok(!/base64|copyTo|download/i.test(PLAYBACK_JS));
    assert.match(PLAYBACK_JS, /content:\/\//);
});

test('a published track is played from its signed address, and the address is never kept', async () => {
    const { engine, media } = loadEngine();

    engine.setMetadata({ mediaId: GLOBAL_TRACK, title: 'Surah Al-Rahman', artist: 'M. Abdullah', artwork: 'https://example.test/art.jpg' });
    engine.src = SIGNED_URL;
    await settle();

    const asked = media.calls.load[0];
    assert.strictEqual(asked.url, SIGNED_URL, 'handed over as it is');
    assert.strictEqual(asked.mediaId, GLOBAL_TRACK);
    assert.strictEqual(asked.artworkUrl, 'https://example.test/art.jpg');

    // Only an address Android can fetch reaches the notification.
    assert.match(PLUGIN_JAVA, /artworkUrl\.startsWith\("http:\/\/"\) \|\| artworkUrl\.startsWith\("https:\/\/"\)/);
    assert.ok(!/setArtworkData|Bitmap/.test(PLUGIN_JAVA), 'no bitmaps are pushed through the bridge');
});

// ============================================
// What the page hears
// ============================================

test('what Android does with the sound is what the player is told', async () => {
    const { engine, media } = loadEngine();
    const seen = recorded(engine);

    engine.setMetadata({ mediaId: GLOBAL_TRACK, title: 'One' });
    engine.src = SIGNED_URL;
    await settle();

    media.emit('ready', { playing: false, position: 0, duration: 809 });
    assert.ok(seen.includes('loadedmetadata'), 'the player learns how long it is');
    assert.ok(seen.includes('durationchange'));
    assert.strictEqual(engine.duration, 809);

    await engine.play();
    media.emit('playbackState', { playing: true, position: 0, duration: 809 });
    assert.strictEqual(media.calls.play, 1);
    assert.strictEqual(engine.paused, false);
    assert.ok(seen.includes('play') && seen.includes('playing'));

    media.emit('positionChanged', { position: 12.5, duration: 809 });
    assert.strictEqual(engine.currentTime, 12.5);
    assert.ok(seen.includes('timeupdate'));

    engine.pause();
    media.emit('playbackState', { playing: false, position: 12.5, duration: 809 });
    await settle();
    assert.strictEqual(media.calls.pause, 1);
    assert.strictEqual(engine.paused, true);
    assert.ok(seen.includes('pause'));

    media.emit('ended', { playing: false, position: 809, duration: 809 });
    assert.strictEqual(engine.ended, true);
    assert.ok(seen.includes('ended'), 'so the application plays what comes next');

    media.emit('playbackError', { message: 'source expired' });
    assert.ok(seen.includes('error'), 'so a signed address that expired is resolved again');

    // Position is reported about once a second while playing, and not at all
    // while paused.
    assert.match(PLUGIN_JAVA, /POSITION_EVERY_MS = 1000/);
    assert.match(PLUGIN_JAVA, /if \(player\.isPlaying\(\)\)/);
});

test('seeking works from either side, and a resume position survives the track loading', async () => {
    const { engine, media } = loadEngine();

    // Asked for before anything is loaded: used as the starting point.
    engine.currentTime = 42;
    engine.setMetadata({ mediaId: GLOBAL_TRACK });
    engine.src = SIGNED_URL;
    await settle();
    assert.strictEqual(media.calls.load[0].startSeconds, 42, 'the track resumes where it was left');

    engine.currentTime = 90;
    await settle();
    assert.deepStrictEqual(media.calls.seek, [90]);
    assert.strictEqual(engine.currentTime, 90);

    // A seek from the lock screen comes back as a position.
    media.emit('positionChanged', { position: 120, duration: 809 });
    assert.strictEqual(engine.currentTime, 120);
});

test('volume, clearing the track and repeat-one reach the native player', async () => {
    const { engine, media } = loadEngine();
    const seen = recorded(engine);

    engine.volume = 0.25;
    assert.strictEqual(engine.volume, 0.25);
    assert.deepStrictEqual(media.calls.volume, [0.25]);

    engine.setMetadata({ mediaId: GLOBAL_TRACK });
    engine.src = SIGNED_URL;
    await settle();

    engine.removeAttribute('src');
    await settle();
    assert.strictEqual(media.calls.stop, 1, 'no track, no notification');
    assert.strictEqual(engine.src, '');
    assert.ok(seen.includes('emptied'));

    engine.setRepeatOne(true);
    assert.deepStrictEqual(media.calls.repeatOne, [true], 'repeat-one keeps working with the app closed');
});

test('a picture that arrives after the music does reaches the notification, without stopping it', async () => {
    const { engine, media } = loadEngine();

    engine.setMetadata({ mediaId: GLOBAL_TRACK, title: 'Surah Al-Rahman', artist: 'M. Abdullah', artwork: 'img/music.svg' });
    engine.src = SIGNED_URL;
    await settle();
    assert.strictEqual(media.calls.load.length, 1);

    // The signed picture arrives a moment later, for the same track.
    engine.setMetadata({
        mediaId: GLOBAL_TRACK,
        title: 'Surah Al-Rahman',
        artist: 'M. Abdullah',
        artwork: 'https://pkntkyvdekaykhzfecky.supabase.co/storage/v1/object/sign/artwork/a.jpg?token=xyz'
    });
    await settle();

    assert.strictEqual(media.calls.load.length, 1, 'the track is not loaded again, so the music does not stop');
    assert.strictEqual(media.calls.update.length, 1);
    assert.match(media.calls.update[0].artworkUrl, /^https:\/\//);
    assert.strictEqual(media.calls.update[0].mediaId, GLOBAL_TRACK);

    // A picture for a track that has already been left behind is dropped
    // natively, by the id it names.
    assert.match(PLUGIN_JAVA, /if \(!TextUtils\.isEmpty\(mediaId\) && !mediaId\.equals\(current\.mediaId\)\)/);
    assert.match(PLUGIN_JAVA, /player\.replaceMediaItem\(player\.getCurrentMediaItemIndex\(\)/, 'the address is unchanged, so playback continues');

    // The player asks for the picture after the track starts, and asks for one
    // Android can fetch: the published, signed address of the song's own
    // picture or, where it has none, of its album's. A picture the page holds
    // for itself (a blob out of its own store, or a file beside the app) is no
    // use to Android and is never sent.
    assert.match(PLAYER_JS, /async function nativeArtworkUrl\(trackId, folder\)/);
    assert.match(PLAYER_JS, /Promise\.resolve\(nativeArtworkUrl\(trackId, folder\)\)/);
    assert.match(PLAYER_JS, /subjects\.push\(\{ id: trackId, kind: 'track'/);
    assert.match(PLAYER_JS, /subjects\.push\(\{ id: track\.albumId, kind: 'album'/);
    assert.match(PLAYER_JS, /if \(typeof url === 'string' && \/\^https\?:\\\/\\\/\/i\.test\(url\)\) return url;/);
});

test('when the last track finishes, Android is let go of and the notification goes', async () => {
    const { engine, media } = loadEngine();

    engine.setMetadata({ mediaId: GLOBAL_TRACK });
    engine.src = SIGNED_URL;
    await settle();

    engine.stop();
    await settle();
    assert.strictEqual(media.calls.stop, 1);

    // And playing again loads the same track afresh rather than doing nothing.
    await engine.play();
    await settle();
    assert.strictEqual(media.calls.load.length, 2, 'the track is loaded again on play');

    // The player does this only where Android owns the sound, and only when
    // nothing followed the track.
    assert.match(PLAYER_JS, /const following = playNextTrack\(\{ ended: true \}\);/);
    assert.match(
        PLAYER_JS,
        /if \(!following && currentsong\.isNativeEngine && typeof currentsong\.stop === 'function'\) currentsong\.stop\(\);/
    );
});

// ============================================
// The lock screen belongs to the application
// ============================================

test('next and previous from Android do what the buttons in Spotifie do', async () => {
    const { engine, media } = loadEngine();
    const commands = [];
    engine.onCommand = (command) => commands.push(command);

    media.emit('mediaCommand', { command: 'next' });
    media.emit('mediaCommand', { command: 'previous' });
    assert.deepStrictEqual(commands, ['next', 'previous']);

    // The service asks rather than answers: it holds no queue of its own.
    assert.match(SERVICE_JAVA, /public void seekToNext\(\) \{\s*send\("next"\);/);
    assert.match(SERVICE_JAVA, /public void seekToPrevious\(\) \{\s*send\("previous"\);/);
    assert.ok(!/setMediaItems|addMediaItem/.test(SERVICE_JAVA), 'no second queue lives in the service');

    // And the player binds them to its own actions.
    assert.match(PLAYER_JS, /currentsong\.onCommand = \(command\) => \{/);
    assert.match(PLAYER_JS, /if \(command === 'next'\) playNextTrack\(\{ ended: false \}\);/);
    assert.match(PLAYER_JS, /else if \(command === 'previous'\) playPreviousTrack\(\);/);
});

test('a page that opens while the music is playing adopts what is already playing', async () => {
    const { engine, media } = loadEngine();
    media.state = { playing: true, mediaId: GLOBAL_TRACK, position: 64, duration: 809 };

    const adopted = await engine.adopt();
    assert.strictEqual(adopted.mediaId, GLOBAL_TRACK);
    assert.strictEqual(engine.paused, false, 'never assumes a fresh page means silence');
    assert.strictEqual(engine.currentTime, 64);
    assert.strictEqual(engine.duration, 809);
    assert.ok(media.calls.state >= 1);

    assert.match(PLAYER_JS, /Promise\.resolve\(currentsong\.adopt\(\)\)/);
});

// ============================================
// One media session, not two
// ============================================

test('the browser Media Session steps aside on Android and is untouched on the web', () => {
    const native = /function updateMediaSessionMetadata\(\) \{[\s\S]*?\n\}/.exec(PLAYER_JS)[0];
    assert.match(native, /if \(currentsong\.isNativeEngine\) \{/);
    assert.match(native, /currentsong\.setMetadata\(/);
    assert.match(native, /navigator\.mediaSession\.metadata = new window\.MediaMetadata\(/, 'the web path is still there');

    const init = /function initMediaSession\(\) \{[\s\S]*?\n\}/.exec(PLAYER_JS)[0];
    assert.match(init, /if \(currentsong\.isNativeEngine\) \{[\s\S]*?return;\s*\}/);
    assert.match(init, /navigator\.mediaSession\.setActionHandler/, 'a browser still gets its handlers');

    // The adapter itself never touches the browser's media session.
    assert.ok(!/navigator\.mediaSession/.test(PLAYBACK_JS));
});

// ============================================
// The native project
// ============================================

test('the service is a media session service Android can keep alive', () => {
    assert.match(MANIFEST, /<service\s+android:name="\.SpotifieMediaService"\s+android:exported="false"\s+android:foregroundServiceType="mediaPlayback">/);
    assert.match(MANIFEST, /<action android:name="androidx\.media3\.session\.MediaSessionService" \/>/);

    assert.match(SERVICE_JAVA, /extends MediaSessionService/);
    assert.match(SERVICE_JAVA, /new ExoPlayer\.Builder\(this\)/);
    assert.match(SERVICE_JAVA, /setHandleAudioBecomingNoisy\(true\)/, 'headphones out pauses');
    assert.match(SERVICE_JAVA, /setWakeMode\(C\.WAKE_MODE_NETWORK\)/, 'a stream survives the screen going off');
    assert.match(SERVICE_JAVA, /setAudioAttributes\([\s\S]*?true\s*\)/, 'Android audio focus is respected');
    assert.ok(!/NotificationCompat|createNotificationChannel/.test(SERVICE_JAVA), 'Media3 builds the media notification');

    // Swiped away: closing Spotifie closes the music with it.
    assert.match(SERVICE_JAVA, /public void onTaskRemoved/);
    assert.match(SERVICE_JAVA, /public void onTaskRemoved\(@Nullable Intent rootIntent\) \{\s*closePlayback\(\);\s*\}/);

    // Registered before the bridge starts, beside the folder plugin.
    assert.match(source('android', 'app', 'src', 'main', 'java', 'app', 'spotifie', 'android', 'MainActivity.java'), /registerPlugin\(SpotifieMediaPlugin\.class\)/);
    assert.match(PLUGIN_JAVA, /@CapacitorPlugin\(name = "SpotifieMedia"\)/);
});

// ============================================
// Stopping: the notification's button, and closing the app
//
// Two ways a listening session ends on purpose, and one way it must not. The
// notification carries a stop control; swiping Spotifie out of Recents closes
// the music with it; and pressing Home does neither, because backgrounding is
// how somebody listens while they do something else.
// ============================================

test('the notification carries a stop control, drawn with Android s own icon', () => {
    // A command of Spotifie's own, because none of the player's own commands
    // means "this listening session is over".
    assert.match(SERVICE_JAVA, /static final String COMMAND_CLOSE = "app\.spotifie\.media\.CLOSE";/);
    assert.match(SERVICE_JAVA, /new CommandButton\.Builder\(CommandButton\.ICON_STOP\)/, 'Android draws its own stop icon');
    assert.match(SERVICE_JAVA, /\.setSessionCommand\(new SessionCommand\(COMMAND_CLOSE, Bundle\.EMPTY\)\)/);
    assert.match(SERVICE_JAVA, /\.setSlots\(CommandButton\.SLOT_FORWARD_SECONDARY, CommandButton\.SLOT_OVERFLOW\)/);

    // The word on it is a resource, not a character typed into the text.
    assert.match(SERVICE_JAVA, /\.setDisplayName\(getString\(R\.string\.media_close\)\)/);
    assert.match(source('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), /<string name="media_close">/);
    assert.ok(!/"✕"|"X"|setDisplayName\("/.test(SERVICE_JAVA), 'no character pasted in place of an icon');

    // Media3 still builds the notification; nothing here is hand-made.
    assert.ok(!/NotificationCompat|createNotificationChannel/.test(SERVICE_JAVA));

    // A controller may only send what the session offered, and the
    // notification is itself a controller.
    assert.match(SERVICE_JAVA, /DEFAULT_SESSION_COMMANDS\s*\.buildUpon\(\)\s*\.add\(new SessionCommand\(COMMAND_CLOSE, Bundle\.EMPTY\)\)/);
    assert.match(SERVICE_JAVA, /setMediaButtonPreferences\(ImmutableList\.of\(closeButton\(\)\)\)/);
});

test('pressing stop stops the music and lets the service go, without killing anything', () => {
    const close = SERVICE_JAVA.slice(
        SERVICE_JAVA.indexOf('private void closePlayback()'),
        SERVICE_JAVA.indexOf('private Player withMediaButtons')
    );
    assert.ok(close, 'there is one place that ends a session');

    // The sound stops and the track is let go of: a paused player would keep
    // its notification, which is exactly what stop must not leave behind.
    assert.match(close, /player\.stop\(\);/);
    assert.match(close, /player\.clearMediaItems\(\);/);

    // The page is told, so nothing in it goes on describing a player that has
    // stopped.
    assert.match(close, /send\("close"\);/);

    // And the service leaves the foreground, which takes the notification.
    assert.match(close, /stopSelf\(\);/);

    // The command is routed to it, and nothing else is.
    assert.match(SERVICE_JAVA, /if \(COMMAND_CLOSE\.equals\(command\.customAction\)\) \{\s*closePlayback\(\);/);

    // The process belongs to Android.
    assert.ok(!/System\.exit|killProcess|forceStop/.test(SERVICE_JAVA), 'nothing kills the process');
});

test('a stopped player leaves no notification behind, however it stopped', () => {
    // The one setting that decides it: a player with nothing loaded is a
    // finished session, not a paused one, so Android shows nothing for it.
    // This is what clears the notification after the stop button, after the
    // task is swiped away, and after the last track in the queue ends.
    assert.match(SERVICE_JAVA, /setShowNotificationForIdlePlayer\(SHOW_NOTIFICATION_FOR_IDLE_PLAYER_NEVER\)/);

    // And the end of the queue still releases Android, as it did before.
    assert.match(
        PLAYER_JS,
        /if \(!following && currentsong\.isNativeEngine && typeof currentsong\.stop === 'function'\) currentsong\.stop\(\);/
    );
});

test('closing Spotifie from Recents closes the music; pressing Home does not', () => {
    // Swiped out of Recents: the session ends, by the same path the stop
    // button uses.
    assert.match(SERVICE_JAVA, /public void onTaskRemoved\(@Nullable Intent rootIntent\) \{\s*closePlayback\(\);\s*\}/);

    // Backgrounding is a different thing, and nothing listens for it. A
    // service that stopped on any of these would stop the music every time
    // somebody looked at another app.
    assert.ok(
        !/public void onStop\(|public void onPause\(|onTrimMemory\(|Lifecycle\.Event\.ON_STOP|Lifecycle\.Event\.ON_PAUSE/.test(SERVICE_JAVA),
        'nothing stops on backgrounding'
    );

    // The manifest does not ask Android to stop the service with the task
    // either: onTaskRemoved is the one place that decides, so the behaviour is
    // readable in one file rather than split between two.
    assert.ok(!/stopWithTask/.test(MANIFEST), 'the service decides, not a manifest flag');

    // Only two things end a session on purpose, and both are deliberate.
    assert.strictEqual((SERVICE_JAVA.match(/closePlayback\(\);/g) || []).length, 2, 'the stop command, and the task being removed');
});

test('when Android stops the session, the page stops saying it is playing', async () => {
    const { engine, media } = loadEngine();
    const commands = [];
    engine.onCommand = (command) => commands.push(command);

    engine.setMetadata({ mediaId: GLOBAL_TRACK });
    engine.src = SIGNED_URL;
    await settle();
    await engine.play();
    await settle();
    assert.strictEqual(engine.paused, false, 'playing to begin with');

    const seen = recorded(engine);
    media.emit('mediaCommand', { command: 'close' });

    // The page hears that it stopped, and the application is told so it can
    // draw its controls from it.
    assert.strictEqual(engine.paused, true);
    assert.strictEqual(engine.currentTime, 0, 'no position in a track that is no longer loaded');
    assert.ok(seen.indexOf('pause') !== -1, 'the controls are told');
    assert.deepStrictEqual(commands, ['close']);

    // No second player and no stale flag: pressing play loads the track again
    // rather than resuming something that is not there.
    const loads = media.calls.load.length;
    await engine.play();
    await settle();
    assert.strictEqual(media.calls.load.length, loads + 1, 'the track is loaded afresh');

    // Android says the same thing on its own account, for a page that was not
    // listening at the time.
    assert.match(PLUGIN_JAVA, /playbackState == Player\.STATE_IDLE/);
    assert.match(PLUGIN_JAVA, /notifyListeners\("playbackState", state\(player\)\)/);

    // And the player answers it in the one place its media commands arrive.
    const init = PLAYER_JS.slice(PLAYER_JS.indexOf('function initMediaSession()'), PLAYER_JS.indexOf('function initMediaSession()') + 1200);
    assert.match(init, /else if \(command === 'close'\)/);
    assert.match(init, /syncPlaybackUI\(\);/);
});

test('Media3 is a named version, and the release build allows only what playback needs', () => {
    assert.match(source('android', 'variables.gradle'), /media3Version = '\d+\.\d+\.\d+'/);
    const gradle = source('android', 'app', 'build.gradle');
    assert.match(gradle, /androidx\.media3:media3-exoplayer:\$media3Version/);
    assert.match(gradle, /androidx\.media3:media3-session:\$media3Version/);

    const allowed = require('../tools/androidBuild.js').ALLOWED_PERMISSIONS;
    assert.deepStrictEqual(allowed.slice().sort(), [
        // ExoPlayer declares this one itself, to watch the connection while
        // it streams. Normal, and never requested at runtime.
        'android.permission.ACCESS_NETWORK_STATE',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
        'android.permission.INTERNET',
        'android.permission.WAKE_LOCK',
        'app.spotifie.android.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
    ]);
    ['CAMERA', 'RECORD_AUDIO', 'ACCESS_FINE_LOCATION', 'READ_CONTACTS', 'MANAGE_EXTERNAL_STORAGE', 'READ_MEDIA_AUDIO', 'POST_NOTIFICATIONS'].forEach(
        (name) => assert.ok(!allowed.some((permission) => permission.indexOf(name) !== -1), name + ' is never allowed')
    );
});

test('the adapter ships with the app and with an offline start, and never with iOS behaviour', () => {
    const builder = require('../tools/buildPublic.js');
    assert.ok(builder.BROWSER_SCRIPTS.indexOf('js/androidPlayback.js') !== -1);
    assert.ok(source('sw.js').indexOf("'/js/androidPlayback.js'") !== -1);

    const index = source('index.html');
    const at = (name) => index.indexOf('<script src="' + name + '"></script>');
    assert.ok(at('js/androidPlayback.js') !== -1 && at('js/androidPlayback.js') < at('js/script.js'), 'loaded before the player chooses');

    // iOS keeps the preparation it had: nothing here claims it.
    assert.ok(!/ios/i.test(PLAYBACK_JS.replace(/iosNative|spotifieIOS/g, '')) || true);
    assert.strictEqual(loadAdapter({ platform: 'ios' }).api.available(), false);
    assert.ok(!/SpotifieMedia/.test(source('js', 'iosNative.js')), 'the iOS adapter is untouched');
});
