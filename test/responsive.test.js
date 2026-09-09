'use strict';

/**
 * The player and the album view, at the sizes people actually hold.
 *
 * The stylesheet is read the way a browser reads it - rules, selectors and
 * the media queries around them - and asked the questions a narrow screen
 * asks: is anything wider than the window, is the last row reachable above
 * the player, and is there still something big enough to press.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PLAYER = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

// ============================================
// Reading the stylesheet
// ============================================

/**
 * Every rule in the sheet, with the media query it sits inside.
 *
 * Comments go first so a selector is never found in prose, and only leaf
 * rules are kept: a block that contains other blocks is a media query, not a
 * declaration.
 */
function parseRules(css) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    const stack = [];

    let index = 0;
    let start = 0;

    while (index < text.length) {
        const character = text[index];

        if (character === '{') {
            const prelude = text.slice(start, index).trim();
            stack.push({ prelude: prelude, bodyStart: index + 1 });
            start = index + 1;
            index += 1;
            continue;
        }

        if (character === '}') {
            const frame = stack.pop();
            if (frame) {
                const body = text.slice(frame.bodyStart, index);
                // A body with no nested block is a rule; anything else is a
                // wrapper such as @media.
                if (body.indexOf('{') === -1 && frame.prelude && frame.prelude[0] !== '@') {
                    rules.push({
                        selector: frame.prelude,
                        body: body,
                        media: stack.map((entry) => entry.prelude).filter((entry) => entry[0] === '@')
                    });
                }
            }
            start = index + 1;
            index += 1;
            continue;
        }

        index += 1;
    }

    return rules;
}

const RULES = parseRules(CSS);

/** The widest screen a media query applies to, or Infinity when it is unbounded. */
function maxWidthOf(media) {
    let limit = Infinity;
    media.forEach((query) => {
        const match = /max-width:\s*(\d+)px/.exec(query);
        if (match) limit = Math.min(limit, Number(match[1]));
    });
    return limit;
}

/** Every rule whose selector mentions this one, in force at the given width. */
function rulesFor(selector, width) {
    return RULES.filter((rule) => {
        if (rule.selector.split(',').every((part) => part.trim() !== selector)) return false;

        const limit = maxWidthOf(rule.media);
        const minMatch = rule.media.map((query) => /min-width:\s*(\d+)px/.exec(query)).find(Boolean);
        const floor = minMatch ? Number(minMatch[1]) : 0;

        return width <= limit && width >= floor;
    });
}

/** What a property resolves to for a selector at a width; later rules win. */
function valueOf(selector, property, width) {
    let value = null;
    rulesFor(selector, width).forEach((rule) => {
        const pattern = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)', 'g');
        let match;
        while ((match = pattern.exec(rule.body))) value = match[1].trim();
    });
    return value;
}

const WIDTHS = [
    { name: 'the narrowest phone', width: 320 },
    { name: 'an ordinary phone', width: 390 },
    { name: 'a tablet', width: 768 },
    { name: 'a laptop', width: 1280 },
    { name: 'a desktop', width: 1920 }
];

// ============================================
// Nothing is left underneath the player
// ============================================

test('the player says how tall it is, and the content leaves exactly that much room', () => {
    // The height is a variable, so the space reserved for it can never drift
    // away from the player's real size.
    assert.ok(valueOf('body', '--player-height', 1280), 'the player has a stated height');
    assert.match(valueOf('.playlist', 'padding-bottom', 1280), /var\(--player-height\)/);
    assert.match(valueOf('.album-detail', 'padding', 1280), /var\(--player-height\)/);
});

WIDTHS.forEach((size) => {
    test('the player still has a stated height at ' + size.name, () => {
        const height = valueOf('body', '--player-height', size.width);
        assert.ok(height, 'a height is set at ' + size.width + 'px');
        assert.match(height, /^\d+px$/);

        const reserved = valueOf('.playlist', 'padding-bottom', size.width);
        assert.match(reserved, /var\(--player-height\)/, 'and the library reserves it');
    });
});

test('every screen reserves exactly the room its player takes', () => {
    const phone = parseInt(valueOf('body', '--player-height', 390), 10);
    // 768px is the widest phone, so a tablet is asked about above it.
    const tablet = parseInt(valueOf('body', '--player-height', 900), 10);
    const desktop = parseInt(valueOf('body', '--player-height', 1280), 10);

    assert.ok(tablet <= desktop, 'a tablet bar is no taller than the desktop one');

    // A phone lays the same controls out in rows rather than one strip, so its
    // bar is the taller of the two - and the library reserves that, which is
    // what keeps the last card reachable.
    assert.ok(phone > tablet, 'a phone bar is taller, because it stacks (' + phone + 'px)');
    assert.ok(phone <= 140, 'and still a bar rather than half the screen (' + phone + 'px)');
});

// ============================================
// Nothing runs off the side
// ============================================

test('the page never scrolls sideways', () => {
    assert.strictEqual(valueOf('body', 'overflow-x', 320), 'hidden');
    assert.strictEqual(valueOf('.cardsarea', 'overflow-x', 320), 'hidden');
});

test('a long name is cut with an ellipsis rather than pushing the layout wider', () => {
    [
        '.songinfo',
        '.playbar-artist',
        '.album-track-title',
        '.album-track-artist',
        '.now-playing-artist'
    ].forEach((selector) => {
        assert.strictEqual(valueOf(selector, 'text-overflow', 320), 'ellipsis', selector + ' is cut, not stretched');
        assert.strictEqual(valueOf(selector, 'overflow', 320), 'hidden', selector + ' keeps to its box');
    });
});

test('everything that shares a row can be made narrower than its contents', () => {
    // Without this a flex or grid child refuses to shrink and the row spills
    // off the screen, which is what clipped the song cards at 320px.
    [
        '.playbar-track',
        '.playbar-meta',
        '.playbar-center',
        '.playbar-progress',
        '.songinfo',
        '.seekbar',
        '.album-track',
        '.album-track-meta',
        '.songslist ul li'
    ].forEach((selector) => {
        assert.strictEqual(valueOf(selector, 'min-width', 320), '0', selector + ' can shrink');
    });
});

test('the songs in the sidebar fill their column instead of a slice of the window', () => {
    // A width in viewport units cannot know how wide its own column is; at
    // 320px those widths cut the name and the controls both.
    const width = valueOf('.songslist ul li', 'width', 320);
    assert.strictEqual(width, '100%');
    assert.strictEqual(valueOf('.songslist ul li', 'box-sizing', 320), 'border-box');
});

// ============================================
// A phone gets a phone's player
// ============================================

test('a phone carries every control a tablet does', () => {
    // Everything a wider screen offers is here too; nothing is left behind in
    // Now Playing, which a phone can still open on top of it.
    ['#shuffle', '#previous', '#play', '#next', '#repeat', '#expandPlayer', '#volume', '#likeCurrentSong'].forEach(
        (id) => {
            assert.match(PAGE, new RegExp('id="' + id.slice(1) + '"'), id + ' is in the player');
        }
    );
    assert.match(PAGE, /id="playbarArtwork"/);

    // And the phone breakpoint hides none of them.
    const hiddenOnPhone = RULES.filter(
        (rule) => maxWidthOf(rule.media) <= 768 && /display:\s*none/.test(rule.body)
    )
        .map((rule) => rule.selector)
        .join(' , ');

    ['#shuffle', '#repeat', '#previous', '#next', '.playbar-progress', '.volume'].forEach((selector) => {
        assert.ok(!hiddenOnPhone.includes(selector), selector + ' is still in the phone bar');
    });

    // The one thing a phone does not get is a slider taking a row of its own;
    // the volume button opens the same small one a tablet uses.
    assert.strictEqual(valueOf('.playbar-right .volumeSeekbar', 'display', 390), 'none');
    assert.match(PAGE, /id="volumePopover"/);

    // Still nothing the brief rules out.
    assert.ok(!/id="queue|Connect to a device|mini-?player/i.test(PAGE), 'no queue, device or mini player');
});

test('a phone gets the seek bar itself, not a hair line standing in for it', () => {
    // The line along the edge said the same thing as the bar; with a row of
    // its own for the real one, it would only say it twice.
    assert.strictEqual(valueOf('.playbar-mini-progress', 'display', 1280), 'none');
    assert.strictEqual(valueOf('.playbar-mini-progress', 'display', 390), 'none');

    assert.notStrictEqual(valueOf('.playbar-progress', 'display', 390), 'none', 'the seek bar is there');
    assert.strictEqual(valueOf('.playbar-progress', 'grid-area', 390), 'progress');
});

test('a tablet keeps the controls and the progress, and drops the volume slider', () => {
    const hiddenOnTablet = RULES.filter(
        (rule) => maxWidthOf(rule.media) <= 1024 && /display:\s*none/.test(rule.body)
    )
        .map((rule) => rule.selector)
        .join(' , ');

    assert.ok(hiddenOnTablet.includes('.playbar-right .volumeSeekbar'), 'the slider goes first');
    assert.notStrictEqual(valueOf('.playbar-progress', 'display', 900), 'none', 'the progress stays');
});

// ============================================
// A finger can reach everything
// ============================================

test('every control in the player is big enough to press', () => {
    ['.player-btn', '.album-track-menu', '.nav-history-btn'].forEach((selector) => {
        const height = valueOf(selector, 'min-height', 390) || valueOf(selector, 'height', 390);
        assert.ok(height, selector + ' states a size');
        assert.ok(parseInt(height, 10) >= 36, selector + ' is at least 36px (' + height + ')');
    });

    // The row's play control is the whole thumbnail, so it is as big as the
    // picture and can never sit outside the row.
    const square = parseInt(valueOf('.album-track-artwork', 'height', 390), 10);
    assert.ok(square >= 44, 'the thumbnail is a target in its own right (' + square + 'px)');
    assert.strictEqual(valueOf('.album-track-play', 'inset', 390), '0', 'the control covers it exactly');
});

test('the seek line is thin to look at and thick to touch', () => {
    assert.strictEqual(valueOf('.seekbar', 'height', 390), '4px');
    // The padding is the target: the line stays hairline, the reach does not.
    assert.match(valueOf('.seekbar', 'padding', 390), /10px/);
    assert.strictEqual(valueOf('.seekbar', 'touch-action', 390), 'none');
});

test('what a pointer reveals, a finger is simply given', () => {
    const touch = RULES.filter((rule) => rule.media.some((query) => /pointer:\s*coarse/.test(query)));
    const shown = touch.filter((rule) => rule.selector.includes('.album-track-play'));

    assert.ok(shown.length > 0, 'the row play control is not hidden behind a hover on touch');
    assert.match(shown[0].body, /opacity:\s*1/);
});

// ============================================
// The album view at each size
// ============================================

test('the album header stands side by side at every width', () => {
    // The picture takes what it needs and the words take the rest, so there
    // is never an empty stretch between them - on a phone as on a desktop.
    // Stacking put the name and the song count below the fold, and left the
    // picture saying nothing the list beneath it did not.
    [1280, 900, 430, 390, 375, 360, 320].forEach((width) => {
        assert.strictEqual(
            valueOf('.album-detail-hero', 'grid-template-columns', width),
            'auto minmax(0, 1fr)',
            'the picture and the words share a row at ' + width + 'px'
        );
    });

    // The words keep a column they can be read in: the picture is what gives
    // up room, never the details.
    assert.strictEqual(valueOf('.album-detail-heading', 'min-width', 390), '0');

    // A hero picture on a desktop; a thumbnail beside the words on a phone.
    assert.match(valueOf('.album-detail-cover', 'width', 1280), /clamp\(160px, 17vw, 240px\)/);
    // 400px and under take a smaller fixed picture; above that a phone
    // sizes it against the screen.
    assert.match(valueOf('.album-detail-cover', 'width', 430), /clamp\(110px, 34vw, 140px\)/);
    assert.strictEqual(valueOf('.album-detail-cover', 'width', 390), '110px', 'smaller on the narrowest phones');
    assert.strictEqual(valueOf('.album-detail-cover', 'width', 320), '110px');

    assert.strictEqual(valueOf('.album-detail-cover', 'aspect-ratio', 390), '1', 'and stays square');
    assert.strictEqual(valueOf('.album-detail-cover', 'object-fit', 390), 'cover');
    assert.strictEqual(valueOf('.album-detail-cover', 'max-width', 390), '100%', 'never past the room it has');
});

test('what an album is fits beside its picture on a phone', () => {
    // Every line of it is there - what kind of album, its name, who it is by,
    // how many songs and how long - each cut rather than allowed to push the
    // column wider.
    assert.strictEqual(valueOf('.album-detail-title', '-webkit-line-clamp', 390), '2', 'two lines for a long name');
    assert.strictEqual(valueOf('.album-detail-artist', 'white-space', 390), 'nowrap', 'one line for the artist');
    assert.strictEqual(valueOf('.album-detail-artist', 'text-overflow', 390), 'ellipsis');

    // The description was dropped on a phone; two lines of it fit here.
    assert.notStrictEqual(valueOf('.album-detail-description', 'display', 390), 'none');
    assert.strictEqual(valueOf('.album-detail-description', '-webkit-line-clamp', 390), '2');

    // The row of controls sits under the hero rather than beside it.
    assert.strictEqual(valueOf('.album-detail-actions', 'justify-content', 390), 'flex-start');
    assert.strictEqual(valueOf('.album-detail-actions', 'flex-wrap', 390), 'wrap');

    // And the last of them clears the player.
    assert.match(valueOf('.album-detail', 'padding', 390), /var\(--player-height\)/);
});

test('the hero leaves the words a readable column at every phone width', () => {
    // The page's own padding, the picture and the gap come off the screen;
    // what is left is the column the details are read in.
    const padding = parseInt(valueOf('.album-detail', 'padding', 390).split(/\s+/)[1], 10);

    [320, 360, 375, 390, 430].forEach((width) => {
        const declared = valueOf('.album-detail-cover', 'width', width);
        const clamp = /clamp\((\d+)px, (\d+)vw, (\d+)px\)/.exec(declared);
        const cover = clamp
            ? Math.min(Number(clamp[3]), Math.max(Number(clamp[1]), (Number(clamp[2]) / 100) * width))
            : parseInt(declared, 10);

        const gap = parseInt(valueOf('.album-detail-hero', 'gap', width), 10);
        const column = width - padding * 2 - cover - gap;

        assert.ok(cover >= 110 && cover <= 140, 'the picture is a thumbnail at ' + width + 'px (' + cover + ')');
        assert.ok(column >= 150, 'the words keep a column at ' + width + 'px (' + Math.round(column) + 'px)');
    });
});

test('the track list is a table on a desktop and a list on a phone', () => {
    const desktop = valueOf('.album-track', 'grid-template-columns', 1280);
    const tablet = valueOf('.album-track', 'grid-template-columns', 900);
    const phone = valueOf('.album-track', 'grid-template-columns', 390);

    assert.ok(desktop.split(' ').length > phone.split(' ').length, 'a phone row carries fewer columns');
    assert.ok(tablet.split(' ').length <= desktop.split(' ').length, 'and a tablet sits between');

    // Every one of them is a grid of proportions, never a fixed width that
    // could reach past the screen.
    [desktop, tablet, phone].forEach((columns) => {
        assert.match(columns, /minmax\(0,/, 'the flexible column can shrink to nothing');
    });
});

test('Now Playing takes the whole screen on a phone and a panel on a desktop', () => {
    assert.strictEqual(valueOf('.now-playing-panel', 'width', 390), '100vw');
    assert.match(valueOf('.now-playing-panel', 'width', 1280), /min\(560px, 92vw\)/);
    assert.match(valueOf('.now-playing-artwork', 'width', 320), /min\(\d+px, \d+vw\)/);
});

// ============================================
// Both themes
// ============================================

test('the player is drawn from theme variables, not from fixed colours', () => {
    const players = RULES.filter((rule) =>
        /^(\.playbar|\.player-btn|\.seekbar|\.album-track|\.album-detail|\.now-playing)/.test(rule.selector.trim())
    );

    assert.ok(players.length > 20, 'the player has rules of its own');

    players.forEach((rule) => {
        const colours = rule.body.match(/(?:^|[\s:;])(#[0-9a-fA-F]{3,8})\b/g) || [];
        colours.forEach((colour) => {
            const value = colour.trim().replace(/^[:;]/, '').trim().toLowerCase();
            // White and black are allowed only where they sit on a wash this
            // stylesheet paints itself, and those are written as rgba().
            assert.ok(
                value === '#ffffff' && /rgba\(0, 0, 0/.test(rule.body),
                'a fixed colour in ' + rule.selector + ': ' + value
            );
        });
    });
});

// ============================================
// The library grid
// ============================================

test('the library is a grid whose columns come from the room available', () => {
    // Not a width per breakpoint: one rule that fits as many cards as there is
    // space for, so a card can never be sized by anything but its cell.
    const columns = valueOf('.cardsarea', 'grid-template-columns', 1280);
    assert.match(columns, /repeat\(auto-fill, minmax\(var\(--card-min\), 1fr\)\)/);
    assert.strictEqual(valueOf('.cardsarea', 'display', 1280), 'grid');

    // Every size of card is the same rule with a different smallest width.
    ['.cardsarea', '.cardsarea.cards-small', '.cardsarea.cards-large'].forEach((selector) => {
        const min = valueOf(selector, '--card-min', 1280);
        assert.match(min, /^\d+px$/, selector + ' states how narrow a card may be');
    });
});

test('no card is positioned by hand, at any width, in any size', () => {
    const cards = RULES.filter((rule) =>
        rule.selector
            .split(',')
            .some((part) => /^\.cardcontainer|^\.cardsarea[^ ]* \.cardcontainer|^\.create-album-card|^\.cardsarea .create-album-card/.test(part.trim()))
    );

    assert.ok(cards.length > 0, 'the cards have rules of their own');

    cards.forEach((rule) => {
        assert.ok(
            !/position:\s*(absolute|fixed)/.test(rule.body),
            'a card is taken out of the grid by ' + rule.selector
        );
        assert.ok(
            !/width:\s*\d+(px|vw)/.test(rule.body),
            'a card is given a width of its own by ' + rule.selector + ': ' + rule.body.trim()
        );
    });
});

test('Local Music is a card like every other, and the first one', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    // The same class as every other album, so it gets the same cell and the
    // same footprint. Nothing gives it a rule of its own.
    assert.match(player, /cardDiv\.className = 'cardcontainer pointer rounded'/);
    assert.ok(
        !RULES.some((rule) => /system.?local.?music|local-music/i.test(rule.selector)),
        'Local Music has no styling of its own to escape the grid with'
    );

    // It leads the library because the order says so, not because it is
    // placed anywhere.
    assert.match(player, /if \(info\.isSystemCollection\) return 0;/);
    assert.ok(
        !RULES.some((rule) => /grid-(column|row|area)\s*:/.test(rule.body) && /cardcontainer/.test(rule.selector)),
        'no card is pinned to a coordinate'
    );
});

test('the play control belongs to the artwork, so it cannot float off a card', () => {
    // One rule for every card size, because it is in the corner of the
    // picture rather than a measured distance from the bottom of the card.
    assert.strictEqual(valueOf('.card-art', 'position', 1280), 'relative');
    assert.strictEqual(valueOf('.card-art', 'aspect-ratio', 1280), '1');
    assert.strictEqual(valueOf('.card-art', 'overflow', 1280), 'hidden');
    assert.strictEqual(valueOf('.play', 'bottom', 1280), '8px');

    // And it is the same 8px at every card size and every width.
    const offsets = RULES.filter((rule) => rule.selector.split(',').some((part) => part.trim().endsWith('.play')))
        .map((rule) => /bottom:\s*([^;]+)/.exec(rule.body))
        .filter(Boolean)
        .map((match) => match[1].trim());
    assert.deepStrictEqual([...new Set(offsets)], ['8px'], 'the offset is not restated per card size');
});

// ============================================
// The drawer
// ============================================

test('the sidebar becomes a drawer over the page, never a column that moves it', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    // One class says whether it is open. Nothing writes a position onto the
    // element, so closing it restores the layout exactly.
    assert.match(player, /function openSidebar\(\)[\s\S]{0,200}classList\.add\('sidebar-open'\)/);
    assert.match(player, /function closeSidebar\(\)[\s\S]{0,200}classList\.remove\('sidebar-open'\)/);
    assert.ok(!/\.left'\)[\s\S]{0,80}style\.left/.test(player), 'the drawer is never positioned from script');

    assert.strictEqual(valueOf('.sidebar-backdrop', 'position', 390), 'fixed');
    assert.match(PAGE, /id="sidebarBackdrop"/);
});

// ============================================
// Nothing is drawn from a fixed colour or forced with !important
// ============================================

test('the components rebuilt here carry no !important patches', () => {
    const owned = RULES.filter((rule) =>
        /^(\.cardsarea|\.cardcontainer|\.card|\.card-art|\.play|\.playbar|\.player-btn|\.seekbar|\.album-|\.now-playing|\.sidebar-backdrop|\.create-)/.test(
            rule.selector.trim()
        )
    );

    assert.ok(owned.length > 30, 'those components have rules');
    owned.forEach((rule) => {
        assert.ok(!/!important/.test(rule.body), '!important in ' + rule.selector);
    });
});

test('a phone fits two cards across, down to the narrowest one', () => {
    // The library's own padding, and the space between two cards, decide how
    // small a card has to be allowed to get for two of them to fit at 320px.
    const padding = 12 * 2;
    const rightMargin = 10;
    const gap = parseInt(valueOf('.cardsarea', 'gap', 320), 10);
    const min = parseInt(valueOf('.cardsarea', '--card-min', 320), 10);

    const usable = 320 - padding - rightMargin;
    assert.ok(min * 2 + gap <= usable, 'two cards fit in ' + usable + 'px (' + min + 'px each)');

    // And a card never shrinks below something that can be read and pressed.
    assert.ok(min >= 96, 'a card is still a card (' + min + 'px)');
    assert.ok(parseInt(valueOf('.cardsarea', '--card-min', 1280), 10) > min, 'a desktop card is larger');
});

test('the player reserves the strip a phone keeps for its own gestures', () => {
    assert.match(valueOf('body', '--player-inset', 390), /env\(safe-area-inset-bottom/);
    assert.match(valueOf('body', '--player-gap', 390), /var\(--player-inset\)/);
    assert.match(valueOf('.playbar', 'bottom', 390), /var\(--player-inset\)/);

    // And the content above it reserves the player plus that strip.
    assert.match(valueOf('.playlist', 'padding-bottom', 390), /var\(--player-height\)/);
    assert.match(valueOf('.playlist', 'padding-bottom', 390), /var\(--player-gap\)/);
});

test('the phone bar is three rows, each control in its own place', () => {
    const height = parseInt(valueOf('body', '--player-height', 390), 10);
    assert.ok(height >= 100 && height <= 140, 'three rows, not half the screen (' + height + 'px)');

    // As tall as its rows need, with the reserved height as the floor - so a
    // long name or a larger text size cannot clip a row.
    assert.strictEqual(valueOf('.playbar', 'height', 390), 'auto');
    assert.strictEqual(valueOf('.playbar', 'min-height', 390), 'var(--player-height)');

    // What is playing, then the transport, then the seek bar and the volume.
    const areas = valueOf('.playbar', 'grid-template-areas', 390).replace(/\s+/g, ' ');
    assert.strictEqual(areas, '"track expand" "controls controls" "progress volume"');

    // The groups that hold these together on a wider screen stand aside, so
    // the volume and the way into Now Playing can sit in different rows.
    ['.playbar-center', '.playbar-right'].forEach((selector) => {
        assert.strictEqual(valueOf(selector, 'display', 390), 'contents', selector + ' steps out of the way');
    });

    [
        ['.playbar-track', 'track'],
        ['#expandPlayer', 'expand'],
        ['.controls', 'controls'],
        ['.playbar-progress', 'progress'],
        ['.volume', 'volume']
    ].forEach(([selector, area]) => {
        assert.strictEqual(valueOf(selector, 'grid-area', 390), area, selector + ' is in the ' + area + ' row');
    });
});

test('the narrowest phone keeps every control, drawn smaller', () => {
    // At 400px and under nothing is dropped; the buttons simply shrink.
    const hiddenAt320 = RULES.filter(
        (rule) => maxWidthOf(rule.media) <= 400 && /display:\s*none/.test(rule.body)
    )
        .map((rule) => rule.selector)
        .join(' , ');

    ['#next', '#previous', '#shuffle', '#repeat'].forEach((selector) => {
        assert.ok(!hiddenAt320.includes(selector), selector + ' survives the narrowest phone');
    });

    // Five buttons across, and they fit: the middle row's widest arrangement
    // is well inside the bar at 320px.
    const button = parseInt(valueOf('.player-btn', 'min-width', 320), 10);
    const primary = parseInt(valueOf('.player-btn-primary', 'min-width', 320), 10);
    const gap = parseInt(valueOf('.controls', 'gap', 320), 10);
    const row = button * 4 + primary + gap * 4;

    const padding = parseInt(valueOf('.playbar', 'padding', 320).split(/\s+/)[1], 10);
    const bar = 320 - 12 - padding * 2;
    assert.ok(row <= bar, 'the five controls fit across 320px (' + row + ' in ' + bar + ')');

    // Play is still the strongest of them.
    assert.ok(primary > button, 'play is the largest control');
});

// ============================================
// A picture is never bigger than the box it was given
// ============================================

/**
 * Album art arrives at whatever size it was made at - a thousand pixels
 * square is ordinary - so every place one is shown has to say how big it is.
 * A picture that escapes its box is drawn across the window.
 */
test('every place a cover is shown gives it a size', () => {
    const boxes = [
        '.card-art',
        '.card-art img',
        '.song-icon',
        '.album-track-art',
        '.album-track-artwork',
        '.playbar-artwork',
        '.now-playing-artwork',
        '.album-detail-cover',
        '.search-result-item img'
    ];

    WIDTHS.forEach((size) => {
        boxes.forEach((selector) => {
            const width =
                valueOf(selector, 'width', size.width) || valueOf('.songslist ul li ' + selector, 'width', size.width);
            assert.ok(width, selector + ' has a width at ' + size.name);
            assert.ok(
                !/^auto$/.test(width),
                selector + ' is not left at its own size at ' + size.name + ' (' + width + ')'
            );
        });
    });
});

test('no picture anywhere may be laid out wider than what holds it', () => {
    // The catch-all, so a rule that goes missing costs a wrong size rather
    // than a cover the size of the window.
    const catchAll = RULES.filter((rule) => rule.selector.split(',').some((part) => part.trim() === 'img'));
    assert.ok(catchAll.length > 0, 'images are bounded as a whole');
    assert.ok(
        catchAll.some((rule) => /max-width:\s*100%/.test(rule.body)),
        'and the bound is the box they sit in'
    );
});

test('a cover fills its square by being cropped, never drawn at its own scale', () => {
    ['.card-art img', '.album-track-art', '.playbar-artwork', '.now-playing-artwork', '.album-detail-cover'].forEach(
        (selector) => {
            assert.strictEqual(valueOf(selector, 'object-fit', 1280), 'cover', selector + ' crops rather than scales');
        }
    );

    // object-fit: none draws a picture at its own size inside the box, which
    // is the one value that makes a cover behave like a full-size image.
    RULES.forEach((rule) => {
        assert.ok(
            !/object-fit:\s*none/.test(rule.body),
            rule.selector + ' would draw its picture at its own size'
        );
    });
});

test('the large artwork belongs to one view each, and is bounded there', () => {
    // The two big pictures have selectors of their own: neither shares a class
    // with a card, so a card can never pick up a hero size.
    assert.ok(!/\.card[^-]/.test('.now-playing-artwork'), 'Now Playing artwork is its own class');
    assert.ok(!/\.card[^-]/.test('.album-detail-cover'), 'the album cover is its own class');

    assert.strictEqual(valueOf('.now-playing-artwork', 'max-width', 1280), '100%');
    assert.ok(valueOf('.now-playing-artwork', 'max-height', 1280), 'and it cannot outgrow its panel');
    assert.strictEqual(valueOf('.album-detail-cover', 'max-width', 1280), '100%');

    // No rule sizes a card's picture against the viewport.
    ['.card-art', '.card-art img', '.song-icon', '.album-track-art'].forEach((selector) => {
        WIDTHS.forEach((size) => {
            const width = valueOf(selector, 'width', size.width) || '';
            assert.ok(!/v[wh]\b/.test(width), selector + ' is not measured against the window');
        });
    });
});

test('a view that holds large artwork is closed by this stylesheet until it is opened', () => {
    // Closed is the default here, not something a script has to arrive and
    // apply: the hero pictures cannot be painted before the app decides.
    assert.strictEqual(valueOf('.album-detail', 'display', 1280), 'none');
    assert.strictEqual(valueOf('.album-detail.is-open', 'display', 1280), 'block');

    // Addressed by id: "now-playing" is also the marker on the album card
    // whose music is sounding, and a bare class here closed that card.
    assert.strictEqual(valueOf('#nowPlayingOverlay', 'display', 1280), 'none');
    assert.strictEqual(valueOf('#nowPlayingOverlay.is-open', 'display', 1280), 'flex');

    // And the document keeps them out of the page as well.
    assert.match(PAGE, /<section class="album-detail"[^>]*\shidden\b/);
    assert.match(PAGE, /<div id="nowPlayingOverlay"[^>]*\shidden\b/);
    assert.match(CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('starting a track touches the player, never a view that holds large artwork', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const starting = source.slice(
        source.indexOf('function playmusic(trackEncoded'),
        source.indexOf('function emptyLibraryCard(')
    );

    assert.ok(starting.length > 0, 'the function was found');
    assert.ok(!/is-open|\.hidden = false|classList\.remove\('hidden'\)/.test(starting), 'no view is opened by playing');
    assert.ok(!/openNowPlaying|openAlbumDetail|navigateTo/.test(starting), 'and no view is navigated to');
});

// ============================================
// The card that stands for this machine
// ============================================

/**
 * Local Music is one card in the same grid as every other collection, and the
 * one that carries a control of its own. These hold it to the grid: it must
 * not set a width, must not force a row taller than it needs to be, and must
 * stay comfortable to press wherever it is opened.
 */

test('the card for this machine carries no control of its own', () => {
    // It used to wear a pill saying "Manage" over its artwork. A card in a
    // grid of cards should not be the one with an extra button stuck to it:
    // what can be done with a collection belongs in the menu every card
    // already has, so this one has exactly the furniture the others have.
    assert.strictEqual(RULES.filter((rule) => /local-card-manage/.test(rule.selector)).length, 0);
    assert.ok(!/local-card-manage/.test(CSS), 'no styles for a control that is gone');

    const owned = RULES.filter((rule) =>
        rule.selector.split(',').some((part) => /local-music-card/.test(part))
    );
    owned.forEach((rule) => {
        // Nothing that would make this card a different size from the rest.
        assert.ok(
            !/(^|;)\s*(width|min-width|height|min-height)\s*:\s*\d+px/.test(rule.body),
            rule.selector + ' sets no size of its own'
        );
    });
});

WIDTHS.forEach((size) => {
    test('the card options button is still worth pressing at ' + size.name, () => {
        const height = valueOf('.card-menu-btn', 'height', size.width);
        assert.ok(height, 'it states a height at ' + size.width + 'px');
        assert.ok(parseInt(height, 10) >= 32, 'and it is not a hairline');
    });
});

// ============================================
// Looking after the music on this machine, at any width
// ============================================

test('the manager leaves the shared dialog to decide how wide it is', () => {
    // It raises the ceiling, because it holds lists. It must not set a width
    // as well: doing that overrode the dialog's own sizing, and the manager
    // took the whole width of a phone while every other dialog left a margin.
    assert.strictEqual(valueOf('.local-manager', 'width', 390), null, 'no width of its own');
    assert.ok(valueOf('.local-manager', 'max-width', 1280), 'only a ceiling');
    assert.match(valueOf('.modal-content', 'width', 390), /calc\(100% - 32px\)/);
});

test('the manager rows are rows at every width, and never scroll sideways', () => {
    WIDTHS.forEach((size) => {
        const columns = valueOf('.local-tracks li', 'grid-template-columns', size.width);
        assert.strictEqual(
            columns,
            'auto minmax(0, 1fr) auto',
            'a song keeps its three parts at ' + size.name
        );
    });

    // The middle column is the one that gives way, and the only one that can.
    assert.strictEqual(valueOf('.local-track-main', 'min-width', 1280), '0');
    assert.strictEqual(valueOf('.local-track-title', 'text-overflow', 1280), 'ellipsis');
    assert.strictEqual(valueOf('.local-track-meta', 'text-overflow', 1280), 'ellipsis');

    // A length and a button are short and stay whole, whatever is beside them.
    assert.strictEqual(valueOf('.local-track-duration', 'white-space', 1280), 'nowrap');
    assert.strictEqual(valueOf('.local-locations li .secondary-btn', 'white-space', 1280), 'nowrap');

    // Nothing in here is a table waiting to be dragged along on a phone.
    assert.ok(!/overflow-x:\s*(auto|scroll)/.test(valueOf('.local-tracks', 'overflow-x', 390) || ''));
});

test('a phone stacks the manager controls instead of splitting a line four ways', () => {
    assert.strictEqual(valueOf('.local-toolbar', 'flex-direction', 390), 'column');
    assert.strictEqual(valueOf('.local-actions', 'flex-direction', 390), 'column');
    assert.strictEqual(valueOf('.local-bulk', 'flex-direction', 390), 'column');

    // And on a tablet they are still a row, with room to wrap - a tablet is
    // not a squeezed desktop and not a wide phone.
    assert.strictEqual(valueOf('.local-toolbar', 'flex-direction', 768), null, 'still a row');
    assert.strictEqual(valueOf('.local-actions', 'flex-wrap', 768), 'wrap');
});

test('every control in the manager is large enough for a finger', () => {
    const coarse = RULES.filter((rule) => rule.media.some((query) => /pointer:\s*coarse/.test(query)));
    const touched = coarse.filter((rule) => /local-/.test(rule.selector) && /min-height:\s*44px/.test(rule.body));

    assert.ok(touched.length >= 2, 'the buttons, the fields and the rows');

    const covered = touched.map((rule) => rule.selector).join(' ');
    assert.match(covered, /secondary-btn/);
    assert.match(covered, /local-search input/);
    assert.match(covered, /local-tracks li/);
});

test('the manager reads in both themes without a colour of its own', () => {
    const owned = RULES.filter((rule) =>
        rule.selector.split(',').some((part) => /^\.local-(manager|health|section|note|track|locations|card|search|sort|bulk|actions|empty|choice)/.test(part.trim()))
    );

    assert.ok(owned.length > 0);

    owned.forEach((rule) => {
        // A literal colour is a colour that cannot follow the theme. The one
        // control that sits on artwork is exempt and named here rather than
        // matched loosely: a picture is any colour it likes, and a control on
        // top of one has to hold against all of them rather than against a
        // theme.
        if (/local-card-manage/.test(rule.selector)) return;

        assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rule.body), rule.selector + ' uses no literal colour');
        assert.ok(!/\brgba?\(/i.test(rule.body), rule.selector + ' uses no literal colour');
    });

    // The tiles are told apart by an edge as well as a fill, because in the
    // light theme an elevated surface is the same white as the dialog.
    assert.match(valueOf('.local-health-item', 'border', 1280), /var\(--border-color\)/);
});

// ============================================
// Waiting for something to arrive
// ============================================

/**
 * A placeholder is the shape of what is coming, and it is shown only when
 * nothing is here yet.
 *
 * The second half is the part that keeps being got wrong. Content already on
 * screen is never covered while it is being checked - a catalogue being
 * revalidated, a device index being reconciled, a library being re-read all
 * leave what is drawn exactly where it is. That is what stopped the library
 * blinking on every refresh, and these hold it in place.
 */

test('a placeholder is the same shape as the thing it stands in for', () => {
    // The card placeholder is a card: the same class, so every size, padding
    // and breakpoint the real one follows it follows too, and nothing moves
    // when one replaces the other.
    assert.match(PLAYER, /card\.className = 'cardcontainer rounded skeleton-card';/);
    assert.strictEqual(valueOf('.skeleton-art', 'aspect-ratio', 1280), '1', 'the artwork stays square');
    assert.strictEqual(valueOf('.skeleton-art', 'width', 1280), '100%');

    // A song row is built from the same columns as a real one.
    assert.strictEqual(valueOf('.skeleton-track', 'display', 1280), 'grid');
    assert.match(valueOf('.skeleton-track', 'grid-template-columns', 1280), /minmax\(0, 1fr\)/);

    // And each of them narrows on a phone, like the rows they stand in for.
    assert.notStrictEqual(
        valueOf('.skeleton-track', 'grid-template-columns', 390),
        valueOf('.skeleton-track', 'grid-template-columns', 1280),
        'a row placeholder follows the phone layout too'
    );
});

test('a placeholder follows the theme, and stops moving when asked', () => {
    // Its colours are the theme's, so it is right in both without a second
    // set of rules.
    assert.match(valueOf('.skeleton', 'background-color', 1280), /var\(--skeleton-base\)/);
    assert.ok(CSS.indexOf('--skeleton-base') !== -1);
    assert.match(CSS, /\[data-theme="light"\] \{[\s\S]{0,200}--skeleton-base/);

    // Somebody who has asked not to be moved gets the shape without the
    // travelling light.
    const reduced = RULES.filter(
        (rule) =>
            rule.media.some((query) => /prefers-reduced-motion/.test(query)) &&
            /skeleton/.test(rule.selector)
    );
    assert.ok(reduced.length > 0, 'reduced motion is answered');
    assert.match(reduced[0].body, /animation: none/);
});

test('nothing that is already on screen is ever covered by a placeholder', () => {
    // The library holds its own shape only when the grid is empty, which is
    // the one moment there is genuinely nothing to cover.
    const showing = PLAYER.slice(
        PLAYER.indexOf('function showLibrarySkeleton(count)'),
        PLAYER.indexOf('function skeletonTrackRow()')
    );
    assert.match(showing, /if \(!cardsArea \|\| cardsArea\.children\.length\) return;/);

    // And the manager holds its own only the first time it is opened, before
    // it has ever been told anything.
    const manager = PLAYER.slice(
        PLAYER.indexOf('async function refreshLocalManager()'),
        PLAYER.indexOf('function unavailableCollectionTracks()')
    );
    assert.match(manager, /if \(!localManager\.health\) \{/);
    assert.ok(
        manager.indexOf('showSkeletonIn') < manager.indexOf('await Promise.all'),
        'the shapes go up before the request, not after it'
    );

    // The paths that check what is already drawn put up no placeholder at all.
    ['async function revalidateCatalog()', 'async function refreshPersonalViews()', 'async function refreshLibraryQuietly()'].forEach(
        (name) => {
            const start = PLAYER.indexOf(name);
            assert.ok(start !== -1, name + ' was found');
            const section = PLAYER.slice(start, PLAYER.indexOf('\n}', start));
            assert.ok(!/[Ss]keleton/.test(section), name + ' never covers what is drawn');
        }
    );
});

test('a placeholder is never left waiting for ever', () => {
    // Whatever arrives - the content, an empty state, or a line saying the
    // machine could not be read - clears the busy mark.
    const manager = PLAYER.slice(
        PLAYER.indexOf('async function refreshLocalManager()'),
        PLAYER.indexOf('function unavailableCollectionTracks()')
    );
    assert.match(manager, /clearSkeleton\(document\.getElementById\(id\)\)/);

    // And a failure ends in words rather than in a shape.
    const health = PLAYER.slice(PLAYER.indexOf('function renderLocalHealth()'), PLAYER.indexOf('function describeWhen('));
    assert.match(health, /Could not read this device just now/);
    assert.match(health, /target\.replaceChildren\(problem\);/);

    // The library says it has stopped waiting the moment real cards are in it.
    assert.match(PLAYER, /cardsArea\.replaceChildren\(grid\);[\s\S]{0,200}clearSkeleton\(cardsArea\);/);
});

test('a placeholder is not read out as content', () => {
    // The region says it is busy once; the shapes inside it say nothing at
    // all, so nothing reads out a list of rectangles.
    assert.match(PLAYER, /region\.setAttribute\('aria-busy', busy \? 'true' : 'false'\)/);
    assert.match(PLAYER, /block\.setAttribute\('aria-hidden', 'true'\)/);
    assert.match(PLAYER, /card\.setAttribute\('aria-hidden', 'true'\)/);
    assert.match(PLAYER, /row\.setAttribute\('aria-hidden', 'true'\)/);
});

test('placeholders never make the page wider than the window', () => {
    ['.skeleton-card', '.skeleton-track', '.skeleton-location', '.skeleton-art', '.skeleton-line'].forEach((selector) => {
        WIDTHS.forEach((size) => {
            const width = valueOf(selector, 'width', size.width);
            if (!width) return;
            assert.ok(
                !/\d+px/.test(width) || parseInt(width, 10) <= 320,
                selector + ' claims no fixed width at ' + size.name
            );
        });
    });

    // The grid of them is the library's own grid, so it wraps the same way.
    assert.match(PLAYER, /cardsArea\.replaceChildren\(grid\);\s*markBusy\(cardsArea, true\);/);
});

// ============================================
// Nothing in the document can paint at its own size
// ============================================

/**
 * Every image in the page as it arrives, with the ancestors around it.
 *
 * The browser paints this document before a single line of the player has
 * run, so anything visible here at its own size is visible for as long as
 * the scripts take to load - which is what "a giant cover for a few seconds"
 * was.
 */
function imagesInPage() {
    const voids = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'path', 'circle', 'rect', 'line']);
    const tags = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

    const found = [];
    const stack = [];
    let match;

    while ((match = tags.exec(PAGE))) {
        const closing = match[1] === '/';
        const name = match[2].toLowerCase();
        const attributes = match[3] || '';

        const classes = (/class="([^"]*)"/.exec(attributes) || [])[1] || '';
        const id = (/id="([^"]*)"/.exec(attributes) || [])[1] || '';
        // A view is out of the page when the document says so, by attribute or
        // by the class the utility sheet hides with.
        const hidden = /\shidden(?=[\s>/])/.test(' ' + attributes + ' ') || /\bhidden\b/.test(classes);

        if (name === 'img') {
            found.push({
                id: id,
                classes: classes.split(/\s+/).filter(Boolean),
                insideHidden: stack.some((entry) => entry.hidden),
                hasSrc: /\ssrc=/.test(attributes)
            });
            continue;
        }

        if (closing) {
            for (let i = stack.length - 1; i >= 0; i -= 1) {
                if (stack[i].name === name) {
                    stack.length = i;
                    break;
                }
            }
            continue;
        }

        if (!voids.has(name) && !/\/\s*$/.test(attributes)) stack.push({ name: name, hidden: hidden });
    }

    return found;
}

test('every picture the page arrives with is either bounded or out of the page', () => {
    const images = imagesInPage();
    assert.ok(images.length > 0, 'the page has images');

    images.forEach((image) => {
        if (image.insideHidden) return;

        // A visible image has to be given a size by the stylesheet, at every
        // width, or it is drawn at whatever size the file happens to be.
        // Its own box if it has one; otherwise the bound every image in the
        // application carries, which is the container it sits in.
        const selectors = image.classes
            .map((name) => '.' + name)
            .concat(image.id ? ['#' + image.id] : [])
            .concat(['img']);
        const named = image.id ? '#' + image.id : image.classes.map((n) => '.' + n).join('') || '<img>';

        WIDTHS.forEach((size) => {
            const bounded = selectors.some((selector) => {
                const width = valueOf(selector, 'width', size.width);
                const max = valueOf(selector, 'max-width', size.width);
                return Boolean(width) || Boolean(max);
            });

            assert.ok(bounded, named + ' is given a size at ' + size.name);
        });
    });
});

test('the views that hold large artwork are out of the page until they are opened', () => {
    const images = imagesInPage();

    const hero = images.filter((image) =>
        image.classes.some((name) => name === 'now-playing-artwork' || name === 'album-detail-cover')
    );
    assert.strictEqual(hero.length, 2, 'both large pictures were found');

    hero.forEach((image) => {
        assert.ok(image.insideHidden, image.id + ' sits inside a view the document keeps closed');
        // And it names no file, so nothing large is fetched or decoded for a
        // view nobody has opened.
        assert.ok(!image.hasSrc, image.id + ' names no picture until its view opens');
    });
});

test('a closed view is handed its picture back', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    // Drawing Now Playing while it is closed sets no source at all, so a
    // track change cannot load a viewport-sized picture behind a closed view.
    const rendering = source.slice(
        source.indexOf('function renderNowPlaying()'),
        source.indexOf('function openNowPlaying()')
    );
    assert.match(rendering, /if \(!nowPlayingOpen\) \{[\s\S]{0,140}artwork\.removeAttribute\('src'\);/);

    // And closing either view lets go of the picture it was holding.
    const closing = source.slice(source.indexOf('function closeNowPlaying(options)'), source.length);
    assert.match(closing.slice(0, 700), /artwork\.removeAttribute\('src'\);/);
    assert.match(source, /cover\.removeAttribute\('src'\);/);
});

// ============================================
// Getting at the library on a small screen
// ============================================

/**
 * Below 1400px the library is a drawer rather than a column, so there has to
 * be a way into it. The button that opens it was hidden with `visibility` on
 * top of `display: none`, and the breakpoints only ever restored the
 * visibility - so it was never rendered at any width and the library was
 * unreachable on a phone or a tablet.
 */
test('the library has a way in at every width where it is a drawer', () => {
    // A column of its own: no button needed, and none shown.
    assert.strictEqual(valueOf('.hamburger', 'display', 1920), 'none', 'no button beside a library that is already there');
    assert.strictEqual(valueOf('.close', 'display', 1920), 'none');

    // A drawer: both the way in and the way out are shown.
    [1280, 768, 390, 320].forEach((width) => {
        assert.strictEqual(valueOf('.hamburger', 'display', width), 'flex', 'the library opens at ' + width + 'px');
        assert.strictEqual(valueOf('.close', 'display', width), 'flex', 'and closes at ' + width + 'px');
    });
});

test('the button that opens the library is a real button, and says so', () => {
    assert.match(PAGE, /<button type="button" class="hamburger[^>]*aria-label="Open library"/);
    assert.match(PAGE, /class="hamburger[^>]*aria-expanded="false"/);
    // It points at the library it opens, not at the shade behind it.
    assert.match(PAGE, /class="hamburger[^>]*aria-controls="librarySidebar"/);
    assert.match(PAGE, /<aside class="left bg-black" id="librarySidebar"/);

    assert.match(PAGE, /<button type="button" class="close[^>]*aria-label="Close library"/);
});

test('both controls are big enough for a thumb', () => {
    ['.hamburger', '.close'].forEach((selector) => {
        [1280, 390, 320].forEach((width) => {
            const size = parseInt(valueOf(selector, 'width', width), 10);
            const height = parseInt(valueOf(selector, 'height', width), 10);
            assert.ok(size >= 44, selector + ' is wide enough at ' + width + 'px (' + size + ')');
            assert.ok(height >= 44, selector + ' is tall enough at ' + width + 'px (' + height + ')');
        });
    });
});

test('the drawer covers most of a narrow screen, and never more than the screen', () => {
    [1280, 768, 390, 320].forEach((width) => {
        const drawer = valueOf('.left', 'width', width);
        assert.match(drawer, /min\(86vw, 380px\)/, 'the drawer is one size, said once, at ' + width + 'px');
        assert.strictEqual(valueOf('.left', 'max-width', width), '100vw', 'and never wider than the window');
        assert.strictEqual(valueOf('.left', 'position', width), 'fixed', 'it sits over the page rather than in it');
    });

    // At full width it is a column again, in the flow, sized in the layout.
    assert.strictEqual(valueOf('.left', 'position', 1920), null, 'no drawer on a wide screen');
    assert.strictEqual(valueOf('.left', 'width', 1920), '22vw');
});

test('the page behind the drawer stays where it is while the drawer is open', () => {
    assert.strictEqual(valueOf('body.sidebar-open', 'overflow', 390), 'hidden');
    assert.strictEqual(valueOf('body.sidebar-open', 'overflow', 1280), 'hidden');

    // And nothing is locked on a screen that never has a drawer.
    assert.strictEqual(valueOf('body.sidebar-open', 'overflow', 1920), null);

    // The shade behind it belongs to the drawer widths only.
    assert.match(PAGE, /<div class="sidebar-backdrop" id="sidebarBackdrop" hidden><\/div>/);
});

test('opening and closing the library touches nothing but the page', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const drawer = source.slice(source.indexOf('function openSidebar()'), source.indexOf('/* ========== SEARCH FUNCTIONALITY ========== */'));

    assert.ok(drawer.length > 0, 'the drawer functions were found');

    // Nothing about the player, and nothing about where the app has been.
    assert.ok(!/currentsong|playmusic|startAudioPlayback|togglePlayback/.test(drawer), 'playback is untouched');
    assert.ok(!/navigateTo|navGoBack|navGoForward|history\./.test(drawer), 'and so is the history');

    // It is the same library underneath: the drawer is the sidebar itself,
    // not a second copy of it built for small screens.
    assert.ok(!/createElement|innerHTML/.test(drawer), 'nothing is rebuilt to show it');

    // Choosing something in the library closes it again.
    assert.match(source, /function closeSidebarOnMobile\(\) \{\s*if \(window\.innerWidth <= 1400\) closeSidebar\(\);/);
    const uses = source.match(/closeSidebarOnMobile\(\)/g) || [];
    assert.ok(uses.length >= 4, 'a song and each navigation item close the drawer');

    // Escape closes it, and the shade behind it closes it.
    assert.match(source, /event\.key === 'Escape' && document\.body\.classList\.contains\('sidebar-open'\)/);
    assert.match(source, /sidebarBackdrop\.addEventListener\('click', \(\) => closeSidebar\(\)\)/);
});

// ============================================
// A song card fills the library it is in
// ============================================

/**
 * The list used to be capped at 18vw and each card at 15vw, and the title
 * inside one at 100px - so a card was narrower than the sidebar holding it and
 * grew no wider when the sidebar did.
 */
test('a song card is as wide as the list, at every width', () => {
    [1920, 1280, 768, 390, 320].forEach((width) => {
        assert.strictEqual(valueOf('.songslist ul li', 'width', width), '100%', 'a card fills the list at ' + width + 'px');
        assert.strictEqual(valueOf('.songslist ul li', 'box-sizing', width), 'border-box', 'border and padding included');
        assert.strictEqual(valueOf('.songslist ul', 'width', width), '100%');
        assert.strictEqual(valueOf('.songslist', 'max-width', width), '100%', 'and the list fills the library');
    });
});

test('nothing caps the list, the card or the name at a fixed size', () => {
    ['.songslist', '.songslist ul', '.songslist ul li', '.musicinfo div:first-child', '.musicinfo'].forEach(
        (selector) => {
            [1920, 1280, 390, 320].forEach((width) => {
                ['width', 'max-width', 'min-width'].forEach((property) => {
                    const value = valueOf(selector, property, width);
                    if (!value) return;
                    assert.ok(
                        !/\d+(vw|px)/.test(value) || value === '100%' || value === '0',
                        selector + ' is not pinned to ' + value + ' at ' + width + 'px'
                    );
                });
            });
        }
    );

    // The name is cut when there is not enough room, rather than being given
    // a size of its own.
    assert.strictEqual(valueOf('.musicinfo div', 'text-overflow', 1280), 'ellipsis');
    assert.strictEqual(valueOf('.musicinfo div', 'white-space', 1280), 'nowrap');
    assert.strictEqual(valueOf('.songslist ul li .musicinfo', 'min-width', 1280), '0', 'so the name can be cut at all');
});

test('a full-width card does not push past the list that holds it', () => {
    // A card carries the utility margin class, which would put ten pixels
    // either side of something already as wide as its container.
    assert.match(valueOf('.songslist ul li', 'margin', 1280), /^0 0 /, 'no space beside the card');
    assert.strictEqual(valueOf('.songslist', 'overflow-x', 1280), 'hidden');

    // The list adds no inset of its own, so a card lines up with the heading
    // above it.
    assert.match(valueOf('.songslist', 'padding', 1280), /^0 0 /);
    assert.strictEqual(valueOf('.songslist ul', 'padding', 1280), '0');
    assert.ok(!/class="songslist[^"]*\bp-\d/.test(PAGE), 'and the markup adds none either');
});

test('the card keeps its compact height and its layout', () => {
    // The same row, in the same order, at the same height as before.
    assert.strictEqual(valueOf('.songslist ul li', 'min-height', 1280), '52px');
    assert.strictEqual(valueOf('.songslist ul li', 'display', 1280), 'flex');
    assert.strictEqual(valueOf('.songslist ul li', 'align-items', 1280), 'center');
    assert.strictEqual(valueOf('.songslist ul li .song-icon', 'width', 1280), '40px');

    // The picture and the two controls keep their size while the name gives.
    ['.songslist ul li .song-icon', '.song-menu-btn'].forEach((selector) => {
        assert.strictEqual(valueOf(selector, 'flex-shrink', 1280), '0', selector + ' is never squeezed');
    });
});

test('the empty placeholder is a card of the same shape', () => {
    // It is one of these rows, so it takes the same width, height and inset
    // without a rule of its own.
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    assert.match(player, /<li class="libcard empty-libcard bg-black p-1 m-1"/);

    const rule = CSS.slice(CSS.indexOf('.empty-libcard {'), CSS.indexOf('.empty-libcard:hover'));
    assert.ok(!/width|max-width|min-width/.test(rule), 'it takes the card geometry rather than setting its own');
});


// ============================================
// An album card, at whatever size it is given
// ============================================

test('the grid works out its own columns, and a card fills the cell it gets', () => {
    assert.match(
        valueOf('.cardsarea', 'grid-template-columns', 1280),
        /repeat\(auto-fill, minmax\(var\(--card-min\), 1fr\)\)/,
        'the grid decides how many fit'
    );

    WIDTHS.forEach((size) => {
        // One number says how narrow a card may be; nothing else is fixed.
        const min = valueOf('.cardsarea', '--card-min', size.width);
        assert.match(min, /^\d+px$/, 'a smallest card width at ' + size.name);

        assert.strictEqual(valueOf('.card', 'width', size.width), '100%', 'a card fills its cell at ' + size.name);
        assert.strictEqual(valueOf('.card', 'min-width', size.width), '0');
        assert.strictEqual(valueOf('.cardcontainer', 'min-width', size.width), '0');
        assert.strictEqual(valueOf('.cardcontainer', 'box-sizing', size.width), 'border-box');
    });

    // The narrowest phones ask for a smaller card rather than squeezing one.
    assert.ok(
        parseInt(valueOf('.cardsarea', '--card-min', 320), 10) < parseInt(valueOf('.cardsarea', '--card-min', 1920), 10),
        'a card is allowed to be smaller on a phone'
    );
});

test('the artwork is a square that fills the card and never leaves it', () => {
    assert.strictEqual(valueOf('.card-art', 'width', 1280), '100%');
    assert.strictEqual(valueOf('.card-art', 'aspect-ratio', 1280), '1');
    assert.strictEqual(valueOf('.card-art', 'overflow', 1280), 'hidden');
    assert.strictEqual(valueOf('.card-art', 'position', 1280), 'relative');

    assert.strictEqual(valueOf('.card-art img', 'object-fit', 1280), 'cover');
    assert.strictEqual(valueOf('.card-art img', 'width', 1280), '100%');
    assert.strictEqual(valueOf('.card-art img', 'max-width', 1280), '100%');
});

test('a long name is cut rather than made to fit', () => {
    ['.card h2', '.card p'].forEach((selector) => {
        assert.strictEqual(valueOf(selector, 'white-space', 1280), 'nowrap', selector + ' is one line');
        assert.strictEqual(valueOf(selector, 'text-overflow', 1280), 'ellipsis');
        assert.strictEqual(valueOf(selector, 'overflow', 1280), 'hidden');
        assert.strictEqual(valueOf(selector, 'min-width', 1280), '0', selector + ' may be cut at all');
    });
});

test('the play control scales with the card and stays on the artwork', () => {
    // It is inside the square, which clips it, so it cannot reach the words.
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    assert.match(player, /<div class="card-art">[\s\S]{0,700}<button type="button" class="play"/);

    assert.match(valueOf('.play', 'width', 1280), /clamp\(/, 'it grows and shrinks with the card');
    assert.strictEqual(valueOf('.play', 'position', 1280), 'absolute');

    // A corner of the picture, not the album.
    const size = /clamp\(\s*(\d+)px,\s*(\d+)%/.exec(valueOf('.play', 'width', 1280));
    assert.ok(size, 'the size is stated as a range');
    assert.ok(Number(size[2]) <= 25, 'it covers a corner, not the album');
});

test('the three-dot control sits in the corner of the card, and is always reachable', () => {
    assert.strictEqual(valueOf('.card-menu', 'position', 1280), 'absolute');
    assert.strictEqual(valueOf('.card-menu', 'top', 1280), '8px');
    assert.strictEqual(valueOf('.card-menu', 'right', 1280), '8px');

    // A finger gets a bigger target, and never has to hover to find it.
    const touch = RULES.filter(
        (rule) =>
            rule.selector.split(',').some((part) => part.trim() === '.card-menu-btn') &&
            rule.media.some((query) => /hover:\s*none|pointer:\s*coarse/.test(query))
    );
    assert.ok(touch.length > 0, 'touch is answered');
    assert.match(touch[0].body, /width:\s*44px/);
    assert.match(touch[0].body, /height:\s*44px/);
    assert.match(touch[0].body, /opacity:\s*1/, 'and it is simply there, not faded');
});

test('a card menu is placed against the window, so nothing can clip it', () => {
    // The grid scrolls, and a scrolling box cuts off whatever hangs out of
    // it; a card is also often narrower than its own menu.
    assert.strictEqual(valueOf('.cardsarea', 'overflow-y', 1280), 'auto', 'the grid does scroll');
    assert.strictEqual(valueOf('.card-menu-dropdown', 'position', 1280), 'fixed');
    assert.match(valueOf('.card-menu-dropdown', 'max-width', 1280), /calc\(100vw - 24px\)/);
    assert.match(valueOf('.card-menu-dropdown', 'max-height', 1280), /calc\(100vh - 24px\)/);

    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const placing = player.slice(
        player.indexOf('function placeCardMenu(button, dropdown)'),
        player.indexOf('let openCardMenuButton = null;')
    );
    assert.ok(placing.length > 0, 'the menu is placed in code');

    // Beside the button it belongs to.
    assert.match(placing, /button\.getBoundingClientRect\(\)/);

    // Slid back on screen when it would run off either side.
    assert.match(placing, /left = Math\.min\(left, viewportWidth - menu\.width - edge\)/);
    assert.match(placing, /left = Math\.max\(edge, left\)/);

    // Flipped above the button when the room below has run out.
    assert.match(placing, /if \(menu\.height > roomBelow && roomAbove > roomBelow\)/);

    // And placed again when the page moves under it.
    assert.match(player, /window\.addEventListener\('resize', reposition\)/);
    assert.match(player, /document\.addEventListener\('scroll', reposition, true\)/);
});

test('the Create Album card is an album card in shape as well as size', () => {
    const player = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    // It is one of these cards, so it takes the cell, the padding and the
    // text rules without a geometry of its own.
    assert.match(player, /createCard\.className = 'cardcontainer[^']*create-album-card'/);
    assert.match(player, /<div class="card create-card-inner">/);

    // Where an album has its square picture, this has its square plus.
    assert.strictEqual(valueOf('.create-card-plus', 'width', 1280), '100%');
    assert.strictEqual(valueOf('.create-card-plus', 'aspect-ratio', 1280), '1');

    // And no size of its own that would make it taller or shorter.
    ['.create-album-card', '.create-card-inner'].forEach((selector) => {
        WIDTHS.forEach((size) => {
            ['width', 'height', 'min-height'].forEach((property) => {
                const value = valueOf(selector, property, size.width);
                if (!value) return;
                assert.ok(
                    value === '100%' || value === '0' || value === 'auto',
                    selector + ' sets no ' + property + ' of its own at ' + size.name + ' (' + value + ')'
                );
            });
        });
    });
});


// ============================================
// The volume slider, where there is room and where there is not
// ============================================

test('the slider is beside the button on a wide screen and not on a narrow one', () => {
    // The stylesheet decides this, at whatever width it decides it.
    assert.strictEqual(valueOf('.playbar-right .volumeSeekbar', 'display', 1920), null, 'it is simply there');
    assert.strictEqual(valueOf('.playbar-right .volumeSeekbar', 'display', 768), 'none', 'and not on a tablet');
    assert.strictEqual(valueOf('.playbar-right .volumeSeekbar', 'display', 390), 'none');

    // Where it is not beside the button, it opens above it instead - over the
    // player, so nothing is pushed about when it appears.
    assert.strictEqual(valueOf('.volume', 'position', 768), 'relative');
    assert.strictEqual(valueOf('.volume-popover', 'position', 768), 'absolute');
    assert.match(valueOf('.volume-popover', 'bottom', 768), /100%/);
});

test('the slider that opens is a real control, reachable and labelled', () => {
    // Closed in the document itself, so it cannot be seen before it is asked
    // for and no script has to arrive and hide it.
    assert.match(PAGE, /<div class="volume-popover" id="volumePopover"[^>]*\shidden>/);

    assert.match(PAGE, /id="volume"[^>]*aria-label="Volume"/);
    assert.match(PAGE, /id="volume"[^>]*aria-expanded="false"/);
    assert.match(PAGE, /id="volume"[^>]*aria-controls="volumePopover"/);

    // Muting is still one press, from inside it.
    assert.match(PAGE, /<button type="button"[^>]*id="volumeMute"[^>]*aria-label="Mute or unmute"/);

    // The slider inside is a range with a name, so the keyboard can move it.
    assert.match(PAGE, /class="volumeRange volume-popover-range pointer" type="range"[^>]*aria-label="Volume level"/);

    // Both buttons are the player's own control, which is 44px square.
    assert.ok(parseInt(valueOf('.player-btn', 'min-width', 768), 10) >= 40, 'a comfortable target');
});

test('the slider that opens changes the volume, and nothing else', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');
    const popover = source.slice(
        source.indexOf('function volumeSliderIsBeside()'),
        source.indexOf('function syncVolumeUI()')
    );
    assert.ok(popover.length > 0, 'the popover is wired in code');

    // Nothing here touches what is playing.
    assert.ok(!/currentsong\.(src|play|pause|load|currentTime)/.test(popover), 'playback is untouched');
    assert.ok(!/playmusic\(|startAudioPlayback\(/.test(popover), 'and nothing is started again');

    // The slider inside carries the same class as the one beside the button,
    // so the binding that sets the volume and the drawing that keeps every
    // slider in step already cover it - there is no second volume anywhere.
    assert.match(source, /document\.querySelectorAll\('\.volumeRange'\)\.forEach\((slider|\(slider\))/);
    assert.match(PAGE, /class="volumeRange volume-popover-range/);

    // It opens, closes on a second press, on a press outside, and on Escape.
    assert.match(popover, /if \(volumePopoverIsOpen\(\)\) closeVolumePopover\(\{ focusButton: true \}\);\s*else openVolumePopover\(\);/);
    assert.match(popover, /if \(event\.target\.closest\('\.volume'\)\) return;\s*closeVolumePopover\(\);/);
    assert.match(popover, /event\.key === 'Escape' && volumePopoverIsOpen\(\)/);

    // The button mutes only where the slider is already beside it.
    assert.match(source, /if \(volumeSliderIsBeside\(\)\) toggleMute\(\);/);
    assert.match(popover, /if \(volumeSliderIsBeside\(\)\) return;/);
});


// ============================================
// The theme a page opens in
// ============================================

test('every page opens dark unless this browser has been told otherwise', () => {
    const root = path.join(__dirname, '..');
    const pages = fs.readdirSync(root).filter((name) => name.endsWith('.html'));
    assert.ok(pages.length >= 8, 'the pages were found');

    pages.forEach((name) => {
        const html = fs.readFileSync(path.join(root, name), 'utf8');
        if (!html.includes('spotify_theme')) return;

        // Set before any stylesheet or script, so nothing is painted light
        // first and corrected afterwards.
        const head = html.slice(0, html.indexOf('</head>'));
        assert.ok(head.includes("localStorage.getItem('spotify_theme')"), name + ' decides its theme in the head');
        assert.match(
            head,
            /savedTheme === 'light' \? 'light' : 'dark'/,
            name + ' opens dark unless light was chosen'
        );

        // The system's own preference no longer decides.
        assert.ok(!/prefers-color-scheme/.test(html), name + ' does not follow the system');
    });
});

test('the player agrees with the page, and remembers what was chosen', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    assert.match(source, /applyTheme\(savedTheme === 'light' \? 'light' : 'dark'\)/);
    assert.ok(!/prefers-color-scheme/.test(source), 'the system is not consulted');

    // Switching writes the choice down, so the next refresh keeps it.
    assert.match(source, /localStorage\.setItem\('spotify_theme', newTheme\)/);
    assert.match(source, /const newTheme = currentTheme === 'dark' \? 'light' : 'dark'/);
});

// ============================================
// Album cards on a phone
// ============================================

test('a phone gets smaller album cards than a tablet, and two across the narrowest', () => {
    // Fewer pixels of chrome, and a smaller floor - so the picture is the
    // card rather than the padding around it.
    const phoneMin = parseInt(valueOf('.cardsarea', '--card-min', 390), 10);
    const deskMin = parseInt(valueOf('.cardsarea', '--card-min', 1280), 10);
    assert.ok(phoneMin < deskMin, 'a phone card may be smaller than a desktop one');

    const phonePad = valueOf('.cardcontainer', 'padding', 390);
    const deskPad = valueOf('.cardcontainer', 'padding', 1280);
    assert.notStrictEqual(phonePad, deskPad, 'and carries less padding');

    // Two columns at the narrowest widths, three once there is room.
    [
        [320, 2],
        [360, 2],
        [375, 2],
        [390, 3],
        [430, 3]
    ].forEach(([width, expected]) => {
        const pad = parseInt(valueOf('.playlist', 'padding-left', width), 10);
        const min = parseInt(valueOf('.cardsarea', '--card-min', width), 10);
        const gap = parseInt(valueOf('.cardsarea', 'gap', width), 10);

        const inner = width - pad * 2;
        const columns = Math.floor((inner + gap) / (min + gap));
        assert.strictEqual(columns, expected, width + 'px holds ' + expected + ' cards across');

        // They divide the row exactly, so none is wider than another - the
        // Local Music card included, which has no sizing of its own.
        const card = (inner - gap * (columns - 1)) / columns;
        assert.ok(card > 0 && card * columns + gap * (columns - 1) <= inner, 'the row fits at ' + width + 'px');
    });
});

test('a card\'s controls stay inside its picture at every phone width', () => {
    [320, 360, 375, 390, 430].forEach((width) => {
        const pad = parseInt(valueOf('.playlist', 'padding-left', width), 10);
        const min = parseInt(valueOf('.cardsarea', '--card-min', width), 10);
        const gap = parseInt(valueOf('.cardsarea', 'gap', width), 10);
        const side = parseInt(valueOf('.cardcontainer', 'padding', width).split(/\s+/)[1], 10);

        const inner = width - pad * 2;
        const columns = Math.floor((inner + gap) / (min + gap));
        const art = (inner - gap * (columns - 1)) / columns - side * 2;

        // The play control is a proportion of the picture, floored at 32px;
        // the three-dot button is a fixed square in the opposite corner.
        const play = Math.min(48, Math.max(32, art * 0.22));
        const menu = parseInt(valueOf('.card-menu-btn', 'width', width) || '32', 10);

        assert.ok(play + menu < art, 'both controls sit inside the picture at ' + width + 'px');
        assert.ok(art >= 84, 'and the picture is still a picture at ' + width + 'px (' + Math.round(art) + 'px)');
    });
});


// ============================================
// My Profile, on a phone
// ============================================

test('the profile card takes the screen less a margin, and scrolls rather than clipping', () => {
    // 95% of 320px left 8px either side, which is not a margin; and a fixed
    // 85vh cut the card off on a short screen instead of letting it scroll.
    assert.strictEqual(valueOf('.modal-content', 'width', 390), 'calc(100% - 32px)');
    assert.strictEqual(valueOf('.modal-content', 'max-width', 390), '420px');
    assert.match(valueOf('.modal-content', 'max-height', 390), /100dvh/);
    assert.strictEqual(valueOf('.modal-content', 'overflow-y', 390), 'auto', 'it scrolls inside itself');

    // Centred, by the layer it sits in.
    assert.strictEqual(valueOf('.modal', 'align-items', 390), 'center');
    assert.strictEqual(valueOf('.modal', 'justify-content', 390), 'center');

    // A desktop keeps the card it had.
    assert.strictEqual(valueOf('.modal-content', 'width', 1280), '90%');
});

test('a long address wraps inside the profile card rather than pushing it wider', () => {
    // An address has no spaces to break at, so it is allowed to break anywhere
    // - and the label beside it never gives up its own word.
    assert.strictEqual(valueOf('.profile-info-item span', 'overflow-wrap', 390), 'anywhere');
    assert.strictEqual(valueOf('.profile-info-item span', 'min-width', 390), '0');
    assert.strictEqual(valueOf('.profile-info-item label', 'flex-shrink', 390), '0');
    assert.strictEqual(valueOf('.profile-info-item', 'align-items', 390), 'baseline');
});

test('the three counts are three equal columns at every phone width', () => {
    assert.match(valueOf('.profile-stats', 'grid-template-columns', 390), /repeat\(3, 1fr\)/);
    assert.strictEqual(valueOf('.profile-stat', 'min-width', 390), '0');
    assert.strictEqual(valueOf('.profile-stat .stat-label', 'text-overflow', 390), 'ellipsis');

    // Each column has room for its number at the narrowest width.
    [320, 360, 375, 390, 430].forEach((width) => {
        const card = Math.min(width - 32, parseInt(valueOf('.modal-content', 'max-width', width), 10));
        const body = parseInt(valueOf('.profile-modal-body', 'padding', width).split(/\s+/)[1], 10);
        const pad = parseInt(valueOf('.profile-stats', 'padding', width).split(/\s+/)[1], 10);
        const gap = parseInt(valueOf('.profile-stats', 'gap', width), 10);

        const column = (card - body * 2 - pad * 2 - gap * 2) / 3;
        assert.ok(column >= 60, 'a count has room at ' + width + 'px (' + Math.round(column) + 'px)');
    });

    // The way out is as wide as the card.
    assert.strictEqual(valueOf('.profile-actions .btn-secondary', 'width', 390), '100%');
});

// ============================================
// The developer page, on a phone
// ============================================

/** That page carries its own stylesheet, so it is read on its own. */
const DEVELOPER = (() => {
    const html = fs.readFileSync(path.join(ROOT, 'developer.html'), 'utf8');
    return { html: html, css: html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')) };
})();

const DEVELOPER_RULES = parseRules(DEVELOPER.css);

function developerValue(selector, property, width) {
    let value = null;
    DEVELOPER_RULES.forEach((rule) => {
        if (rule.selector.split(',').every((part) => part.trim() !== selector)) return;

        const limit = maxWidthOf(rule.media);
        const minMatch = rule.media.map((query) => /min-width:\s*(\d+)px/.exec(query)).find(Boolean);
        const floor = minMatch ? Number(minMatch[1]) : 0;
        if (width > limit || width < floor) return;

        const pattern = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)', 'g');
        let match;
        while ((match = pattern.exec(rule.body))) value = match[1].trim();
    });
    return value;
}

test('the developer page counts stay three columns across the page', () => {
    // They were one 200px column on a narrow screen: a tall strip with the
    // page empty either side of it.
    [320, 360, 375, 390, 430].forEach((width) => {
        assert.match(
            developerValue('.stats-section', 'grid-template-columns', width),
            /repeat\(3, 1fr\)/,
            'three across at ' + width + 'px'
        );
        assert.strictEqual(
            developerValue('.stats-section', 'max-width', width),
            '100%',
            'and as wide as the page at ' + width + 'px'
        );

        const side = parseInt(developerValue('.developer-content', 'padding', width).split(/\s+/)[1], 10);
        const pad = parseInt(developerValue('.stats-section', 'padding', width).split(/\s+/)[1], 10);
        const gap = parseInt(developerValue('.stats-section', 'gap', width), 10);
        const column = (width - side * 2 - pad * 2 - gap * 2) / 3;

        assert.ok(column >= 70, 'a count has room at ' + width + 'px (' + Math.round(column) + 'px)');
    });

    // A desktop keeps the card it had.
    assert.strictEqual(developerValue('.stats-section', 'max-width', 1280), '500px');
});

test('the developer page measures itself against what a phone can show', () => {
    // 100vh on a phone is taller than the part of it you can see, so a page
    // measured in it hides its own last inch behind the browser's bars.
    assert.match(DEVELOPER.css, /min-height: 100vh;\s*\n\s*min-height: 100dvh;/, 'the page, with a fallback first');
    assert.match(DEVELOPER.css, /height: 100vh;\s*\n\s*height: 100dvh;/, 'and the drawer over it');
    assert.match(DEVELOPER.css, /overflow-x: hidden/, 'nothing runs off the side');

    // The header stays out of the content's way rather than over it.
    assert.strictEqual(developerValue('.developer-header', 'position', 390), 'sticky');

    // Its name is allowed to break, and its bio to take the width it has.
    assert.match(developerValue('.developer-name', 'font-size', 390), /clamp\(/);
    assert.strictEqual(developerValue('.developer-name', 'overflow-wrap', 390), 'anywhere');
    assert.strictEqual(developerValue('.developer-bio', 'max-width', 390), '100%');

    // The four ways of getting in touch are two rows of two, not four narrow
    // bars stacked with air either side of them.
    assert.match(developerValue('.social-links', 'grid-template-columns', 390), /repeat\(2, minmax\(0, 1fr\)\)/);
    assert.strictEqual(developerValue('.social-link', 'width', 320), '100%');
    assert.strictEqual(developerValue('.social-link', 'min-width', 320), '0');
    assert.ok(
        parseInt(developerValue('.social-link', 'min-height', 320), 10) >= 44,
        'each is a comfortable target'
    );
});

test('the developer page has one mobile breakpoint, and nothing overflows it', () => {
    // Three rules in three breakpoints contradicting each other became one
    // block at 600px.
    const breakpoints = (DEVELOPER.css.match(/@media screen and \(max-width: (\d+)px\)/g) || []).map((query) =>
        Number(/(\d+)/.exec(query)[1])
    );
    assert.deepStrictEqual(breakpoints.sort((a, b) => b - a), [1024, 768, 600], 'tablet, small tablet, phone');

    [320, 360, 375, 390, 430].forEach((width) => {
        // A safe margin either side, and the page takes the rest.
        const padding = developerValue('.developer-content', 'padding', width).split(/\s+/);
        const side = parseInt(padding[1], 10);
        assert.ok(side >= 16 && side <= 20, 'a safe margin at ' + width + 'px (' + side + 'px)');
        assert.strictEqual(developerValue('.developer-content', 'width', width), '100%');
        assert.strictEqual(developerValue('.developer-content', 'min-width', width), '0');

        // Two buttons and the gap between them fit the usable width.
        const gap = parseInt(developerValue('.social-links', 'gap', width), 10);
        const button = (width - side * 2 - gap) / 2;
        assert.ok(button >= 120, 'a button has room at ' + width + 'px (' + Math.round(button) + 'px)');
    });

    // The last inch of the page clears the browser's own bar.
    assert.match(developerValue('.developer-footer', 'padding', 390), /env\(safe-area-inset-bottom/);
    assert.match(developerValue('.developer-content', 'padding', 390), /env\(safe-area-inset-bottom/);
});

test('the cards on the developer page take the width and no fixed height', () => {
    [320, 390, 430].forEach((width) => {
        // Nothing states a height, so a card is as tall as what is in it.
        ['.project-card', '.contact-section', '.skill-tag'].forEach((selector) => {
            assert.strictEqual(developerValue(selector, 'height', width), null, selector + ' has no fixed height');
        });

        // Long words break inside their own card rather than pushing it wider.
        assert.strictEqual(developerValue('.project-name', 'overflow-wrap', width), 'anywhere');
        assert.strictEqual(developerValue('.project-name', 'flex-wrap', width), 'wrap');
        assert.strictEqual(developerValue('.skill-tag', 'overflow-wrap', width), 'anywhere');
        assert.strictEqual(developerValue('.project-card', 'min-width', width), '0');

        // The call to action stays inside its card and centred.
        assert.strictEqual(developerValue('.contact-btn', 'width', width), '100%');
        assert.strictEqual(developerValue('.contact-btn', 'max-width', width), '320px');
        assert.strictEqual(developerValue('.contact-btn', 'margin', width), '0 auto');
        assert.strictEqual(developerValue('.contact-btn', 'box-sizing', width), 'border-box');
    });

    // A desktop keeps the padding it had.
    assert.strictEqual(developerValue('.contact-section', 'padding', 1280), '48px');
    assert.strictEqual(developerValue('.project-card', 'padding', 1280), '24px');
});


// ============================================
// The library, and the links under it
// ============================================

/**
 * The links used to be lifted out of the flow and pinned 34px from the bottom
 * of the library, while the list above them was allowed to run to 60vh - so
 * with enough songs the two occupied the same strip of the sidebar and the
 * cards were drawn across Features, Privacy, Terms and the rest.
 *
 * The sidebar is a column now: a nav, a list that takes what is left, and the
 * links at the foot of it. Nothing is positioned, so nothing can overlap.
 */
test('the sidebar is a column, and only the song list scrolls in it', () => {
    [1600, 1280, 390].forEach((width) => {
        assert.strictEqual(valueOf('.left', 'display', width), 'flex', 'the sidebar is a column at ' + width + 'px');
        assert.strictEqual(valueOf('.left', 'flex-direction', width), 'column');

        // The nav keeps its own height; the library takes the rest.
        assert.strictEqual(valueOf('.home', 'flex-shrink', width), '0');
        assert.strictEqual(valueOf('.library', 'flex', width), '1');
        assert.strictEqual(valueOf('.library', 'min-height', width), '0');
        assert.strictEqual(valueOf('.library', 'display', width), 'flex');

        // The list is the one part that moves, and min-height: 0 is what lets
        // a flex child shrink far enough to scroll at all.
        assert.strictEqual(valueOf('.songslist', 'flex', width), '1');
        assert.strictEqual(valueOf('.songslist', 'min-height', width), '0');
        assert.strictEqual(valueOf('.songslist', 'overflow-y', width), 'auto');

        // And it is no longer given a height of its own that could run past
        // where the links begin.
        assert.strictEqual(valueOf('.songslist', 'max-height', width), null, 'the list has no height of its own');

        // The links are last in the column and never give up their room.
        assert.strictEqual(valueOf('.footer', 'flex-shrink', width), '0');
    });
});

test('nothing in the sidebar is lifted out of the flow or given a layer', () => {
    // The fix is the column, not a bigger number: a card cannot cover the
    // links because the list it is in stops where they begin.
    assert.strictEqual(valueOf('.footer', 'position', 1600), null, 'the links are in the flow');
    assert.strictEqual(valueOf('.footer', 'bottom', 1600), null);
    assert.strictEqual(valueOf('.footer', 'z-index', 1600), null, 'and need no layer of their own');
    assert.strictEqual(valueOf('.library', 'position', 1600), null, 'nothing anchors an absolute child here now');

    // No song card carries a position or a layer, at any width.
    ['.songslist ul li', '.libcard', '.empty-libcard', '.songslist ul'].forEach((selector) => {
        [1600, 1280, 390].forEach((width) => {
            ['position', 'z-index'].forEach((property) => {
                assert.strictEqual(
                    valueOf(selector, property, width),
                    null,
                    selector + ' sets no ' + property + ' at ' + width + 'px'
                );
            });
        });
    });

    // The drawer itself is the one layered thing, which is what a drawer is.
    assert.strictEqual(valueOf('.left', 'position', 390), 'fixed');
    assert.strictEqual(valueOf('.left', 'z-index', 390), '1000');
    assert.strictEqual(valueOf('.left', 'position', 1600), null, 'and on a desktop it is a column in the page');
});

test('the drawer holds its shape while the list inside it moves', () => {
    // Two scrollers one inside the other would fight each other; the drawer
    // keeps its shape and the list is the part that scrolls.
    assert.strictEqual(valueOf('.left', 'overflow', 390), 'hidden');
    assert.strictEqual(valueOf('.left', 'overscroll-behavior', 390), 'contain');
    assert.strictEqual(valueOf('.songslist', 'overflow-y', 390), 'auto');
});

test('the links say their own width once, not three times against the window', () => {
    // Inside a column with a width of its own, a width measured against the
    // window says nothing - and it said it differently at three breakpoints.
    const widths = RULES.filter(
        (rule) => rule.selector.split(',').some((part) => part.trim() === '.footer div') && /max-width/.test(rule.body)
    );
    assert.strictEqual(widths.length, 1, 'one rule states the width');
    assert.match(widths[0].body, /max-width:\s*100%/, 'and it is the column that holds them');

    [1600, 1280, 620, 390, 320].forEach((width) => {
        assert.strictEqual(valueOf('.footer div', 'max-width', width), '100%', 'no vw width at ' + width + 'px');
        assert.match(valueOf('.footer div', 'grid-template-columns', width), /repeat\(2, 1fr\)/);
    });
});
