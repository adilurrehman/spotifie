'use strict';

/**
 * What gets published, and what must never be.
 *
 * The release is built from an allowlist rather than filtered from the working
 * copy, so the administrator pages and the private modules are absent by
 * construction. That is the important half. This is the other half: the checks
 * that would catch it if the construction were ever wrong, and the ones that
 * describe what a static host is told about the files it does publish.
 *
 * Three things run through it.
 *
 * A published copy is the application and nothing else. No audio, no library,
 * no state belonging to anybody, no administrator anything, and no key beyond
 * the two public Supabase values a browser has always had.
 *
 * The release is also a Node application - it carries the server somebody can
 * run themselves - and a static host must not serve that half as files. The
 * list that prevents it is checked here rather than trusted.
 *
 * And nothing claims an address it does not have. A canonical URL naming the
 * machine a build happened on is worse than no canonical URL at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// This file's own release, rather than the one in the working copy. Test files
// run beside each other, a build begins by emptying the directory it is given,
// and another file here builds a release and then starts it - so sharing one
// directory means one of them occasionally reads a release that is only half
// written.
const DIST = path.join(os.tmpdir(), 'spotifie-release-deployment-test');

/**
 * Build the release once for the whole file, with the settings a deployment
 * would supply. Placeholders: nothing here is a real project.
 */
let built = false;

function release() {
    if (!built) {
        execFileSync(process.execPath, [path.join(ROOT, 'tools', 'buildPublic.js')], {
            cwd: ROOT,
            stdio: 'ignore',
            env: Object.assign({}, process.env, {
                SPOTIFIE_RELEASE_OUT: DIST,
                SUPABASE_URL: 'https://example.supabase.co',
                SUPABASE_ANON_KEY: 'public-anon-placeholder',
                PUBLIC_SITE_URL: 'https://spotifie.example'
            })
        });
        built = true;
    }
    return DIST;
}

function walk(directory) {
    const out = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

function relative(file) {
    return path.relative(DIST, file).split(path.sep).join('/');
}

function read(name) {
    return fs.readFileSync(path.join(release(), name), 'utf8');
}

// ============================================
// The application is all that is published
// ============================================

test('the release is an application, and holds nobody library', () => {
    const files = walk(release()).map(relative);

    assert.ok(files.includes('index.html'), 'it is a Spotifie');

    // No audio, ever. The music on somebody's device stays on it.
    const audio = files.filter((name) => /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i.test(name));
    assert.deepStrictEqual(audio, [], 'no audio is packaged');

    // Nothing belonging to an account or to a machine.
    const personal = files.filter((name) =>
        /(^|\/)\.spotifie(\/|$)|(^|\/)users(\/|$)|state\.json$|scan-state\.json$|playback\.json$|(^|\/)\.env$/i.test(name)
    );
    assert.deepStrictEqual(personal, [], 'no library state is packaged');

    // And nothing of the private half of the project.
    //
    // The dashboard and its script are not that half. Both ask the database
    // whether the account reading them is an administrator and send everybody
    // else away, and every write they attempt is refused again by the
    // row-level policies - so publishing them hands nobody anything. What must
    // never be here is what actually decides: the server modules that verify
    // administrators, and the sign-in page that belongs to a copy somebody
    // runs themselves.
    const allowed = ['admin-dashboard.html', 'js/admin.js'];
    const privateHalf = files.filter(
        (name) =>
            (/admin/i.test(name) && allowed.indexOf(name) === -1) ||
            /(^|\/)test(\/|$)/.test(name) ||
            /CLAUDE\.md$/.test(name)
    );
    assert.deepStrictEqual(privateHalf, [], 'no administrator tooling is packaged');
});

test('every address a visitor can reach resolves to a file', () => {
    const files = new Set(walk(release()).map(relative));

    // The pages, the application, and everything a browser installs it from.
    [
        'index.html',
        'about.html',
        'developer.html',
        'signin.html',
        'signup.html',
        'forgot-password.html',
        'reset-password.html',
        'manifest.webmanifest',
        'sw.js',
        'css/style.css',
        'js/script.js',
        'js/platform.js',
        'favicons/favicon.ico'
    ].forEach((name) => {
        assert.ok(files.has(name), name + ' is published');
    });

    // Every stylesheet, script and icon a page names is in the release, so no
    // address in it answers with nothing.
    const page = read('index.html');
    const referenced = Array.from(page.matchAll(/(?:href|src)="(?!https?:|data:|#)([^"?#]+)/g)).map((m) => m[1]);

    assert.ok(referenced.length > 5, 'the page does name its own files');
    referenced.forEach((name) => {
        // Named from the root or named from beside the page: the same file
        // either way, and either way it has to be in the release.
        const file = name.replace(/^\.\//, '').replace(/^\//, '');
        if (!file) return;

        assert.ok(files.has(file), 'index.html names ' + name + ', which is published');
    });
});

test('robots, the sitemap and the summary are answered by the application', () => {
    // They are not files: two of them say where the installation is published,
    // and only the running application knows whether anybody has said. The
    // module that answers them ships with the release.
    const files = new Set(walk(release()).map(relative));
    assert.ok(files.has('lib/siteMeta.js'), 'the module that answers them is published');

    const meta = read('lib/siteMeta.js');
    assert.match(meta, /function robotsTxt\(\)/);
    assert.match(meta, /function sitemapXml\(\)/);
    assert.match(meta, /function llmsTxt\(\)/);
});

// ============================================
// What a static host is told
// ============================================

test('a static host is told not to publish the half that is a server', () => {
    const ignored = read('.assetsignore');

    ['server.js', 'lib/', 'package.json', 'supabase-setup.sql', '/.env.example'].forEach((entry) => {
        assert.ok(ignored.indexOf(entry) !== -1, entry + ' is kept off a static host');
    });

    // The files are still in the release, because somebody running Spotifie
    // themselves needs every one of them.
    const files = new Set(walk(release()).map(relative));
    assert.ok(files.has('server.js'), 'the server is still in the release');
    assert.ok(files.has('supabase-setup.sql'), 'and so is the schema');
});

test('a static host is told what to send with each kind of file', () => {
    const headers = read('_headers');

    ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy'].forEach((header) => {
        assert.ok(headers.indexOf(header) !== -1, headers + ' carries ' + header);
    });

    assert.match(headers, /frame-ancestors 'none'/);
    assert.ok(!/script-src[^;\n]*\*/.test(headers), 'scripts do not come from anywhere');
    assert.ok(!/unsafe-eval/.test(headers), 'and nothing is evaluated');

    // Only what Spotifie actually needs: itself, the Supabase project, the CDN
    // the Supabase client is loaded from, and the helper on the machine the
    // page is being read on.
    const connect = /connect-src ([^;\n]+)/.exec(headers);
    assert.ok(connect, 'it says where the page may connect');
    assert.match(connect[1], /'self'/);
    assert.match(connect[1], /https:\/\/example\.supabase\.co/);
    assert.match(connect[1], /127\.0\.0\.1/, 'the helper on this machine');
    assert.ok(!/\*/.test(connect[1]), 'and nowhere else');

    // A page is checked every visit; the things that only change with a
    // release may be kept.
    assert.match(headers, /\/\*\.html\n\s*Cache-Control: public, max-age=0, must-revalidate/);
    assert.match(headers, /\/sw\.js\n\s*Cache-Control: no-cache/);
    assert.match(headers, /\/config\.json\n\s*Cache-Control: no-cache/);
    assert.match(headers, /\/img\/\*\n\s*Cache-Control: public, max-age=\d+/);
});

test('the settings a published copy carries are the two public ones', () => {
    const settings = JSON.parse(read('config.json'));

    // The project, the browser key, where it was published, and what it is.
    // Nothing else: every field here is read by a browser, so every field here
    // has to be something a browser may see.
    assert.deepStrictEqual(Object.keys(settings).sort(), [
        'configured',
        'deployment',
        'publicSiteUrl',
        'supabaseAnonKey',
        'supabaseUrl'
    ]);
    assert.strictEqual(settings.supabaseUrl, 'https://example.supabase.co');
    assert.strictEqual(settings.publicSiteUrl, 'https://spotifie.example');
    assert.strictEqual(settings.deployment, 'cloudflare');
    assert.strictEqual(settings.configured, true);

    // And the same values as a script, which is what the application reads:
    // already there when the page loads, so nothing has to fetch them or
    // decide what to do while they have not arrived.
    const script = read('js/config.js');
    assert.match(script, /window\.__SPOTIFIE_CONFIG__ = \{/);

    // Read as the browser reads it, rather than as text: the comment above it
    // names the kinds of secret that must never appear, and a search of the
    // whole file for those words would find the warning against them.
    const carried = JSON.parse(/window\.__SPOTIFIE_CONFIG__ = (\{[\s\S]*?\});/.exec(script)[1]);

    assert.strictEqual(carried.deployment, 'cloudflare');
    assert.strictEqual(carried.supabaseUrl, 'https://example.supabase.co');
    assert.strictEqual(carried.publicSiteUrl, 'https://spotifie.example');
    assert.ok(!/service.role/i.test(carried.supabaseAnonKey), 'and no secret in it');
    assert.ok(!new RegExp('^sb' + '_secret_').test(carried.supabaseAnonKey));

    // The anon key is meant for a browser. A secret key would hand every
    // reader of the page the whole database, so the build refuses to write one
    // and the check refuses to pass one.
    assert.ok(!/service.role/i.test(settings.supabaseAnonKey));
    assert.ok(!new RegExp('^sb' + '_secret_').test(settings.supabaseAnonKey));
});

test('a build handed a secret key refuses to produce a release', () => {
    assert.throws(
        () =>
            execFileSync(process.execPath, [path.join(ROOT, 'tools', 'buildPublic.js')], {
                cwd: ROOT,
                stdio: 'pipe',
                env: Object.assign({}, process.env, {
                    SPOTIFIE_RELEASE_OUT: DIST,
                    SUPABASE_URL: 'https://example.supabase.co',
                    // Assembled rather than written out: a file that carried a
                    // string shaped like a secret key would be flagged by the very
                    // check it exists to exercise.
                    SUPABASE_ANON_KEY: ['sb', 'secret', 'would-be-a-disaster'].join('_')
                })
            }),
        /looks like a secret key|Command failed/
    );

    // And the release is put back the way the rest of this file expects it.
    built = false;
    release();
});

// ============================================
// Nothing claims an address it does not have
// ============================================

test('no page names the machine it was built on', () => {
    walk(release())
        .map(relative)
        .filter((name) => /\.html$/.test(name))
        .forEach((name) => {
            const page = read(name);
            const canonical = /<link rel="canonical" href="([^"]+)"/.exec(page);
            if (canonical) {
                assert.ok(!/localhost|127\.0\.0\.1/.test(canonical[1]), name + ' claims a real address');
            }

            // Nor anywhere else in the head.
            const head = page.slice(0, page.indexOf('</head>'));
            assert.ok(!/https?:\/\/(localhost|127\.0\.0\.1)/.test(head), name + ' points nowhere local');
        });
});

test('the manifest a browser installs from is complete and honest', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));

    assert.strictEqual(manifest.start_url, '/');
    assert.strictEqual(manifest.scope, '/');
    assert.ok(manifest.name && manifest.short_name && manifest.description);
    assert.ok(manifest.icons.length >= 4);

    const files = new Set(walk(release()).map(relative));
    manifest.icons.forEach((icon) => {
        assert.ok(files.has(icon.src), icon.src + ' is published');
    });

    // Nothing promised that has not been built.
    ['share_target', 'file_handlers', 'protocol_handlers', 'related_applications'].forEach((field) => {
        assert.ok(!(field in manifest), 'the manifest does not claim ' + field);
    });
});

test('the worker keeps the application and nothing belonging to anybody', () => {
    const worker = read('sw.js');

    // Versioned, so an update replaces what came before rather than living
    // beside it forever.
    assert.match(worker, /const CACHE_VERSION = '[^']+'/);
    assert.match(worker, /\.filter\(\(name\) => name\.startsWith\('spotifie-shell-'\) && name !== SHELL_CACHE\)/);

    // What it keeps is the application: pages, styles, scripts, icons. No
    // audio, nothing signed, nothing from an account.
    const shell = worker.slice(worker.indexOf('const SHELL_ASSETS'), worker.indexOf('];', worker.indexOf('const SHELL_ASSETS')));
    assert.ok(!/\.mp3|\/api\/library\/tracks|\/api\/catalog\/tracks|token|signed/i.test(shell), 'nothing private is kept');
    assert.match(shell, /'\/manifest\.webmanifest'/);

    // The application is kept under the one address it has. Keeping the same
    // document twice, at "/" and at "/index.html", is two entries in the
    // cache, two in the history, and two chances for a page to be answered
    // from the older of them.
    assert.match(worker, /const APP_SHELL = '\/';/);
    assert.match(shell, /^\s*APP_SHELL,/m);
    assert.ok(!/'\/index\.html'/.test(shell), 'and not a second time under another name');
});

// ============================================
// The check that stands in front of a deployment
// ============================================

/**
 * What the check refuses, read from the check itself.
 *
 * Deliberately not by planting a bad file in the release: the release is one
 * directory shared by every test file in this suite, and a test that writes an
 * administrator page into it - however briefly - is a test that makes another
 * file fail for reasons that have nothing to do with what it is testing. The
 * rules are read where they are written instead, which is both stabler and
 * more direct.
 */
test('the check refuses every shape of private thing', () => {
    const checker = fs.readFileSync(path.join(ROOT, 'tools', 'releaseCheck.js'), 'utf8');

    // The half that decides anything, by file name: the modules a server would
    // check an administrator with, and the sign-in page that belongs to a copy
    // somebody runs themselves.
    ['admin-login', 'adminAuth', 'adminCatalogRoutes', 'adminAlbumRoutes'].forEach((name) => {
        assert.ok(checker.indexOf(name) !== -1, 'a release carrying ' + name + ' is refused');
    });

    // Anything belonging to a person or a machine.
    ['\\.env', '\\.spotifie', 'scan-state', 'playback', 'users', 'node_modules', 'CLAUDE'].forEach((name) => {
        assert.ok(new RegExp(name).test(checker), 'a release carrying ' + name + ' is refused');
    });

    // Secrets, by shape rather than by name.
    [['service', 'role'].join('_'), ['sb', 'secret_'].join('_'), 'PRIVATE KEY', 'jwt', 'postgres'].forEach((pattern) => {
        assert.ok(checker.indexOf(pattern) !== -1, 'a release carrying ' + pattern + ' is refused');
    });

    // Audio, and a map back to the source.
    assert.match(checker, /mp3\|m4a\|aac\|flac\|wav\|ogg\|opus/);
    assert.match(checker, /\\\.map\$/);

    // And the settings a published copy carries are checked rather than
    // trusted: two public values, and never a secret.
    assert.match(checker, /function checkRuntimeConfig\(failures\)/);
    assert.match(checker, /config\.json carries a secret key/);
    assert.match(checker, /function checkStaticHostFiles\(names, failures\)/);
    assert.match(checker, /names this machine as its address/);
});

test('a release built as it should be passes', () => {
    release();

    const output = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'releaseCheck.js')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { SPOTIFIE_RELEASE_OUT: DIST })
    });

    assert.match(output, /The release is clean/);
});
