'use strict';

/**
 * Playback state.
 *
 * The audio element decides what the controls show. These tests run the
 * player's playback-state section against a stand-in audio element that
 * behaves like the real one - play() is a promise, and the events arrive only
 * when the state actually changes - and check that every control follows it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLAYER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

/** The playback-state section of the player, on its own. */
function playbackStateSource() {
    const start = PLAYER_SOURCE.indexOf('// ==================== Playback state ====================');
    const end = PLAYER_SOURCE.indexOf('// ==================== Playback sequence ====================');
    assert.ok(start !== -1 && end > start, 'the playback-state section was found');
    return PLAYER_SOURCE.slice(start, end);
}

// ============================================
// A stand-in for the browser
// ============================================

function makeElement(tagName, attributes) {
    const element = {
        tagName: tagName,
        attributes: Object.assign({}, attributes),
        dataset: {},
        children: [],
        classes: new Set(),
        src: '',
        alt: '',
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name);
        },
        querySelector(selector) {
            return this.children.find((child) => child.matches(selector)) || null;
        },
        matches(selector) {
            if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
            return this.tagName.toLowerCase() === selector;
        }
    };

    element.classList = {
        add(...names) {
            names.forEach((name) => element.classes.add(name));
        },
        remove(...names) {
            names.forEach((name) => element.classes.delete(name));
        },
        contains(name) {
            return element.classes.has(name);
        }
    };

    return element;
}

/** An audio element that behaves like the real one: play() is a promise. */
function makeAudio() {
    const listeners = {};
    const audio = {
        src: '',
        paused: true,
        ended: false,
        currentTime: 0,
        duration: 0,
        // Set by a test to make the next play() request fail.
        failNextPlay: false,
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        emit(type) {
            (listeners[type] || []).forEach((handler) => handler());
        },
        play() {
            if (this.failNextPlay) {
                this.failNextPlay = false;
                this.paused = true;
                return Promise.reject(new Error('NotAllowedError'));
            }
            return Promise.resolve().then(() => {
                this.paused = false;
                this.ended = false;
                this.emit('play');
                this.emit('playing');
            });
        },
        pause() {
            if (this.paused) return;
            this.paused = true;
            this.emit('pause');
        },
        // The end of a track, as the browser reports it.
        finish() {
            this.paused = true;
            this.ended = true;
            this.emit('ended');
        },
        load(src) {
            this.src = src;
            this.paused = true;
            this.ended = false;
            this.currentTime = 0;
            this.emit('emptied');
        }
    };
    return audio;
}

/**
 * Load the playback-state section with a small page around it: a playbar
 * button, two track rows and two album cards.
 */
function buildPlayer() {
    const playImg = makeElement('IMG');
    const playBtn = makeElement('BUTTON', { 'aria-label': 'Play' });
    playBtn.children.push(playImg);

    function makeRow(trackId, folder) {
        const button = makeElement('IMG');
        button.classes.add('libPlayButton');
        const row = makeElement('LI');
        row.dataset.track = trackId;
        row.dataset.sourceFolder = folder;
        row.children.push(button);
        return { row: row, button: button };
    }

    const first = makeRow('local:aaa', 'library/album-a');
    const second = makeRow('global:bbb', 'library/album-b');

    function makeCard(folder) {
        const card = makeElement('DIV');
        card.classes.add('cardcontainer');
        card.dataset.folder = folder;

        // The card's own play control: an inline SVG, as the player renders it.
        const svg = makeElement('SVG');
        svg.innerHTML = '';
        const control = makeElement('DIV');
        control.classes.add('play');
        control.children.push(svg);
        card.children.push(control);

        return card;
    }

    const cards = {
        'library/album-a': makeCard('library/album-a'),
        'library/album-b': makeCard('library/album-b')
    };

    const rows = [first.row, second.row];
    const audio = makeAudio();

    const document = {
        querySelectorAll(selector) {
            if (selector === '.libPlayButton') return [first.button, second.button];
            if (selector === '.songslist li') return rows;
            if (selector === '.cardcontainer.now-playing') {
                return Object.values(cards).filter((card) => card.classes.has('now-playing'));
            }
            if (selector === '.cardcontainer') return Object.values(cards);
            return [];
        },
        querySelector(selector) {
            const match = /^\.cardcontainer\[data-folder="(.+)"\]$/.exec(selector);
            if (match) return cards[match[1]] || null;
            return null;
        }
    };

    const sandbox = {
        console: { error() {}, warn() {}, log() {} },
        document: document,
        window: { currentPlayingTrack: null, currentPlayingAlbum: null },
        basePath: '',
        currentsong: audio,
        playBtn: playBtn,
        currentLibButton: null,
        currentFolder: '',
        getButtonImg: (btn) => (btn ? btn.querySelector('img') : null)
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(playbackStateSource(), sandbox);

    return {
        sandbox: sandbox,
        audio: audio,
        playBtn: playBtn,
        playImg: playImg,
        rows: { local: first, global: second },
        cards: cards,
        /** What one album card's own play control shows. */
        cardControl(folder) {
            const control = cards[folder].querySelector('.play');
            return { label: control.getAttribute('aria-label'), icon: control.querySelector('svg').innerHTML };
        },
        /** What the playbar button currently shows. */
        playbar() {
            return { icon: playImg.src, label: playBtn.getAttribute('aria-label') };
        },
        /** Start a track the way playmusic() does. */
        start(trackId, sourceFolder, control) {
            sandbox.window.currentPlayingTrack = trackId;
            sandbox.window.currentPlayingAlbum = sourceFolder;
            audio.load('stream://' + trackId);
            sandbox.currentLibButton = control || null;
            sandbox.syncPlaybackUI();
            return sandbox.startAudioPlayback();
        }
    };
}

const PLAYING = 'img/pause.svg';
const PAUSED = 'img/play.svg';

// ============================================
// Tests
// ============================================

test('starting a track from an album shows Pause on every control', async () => {
    const player = buildPlayer();

    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    assert.strictEqual(player.audio.paused, false, 'the audio is playing');
    assert.deepStrictEqual(player.playbar(), { icon: PLAYING, label: 'Pause' });
    assert.strictEqual(player.rows.local.button.src, PLAYING);
    assert.strictEqual(player.rows.local.button.alt, 'Pause');
    assert.ok(player.cards['library/album-a'].classList.contains('now-playing'));
    assert.ok(!player.cards['library/album-a'].classList.contains('paused'));
    assert.strictEqual(player.cardControl('library/album-a').label, 'Pause', 'the card control follows too');
    assert.strictEqual(player.cardControl('library/album-b').label, 'Play');
});

test('the playbar button pauses the audio and then shows Play', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    await player.sandbox.togglePlayback();

    assert.strictEqual(player.audio.paused, true);
    assert.deepStrictEqual(player.playbar(), { icon: PAUSED, label: 'Play' });
    assert.strictEqual(player.rows.local.button.src, PAUSED);
    assert.ok(player.cards['library/album-a'].classList.contains('paused'), 'the card shows it is paused');
    assert.strictEqual(player.cardControl('library/album-a').label, 'Play');
});

test('the playbar button resumes the audio and then shows Pause', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);
    await player.sandbox.togglePlayback();

    await player.sandbox.togglePlayback();

    assert.strictEqual(player.audio.paused, false);
    assert.deepStrictEqual(player.playbar(), { icon: PLAYING, label: 'Pause' });
    assert.strictEqual(player.rows.local.button.src, PLAYING);
});

test('starting a second track moves Pause to it and leaves the first on Play', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    await player.start('global:bbb', 'library/album-b', player.rows.global.button);

    assert.strictEqual(player.sandbox.window.currentPlayingTrack, 'global:bbb');
    assert.strictEqual(player.audio.src, 'stream://global:bbb', 'one audio element, one source');
    assert.deepStrictEqual(player.playbar(), { icon: PLAYING, label: 'Pause' });
    assert.strictEqual(player.rows.global.button.src, PLAYING, 'the new track shows Pause');
    assert.strictEqual(player.rows.local.button.src, PAUSED, 'the previous track is back to Play');
    assert.ok(player.cards['library/album-b'].classList.contains('now-playing'));
    assert.ok(!player.cards['library/album-a'].classList.contains('now-playing'));
    assert.strictEqual(player.cardControl('library/album-b').label, 'Pause');
    assert.strictEqual(player.cardControl('library/album-a').label, 'Play', 'the previous card is back to Play');
    assert.strictEqual(player.audio.currentTime, 0, 'progress belongs to the new track');
});

test('a refused play() leaves the controls on Play', async () => {
    const player = buildPlayer();
    player.audio.failNextPlay = true;

    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    assert.strictEqual(player.audio.paused, true);
    assert.deepStrictEqual(player.playbar(), { icon: PAUSED, label: 'Play' }, 'no false Pause');
    assert.strictEqual(player.rows.local.button.src, PAUSED);
});

test('a track that ends with nothing after it shows Play', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    player.audio.finish();

    assert.deepStrictEqual(player.playbar(), { icon: PAUSED, label: 'Play' });
    assert.strictEqual(player.rows.local.button.src, PAUSED);
});

test('a track that ends and is followed by another shows Pause again', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    player.audio.finish();
    await player.start('global:bbb', 'library/album-b', player.rows.global.button);

    assert.deepStrictEqual(player.playbar(), { icon: PLAYING, label: 'Pause' });
    assert.strictEqual(player.rows.global.button.src, PLAYING);
    assert.strictEqual(player.audio.ended, false);
});

test('a local track and a global track use the same playback state', async () => {
    const local = buildPlayer();
    await local.start('local:aaa', 'library/album-a', local.rows.local.button);
    const afterLocal = local.playbar();

    const global = buildPlayer();
    await global.start('global:bbb', 'library/album-b', global.rows.global.button);
    const afterGlobal = global.playbar();

    assert.deepStrictEqual(afterGlobal, afterLocal, 'both sources end in the same state');

    // And pausing behaves the same way for both.
    await local.sandbox.togglePlayback();
    await global.sandbox.togglePlayback();
    assert.deepStrictEqual(global.playbar(), local.playbar());
});

test('progress on its own never turns the controls to Pause', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);
    await player.sandbox.togglePlayback();

    // Time and duration change while the audio stays paused: seeking, or a
    // duration arriving late. Neither is playback.
    player.audio.currentTime = 42;
    player.audio.duration = 210;
    player.sandbox.syncPlaybackUI();

    assert.deepStrictEqual(player.playbar(), { icon: PAUSED, label: 'Play' });
    assert.strictEqual(player.rows.local.button.src, PAUSED);
});

test('buffering mid-track does not flip the controls back to Play', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    // The browser stalls and recovers; the audio was never paused.
    player.audio.emit('waiting');
    player.audio.emit('stalled');
    player.sandbox.syncPlaybackUI();

    assert.deepStrictEqual(player.playbar(), { icon: PLAYING, label: 'Pause' });
});

test('with nothing loaded every control shows Play and no card is marked', () => {
    const player = buildPlayer();

    player.sandbox.syncPlaybackUI();

    assert.deepStrictEqual(player.playbar(), { icon: PAUSED, label: 'Play' });
    assert.strictEqual(player.rows.local.button.src, PAUSED);
    assert.strictEqual(player.rows.global.button.src, PAUSED);
    assert.ok(!player.cards['library/album-a'].classList.contains('now-playing'));
});

test('a row rebuilt by opening an album is the one that gets drawn', async () => {
    const player = buildPlayer();
    await player.start('local:aaa', 'library/album-a', player.rows.local.button);

    // The list is re-rendered: the player still holds the old row object.
    const stale = player.rows.local.button;
    const fresh = makeElement('IMG');
    fresh.classes.add('libPlayButton');
    player.rows.local.row.children[0] = fresh;

    player.sandbox.syncPlaybackUI();

    assert.strictEqual(fresh.src, PLAYING, 'the row on screen shows Pause');
    assert.strictEqual(player.sandbox.currentLibButton, fresh, 'the player follows the row on screen');
    assert.notStrictEqual(stale, fresh);
});

test('the player keeps no playing flag of its own', () => {
    // Every control is drawn from the audio element, through one function.
    assert.match(PLAYER_SOURCE, /function isAudioPlaying\(\) \{\s*return Boolean\(currentsong\.src\) && !currentsong\.paused && !currentsong\.ended;/);
    assert.match(PLAYER_SOURCE, /function syncPlaybackUI\(\)/);
    assert.match(PLAYER_SOURCE, /\['play', 'playing', 'pause', 'ended', 'emptied', 'error'\]\.forEach/);

    // No separate boolean anywhere, and no icon set outside the one renderer.
    assert.ok(!/\bisPlaying\s*=/.test(PLAYER_SOURCE), 'no independent playing flag');
    const iconWrites = PLAYER_SOURCE.match(/img\/(play|pause)\.svg/g) || [];
    const renderer = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function renderPlayPauseIcon'),
        PLAYER_SOURCE.indexOf('/** Every track row back to Play')
    );
    const insideRenderer = (renderer.match(/img\/(play|pause)\.svg/g) || []).length;
    const inMarkup = (PLAYER_SOURCE.match(/libPlayButton invert pointer" src="\$\{basePath\}img\/play\.svg/g) || []).length;
    assert.strictEqual(
        iconWrites.length,
        insideRenderer + inMarkup,
        'play and pause icons are only chosen in renderPlayPauseIcon'
    );

    // Playback is requested through one place, which waits for the result.
    assert.match(PLAYER_SOURCE, /async function startAudioPlayback\(\)[\s\S]{0,200}await currentsong\.play\(\)/);
    const requests = PLAYER_SOURCE.match(/currentsong\.play\(\)/g) || [];
    assert.strictEqual(requests.length, 1, 'play() is called in exactly one place');
});
