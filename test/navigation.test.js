'use strict';

/**
 * Which view the page shows, and how it gets there.
 *
 * Two things are checked here. First, that a refresh cannot paint a view the
 * app has not chosen: the album view is closed by the document itself, not by
 * a script that arrives later, and nothing on the page names a picture before
 * there is something to show one for. Second, that the header's two chevrons
 * are the app's own history - they move between views the app has shown, they
 * say plainly when there is nowhere to go, and they never touch the audio.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const STYLES = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

/** The navigation manager, on its own. */
/** One @media block, from its brace to the one that closes it. */
function mediaBlock(query) {
    const start = STYLES.indexOf(query);
    assert.ok(start !== -1, query + ' was found');

    let depth = 0;
    for (let i = STYLES.indexOf('{', start); i < STYLES.length; i += 1) {
        if (STYLES[i] === '{') depth += 1;
        if (STYLES[i] === '}') {
            depth -= 1;
            if (depth === 0) return STYLES.slice(start, i + 1);
        }
    }
    throw new Error(query + ' is never closed');
}

function navigationSource() {
    const start = PLAYER_SOURCE.indexOf('// ==================== Navigation ====================');
    const end = PLAYER_SOURCE.indexOf('// ==================== Album detail ====================');
    assert.ok(start !== -1 && end > start, 'the navigation section was found');
    return PLAYER_SOURCE.slice(start, end);
}

// navEntries and navIndex belong to the script, so a test cannot read them
// from outside. These lines are appended to the section under test so it can
// report the same values the manager is using.
const NAV_EXPORTS = `
globalThis.readNavState = function () {
    return { entries: navEntries.map(function (e) { return Object.assign({}, e); }), index: navIndex };
};
`;

// ============================================
// A stand-in for the page
// ============================================

function makeNode(id) {
    const classes = new Set();

    return {
        id: id,
        hidden: false,
        disabled: false,
        attributes: {},
        classes: classes,
        classList: {
            add(name) {
                classes.add(name);
            },
            remove(name) {
                classes.delete(name);
            },
            contains(name) {
                return classes.has(name);
            },
            toggle(name, on) {
                if (on === undefined) return classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true);
                if (on) classes.add(name);
                else classes.delete(name);
                return Boolean(on);
            }
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        addEventListener(type, handler) {
            (this.handlers = this.handlers || {})[type] = handler;
        },
        click() {
            // A disabled button is not a button anybody can press.
            if (this.disabled) return;
            if (this.handlers && this.handlers.click) this.handlers.click();
        }
    };
}

/** Load the navigation manager with the two views it moves between. */
function buildNavigation() {
    const elements = {
        albumDetail: makeNode('albumDetail'),
        navBack: makeNode('navBack'),
        navForward: makeNode('navForward')
    };
    const playlist = makeNode('playlist');

    // The album view starts closed, exactly as the document leaves it.
    elements.albumDetail.hidden = true;

    const loaded = [];

    const sandbox = {
        console: { warn() {}, error() {}, log() {} },
        document: {
            getElementById(id) {
                return elements[id] || null;
            },
            querySelector(selector) {
                return selector === '.playlist' ? playlist : null;
            },
            querySelectorAll() {
                return [];
            }
        },
        window: {},
        Object: Object,
        elements: elements,
        playlist: playlist,
        loaded: loaded,
        albumDetailFolder: null,
        // The audio, only so a test can prove nothing here touches it.
        audio: { track: 'local:aaaaaaaa', playing: true, currentTime: 61.5, volume: 0.4 }
    };

    sandbox.albumDetailSection = () => elements.albumDetail;
    sandbox.getsongs = (folder) => {
        loaded.push(folder);
        return Promise.resolve([]);
    };
    sandbox.hideSearchResults = () => {};

    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(navigationSource() + NAV_EXPORTS, sandbox);

    sandbox.initNavigation();
    return sandbox;
}

const ALBUM_A = 'library/global-album:aaaa1111-1111-4111-8111-111111111111';
const ALBUM_B = 'library/local-album:bbbb2222';
const ALBUM_C = 'library/system:local-music';

// ============================================
// What a refresh is allowed to paint
// ============================================

test('the album view is closed by the page itself, not by a script arriving later', () => {
    const section = /<section class="album-detail"[^>]*>/.exec(PAGE);
    assert.ok(section, 'the album view is in the page');
    assert.match(section[0], /\shidden\b/, 'it carries the hidden attribute from the start');
    assert.match(section[0], /aria-hidden="true"/);

    // Hidden means hidden, whatever else a rule further down says about it.
    assert.match(STYLES, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('Now Playing is closed by the page too', () => {
    const overlay = /<div id="nowPlayingOverlay"[^>]*>/.exec(PAGE);
    assert.ok(overlay, 'the Now Playing view is in the page');
    assert.match(overlay[0], /\shidden\b/);
});

test('nothing on the page names a picture before there is a track to show one for', () => {
    // A cover with a fallback already in its src is a full-size picture the
    // browser can paint before the app has decided anything.
    ['albumDetailCover', 'nowPlayingArtwork', 'playbarArtwork'].forEach((id) => {
        const tag = new RegExp('<img[^>]*id="' + id + '"[^>]*>').exec(PAGE);
        assert.ok(tag, id + ' is in the page');
        assert.ok(!/\ssrc=/.test(tag[0]), id + ' has no picture until one is chosen');
    });
});

test('the app opens on the library, whatever was open last time', () => {
    const nav = buildNavigation();
    const state = nav.readNavState();

    assert.strictEqual(state.entries.length, 1, 'one view has been shown');
    assert.strictEqual(state.entries[0].type, 'library');
    assert.strictEqual(state.index, 0);

    // Starting up loads no album, so no album view can be drawn on the way.
    assert.strictEqual(nav.loaded.length, 0, 'no album is opened at startup');
    assert.strictEqual(nav.elements.albumDetail.hidden, true, 'the album view stays closed');
});

// ============================================
// Back and forward
// ============================================

test('with nothing behind or ahead, both chevrons are disabled', () => {
    const nav = buildNavigation();

    assert.strictEqual(nav.elements.navBack.disabled, true);
    assert.strictEqual(nav.elements.navForward.disabled, true);
});

test('opening an album gives Back somewhere to go', async () => {
    const nav = buildNavigation();
    await nav.navigateTo({ type: 'album', albumId: ALBUM_A });

    assert.strictEqual(nav.elements.navBack.disabled, false, 'Back leads to the library');
    assert.strictEqual(nav.elements.navForward.disabled, true, 'there is still nothing ahead');
    assert.strictEqual(nav.elements.albumDetail.hidden, false, 'the album is showing');
    assert.ok(nav.elements.albumDetail.classes.has('is-open'), 'and the stylesheet has been told so too');
    assert.strictEqual(nav.playlist.hidden, true, 'and the library is not');
    assert.deepStrictEqual(Array.from(nav.loaded), [ALBUM_A]);
});

test('Back returns to the view before, and Forward returns to the one after', async () => {
    const nav = buildNavigation();
    await nav.navigateTo({ type: 'album', albumId: ALBUM_A });

    await nav.navGoBack();
    assert.strictEqual(nav.elements.albumDetail.hidden, true, 'the library is showing again');
    assert.ok(!nav.elements.albumDetail.classes.has('is-open'), 'and the album view is closed both ways');
    assert.strictEqual(nav.playlist.hidden, false);
    assert.strictEqual(nav.elements.navBack.disabled, true, 'and there is nothing behind it');
    assert.strictEqual(nav.elements.navForward.disabled, false, 'the album is ahead now');

    await nav.navGoForward();
    assert.strictEqual(nav.elements.albumDetail.hidden, false, 'the album is showing again');
    assert.strictEqual(nav.readNavState().entries[nav.readNavState().index].albumId, ALBUM_A);
    assert.strictEqual(nav.elements.navForward.disabled, true, 'and nothing is ahead of it');
});

test('going back and then somewhere new drops the branch that was ahead', async () => {
    const nav = buildNavigation();

    await nav.navigateTo({ type: 'album', albumId: ALBUM_A });
    await nav.navigateTo({ type: 'album', albumId: ALBUM_B });
    await nav.navGoBack();

    // Back at album A, with B ahead. Opening C is a different turn, so B goes.
    await nav.navigateTo({ type: 'album', albumId: ALBUM_C });

    const state = nav.readNavState();
    assert.deepStrictEqual(
        Array.from(state.entries, (entry) => entry.albumId || entry.type),
        ['library', ALBUM_A, ALBUM_C]
    );
    assert.strictEqual(state.index, 2);
    assert.strictEqual(nav.elements.navForward.disabled, true, 'nothing is ahead of where we turned');
});

test('a chevron with nowhere to go does nothing when pressed', async () => {
    const nav = buildNavigation();

    nav.elements.navBack.click();
    nav.elements.navForward.click();
    assert.strictEqual(nav.readNavState().index, 0, 'the page has not moved');

    await nav.navigateTo({ type: 'album', albumId: ALBUM_A });
    nav.elements.navForward.click();
    assert.strictEqual(nav.readNavState().index, 1, 'and still has not');
});

test('an entry says which album, not what an album is', () => {
    const source = navigationSource();

    // Only ids are recorded: an album is looked up again when it is restored,
    // so a history entry can never hold a stale copy of one.
    assert.match(source, /navEntries\.push\(entry\)/);
    assert.match(source, /entry\.albumId/, 'an entry is read back as an id');
    assert.ok(!/albumInfo\[|predefinedSongs\[/.test(source), 'no album data is stored in history');

    // And an id is all that is put in.
    assert.match(PLAYER_SOURCE, /navigateTo\(\{ type: NAV_ALBUM, albumId: folder \}\)/);
});

test('moving between views never touches the audio', () => {
    const source = navigationSource();

    assert.ok(!/currentsong|playmusic\(|startAudioPlayback|togglePlayback/.test(source), 'no playback call anywhere');
    assert.ok(!/shuffleEnabled|repeatMode|trackProgress|\.volume/.test(source), 'and no player state either');
});

test('the app never hands its Back to the browser', () => {
    const source = navigationSource();

    // The app's own stack is the authority, so Back cannot land on whatever
    // page somebody was on before they opened Spotifie.
    assert.ok(!/history\.(pushState|back|replaceState|go)\(/.test(source), 'the browser history is left alone');

    // The one browser entry the app pushes belongs to Now Playing, and popping
    // it only closes that view.
    const popstate = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf("window.addEventListener('popstate'"),
        PLAYER_SOURCE.indexOf("window.addEventListener('popstate'") + 260
    );
    assert.match(popstate, /if \(nowPlayingOpen\) closeNowPlaying\(\{ fromHistory: true \}\)/);
});

// ============================================
// The album view has no history control of its own
// ============================================

test('the extra Back button inside the album is gone, and leaves no gap', () => {
    assert.ok(!/albumDetailBack/.test(PAGE), 'no second back button in the page');
    assert.ok(!/albumDetailBack/.test(PLAYER_SOURCE), 'and nothing wires one up');

    // Its styles went with it, so nothing reserves the space it used to take.
    assert.ok(!/\.album-detail-back/.test(STYLES), 'and no rule is left holding its place');

    // The album view starts with its header, not with a row above it.
    assert.match(PAGE, /<section class="album-detail"[^>]*>\s*<header class="album-detail-hero">/);
});

// ============================================
// How the chevrons look, and where they work
// ============================================

test('both states of a chevron are drawn by this stylesheet, in theme colours', () => {
    const enabled = /\.nav-history-btn \{[^}]*\}/.exec(STYLES);
    assert.ok(enabled, 'the control has a rule of its own');
    assert.match(enabled[0], /color:\s*var\(--text-secondary\)/, 'readable in either theme');

    const disabled = /\.nav-history-btn:disabled \{[^}]*\}/.exec(STYLES);
    assert.ok(disabled, 'and so does the state where there is nowhere to go');
    assert.match(disabled[0], /color:\s*var\(--text-muted\)/, 'muted, not invisible');
    assert.match(disabled[0], /cursor:\s*default/, 'and it does not invite a click');

    // Hover belongs to a control that can actually do something.
    assert.match(STYLES, /\.nav-history-btn:not\(:disabled\):hover/);
    assert.match(STYLES, /\.nav-history-btn:not\(:disabled\):focus-visible/);
});

test('the chevrons are real buttons, and say what they do', () => {
    assert.match(PAGE, /<button type="button" id="navBack" class="nav-history-btn[^>]*aria-label="Go back" disabled>/);
    assert.match(
        PAGE,
        /<button type="button" id="navForward" class="nav-history-btn[^>]*aria-label="Go forward" disabled>/
    );
});

test('a phone keeps its chevrons, at a size a thumb can hit', () => {
    // They used to be hidden below 600px, which left a phone with no way back.
    assert.ok(!/\.nav button:not\(\.hamburger\) \{\s*display:\s*none/.test(STYLES), 'nothing hides them');

    // The phone breakpoint the header compacts at.
    const mobile = mediaBlock('@media screen and (max-width: 545px)');
    const sized = /\.nav-history-btn \{\s*width:\s*(\d+)px;\s*height:\s*(\d+)px;/.exec(mobile);
    assert.ok(sized, 'and it sizes them for a phone');
    assert.ok(Number(sized[1]) >= 36 && Number(sized[2]) >= 36, 'at least 36px across');
});

test('Now Playing is opened and closed the same way the page closed it', () => {
    // The document keeps this view closed with the hidden attribute, so the
    // code that opens it has to speak the same language: a class the
    // stylesheet no longer knows about would leave it shut for good.
    const opening = PLAYER_SOURCE.slice(
        PLAYER_SOURCE.indexOf('function openNowPlaying()'),
        PLAYER_SOURCE.indexOf('function initNowPlaying()')
    );

    assert.ok(opening.length > 0, 'the two functions were found');

    // The document keeps it out of the page, and the stylesheet keeps it
    // closed by default; opening it takes both, so neither alone failing can
    // leave a window-sized picture on screen.
    assert.match(opening, /overlay\.hidden = false;/);
    assert.match(opening, /overlay\.classList\.add\('is-open'\);/);
    assert.match(opening, /overlay\.hidden = true;/);
    assert.match(opening, /overlay\.classList\.remove\('is-open'\);/);
});

test('an album that is deleted stops being somewhere Back can land', async () => {
    const nav = buildNavigation();

    await nav.navigateTo({ type: 'album', albumId: ALBUM_A });
    await nav.navigateTo({ type: 'album', albumId: ALBUM_B });
    await nav.navigateTo({ type: 'album', albumId: ALBUM_A });

    await nav.navForgetAlbum(ALBUM_A);

    const state = nav.readNavState();
    assert.deepStrictEqual(
        Array.from(state.entries, (entry) => entry.albumId || entry.type),
        ['library', ALBUM_B]
    );

    // It was the view on screen, so the library took its place.
    assert.strictEqual(state.index, 1);
    assert.strictEqual(nav.elements.albumDetail.hidden, false, 'the view that is left is shown');
});

test('deleting the only album shown falls back to the library', async () => {
    const nav = buildNavigation();
    await nav.navigateTo({ type: 'album', albumId: ALBUM_A });

    await nav.navForgetAlbum(ALBUM_A);

    const state = nav.readNavState();
    assert.strictEqual(state.entries.length, 1);
    assert.strictEqual(state.entries[0].type, 'library');
    assert.strictEqual(nav.elements.albumDetail.hidden, true, 'the album view is closed');
    assert.ok(!nav.elements.albumDetail.classes.has('is-open'));
    assert.strictEqual(nav.playlist.hidden, false, 'and the library is back');
    assert.strictEqual(nav.elements.navBack.disabled, true);
    assert.strictEqual(nav.elements.navForward.disabled, true);
});

// ============================================
// A view restored is a view rebuilt
// ============================================

test('history keeps stable ids, never an album with a picture in it', () => {
    const section = navigationSource();

    // What is remembered is what to show, not what it looked like: an album is
    // its folder id and nothing else, so nothing temporary can be restored.
    assert.match(section, /navEntries\.push\(entry\)/);

    // The prose is not the code, so it is set aside before looking.
    const code = section.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // An entry carries what to show and nothing about how it looked: no
    // address is read from one, and none is put into one.
    assert.ok(!/entry\.(cover|artwork|artworkUrl)/i.test(code), 'nothing reads a picture out of an entry');
    assert.ok(!/\.src\s*=\s*(?!'')/.test(code.replace(/removeAttribute\('src'\)/g, '')), 'and none puts one on screen from memory');
    assert.ok(!/localStorage|sessionStorage/.test(code), 'and the history is not written down');
});

test('going back to an album builds it again rather than restoring what it looked like', () => {
    const section = navigationSource();

    // Restoring an entry loads the album's songs again, which is what redraws
    // its cover; there is nothing kept from last time to put back.
    assert.match(section, /async function navRenderEntry\(entry\)[\s\S]{0,700}await getsongs\(entry\.albumId\)/);

    const restoring = section.slice(section.indexOf('async function navRenderEntry(entry)'), section.indexOf('async function navigateTo(entry)'));
    assert.ok(!/\.src\s*=/.test(restoring), 'nothing puts a remembered picture back');
});
