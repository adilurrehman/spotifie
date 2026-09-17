'use strict';

/**
 * Build the desktop application's frontend.
 *
 * The desktop application is this web application inside a small native shell
 * (Tauri), so its frontend is the public build: the same pages, scripts and
 * styles, not a second copy of the interface. What changes on the way in:
 *
 * - it is built strictly. Missing or placeholder Supabase settings stop the
 *   build, exactly as they stop a deploying one, and no value is printed;
 * - nothing administrative goes in. The dashboard, its script and the link to
 *   it are left out, whether or not this working copy has the private source;
 * - only what a window needs goes in. The Node server, its modules, the
 *   database schema, the READMEs, the host's headers file, the crawler files
 *   and the service worker (the files are on disk already) stay out;
 * - every page carries a content security policy of its own, because a
 *   shell has no host to send one;
 * - the result is checked before anything is packaged: no private file, no
 *   secret, no audio, no path from this machine.
 *
 * Run it with: npm run build:desktop (desktop:dev and desktop:build run it).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Where the frontend is written for the shell to bundle, and where the public
// build is staged first. Overridable so the tests build somewhere of their own.
const OUT = process.env.SPOTIFIE_DESKTOP_OUT
    ? path.resolve(process.env.SPOTIFIE_DESKTOP_OUT)
    : path.join(ROOT, 'desktop', 'dist');
const STAGE = OUT + '.stage';

// The public builder writes wherever this says, so it is set before it loads.
process.env.SPOTIFIE_RELEASE_OUT = STAGE;
const builder = require('./buildPublic.js');
const checker = require('./releaseCheck.js');

/** What a window needs, and nothing else. */
const DIRECTORIES = ['css', 'js', 'img', 'favicons'];
const FILES = ['manifest.webmanifest', 'config.json', 'build-info.json'];

/** Never in a desktop package, whatever the working copy holds. */
const NEVER = [/(^|\/)js\/admin\.js$/i, /(^|\/)admin-dashboard\.html$/i, /(^|\/)admin-login\.html$/i, /(^|\/)sw\.js$/i];

function walk(directory) {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...walk(full));
        else found.push(full);
    }
    return found;
}

function relative(file) {
    return path.relative(OUT, file).split(path.sep).join('/');
}

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

/**
 * The policy each page carries inside the shell.
 *
 * The same rules the web host sends, written for a window: the Supabase
 * project (and its realtime socket), the Supabase library from its CDN, the
 * fonts, a local helper on loopback, and the shell's own IPC channel. Nothing
 * else may be fetched, framed or run.
 */
function desktopCsp() {
    let supabase = '';
    try {
        supabase = new URL((process.env.SUPABASE_URL || '').trim()).origin;
    } catch (e) {
        supabase = '';
    }

    const helper = 'http://127.0.0.1:3000 http://localhost:3000';
    const ipc = 'ipc: http://ipc.localhost';

    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        ["img-src 'self'", supabase, 'data: blob:', helper, 'https://ui-avatars.com'].filter(Boolean).join(' '),
        ["media-src 'self'", supabase, 'blob:', helper].filter(Boolean).join(' '),
        ["connect-src 'self'", supabase, supabase.replace(/^https:/, 'wss:'), helper, ipc].filter(Boolean).join(' '),
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'"
    ].join('; ');
}

function withCsp(html, csp) {
    const tag = '<meta http-equiv="Content-Security-Policy" content="' + csp.replace(/"/g, '&quot;') + '">';
    if (/<meta charset="[^"]*">/i.test(html)) {
        return html.replace(/<meta charset="[^"]*">/i, (charset) => charset + '\n    ' + tag);
    }
    return html.replace(/<head>/i, '<head>\n    ' + tag);
}

/**
 * Refuse a frontend that carries anything it should not.
 *
 * The release check's own rules (private files, secrets, audio), plus the
 * desktop's: nothing administrative, no service worker, and no path from the
 * machine it was built on.
 */
function inspect() {
    const failures = [];
    const home = os.homedir();
    const machinePaths = [ROOT, home].filter((value) => value && value.length > 3);

    for (const file of walk(OUT)) {
        const name = relative(file);

        for (const pattern of checker.FORBIDDEN_PATHS) {
            if (pattern.test(name)) failures.push(name + ' must not be in a desktop package.');
        }
        for (const pattern of NEVER) {
            if (pattern.test(name)) failures.push(name + ' must not be in a desktop package.');
        }
        if (checker.AUDIO_EXTENSIONS.test(name)) failures.push(name + ' is audio. A package carries no music.');

        if (!/\.(html|js|css|json|webmanifest|svg|txt)$/i.test(name)) continue;
        const text = fs.readFileSync(file, 'utf8');

        for (const rule of checker.FORBIDDEN_CONTENT) {
            if (rule.pattern.test(text)) failures.push(name + ' contains ' + rule.name + '.');
        }
        for (const value of machinePaths) {
            if (text.indexOf(value) !== -1 || text.indexOf(value.split(path.sep).join('/')) !== -1) {
                failures.push(name + ' names a path on the machine it was built on.');
            }
        }
    }

    return failures;
}

function build(options) {
    // Which shell this frontend is for: the desktop app or the Android app.
    // The frontend is the same; only the words in the report differ.
    const label = (options && options.label) || 'Desktop';

    // The public build, strictly, and without the administrative half.
    builder.build({ mode: 'public', strict: true, withoutAdmin: true });

    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });

    const csp = desktopCsp();

    for (const page of builder.PAGES) {
        const from = path.join(STAGE, page);
        if (!fs.existsSync(from)) continue;
        fs.writeFileSync(path.join(OUT, page), withCsp(fs.readFileSync(from, 'utf8'), csp));
    }

    for (const directory of DIRECTORIES) {
        const base = path.join(STAGE, directory);
        if (!fs.existsSync(base)) continue;
        for (const file of walk(base)) {
            const name = path.relative(STAGE, file).split(path.sep).join('/');
            if (NEVER.some((pattern) => pattern.test(name))) continue;
            copy(file, path.join(OUT, name));
        }
    }

    for (const file of FILES) {
        const from = path.join(STAGE, file);
        if (fs.existsSync(from)) copy(from, path.join(OUT, file));
    }

    fs.rmSync(STAGE, { recursive: true, force: true });

    const failures = inspect();
    if (failures.length) {
        throw new Error('The ' + label.toLowerCase() + ' frontend is not fit to package:\n  - ' + failures.join('\n  - '));
    }

    const files = walk(OUT);
    const bytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
    console.log('');
    console.log(label + ' frontend built in ' + path.relative(ROOT, OUT));
    console.log('  ' + files.length + ' files, ' + Math.round(bytes / 1024) + ' KB');
    console.log('  No admin source, no server, no service worker, no secrets, no machine paths.');
}

if (require.main === module) {
    try {
        build();
    } catch (err) {
        fs.rmSync(STAGE, { recursive: true, force: true });
        console.error('Could not build the desktop frontend: ' + err.message);
        process.exit(1);
    }
}

module.exports = { build, inspect, desktopCsp, withCsp, OUT, STAGE, NEVER };
