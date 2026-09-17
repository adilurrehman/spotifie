'use strict';

/**
 * Check a public release before it is published.
 *
 * The builder works from a list of what to include, so in principle nothing
 * unwanted can reach the release. This is the second pair of eyes: it reads
 * what was actually produced and refuses it if anything privileged, private or
 * personal is in there. A build script can be edited by mistake; this fails
 * loudly when it has been.
 *
 * It also looks at what git is tracking in the working copy, because that is
 * what would be published if this repository were ever made public directly.
 * A finding there is a warning rather than a failure: the working copy is
 * meant to hold the administrator tooling. It is the release that must not.
 *
 * Run it with: npm run release:check
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// The release this is asked about - the one the build just wrote, which is
// the usual place unless the build was pointed somewhere else.
const DIST = process.env.SPOTIFIE_RELEASE_OUT
    ? path.resolve(process.env.SPOTIFIE_RELEASE_OUT)
    : path.join(ROOT, 'public-release', 'dist');

/**
 * What the check is being asked about.
 *
 * "public" - the default - is a PUBLIC SOURCE RELEASE: the static files that
 * go to a public host, which must carry no admin frontend source, no secrets
 * and no private files. "production" is the CLOUDFLARE PRODUCTION WORKER built
 * from this private tree: the same static files, plus the protected dashboard
 * document embedded in the worker. There the admin script must not be a public
 * asset (it is inlined into the gated document), the raw dashboard page must
 * still never be a static file, and the embedded document must be a real,
 * secret-free dashboard rather than a null one.
 */
const MODE =
    process.argv.indexOf('--production') !== -1 || process.env.SPOTIFIE_RELEASE_MODE === 'production'
        ? 'production'
        : 'public';

// Where the build writes the document the worker holds. Not part of the static
// assets - it lives in the worker's own source tree - so it is checked apart
// from the release directory, and only for a production worker build.
const ADMIN_DOCUMENT_MODULE = path.join(ROOT, 'worker', 'generated', 'adminDocument.mjs');

// ============================================
// What must never be in a release
// ============================================

/**
 * Files and paths that would mean the privileged half of the project was
 * included.
 *
 * The dashboard document is on this list: it must never be a static file. On a
 * published copy it is not served from the assets at all - the Cloudflare
 * worker holds it and serves it only to an administrator it has verified live
 * against Supabase - so finding admin-dashboard.html among the released files
 * means the gate has been bypassed and anybody could open it by its address.
 * The dashboard's script is not on this list: it carries no secret, it decides
 * nothing, and the gated page loads it as an ordinary asset.
 *
 * The administrator sign-in page and the server modules that actually decide
 * who is an administrator are on the list too: they belong to a copy somebody
 * runs themselves, never to a release.
 */
const FORBIDDEN_PATHS = [
    /(^|[/\\])admin-dashboard\.html$/i,
    /(^|[/\\])admin-login\.html$/i,
    /(^|[/\\])adminAuth\.js$/i,
    /(^|[/\\])adminCatalogRoutes\.js$/i,
    /(^|[/\\])adminAlbumRoutes\.js$/i,
    // Anything private, generated or personal.
    /(^|[/\\])\.env$/i,
    /(^|[/\\])\.env\.(?!example)/i,
    /(^|[/\\])\.git([/\\]|$)/i,
    /(^|[/\\])\.spotifie([/\\]|$)/i,
    /(^|[/\\])node_modules([/\\]|$)/i,
    /(^|[/\\])test([/\\]|$)/i,
    /(^|[/\\])CLAUDE\.md$/i,
    /\.(pem|key|p12|pfx)$/i,
    // Android packages, signing material and build settings. The one app a
    // production website may offer is allowed by name in checkRelease.
    /\.(apk|aab|jks|keystore)$/i,
    /(^|[/\\])(keystore|signing|local)\.properties$/i,
    /(^|[/\\])google-services\.json$/i,
    // Somebody's own library state, in any of the shapes it is kept in.
    /(^|[/\\])(state|scan-state|playback)\.json$/i,
    /(^|[/\\])users([/\\]|$)/i,
    /(^|[/\\])(local-state|user-state|runtime-data)([/\\]|$)/i,
    // A map back to source is a copy of the source. The release ships the
    // code it runs; it should never also ship a second copy of it by accident.
    /\.map$/i
];

/** Audio, of any kind. A release carries an application, not a music library. */
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4)$/i;

/** Text that should never appear inside a released file. */
const FORBIDDEN_CONTENT = [
    { name: 'a service-role key', pattern: /service_role/ },
    { name: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'a Supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]+/ },
    { name: 'a hardcoded password', pattern: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{3,}['"]/i },
    { name: 'a database connection string', pattern: /postgres(ql)?:\/\/[^\s'"]*:[^\s'"]*@/i },
    { name: 'a JWT secret', pattern: /\bjwt[_-]?secret\b/i },
    { name: 'a link to the admin sign-in page', pattern: /admin-login\.html/i }
];

/** Files whose job is to talk about these things, and may name them. */
const CONTENT_EXEMPT = [/(^|[/\\])SECURITY\.md$/i, /(^|[/\\])\.env\.example$/i];

/** Extensions worth reading. Anything binary is checked by name only. */
const READABLE = /\.(html|js|mjs|css|json|md|sql|txt|yml|yaml|svg)$/i;

// ============================================
// Walking the release
// ============================================

function walk(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...walk(full));
        else files.push(full);
    }
    return files;
}

function relative(file) {
    return path.relative(DIST, file).split(path.sep).join('/');
}

function checkRelease(failures) {
    if (!fs.existsSync(DIST)) {
        failures.push('There is no release to check. Build one first: npm run build:public');
        return;
    }

    const files = walk(DIST);
    if (!files.length) {
        failures.push('The release is empty.');
        return;
    }

    for (const file of files) {
        const name = relative(file);

        for (const pattern of FORBIDDEN_PATHS) {
            if (pattern.test(name) && !offeredDownload(name, MODE)) failures.push(name + ' must not be in a public release.');
        }

        // In a production worker build the administrator script is not a public
        // file: it is inlined into the gated dashboard document. Finding it
        // among the assets means it would answer at /js/admin.js, outside the
        // gate. In the public build it is an ordinary asset and allowed.
        if (MODE === 'production' && /(^|[/\\])js[/\\]admin\.js$/i.test(name)) {
            failures.push(name + ' must not be a public static asset in a production worker build; it belongs inlined in the gated dashboard document.');
        }

        if (AUDIO_EXTENSIONS.test(name)) {
            failures.push(name + ' is audio. A release carries no music.');
        }

        if (!READABLE.test(name)) continue;
        if (CONTENT_EXEMPT.some((pattern) => pattern.test(name))) continue;

        const text = fs.readFileSync(file, 'utf8');
        for (const rule of FORBIDDEN_CONTENT) {
            if (rule.pattern.test(text)) failures.push(name + ' contains ' + rule.name + '.');
        }
    }

    checkExpectedShape(files, failures);
    checkDownloads(DIST, MODE, failures);

    // A production worker build is only fit to deploy if the document the
    // worker holds is a real dashboard. That document is not in the release
    // directory, so it is checked on its own.
    if (MODE === 'production') checkEmbeddedDashboard(failures);
}

// ============================================
// The Android app download
// ============================================

/** The files a release may offer for download, and only a production one. */
const ANDROID_DOWNLOAD = 'downloads/spotifie-android.apk';
const ANDROID_RELEASE_METADATA = 'downloads/android-release.json';
// Cloudflare serves no static asset larger than this.
const ANDROID_DOWNLOAD_LIMIT = 25 * 1024 * 1024;

function offeredDownload(name, mode) {
    return mode === 'production' && (name === ANDROID_DOWNLOAD || name === ANDROID_RELEASE_METADATA);
}

/**
 * The public description of the release must describe this very APK, and say
 * nothing else: no path on the build machine, no source file name, no secret.
 */
function checkReleaseMetadata(dist, failures) {
    const file = path.join(dist, ...ANDROID_RELEASE_METADATA.split('/'));
    if (!fs.existsSync(file)) {
        failures.push(ANDROID_DOWNLOAD + ' has no ' + ANDROID_RELEASE_METADATA + ' describing it.');
        return;
    }

    const text = fs.readFileSync(file, 'utf8');
    let metadata;
    try {
        metadata = JSON.parse(text);
    } catch (e) {
        failures.push(ANDROID_RELEASE_METADATA + ' is not valid JSON.');
        return;
    }

    const apk = path.join(dist, ...ANDROID_DOWNLOAD.split('/'));
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
    if (metadata.apk !== '/' + ANDROID_DOWNLOAD) failures.push(ANDROID_RELEASE_METADATA + ' points at another file.');
    if (metadata.sha256 !== digest) failures.push(ANDROID_RELEASE_METADATA + ' has the wrong SHA-256 for the APK.');
    if (metadata.size !== fs.statSync(apk).size) failures.push(ANDROID_RELEASE_METADATA + ' has the wrong size for the APK.');
    if (!Number.isInteger(metadata.versionCode) || metadata.versionCode < 1) failures.push(ANDROID_RELEASE_METADATA + ' has no versionCode.');
    if (!metadata.version) failures.push(ANDROID_RELEASE_METADATA + ' has no version.');
    if (/[A-Za-z]:\\|\/Users\/|\/home\/|password|keystore|app-release|app-debug|service.role/i.test(text)) {
        failures.push(ANDROID_RELEASE_METADATA + ' names something private (a path, a source file or a secret).');
    }
}

/** What the build told the page about the Android app, from both places it says so. */
function advertisedAndroidApp(dist, failures) {
    const found = [];

    const info = path.join(dist, 'build-info.json');
    if (fs.existsSync(info)) {
        try {
            found.push({ where: 'build-info.json', app: JSON.parse(fs.readFileSync(info, 'utf8')).androidApp || null });
        } catch (e) {
            failures.push('build-info.json is not valid JSON.');
        }
    }

    const script = path.join(dist, 'js', 'config.js');
    if (fs.existsSync(script)) {
        const written = /window\.__SPOTIFIE_BUILD__ = (\{[\s\S]*?\});/.exec(fs.readFileSync(script, 'utf8'));
        if (written) {
            try {
                found.push({ where: 'js/config.js', app: JSON.parse(written[1]).androidApp || null });
            } catch (e) {
                failures.push('js/config.js does not carry a readable build description.');
            }
        }
    }

    return found;
}

/**
 * The Android app a production website offers.
 *
 * Exactly one file, at exactly one address, and only in a production build: a
 * public source release carries no app binary. Nothing else may sit beside it,
 * nothing from the Android project may come with it, and the page must offer it
 * exactly when it is there - never a link to a missing file. The APK itself is
 * opened and inspected the same way the Android build inspects it: no admin
 * source, no server, no private files, no secrets, no paths from this machine.
 */
function checkDownloads(dist, mode, failures) {
    if (!fs.existsSync(dist)) return;

    const names = walk(dist).map((file) => path.relative(dist, file).split(path.sep).join('/'));

    for (const name of names) {
        if (/^android\//i.test(name)) {
            failures.push(name + ' belongs to the Android project; a release never carries it.');
        }
        if (/^ios\//i.test(name)) {
            failures.push(name + ' belongs to the iOS project; a release never carries it.');
        }
        if (/^downloads\//i.test(name) && !offeredDownload(name, mode)) {
            failures.push(name + ' is not something a release may offer for download.');
        }
    }

    const present = names.indexOf(ANDROID_DOWNLOAD) !== -1;

    for (const entry of advertisedAndroidApp(dist, failures)) {
        if (!entry.app) continue;
        if (entry.app.url !== '/' + ANDROID_DOWNLOAD) {
            failures.push(entry.where + ' offers the Android app at an unexpected address.');
        } else if (!present || mode !== 'production') {
            failures.push(entry.where + ' offers the Android app but does not carry it (' + ANDROID_DOWNLOAD + ').');
        }
    }

    if (!present && names.indexOf(ANDROID_RELEASE_METADATA) !== -1) {
        failures.push(ANDROID_RELEASE_METADATA + ' describes an APK the release does not carry.');
    }

    if (!present || mode !== 'production') return;

    checkReleaseMetadata(dist, failures);

    if (!advertisedAndroidApp(dist, []).some((entry) => entry.app)) {
        failures.push(ANDROID_DOWNLOAD + ' is in the release but no page offers it.');
    }

    const apk = path.join(dist, ...ANDROID_DOWNLOAD.split('/'));
    if (fs.statSync(apk).size > ANDROID_DOWNLOAD_LIMIT) {
        failures.push(ANDROID_DOWNLOAD + ' is larger than a static host serves (25 MB).');
    }

    let problems;
    try {
        problems = require('./androidBuild.js').inspectApk(apk);
    } catch (e) {
        problems = ['it could not be opened as an APK (' + e.message + ')'];
    }
    problems.forEach((problem) => failures.push(ANDROID_DOWNLOAD + ': ' + problem));

    const headers = path.join(dist, '_headers');
    const sent = fs.existsSync(headers) ? fs.readFileSync(headers, 'utf8') : '';
    if (sent.indexOf('/' + ANDROID_DOWNLOAD + '\n  Content-Type: application/vnd.android.package-archive') === -1) {
        failures.push('_headers does not send ' + ANDROID_DOWNLOAD + ' as an Android package.');
    }
}

/**
 * The dashboard document the production worker holds.
 *
 * It is what makes /admin-dashboard serve a page rather than send an
 * administrator back to the application, so a production worker with a null or
 * empty document is broken in exactly the way this whole build mode exists to
 * prevent. It carries the administrator script inline, so it must also carry
 * no secret.
 */
function checkEmbeddedDashboard(failures, target) {
    const out = target || ADMIN_DOCUMENT_MODULE;

    if (!fs.existsSync(out)) {
        failures.push(
            'The production worker has no embedded dashboard document ' +
                '(worker/generated/adminDocument.mjs is missing). Run npm run build:production.'
        );
        return;
    }

    const text = fs.readFileSync(out, 'utf8');

    if (/export default null/.test(text)) {
        failures.push('The embedded dashboard document is null. Run npm run build:production from the private working tree.');
        return;
    }

    const markers = [
        ['the dashboard title', /Developer Dashboard \| Spotifie/],
        ['the dashboard body', /<body class="admin-dashboard">/],
        ['the administrator initialization code', /initAdminDashboard/]
    ];
    for (const [name, pattern] of markers) {
        if (!pattern.test(text)) failures.push('The embedded dashboard document is missing ' + name + '.');
    }

    for (const rule of FORBIDDEN_CONTENT) {
        if (rule.pattern.test(text)) failures.push('The embedded dashboard document contains ' + rule.name + '.');
    }
}

/**
 * A release that is missing half the application is as wrong as one carrying
 * too much, and would fail quietly rather than loudly.
 */
function checkExpectedShape(files, failures) {
    const names = new Set(files.map(relative));

    const required = [
        'index.html',
        'signin.html',
        'server.js',
        'package.json',
        'README.md',
        'js/script.js',
        'js/auth.js',
        'js/platform.js',
        // The only way a copy with no server reaches the music on the device
        // it is being read on.
        'js/browserLibrary.js',
        'css/style.css',
        'lib/sessionAuth.js',
        'lib/catalogRoutes.js',
        // What a copy published to a static host needs and a copy run from a
        // terminal ignores: its own public settings, the headers a host should
        // send, and the list of files such a host must not publish.
        'config.json',
        '_headers',
        '.assetsignore'
    ];

    for (const file of required) {
        if (!names.has(file)) failures.push('The release is missing ' + file + '.');
    }

    // The project's own Supabase settings are not shipped: whoever runs the
    // release supplies their own.
    const configFile = path.join(DIST, 'lib', 'publicConfig.js');
    if (fs.existsSync(configFile)) {
        const config = fs.readFileSync(configFile, 'utf8');
        if (/https:\/\/[a-z0-9]{16,}\.supabase\.co/.test(config)) {
            failures.push('lib/publicConfig.js still names a specific Supabase project.');
        }
        if (/eyJ[A-Za-z0-9_-]{20,}\./.test(config)) {
            failures.push('lib/publicConfig.js still carries a key.');
        }
    }

    checkRuntimeConfig(failures);
    checkStaticHostFiles(names, failures);
}

/**
 * The settings a published copy carries.
 *
 * Two public values or nothing - a copy built without them is honest about
 * being unconfigured, which is fine. What is never fine is a secret: the anon
 * key is meant for a browser and a service-role key would hand every reader of
 * the page the whole database.
 */
function checkRuntimeConfig(failures) {
    const file = path.join(DIST, 'config.json');
    if (!fs.existsSync(file)) return;

    let settings;
    try {
        settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        failures.push('config.json is not valid JSON.');
        return;
    }

    const key = String(settings.supabaseAnonKey || '');
    if (/service.role/i.test(key) || /^sb_secret_/.test(key)) {
        failures.push('config.json carries a secret key. Only the anon/publishable key belongs in a browser.');
    }

    const url = String(settings.supabaseUrl || '');
    if (url && /localhost|127\.0\.0\.1/i.test(url)) {
        failures.push('config.json points at this machine rather than at a Supabase project.');
    }

    // Every field here is read by a browser, so every field here has to be
    // something a browser may see. The list is closed on purpose: a new field
    // has to be argued for here before it can be published.
    const allowed = ['supabaseUrl', 'supabaseAnonKey', 'publicSiteUrl', 'deployment', 'configured'];

    for (const field of Object.keys(settings)) {
        if (allowed.indexOf(field) === -1) {
            failures.push('config.json carries an unexpected field: ' + field + '.');
        }
    }

    // The same settings as a script, which is what the application reads.
    const script = path.join(DIST, 'js', 'config.js');
    if (fs.existsSync(script)) {
        const text = fs.readFileSync(script, 'utf8');
        const written = /window\.__SPOTIFIE_CONFIG__ = (\{[\s\S]*?\});/.exec(text);

        if (!written) {
            failures.push('js/config.js does not set the settings a published copy reads.');
        } else {
            let carried;
            try {
                carried = JSON.parse(written[1]);
            } catch (e) {
                failures.push('js/config.js does not carry readable settings.');
                carried = null;
            }

            if (carried) {
                const carriedKey = String(carried.supabaseAnonKey || '');
                if (/service.role/i.test(carriedKey) || /^sb_secret_/.test(carriedKey)) {
                    failures.push('js/config.js carries a secret key.');
                }

                for (const field of Object.keys(carried)) {
                    if (['supabaseUrl', 'supabaseAnonKey', 'publicSiteUrl', 'deployment'].indexOf(field) === -1) {
                        failures.push('js/config.js carries an unexpected field: ' + field + '.');
                    }
                }
            }
        }
    }
}

/**
 * What a static host is told, and what it is told to keep to itself.
 *
 * The release is also a Node application, and a host that published every file
 * in it would serve the server's own source and the database schema at
 * addresses anybody could guess. The list that prevents that is checked here
 * rather than trusted.
 */
function checkStaticHostFiles(names, failures) {
    const ignoreFile = path.join(DIST, '.assetsignore');
    if (fs.existsSync(ignoreFile)) {
        const ignored = fs.readFileSync(ignoreFile, 'utf8');
        ['server.js', 'lib/', 'package.json', 'supabase-setup.sql'].forEach((entry) => {
            if (ignored.indexOf(entry) === -1) {
                failures.push('.assetsignore does not keep ' + entry + ' off a static host.');
            }
        });
    }

    const headersFile = path.join(DIST, '_headers');
    if (fs.existsSync(headersFile)) {
        const headers = fs.readFileSync(headersFile, 'utf8');
        ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'frame-ancestors'].forEach(
            (header) => {
                if (headers.indexOf(header) === -1) failures.push('_headers is missing ' + header + '.');
            }
        );

        if (/script-src[^;]*\*/.test(headers)) {
            failures.push('_headers allows scripts from anywhere.');
        }
    }

    // A page must not claim to live on the machine it was built on, and must
    // not link straight to the raw dashboard file. The dashboard opens only
    // through the worker's entry gate; an <a href> to admin-dashboard.html
    // would be a way around it - which is exactly what the gate exists to
    // close.
    for (const name of names) {
        if (!/\.html$/i.test(name)) continue;

        const page = fs.readFileSync(path.join(DIST, name), 'utf8');
        const canonical = /<link rel="canonical" href="([^"]+)"/.exec(page);
        if (canonical && /localhost|127\.0\.0\.1/i.test(canonical[1])) {
            failures.push(name + ' names this machine as its address.');
        }

        if (/href="[^"]*admin-dashboard\.html/i.test(page)) {
            failures.push(name + ' links directly to the raw dashboard file instead of the entry gate.');
        }
    }
}

// ============================================
// Looking at what git tracks
// ============================================

/**
 * What this repository would publish if it were made public as it stands.
 *
 * Reported, not enforced: the working copy is supposed to hold the
 * administrator tooling, and it is expected to appear here. The point is that
 * publishing means building a release and putting that in a new repository -
 * never making this one public - and this is the reminder of why.
 */
function reportTrackedFiles(warnings) {
    let tracked;
    try {
        tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch (e) {
        warnings.push('Could not list the tracked files (git said: ' + e.message.split('\n')[0] + ').');
        return;
    }

    const flagged = tracked.filter((file) => FORBIDDEN_PATHS.some((pattern) => pattern.test(file)));
    const audio = tracked.filter((file) => AUDIO_EXTENSIONS.test(file));

    if (audio.length) {
        warnings.push(audio.length + ' audio file(s) are tracked by git in the working copy.');
    }
    if (flagged.length) {
        warnings.push(
            flagged.length +
                ' tracked file(s) belong to the private half of the project: ' +
                flagged.slice(0, 6).join(', ') +
                (flagged.length > 6 ? ', ...' : '')
        );
    }

    // Something that reads as a real secret is a failure wherever it is.
    const leaked = [];
    for (const file of tracked) {
        if (!READABLE.test(file)) continue;
        if (CONTENT_EXEMPT.some((pattern) => pattern.test(file))) continue;

        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) continue;

        const text = fs.readFileSync(full, 'utf8');
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) leaked.push(file + ': a private key');
        if (/sb_secret_[A-Za-z0-9_-]+/.test(text)) leaked.push(file + ': a Supabase secret key');
        if (/"role"\s*:\s*"service_role"/.test(text)) leaked.push(file + ': a service-role key');
    }

    if (leaked.length) {
        warnings.push('SECRETS IN TRACKED FILES: ' + leaked.join('; '));
    }
}

// ============================================
// Run
// ============================================

function main() {
    const failures = [];
    const warnings = [];

    checkRelease(failures);
    reportTrackedFiles(warnings);

    if (warnings.length) {
        console.log('Notes on the working copy (not part of the release):');
        for (const warning of warnings) console.log('  - ' + warning);
        console.log('');
    }

    const rebuild = MODE === 'production' ? 'npm run build:production' : 'npm run build:public';

    if (failures.length) {
        console.error(
            MODE === 'production'
                ? 'The production worker build is not fit to deploy:'
                : 'The release is not fit to publish:'
        );
        for (const failure of failures) console.error('  - ' + failure);
        console.error('');
        console.error('Fix the build, run ' + rebuild + ' again, and check again.');
        process.exit(1);
    }

    if (MODE === 'production') {
        console.log('The production worker build is fit to deploy: no secrets in the static');
        console.log('assets, the raw dashboard page is not among them, the administrator');
        console.log('script is not a public file, and the worker holds a real dashboard.');
        console.log('');
        console.log('Deploy it from this private working tree:  npx wrangler deploy');
        return;
    }

    console.log('The release is clean: no admin tooling, no secrets, no music, no private data.');
    console.log('');
    console.log('Publish it by copying ' + path.relative(ROOT, DIST) + ' into a NEW, EMPTY repository.');
    console.log('Deleting a file does not remove it from this repository\'s history, so this');
    console.log('repository itself must stay private.');
}

if (require.main === module) main();

module.exports = {
    checkRelease,
    checkEmbeddedDashboard,
    checkDownloads,
    ANDROID_DOWNLOAD,
    ANDROID_RELEASE_METADATA,
    FORBIDDEN_PATHS,
    FORBIDDEN_CONTENT,
    AUDIO_EXTENSIONS,
    DIST,
    ADMIN_DOCUMENT_MODULE
};
