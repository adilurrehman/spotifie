'use strict';

/**
 * The album view, and the Now Playing view over it.
 *
 * Opening an album draws its cover, what it is and every song in it, from the
 * same list the sidebar is drawn from - so a personal addition, a hidden
 * track or a local edit shows up in both. Nothing here touches the audio: the
 * player carries on underneath, which is what the tests about opening and
 * closing are for.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** The album detail and Now Playing sections, on their own. */
function viewSource() {
    const start = PLAYER_SOURCE.indexOf('// ==================== Artwork for a track ====================');
    const end = PLAYER_SOURCE.indexOf('// Starting the application');
    assert.ok(start !== -1 && end > start, 'the album detail section was found');
    return PLAYER_SOURCE.slice(start, end);
}

// ============================================
// A stand-in for the page
// ============================================

function makeNode(tagName) {
    const node = {
        tagName: tagName,
        children: [],
        dataset: {},
        attributes: {},
        className: '',
        innerHTML: '',
        textContent: '',
        src: '',
        alt: '',
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        removeAttribute(name) {
            delete this.attributes[name];
            // src is a property as well as an attribute; clearing one clears both.
            if (name === 'src') this.src = '';
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        addEventListener() {},
        focus() {}
    };

    node.classList = {
        add() {},
        remove() {},
        toggle() {},
        contains() {
            return false;
        }
    };

    return node;
}

/** Load the album detail section with a page that has only what it draws on. */
function buildView(options) {
    const settings = options || {};
    const elements = {};

    [
        'albumDetail',
        'albumDetailCover',
        'albumDetailKind',
        'albumDetailTitle',
        'albumDetailArtist',
        'albumDetailFacts',
        'albumDetailDescription',
        'albumDetailPlay',
        'albumDetailTracks',
        'nowPlayingTitle',
        'nowPlayingArtist',
        'nowPlayingContext',
        'nowPlayingArtwork',
        'nowPlayingOverlay'
    ].forEach((id) => {
        elements[id] = makeNode('DIV');
    });

    const document = {
        getElementById(id) {
            return elements[id] || null;
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        createElement(tagName) {
            return makeNode(tagName.toUpperCase());
        },
        createDocumentFragment() {
            const fragment = makeNode('FRAGMENT');
            return fragment;
        },
        addEventListener() {}
    };

    const sandbox = {
        console: { warn() {}, error() {}, log() {} },
        document: document,
        window: {
            currentPlayingTrack: settings.playing || null,
            currentPlayingAlbum: settings.playingAlbum || null,
            currentSongsMeta: settings.meta || [],
            addEventListener() {}
        },
        Number: Number,
        Math: Math,
        Promise: Promise,
        basePath: '',
        currentFolder: settings.folder || '',
        albumInfo: settings.albumInfo || {},
        currentsong: { src: '', currentTime: 0, duration: 0 },
        elements: elements
    };

    // What the rest of the player answers when the view asks.
    sandbox.getLibraryTrack = (id) => (settings.tracks || {})[id] || null;
    // Whether a song is liked is one answer, given in one place; here it is a
    // stand-in for that place.
    sandbox.isTrackLiked = (id) => Boolean((settings.liked || []).includes(id));
    sandbox.escapeHTML = (value) => String(value === undefined || value === null ? '' : value);
    sandbox.defaultCoverSrc = () => 'img/music.svg';
    // The artwork resolver lives outside this section; these stand in for it
    // and answer the way it does.
    sandbox.usableArtworkUrl = (value) => {
        if (typeof value !== 'string' || !value.trim()) return null;
        if (/^(blob:|data:)/.test(value) || /^\/api\/catalog\//.test(value)) return null;
        return value;
    };
    sandbox.albumCoverSrcNow = (info) => sandbox.usableArtworkUrl(info && info.cover) || 'img/music.svg';
    sandbox.albumCoverIfAny = (info) => sandbox.usableArtworkUrl(info && info.cover);
    sandbox.libraryFolderForAlbum = (albumId) => 'library/' + albumId;
    sandbox.predefinedSongs = {};

    // The painters set what can be shown at once and wire the fallback; the
    // real ones then resolve, which needs a catalogue this sandbox has not got.
    sandbox.paintAlbumArtwork = (image, info) => {
        if (!image) return;
        image.onerror = () => {
            image.onerror = null;
            image.src = sandbox.defaultCoverSrc();
        };
        image.src = sandbox.albumCoverSrcNow(info);
    };
    sandbox.paintTrackArtwork = (image, trackId, folder) => {
        if (!image) return;
        image.onerror = () => {
            image.onerror = null;
            image.src = sandbox.defaultCoverSrc();
        };
        image.src = (trackId && sandbox.trackArtworkSrc(trackId, folder)) || sandbox.defaultCoverSrc();
    };
    sandbox.resolveAlbumCoverSrc = () => Promise.resolve(null);
    sandbox.albumCardArtist = (info) => (info && info.artist) || '';
    sandbox.formatDuration = (seconds) =>
        Number.isFinite(seconds) && seconds > 0 ? sandbox.secondsToMinutesSeconds(seconds) : '—:—';
    sandbox.secondsToMinutesSeconds = (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    sandbox.trackDisplayTitle = (id) => {
        const track = sandbox.getLibraryTrack(id);
        return track && track.title ? track.title : id;
    };
    sandbox.trackDisplayArtist = (id) => {
        const track = sandbox.getLibraryTrack(id);
        return track && track.artist ? track.artist : 'Unknown Artist';
    };
    sandbox.syncPlaybackUI = () => {};
    sandbox.syncSequenceUI = () => {};
    sandbox.updateProgressUI = () => {};
    sandbox.showToast = () => {};
    sandbox.expandBtn = null;

    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(viewSource(), sandbox);
    return sandbox;
}

const LOCAL = 'local:aaaaaaaaaaaa';
const GLOBAL = 'global:11111111-1111-4111-8111-111111111111';

const TRACKS = {
    [LOCAL]: { title: 'Riverbed', artist: 'Nova Rae', album: 'Local Music', duration: 201, artworkUrl: '' },
    [GLOBAL]: {
        title: 'Afterglow',
        artist: 'Nova Rae',
        album: 'Afterglow',
        duration: 245,
        artworkUrl: '/api/catalog/tracks/x/artwork',
        source: 'global'
    }
};

// ============================================
// What the page offers
// ============================================

test('the page has an album view and a Now Playing view, and neither is a queue', () => {
    assert.match(PAGE, /id="albumDetail"/);
    assert.match(PAGE, /id="albumDetailTracks"/);
    assert.match(PAGE, /id="nowPlayingOverlay"/);

    // Explicitly not offered: a queue, another device to play on, or a
    // second smaller player.
    assert.ok(!/id="queue|class="queue|Queue<|Add to queue/i.test(PAGE), 'no queue anywhere');
    assert.ok(!/Connect to a device|connect-device/i.test(PAGE), 'no device to connect to');
    assert.ok(!/mini-?player/i.test(PAGE), 'no mini player');
});

test('every control in the player is a real button and says what it does', () => {
    const wanted = [
        'aria-label="Previous track"',
        'aria-label="Next track"',
        'aria-label="Shuffle"',
        'aria-label="Repeat off"',
        'aria-label="Expand player"',
        'aria-label="Close Now Playing"',
        // The header's two chevrons are the app's only history controls.
        'aria-label="Go back"',
        'aria-label="Go forward"'
    ];

    wanted.forEach((label) => assert.ok(PAGE.includes(label), 'the player offers ' + label));

    // The seek bars carry the values a screen reader reads out.
    const sliders = PAGE.match(/role="slider"/g) || [];
    assert.ok(sliders.length >= 2, 'the playbar and Now Playing both have a seek bar');
    assert.match(PAGE, /aria-valuemin="0"[^>]*aria-valuemax="100"[^>]*aria-valuenow="0"/);
});

// ============================================
// Drawing one album
// ============================================

test('an album shows its cover, what it is, and how much of it there is', () => {
    const view = buildView({
        folder: 'library/global-album:1',
        albumInfo: {
            'library/global-album:1': {
                title: 'Afterglow',
                artist: 'Nova Rae',
                description: 'A record.',
                cover: '/cover.jpg',
                source: 'global'
            }
        },
        tracks: TRACKS,
        meta: [
            { track: GLOBAL, sourceFolder: 'library/global-album:1' },
            { track: LOCAL, sourceFolder: 'library/system:local-music', isUserAdded: true }
        ]
    });

    view.renderAlbumDetail('library/global-album:1');

    assert.strictEqual(view.elements.albumDetailTitle.textContent, 'Afterglow');
    assert.strictEqual(view.elements.albumDetailArtist.textContent, 'Nova Rae');
    assert.strictEqual(view.elements.albumDetailKind.textContent, 'Published album');
    assert.strictEqual(view.elements.albumDetailDescription.textContent, 'A record.');

    // Two songs, 245 + 201 seconds, said the way a person would say it.
    assert.strictEqual(view.elements.albumDetailFacts.textContent, '2 songs · 7 min');
    assert.strictEqual(view.elements.albumDetailPlay.dataset.folder, 'library/global-album:1');
});

test('every song in an album is listed, with its number, picture, name and length', () => {
    const view = buildView({
        folder: 'library/album',
        albumInfo: { 'library/album': { title: 'Afterglow', cover: '/cover.jpg' } },
        tracks: TRACKS,
        meta: [
            { track: GLOBAL, sourceFolder: 'library/album' },
            { track: LOCAL, sourceFolder: 'library/album' }
        ]
    });

    view.renderAlbumDetail('library/album');

    const rows = view.elements.albumDetailTracks.children[0].children;
    assert.strictEqual(rows.length, 2, 'both songs are listed');

    assert.match(rows[0].innerHTML, /album-track-index">1</);
    assert.match(rows[0].innerHTML, /Afterglow/);
    assert.match(rows[0].innerHTML, /Nova Rae/);
    assert.match(rows[0].innerHTML, /04:05/, 'its length is shown');
    assert.match(rows[0].innerHTML, /album-track-menu/, 'and the way into the rest');
    assert.strictEqual(rows[0].dataset.track, GLOBAL, 'the row is the track id, not its name');

    // A song with no picture of its own falls back to the album's, and is
    // still listed either way.
    assert.match(rows[0].innerHTML, /src="\/api\/catalog\/tracks\/x\/artwork"/);
    assert.match(rows[1].innerHTML, /src="\/cover\.jpg"/);
    assert.match(rows[1].innerHTML, /Riverbed/);
});

test('a song with no picture anywhere still gets a row, and a default picture', () => {
    const view = buildView({
        folder: 'library/album',
        albumInfo: { 'library/album': { title: 'Nothing pictured' } },
        tracks: { [LOCAL]: { title: 'Riverbed', artist: 'Nova Rae', duration: 60 } },
        meta: [{ track: LOCAL, sourceFolder: 'library/album' }]
    });

    view.renderAlbumDetail('library/album');

    const rows = view.elements.albumDetailTracks.children[0].children;
    assert.strictEqual(rows.length, 1);
    assert.match(rows[0].innerHTML, /src="img\/music\.svg"/);
});

test('an empty album says so instead of listing nothing', () => {
    const view = buildView({
        folder: 'library/album',
        albumInfo: { 'library/album': { title: 'Empty' } },
        meta: []
    });

    view.renderAlbumDetail('library/album');

    assert.match(view.elements.albumDetailTracks.innerHTML, /album-track-empty/);
    assert.strictEqual(view.elements.albumDetailFacts.textContent, '0 songs');
});

test('Local Music is shown as this machine\'s own collection', () => {
    const view = buildView({
        folder: 'library/system:local-music',
        albumInfo: {
            'library/system:local-music': { title: 'Local Music', isSystemCollection: true }
        },
        tracks: TRACKS,
        meta: [{ track: LOCAL, sourceFolder: 'library/system:local-music' }]
    });

    view.renderAlbumDetail('library/system:local-music');

    assert.strictEqual(view.elements.albumDetailTitle.textContent, 'Local Music');
    assert.strictEqual(view.elements.albumDetailKind.textContent, 'On this device');
    assert.strictEqual(view.elements.albumDetailFacts.textContent, '1 song · 3 min');
});

test('an album someone made themselves is named as theirs', () => {
    const view = buildView({
        albumInfo: { 'library/mine': { title: 'Late nights', isUserAlbum: true } },
        meta: []
    });

    view.renderAlbumDetail('library/mine');
    assert.strictEqual(view.elements.albumDetailKind.textContent, 'Your album');
});

// ============================================
// Now Playing
// ============================================

test('Now Playing shows the track the player is on, with a picture that always resolves', () => {
    const view = buildView({
        playing: GLOBAL,
        playingAlbum: 'library/album',
        albumInfo: { 'library/album': { title: 'Afterglow', cover: '/cover.jpg' } },
        tracks: TRACKS
    });

    view.openNowPlaying();

    assert.strictEqual(view.elements.nowPlayingTitle.textContent, 'Afterglow');
    assert.strictEqual(view.elements.nowPlayingArtist.textContent, 'Nova Rae');
    assert.strictEqual(view.elements.nowPlayingContext.textContent, 'Afterglow');
    assert.strictEqual(view.elements.nowPlayingArtwork.src, '/api/catalog/tracks/x/artwork');
});

test('a track with no picture of its own borrows the album\'s, then the default', () => {
    const withAlbumCover = buildView({
        playing: LOCAL,
        playingAlbum: 'library/album',
        albumInfo: { 'library/album': { title: 'Afterglow', cover: '/cover.jpg' } },
        tracks: TRACKS
    });
    withAlbumCover.openNowPlaying();
    assert.strictEqual(withAlbumCover.elements.nowPlayingArtwork.src, '/cover.jpg');

    const withNothing = buildView({
        playing: LOCAL,
        playingAlbum: 'library/album',
        albumInfo: { 'library/album': { title: 'Afterglow' } },
        tracks: TRACKS
    });
    withNothing.openNowPlaying();
    assert.strictEqual(withNothing.elements.nowPlayingArtwork.src, 'img/music.svg');
});

test('a closed Now Playing holds no picture, however many tracks go by', () => {
    const view = buildView({
        playing: GLOBAL,
        playingAlbum: 'library/album',
        albumInfo: { 'library/album': { title: 'Afterglow', cover: '/cover.jpg' } },
        tracks: TRACKS
    });

    // Starting a track redraws this view; while it is closed there is nothing
    // to draw, and the one picture measured against the viewport is not
    // loaded at all.
    view.renderNowPlaying();
    assert.strictEqual(view.elements.nowPlayingArtwork.src, '', 'no picture while closed');

    view.openNowPlaying();
    assert.strictEqual(view.elements.nowPlayingArtwork.src, '/api/catalog/tracks/x/artwork', 'and one once open');

    view.closeNowPlaying();
    assert.strictEqual(view.elements.nowPlayingArtwork.src, '', 'handed back when it closes');
});

test('opening or closing Now Playing never touches the audio', () => {
    const source = viewSource();
    const opening = source.slice(source.indexOf('function openNowPlaying'), source.indexOf('function initNowPlaying'));

    assert.ok(opening.length > 0, 'the two functions were found');
    assert.ok(!/currentsong\.(src|play|pause|load|currentTime)/.test(opening), 'no audio is loaded, moved or stopped');
    assert.ok(!/playmusic\(/.test(opening), 'and no track is started again');
});

// ============================================
// How an album is reached, and what it is made of
// ============================================

test('a card opens the album; the card\'s own play control plays it', () => {
    // One listener on the grid, not one per card: the cards are rebuilt
    // whenever anything changes, and binding to each of them meant every
    // rebuild had to remember to bind again. Missing it once stopped the whole
    // library opening.
    const binding = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function bindAlbumCardEvents()'),
        PLAYER_SOURCE.indexOf('function toggleCardMenu(button)')
    );

    assert.ok(binding.length > 0, 'the card binding was found');
    assert.match(binding, /cardsArea\.addEventListener\('click'/, 'delegated from the container');
    assert.match(binding, /const card = event\.target\.closest\('\.cardcontainer'\);/);
    assert.match(binding, /await openAlbumDetail\(folder\)/);
    assert.match(binding, /if \(event\.target\.closest\('\.play'\)\)[\s\S]{0,200}playAlbumFromCard\(folder\)/);

    // Attached once, so a rerender can never take navigation away.
    assert.match(binding, /if \(!cardsArea \|\| cardsArea\.dataset\.bound === 'yes'\) return;/);
    assert.match(binding, /cardsArea\.dataset\.bound = 'yes';/);

    // The folder is carried through exactly as it was rendered - no prefix
    // stripped, nothing parsed as a number - so every kind of album reaches
    // the same resolver.
    assert.match(binding, /const folder = card\.dataset\.folder;/);
    assert.ok(!/parseInt|Number\(folder\)|replace\(/.test(binding), 'the id is not rewritten on the way');
});

test('the grid is wired after it is in the page, never while it is detached', () => {
    const render = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function refreshAlbumCards()'),
        PLAYER_SOURCE.indexOf('\nasync function ', PLAYER_SOURCE.indexOf('async function refreshAlbumCards()') + 1)
    );

    // Built away from the document so the library never blinks, then put in
    // place, and only then asked about. Anything that queries the page has to
    // come after the swap or it finds nothing.
    const swap = render.indexOf('cardsArea.replaceChildren(grid);');
    const bind = render.indexOf('bindAlbumCardEvents();');
    const gate = render.indexOf('applyAccountGating();');

    assert.ok(swap !== -1, 'the grid is swapped in one go');
    assert.ok(bind > swap, 'wiring happens once the cards are in the page');
    assert.ok(gate > swap, 'and so does the gating that looks for them');
});

test('the album view is drawn from the same effective list as the sidebar', () => {
    // getsongs() is what applies a person's own additions and removals, and
    // it is what the album view is built from - so the two can never disagree.
    assert.match(PLAYER_SOURCE, /async function navRenderEntry\(entry\)[\s\S]{0,600}await getsongs\(entry\.albumId\)/);
    assert.match(PLAYER_SOURCE, /if \(typeof albumDetailFolder !== 'undefined' && albumDetailFolder === folder\) renderAlbumDetail\(folder\)/);
    assert.match(PLAYER_SOURCE, /LibraryDB\.getEffectiveSongsForAlbum\(folder, serverSongs\)/);
});

test('opening an album plays nothing, and writes nothing to the catalogue', () => {
    const showing = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('async function navRenderEntry(entry)'),
        PLAYER_SOURCE.indexOf('async function navigateTo(entry)')
    );

    assert.ok(showing.length > 0, 'the function was found');
    assert.ok(!/playmusic\(|startAudioPlayback\(/.test(showing), 'browsing an album does not start it');
    assert.ok(!/createGlobal|updateGlobal|deleteGlobal|setAlbumOverride/.test(showing), 'and changes nothing shared');
});

test('the album play button starts the album that is open, shuffled when shuffle is on', () => {
    const playing = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function playAlbumFromDetail(folder)'),
        PLAYER_SOURCE.indexOf('function initAlbumDetail()')
    );

    assert.ok(playing.length > 0, 'the function was found');
    assert.match(playing, /window\.currentPlayingAlbum === folder && currentsong\.src[\s\S]{0,120}togglePlayback\(\)/);
    assert.match(playing, /shuffleEnabled \? shuffledFrom\(ids, null\)\[0\] : ids\[0\]/);
});

test('the album view carries no queue, no other device and no second player', () => {
    const view = viewSource();

    assert.ok(!/queue/i.test(view), 'nothing here is a queue');
    assert.ok(!/connect.{0,12}device|castDevice/i.test(view), 'nothing here plays somewhere else');
    assert.ok(!/mini-?player/i.test(view), 'there is one player');
});

// ============================================
// Which picture a song is shown with
// ============================================

const WITH_COVER = 'library/album-with-cover';
const NO_COVER = 'library/system:local-music';

/** A view whose catalogue holds one album with a cover and one without. */
function buildArtwork(track) {
    return buildView({
        folder: NO_COVER,
        albumInfo: {
            [NO_COVER]: { title: 'Local Music', isSystemCollection: true },
            [WITH_COVER]: { title: 'Afterglow', cover: '/album-cover.jpg' }
        },
        tracks: { 'local:song': track }
    });
}

test('a song shows its own picture before anything else', () => {
    const view = buildArtwork({
        title: 'Riverbed',
        albumId: 'album-with-cover',
        artworkUrl: '/track-cover.jpg'
    });

    assert.strictEqual(view.trackArtworkSrc('local:song', NO_COVER), '/track-cover.jpg');
});

test('a song with no picture of its own borrows its album\'s', () => {
    // Played from Local Music, which is a collection with no cover - the
    // album the song belongs to is the one that has one.
    const view = buildArtwork({ title: 'Riverbed', albumId: 'album-with-cover' });

    assert.strictEqual(view.trackArtworkSrc('local:song', NO_COVER), '/album-cover.jpg');
});

test('a song shows the cover of the collection it is played from when it has no album of its own', () => {
    const view = buildView({
        folder: WITH_COVER,
        albumInfo: { [WITH_COVER]: { title: 'Made by me', cover: '/mine.jpg' } },
        tracks: { 'local:song': { title: 'Riverbed' } }
    });

    assert.strictEqual(view.trackArtworkSrc('local:song', WITH_COVER), '/mine.jpg');
});

test('a song with no picture anywhere falls back to the default, never to nothing', () => {
    const view = buildArtwork({ title: 'Riverbed', albumId: 'system:local-music' });

    const chosen = view.trackArtworkSrc('local:song', NO_COVER);
    assert.strictEqual(chosen, 'img/music.svg');
    assert.ok(chosen, 'a picture is always chosen');

    // A track the catalogue has never heard of still gets one.
    assert.strictEqual(view.trackArtworkSrc('local:unknown', NO_COVER), 'img/music.svg');
});

test('the picture chosen is never a path from the filesystem, and never inline data', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const resolver = source.slice(
        source.indexOf('function usableArtworkUrl(value)'),
        source.indexOf('function paintAlbumArtwork(image, info, folder)')
    );

    assert.ok(resolver.length > 0, 'the resolver was found');

    // It answers with what the catalogue gave it - a URL this server serves -
    // or with nothing, so the caller falls back. It never builds one out of
    // anything else. The prose is not the code, so it is set aside first.
    const code = resolver.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/relativePath|absolute|fileName|file:\/\//.test(code), 'no filesystem path is used');

    // The three things it refuses outright, each named in it.
    assert.match(resolver, /looksLikeFilePath\(cover\)/, 'a place on a disk is refused');
    assert.match(resolver, /cover\.startsWith\('blob:'\)/, 'a handle from a previous visit is refused');
    assert.match(resolver, /cover\.startsWith\('data:'\)/, 'a picture written inline is refused');

    // And a refusal ends the search rather than passing the value on.
    const refusals = resolver.match(/return null;/g) || [];
    assert.ok(refusals.length >= 3, 'each refusal answers with nothing');
});

test('the playbar and Now Playing ask the one painter, and both fall back on error', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    // Neither writes a source of its own: both hand the element to the one
    // painter, which is where the fallback and the resolving live.
    const playbar = source.slice(
        source.indexOf('function renderPlaybarTrack(trackId, track)'),
        source.indexOf('function updateProgressUI()')
    );
    assert.match(playbar, /paintTrackArtwork\(artwork, trackId, window\.currentPlayingAlbum\);/);
    assert.ok(!/artwork\.src =/.test(playbar), 'the playbar does not choose a picture itself');

    const nowPlaying = source.slice(
        source.indexOf('function renderNowPlaying()'),
        source.indexOf('function openNowPlaying()')
    );
    assert.match(nowPlaying, /paintTrackArtwork\(artwork, trackId, window\.currentPlayingAlbum\);/);

    // The painter puts the default up at once, wires the fallback before it
    // asks for anything, and swaps in what it resolves.
    const painter = source.slice(
        source.indexOf('function paintResolvedArtwork(image, key, resolve, forget)'),
        source.indexOf('function paintAlbumArtwork(image, info, folder)')
    );
    assert.ok(painter.length > 0, 'the painter was found');
    assert.ok(
        painter.indexOf('image.onerror = () =>') < painter.indexOf('showDefaultArtwork(image);\n\n    Promise'),
        'the fallback is ready before the picture is asked for'
    );

    // A failure drops the address, tries once more, and then stands on the
    // default - and the handler stays in place for any later failure.
    assert.match(painter, /if \(typeof forget === 'function'\) forget\(\);/);
    assert.match(painter, /if \(image\.dataset\.artworkRetried === 'yes'\) return;/);
    assert.ok(!/image\.onerror = null/.test(painter), 'the handler is never taken away');
});
