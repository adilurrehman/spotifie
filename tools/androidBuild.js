'use strict';

/**
 * Build the Android debug APK, and inspect it before anybody installs it.
 *
 * 1. Build the frontend (npm run build:mobile): strict public settings, no
 *    admin source, no server, no service worker, checked for leaks.
 * 2. Copy it into the Android project (cap sync android).
 * 3. Assemble the debug APK with Gradle, using Android Studio's bundled JDK and
 *    the SDK on this machine.
 * 4. Open the APK and look inside: every file it carries, and the text of the
 *    web assets. It must not contain administrator source, the Node server,
 *    private documents, audio, a secret, or a path from this machine. A
 *    failure stops here.
 *
 * The result is an unsigned-for-release debug APK, for development and testing.
 * No release signing key is created or used.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const APK = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

function run(command, args, options) {
    const result = spawnSync(command, args, Object.assign({ cwd: ROOT, stdio: 'inherit', shell: true }, options || {}));
    if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + ').');
}

/** A portable JDK 21 in %LOCALAPPDATA%\spotifie-tools, if one is there. */
function findJdk21() {
    const tools = path.join(os.homedir(), 'AppData', 'Local', 'spotifie-tools');
    if (!fs.existsSync(tools)) return null;
    const found = fs
        .readdirSync(tools)
        .filter((name) => /^jdk-21/.test(name) && fs.existsSync(path.join(tools, name, 'bin')))
        .sort()
        .pop();
    return found ? path.join(tools, found) : null;
}

/** Where the Android tools are, without asking anybody to set a variable. */
function androidEnvironment() {
    const env = Object.assign({}, process.env);

    if (!env.ANDROID_HOME) {
        const sdk = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
        if (fs.existsSync(sdk)) env.ANDROID_HOME = sdk;
    }
    // Capacitor 8 builds with Gradle 8.14, which runs on JDK 17-24. A JDK 21
    // is preferred: one named explicitly, then a portable one kept in the
    // user's own tools folder. Android Studio's bundled JDK is the last resort
    // and may be too new for this Gradle.
    const jdk21 = findJdk21();
    if (process.env.SPOTIFIE_ANDROID_JAVA_HOME) {
        env.JAVA_HOME = process.env.SPOTIFIE_ANDROID_JAVA_HOME;
    } else if (jdk21) {
        env.JAVA_HOME = jdk21;
    } else if (!env.JAVA_HOME) {
        const jbr = path.join('C:', 'Program Files', 'Android', 'Android Studio', 'jbr');
        if (fs.existsSync(jbr)) env.JAVA_HOME = jbr;
    }
    if (!env.ANDROID_HOME) throw new Error('No Android SDK found. Install Android Studio, or set ANDROID_HOME.');
    if (!env.JAVA_HOME) throw new Error('No JDK found. Install Android Studio, or set JAVA_HOME.');
    return env;
}

// ============================================
// Reading an APK, which is a zip
// ============================================

/** Every entry in a zip: its name, and a way to read it. */
function readZip(file) {
    const data = fs.readFileSync(file);

    // The end-of-central-directory record, searched for from the end.
    let end = -1;
    for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at -= 1) {
        if (data.readUInt32LE(at) === 0x06054b50) {
            end = at;
            break;
        }
    }
    if (end === -1) throw new Error(path.basename(file) + ' is not a zip archive.');

    const count = data.readUInt16LE(end + 10);
    let at = data.readUInt32LE(end + 16);
    const entries = [];

    for (let i = 0; i < count; i += 1) {
        if (data.readUInt32LE(at) !== 0x02014b50) break;
        const method = data.readUInt16LE(at + 10);
        const compressed = data.readUInt32LE(at + 20);
        const nameLength = data.readUInt16LE(at + 28);
        const extraLength = data.readUInt16LE(at + 30);
        const commentLength = data.readUInt16LE(at + 32);
        const local = data.readUInt32LE(at + 42);
        const name = data.slice(at + 46, at + 46 + nameLength).toString('utf8');

        entries.push({
            name: name,
            read() {
                const localNameLength = data.readUInt16LE(local + 26);
                const localExtraLength = data.readUInt16LE(local + 28);
                const start = local + 30 + localNameLength + localExtraLength;
                const raw = data.slice(start, start + compressed);
                if (method === 0) return raw;
                if (method === 8) return zlib.inflateRawSync(raw);
                return Buffer.alloc(0);
            }
        });

        at += 46 + nameLength + extraLength + commentLength;
    }

    return { data: data, entries: entries };
}

/** What must never be inside the app, by name. */
const FORBIDDEN_NAMES = [
    /(^|\/)admin-dashboard\.html$/i,
    /(^|\/)admin-login\.html$/i,
    /(^|\/)js\/admin\.js$/i,
    /(^|\/)server\.js$/i,
    /(^|\/)lib\/[^/]+\.js$/i,
    /(^|\/)supabase-setup\.sql$/i,
    /(^|\/)\.env(\.|$)/i,
    /\.private\.md$/i,
    /(^|\/)sw\.js$/i,
    /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i
];

/** What must never be inside the web assets, by content. */
const FORBIDDEN_TEXT = [
    { name: 'a service-role key', pattern: /service_role/ },
    { name: 'a Supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]+/ },
    { name: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'the admin dashboard code', pattern: /initAdminDashboard/ }
];

/** Look inside an APK. Answers a list of problems; empty means fit to install. */
function inspectApk(file) {
    const zip = readZip(file);
    const problems = [];
    const machine = [ROOT, os.homedir()].filter((value) => value && value.length > 3);

    for (const entry of zip.entries) {
        if (FORBIDDEN_NAMES.some((pattern) => pattern.test(entry.name))) {
            problems.push(entry.name + ' must not be in the app.');
        }

        if (!/^assets\/public\/.*\.(html|js|css|json|webmanifest|svg|txt)$/i.test(entry.name)) continue;
        const text = entry.read().toString('utf8');

        for (const rule of FORBIDDEN_TEXT) {
            if (rule.pattern.test(text)) problems.push(entry.name + ' contains ' + rule.name + '.');
        }
        for (const value of machine) {
            if (text.indexOf(value) !== -1 || text.indexOf(value.split(path.sep).join('/')) !== -1) {
                problems.push(entry.name + ' names a path on the machine it was built on.');
            }
        }
    }

    // The whole archive, raw, for a path from this machine written anywhere.
    for (const value of machine) {
        if (zip.data.indexOf(Buffer.from(value, 'utf8')) !== -1 || zip.data.indexOf(Buffer.from(value, 'utf16le')) !== -1) {
            problems.push(path.basename(file) + ' contains a path from the machine it was built on.');
        }
    }

    if (!zip.entries.some((entry) => entry.name === 'assets/public/index.html')) {
        problems.push('The app carries no index.html; the frontend was not copied in.');
    }

    return problems;
}

/**
 * The permissions the finished APK asks for, after every library's manifest
 * has been merged in - which is where a plugin can add one nobody chose.
 * Read with the SDK's own aapt2.
 */
const ALLOWED_PERMISSIONS = [
    'android.permission.INTERNET',
    // Playing music with the app in the background: a media-playback
    // foreground service, and a wake lock held only while something plays.
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.WAKE_LOCK',
    // Declared by ExoPlayer itself, which watches the connection while it
    // streams. A normal permission: it grants no access to anything personal,
    // and it is not requested at runtime.
    'android.permission.ACCESS_NETWORK_STATE',
    'app.spotifie.android.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
];

function mergedPermissions(apk, env) {
    const tools = path.join(env.ANDROID_HOME, 'build-tools');
    const versions = fs.existsSync(tools) ? fs.readdirSync(tools).sort() : [];
    const aapt2 = versions.length ? path.join(tools, versions[versions.length - 1], process.platform === 'win32' ? 'aapt2.exe' : 'aapt2') : null;
    if (!aapt2 || !fs.existsSync(aapt2)) throw new Error('aapt2 was not found in the Android SDK build-tools.');

    const result = spawnSync(aapt2, ['dump', 'permissions', apk], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('aapt2 could not read the APK.');

    return (result.stdout.match(/uses-permission: name='([^']+)'/g) || []).map((line) => line.replace(/.*name='([^']+)'.*/, '$1'));
}

function main() {
    run('node', [path.join('tools', 'buildMobile.js')]);
    run('npx', ['cap', 'sync', 'android']);

    const env = androidEnvironment();
    // Named by its full path: a shell does not always look in the working
    // directory for a command.
    const gradle = path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    run('"' + gradle + '"', ['assembleDebug', '--no-daemon'], { cwd: ANDROID, env: env });

    if (!fs.existsSync(APK)) throw new Error('Gradle finished without producing ' + path.relative(ROOT, APK) + '.');

    const problems = inspectApk(APK);

    const extra = mergedPermissions(APK, env).filter((name) => ALLOWED_PERMISSIONS.indexOf(name) === -1);
    extra.forEach((name) => problems.push('The APK asks for ' + name + ', which Spotifie does not need.'));

    if (problems.length) throw new Error('The APK is not fit to install:\n  - ' + problems.join('\n  - '));

    const size = fs.statSync(APK).size;
    console.log('');
    console.log('Android debug APK built: ' + path.relative(ROOT, APK) + '  ' + (size / (1024 * 1024)).toFixed(1) + ' MB');
    console.log('  Checked: no admin source, no server, no private files, no audio, no secrets, no machine paths.');
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error('Could not build the Android app: ' + err.message);
        process.exit(1);
    }
}

module.exports = {
    readZip,
    inspectApk,
    mergedPermissions,
    androidEnvironment,
    findJdk21,
    ALLOWED_PERMISSIONS,
    FORBIDDEN_NAMES,
    FORBIDDEN_TEXT,
    APK,
    ROOT,
    ANDROID
};
