'use strict';

/**
 * Build the iOS app's frontend, and prepare its Xcode project - everything
 * that can honestly be done without a Mac.
 *
 *   npm run build:ios   the frontend, into mobile/www (Capacitor's webDir, the
 *                       same one the Android app uses): the strict public
 *                       build, no admin source, no server, no service worker,
 *                       a content security policy on every page, inspected.
 *   npm run ios:sync    the above, then `cap sync ios`, then the Xcode project
 *                       is brought in line (bundle id, version) and both the
 *                       web assets it carries and its native settings are
 *                       inspected.
 *
 * What this cannot do: compile, sign, run in the Simulator or on an iPhone, or
 * archive. Those need Xcode on a Mac - see SPOTIFIE_OPERATIONS.private.md. Nothing
 * here creates a signing identity, a certificate, a provisioning profile or a
 * Team ID, and nothing here claims the app builds.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IOS = path.join(ROOT, 'ios', 'App');
const APP_DIR = path.join(IOS, 'App');
const PBXPROJ = path.join(IOS, 'App.xcodeproj', 'project.pbxproj');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

/** The iOS app's identity. Its URL scheme for email links is the same string. */
const BUNDLE_ID = 'app.spotifie.ios';
const URL_SCHEME = BUNDLE_ID;

/** Never in the iOS app's web assets, by name. */
const NEVER_IN_APP = [
    { name: 'an Android package', pattern: /\.(apk|aab)$/i },
    { name: 'the website download area', pattern: /(^|\/)downloads\//i },
    { name: 'native project files', pattern: /(^|\/)(android|ios)\//i },
    { name: 'a private document', pattern: /\.private(\.md)?$/i },
    { name: 'an environment file', pattern: /(^|\/)\.env(\.|$)/i },
    { name: 'signing material', pattern: /\.(p12|p8|cer|mobileprovision|jks|keystore|pem|key)$/i },
    { name: 'the embedded worker document', pattern: /adminDocument\.mjs$/i },
    { name: 'test material', pattern: /(^|\/)test\//i }
];

/** Permissions Spotifie does not use and must never ask for. */
const FORBIDDEN_PLIST_KEYS = [
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSLocationWhenInUseUsageDescription',
    'NSLocationAlwaysAndWhenInUseUsageDescription',
    'NSLocationAlwaysUsageDescription',
    'NSContactsUsageDescription',
    'NSPhotoLibraryUsageDescription',
    'NSPhotoLibraryAddUsageDescription',
    'NSUserTrackingUsageDescription',
    'NSAppleMusicUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSAllowsArbitraryLoads',
    'NSAllowsArbitraryLoadsInWebContent'
];

function walk(directory) {
    const found = [];
    if (!fs.existsSync(directory)) return found;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...walk(full));
        else found.push(full);
    }
    return found;
}

/** x.y.z from package.json's version: CFBundleShortVersionString allows nothing else. */
function marketingVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
    if (!match) throw new Error('package.json version "' + version + '" does not start with x.y.z.');
    return match[1] + '.' + match[2] + '.' + match[3];
}

/**
 * The Xcode project's identity and version, from package.json. The build
 * number (CURRENT_PROJECT_VERSION) is left as it is unless one is given: it
 * must rise with every upload, which only the person uploading knows.
 */
function syncProjectSettings(text, version, buildNumber) {
    let out = text
        .replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, 'PRODUCT_BUNDLE_IDENTIFIER = ' + BUNDLE_ID + ';')
        .replace(/MARKETING_VERSION = [^;]+;/g, 'MARKETING_VERSION = ' + marketingVersion(version) + ';');
    if (buildNumber) {
        if (!/^\d+(\.\d+){0,2}$/.test(String(buildNumber))) throw new Error('The iOS build number must be one to three whole numbers.');
        out = out.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, 'CURRENT_PROJECT_VERSION = ' + buildNumber + ';');
    }
    return out;
}

/** A service-role key hidden inside a JWT does not say so in plain text; its payload does. */
function carriesServiceRoleJwt(text) {
    const tokens = text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
    return tokens.some((token) => {
        try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
            return payload && payload.role === 'service_role';
        } catch (e) {
            return false;
        }
    });
}

/**
 * The web assets an iOS build carries, checked: the release check's rules
 * (private files, secrets, audio), the shells' rules (nothing administrative,
 * no service worker), the iOS app's own (no APK, no native project, no private
 * document, no signing material) and no path from this machine.
 */
function inspectWebAssets(directory) {
    const checker = require('./releaseCheck.js');
    const shell = require('./buildDesktop.js');
    const problems = [];
    const machine = [ROOT, os.homedir()].filter((value) => value && value.length > 3);

    const files = walk(directory);
    if (!files.some((file) => path.basename(file) === 'index.html')) problems.push('There is no index.html: the frontend was not copied in.');

    for (const file of files) {
        const name = path.relative(directory, file).split(path.sep).join('/');

        for (const pattern of checker.FORBIDDEN_PATHS) {
            if (pattern.test(name)) problems.push(name + ' must not be in the iOS app.');
        }
        for (const pattern of shell.NEVER) {
            if (pattern.test(name)) problems.push(name + ' must not be in the iOS app.');
        }
        for (const rule of NEVER_IN_APP) {
            if (rule.pattern.test(name)) problems.push(name + ' is ' + rule.name + ', which the iOS app never carries.');
        }
        if (checker.AUDIO_EXTENSIONS.test(name)) problems.push(name + ' is audio. The app carries no music.');

        if (!/\.(html|js|css|json|webmanifest|svg|txt|xml)$/i.test(name)) continue;
        const text = fs.readFileSync(file, 'utf8');

        for (const rule of checker.FORBIDDEN_CONTENT) {
            if (rule.pattern.test(text)) problems.push(name + ' contains ' + rule.name + '.');
        }
        if (carriesServiceRoleJwt(text)) problems.push(name + ' contains a service-role key.');
        if (/initAdminDashboard/.test(text)) problems.push(name + ' contains the admin dashboard code.');
        for (const value of machine) {
            if (text.indexOf(value) !== -1 || text.indexOf(value.split(path.sep).join('/')) !== -1) {
                problems.push(name + ' names a path on the machine it was built on.');
            }
        }
    }

    return problems;
}

/**
 * The native project, checked for what it asks of iOS and what it declares:
 * no permission Spotifie does not use, no arbitrary HTTP, no tracking, the
 * email-link scheme and background audio present, one bundle id, no Team ID
 * or signing material committed, and the app's own files in the build.
 */
function inspectNativeProject(iosAppDir) {
    const base = iosAppDir || IOS;
    const problems = [];

    const plistPath = path.join(base, 'App', 'Info.plist');
    const plist = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : '';
    if (!plist) problems.push('ios/App/App/Info.plist is missing.');

    FORBIDDEN_PLIST_KEYS.forEach((key) => {
        if (plist.indexOf('<key>' + key + '</key>') !== -1) problems.push('Info.plist declares ' + key + ', which Spotifie does not use.');
    });
    if (!/<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>app\.spotifie\.ios<\/string>/.test(plist)) {
        problems.push('Info.plist does not register the ' + URL_SCHEME + ' scheme that email links return to.');
    }
    if (!/<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>\s*<\/array>/.test(plist)) {
        problems.push('Info.plist does not declare exactly the audio background mode.');
    }
    if (!/<key>CFBundleDisplayName<\/key>\s*<string>Spotifie<\/string>/.test(plist)) problems.push('The app is not named Spotifie.');
    if (/<string>armv7<\/string>/.test(plist)) problems.push('Info.plist still requires armv7.');

    const manifestPath = path.join(base, 'App', 'PrivacyInfo.xcprivacy');
    const manifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
    if (!manifest) problems.push('ios/App/App/PrivacyInfo.xcprivacy is missing.');
    if (!/<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(manifest)) problems.push('The privacy manifest does not say Spotifie does not track.');
    if (!/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/.test(manifest)) problems.push('The privacy manifest names tracking domains.');

    const pbxPath = path.join(base, 'App.xcodeproj', 'project.pbxproj');
    const pbx = fs.existsSync(pbxPath) ? fs.readFileSync(pbxPath, 'utf8') : '';
    const ids = (pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g) || []).map((line) => line.replace(/.*= ([^;]+);/, '$1'));
    if (!ids.length || ids.some((id) => id !== BUNDLE_ID)) problems.push('The Xcode project is not identified as ' + BUNDLE_ID + '.');
    if (/DEVELOPMENT_TEAM = /.test(pbx)) problems.push('The Xcode project names a Team ID; signing is set up on the Mac, not committed.');
    ['MusicFoldersPlugin.swift in Sources', 'SpotifieBridgeViewController.swift in Sources', 'PrivacyInfo.xcprivacy in Resources'].forEach((entry) => {
        if (pbx.indexOf(entry) === -1) problems.push('The Xcode project does not build ' + entry.replace(/ in .*/, '') + '.');
    });

    walk(base).forEach((file) => {
        if (/\.(p12|p8|cer|mobileprovision|jks|keystore)$/i.test(file)) {
            problems.push(path.relative(ROOT, file) + ' is signing material and must not be in the project.');
        }
    });

    return problems;
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: true });
    if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + ').');
}

function buildFrontend() {
    // The shell builder writes wherever this says, so it is set before it loads.
    process.env.SPOTIFIE_DESKTOP_OUT = process.env.SPOTIFIE_MOBILE_OUT
        ? path.resolve(process.env.SPOTIFIE_MOBILE_OUT)
        : path.join(ROOT, 'mobile', 'www');
    const shell = require('./buildDesktop.js');
    try {
        shell.build({ label: 'iOS' });
    } catch (err) {
        fs.rmSync(shell.STAGE, { recursive: true, force: true });
        throw err;
    }
    return shell.OUT;
}

function main() {
    const sync = process.argv.indexOf('--sync') !== -1;

    const out = buildFrontend();
    const webProblems = inspectWebAssets(out);
    if (webProblems.length) throw new Error('The iOS frontend is not fit to package:\n  - ' + webProblems.join('\n  - '));

    if (!sync) {
        console.log('  Checked for iOS: no APK, no native project files, no private documents, no signing material.');
        return;
    }

    if (!fs.existsSync(PBXPROJ)) throw new Error('There is no iOS project. Run: npx cap add ios');

    run('npx', ['cap', 'sync', 'ios']);

    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    fs.writeFileSync(PBXPROJ, syncProjectSettings(fs.readFileSync(PBXPROJ, 'utf8'), version, process.env.SPOTIFIE_IOS_BUILD_NUMBER));

    const problems = inspectWebAssets(PUBLIC_DIR).concat(inspectNativeProject(IOS));
    if (problems.length) throw new Error('The iOS project is not fit to open in Xcode:\n  - ' + problems.join('\n  - '));

    console.log('');
    console.log('iOS project prepared in ios/App (' + BUNDLE_ID + ', version ' + marketingVersion(version) + ').');
    console.log('  Checked: web assets, permissions, privacy manifest, URL scheme, background audio, no signing material.');
    console.log('  Not done here: compiling, signing, the Simulator, a device. Those REQUIRE A MAC (SPOTIFIE_OPERATIONS.private.md).');
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error('Could not prepare the iOS app: ' + err.message);
        process.exit(1);
    }
}

module.exports = {
    BUNDLE_ID,
    URL_SCHEME,
    NEVER_IN_APP,
    FORBIDDEN_PLIST_KEYS,
    marketingVersion,
    syncProjectSettings,
    carriesServiceRoleJwt,
    inspectWebAssets,
    inspectNativeProject
};
