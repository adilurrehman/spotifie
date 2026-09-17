'use strict';

/**
 * Build a signed Android release, and prove what it is before anybody gets it.
 *
 *   npm run android:release   the signed APK the website offers
 *   npm run android:bundle    the signed App Bundle, for Google Play later
 *
 * 1. Refuse to start without release signing: the keystore and its passwords
 *    come from the environment of the person building (never this repository),
 *    the keystore must live outside the project, and the debug key is refused.
 *    Nothing here prints a password.
 * 2. Build the frontend (strict public settings, no admin source), sync it into
 *    the Android project, and run Gradle's release task, which signs with that
 *    key or fails.
 * 3. Check the result:
 *    - signature valid (apksigner for the APK, jarsigner for the bundle);
 *    - the signer is not the Android debug certificate;
 *    - package and version are package.json's;
 *    - the permissions are only the ones Spotifie uses;
 *    - no admin source, server, private file, audio, secret, machine path or
 *      signing password inside;
 *    - and, once a release certificate is pinned in android/release-signing.json,
 *      signed by that certificate and no other.
 * 4. Write a small verification record beside the artifact. The website build
 *    offers an APK only with a record that matches it byte for byte.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const android = require('./androidBuild.js');
const { readVersion, androidVersionCode } = require('./releaseVersion.js');

const ROOT = android.ROOT;
const ANDROID = android.ANDROID;
const OUTPUTS = path.join(ANDROID, 'app', 'build', 'outputs');
const RELEASE_APK = path.join(OUTPUTS, 'apk', 'release', 'app-release.apk');
const RELEASE_BUNDLE = path.join(OUTPUTS, 'bundle', 'release', 'app-release.aab');
const RECORD_NAME = 'spotifie-release.json';
const PIN_FILE = path.join(ANDROID, 'release-signing.json');
const PACKAGE = 'app.spotifie.android';

const SIGNING_ENV = [
    'SPOTIFIE_ANDROID_KEYSTORE',
    'SPOTIFIE_ANDROID_KEY_ALIAS',
    'SPOTIFIE_ANDROID_KEYSTORE_PASSWORD',
    'SPOTIFIE_ANDROID_KEY_PASSWORD'
];

// ============================================
// Signing configuration
// ============================================

/** What is wrong with the signing configuration. Names only - never a value. */
function signingProblems(env) {
    const settings = env || process.env;
    const problems = [];

    const missing = SIGNING_ENV.filter((name) => !settings[name] || !String(settings[name]).trim());
    if (missing.length) {
        problems.push('Release signing is not configured: set ' + missing.join(', ') + ' (see SPOTIFIE_OPERATIONS.private.md).');
    }

    const store = settings.SPOTIFIE_ANDROID_KEYSTORE;
    if (store && String(store).trim()) {
        const full = path.resolve(store);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
            problems.push('SPOTIFIE_ANDROID_KEYSTORE does not name a keystore file.');
        }
        const inside = path.relative(ROOT, full);
        if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
            problems.push('The release keystore is inside the project folder. Keep it outside the repository.');
        }
        if (/^debug\.keystore$/i.test(path.basename(full)) || settings.SPOTIFIE_ANDROID_KEY_ALIAS === 'androiddebugkey') {
            problems.push('That is the Android debug key. A release is never signed with it.');
        }
    }

    return problems;
}

/** A SHA-256 fingerprint as 64 lowercase hex digits, whatever way it was written. */
function normalizeFingerprint(value) {
    const hex = String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    return hex.length === 64 ? hex : null;
}

/** The release certificate the website will accept: the environment's, or the committed one. */
function readPin(env, pinFile) {
    const settings = env || process.env;
    if (settings.SPOTIFIE_ANDROID_CERT_SHA256) return normalizeFingerprint(settings.SPOTIFIE_ANDROID_CERT_SHA256);
    try {
        return normalizeFingerprint(JSON.parse(fs.readFileSync(pinFile || PIN_FILE, 'utf8')).certificateSha256);
    } catch (e) {
        return null;
    }
}

function isDebugCertificate(subject, sha256, debugSha256) {
    if (/CN=Android Debug/i.test(String(subject || ''))) return true;
    return Boolean(debugSha256 && sha256 && debugSha256 === sha256);
}

// ============================================
// Tools
// ============================================

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function capture(command, args, env) {
    const quoted = [command].concat(args).map((part) => (/\s/.test(part) ? '"' + part + '"' : part)).join(' ');
    const result = spawnSync(quoted, { cwd: ROOT, env: env, shell: true, encoding: 'utf8' });
    return { status: result.status, output: String(result.stdout || '') + String(result.stderr || '') };
}

function run(command, args, options) {
    const result = spawnSync(command, args, Object.assign({ cwd: ROOT, stdio: 'inherit', shell: true }, options || {}));
    if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + ').');
}

function buildTool(env, name) {
    const tools = path.join(env.ANDROID_HOME, 'build-tools');
    const versions = fs.existsSync(tools) ? fs.readdirSync(tools).sort() : [];
    for (let i = versions.length - 1; i >= 0; i -= 1) {
        const candidates = process.platform === 'win32' ? [name + '.bat', name + '.exe'] : [name];
        for (const candidate of candidates) {
            const full = path.join(tools, versions[i], candidate);
            if (fs.existsSync(full)) return full;
        }
    }
    throw new Error(name + ' was not found in the Android SDK build-tools.');
}

function javaTool(env, name) {
    return path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? name + '.exe' : name);
}

/** apksigner's own words about an APK: valid or not, and who signed it. */
function parseApksigner(output) {
    const text = String(output || '');
    return {
        verified: /^Verifies\s*$/m.test(text),
        v2: /Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(text),
        v3: /Verified using v3 scheme \(APK Signature Scheme v3\): true/.test(text),
        signers: (text.match(/^Signer #\d+ certificate DN:/gm) || []).length,
        subject: ((/^Signer #1 certificate DN: (.+)$/m.exec(text) || [])[1] || '').trim(),
        sha256: normalizeFingerprint((/^Signer #1 certificate SHA-256 digest: ([0-9a-fA-F:]+)$/m.exec(text) || [])[1])
    };
}

/** keytool -printcert's words about a signed archive or a keystore entry. */
function parseKeytoolCertificate(output) {
    const text = String(output || '');
    return {
        subject: ((/^Owner: (.+)$/m.exec(text) || [])[1] || '').trim(),
        sha256: normalizeFingerprint((/SHA256: ([0-9A-Fa-f:]+)/.exec(text) || [])[1])
    };
}

/** The Android debug certificate on this machine, to be sure a release is not signed with it. */
function debugCertificateSha256(env) {
    const store = path.join(os.homedir(), '.android', 'debug.keystore');
    if (!fs.existsSync(store)) return null;
    // "android" is the debug keystore's published, well-known password.
    const result = capture(javaTool(env, 'keytool'), ['-list', '-v', '-keystore', store, '-alias', 'androiddebugkey', '-storepass', 'android'], env);
    return result.status === 0 ? parseKeytoolCertificate(result.output).sha256 : null;
}

// ============================================
// Looking inside
// ============================================

/** A signing password written anywhere inside the artifact. Reports that it is there, never what it is. */
function carriesSigningSecret(file, env) {
    const data = fs.readFileSync(file);
    const secrets = ['SPOTIFIE_ANDROID_KEYSTORE_PASSWORD', 'SPOTIFIE_ANDROID_KEY_PASSWORD']
        .map((name) => (env || {})[name])
        .filter((value) => value && String(value).length >= 6);
    return secrets.some(
        (value) => data.indexOf(Buffer.from(String(value), 'utf8')) !== -1 || data.indexOf(Buffer.from(String(value), 'utf16le')) !== -1
    );
}

/** Signing material or a keystore packed inside an artifact, by name. */
const SIGNING_NAMES = /\.(jks|keystore|p12|pfx)$|(^|\/)(keystore|signing)\.properties$/i;

/**
 * The permissions a bundle's (protobuf) manifest asks for: each permission
 * name whose nearest preceding element is <uses-permission>.
 */
function requestedPermissions(bytes) {
    const text = Buffer.from(bytes).toString('latin1');
    const asked = new Set();
    for (const hit of text.matchAll(/(?:android\.permission|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.permission|app\.spotifie\.android)\.[A-Z_]+/g)) {
        const before = text.slice(Math.max(0, hit.index - 300), hit.index);
        const elements = before.match(/uses-permission(?:-sdk-23)?|permission-group|permission-tree|permission|receiver|service|activity|provider|application/g) || [];
        const nearest = elements[elements.length - 1];
        if (nearest === 'uses-permission' || nearest === 'uses-permission-sdk-23') asked.add(hit[0]);
    }
    return Array.from(asked);
}

/**
 * An App Bundle, looked inside the same way as the APK: its modules keep the
 * web assets under base/assets/public/.
 */
function inspectBundle(file) {
    const zip = android.readZip(file);
    const problems = [];
    const machine = [ROOT, os.homedir()].filter((value) => value && value.length > 3);

    for (const entry of zip.entries) {
        const inner = entry.name.replace(/^base\//, '');
        if (android.FORBIDDEN_NAMES.some((pattern) => pattern.test(inner))) problems.push(entry.name + ' must not be in the app.');
        if (SIGNING_NAMES.test(entry.name)) problems.push(entry.name + ' is signing material and must not be in the app.');

        if (!/^base\/assets\/public\/.*\.(html|js|css|json|webmanifest|svg|txt)$/i.test(entry.name)) continue;
        const text = entry.read().toString('utf8');
        for (const rule of android.FORBIDDEN_TEXT) {
            if (rule.pattern.test(text)) problems.push(entry.name + ' contains ' + rule.name + '.');
        }
        for (const value of machine) {
            if (text.indexOf(value) !== -1 || text.indexOf(value.split(path.sep).join('/')) !== -1) {
                problems.push(entry.name + ' names a path on the machine it was built on.');
            }
        }
    }

    if (!zip.entries.some((entry) => entry.name === 'base/assets/public/index.html')) {
        problems.push('The bundle carries no index.html; the frontend was not copied in.');
    }

    // The merged manifest is binary, but element and permission names are plain
    // strings in it. Only a permission inside a <uses-permission> is one the app
    // asks for; the same name as a component's android:permission (a receiver
    // that only callers holding DUMP may reach, say) asks for nothing.
    const manifest = zip.entries.find((entry) => entry.name === 'base/manifest/AndroidManifest.xml');
    if (!manifest) {
        problems.push('The bundle has no manifest.');
    } else {
        requestedPermissions(manifest.read())
            .filter((name) => android.ALLOWED_PERMISSIONS.indexOf(name) === -1)
            .forEach((name) => problems.push('The bundle asks for ' + name + ', which Spotifie does not use.'));
    }

    return problems;
}

function badging(apk, env) {
    const aapt2 = path.join(path.dirname(buildTool(env, 'apksigner')), process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
    const result = spawnSync(aapt2, ['dump', 'badging', apk], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('aapt2 could not read the APK.');
    const text = result.stdout;
    return {
        packageName: (/package: name='([^']+)'/.exec(text) || [])[1],
        versionCode: Number((/versionCode='(\d+)'/.exec(text) || [])[1]),
        versionName: (/versionName='([^']+)'/.exec(text) || [])[1],
        // aapt2 says minSdkVersion:'26'; the older aapt said sdkVersion:'26'.
        minSdk: Number((/(?:minSdkVersion|sdkVersion):'(\d+)'/.exec(text) || [])[1]) || null
    };
}

function minSdkFromGradle() {
    const text = fs.readFileSync(path.join(ANDROID, 'variables.gradle'), 'utf8');
    return Number((/minSdkVersion = (\d+)/.exec(text) || [])[1]);
}

// ============================================
// Build
// ============================================

function main() {
    const bundle = process.argv.indexOf('--bundle') !== -1;
    const kind = bundle ? 'App Bundle' : 'APK';

    const problems = signingProblems(process.env);
    if (problems.length) throw new Error(problems.join('\n  '));

    const version = readVersion();
    const versionCode = androidVersionCode(version);

    run('node', [path.join('tools', 'buildMobile.js')]);
    run('npx', ['cap', 'sync', 'android']);

    const env = android.androidEnvironment();
    const gradle = path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    run('"' + gradle + '"', [bundle ? 'bundleRelease' : 'assembleRelease', '--no-daemon'], { cwd: ANDROID, env: env });

    const artifact = bundle ? RELEASE_BUNDLE : RELEASE_APK;
    if (!fs.existsSync(artifact)) throw new Error('Gradle finished without producing ' + path.relative(ROOT, artifact) + '.');

    const failures = [];
    const debugSha = debugCertificateSha256(env);
    let certificate;
    let minSdk;

    if (bundle) {
        failures.push(...inspectBundle(artifact));

        const verify = capture(javaTool(env, 'jarsigner'), ['-verify', artifact], env);
        if (verify.status !== 0 || !/jar verified/i.test(verify.output)) failures.push('The bundle signature does not verify.');
        certificate = parseKeytoolCertificate(capture(javaTool(env, 'keytool'), ['-printcert', '-jarfile', artifact], env).output);
        minSdk = minSdkFromGradle();
    } else {
        failures.push(...android.inspectApk(artifact));
        android
            .readZip(artifact)
            .entries.filter((entry) => SIGNING_NAMES.test(entry.name))
            .forEach((entry) => failures.push(entry.name + ' is signing material and must not be in the app.'));

        android
            .mergedPermissions(artifact, env)
            .filter((name) => android.ALLOWED_PERMISSIONS.indexOf(name) === -1)
            .forEach((name) => failures.push('The APK asks for ' + name + ', which Spotifie does not use.'));

        const signed = parseApksigner(capture(buildTool(env, 'apksigner'), ['verify', '--verbose', '--print-certs', artifact], env).output);
        if (!signed.verified) failures.push('The APK signature does not verify.');
        if (!signed.v2 && !signed.v3) failures.push('The APK is not signed with APK Signature Scheme v2 or v3.');
        if (signed.signers !== 1) failures.push('The APK has ' + signed.signers + ' signers; it should have exactly one.');
        certificate = { subject: signed.subject, sha256: signed.sha256 };

        const facts = badging(artifact, env);
        if (facts.packageName !== PACKAGE) failures.push('The APK is ' + facts.packageName + ', not ' + PACKAGE + '.');
        if (facts.versionName !== version) failures.push('The APK says version ' + facts.versionName + '; package.json says ' + version + '.');
        if (facts.versionCode !== versionCode) failures.push('The APK has versionCode ' + facts.versionCode + '; ' + version + ' maps to ' + versionCode + '.');
        minSdk = facts.minSdk;
    }

    if (!certificate || !certificate.sha256) failures.push('The signing certificate could not be read.');
    else if (isDebugCertificate(certificate.subject, certificate.sha256, debugSha)) failures.push('The ' + kind + ' is signed with the Android debug certificate.');

    if (carriesSigningSecret(artifact, process.env)) failures.push('The ' + kind + ' contains a signing password.');

    const pin = readPin(process.env);
    if (pin && certificate && certificate.sha256 && pin !== certificate.sha256) {
        failures.push('The ' + kind + ' is signed by a certificate other than the pinned release certificate (android/release-signing.json).');
    }

    if (failures.length) throw new Error('The signed ' + kind + ' is not fit to distribute:\n  - ' + failures.join('\n  - '));

    const record = {
        artifact: bundle ? 'aab' : 'apk',
        packageName: PACKAGE,
        version: version,
        versionCode: versionCode,
        minSdk: minSdk,
        size: fs.statSync(artifact).size,
        sha256: sha256File(artifact),
        certificateSha256: certificate.sha256,
        pinned: Boolean(pin),
        builtAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(path.dirname(artifact), RECORD_NAME), JSON.stringify(record, null, 2) + '\n');

    console.log('');
    console.log('Signed Android ' + kind + ': ' + path.relative(ROOT, artifact) + '  ' + (record.size / (1024 * 1024)).toFixed(1) + ' MB');
    console.log('  ' + PACKAGE + ' ' + version + ' (versionCode ' + versionCode + ')');
    console.log('  SHA-256 of the file:        ' + record.sha256);
    console.log('  Signing certificate SHA-256: ' + record.certificateSha256);
    console.log('  Checked: signature, not the debug key, permissions, no admin source, no secrets, no machine paths.');
    if (!pin) {
        console.log('');
        console.log('  Not pinned yet. The website offers an APK only when android/release-signing.json names');
        console.log('  its certificate. If this is the release key, put the certificate SHA-256 above there.');
    }
    if (bundle) console.log('  The App Bundle is for Google Play only. The website never offers it.');
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error('Could not build the signed Android release: ' + err.message);
        process.exit(1);
    }
}

module.exports = {
    signingProblems,
    normalizeFingerprint,
    readPin,
    isDebugCertificate,
    parseApksigner,
    parseKeytoolCertificate,
    carriesSigningSecret,
    requestedPermissions,
    inspectBundle,
    sha256File,
    SIGNING_ENV,
    RELEASE_APK,
    RELEASE_BUNDLE,
    RECORD_NAME,
    PIN_FILE,
    PACKAGE
};
