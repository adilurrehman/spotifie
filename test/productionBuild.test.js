'use strict';

/**
 * The two build modes, and the wall between them.
 *
 * The public build is the sanitized release that goes to the public GitHub
 * repository and to Cloudflare's GitHub-triggered build. It carries no
 * administrator dashboard, and a checkout without the private admin source
 * builds one with none - which is why the deployed GitHub build served no
 * dashboard and sent every administrator back to the application.
 *
 * The production build is the Worker deployed by hand from this private tree.
 * It requires the private admin source, refuses to build without it, embeds
 * the dashboard document into the Worker with its script inlined, and never
 * publishes the raw page or the script as a static file. These hold that line:
 * a production build that lost the dashboard, or that leaked the admin script
 * as an asset, is a build that fails here rather than one that deploys broken.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// The static assets both modes write. Pointed at a throwaway directory before
// the builder is loaded, so nothing here touches the real release directory.
const DIST = path.join(os.tmpdir(), 'spotifie-production-build-test');
// The Worker's dashboard module. Pointed at a throwaway file so a production
// build in a test never rewrites the working tree's own generated document.
const DOC = path.join(os.tmpdir(), 'spotifie-production-build-doc.mjs');

process.env.SPOTIFIE_RELEASE_OUT = DIST;

// A production build refuses to run without real public settings, so these
// tests hand it some. Shaped like the real thing, pointed at nothing.
process.env.SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.SUPABASE_ANON_KEY = 'sb_publishable_releasecandidatetestvalue0123';
process.env.PUBLIC_SITE_URL = 'https://spotifie-rc-test.pages.dev';

const test = require('node:test');
const assert = require('node:assert');

const builder = require('../tools/buildPublic.js');
const checker = require('../tools/releaseCheck.js');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function walk(directory) {
    const found = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.name === '.spotifie') continue;
            if (entry.isDirectory()) visit(full);
            else found.push(path.relative(DIST, full).split(path.sep).join('/'));
        }
    };
    visit(directory);
    return found;
}

function tempDoc(name, contents) {
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, contents);
    return file;
}

test.after(() => {
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.rmSync(DOC, { force: true });
});

// ============================================
// The private source is required in production
// ============================================

test('a production build refuses to run without the private admin source', () => {
    assert.throws(
        () => builder.requireProductionSource(false, 'production'),
        /^Error: Private admin source is required for production deployment\.$/,
        'the message is exact'
    );

    // Present, or not a production build: nothing to stop.
    assert.doesNotThrow(() => builder.requireProductionSource(true, 'production'));
    assert.doesNotThrow(() => builder.requireProductionSource(false, 'public'));
});

// ============================================
// The admin script goes inside the document, not beside it
// ============================================

test('the admin script is inlined into the dashboard document, closing tags and all', () => {
    const html = '<head></head><body><script src="/js/admin.js"></script></body>';
    const out = builder.inlineAdminScript(html, 'var marker = "</script>"; initAdminDashboard();');

    // The external reference is gone: nothing in the document asks for a file
    // the production worker does not publish.
    assert.ok(out.indexOf('src="/js/admin.js"') === -1, 'the external reference is replaced');

    // The script is there, inside an inline tag.
    assert.match(out, /<script>\n[\s\S]*initAdminDashboard\(\);[\s\S]*\n<\/script>/);

    // A closing tag inside the script cannot end the inline tag early: it is
    // neutralised, so the raw sequence does not appear.
    assert.match(out, /<\\\/script>/, 'the closing tag inside the script is escaped');
    assert.ok(out.indexOf('"</script>";') === -1, 'and does not survive unescaped');

    // If the reference is not there to replace, this fails rather than shipping
    // a document that still points at an unpublished file.
    assert.throws(
        () => builder.inlineAdminScript('<body>no reference here</body>', 'x'),
        /Could not inline js\/admin\.js/
    );
});

// ============================================
// A production build proves it embedded a real dashboard
// ============================================

test('a production build verifies the worker actually got a real dashboard', () => {
    const good = tempDoc(
        'spotifie-doc-good.mjs',
        'export default `<title>Developer Dashboard | Spotifie</title>' +
            '<body class="admin-dashboard"></body><script>function initAdminDashboard(){}</script>`;\n'
    );
    assert.doesNotThrow(() => builder.assertAdminDocument(good));

    const nul = tempDoc('spotifie-doc-null.mjs', 'export default null;\n');
    assert.throws(() => builder.assertAdminDocument(nul), /is null/);

    const bare = tempDoc('spotifie-doc-bare.mjs', 'export default `<body></body>`;\n');
    assert.throws(() => builder.assertAdminDocument(bare), /missing/);

    const secret = tempDoc(
        'spotifie-doc-secret.mjs',
        'export default `<title>Developer Dashboard | Spotifie</title>' +
            '<body class="admin-dashboard"></body>' +
            '<script>function initAdminDashboard(){ var k = "service_role key"; }</script>`;\n'
    );
    assert.throws(() => builder.assertAdminDocument(secret), /service-role/);

    [good, nul, bare, secret].forEach((file) => fs.rmSync(file, { force: true }));
});

// ============================================
// The full builds, to a throwaway directory
// ============================================

test('build:production embeds a real dashboard and publishes no raw admin source', () => {
    builder.build({ mode: 'production', adminModulePath: DOC });

    const files = walk(DIST);

    // A whole application is still there.
    assert.ok(files.indexOf('index.html') !== -1, 'the application is built');
    assert.ok(files.indexOf('js/auth.js') !== -1, 'and its public scripts');

    // But the private half is not a public file: not the raw dashboard page,
    // and not the administrator script.
    assert.ok(files.indexOf('admin-dashboard.html') === -1, 'the raw dashboard page is not an asset');
    assert.ok(files.indexOf('js/admin.js') === -1, 'the admin script is not an asset');

    // The worker got a real document, with the script inlined into it.
    const doc = fs.readFileSync(DOC, 'utf8');
    assert.ok(!/export default null/.test(doc), 'the worker document is not null');
    assert.match(doc, /Developer Dashboard \| Spotifie/, 'it carries the dashboard title');
    assert.match(doc, /<body class="admin-dashboard">/, 'and the dashboard body');
    assert.match(doc, /function initAdminDashboard/, 'and the inlined administrator code');
    assert.ok(doc.indexOf('src="/js/admin.js"') === -1, 'and no reference to an unpublished file');
});

test('build:public keeps the admin script as an ordinary asset and leaves the worker document alone', () => {
    // A sentinel the throwaway public build must not overwrite: under
    // SPOTIFIE_RELEASE_OUT the public build does not rewrite the worker's
    // module, because that is a test building a release, not a deployment.
    fs.writeFileSync(DOC, 'export default "sentinel";\n');

    builder.build({ mode: 'public', adminModulePath: DOC });

    const files = walk(DIST);
    assert.ok(files.indexOf('js/admin.js') !== -1, 'the public build ships the admin script as an asset');
    assert.ok(files.indexOf('admin-dashboard.html') === -1, 'but never the raw dashboard page');

    assert.strictEqual(
        fs.readFileSync(DOC, 'utf8'),
        'export default "sentinel";\n',
        'a throwaway public build does not touch the worker document'
    );
});

// ============================================
// The release check, in each mode
// ============================================

test('the production release check rejects a null or empty embedded dashboard', () => {
    const nul = tempDoc('spotifie-check-null.mjs', 'export default null;\n');
    const bare = tempDoc('spotifie-check-bare.mjs', 'export default `<body></body>`;\n');
    const good = tempDoc(
        'spotifie-check-good.mjs',
        'export default `<title>Developer Dashboard | Spotifie</title>' +
            '<body class="admin-dashboard"></body><script>function initAdminDashboard(){}</script>`;\n'
    );
    const absent = path.join(os.tmpdir(), 'spotifie-check-absent.mjs');
    fs.rmSync(absent, { force: true });

    let failures = [];
    checker.checkEmbeddedDashboard(failures, nul);
    assert.ok(failures.some((message) => /null/.test(message)), 'a null document is refused');

    failures = [];
    checker.checkEmbeddedDashboard(failures, bare);
    assert.ok(failures.some((message) => /missing/.test(message)), 'a document with no dashboard in it is refused');

    failures = [];
    checker.checkEmbeddedDashboard(failures, absent);
    assert.ok(failures.some((message) => /no embedded dashboard/.test(message)), 'a missing document is refused');

    failures = [];
    checker.checkEmbeddedDashboard(failures, good);
    assert.deepStrictEqual(failures, [], 'a real dashboard passes');

    [nul, bare, good].forEach((file) => fs.rmSync(file, { force: true }));
});

test('the production release check refuses the admin script as a public asset', () => {
    // The public build just wrote a dist that ships js/admin.js as an asset -
    // fine for the public release, forbidden for a production worker, where it
    // belongs inside the gated document. The check in production mode says so.
    builder.build({ mode: 'public', adminModulePath: DOC });
    assert.ok(walk(DIST).indexOf('js/admin.js') !== -1, 'the dist under test carries the admin script');

    // execFileSync throws on a non-zero exit, and the check is meant to fail
    // here: the admin script must not be a public asset in a production build.
    let output = '';
    let failed = false;
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'tools', 'releaseCheck.js'), '--production'], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
            env: Object.assign({}, process.env, { SPOTIFIE_RELEASE_OUT: DIST })
        });
    } catch (error) {
        failed = true;
        output = String(error.stdout || '') + String(error.stderr || '');
    }

    assert.ok(failed, 'the production check refused the release');
    assert.match(output, /js\/admin\.js must not be a public static asset/);
});

// ============================================
// The Android app, offered by the production website
// ============================================

// A release as npm run android:release leaves it: the APK, its verification
// record beside it, and the certificate it was signed with.
const FAKE_RELEASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-release-test-'));
const FAKE_APK = path.join(FAKE_RELEASE_DIR, 'app-release.apk');
const FAKE_CERT = 'ab'.repeat(32);

function writeRecord(apk, overrides) {
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
    const record = Object.assign(
        {
            artifact: 'apk',
            packageName: 'app.spotifie.android',
            // The release this working tree is, so a version bump cannot leave
            // the fixture describing an APK the build would then refuse.
            version: require('../package.json').version,
            versionCode: require('../tools/releaseVersion.js').androidVersionCode(require('../package.json').version),
            minSdk: 26,
            size: fs.statSync(apk).size,
            sha256: digest,
            certificateSha256: FAKE_CERT,
            pinned: true,
            builtAt: '2026-09-15T00:00:00.000Z'
        },
        overrides || {}
    );
    fs.writeFileSync(path.join(path.dirname(apk), 'spotifie-release.json'), JSON.stringify(record));
    return record;
}

/** A small but genuine zip laid out like an APK, standing in for the real one. */
function fakeApk() {
    const name = Buffer.from('assets/public/index.html');
    const body = Buffer.from('<!doctype html><title>Spotifie</title>');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + body.length, 16);

    fs.writeFileSync(FAKE_APK, Buffer.concat([local, name, body, central, name, end]));
    writeRecord(FAKE_APK);
    return FAKE_APK;
}

function downloadsIn(files) {
    return files.filter((file) => /^downloads\//i.test(file) || /\.apk$/i.test(file));
}

test.after(() => fs.rmSync(FAKE_RELEASE_DIR, { recursive: true, force: true }));

test('build:production offers the Android app at one address, and nothing else from the Android project', () => {
    builder.build({ mode: 'production', adminModulePath: DOC, androidApkPath: fakeApk(), androidCertificatePin: FAKE_CERT });

    const files = walk(DIST);
    assert.deepStrictEqual(
        downloadsIn(files).sort(),
        ['downloads/android-release.json', 'downloads/spotifie-android.apk'],
        'exactly the APK and its description'
    );
    assert.ok(fs.readFileSync(path.join(DIST, 'downloads', 'spotifie-android.apk')).equals(fs.readFileSync(FAKE_APK)), 'unchanged');
    assert.ok(!files.some((file) => /^android\/|\.(aab|jks|keystore)$|\.properties$/i.test(file)), 'no build tree, no signing material');

    // The page is told where it is and which version it is.
    const info = JSON.parse(fs.readFileSync(path.join(DIST, 'build-info.json'), 'utf8'));
    assert.strictEqual(info.androidApp.url, '/downloads/spotifie-android.apk');
    assert.strictEqual(info.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    assert.match(fs.readFileSync(path.join(DIST, 'js', 'config.js'), 'utf8'), /"url": "\/downloads\/spotifie-android\.apk"/);

    // Sent as an Android package, saved under a readable name.
    const headers = fs.readFileSync(path.join(DIST, '_headers'), 'utf8');
    assert.match(
        headers,
        /\/downloads\/spotifie-android\.apk\n {2}Content-Type: application\/vnd\.android\.package-archive\n {2}Content-Disposition: attachment; filename="Spotifie-Android\.apk"/
    );

    const failures = [];
    checker.checkDownloads(DIST, 'production', failures);
    assert.deepStrictEqual(failures, [], 'the production check accepts it');
    assert.ok(checker.FORBIDDEN_PATHS.some((pattern) => pattern.test('downloads/spotifie-android.apk')), 'allowed by name only');
});

test('without an APK, build:production still builds and offers no download', () => {
    builder.build({ mode: 'production', adminModulePath: DOC, androidApkPath: path.join(os.tmpdir(), 'no-such-spotifie-app.apk') });

    assert.deepStrictEqual(downloadsIn(walk(DIST)), []);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DIST, 'build-info.json'), 'utf8')).androidApp, undefined);
    assert.ok(!/androidApp/.test(fs.readFileSync(path.join(DIST, 'js', 'config.js'), 'utf8')), 'the page offers nothing');
    assert.ok(!/spotifie-android\.apk/.test(fs.readFileSync(path.join(DIST, '_headers'), 'utf8')));

    const failures = [];
    checker.checkDownloads(DIST, 'production', failures);
    assert.deepStrictEqual(failures, []);
});

test('an APK from another version is never offered as this release', () => {
    // The previous release's APK is still sitting in the Android build output
    // after a version bump. Offering it would put one version on the page and
    // hand over another, so the site offers nothing until the new version has
    // been signed.
    const apk = fakeApk();
    writeRecord(apk, { version: '0.9.0', versionCode: 900099 });

    builder.build({ mode: 'production', adminModulePath: DOC, androidApkPath: apk, androidCertificatePin: FAKE_CERT });

    assert.deepStrictEqual(downloadsIn(walk(DIST)), [], 'no download at all, rather than a stale one');
    assert.ok(!/androidApp/.test(fs.readFileSync(path.join(DIST, 'js', 'config.js'), 'utf8')), 'and the page offers nothing');

    const failures = [];
    checker.checkDownloads(DIST, 'production', failures);
    assert.deepStrictEqual(failures, [], 'a release that offers nothing is still a valid release');

    // The build that does match is offered, so the guard is about the version
    // and not about refusing everything.
    builder.build({ mode: 'production', adminModulePath: DOC, androidApkPath: fakeApk(), androidCertificatePin: FAKE_CERT });
    assert.deepStrictEqual(
        downloadsIn(walk(DIST)).sort(),
        ['downloads/android-release.json', 'downloads/spotifie-android.apk'],
        'the matching build is still offered'
    );
});

test('the public build and the app shells never carry the APK, even when one exists', () => {
    fakeApk();
    [{ mode: 'public' }, { mode: 'public', strict: true, withoutAdmin: true }].forEach((options) => {
        builder.build(Object.assign({ adminModulePath: DOC, androidApkPath: FAKE_APK }, options));
        assert.deepStrictEqual(downloadsIn(walk(DIST)), [], JSON.stringify(options));
        assert.ok(!/androidApp/.test(fs.readFileSync(path.join(DIST, 'build-info.json'), 'utf8')));
    });

    // One smuggled into a public release is refused.
    fs.mkdirSync(path.join(DIST, 'downloads'), { recursive: true });
    fs.copyFileSync(FAKE_APK, path.join(DIST, 'downloads', 'spotifie-android.apk'));
    const failures = [];
    checker.checkDownloads(DIST, 'public', failures);
    assert.ok(failures.some((failure) => /^downloads\/spotifie-android\.apk is not something a release may offer/.test(failure)), failures.join('\n'));

    // The Android web bundle the app is built from holds no APK either.
    const www = path.join(ROOT, 'mobile', 'www');
    if (fs.existsSync(www)) {
        const inside = [];
        const visit = (dir) =>
            fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) visit(full);
                else if (/\.apk$/i.test(entry.name)) inside.push(full);
            });
        visit(www);
        assert.deepStrictEqual(inside, [], 'mobile/www carries no APK');
    }
});

test('the production check refuses extra downloads, the Android tree, and a link to a missing APK', () => {
    builder.build({ mode: 'production', adminModulePath: DOC, androidApkPath: fakeApk(), androidCertificatePin: FAKE_CERT });

    fs.writeFileSync(path.join(DIST, 'downloads', 'other.apk'), 'x');
    fs.mkdirSync(path.join(DIST, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(DIST, 'android', 'app', 'build.gradle'), '');
    const extra = [];
    checker.checkDownloads(DIST, 'production', extra);
    assert.ok(extra.some((failure) => /^downloads\/other\.apk is not something/.test(failure)), 'one file only');
    assert.ok(extra.some((failure) => /^android\/app\/build\.gradle belongs to the Android project/.test(failure)), 'no build tree');

    // The page offers the app, but the file is gone: a broken link, refused.
    fs.rmSync(path.join(DIST, 'downloads'), { recursive: true, force: true });
    const broken = [];
    checker.checkDownloads(DIST, 'production', broken);
    assert.ok(broken.some((failure) => /offers the Android app but does not carry it/.test(failure)), broken.join('\n'));

    // Signing material is refused by name wherever it is.
    ['release.keystore', 'upload.jks', 'app-release.aab', 'keystore.properties', 'signing.properties', 'google-services.json'].forEach(
        (name) => assert.ok(checker.FORBIDDEN_PATHS.some((pattern) => pattern.test(name)), name)
    );
});
