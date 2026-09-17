'use strict';

/**
 * Android release engineering: one version authority, release signing that
 * comes only from the environment, and a website that offers only the signed
 * release APK - verified, pinned, described truthfully - and never a debug one.
 *
 * The signing and building themselves are run for real by npm run
 * android:release; here the rules are held: what the tool refuses, what the
 * Gradle file may contain, and what the production build will and will not
 * publish.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// The production builder writes where this says; set before it is loaded.
const DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-android-release-dist-'));
const DOC = path.join(os.tmpdir(), 'spotifie-android-release-doc.mjs');
process.env.SPOTIFIE_RELEASE_OUT = DIST;
process.env.SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.SUPABASE_ANON_KEY = 'sb_publishable_releasecandidatetestvalue0123';
process.env.PUBLIC_SITE_URL = 'https://spotifie-rc-test.pages.dev';
delete process.env.SPOTIFIE_ANDROID_CERT_SHA256;

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const builder = require('../tools/buildPublic.js');
const checker = require('../tools/releaseCheck.js');
const release = require('../tools/androidRelease.js');
const { androidVersionCode, androidReleaseName, readVersion } = require('../tools/releaseVersion.js');

/**
 * The release this working tree is.
 *
 * Fixtures describe that version rather than one written down here, because a
 * website only offers an APK that is the release the site itself claims to be -
 * so a fixture pinned to an old version would describe an app the build is
 * right to refuse.
 */
const PACKAGE_VERSION = require('../package.json').version;

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const CERT = 'cd'.repeat(32);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'spotifie-android-release-'));

test.after(() => {
    [DIST, WORK].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    fs.rmSync(DOC, { force: true });
});

/** A small real zip, with the named entries stored uncompressed. */
function zip(file, entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    Object.keys(entries).forEach((entryName) => {
        const name = Buffer.from(entryName);
        const body = Buffer.from(entries[entryName]);
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
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    });
    const centralSize = centrals.reduce((total, part) => total + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat(locals.concat(centrals, [end])));
    return file;
}

/** An APK and the record npm run android:release leaves beside it. */
function releaseApk(dir, overrides) {
    const apk = zip(path.join(dir, 'app-release.apk'), { 'assets/public/index.html': '<!doctype html><title>Spotifie</title>' });
    const record = Object.assign(
        {
            artifact: 'apk',
            packageName: 'app.spotifie.android',
            // The release this working tree is: a website only offers an APK
            // that is the version the site itself claims to be.
            version: PACKAGE_VERSION,
            versionCode: androidVersionCode(PACKAGE_VERSION),
            minSdk: 26,
            size: fs.statSync(apk).size,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
            certificateSha256: CERT,
            pinned: true,
            builtAt: '2026-09-15T00:00:00.000Z'
        },
        overrides || {}
    );
    fs.writeFileSync(path.join(dir, 'spotifie-release.json'), JSON.stringify(record));
    return apk;
}

function downloads() {
    const dir = path.join(DIST, 'downloads');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

// ============================================
// One version, from package.json
// ============================================

test('versionCode is derived from package.json and only ever rises', () => {
    assert.strictEqual(androidVersionCode('1.0.0-rc.1'), 1000001);
    assert.strictEqual(androidVersionCode('1.0.0'), 1000099);

    const order = ['1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.98', '1.0.0', '1.0.1-rc.1', '1.0.1', '1.1.0-rc.1', '1.1.0', '2.0.0-rc.1', '2.0.0'];
    const codes = order.map(androidVersionCode);
    codes.forEach((code, i) => {
        if (i) assert.ok(code > codes[i - 1], order[i] + ' comes after ' + order[i - 1]);
    });
    assert.ok(codes[0] > 1, 'never below the versionCode 1 already built');

    ['1.0', 'v1.0.0', '1.0.0-beta.1', '1.0.0-rc.99', '1.100.0', '1.0.0-rc.0'].forEach((bad) => {
        assert.throws(() => androidVersionCode(bad), bad);
    });

    assert.strictEqual(androidReleaseName(26), 'Android 8.0');
});

test('Gradle takes versionName and versionCode from package.json by the same rule', () => {
    const gradle = source('android', 'app', 'build.gradle');
    assert.match(gradle, /new JsonSlurper\(\)\.parse\(file\('\.\.\/\.\.\/package\.json'\)\)\.version/);
    assert.match(gradle, /major \* 1000000 \+ minor \* 10000 \+ patch \* 100 \+ step/);
    assert.match(gradle, /int step = match\.group\(4\) != null \? \(match\.group\(4\) as int\) : 99/);
    assert.match(gradle, /versionCode spotifieVersionCode/);
    assert.match(gradle, /versionName spotifieVersion/);
    assert.ok(!/versionCode \d/.test(gradle) && !/versionName "/.test(gradle), 'nothing written by hand');

    // The web, Android and iOS all read the same version.
    const version = readVersion();
    assert.strictEqual(version, JSON.parse(source('package.json')).version);
    assert.strictEqual(require('../tools/iosBuild.js').marketingVersion(version), version.replace(/-.*$/, ''));
});

// ============================================
// Release signing
// ============================================

test('release signing comes from the environment only, and the debug key is refused', () => {
    const gradle = source('android', 'app', 'build.gradle');
    release.SIGNING_ENV.forEach((name) => assert.match(gradle, new RegExp("System\\.getenv\\('" + name + "'\\)")));
    assert.ok(!/storePassword\s+['"]/.test(gradle) && !/keyPassword\s+['"]/.test(gradle), 'no password written in the build file');
    assert.ok(!/signingConfigs\.debug/.test(gradle), 'release never falls back to the debug signing config');
    assert.match(gradle, /Release signing is not configured/);
    assert.match(gradle, /That is the Android debug key/);

    // Nothing that names a secret anywhere a reader could see it.
    const pkg = source('package.json');
    assert.ok(!/PASSWORD=|storepass|keypass/i.test(pkg));
});

test('the release tool refuses to start without signing, with a keystore in the project, or with the debug key', () => {
    const missing = release.signingProblems({}).join('\n');
    release.SIGNING_ENV.forEach((name) => assert.ok(missing.indexOf(name) !== -1, name));

    const outside = path.join(WORK, 'spotifie-release.jks');
    fs.writeFileSync(outside, 'not a real keystore');
    const env = {
        SPOTIFIE_ANDROID_KEYSTORE: outside,
        SPOTIFIE_ANDROID_KEY_ALIAS: 'spotifie',
        SPOTIFIE_ANDROID_KEYSTORE_PASSWORD: 'store-secret-value',
        SPOTIFIE_ANDROID_KEY_PASSWORD: 'key-secret-value'
    };
    assert.deepStrictEqual(release.signingProblems(env), []);

    const inside = release.signingProblems(Object.assign({}, env, { SPOTIFIE_ANDROID_KEYSTORE: path.join(ROOT, 'package.json') })).join('\n');
    assert.match(inside, /inside the project folder/);

    const debug = release.signingProblems(Object.assign({}, env, { SPOTIFIE_ANDROID_KEY_ALIAS: 'androiddebugkey' })).join('\n');
    assert.match(debug, /debug key/);

    // A problem names the setting, never its value.
    const problems = release.signingProblems(Object.assign({}, env, { SPOTIFIE_ANDROID_KEY_PASSWORD: '' })).join('\n');
    assert.ok(problems.indexOf('store-secret-value') === -1 && problems.indexOf(outside) === -1);
});

test('keystores and signing settings are ignored by git, and no keystore is in the project', () => {
    const ignore = source('.gitignore');
    ['*.jks', '*.keystore', '*.p12', 'keystore.properties', 'signing.properties', '*.aab'].forEach((pattern) => {
        assert.ok(ignore.split(/\r?\n/).indexOf(pattern) !== -1, pattern);
    });

    const found = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'build', '.gradle'].indexOf(entry.name) !== -1) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (/\.(jks|keystore|p12|pfx)$/i.test(entry.name)) found.push(path.relative(ROOT, full));
        }
    };
    visit(ROOT);
    assert.deepStrictEqual(found, [], 'no keystore anywhere in the working tree');

    // The pin is a public fingerprint or nothing - never a secret.
    const pin = JSON.parse(source('android', 'release-signing.json'));
    assert.deepStrictEqual(Object.keys(pin).sort(), ['about', 'certificateSha256']);
    assert.ok(pin.certificateSha256 === null || /^[0-9a-f]{64}$/.test(pin.certificateSha256));
});

test('what apksigner and keytool say is read correctly, and the debug certificate is recognised', () => {
    const verified = release.parseApksigner(
        [
            'Verifies',
            'Verified using v1 scheme (JAR signing): false',
            'Verified using v2 scheme (APK Signature Scheme v2): true',
            'Verified using v3 scheme (APK Signature Scheme v3): true',
            'Number of signers: 1',
            'Signer #1 certificate DN: CN=Spotifie, O=Spotifie',
            'Signer #1 certificate SHA-256 digest: ' + CERT
        ].join('\n')
    );
    assert.strictEqual(verified.verified, true);
    assert.strictEqual(verified.v2, true);
    assert.strictEqual(verified.signers, 1);
    assert.strictEqual(verified.sha256, CERT);
    assert.strictEqual(release.parseApksigner('DOES NOT VERIFY\nERROR: ...').verified, false);

    const printed = release.parseKeytoolCertificate('Owner: CN=Spotifie\nSHA256: ' + CERT.toUpperCase().match(/../g).join(':'));
    assert.strictEqual(printed.sha256, CERT);

    assert.strictEqual(release.isDebugCertificate('C=US, O=Android, CN=Android Debug', 'ef'.repeat(32), null), true);
    assert.strictEqual(release.isDebugCertificate('CN=Spotifie', 'ef'.repeat(32), 'ef'.repeat(32)), true, 'this machine’s debug key');
    assert.strictEqual(release.isDebugCertificate('CN=Spotifie', CERT, 'ef'.repeat(32)), false);
});

test('a signing password inside an artifact is found and not repeated', () => {
    const file = zip(path.join(WORK, 'leaky.apk'), { 'assets/public/index.html': 'x store-secret-value y' });
    assert.strictEqual(release.carriesSigningSecret(file, { SPOTIFIE_ANDROID_KEYSTORE_PASSWORD: 'store-secret-value' }), true);
    assert.strictEqual(release.carriesSigningSecret(file, { SPOTIFIE_ANDROID_KEYSTORE_PASSWORD: 'something-else' }), false);
});

test('an App Bundle is inspected like the APK: no admin source, no keystore, no extra permission', () => {
    // A receiver's android:permission (callers must hold DUMP) is not a
    // permission the app asks for; only a <uses-permission> is.
    const clean = zip(path.join(WORK, 'clean.aab'), {
        'base/assets/public/index.html': '<!doctype html>',
        'base/manifest/AndroidManifest.xml':
            'manifest uses-permission android.permission.INTERNET application receiver androidx.profileinstaller.ProfileInstallReceiver android.permission.DUMP'
    });
    assert.deepStrictEqual(release.inspectBundle(clean), []);
    assert.deepStrictEqual(
        release.requestedPermissions(Buffer.from('uses-permission android.permission.INTERNET receiver android.permission.DUMP')),
        ['android.permission.INTERNET']
    );

    const dirty = zip(path.join(WORK, 'dirty.aab'), {
        'base/assets/public/index.html': '<!doctype html>',
        'base/assets/public/admin-dashboard.html': '<html>',
        'base/assets/upload.jks': 'x',
        'base/manifest/AndroidManifest.xml': 'uses-permission android.permission.INTERNET uses-permission android.permission.CAMERA'
    });
    const problems = release.inspectBundle(dirty).join('\n');
    assert.match(problems, /admin-dashboard\.html must not be in the app/);
    assert.match(problems, /upload\.jks is signing material/);
    assert.match(problems, /android\.permission\.CAMERA/);
});

// ============================================
// The website offers only the signed release
// ============================================

test('build:production offers the signed release APK, pinned and described, and the check accepts it', () => {
    const dir = fs.mkdtempSync(path.join(WORK, 'good-'));
    const apk = releaseApk(dir);
    builder.build({ mode: 'production', adminModulePath: DOC, androidApkPath: apk, androidCertificatePin: CERT });

    assert.deepStrictEqual(downloads(), ['android-release.json', 'spotifie-android.apk']);
    const metadata = JSON.parse(fs.readFileSync(path.join(DIST, 'downloads', 'android-release.json'), 'utf8'));
    assert.strictEqual(metadata.version, PACKAGE_VERSION);
    assert.strictEqual(metadata.versionCode, androidVersionCode(PACKAGE_VERSION));
    assert.strictEqual(metadata.apk, '/downloads/spotifie-android.apk');
    assert.strictEqual(metadata.size, fs.statSync(apk).size);
    assert.strictEqual(metadata.sha256, crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex'));
    assert.strictEqual(metadata.minimumAndroid, 'Android 8.0');
    const text = JSON.stringify(metadata);
    assert.ok(!/app-release|app-debug|[A-Za-z]:\\\\|\/Users\/|password|keystore/i.test(text), 'nothing private in it');

    const build = JSON.parse(fs.readFileSync(path.join(DIST, 'build-info.json'), 'utf8'));
    assert.strictEqual(build.androidApp.sha256, metadata.sha256, 'the page is told the same checksum');
    assert.strictEqual(build.androidApp.version, PACKAGE_VERSION);

    assert.match(fs.readFileSync(path.join(DIST, '_headers'), 'utf8'), /\/downloads\/android-release\.json\n {2}Content-Type: application\/json/);

    const failures = [];
    checker.checkDownloads(DIST, 'production', failures);
    assert.deepStrictEqual(failures, []);
});

test('a debug build, an unverified APK, an unpinned or wrong certificate: never offered', () => {
    const debugDir = path.join(WORK, 'outputs', 'apk', 'debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const debugApk = releaseApk(debugDir);
    fs.renameSync(debugApk, path.join(debugDir, 'app-debug.apk'));
    const cases = [
        { name: 'a debug APK', options: { androidApkPath: path.join(debugDir, 'app-debug.apk'), androidCertificatePin: CERT } },
        {
            name: 'no verification record',
            prepare: (dir) => {
                const apk = releaseApk(dir);
                fs.rmSync(path.join(dir, 'spotifie-release.json'));
                return apk;
            },
            pin: CERT
        },
        { name: 'a record for another file', prepare: (dir) => releaseApk(dir, { sha256: '00'.repeat(32) }), pin: CERT },
        { name: 'no pinned certificate', prepare: (dir) => releaseApk(dir), pin: null },
        { name: 'another certificate', prepare: (dir) => releaseApk(dir, { certificateSha256: 'ee'.repeat(32) }), pin: CERT }
    ];

    for (const entry of cases) {
        const options = entry.options || { androidApkPath: entry.prepare(fs.mkdtempSync(path.join(WORK, 'case-'))), androidCertificatePin: entry.pin };
        builder.build(Object.assign({ mode: 'production', adminModulePath: DOC }, options));
        assert.deepStrictEqual(downloads(), [], entry.name + ': no download');
        const build = JSON.parse(fs.readFileSync(path.join(DIST, 'build-info.json'), 'utf8'));
        assert.strictEqual(build.androidApp, undefined, entry.name + ': the page offers nothing');
    }

    // And the builder does not even know where a debug build lives.
    assert.ok(!/app-debug\.apk'|outputs', 'apk', 'debug'/.test(source('tools', 'buildPublic.js')));
});

test('the release check refuses a description that does not match the APK', () => {
    const dir = fs.mkdtempSync(path.join(WORK, 'meta-'));
    builder.build({ mode: 'production', adminModulePath: DOC, androidApkPath: releaseApk(dir), androidCertificatePin: CERT });

    const file = path.join(DIST, 'downloads', 'android-release.json');
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, metadata, { sha256: '11'.repeat(32), note: 'C:\\Users\\someone\\app-release.apk' })));

    const failures = [];
    checker.checkDownloads(DIST, 'production', failures);
    const text = failures.join('\n');
    assert.match(text, /wrong SHA-256/);
    assert.match(text, /names something private/);

    fs.rmSync(path.join(DIST, 'downloads', 'spotifie-android.apk'));
    const orphan = [];
    checker.checkDownloads(DIST, 'production', orphan);
    assert.ok(orphan.some((failure) => /describes an APK the release does not carry/.test(failure)), orphan.join('\n'));
});

test('the App Bundle is for Google Play only: the website never offers it', () => {
    assert.ok(!/\.aab/.test(source('tools', 'buildPublic.js')), 'the website build never reads a bundle');
    assert.ok(checker.FORBIDDEN_PATHS.some((pattern) => pattern.test('downloads/spotifie-android.aab')));
    assert.match(source('tools', 'androidRelease.js'), /The website never offers it/);
});
