'use strict';

/**
 * Nothing wider than the phone it is on.
 *
 * A page that is one pixel wider than the screen can be dragged sideways, and
 * on a phone that feels like the whole application coming loose. The defect
 * that prompted this was exactly that: a column asking for the width of the
 * window and then adding its own margin, and a player bar built the same way.
 *
 * Layout itself is measured in a browser (the widths in WIDTHS, against the
 * real pages), because a rule cannot be read for what it computes to. What is
 * held here are the rules that made it possible: no element may take the
 * window's own width and then add to it, and the parts that must fill the
 * screen are fixed to its edges instead.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STYLE = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const AUTH = fs.readFileSync(path.join(ROOT, 'css', 'auth.css'), 'utf8');

/** The phone widths the layout is checked at, narrowest first. */
const WIDTHS = [320, 340, 360, 375, 384, 393, 400, 412, 430];

/** One CSS rule's body, by selector, within an optional block of the file. */
function ruleBody(css, selector, from) {
    const start = css.indexOf(selector + ' {', from || 0);
    if (start === -1) return null;
    return css.slice(start, css.indexOf('}', start));
}

/** Every rule body for a selector, in file order. */
function allRules(css, selector) {
    const bodies = [];
    let at = 0;
    for (;;) {
        const body = ruleBody(css, selector, at);
        if (!body) return bodies;
        bodies.push(body);
        at = css.indexOf(body, at) + body.length;
    }
}

test('the phone widths the layout is answerable for', () => {
    assert.ok(WIDTHS[0] === 320 && WIDTHS[WIDTHS.length - 1] === 430);
    // The width a Redmi Note 9 reports, which is where this was first seen.
    assert.ok(WIDTHS.includes(393));
});

test('nothing takes the window width and then adds its own margin', () => {
    // .right sits in a flex row beside the library and carries a margin. A
    // window-wide column plus that margin is a page wider than the screen.
    allRules(STYLE, '.right').forEach((body) => {
        assert.ok(!/width:\s*100vw/.test(body), '.right must not be as wide as the window: ' + body.trim().slice(0, 80));
    });

    // The player bar is fixed to both edges rather than measured against the
    // window, so a rounding error cannot push the page sideways.
    allRules(STYLE, '.playbar').forEach((body) => {
        assert.ok(!/width:\s*calc\(100vw/.test(body), 'the player must not be sized from the window width');
    });

    const player = allRules(STYLE, '.playbar').filter((body) => /left:\s*max\(/.test(body));
    assert.ok(player.length >= 2, 'the player is held to both edges at phone and tablet widths');
    player.forEach((body) => {
        assert.match(body, /left:\s*max\([^)]*env\(safe-area-inset-left/, 'and keeps clear of what the device keeps down the sides');
        assert.match(body, /right:\s*max\([^)]*env\(safe-area-inset-right/);
        assert.match(body, /width:\s*auto/);
    });
});

test('what fills the screen fills its own view, not the window', () => {
    // Inside a view that is already the whole screen, 100vw takes no notice of
    // what the device keeps for itself down the sides.
    const panel = allRules(STYLE, '.now-playing-panel').find((body) => /width:/.test(body) && /max-width:/.test(body));
    assert.ok(panel, 'the full-screen Now Playing rule exists');
    assert.ok(!/100vw/.test(panel), 'and is not measured against the window');

    // The drawer is fixed and off-screen when closed; it must not be able to
    // make the page itself wider.
    allRules(STYLE, '.left')
        .filter((body) => /position:\s*fixed/.test(body))
        .forEach((body) => {
            assert.match(body, /position:\s*fixed/);
            assert.ok(!/max-width:\s*100vw/.test(body), 'a closed drawer is measured against its view, not the window');
        });
});

test('every remaining window-width rule leaves room rather than filling it', () => {
    // 100vw is still right for "at most the window, less a margin" - a menu
    // or a dialog clamped so it cannot reach the edges. What is refused is a
    // bare 100vw, or one that something else then adds to.
    const uses = (STYLE.match(/[^\n]*100vw[^\n]*/g) || []).map((line) => line.trim());
    uses.forEach((line) => {
        const clamped = /min\(|max-width|calc\(100vw\s*-/.test(line);
        assert.ok(clamped, 'this asks for the whole window width: ' + line);
    });

    // The pages a person signs in on are sized the same way.
    assert.ok(!/100vw/.test(AUTH), 'the auth pages never measure the window');
});

test('the mobile viewport still asks for the whole screen, and still scales', () => {
    ['index.html', 'signin.html', 'signup.html', 'forgot-password.html', 'reset-password.html'].forEach((page) => {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        const meta = /<meta name="viewport" content="([^"]+)">/.exec(html);
        assert.ok(meta, page + ' declares a viewport');
        assert.match(meta[1], /width=device-width/, page);
        // The Android app draws behind the status bar and needs this.
        assert.match(meta[1], /viewport-fit=cover/, page);
        // Nothing here may stop somebody zooming in.
        assert.ok(!/user-scalable\s*=\s*no|maximum-scale/.test(meta[1]), page + ' does not block zooming');
    });
});

test('a stray oversized thing still cannot drag the page sideways', () => {
    // The guard, not the fix: it is here because one long word or a menu at
    // the edge should not turn the page into something that pans.
    const guard = ruleBody(STYLE, 'html,\nbody');
    assert.ok(guard, 'the document and the body are both guarded');
    assert.match(guard, /max-width:\s*100%/);
    // clip does not make a scroll container (which would break sticky);
    // hidden stays first for a WebView too old to know clip.
    assert.match(guard, /overflow-x:\s*hidden;\s*\n\s*overflow-x:\s*clip/);
});

test('the main column and its rows are allowed to be narrow', () => {
    // A flex or grid child holding text keeps its widest row's width unless it
    // is told it may shrink, and then the page grows sideways instead.
    const narrow = allRules(STYLE, '.right').some((body) => /min-width:\s*0/.test(body));
    assert.ok(narrow, 'the main column may be narrower than its widest row');

    assert.match(STYLE, /\.container \{[^}]*min-width:\s*0/, 'and so may the row it is in');
});
