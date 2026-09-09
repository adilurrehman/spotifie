'use strict';

/**
 * Reading the interface in either theme.
 *
 * The light theme is not the dark one with a white page behind it: a surface
 * that darkens under a pointer needs dark text on it, an accent that is bright
 * enough to sit on black is too bright to read on white, and a hint that is
 * quiet in one is invisible in the other.
 *
 * These tests read the stylesheet the way a browser does - tokens resolved,
 * later and more specific rules winning - and check that nothing ends up
 * written in a colour too close to the colour behind it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

// ============================================
// Reading the stylesheet
// ============================================

function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every leaf rule in the sheet, in the order it is written. */
function rulesOf(css) {
    const text = stripComments(css);
    const out = [];
    const stack = [];
    let buffer = '';

    for (const ch of text) {
        if (ch === '{') {
            stack.push(buffer.trim());
            buffer = '';
            continue;
        }
        if (ch === '}') {
            const prelude = stack.pop() || '';
            if (prelude && !prelude.startsWith('@')) out.push({ selector: prelude, body: buffer });
            buffer = '';
            continue;
        }
        buffer += ch;
    }

    return out;
}

function declarationsOf(body) {
    const map = {};
    for (const part of body.split(';')) {
        const index = part.indexOf(':');
        if (index === -1) continue;
        map[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
    }
    return map;
}

const RULES = rulesOf(CSS);

/** Every rule written for exactly this selector, bodies only. */
function ruleBodies(selector) {
    return RULES.filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector)).map(
        (rule) => rule.body
    );
}

/** The theme's variables, as the browser would have them. */
function tokensFor(theme) {
    const values = {};
    for (const rule of RULES) {
        const selector = rule.selector.replace(/\s+/g, ' ').trim();
        const isRoot = /:root/.test(selector) || /\[data-theme="dark"\]/.test(selector);
        const isLight = selector === '[data-theme="light"]';
        if (theme === 'dark' ? !isRoot : !(isRoot || isLight)) continue;

        for (const [name, value] of Object.entries(declarationsOf(rule.body))) {
            if (name.startsWith('--')) values[name] = value;
        }
    }
    return values;
}

const THEMES = { light: tokensFor('light'), dark: tokensFor('dark') };

function resolve(value, tokens) {
    let out = value;
    for (let i = 0; i < 5 && /var\(/.test(out); i += 1) {
        out = out.replace(/var\((--[^,)]+)(?:,([^)]*))?\)/g, (whole, name, fallback) => {
            const stored = tokens[name.trim()];
            if (stored !== undefined) return stored;
            return fallback ? fallback.trim() : whole;
        });
    }
    return out;
}

// ============================================
// Colours
// ============================================

function toRgb(value) {
    if (!value) return null;
    const text = value.trim().toLowerCase();

    if (text === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    if (text === 'black') return { r: 0, g: 0, b: 0, a: 1 };

    let match = /^#([0-9a-f]{3,8})$/.exec(text);
    if (match) {
        let hex = match[1];
        if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');

        // A hex colour can carry its own transparency in the last two digits,
        // and a wash of white over black is not white.
        let alpha = 1;
        if (hex.length === 8) {
            alpha = parseInt(hex.slice(6, 8), 16) / 255;
            hex = hex.slice(0, 6);
        }
        if (hex.length !== 6) return null;

        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: alpha
        };
    }

    match = /^rgba?\(([^)]+)\)$/.exec(text);
    if (match) {
        const parts = match[1].split(',').map((n) => parseFloat(n));
        if (parts.length < 3) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }

    return null;
}

function firstColour(value) {
    if (!value) return null;
    const direct = toRgb(value);
    if (direct) return direct;
    const found = value.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|\bwhite\b|\bblack\b/);
    return found ? toRgb(found[0]) : null;
}

function luminance(colour) {
    const parts = [colour.r, colour.g, colour.b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

function over(colour, base) {
    if (!colour) return base;
    if (colour.a >= 0.999) return colour;
    return {
        r: colour.r * colour.a + base.r * (1 - colour.a),
        g: colour.g * colour.a + base.g * (1 - colour.a),
        b: colour.b * colour.a + base.b * (1 - colour.a),
        a: 1
    };
}

function contrast(a, b) {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
}

/** Colour of one property for one selector, as the cascade would settle it. */
function effective(selectorText, theme, property) {
    const wanted = selectorText
        .split(',')
        .map((part) => part.replace(/\[data-theme="light"\]/g, '').replace(/\s+/g, ' ').trim());

    let generic = null;
    let themed = null;

    for (const rule of RULES) {
        const isLightRule = /\[data-theme="light"\]/.test(rule.selector);
        if (isLightRule && theme !== 'light') continue;

        const parts = rule.selector
            .split(',')
            .map((part) => part.replace(/\[data-theme="light"\]/g, '').replace(/\s+/g, ' ').trim());
        if (!parts.some((part) => wanted.includes(part))) continue;

        const found = declarationsOf(rule.body)[property];
        if (!found) continue;
        if (isLightRule) themed = found;
        else generic = found;
    }

    return themed || generic;
}

const PAGE = { light: { r: 255, g: 255, b: 255, a: 1 }, dark: { r: 18, g: 18, b: 18, a: 1 } };

/** How readable one selector's text is on its own background, in one theme. */
function readability(selector, theme) {
    const tokens = THEMES[theme];
    const background = effective(selector, theme, 'background-color') || effective(selector, theme, 'background');
    const colour = effective(selector, theme, 'color');
    if (!background || !colour) return null;

    const bg = over(firstColour(resolve(background, tokens)), PAGE[theme]);
    const fg = over(firstColour(resolve(colour, tokens)), bg);
    if (!bg || !fg) return null;

    return contrast(fg, bg);
}

// ============================================
// The tokens themselves
// ============================================

test('both themes answer every question the other one does', () => {
    const light = Object.keys(THEMES.light).sort();
    const dark = Object.keys(THEMES.dark).sort();

    assert.deepStrictEqual(light, dark, 'a theme that leaves a colour unsaid falls back to the other one');
    assert.ok(light.length >= 20, 'the themes are described by name, not by exception');

    for (const name of ['--surface-hover', '--text-on-hover', '--text-on-accent', '--accent-text', '--danger', '--danger-text', '--focus-ring', '--placeholder']) {
        assert.ok(THEMES.light[name], 'the light theme says what ' + name + ' is');
        assert.ok(THEMES.dark[name], 'and so does the dark one');
    }
});

test('each theme reads on its own page, and the two do not share answers', () => {
    const checks = [
        ['--text-primary', 7],
        ['--text-secondary', 4.5],
        ['--text-muted', 3.5],
        ['--placeholder', 3.5],
        ['--accent-text', 3],
        ['--danger-text', 3]
    ];

    for (const theme of ['light', 'dark']) {
        for (const [name, least] of checks) {
            const colour = over(firstColour(resolve(THEMES[theme][name], THEMES[theme])), PAGE[theme]);
            const ratio = contrast(colour, PAGE[theme]);
            assert.ok(ratio >= least, theme + ' ' + name + ' reads on its own page (' + ratio + ' >= ' + least + ')');
        }
    }

    // The colours that answer "what goes on top of this" are opposites, which
    // is the whole point: white on a dark hover, near-black on a light one.
    assert.notStrictEqual(THEMES.light['--text-on-hover'], THEMES.dark['--text-on-hover']);
    assert.notStrictEqual(THEMES.light['--surface-hover'], THEMES.dark['--surface-hover']);
    assert.notStrictEqual(THEMES.light['--accent-text'], THEMES.dark['--accent-text']);
});

test('what is written on the accent is chosen for the accent', () => {
    for (const theme of ['light', 'dark']) {
        const accent = firstColour(resolve(THEMES[theme]['--accent-primary'], THEMES[theme]));
        const onAccent = firstColour(resolve(THEMES[theme]['--text-on-accent'], THEMES[theme]));
        assert.ok(contrast(onAccent, accent) >= 4.5, theme + ' text on the accent is readable');

        const danger = firstColour(resolve(THEMES[theme]['--danger'], THEMES[theme]));
        const onDanger = firstColour(resolve(THEMES[theme]['--text-on-danger'], THEMES[theme]));
        assert.ok(contrast(onDanger, danger) >= 4, theme + ' text on a destructive button is readable');
    }
});

// ============================================
// States
// ============================================

const HOVER_FAMILIES = [
    '.libcard:hover',
    '.songslist ul li:hover',
    '.search-result-item:hover',
    '.context-menu-item:hover',
    '.menu-option:hover',
    '.dropdown-item:hover',
    '.album-list-item:hover',
    '.add-songs-item:hover',
    '.sidebar-nav-item:hover',
    '.card-size-btn:hover',
    '.backup-btn:hover',
    '.user-menu-btn:hover',
    '.btn-secondary:hover',
    '.device-upload-area:hover',
    '.import-area:hover'
];

test('a surface that changes under the pointer says what goes on it', () => {
    for (const theme of ['light', 'dark']) {
        for (const selector of HOVER_FAMILIES) {
            const colour = effective(selector, theme, 'color');
            assert.ok(colour, theme + ': ' + selector + ' states its foreground');

            const ratio = readability(selector, theme);
            if (ratio === null) continue;
            assert.ok(ratio >= 3.5, theme + ': ' + selector + ' stays readable (' + ratio + ')');
        }
    }
});

test('a destructive row is a warning in both themes, and never a whisper', () => {
    for (const theme of ['light', 'dark']) {
        const ratio = readability('.menu-option.delete-option:hover', theme);
        assert.ok(ratio !== null, theme + ' says what a delete row looks like');
        assert.ok(ratio >= 3.5, theme + ' delete row is readable (' + ratio + ')');
    }
});

test('nothing in the sheet writes light text that only the dark theme answers', () => {
    // Every rule that paints text is checked against the light theme: a colour
    // that stays light there is a rule written for one theme only.
    const covered = new Set();
    for (const rule of RULES) {
        if (!/\[data-theme="light"\]/.test(rule.selector)) continue;
        for (const part of rule.selector.split(',')) {
            covered.add(part.replace(/\[data-theme="light"\]/g, '').replace(/\s+/g, ' ').trim());
        }
    }

    // Rules whose light text sits on a colour of its own - a red button, the
    // accent, a photograph - are answered by that colour, not by the theme.
    const onOwnSurface = /badge|btn-danger|danger|toast|remove-image|card-menu-btn|theme-icon|play|overlay|gradient|status|admin/i;

    const offenders = [];
    for (const rule of RULES) {
        const selector = rule.selector.replace(/\s+/g, ' ').trim();
        if (/\[data-theme="light"\]/.test(selector)) continue;

        const colour = declarationsOf(rule.body)['color'];
        if (!colour) continue;

        const resolved = firstColour(resolve(colour, THEMES.light));
        if (!resolved || luminance(resolved) <= 0.6) continue;
        if (onOwnSurface.test(selector)) continue;
        if (declarationsOf(rule.body)['background'] || declarationsOf(rule.body)['background-color']) continue;

        const parts = selector.split(',').map((part) => part.trim());
        if (parts.every((part) => !covered.has(part))) offenders.push(selector.slice(0, 80));
    }

    assert.deepStrictEqual(offenders, [], 'every one of these needs a light-theme answer');
});

test('the keyboard is shown where it is, in a colour each theme can show', () => {
    const rule = RULES.find((entry) => /button:focus-visible/.test(entry.selector) && /outline/.test(entry.body));
    assert.ok(rule, 'focus is drawn as an outline');
    assert.match(rule.body, /var\(--focus-ring\)/, 'and the colour comes from the theme');

    for (const theme of ['light', 'dark']) {
        const ring = firstColour(resolve(THEMES[theme]['--focus-ring'], THEMES[theme]));
        assert.ok(contrast(ring, PAGE[theme]) >= 3, theme + ' focus ring stands out from the page');
    }
});

test('the theme is a set of variables, so a change reaches what is already on screen', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The page switches themes by saying which one it is, and lets the
    // stylesheet answer: nothing paints colours onto elements by hand.
    assert.match(player, /document\.documentElement\.setAttribute\('data-theme', theme\)/);
    assert.ok(!/style\.color\s*=\s*['"#]/.test(player), 'no colour is set on an element by script');
    assert.ok(!/style\.backgroundColor\s*=\s*['"#]/.test(player), 'nor a background');
});


// ============================================
// The developer's portrait
// ============================================

/** Width and height of a JPEG, read from its own frame header. */
function jpegSize(buffer) {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    let i = 2;
    while (i < buffer.length - 9) {
        if (buffer[i] !== 0xff) {
            i += 1;
            continue;
        }
        const marker = buffer[i + 1];
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
        i += 2 + buffer.readUInt16BE(i + 2);
    }
    return null;
}

test('the developer page shows a portrait, cropped rather than squashed', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'developer.html'), 'utf8');

    const referenced = [...page.matchAll(/src="(img\/developer-avatar[^"]*)"/g)].map((entry) => entry[1]);
    assert.ok(referenced.length > 0, 'the page shows a portrait');

    for (const reference of referenced) {
        const file = path.join(__dirname, '..', reference);
        assert.ok(fs.existsSync(file), reference + ' is there to load');

        const image = fs.readFileSync(file);
        const size = jpegSize(image);
        assert.ok(size, reference + ' is a photograph');
        assert.strictEqual(size.width, size.height, reference + ' is square, as the circle it is shown in');
        assert.ok(size.width >= 320, reference + ' is sharp enough for the size it is shown at');
        assert.ok(image.length < 400 * 1024, reference + ' is small enough to send (' + Math.round(image.length / 1024) + ' KB)');
    }

    // The picture fills its circle by being cropped, never by being stretched.
    assert.match(page, /\.avatar \{[\s\S]{0,400}object-fit: cover;/);
    assert.match(page, /\.avatar \{[\s\S]{0,400}border-radius: 50%;/);

    // Nothing else on the page was swapped for it.
    assert.match(page, /src="img\/logo\.webp"/, 'the logo is still the logo');
});

// ============================================
// Icons that are pictures, not letters
// ============================================

/**
 * Every leaf rule again, this time remembering which media queries it sits
 * inside - a hover that only a pointer may trigger has to be told apart from
 * one that fires on a tap.
 */
function rulesWithMedia(css) {
    const text = stripComments(css);
    const out = [];
    const stack = [];
    let buffer = '';

    for (const ch of text) {
        if (ch === '{') {
            stack.push(buffer.trim());
            buffer = '';
            continue;
        }
        if (ch === '}') {
            const prelude = stack.pop() || '';
            if (prelude && !prelude.startsWith('@')) {
                out.push({
                    selector: prelude,
                    body: buffer,
                    media: stack.filter((entry) => entry.startsWith('@'))
                });
            }
            buffer = '';
            continue;
        }
        buffer += ch;
    }

    return out;
}

const MEDIA_RULES = rulesWithMedia(CSS);

/** Every rule written for exactly this selector. */
function rulesNamed(selector) {
    return MEDIA_RULES.filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector));
}

/** What a property is set to for a selector, taking the last word on it. */
function settingOf(selector, property) {
    let value = null;
    rulesNamed(selector).forEach((rule) => {
        const found = declarationsOf(rule.body)[property];
        if (found) value = found;
    });
    return value;
}

/**
 * The header and sidebar icons are <img> elements tinted by a filter, and the
 * theme is what sets that filter: invert(1) paints a dark drawing white for
 * the dark theme, invert(0) leaves it dark for the light one.
 *
 * A hover that sets a `filter` of its own does not add to that - it replaces
 * it. `filter: brightness(1.8)` on a light page took a dark icon and
 * brightened it into the surface behind it, which is how the hamburger, the
 * drawer's close control and the search icon came to disappear when pointed
 * at. The same rule on a song's thumbnail inverted the photograph.
 */
test('no hover repaints an icon the theme has already coloured', () => {
    const offenders = [];

    MEDIA_RULES.forEach((rule) => {
        if (!/:hover|:focus/.test(rule.selector)) return;

        const filter = declarationsOf(rule.body).filter;
        // Only `none` is safe: it hands the icon back to the theme.
        if (!filter || filter.trim() === 'none') return;
        offenders.push(rule.selector.replace(/\s+/g, ' ') + ' { filter: ' + filter.trim() + ' }');
    });

    assert.deepStrictEqual(offenders, [], 'a hover must not set a filter of its own');
});

test('the controls that open and close the library are legible in both themes', () => {
    ['.hamburger', '.close'].forEach((selector) => {
        assert.strictEqual(settingOf(selector, 'color'), 'var(--text-primary)', selector + ' is written in the theme');

        const focused = rulesNamed(selector + ':focus-visible');
        assert.ok(focused.length > 0, selector + ' answers the keyboard');
        assert.match(focused[0].body, /background-color:\s*var\(--surface-hover\)/);
        assert.match(focused[0].body, /color:\s*var\(--text-on-hover\)/);

        // Pressing one is answered on every device, pointer or not.
        const pressed = rulesNamed(selector + ':active');
        assert.ok(pressed.length > 0, selector + ' answers a press');
        assert.match(pressed[0].body, /background-color:\s*var\(--surface-active\)/);
    });
});

test('the search box and the sidebar rows take a surface each theme answers', () => {
    // The fixed darks that used to be here became a dark surface under dark
    // text the moment the light theme was on.
    assert.strictEqual(settingOf('.search-box', 'background-color'), 'var(--bg-elevated)');
    assert.strictEqual(settingOf('.search-input', 'color'), 'var(--text-primary)');
    assert.strictEqual(settingOf('.search-input::placeholder', 'color'), 'var(--placeholder)');

    const focused = rulesNamed('.search-box:focus-within');
    assert.ok(focused.length > 0);
    assert.match(focused[0].body, /background-color:\s*var\(--surface-hover\)/);
    assert.match(focused[0].body, /border-color:\s*var\(--focus-ring\)/);

    // The words on that surface are named beside it.
    assert.ok(
        rulesNamed('.search-box:hover .search-input').length > 0 ||
            /\.search-box:hover \.search-input/.test(CSS),
        'the text on the hovered box is stated'
    );

    // A sidebar row's wash was a fixed white one, invisible on a light page.
    const row = rulesNamed('.sidebar-nav-item:focus-visible');
    assert.ok(row.length > 0, 'a row answers the keyboard');
    assert.match(row[0].body, /background-color:\s*var\(--surface-hover\)/);
    assert.match(row[0].body, /color:\s*var\(--text-on-hover\)/);

    const washes = rulesNamed('.sidebar-nav-item:hover').concat(rulesNamed('.sidebar-nav-item:active'));
    washes.forEach((rule) => {
        assert.ok(!/rgba\(255,\s*255,\s*255/.test(rule.body), 'no fixed white wash under a sidebar row');
    });
});

test('the light theme does not dim its own icons before anything is pointed at', () => {
    ['[data-theme="light"] .heading img', '[data-theme="light"] .home ul li img'].forEach((selector) => {
        const rule = rulesNamed(selector);
        assert.ok(rule.length > 0, selector + ' is themed');
        assert.match(rule[0].body, /filter:\s*invert\(0\)/, selector + ' keeps its own colours');
        assert.ok(!/opacity/.test(rule[0].body), selector + ' is not dimmed');
    });
});

test('pointing is a thing only a pointer does', () => {
    // A tap leaves :hover stuck on a touch screen, so a wash would stay under
    // a control nobody is touching. These are gated; the keyboard and the
    // press are not, so nothing is out of reach on a phone.
    ['.hamburger:hover', '.close:hover', '.sidebar-nav-item:hover', '.search-box:hover'].forEach((selector) => {
        const rules = rulesNamed(selector);
        assert.ok(rules.length > 0, selector + ' exists');

        rules.forEach((rule) => {
            assert.ok(
                rule.media.some((query) => /hover:\s*hover/.test(query) && /pointer:\s*fine/.test(query)),
                selector + ' is only for a pointer'
            );
        });
    });
});


// ============================================
// The one control everything else is arranged around
// ============================================

/**
 * Play used to be a disc of the theme's own text colour. On a dark page that
 * is a white circle, which is right; on a light one it is very nearly black,
 * which put a black circle in the middle of a pale player. It takes the
 * accent now - the same green the album's own Play button takes - so the two
 * agree and neither depends on which theme is on.
 */
test('Play is the accent in both themes, and never a black disc', () => {
    assert.strictEqual(settingOf('.player-btn-primary', 'background-color'), 'var(--accent-primary)');
    assert.strictEqual(settingOf('.player-btn-primary', 'color'), 'var(--text-on-accent)');

    // Nothing repaints it for one theme in particular.
    const themed = MEDIA_RULES.filter(
        (rule) => /\[data-theme/.test(rule.selector) && /player-btn-primary/.test(rule.selector)
    );
    assert.deepStrictEqual(themed, [], 'one rule serves both themes');

    // And the album's own Play button is the same control, said the same way.
    assert.strictEqual(settingOf('.album-detail-play', 'background-color'), 'var(--accent-primary)');
    assert.strictEqual(settingOf('.album-detail-play', 'color'), 'var(--text-on-accent)');
});

test('every state of Play is readable in both themes', () => {
    const states = {
        ':hover': 'var(--accent-hover)',
        ':focus-visible': 'var(--accent-hover)',
        ':active': 'var(--accent-primary)',
        ':disabled': 'var(--accent-primary)'
    };

    Object.keys(states).forEach((state) => {
        const rules = rulesNamed('.player-btn-primary' + state);
        assert.ok(rules.length > 0, 'Play answers ' + state);
        assert.match(rules[0].body, new RegExp('background-color:\\s*' + states[state].replace(/[()-]/g, '\\$&')));
        assert.match(rules[0].body, /color:\s*var\(--text-on-accent\)/, state + ' says what is on it');
    });

    // Measured, in each theme: the mark on the button, and the button on the
    // surface it sits on.
    ['dark', 'light'].forEach((theme) => {
        const tokens = tokensFor(theme);
        assert.ok(
            contrast(toRgb(tokens['--text-on-accent']), toRgb(tokens['--accent-primary'])) >= 4.5,
            'Play reads at rest in the ' + theme + ' theme'
        );
        assert.ok(
            contrast(toRgb(tokens['--text-on-accent']), toRgb(tokens['--accent-hover'])) >= 4.5,
            'and when it is pointed at'
        );
    });
});

test('the mark on Play is left as it was drawn, in either theme', () => {
    // The icons are dark drawings, and dark is what reads on the green - so
    // nothing inverts them, and nothing has to know which theme is on.
    const rules = rulesNamed('.player-btn-primary img');
    assert.ok(rules.length > 0);
    assert.match(rules[0].body, /filter:\s*none/);

    // A dark drawing on the accent, measured.
    ['dark', 'light'].forEach((theme) => {
        assert.ok(
            contrast(toRgb('#141b34'), toRgb(tokensFor(theme)['--accent-primary'])) >= 4.5,
            'the mark reads on the accent in the ' + theme + ' theme'
        );
    });
});

test('the same Play button serves every size of player', () => {
    // One control, in the playbar - which is the desktop, tablet and phone
    // player alike - and in Now Playing.
    const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.match(page, /id="play" class="player-btn player-btn-primary/);
    assert.match(page, /id="npPlay"[^>]*class="player-btn player-btn-primary player-btn-large/);

    // The breakpoints change how big it is and nothing about how it looks.
    rulesNamed('.player-btn-primary').forEach((rule) => {
        if (!rule.media.length) return;
        assert.ok(
            !/background|color|filter/.test(rule.body),
            'a breakpoint sets only its size: ' + rule.body.trim()
        );
    });
});


// ============================================
// An album's name, in the theme's own colour
// ============================================

/**
 * The title had been swept into the rule that describes the green play disc,
 * so it took the colour meant to be read *on* the accent - black in the dark
 * theme. A title could not be read until it was pointed at and the hover rule
 * painted it back.
 */
test('an album title is written in the theme, not on the accent', () => {
    assert.strictEqual(settingOf('.card h2', 'color'), 'var(--text-primary)');
    assert.strictEqual(settingOf('.card p', 'color'), 'var(--text-secondary)');

    // Nothing else claims the title.
    const claims = MEDIA_RULES.filter(
        (rule) =>
            rule.selector.split(',').some((part) => part.trim() === '.card h2') &&
            /(?:^|;)\s*color\s*:/.test(rule.body)
    );
    assert.strictEqual(claims.length, 1, 'one rule says what colour a title is');

    // And it reads on the card it sits on, before anything is pointed at.
    ['dark', 'light'].forEach((theme) => {
        const tokens = tokensFor(theme);
        assert.ok(
            contrast(toRgb(tokens['--text-primary']), toRgb(tokens['--card-bg'])) >= 4.5,
            'a title reads on a card in the ' + theme + ' theme'
        );
        assert.ok(
            contrast(toRgb(tokens['--text-secondary']), toRgb(tokens['--card-bg'])) >= 4.5,
            'and so does the artist under it'
        );
    });
});

test('the slider that opens on demand is readable in both themes', () => {
    assert.strictEqual(settingOf('.volume-popover', 'background-color'), 'var(--bg-elevated)');
    assert.match(settingOf('.volume-popover', 'border'), /var\(--border-color\)/);

    ['dark', 'light'].forEach((theme) => {
        const tokens = tokensFor(theme);
        assert.ok(
            contrast(toRgb(tokens['--text-primary']), toRgb(tokens['--bg-elevated'])) >= 4.5,
            'what is on it reads in the ' + theme + ' theme'
        );
    });
});


// ============================================
// The note shown in place of a picture
// ============================================

/** Every surface a fallback note is ever drawn on. */
const NOTE_SURFACES = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-elevated', '--card-bg', '--surface-hover'];

/** The green the note file is drawn in. */
const NOTE_INK = '#1db954';

/** What a theme's tint leaves that green as. */
function noteColour(theme) {
    const tint = tokensFor(theme)['--music-fallback-tint'];
    assert.ok(tint, 'the theme says what it does to the note');

    const drawn = toRgb(NOTE_INK);
    if (tint.trim() === 'none') return drawn;

    const brightness = /^brightness\(([\d.]+)\)$/.exec(tint.trim());
    assert.ok(brightness, 'the only adjustment is a darkening: ' + tint);

    const factor = Number(brightness[1]);
    return {
        r: Math.round(drawn.r * factor),
        g: Math.round(drawn.g * factor),
        b: Math.round(drawn.b * factor),
        a: 1
    };
}

test('the note stood in for a missing cover is green, and reads in both themes', () => {
    // It used to be drawn near-black, which measured 1.02 against a dark tile:
    // there, and impossible to see.
    ['dark', 'light'].forEach((theme) => {
        const colour = noteColour(theme);

        // Green, not a neutral: the other two channels sit below the green one.
        assert.ok(colour.g > colour.r && colour.g > colour.b, 'the note is green in the ' + theme + ' theme');

        const tokens = tokensFor(theme);
        NOTE_SURFACES.forEach((name) => {
            const ratio = contrast(colour, toRgb(tokens[name]));
            assert.ok(ratio >= 4.5, 'the note reads on ' + name + ' in the ' + theme + ' theme (' + ratio + ')');
        });
    });

    // The dark theme is the one the file was drawn for, so it does nothing at
    // all to it - which is what makes the very first paint already green.
    assert.strictEqual(tokensFor('dark')['--music-fallback-tint'], 'none');
    assert.notStrictEqual(tokensFor('light')['--music-fallback-tint'], 'none');
});

test('the note arrives green rather than being corrected afterwards', () => {
    // A stylesheet can only arrive after the picture it describes, so a note
    // tinted in CSS alone would be navy for a moment and green after. The file
    // itself carries the accent, and nothing in it is the old near-black.
    const note = fs.readFileSync(path.join(__dirname, '..', 'img', 'music.svg'), 'utf8');

    assert.ok(!/#141B34/i.test(note), 'nothing in the note is drawn in the old ink');
    assert.match(note, new RegExp('stroke="' + NOTE_INK + '"'), 'it is drawn in the accent');

    // Its shape is untouched: same canvas, same paths.
    assert.match(note, /viewBox="0 0 24 24"/);
    assert.strictEqual((note.match(/<circle|<path/g) || []).length, 4, 'the same four strokes it always had');
});

test('one rule adjusts the note wherever it is shown, and only the note', () => {
    // The rules that *use* the token, not the two that declare it.
    const tinted = MEDIA_RULES.filter((rule) => rule.body.includes('var(--music-fallback-tint)'));
    assert.strictEqual(tinted.length, 1, 'the note is adjusted in one place');

    // Matched by the file's own address, so every fallback is covered at once
    // - the painters' and the ones an image that failed to load falls back to.
    const selector = tinted[0].selector;
    [
        '.card-art img',
        '.song-icon',
        '.album-track-art',
        '.playbar-artwork',
        '.now-playing-artwork',
        '.album-detail-cover',
        '.search-result-item img',
        '.album-list-item img'
    ].forEach((part) => {
        assert.ok(selector.includes(part), 'it reaches ' + part);
    });

    // Every one of those is qualified by the file's address, so a real cover -
    // uploaded, published or chosen by hand - is never touched by any of it.
    selector.split(',').forEach((part) => {
        assert.match(part.trim(), /\[src\$="img\/music\.svg"\]$/, part.trim() + ' names the default picture');
    });

    // The whole rule is the tint: nothing about size, shape or position.
    const body = tinted[0].body;
    assert.match(body, /filter:\s*var\(--music-fallback-tint\)/);
    assert.ok(
        !/(?:^|;)\s*(width|height|padding|aspect-ratio|border-radius|object-fit|mask|background)/.test(body),
        'its geometry and its picture are left alone'
    );
});

test('no fallback music note anywhere is left in the old ink', () => {
    // The whole project, not this stylesheet alone. The other icons drawn in
    // that ink are the transport and menu controls, which the themes turn
    // about on purpose; the note is the one that had to stop being navy.
    const root = path.join(__dirname, '..');
    const files = [];

    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.spotifie') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(svg|css|js|html)$/.test(entry.name)) files.push(full);
        }
    })(root);

    files.forEach((file) => {
        if (file.includes(path.join('test', ''))) return;
        const text = fs.readFileSync(file, 'utf8');
        if (!/#141B34/i.test(text)) return;

        // Whatever still carries it must not be a music note.
        assert.ok(
            !/music/i.test(path.basename(file)),
            path.basename(file) + ' is a music graphic still drawn in the old ink'
        );
        assert.ok(
            !/M10 18\.5L10 7|circle cx="6\.5" cy="18\.5"/.test(text),
            file + ' draws the music note in the old ink'
        );
    });
});


// ============================================
// The search field, and the pill around it
// ============================================

test('the search field has no edge of its own; the pill around it has', () => {
    // The field asks for no outline, but the rule that gives every control a
    // focus ring names `input` - which outranks it - so a square green ring
    // was drawn inside the rounded pill.
    const field = ruleBodies('.search-box .search-input:focus-visible');
    assert.ok(field.length > 0, 'the field says what its focus looks like');
    assert.match(field[0], /outline:\s*none/);
    assert.match(field[0], /border:\s*none/);
    assert.match(field[0], /background:\s*transparent/);

    // The pill is what lights up, so the keyboard is still plainly shown.
    const pill = ruleBodies('.search-box:focus-within');
    assert.ok(pill.length > 0, 'the pill answers the keyboard');
    assert.match(pill[0], /border-color:\s*var\(--focus-ring\)/);
    assert.match(pill[0], /background-color:\s*var\(--surface-hover\)/);

    // One rounded container, and the field inside it carries no surface.
    assert.match(settingOf('.search-box', 'border-radius'), /500px/);
    assert.strictEqual(settingOf('.search-input', 'background'), 'transparent');
    assert.strictEqual(settingOf('.search-input', 'border'), 'none');

    // And what is typed still reads on the surface the focus gives it, in
    // both themes.
    ['dark', 'light'].forEach((theme) => {
        const tokens = tokensFor(theme);
        assert.ok(
            contrast(toRgb(tokens['--text-primary']), toRgb(tokens['--surface-hover'])) >= 4.5,
            'the typing reads while focused in the ' + theme + ' theme'
        );
    });
});
