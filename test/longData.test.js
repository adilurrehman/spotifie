'use strict';

/**
 * Names nobody expected, and how the page survives them.
 *
 * Music metadata is written by whoever made the file. A track title can be a
 * sentence, an album name can be a paragraph somebody pasted, and an artist
 * field can be a URL, an emoji, or a piece of markup. None of that may break
 * the layout, and none of it may become part of the page.
 *
 * What is held here is the part that is decidable without a browser: that the
 * places long text lands are told to truncate rather than to grow, and that
 * metadata is escaped or set as text wherever it is drawn. How wide the result
 * is at 320 px is measured in responsiveOverflow.test.js, against the real
 * pages.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STYLE = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const PLAYER = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

/**
 * Every rule body for a selector, in file order.
 *
 * A selector is written more than once - a base rule, a theme, a width - so
 * asking for "the" rule finds whichever happens to come first and says nothing
 * about the one that carries the guards.
 */
function allRules(selector) {
    const bodies = [];
    let at = 0;
    for (;;) {
        const start = STYLE.indexOf(selector + ' {', at);
        if (start === -1) return bodies;
        const end = STYLE.indexOf('}', start);
        bodies.push(STYLE.slice(start, end));
        at = end;
    }
}

/** One rule body for a selector that carries all of these declarations. */
function ruleWith(selector, patterns) {
    const found = allRules(selector).find((body) => patterns.every((pattern) => pattern.test(body)));
    assert.ok(found, selector + ' has a rule carrying ' + patterns.map(String).join(' '));
    return found;
}

/** A name far longer than any column it is drawn in. */
const LONG_TITLE = 'Nocturne in the Key of Everything That Ever Happened to Anyone, '.repeat(8);
const LONG_ARTIST = 'A'.repeat(400);

test('the places a long name lands are told to truncate, not to grow', () => {
    // One line, clipped, and allowed to be narrower than its text. Without
    // min-width a flex child keeps its widest line and pushes the row wider
    // than the screen, which is how a page starts scrolling sideways.
    const clips = [/overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/];

    // These sit directly in a flex row, where a child keeps its widest line
    // unless it is told it may shrink - so they need min-width as well.
    ['.songinfo', '.playbar-artist'].forEach((selector) => ruleWith(selector, clips.concat(/min-width:\s*0/)));

    // These sit in a column inside a grid track that is already minmax(0, 1fr),
    // and their own parent carries min-width: 0. Clipping is what does the work
    // there, so that is what is held.
    ['.album-track-title', '.album-track-artist'].forEach((selector) => ruleWith(selector, clips));

    // The row and the column it sits in may both be narrower than their text.
    ruleWith('.album-track', [/minmax\(0, 1fr\)/, /min-width:\s*0/]);
    ruleWith('.album-track-meta', [/min-width:\s*0/]);
});

test('an album title long enough to be a paragraph stays a heading', () => {
    // The hero keeps its shape: two lines at most, and a word with no spaces
    // in it breaks rather than running off the side.
    ruleWith('.album-detail-title', [/-webkit-line-clamp:\s*2/, /overflow:\s*hidden/, /overflow-wrap:\s*anywhere/]);
});

test('metadata is escaped wherever it is written into markup', () => {
    // Titles, artists, album names and file names all come from somewhere
    // else. Every one of them goes through the same escape on its way into
    // HTML, or is set as text.
    const escapeSource = /function escapeHTML\([\s\S]*?\n\}/.exec(PLAYER);
    assert.ok(escapeSource, 'the page has one escape helper');

    const sandbox = { document: { createElement: () => ({ set textContent(v) { this._v = v; }, get innerHTML() { return String(this._v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }) } };
    vm.createContext(sandbox);
    vm.runInContext(escapeSource[0] + '\nvar out = escapeHTML(NAME);', Object.assign(sandbox, { NAME: '<img src=x onerror=alert(1)>' }));

    assert.ok(!/<img/.test(sandbox.out), 'markup in a track name never becomes markup');
    assert.match(sandbox.out, /&lt;img/);

    // A long name is not truncated on the way in: what is shown is a styling
    // decision, so the whole of it stays available to a title attribute and to
    // anyone reading with a screen reader.
    vm.runInContext('var kept = escapeHTML(LONG);', Object.assign(sandbox, { LONG: LONG_TITLE }));
    assert.strictEqual(sandbox.kept.length, LONG_TITLE.length, 'nothing is cut off in the data');
});

test('a row carries the whole name for anyone who asks, however it is drawn', () => {
    // The visible text is clipped; the title attribute is not. Somebody who
    // cannot see the ellipsis can still find out what the song is called.
    const rowSource = PLAYER.slice(PLAYER.indexOf('function renderAlbumDetail(folder)'), PLAYER.indexOf('async function openAlbumDetail(folder)'));
    assert.match(rowSource, /album-track-title" title="\$\{escapeHTML\(title\)\}"/);
    assert.match(rowSource, /album-track-artist" title="\$\{escapeHTML\(artist\)\}"/);
});

test('a library of many songs is drawn from one list, not one listener each', () => {
    // Rows are built into a fragment and put in once. A list that attached a
    // listener per row as it built would cost a thousand listeners for a
    // thousand songs, and rebinding would double them.
    const render = PLAYER.slice(PLAYER.indexOf('function renderAlbumDetail(folder)'), PLAYER.indexOf('function bindAlbumDetailTrackEvents()'));
    assert.match(render, /createDocumentFragment\(\)/);
    assert.match(render, /list\.innerHTML = '';/, 'the old rows go before the new ones arrive');

    // The loop that builds the rows attaches nothing. Listeners are bound once
    // afterwards, against the rows that are in the page - so a thousand songs
    // is one pass, and redrawing cannot leave two listeners on a row.
    const loop = render.slice(render.indexOf('const fragment = document.createDocumentFragment();'), render.indexOf("list.innerHTML = '';"));
    assert.ok(!/addEventListener/.test(loop), 'no listener is attached while the rows are being built');
    assert.match(render, /bindAlbumDetailTrackEvents\(\);/, 'and they are bound once, after the rows are in the page');
});
