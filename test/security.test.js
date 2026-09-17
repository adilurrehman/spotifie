'use strict';

/**
 * The rules that must hold however the application is built.
 *
 * Three separate claims are made here, and each is checked rather than
 * asserted in a comment:
 *
 * - authorization is decided on the server. Nothing a browser can write takes
 *   part in it, so editing the page's JavaScript changes what the page shows
 *   and nothing else;
 * - the public release contains the application and nothing else. No admin
 *   pages, no admin modules, no secrets, no music, no working data - and its
 *   server has no privileged route to expose;
 * - text that arrives from outside is rendered as text. A song called
 *   `<img onerror=...>` is a song with an odd name, not a script.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ============================================
// Authorization is decided on the server
// ============================================

/** A file's code, with its comments taken out - the comments discuss these. */
function codeOf(file) {
    return fs
        .readFileSync(path.join(ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('nothing the browser can write takes part in deciding who is an administrator', () => {
    const guard = codeOf('lib/adminAuth.js');

    // The id comes from the answer Supabase gave about the token, and from
    // nowhere else.
    assert.match(guard, /const user = await identifyToken\(token\);/);
    assert.match(guard, /app_admins\?select=user_id&user_id=eq\./);

    // None of the places a browser could put a claim are read.
    [/localStorage/, /sessionStorage/, /document\./, /body\.isAdmin/, /body\.userId/, /headers\['x-/i].forEach(
        (pattern) => {
            assert.ok(!pattern.test(guard), 'the guard never reads ' + pattern);
        }
    );

    // A caller cannot name themselves, in any of the server's own modules.
    ['lib/catalogRoutes.js', 'lib/libraryRoutes.js', 'lib/adminCatalogRoutes.js', 'lib/adminAlbumRoutes.js'].forEach(
        (file) => {
            const source = codeOf(file);
            assert.ok(
                !/query\.userId|body\.userId|body\.isAdmin|headers\['x-user/i.test(source),
                file + ' never takes an identity from the request'
            );
        }
    );
});

test('a browser claiming to be an administrator is claiming it to itself', () => {
    // The page asks whether the account is an administrator so it can show a
    // link. Nothing is authorized by that answer, and the endpoints do not
    // consult the page.
    const auth = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
    assert.match(auth, /isAdmin/);

    const guard = codeOf('lib/adminAuth.js');
    assert.ok(!/js\/auth|window|navigator/.test(guard), 'the server does not consult the page');

    // A session left in storage by an older version proves nothing and is
    // cleared away.
    assert.match(auth, /LEGACY_AUTH_KEYS/);
    assert.match(auth, /purgeLegacyAuthStorage/);
});

test('every write to the shared catalogue passes the guard first', () => {
    const admin = fs.readFileSync(path.join(ROOT, 'lib', 'adminCatalogRoutes.js'), 'utf8');
    const albums = fs.readFileSync(path.join(ROOT, 'lib', 'adminAlbumRoutes.js'), 'utf8');

    // Six catalogue writes: publish an album, publish a track, edit either,
    // delete either. Each one asks first.
    const guards = (admin.match(/await requireAdmin\(req\)/g) || []).length;
    assert.ok(guards >= 6, 'each catalogue write is guarded (' + guards + ')');

    // The album routes are guarded once, before the body is even read, for
    // every one of them.
    assert.match(albums, /const adminCheck = await requireAdmin\(req\);/);
    const readsBody = albums.indexOf("req.on('data'");
    const checks = albums.indexOf('await requireAdmin(req)');
    assert.ok(checks !== -1 && checks < readsBody, 'nothing is read from the body before the check');
});

test('a check that cannot be made refuses the request rather than allowing it', () => {
    const guard = fs.readFileSync(path.join(ROOT, 'lib', 'adminAuth.js'), 'utf8');

    // Supabase unreachable is 502/504, never ok.
    assert.match(guard, /status: e\.status \|\| 502/);
    assert.ok(!/return \{ ok: true \}/.test(guard), 'no path answers ok without a verified admin');

    // The two refusals are distinct: not signed in, and not allowed.
    assert.match(guard, /status: 401, error: 'Authentication required'/);
    assert.match(guard, /status: 403, error: 'Administrator access required'/);
});

// ============================================
// The database refuses the same things again
// ============================================

test('the database policies match what the server enforces', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase-setup.sql'), 'utf8');

    // Reading the published catalogue needs no account.
    assert.match(sql, /CREATE POLICY "Anyone can read catalog albums"[\s\S]*?FOR SELECT TO anon, authenticated/);
    assert.match(sql, /CREATE POLICY "Anyone can read catalog tracks"[\s\S]*?FOR SELECT TO anon, authenticated/);
    assert.match(sql, /CREATE POLICY "Anyone can read catalog media"[\s\S]*?FOR SELECT TO anon, authenticated/);

    // Writing it needs an administrator, on every table and on Storage.
    ['catalog albums', 'catalog tracks'].forEach((what) => {
        ['insert', 'update', 'delete'].forEach((verb) => {
            const policy = new RegExp(
                'CREATE POLICY "Admins can ' + verb + ' ' + what + '"[\\s\\S]*?public\\.is_admin\\(auth\\.uid\\(\\)\\)'
            );
            assert.match(sql, policy, verb + ' ' + what + ' is administrator only');
        });
    });
    ['upload', 'update', 'delete'].forEach((verb) => {
        const policy = new RegExp(
            'CREATE POLICY "Admins can ' + verb + ' catalog media"[\\s\\S]*?public\\.is_admin\\(auth\\.uid\\(\\)\\)'
        );
        assert.match(sql, policy, verb + ' of stored media is administrator only');
    });

    // Nobody can make themselves an administrator.
    assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON public\.app_admins FROM anon, authenticated;/);
    assert.match(sql, /GRANT SELECT ON public\.app_admins TO authenticated;/);
    assert.match(sql, /CREATE POLICY "Users can check own admin status"[\s\S]*?auth\.uid\(\) = user_id/);
    assert.ok(
        !/GRANT (INSERT|UPDATE|DELETE|ALL)[^\n]*ON public\.app_admins TO (anon|authenticated)/.test(sql),
        'app_admins is never made writable from a client'
    );

    // A profile belongs to its owner.
    assert.match(sql, /CREATE POLICY "Users can view own profile"[\s\S]*?auth\.uid\(\) = id/);
    assert.match(sql, /CREATE POLICY "Users can update own profile"[\s\S]*?auth\.uid\(\) = id/);

    // Every table this project owns has row level security turned on.
    ['profiles', 'app_admins', 'catalog_albums', 'catalog_tracks'].forEach((table) => {
        assert.match(sql, new RegExp('ALTER TABLE public\\.' + table + ' ENABLE ROW LEVEL SECURITY;'));
    });
});

// ============================================
// Nothing private is served, and nothing is traversable
// ============================================

/** The path resolver, on its own, with a stand-in for the filesystem. */
function loadResolver() {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    const start = source.indexOf('const BACKSLASH = String.fromCharCode(92);');
    const end = source.indexOf('function statFile(filePath)');
    assert.ok(start !== -1 && end > start, 'the resolver was found');

    // A path this platform would actually produce, so the containment check
    // compares like with like.
    const root = path.resolve(path.sep === '\\' ? 'C:/spotifie-test' : '/spotifie-test');

    const sandbox = {
        path: path,
        ROOT_DIR: root,
        MUSIC_ROOT: path.join(root, 'music'),
        decodeURIComponent: decodeURIComponent,
        String: String,
        Set: Set
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end), sandbox);

    sandbox.resolveStaticPath.root = root;
    return sandbox.resolveStaticPath;
}

test('the server serves what it lists, and nothing else', () => {
    const resolve = loadResolver();

    // The application.
    ['/', '/index.html', '/signin', '/about.html', '/css/style.css', '/js/script.js', '/img/music.svg', '/robots.txt']
        .forEach((request) => {
            assert.ok(resolve(request), request + ' is part of the application');
        });

    // Its own source, its modules, its tests, its data, its dependencies.
    [
        '/server.js',
        '/lib/adminAuth.js',
        '/lib/publicConfig.js',
        '/lib/sessionAuth.js',
        '/test/security.test.js',
        '/tools/buildPublic.js',
        '/package.json',
        '/package-lock.json',
        '/supabase-setup.sql',
        '/CLAUDE.md',
        '/README.md',
        '/node_modules/music-metadata/package.json',
        '/.env',
        '/.git/config',
        '/.spotifie/device/index.json'
    ].forEach((request) => {
        assert.strictEqual(resolve(request), null, request + ' is never served');
    });
});

test('traversal is refused in every spelling', () => {
    const resolve = loadResolver();

    [
        '/../.env',
        '/../../etc/passwd',
        '/css/../../.env',
        '/%2e%2e/.env',
        '/%2e%2e%2f%2e%2e%2fserver.js',
        '/..%5cserver.js',
        '/css/..%5c..%5c.env',
        '/js/%00../../server.js'
    ].forEach((request) => {
        assert.strictEqual(resolve(request), null, request + ' is refused');
    });

    // A backslash is a separator here too, so it cannot be used to slip past.
    assert.strictEqual(resolve('/..\\server.js'), null);
    assert.strictEqual(resolve('/css\\..\\..\\.env'), null);
});

test('a directory is never listed', () => {
    const resolve = loadResolver();

    // Naming a folder is not a request for its contents. A bare name at the
    // top level means the page of that name - /signin is signin.html - so
    // /css asks for css.html, which does not exist, and never for the folder.
    ['/css', '/js', '/img', '/favicons', '/songs', '/lib', '/test', '/tools', '/node_modules'].forEach((request) => {
        const resolved = resolve(request);
        const folder = path.join(resolve.root, request.slice(1));

        assert.notStrictEqual(resolved, folder, request + ' never resolves to the folder itself');
        if (resolved !== null) {
            assert.ok(resolved.endsWith('.html'), request + ' can only ever be a page: ' + resolved);
        }
    });

    // The bare root is the front page, not the directory.
    assert.strictEqual(resolve('/'), path.join(resolve.root, 'index.html'));

    // And a file inside one of those folders is refused outright.
    ['/lib/adminAuth.js', '/test/security.test.js', '/tools/buildPublic.js', '/node_modules/x/index.js'].forEach(
        (request) => {
            assert.strictEqual(resolve(request), null, request + ' is refused');
        }
    );
});

test('the music root is reachable only through the library API', () => {
    const resolve = loadResolver();

    // Nothing under the music root is served as a file, at any depth.
    assert.strictEqual(resolve('/music/song.mp3'), null);
    assert.strictEqual(resolve('/music/Artist/Album/song.mp3'), null);

    // And the folder itself is not reachable either: the bare name means the
    // page of that name, which is not the folder.
    assert.notStrictEqual(resolve('/music'), path.join(resolve.root, 'music'));
});

// ============================================
// Every answer carries the same protections
// ============================================

test('the pages say what they may load, and refuse to be framed', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    assert.match(source, /'Content-Security-Policy': CSP/);
    assert.match(source, /"frame-ancestors 'none'"/);
    assert.match(source, /"object-src 'none'"/);
    assert.match(source, /"base-uri 'self'"/);
    assert.match(source, /'X-Frame-Options': 'DENY'/);
    assert.match(source, /'X-Content-Type-Options': 'nosniff'/);
    assert.match(source, /'Referrer-Policy': 'strict-origin-when-cross-origin'/);
    assert.match(source, /'Permissions-Policy'/);

    // Not HSTS: this server is reached over plain HTTP on loopback, and
    // telling a browser to demand HTTPS there locks the person out.
    assert.ok(!/Strict-Transport-Security/i.test(source), 'no HSTS on a loopback server');
});

test('the server listens on this machine only, unless told otherwise', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(source, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1';/);
});

// ============================================
// Imported files are checked before they are kept
// ============================================

test('an import is limited, named safely and confined to its own folder', () => {
    const media = fs.readFileSync(path.join(ROOT, 'lib', 'userMedia.js'), 'utf8');

    assert.match(media, /const MAX_FILE_BYTES = /);
    assert.match(media, /const MAX_TOTAL_BYTES = /);
    assert.match(media, /if \(!AUDIO_EXTENSIONS\.has\(extension\)\)/, 'only known audio extensions are accepted');
    assert.match(media, /written > limitBytes/, 'the size is enforced while it is being written');

    // Real paths are compared, so a symlink cannot point out of the folder.
    const safe = fs.readFileSync(path.join(ROOT, 'lib', 'safeFs.js'), 'utf8');
    assert.match(safe, /realpathSync/);
    assert.match(safe, /if \(!isInside\(realRoot, realTarget\)\) return null;/);
    assert.match(safe, /if \(part === '\.\.'\) return null;/);
});

// ============================================
// Text from outside stays text
// ============================================

/** The escaper, taken from the player and run on its own. */
function loadEscaper(file, name) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start !== -1, name + ' was found in ' + file);

    const end = source.indexOf('\n}', start) + 2;
    const sandbox = { String: String };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end), sandbox);
    return sandbox[name];
}

test('a malicious title is written as a title, not as markup', () => {
    const escape = loadEscaper('js/script.js', 'escapeHTML');

    const attacks = [
        '<img src=x onerror=alert(1)>',
        '</div><script>alert(1)</script>',
        '" onerror="alert(1)',
        "' onload='alert(1)",
        '<svg/onload=alert(1)>'
    ];

    attacks.forEach((attack) => {
        const escaped = escape(attack);
        assert.ok(!/[<>]/.test(escaped), 'no tag survives: ' + attack);
        assert.ok(escaped.indexOf('"') === -1, 'no quote survives an attribute: ' + attack);
        assert.ok(escaped.indexOf("'") === -1, 'nor an apostrophe: ' + attack);
    });

    // The quotes matter as much as the brackets: almost every use of this is
    // inside an attribute.
    assert.strictEqual(escape('a "b" c'), 'a &quot;b&quot; c');
    assert.strictEqual(escape("it's"), 'it&#39;s');
    assert.strictEqual(escape('a & b'), 'a &amp; b');
    assert.strictEqual(escape('<b>'), '&lt;b&gt;');

    // And it does not double-escape its own output into nonsense.
    assert.strictEqual(escape('&amp;'), '&amp;amp;');
});

test('the dashboard escapes what it shows the same way', () => {
    const escape = loadEscaper('js/admin.js', 'escapeHtml');

    assert.strictEqual(escape('" onerror="alert(1)'), '&quot; onerror=&quot;alert(1)');
    assert.strictEqual(escape('<script>'), '&lt;script&gt;');
});

test('a name is set as text, never built into markup', () => {
    const auth = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');

    // A person chooses their own display name. It is written with textContent
    // and the decoration is built as an element beside it.
    assert.match(auth, /function writeLibraryTitle\(element, name\)/);
    assert.match(auth, /element\.textContent = String\(/);
    assert.match(auth, /document\.createElement\('span'\)/);

    // And never concatenated into innerHTML.
    assert.ok(!/innerHTML = displayName/.test(auth), 'a display name is never written as markup');
    assert.ok(!/innerHTML = profile\.username/.test(auth), 'nor is a profile name');
});

test('the dashboard carries no value inside a handler attribute', () => {
    const admin = fs.readFileSync(path.join(ROOT, 'js', 'admin.js'), 'utf8');

    // A title inside onclick="..." is a JavaScript string inside an HTML
    // attribute: a quote in the title ends the string and the rest is code.
    // Values travel in data- attributes and are read back as text.
    assert.ok(!/onclick="[^"]*\$\{/.test(admin), 'no generated markup puts a value into onclick');
    assert.match(admin, /function initRowActions\(\)/);
    assert.match(admin, /button\.dataset\.name/);
});

test('a cover address that is not an address for a picture is refused', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

    const start = source.indexOf('function usableArtworkUrl(value)');
    const end = source.indexOf('/** Kept for the few places that hold a plain asset reference. */');
    assert.ok(start !== -1 && end > start);

    const sandbox = { basePath: '', looksLikeFilePath: () => false };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end), sandbox);

    const usable = sandbox.usableArtworkUrl;

    // A scheme that runs code instead of fetching bytes.
    assert.strictEqual(usable('javascript:alert(1)'), null);
    assert.strictEqual(usable('JavaScript:alert(1)'), null);
    assert.strictEqual(usable('vbscript:msgbox(1)'), null);
    assert.strictEqual(usable('data:text/html,<script>alert(1)</script>'), null);
    assert.strictEqual(usable('blob:http://localhost/1'), null);

    // What a picture actually arrives as.
    assert.strictEqual(usable('/api/library/artwork/abc'), '/api/library/artwork/abc');
    assert.strictEqual(usable('https://example.test/cover.jpg'), 'https://example.test/cover.jpg');
});

// ============================================
// The public release
// ============================================

// Left to its defaults, the build writes over the working tree's own
// public-release/dist and rewrites worker/generated/adminDocument.mjs - the
// dashboard document a production deploy ships. A test has no business with
// either, so the release is built into a throwaway directory. That is set
// before the builder is loaded, because it reads the location once, and a
// build aimed elsewhere leaves the worker's document alone.
const os = require('os');
const crypto = require('crypto');

process.env.SPOTIFIE_RELEASE_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-security-release-'));

/** The deployable artifacts in the working tree that no test may touch. */
const DEPLOYABLE = [path.join(ROOT, 'worker', 'generated', 'adminDocument.mjs'), path.join(ROOT, 'public-release', 'dist')];

/** Exact bytes, as a hash: of a file, or of every path and file in a directory. */
function fingerprint(target) {
    if (!fs.existsSync(target)) return 'absent';
    const hash = crypto.createHash('sha256');
    if (fs.statSync(target).isFile()) return hash.update(fs.readFileSync(target)).digest('hex');
    const visit = (directory) => {
        fs.readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .forEach((entry) => {
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) visit(full);
                else hash.update(path.relative(target, full) + '\0').update(fs.readFileSync(full));
            });
    };
    visit(target);
    return hash.digest('hex');
}

const deployableBefore = DEPLOYABLE.map(fingerprint);

const { build, OUT } = require('../tools/buildPublic.js');

// Built once. Rebuilding while a released server is running would try to
// delete the directory out from under it.
build();

test('building the release for these tests leaves the deployable working tree alone', () => {
    assert.notStrictEqual(path.resolve(OUT), path.join(ROOT, 'public-release', 'dist'), 'built into a throwaway directory');
    assert.deepStrictEqual(
        DEPLOYABLE.map(fingerprint),
        deployableBefore,
        'worker/generated/adminDocument.mjs and public-release/dist are byte-for-byte unchanged'
    );
});

function releaseFiles() {
    const files = [];
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            // Whatever a released server wrote while this file was running it.
            // It is this test's leavings rather than part of the release, and
            // the assertions below are about what the build produced.
            if (entry.name === '.spotifie') continue;
            if (entry.isDirectory()) walk(full);
            else files.push(path.relative(OUT, full).split(path.sep).join('/'));
        }
    };
    walk(OUT);
    return files;
}

test('the release is the application, and nothing that runs it as an administrator', () => {
    const files = releaseFiles();

    // What decides whether an account is an administrator, and what it may do
    // with that: none of it is here, so the released server has no privileged
    // route to reach at all. The dashboard document is not here either - it is
    // not a static file at all, but something the Cloudflare worker holds and
    // serves only to a proven administrator; a copy of it among the assets
    // would be a way around that gate.
    [
        'admin-dashboard.html',
        'admin-login.html',
        'lib/adminAuth.js',
        'lib/adminCatalogRoutes.js',
        'lib/adminAlbumRoutes.js',
        'CLAUDE.md'
    ].forEach((file) => {
        assert.ok(files.indexOf(file) === -1, file + ' is not in the release');
    });

    // The dashboard's script is here, and grants nothing by being here: the
    // gated page loads it, and it asks the database whether the account reading
    // it is an administrator and sends everybody else away. The row-level
    // policies refuse every write it attempts on behalf of an account the
    // database does not trust.
    assert.ok(files.indexOf('js/admin.js') !== -1, 'js/admin.js is in the release');

    // Nothing from the working copy's own life, either.
    files.forEach((file) => {
        assert.ok(!/^test\//.test(file), 'no tests: ' + file);
        assert.ok(!/^tools\//.test(file), 'no build tooling: ' + file);
        assert.ok(!/^\.spotifie\//.test(file), 'no working data: ' + file);
        assert.ok(!/^node_modules\//.test(file), 'no dependencies: ' + file);
        assert.ok(!/\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(file), 'no music: ' + file);
        assert.ok(file !== '.env', 'no environment file');
    });

    // And it is a whole application.
    ['index.html', 'signin.html', 'server.js', 'js/script.js', 'css/style.css', 'README.md', 'SECURITY.md'].forEach(
        (file) => {
            assert.ok(files.indexOf(file) !== -1, 'the release includes ' + file);
        }
    );
});

test('nothing in the release names a dashboard or carries a secret', () => {
    for (const file of releaseFiles()) {
        if (!/\.(html|js|css|json|md|sql|txt)$/i.test(file)) continue;
        if (/^(SECURITY\.md|\.env\.example)$/.test(file)) continue;

        const text = fs.readFileSync(path.join(OUT, file), 'utf8');

        assert.ok(!/admin-login\.html/i.test(text), file + ' names the admin sign-in page');
        assert.ok(!/service_role/.test(text), file + ' names a service-role key');
        assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), file + ' carries a private key');
        assert.ok(!/sb_secret_/.test(text), file + ' carries a secret key');
    }

    // The release arrives pointed at nobody's project in particular.
    const config = fs.readFileSync(path.join(OUT, 'lib', 'publicConfig.js'), 'utf8');
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(config), 'no key is shipped');
    assert.ok(!/https:\/\/[a-z0-9]{16,}\.supabase\.co/.test(config), 'no project is named');

    // The page carries the link to the dashboard, hidden until the database
    // says the account reading it is an administrator. Leaving it out was why
    // an administrator signing in to a published copy had no way to reach a
    // dashboard that was there all along.
    const index = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
    assert.match(index, /id="dashboardLink"/);
    assert.match(index, /style="display: none;"/);
});

// ============================================
// The release, running
// ============================================

/** Start the built release on a free port and wait for it to answer. */
function startRelease() {
    const port = 3400 + Math.floor(Math.random() * 400);

    const child = spawn(process.execPath, ['server.js'], {
        cwd: OUT,
        env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
        stdio: 'ignore'
    });
    child.unref();

    const ready = new Promise((resolve, reject) => {
        let attempts = 0;
        const poll = () => {
            attempts += 1;
            const req = http.get({ host: '127.0.0.1', port: port, path: '/health' }, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', () => {
                if (attempts > 60) reject(new Error('the release did not start'));
                else setTimeout(poll, 100);
            });
        };
        setTimeout(poll, 150);
    });

    return ready.then(() => ({ port: port, child: child }));
}

/**
 * One released server for the whole file, started on first use and stopped
 * when the run ends.
 */
let releaseServerPromise = null;

function releaseServer() {
    if (!releaseServerPromise) releaseServerPromise = startRelease();
    return releaseServerPromise;
}

// The run does not end while a child is still listening, so it is stopped
// once, after the last test that used it.
after(async () => {
    if (releaseServerPromise) {
        const started = await releaseServerPromise;
        // Waited for, not just signalled: Windows will not remove a directory
        // a running process is still using as its working directory.
        await new Promise((resolve) => {
            if (started.child.exitCode !== null || started.child.signalCode !== null) return resolve();
            const timer = setTimeout(resolve, 5000);
            started.child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            started.child.kill();
        });
    }

    // And the throwaway release goes with it, including the .spotifie a
    // released server writes beside itself while it runs. It is in the
    // system's temporary directory, so one the system will not let go of yet
    // is left for it to clear rather than failing the run.
    try {
        fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (e) {
        console.warn('Could not remove the throwaway release at ' + OUT + ': ' + e.code);
    }
});

function ask(port, pathname, method) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: port, path: pathname, method: method || 'GET' },
            (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

test('the released server has no administrator route to reach', async () => {
    const started = await releaseServer();

    // The pages a listener uses.
    for (const page of ['/', '/index.html', '/signin.html', '/about.html']) {
        assert.strictEqual(await ask(started.port, page), 200, page + ' is there');
    }

    // The administrator sign-in page belongs to a copy somebody runs
    // themselves and is nowhere in a release, under any spelling. The dashboard
    // document is not a static file at all - the Cloudflare worker holds it, so
    // the plain asset server that ships in the release has nothing to answer
    // for it, which is the point: no address opens the dashboard by its file.
    for (const page of ['/admin-login.html', '/admin-login', '/admin-dashboard.html', '/admin-dashboard']) {
        assert.strictEqual(await ask(started.port, page), 404, page + ' is not there');
    }

    // Every write to the shared catalogue, and the rescan.
    const writes = [
        ['POST', '/api/create-album'],
        ['POST', '/api/update-album'],
        ['POST', '/api/add-song'],
        ['POST', '/api/delete-album'],
        ['POST', '/api/delete-song'],
        ['POST', '/api/catalog/admin/albums'],
        ['POST', '/api/catalog/admin/tracks'],
        ['PATCH', '/api/catalog/albums/global-album:x'],
        ['DELETE', '/api/catalog/albums/global-album:x'],
        ['DELETE', '/api/catalog/tracks/global:x'],
        ['POST', '/api/library/rescan']
    ];

    for (const [method, route] of writes) {
        assert.strictEqual(await ask(started.port, route, method), 404, method + ' ' + route + ' does not exist');
    }
});

test('the released server keeps its own files and this machine to itself', async () => {
    const started = await releaseServer();

    for (const request of [
        '/.env',
        '/.env.example',
        '/.git/config',
        '/.gitignore',
        '/.spotifie/device/index.json',
        '/server.js',
        '/package.json',
        '/supabase-setup.sql',
        '/lib/sessionAuth.js',
        '/lib/catalogRoutes.js',
        '/README.md',
        '/SECURITY.md',
        '/..%2f.env',
        '/%2e%2e%2fserver.js',
        '/css/..%5c..%5cserver.js',
        '/css',
        '/js',
        '/lib'
    ]) {
        assert.strictEqual(await ask(started.port, request), 404, request + ' is refused');
    }

    // What a listener may still read.
    for (const request of ['/js/script.js', '/css/style.css', '/img/music.svg', '/robots.txt']) {
        assert.strictEqual(await ask(started.port, request), 200, request + ' is served');
    }
});

// ============================================
// The cache carries nothing private
// ============================================

test('the copy this device keeps holds no token, no signature and nobody s state', () => {
    const cache = fs.readFileSync(path.join(ROOT, 'js', 'catalogCache.js'), 'utf8');

    // Only a plain address from this origin is ever written down.
    assert.match(cache, /if \(url\.indexOf\('\?'\) !== -1 \|\| url\.indexOf\('#'\) !== -1\) return null;/);
    assert.match(cache, /if \(url\.charAt\(0\) !== '\/' \|\| url\.charAt\(1\) === '\/'\) return null;/);

    // Only published items, and only the fields named.
    assert.match(cache, /album\.source !== 'global'/);
    assert.match(cache, /track\.source !== 'global'/);
    ['hasLocalEdits', 'localEdits', 'published', 'addedToAlbum', 'personal'].forEach((field) => {
        assert.ok(cache.indexOf("'" + field + "'") === -1, field + ' is never a kept field');
    });

    // Nothing about a session goes near it.
    assert.ok(!/access_token|Authorization|bearer/i.test(cache), 'no token is stored');
});
