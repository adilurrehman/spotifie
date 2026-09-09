'use strict';

/**
 * What plays next, and where a track was left.
 *
 * The player's sequence and position sections are run on their own, against a
 * small stand-in for the page: a list of track ids and an audio element that
 * only has to remember a time. Everything asserted here is about order and
 * position - never about a file name, and never about Supabase.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLAYER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

function sectionBetween(startMarker, endMarker) {
    const start = PLAYER_SOURCE.indexOf(startMarker);
    const end = PLAYER_SOURCE.indexOf(endMarker);
    assert.ok(start !== -1 && end > start, 'the section ' + startMarker.trim() + ' was found');
    return PLAYER_SOURCE.slice(start, end);
}

// The player's own state is declared with let, which a script keeps to itself.
// These lines are appended to the section under test so a test can read the
// same variables the player is using.
const SEQUENCE_EXPORTS = `
globalThis.readSequenceState = function () {
    return {
        shuffleEnabled: shuffleEnabled,
        repeatMode: repeatMode,
        shuffleOrder: shuffleOrder.slice(),
        shuffleCursor: shuffleCursor,
        playbackHistory: playbackHistory.slice()
    };
};
`;

const POSITION_EXPORTS = `
globalThis.readTrackProgress = function () {
    return trackProgress;
};
`;

function sequenceSource() {
    return sectionBetween(
        '// ==================== Playback sequence ====================',
        '// ==================== Playback position ===================='
    );
}

function positionSource() {
    return sectionBetween(
        '// ==================== Playback position ====================',
        '// ==================== Account gating ===================='
    );
}

// ============================================
// A stand-in for the page
// ============================================

/** A store that behaves like localStorage and can be inspected. */
function makeStore() {
    const values = new Map();
    return {
        values: values,
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}

/**
 * Load the sequence section with a context to play: a list of track ids, an
 * audio element, and nothing on screen for it to draw on.
 */
function buildSequence(trackIds, options) {
    const settings = options || {};
    const store = makeStore();
    if (settings.saved) store.setItem('spotifie_player_prefs', JSON.stringify(settings.saved));

    // A predictable shuffle: without it the order would be different on every
    // run and nothing could be asserted about which track comes next.
    let seed = 1;
    const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };

    const sandbox = {
        console: { warn() {}, error() {}, log() {} },
        document: {
            querySelectorAll() {
                return [];
            },
            querySelector() {
                return null;
            }
        },
        window: { currentPlayingTrack: null, currentPlayingAlbum: null },
        localStorage: store,
        Math: Object.assign(Object.create(Math), { random: random }),
        Number: Number,
        Date: Date,
        JSON: JSON,
        songs: trackIds.slice(),
        currentsong: { volume: 0.5, currentTime: 0, duration: 200, src: 'stream://x' },
        lastVolume: 0.5,
        currentTrackId: null
    };

    // The one thing the sequence asks the rest of the player for.
    sandbox.getCurrentEncodedTrack = function () {
        return sandbox.currentTrackId;
    };

    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(sequenceSource() + SEQUENCE_EXPORTS, sandbox);

    /** Start a track, the way playmusic() records one. */
    sandbox.play = function (trackId) {
        sandbox.currentTrackId = trackId;
        sandbox.window.currentPlayingTrack = trackId;
        sandbox.noteTrackStarted(trackId);
    };

    return sandbox;
}

const A = 'local:aaaaaaaa';
const B = 'local:bbbbbbbb';
const C = 'global:cccccccc';
const D = 'global:dddddddd';

// ============================================
// Next and previous
// ============================================

test('next follows the list being played, not the order of the file names', () => {
    const player = buildSequence([C, A, D, B]);
    player.play(C);

    assert.strictEqual(player.nextTrackIdInContext({}), A);
    player.play(A);
    assert.strictEqual(player.nextTrackIdInContext({}), D);
});

test('the last track of a list has nothing after it while repeat is off', () => {
    const player = buildSequence([A, B]);
    player.play(B);

    assert.strictEqual(player.nextTrackIdInContext({ ended: true }), null);
});

test('previous restarts a track that is already under way', () => {
    const player = buildSequence([A, B]);
    player.play(B);

    const early = player.previousAction(1.2);
    assert.strictEqual(early.restart, false, 'a press in the first seconds goes back');
    assert.strictEqual(early.trackId, A);

    const later = player.previousAction(30);
    assert.strictEqual(later.restart, true, 'a press later starts this track again');
    assert.strictEqual(later.trackId, null);
});

test('previous walks back through what was actually played', () => {
    const player = buildSequence([A, B, C, D]);
    player.play(A);
    player.play(C);
    player.play(D);

    assert.strictEqual(player.previousAction(0).trackId, C);
    player.play(C);
    assert.strictEqual(player.previousAction(0).trackId, A);
});

// ============================================
// Shuffle
// ============================================

test('turning shuffle on does not disturb the track that is playing', () => {
    const player = buildSequence([A, B, C, D]);
    player.play(B);
    const timeBefore = player.currentsong.currentTime;

    player.setShuffleEnabled(true);

    assert.strictEqual(player.getCurrentEncodedTrack(), B, 'the same track is still loaded');
    assert.strictEqual(player.currentsong.currentTime, timeBefore, 'it is still in the same place');
    assert.strictEqual(player.readSequenceState().shuffleOrder[0], B, 'the shuffled walk carries on from it');
});

test('shuffle plays everything in the context once before repeating any of it', () => {
    const player = buildSequence([A, B, C, D]);
    player.play(A);
    player.setShuffleEnabled(true);

    const heard = [A];
    for (let i = 0; i < 3; i += 1) {
        const next = player.nextTrackIdInContext({ ended: true });
        assert.ok(next, 'the walk continues');
        assert.ok(heard.indexOf(next) === -1, next + ' was not heard twice before the walk finished');
        heard.push(next);
        player.play(next);
    }

    assert.strictEqual(heard.length, 4);
    assert.strictEqual(player.nextTrackIdInContext({ ended: true }), null, 'the walk ends when repeat is off');
});

test('shuffle draws from the context being played, and follows it when it changes', () => {
    const player = buildSequence([A, B]);
    player.play(A);
    player.setShuffleEnabled(true);

    // The listener opens a different collection: shuffle is over that one now.
    player.songs = [C, D];
    player.play(C);

    const next = player.nextTrackIdInContext({ ended: true });
    assert.ok([C, D].indexOf(next) !== -1, 'the next track comes from the collection being played');
});

test('turning shuffle off puts the list back in its own order', () => {
    const player = buildSequence([A, B, C, D]);
    player.play(A);
    player.setShuffleEnabled(true);
    player.setShuffleEnabled(false);

    assert.strictEqual(player.readSequenceState().shuffleOrder.length, 0, 'no shuffled walk is kept');
    assert.strictEqual(player.nextTrackIdInContext({}), B);
});

// ============================================
// Repeat
// ============================================

test('the repeat button cycles off, all, one, off', () => {
    const player = buildSequence([A, B]);

    assert.strictEqual(player.readSequenceState().repeatMode, 'off');
    assert.strictEqual(player.cycleRepeatMode(), 'all');
    assert.strictEqual(player.cycleRepeatMode(), 'one');
    assert.strictEqual(player.cycleRepeatMode(), 'off');
});

test('repeat all sends the last track back to the first', () => {
    const player = buildSequence([A, B]);
    player.setRepeatMode('all');
    player.play(B);

    assert.strictEqual(player.nextTrackIdInContext({ ended: true }), A);
});

test('repeat one plays the same track again when it ends, and Next still moves on', () => {
    const player = buildSequence([A, B]);
    player.setRepeatMode('one');
    player.play(A);

    assert.strictEqual(player.nextTrackIdInContext({ ended: true }), A, 'ending on its own repeats it');
    assert.strictEqual(player.nextTrackIdInContext({ ended: false }), B, 'pressing Next does not');
});

test('shuffle and repeat all keep going, in a fresh order each time round', () => {
    const player = buildSequence([A, B, C, D]);
    player.setRepeatMode('all');
    player.play(A);
    player.setShuffleEnabled(true);

    const heard = [A];
    for (let i = 0; i < 9; i += 1) {
        const next = player.nextTrackIdInContext({ ended: true });
        assert.ok(next, 'playback carries on');
        heard.push(next);
        player.play(next);
    }

    // Ten tracks over a collection of four: it went round, and it never
    // repeated a track while others were still unheard in that round.
    for (let round = 0; round + 4 <= 8; round += 4) {
        const window = heard.slice(round, round + 4);
        assert.strictEqual(new Set(window).size, 4, 'each pass covers the whole collection');
    }
});

// ============================================
// What is remembered on this device
// ============================================

test('shuffle and repeat are kept for next time, and never sent anywhere', () => {
    const player = buildSequence([A, B]);
    player.setShuffleEnabled(true);
    player.setRepeatMode('one');

    const saved = JSON.parse(player.localStorage.getItem('spotifie_player_prefs'));
    assert.strictEqual(saved.shuffle, true);
    assert.strictEqual(saved.repeat, 'one');

    const again = buildSequence([A, B], { saved: { shuffle: true, repeat: 'all', volume: 0.3 } });
    again.loadPlayerPreferences();
    assert.strictEqual(again.readSequenceState().shuffleEnabled, true);
    assert.strictEqual(again.readSequenceState().repeatMode, 'all');
    assert.strictEqual(again.currentsong.volume, 0.3);
});

// ============================================
// Where a track was left
// ============================================

/** Load the position section with an audio element and a catalogue stand-in. */
function buildPosition(options) {
    const settings = options || {};
    const saved = [];

    const sandbox = {
        console: { warn() {}, error() {}, log() {} },
        window: { currentPlayingTrack: settings.trackId || null },
        Number: Number,
        Date: Date,
        Math: Math,
        Promise: Promise,
        currentsong: {
            currentTime: settings.currentTime || 0,
            duration: settings.duration || 200,
            addEventListener() {}
        },
        saved: saved
    };

    sandbox.getCatalogClient = function () {
        return {
            getPlaybackProgress() {
                return Promise.resolve({ trackProgress: settings.stored || {} });
            },
            savePlaybackProgress(id, position, duration) {
                saved.push({ id: id, position: position, duration: duration });
                return Promise.resolve({ saved: true });
            },
            savePlaybackProgressOnExit(id, position, duration) {
                saved.push({ id: id, position: position, duration: duration, onExit: true });
                return true;
            }
        };
    };

    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(positionSource() + POSITION_EXPORTS, sandbox);
    return sandbox;
}

test('a track comes back to where it was left', async () => {
    const player = buildPosition({
        stored: {
            [A]: { position: 103.4, duration: 240 },
            [B]: { position: 52.8, duration: 180 }
        }
    });

    await player.loadTrackProgress();

    assert.strictEqual(player.resumePositionFor(A), 103.4);
    assert.strictEqual(player.resumePositionFor(B), 52.8);
    assert.strictEqual(player.resumePositionFor(C), 0, 'a track never played starts at the beginning');
});

test('a track heard to the end starts again rather than at its last second', async () => {
    const player = buildPosition({
        stored: {
            [A]: { position: 238, duration: 240 },
            [B]: { position: 240, duration: 240 }
        }
    });

    await player.loadTrackProgress();

    assert.strictEqual(player.resumePositionFor(A), 0, 'all but the last seconds is the end');
    assert.strictEqual(player.resumePositionFor(B), 0, 'a completed track starts from zero');
});

test('the first few seconds of a track are where it starts, not where it was left', async () => {
    const player = buildPosition({ stored: { [A]: { position: 2.5, duration: 240 } } });
    await player.loadTrackProgress();

    assert.strictEqual(player.resumePositionFor(A), 0);
});

test('a position is written a few times a minute, not a few times a second', () => {
    const player = buildPosition({ trackId: A, currentTime: 60, duration: 240 });

    assert.strictEqual(player.rememberProgress({}), true, 'the first one is written');
    assert.strictEqual(player.rememberProgress({}), false, 'the next moment is not');
    assert.strictEqual(player.rememberProgress({ force: true }), true, 'pausing or switching writes anyway');

    assert.strictEqual(player.saved.length, 2);
    assert.strictEqual(player.saved[0].id, A);
    assert.strictEqual(player.saved[0].position, 60);
});

test('leaving the page hands the position over in a way that outlives it', () => {
    const player = buildPosition({ trackId: A, currentTime: 90, duration: 240 });
    player.rememberProgress({ force: true, onExit: true });

    assert.strictEqual(player.saved.length, 1);
    assert.strictEqual(player.saved[0].onExit, true);
});

test('reaching the end forgets the position instead of saving it', () => {
    const player = buildPosition({ trackId: A, currentTime: 239, duration: 240 });
    player.readTrackProgress()[A] = { position: 100, duration: 240 };

    player.rememberProgress({ force: true });

    assert.ok(!player.readTrackProgress()[A], 'nothing is kept for a track that finished');
    assert.strictEqual(player.saved[0].position, 239, 'the server is told, and applies the same rule');
});
