'use strict';

/**
 * Release-candidate guards.
 *
 * The things that would make a release embarrassing or unsafe rather than
 * merely buggy: a deploy built from placeholder settings, a hosted copy with
 * no robots.txt or canonical, a service worker that caches the admin route, a
 * web-only copy asking a static host for a Node API, and a version nobody can
 * trace. Behaviour is exercised wherever it can be; source is read only where
 * running the code would need a whole browser.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'tools', 'buildPublic.js');
const CHECK = path.join(ROOT, 'tools', 'releaseCheck.js');
const { placeholderProblems } = require('../tools/buildPublic.js');

// Shaped like real public values, pointed at nothing.
const REAL = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_releasecandidatetestvalue0123',
    PUBLIC_SITE_URL: 'https://spotifie-rc-test.pages.dev'
};

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function run(script, args, env) {
    const result = spawnSync(process.execPath, [script].concat(args || []), {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { WORKERS_CI: '' }, env)
    });
    return { status: result.status, output: String(result.stdout || '') + String(result.stderr || '') };
}

function tempDir(name) {
    const dir = path.join(os.tmpdir(), name);
    fs.rmSync(dir, { recursive: true, force: true });
    return dir;
}

// ============================================
// Settings that were never filled in
// ============================================

test('real-looking public settings pass the placeholder check', () => {
    assert.deepStrictEqual(placeholderProblems(REAL), []);
});

test('placeholder and example values are named, whichever setting holds them', () => {
    const cases = [
        ['SUPABASE_URL', 'https://PASTE_PROJECT_URL.supabase.co'],
        ['SUPABASE_URL', 'https://your-project-ref.supabase.co'],
        ['SUPABASE_URL', 'https://example.supabase.co'],
        ['SUPABASE_URL', 'http://abcdefghijklmnopqrst.supabase.co'],
        ['SUPABASE_URL', 'not a url'],
        ['SUPABASE_ANON_KEY', 'YOUR_PUBLISHABLE_KEY_GOES_HERE'],
        ['SUPABASE_ANON_KEY', 'PLACEHOLDER-publishable-key-value'],
        ['SUPABASE_ANON_KEY', 'changeme-changeme-changeme'],
        ['SUPABASE_ANON_KEY', 'too-short'],
        ['PUBLIC_SITE_URL', 'https://example.com'],
        ['PUBLIC_SITE_URL', 'https://spotifie.example'],
        ['PUBLIC_SITE_URL', 'https://localhost:3000'],
        ['PUBLIC_SITE_URL', 'http://spotifie-rc-test.pages.dev']
    ];

    cases.forEach(([name, value]) => {
        const settings = Object.assign({}, REAL, { [name]: value });
        assert.deepStrictEqual(placeholderProblems(settings), [name], name + ' = ' + JSON.stringify(value) + ' is caught');
    });
});

test('a production build without its settings stops before writing anything, naming them', () => {
    const out = tempDir('spotifie-rc-missing');
    const doc = path.join(ROOT, 'worker', 'generated', 'adminDocument.mjs');

    const result = run(BUILD, ['--production'], {
        SPOTIFIE_RELEASE_OUT: out,
        SUPABASE_URL: '',
        SUPABASE_ANON_KEY: '',
        PUBLIC_SITE_URL: ''
    });

    assert.notStrictEqual(result.status, 0, 'the build refused');
    ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUBLIC_SITE_URL'].forEach((name) => {
        assert.ok(result.output.indexOf(name) !== -1, 'it names ' + name);
    });

    // Nothing reached the worker: the refusal comes before any document is
    // written, so a null one never replaces a real one. (Compared by content
    // rather than byte for byte: other test files rebuild this module
    // concurrently from the same private source.)
    if (fs.existsSync(doc)) {
        assert.ok(!/export default null/.test(fs.readFileSync(doc, 'utf8')), 'no null document was written');
    }

    fs.rmSync(out, { recursive: true, force: true });
});

test('a production build with placeholder settings refuses and never repeats a value', () => {
    const out = tempDir('spotifie-rc-placeholder');
    const values = {
        SUPABASE_URL: 'https://PASTE_URL_HERE.supabase.co',
        SUPABASE_ANON_KEY: 'YOUR_PUBLISHABLE_KEY_GOES_HERE',
        PUBLIC_SITE_URL: 'https://example.com'
    };

    const result = run(BUILD, ['--production'], Object.assign({ SPOTIFIE_RELEASE_OUT: out }, values));

    assert.notStrictEqual(result.status, 0, 'the build refused');
    Object.keys(values).forEach((name) => {
        assert.ok(result.output.indexOf(name) !== -1, 'it names ' + name);
        assert.ok(result.output.indexOf(values[name]) === -1, 'and never prints the value of ' + name);
    });

    fs.rmSync(out, { recursive: true, force: true });
});

test("Cloudflare's builder refuses placeholder settings for the public build too", () => {
    const out = tempDir('spotifie-rc-ci-placeholder');
    const result = run(BUILD, [], {
        SPOTIFIE_RELEASE_OUT: out,
        WORKERS_CI: '1',
        SUPABASE_URL: REAL.SUPABASE_URL,
        SUPABASE_ANON_KEY: 'PASTE_YOUR_KEY_HERE_PLEASE',
        PUBLIC_SITE_URL: REAL.PUBLIC_SITE_URL
    });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /SUPABASE_ANON_KEY/);
    assert.ok(result.output.indexOf('PASTE_YOUR_KEY_HERE_PLEASE') === -1);

    fs.rmSync(out, { recursive: true, force: true });
});

// ============================================
// What a hosted copy tells a crawler
// ============================================

test('a public build that knows its address carries robots, sitemap, llms and canonical URLs', () => {
    const out = tempDir('spotifie-rc-discovery');
    const built = run(BUILD, [], Object.assign({ SPOTIFIE_RELEASE_OUT: out }, REAL));
    assert.strictEqual(built.status, 0, built.output);

    const robots = fs.readFileSync(path.join(out, 'robots.txt'), 'utf8');
    assert.match(robots, /^User-agent: \*$/m);
    assert.match(robots, /^Disallow: \/api\/$/m);
    assert.match(robots, /^Sitemap: https:\/\/spotifie-rc-test\.pages\.dev\/sitemap\.xml$/m);

    const sitemap = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
    assert.match(sitemap, /<loc>https:\/\/spotifie-rc-test\.pages\.dev\/<\/loc>/);
    assert.ok(fs.existsSync(path.join(out, 'llms.txt')), 'llms.txt is written');

    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(index, /<link rel="canonical" href="https:\/\/spotifie-rc-test\.pages\.dev\/">/);
    assert.match(index, /<meta property="og:image" content="https:\/\/spotifie-rc-test\.pages\.dev\/favicons\/favicon-512x512\.png">/);
    assert.ok(index.indexOf('<!--site-meta-->') === -1, 'the marker is filled in');

    const record = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(index);
    assert.ok(record, 'the structured record is there');
    assert.strictEqual(JSON.parse(record[1])['@type'], 'WebApplication');

    const about = fs.readFileSync(path.join(out, 'about.html'), 'utf8');
    assert.match(about, /<link rel="canonical" href="https:\/\/spotifie-rc-test\.pages\.dev\/about\.html">/);

    // And the release check still passes with the new files in it.
    const checked = run(CHECK, [], { SPOTIFIE_RELEASE_OUT: out });
    assert.strictEqual(checked.status, 0, checked.output);

    fs.rmSync(out, { recursive: true, force: true });
});

test('a public build that does not know its address claims none', () => {
    const out = tempDir('spotifie-rc-no-address');
    const built = run(BUILD, [], { SPOTIFIE_RELEASE_OUT: out, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', PUBLIC_SITE_URL: '' });
    assert.strictEqual(built.status, 0, built.output);

    assert.ok(!fs.existsSync(path.join(out, 'sitemap.xml')), 'no sitemap of an unknown address');
    assert.ok(!/Sitemap:/.test(fs.readFileSync(path.join(out, 'robots.txt'), 'utf8')), 'and robots names none');

    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(!/rel="canonical"/.test(index), 'no canonical');
    assert.ok(!/127\.0\.0\.1|localhost/.test(index.slice(0, index.indexOf('</head>'))), 'and no address of this machine');

    fs.rmSync(out, { recursive: true, force: true });
});

// ============================================
// The service worker leaves privileged routes alone
// ============================================

test('the service worker always sends admin and API requests to the network', () => {
    const sw = source('sw.js');
    const body = /function isAlwaysLive\(url\) \{[\s\S]*?\n\}/.exec(sw);
    assert.ok(body, 'the bypass rule exists');

    // eslint-disable-next-line no-new-func
    const isAlwaysLive = new Function(body[0] + '\nreturn isAlwaysLive;')();
    const live = (pathname) => isAlwaysLive(new URL('https://spotifie.test' + pathname));

    ['/api/admin/enter', '/admin-dashboard', '/admin-dashboard.html', '/api/catalog/albums', '/api/config'].forEach(
        (pathname) => assert.strictEqual(live(pathname), true, pathname + ' is never answered from a cache')
    );
    ['/', '/index.html', '/js/auth.js', '/css/style.css'].forEach((pathname) =>
        assert.strictEqual(live(pathname), false, pathname + ' may be served by the shell')
    );
});

// ============================================
// A web-only copy does not ask for a Node API
// ============================================

test('custom covers and backups say plainly they need the local runtime', () => {
    const script = source('js', 'script.js');

    const cover = script.slice(script.indexOf('async function saveLocalAlbumArtwork'), script.indexOf("fetch('/api/library/artwork'"));
    assert.match(cover, /if \(isPublishedCopy\(\)\) \{\s*throw new Error\(/, 'the cover upload stops before the request');

    ['requestLibraryBackup', 'restoreLibraryBackup'].forEach((name) => {
        const start = script.indexOf('async function ' + name);
        const body = script.slice(start, script.indexOf("_request('/api/catalog/backup", start));
        assert.match(body, /const unavailable = backupUnavailableHere\(\);\s*if \(unavailable\) throw unavailable;/, name + ' stops first');
    });
});

// ============================================
// A production console that says little
// ============================================

test('admin diagnostics are opt-in and nothing logs a session secret', () => {
    const auth = source('js', 'auth.js');
    assert.ok(!/console\.info\('\[admin/.test(auth), 'every [admin] line goes through the debug switch');
    assert.match(auth, /getItem\('spotifie_debug'\) === '1'/);

    const script = source('js', 'script.js');
    assert.ok(!/Starting The JS/.test(script), 'the start-up line is gone');

    // Nothing anywhere prints a token, a cookie or a key.
    ['auth.js', 'script.js', 'catalogClient.js', 'platform.js', 'browserLibrary.js'].forEach((file) => {
        const text = source('js', file);
        assert.ok(
            !/console\.(log|info|warn|error)\([^;]*\b(access_token|refresh_token|document\.cookie|anonKey|supabaseAnonKey)\b/.test(text),
            file + ' logs no secret'
        );
    });
});

// ============================================
// The local runtime loads without console errors
// ============================================

test('a checkout answers js/config.js with a script that sets nothing, not a 404', async () => {
    const net = require('net');
    const http = require('http');
    const { spawn } = require('child_process');

    const port = await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const chosen = probe.address().port;
            probe.close(() => resolve(chosen));
        });
    });

    const music = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-rc-music-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', MUSIC_ROOT: music }),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        let output = '';
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('server did not start: ' + output)), 15000);
            const seen = (chunk) => {
                output += chunk.toString();
                if (output.includes('Spotifie is running')) {
                    clearTimeout(timer);
                    resolve();
                }
            };
            child.stdout.on('data', seen);
            child.stderr.on('data', seen);
            child.on('exit', () => reject(new Error('server exited: ' + output)));
        });

        const response = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: port, path: '/js/config.js' }, (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: body }));
            }).on('error', reject);
        });

        assert.strictEqual(response.status, 200, 'answered, not 404');
        assert.match(response.type, /^text\/javascript/, 'as a script the browser will run');
        assert.ok(!/__SPOTIFIE_CONFIG__/.test(response.body), 'setting nothing, so the page knows it is a local run');
    } finally {
        child.kill();
        fs.rmSync(music, { recursive: true, force: true });
    }
});

// ============================================
// Version, notes and installability
// ============================================

test('the release is versioned, and the changelog says what is in it', () => {
    const pkg = JSON.parse(source('package.json'));
    const lock = JSON.parse(source('package-lock.json'));

    // A release (1.0.0) or a candidate for one (1.0.0-rc.1). Nothing else:
    // every other version source is derived from this one, and the Android
    // versionCode can only be counted from a version of this shape.
    assert.match(pkg.version, /^\d+\.\d+\.\d+(-rc\.\d+)?$/, 'a release or a release candidate');
    assert.strictEqual(lock.version, pkg.version, 'the lockfile agrees');
    assert.strictEqual(lock.packages[''].version, pkg.version);

    const changelog = source('CHANGELOG.md');
    assert.ok(changelog.indexOf('## [' + pkg.version + ']') !== -1, 'the changelog has this version');
    assert.ok(!/affiliated with Spotify|official Spotify/i.test(changelog.replace(/not affiliated/gi, '')), 'no claim of affiliation');
});

test('the manifest is ready for installation', () => {
    const manifest = JSON.parse(source('manifest.webmanifest'));

    assert.strictEqual(manifest.short_name, 'Spotifie');
    assert.match(manifest.name, /Hybrid Local & Global Music Player/);
    assert.strictEqual(manifest.start_url, '/');
    assert.strictEqual(manifest.scope, '/');
    assert.strictEqual(manifest.display, 'standalone');
    assert.ok(manifest.theme_color && manifest.background_color);

    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'), 'a 512px icon');
    manifest.icons.forEach((icon) => {
        assert.ok(fs.existsSync(path.join(ROOT, icon.src)), icon.src + ' exists');
    });
});

test('the public README describes the product without private operations', () => {
    [source('README.md'), source('public-release', 'README.public.md')].forEach((readme) => {
        assert.match(readme, /Hybrid Local & Global Music Player/);
        // Matched across line wrapping and blockquote markers.
        assert.match(readme, /not affiliated with, endorsed by or\s+(>\s*)?connected to Spotify/);

        // Names, never values; and none of the private deployment procedure.
        assert.ok(!/sb_publishable_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{20,}|service_role/.test(readme), 'no key');
        assert.ok(!/build:production|deploy:production|admin-login\.html|DEPLOYMENT\.private/.test(readme), 'no private procedure');
    });
});
