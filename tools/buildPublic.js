'use strict';

/**
 * Build the public release.
 *
 * Spotifie is developed with its administrator tooling in the same working
 * tree: the dashboard, the routes that publish to the shared catalogue, and
 * the module that decides who is allowed to use them. None of that belongs in
 * a copy handed to the public, and neither does anything this machine happens
 * to hold - music, indexes, state, a filled-in .env.
 *
 * So the release is built from a list of what goes in, never by copying
 * everything and then deleting what should not have been copied. A list of
 * exclusions has to be right about every file that will ever exist here,
 * including the ones added after it was written; a list of inclusions only has
 * to be right about the application. A file nobody named is simply not there.
 *
 * What comes out is a directory that runs the user-facing application on its
 * own: the pages, the assets, the server, and the shared half of the library
 * and catalogue code. What is left behind has no route to reach - the server
 * modules that check administrators and perform privileged writes are absent,
 * so the released server has no privileged endpoints to expose at all.
 *
 * The dashboard page and its script are included, and grant nothing by being
 * there: both ask the database whether the account reading them is an
 * administrator, and every write they attempt is refused again by the
 * row-level policies. The administrator sign-in page is not included - it
 * belongs to a copy somebody runs themselves.
 *
 * Run it with: npm run build:public
 * Then check it with: npm run release:check
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Where the release is written. One place, unless somebody names another:
// the test suite builds several releases at once and each one needs its own
// directory, because a build starts by emptying the one it is given.
const OUT = process.env.SPOTIFIE_RELEASE_OUT
    ? path.resolve(process.env.SPOTIFIE_RELEASE_OUT)
    : path.join(ROOT, 'public-release', 'dist');

/**
 * The Android app a production website offers for download.
 *
 * Only the signed RELEASE APK, built and verified by `npm run android:release`,
 * and only with the verification record that tool writes beside it: the record
 * must match the file byte for byte, and the certificate that signed it must be
 * the release certificate pinned in android/release-signing.json. A debug build
 * is never offered and never substituted. Without a release APK that passes all
 * of that, the site builds and simply offers no download.
 *
 * Only a production build copies it, only these files, and nothing else from
 * the Android project - its build tree, its settings, any signing material - is
 * ever read here.
 */
const ANDROID_RELEASE_APK = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const ANDROID_RELEASE_RECORD = 'spotifie-release.json';
const ANDROID_SIGNING_PIN = path.join(ROOT, 'android', 'release-signing.json');
const ANDROID_DOWNLOAD = 'downloads/spotifie-android.apk';
const ANDROID_RELEASE_METADATA = 'downloads/android-release.json';
// Cloudflare serves no static asset larger than this.
const ANDROID_DOWNLOAD_LIMIT = 25 * 1024 * 1024;

/**
 * Which build this is.
 *
 * "public" is the default and the sanitized one: the release that goes to the
 * public GitHub repository and to Cloudflare's GitHub-triggered build. It
 * carries no administrator dashboard, and a checkout without the private admin
 * source simply builds one with none - the worker then serves no dashboard at
 * all, which is correct for an app-only copy.
 *
 * "production" is the Cloudflare Worker deployed by hand from this private
 * working tree. It requires the private admin source, refuses to build without
 * it, embeds the dashboard document into the worker with its script inlined,
 * and never publishes the script as an ordinary asset. It is selected with the
 * --production flag or SPOTIFIE_BUILD_MODE=production.
 */
function detectMode() {
    if (process.argv.indexOf('--production') !== -1) return 'production';
    return process.env.SPOTIFIE_BUILD_MODE === 'production' ? 'production' : 'public';
}

// The mode the running build was asked for, so the settings check knows how
// strict to be. Set at the start of every build().
let buildModeInUse = 'public';

// A public build that is going to be packaged (the desktop frontend) is held
// to the same rules as a deploying one. Set at the start of every build().
let strictRequested = false;

/**
 * Settings that were never filled in.
 *
 * Copied templates and half-finished environments leave tell-tale values
 * behind - a PASTE_ prefix, "your-project-ref", an example.com host. A build
 * that ships one produces an application that cannot sign anybody in and
 * says nothing useful about why. Only the names are returned; a value is
 * never repeated back, placeholder or not.
 */
const PLACEHOLDER_TEXT = /PASTE_|YOUR[_-]|PLACEHOLDER|CHANGE_?ME|REPLACE_?ME|<[^>]*>|\bx{3,}\b|your-project-ref/i;
const EXAMPLE_HOST = /(^|\.)example\.(com|org|net)$|(^|\.)example$|^example\.|\.(test|invalid|localhost)$|^localhost$|^127\.|^0\.0\.0\.0$|^\[?::1\]?$/i;

function placeholderProblems(values) {
    const settings = values || {};
    const problems = [];

    const badUrl = (value) => {
        if (!value) return false;
        if (PLACEHOLDER_TEXT.test(value)) return true;

        let parsed;
        try {
            parsed = new URL(value);
        } catch (e) {
            return true;
        }

        if (parsed.protocol !== 'https:') return true;
        return EXAMPLE_HOST.test(parsed.hostname);
    };

    if (badUrl(settings.SUPABASE_URL)) problems.push('SUPABASE_URL');

    const key = settings.SUPABASE_ANON_KEY;
    if (key && (PLACEHOLDER_TEXT.test(key) || key.length < 20)) problems.push('SUPABASE_ANON_KEY');

    if (badUrl(settings.PUBLIC_SITE_URL)) problems.push('PUBLIC_SITE_URL');

    return problems;
}

// ============================================
// What goes in
// ============================================

/**
 * Pages a visitor can open, as ordinary static files.
 *
 * admin-login.html is deliberately not here: it belongs to a copy somebody
 * runs themselves, and this being a list of what to include is what makes that
 * a fact rather than something to remember.
 *
 * admin-dashboard.html is deliberately not here either, and for a different
 * reason. It is not a page a visitor may simply open by its address - it is
 * served by the Cloudflare worker only to an administrator who has just proven
 * it, so it is held inside the worker (see writeAdminDocument) rather than
 * published as a file anybody could request. What stays a plain file is its
 * script and stylesheets, which carry no secret; the page that ties them
 * together is the part that is gated.
 */
const PAGES = [
    'index.html',
    'about.html',
    'developer.html',
    'signin.html',
    'signup.html',
    'forgot-password.html',
    'reset-password.html',
    // Deleting an account, from a page that needs nothing installed. Google
    // Play requires this of any app that lets somebody create an account, and
    // it has to work for a person who has already removed the app.
    'delete-account.html'
];

/** Browser code the pages load. */
const BROWSER_SCRIPTS = [
    // The dashboard's own script. The gated page the worker serves loads it,
    // and it carries no secret - it asks the database whether the account
    // reading it is an administrator and sends everybody else away, decides
    // nothing itself, and the row-level policies refuse every write it attempts
    // on behalf of an account the database does not trust. So it is an ordinary
    // public asset; the page that uses it is the part held back and gated.
    'js/admin.js',
    // What this copy is - a checkout, or something published. Read before
    // anything asks an origin for an API it may not have.
    'js/deployment.js',
    // What this installation can do, asked rather than assumed. Loaded before
    // anything that reads the answer.
    'js/platform.js',
    // The published catalogue, read straight from Supabase by a copy that has
    // no server to assemble it.
    'js/cloudCatalog.js',
    // The music on this device, read by the browser when somebody hands it
    // a folder. The only way to it in a copy with no server.
    'js/browserLibrary.js',
    'js/script.js',
    'js/auth.js',
    'js/catalogClient.js',
    'js/catalogCache.js',
    'js/personalClient.js',
    'js/libraryClient.js',
    'js/libraryDB.js',
    // Whether this is running inside the desktop shell, and what the shell
    // offers. Loaded before the platform, which asks it.
    'js/desktopNative.js',
    // Installing, updating and the offline word in the header.
    'js/pwa.js',
    // The Android app's own playback engine, so the music keeps playing in the
    // background and appears on the lock screen. Loaded before the player,
    // which picks its engine once.
    'js/androidPlayback.js',
    // Local Music in the phone apps: the library both native shells share.
    'js/nativeLibrary.js',
    // Whether this is the Android app, and the phone's folders when it is.
    'js/androidNative.js',
    // Whether this is the iOS app, and what the person chose in Files when it is.
    'js/iosNative.js',
    // A deliberate long press, for an album's options on a touch screen.
    'js/longPress.js',
    // Asking for an account to be deleted. Shared by the page on the website
    // and the action inside the app, so both ask in exactly one way.
    'js/deleteAccount.js'
];

/**
 * The dashboard, and the script that drives it.
 *
 * Present together or not at all, and only when this working copy has them:
 * they live in the private half of the project, so a checkout without them
 * builds a release with no dashboard to serve and no link to one. The page
 * itself never becomes a public file - it is held inside the worker - but its
 * script is an ordinary asset, so both must be present for either to matter.
 */
const ADMIN_FILES = ['admin-dashboard.html', 'js/admin.js'];

// Where the built dashboard document is written for the worker to hold. The
// worker imports this exact path; the build writes it (or a module that
// exports null when there is no dashboard to serve).
const ADMIN_DOCUMENT_MODULE = path.join(ROOT, 'worker', 'generated', 'adminDocument.mjs');

const STYLES = ['css/style.css', 'css/auth.css', 'css/utlity.css'];

/** Whole directories of assets, copied as they are. */
const ASSET_DIRECTORIES = ['img', 'favicons'];

/**
 * The server, and the half of the library it needs.
 *
 * adminAuth.js, adminCatalogRoutes.js and adminAlbumRoutes.js are absent by
 * design. server.js and catalogRoutes.js look for those files and, not finding
 * them, build themselves without the privileged routes.
 */
const SERVER_FILES = [
    'server.js',
    'lib/config.js',
    'lib/safeFs.js',
    // What the release says about itself to a search engine, a shared link and
    // anything reading documentation. It describes the application and never
    // an installation: without PUBLIC_SITE_URL it claims no address at all.
    'lib/siteMeta.js',
    'lib/publicConfig.js',
    'lib/sessionAuth.js',
    'lib/libraryIndex.js',
    'lib/libraryService.js',
    'lib/libraryRoutes.js',
    'lib/adapters/localFileSystemAdapter.js',
    'lib/catalogService.js',
    'lib/catalogRoutes.js',
    'lib/globalCatalog.js',
    'lib/supabaseRest.js',
    'lib/userState.js',
    'lib/libraryBackup.js',
    'lib/userArtwork.js',
    'lib/userMedia.js',
    'lib/mediaTickets.js',
    'lib/deviceScan.js',
    'lib/deviceLibrary.js',
    'lib/deviceWatcher.js',
    'lib/playbackProgress.js'
];

/** Project files a person needs in order to run and understand the release. */
const PROJECT_FILES = ['package-lock.json', '.env.example', '.gitignore', 'LICENSE'];

// The scripts a public copy can actually run: no build and no release check,
// because there is nothing further to build from it.
const PUBLIC_SCRIPTS = ['start', 'test', 'check'];

// ============================================
// Copying
// ============================================

function ensureDirectory(target) {
    fs.mkdirSync(target, { recursive: true });
}

function copyFile(relative, options) {
    const settings = options || {};
    const from = path.join(ROOT, relative);

    if (!fs.existsSync(from)) {
        if (settings.optional) return false;
        throw new Error('Missing file named in the release list: ' + relative);
    }

    const to = path.join(OUT, relative);
    ensureDirectory(path.dirname(to));

    if (settings.transform) {
        fs.writeFileSync(to, settings.transform(fs.readFileSync(from, 'utf8')));
    } else {
        fs.copyFileSync(from, to);
    }

    return true;
}

/** Copy a whole directory of assets. Nothing here is generated or private. */
function copyDirectory(relative) {
    const from = path.join(ROOT, relative);
    if (!fs.existsSync(from)) return;

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const child = relative + '/' + entry.name;
        if (entry.isDirectory()) {
            copyDirectory(child);
        } else if (entry.isFile()) {
            copyFile(child);
        }
    }
}

// ============================================
// The few things that are rewritten on the way out
// ============================================

/**
 * Take the dashboard link out of the page.
 *
 * Only when the dashboard itself is not being published - a checkout that does
 * not carry the private half of the project. A link to a page that is not
 * there is worse than no link: it is hidden until the database says the
 * account is an administrator, and then it leads nowhere.
 */
function stripDashboardLink(html) {
    const start = html.indexOf('<!-- The dashboard, shown only once the database');
    if (start === -1) return html;

    const closing = html.indexOf('</button>', start);
    if (closing === -1) return html;

    const end = closing + '</button>'.length;
    const lineStart = html.lastIndexOf('\n', start) + 1;
    let lineEnd = html.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = html.length;

    return html.slice(0, lineStart) + html.slice(lineEnd + 1);
}

/**
 * Write the dashboard document into the worker.
 *
 * The dashboard is the one page that is not a public file: the worker holds it
 * and serves it only to a proven administrator. So it is emitted here as a
 * module the worker imports, rather than copied into the assets a static host
 * would answer for anybody. A build with no dashboard writes a module that
 * exports null, and the worker treats that as "there is no dashboard here" -
 * which is what a checkout without the private half produces.
 *
 * The document's own references to scripts, styles and images are rewritten to
 * absolute paths on the way in. Served from /admin-dashboard rather than from a
 * file, a relative reference could resolve against the wrong base; an absolute
 * one names the asset the same way wherever the page is served.
 *
 * Skipped when the build is aimed at a directory other than the default one:
 * that is the test suite building throwaway releases, and it has no worker to
 * feed and no business rewriting a file in the working tree.
 */
function writeAdminDocument(present, mode, target) {
    const out = target || ADMIN_DOCUMENT_MODULE;

    // A build aimed at a throwaway directory is the test suite, and it has no
    // worker to feed - so it does not rewrite the working tree's module. The
    // production build is never a throwaway build, and always writes the real
    // document the worker it is about to deploy will hold.
    if (mode !== 'production' && process.env.SPOTIFIE_RELEASE_OUT) return;

    ensureDirectory(path.dirname(out));

    if (!present) {
        // No dashboard to serve. The worker reads this as "there is no
        // dashboard here" and sends every request for it back to the
        // application. Production never reaches this: build() has already
        // refused a production build with no admin source.
        fs.writeFileSync(out, 'export default null;\n');
        return;
    }

    let html = fs
        .readFileSync(path.join(ROOT, 'admin-dashboard.html'), 'utf8')
        // Named the same way wherever the page is served from.
        .replace(/\b(src|href)="(js|css|img|favicons)\//g, '$1="/$2/');

    if (mode === 'production') {
        // The dashboard's own script is not a public file in production: it is
        // written into the document here, inside the page the worker holds, so
        // the gate is the only way to it and /js/admin.js is answered by
        // nothing. The public build leaves the reference alone and ships the
        // script as an ordinary asset instead.
        const script = fs.readFileSync(path.join(ROOT, 'js', 'admin.js'), 'utf8');
        html = inlineAdminScript(html, script);
    }

    // Held as a template literal, so the three sequences that would end one
    // early or start an interpolation are escaped. Nothing else is changed.
    const escaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

    const module = [
        '// Generated by the Spotifie release build. Do not edit.',
        '//',
        '// The administrator dashboard document, held inside the worker so it is',
        '// served only to a proven administrator and never answered as a public',
        '// file. Regenerated on every build from admin-dashboard.html; in a',
        '// production build the administrator script is inlined so it, too, is',
        '// reachable only through the gate.',
        'export default `' + escaped + '`;',
        ''
    ].join('\n');

    fs.writeFileSync(out, module);
}

/**
 * The tags only an address can give a page - canonical, og:url, the social
 * image - and its structured record, written in at build time.
 *
 * The local server writes these in as each page is served; a static host has
 * no server to do it, so without this a published copy had none. They follow
 * PUBLIC_SITE_URL exactly as the server's do: without it only the structured
 * record goes in, and nothing claims an address.
 */
function withSiteMeta(html, page) {
    const siteMeta = require(path.join(ROOT, 'lib', 'siteMeta.js'));
    return siteMeta.injectInto(html, page === 'index.html' ? '/' : '/' + page);
}

/** robots.txt, llms.txt and, when there is an address, sitemap.xml. */
function writeDiscoveryFiles() {
    const siteMeta = require(path.join(ROOT, 'lib', 'siteMeta.js'));

    fs.writeFileSync(path.join(OUT, 'robots.txt'), siteMeta.robotsTxt());
    fs.writeFileSync(path.join(OUT, 'llms.txt'), siteMeta.llmsTxt());

    const sitemap = siteMeta.sitemapXml();
    if (sitemap) fs.writeFileSync(path.join(OUT, 'sitemap.xml'), sitemap);
}

/**
 * Put js/admin.js inside the dashboard document, replacing the external
 * reference the page carries.
 *
 * A closing </script> anywhere in the script would end the inline tag early,
 * so those are neutralised; the script itself is otherwise untouched. If the
 * reference is not there to replace - the page changed shape - this fails
 * rather than silently shipping a dashboard that still asks for a file the
 * production worker does not publish.
 */
function inlineAdminScript(html, script) {
    const inline = '<script>\n' + script.replace(/<\/(script)/gi, '<\\/$1') + '\n</script>';
    const next = html.replace(/<script src="\/js\/admin\.js"><\/script>/, inline);

    if (next === html || next.indexOf('src="/js/admin.js"') !== -1) {
        throw new Error('Could not inline js/admin.js into the production dashboard document.');
    }

    return next;
}

/**
 * A production build must carry the dashboard, so it stops at the door if the
 * private admin source is not here rather than emitting a null document and
 * deploying a worker that serves no dashboard at all.
 */
function requireProductionSource(dashboard, mode) {
    if (mode === 'production' && !dashboard) {
        throw new Error('Private admin source is required for production deployment.');
    }
}

/**
 * After a production build, prove the worker actually got a dashboard.
 *
 * A null document, or one missing the markers that make it the dashboard - its
 * title, its body, the administrator code that drives it - means the build
 * produced something that would deploy and then serve nothing. It also must
 * carry no secret, because in production the administrator script is inside it.
 */
function assertAdminDocument(target) {
    const out = target || ADMIN_DOCUMENT_MODULE;

    if (!fs.existsSync(out)) {
        throw new Error('The production build did not write the worker dashboard document.');
    }

    const text = fs.readFileSync(out, 'utf8');

    if (/export default null/.test(text)) {
        throw new Error('The production dashboard document is null. Private admin source is required for production deployment.');
    }

    const markers = [
        { name: 'the dashboard title', pattern: /Developer Dashboard \| Spotifie/ },
        { name: 'the dashboard body', pattern: /<body class="admin-dashboard">/ },
        { name: 'the administrator initialization code', pattern: /initAdminDashboard/ }
    ];

    const missing = markers.filter((marker) => !marker.pattern.test(text)).map((marker) => marker.name);
    if (missing.length) {
        throw new Error('The production dashboard document is missing ' + missing.join(', ') + '.');
    }

    const secrets = [
        { name: 'a service-role key', pattern: /service_role/ },
        { name: 'a Supabase secret key', pattern: /sb_secret_[A-Za-z0-9_-]+/ },
        { name: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
    ];

    const leaked = secrets.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
    if (leaked.length) {
        throw new Error('The production dashboard document contains ' + leaked.join(', ') + '.');
    }
}


/**
 * Point the release at nothing in particular.
 *
 * The working copy carries this project's own Supabase settings as a fallback,
 * so it runs without a .env. Those are public, browser-safe values - a project
 * URL and an anon key - but they name one specific project, and a public copy
 * should not arrive pointed at somebody else's. Whoever runs it supplies their
 * own, the way .env.example says.
 */
function neutralisePublicConfig(source) {
    return source
        .replace(/process\.env\.SUPABASE_URL \|\|\s*'[^']*'/, "process.env.SUPABASE_URL || ''")
        .replace(/process\.env\.SUPABASE_ANON_KEY \|\|\s*'[^']*'/, "process.env.SUPABASE_ANON_KEY || ''");
}

/**
 * The public settings, written where a static host can serve them.
 *
 * A published copy has no server to ask for these, so they are written beside
 * the application as a file. Only the two values a browser is meant to have:
 * the project URL and the anon key, both public by design and both already
 * visible to anyone who opens the network tab of a working Spotifie.
 *
 * Taken from the environment the build runs in, never from this project's own
 * settings - the release is somebody else's copy, and it should carry their
 * project or nothing. A build with neither writes a file saying so, which is
 * what makes the application report "not configured" rather than fail in a way
 * nobody can act on.
 *
 * A service-role key is never read here, never written here, and would be
 * refused by the release check if it somehow arrived.
 */
let publicSettingsRead = null;

function publicSettings() {
    // Read once. The same settings are written twice, as a script and as data,
    // and a build that is missing them should say so once rather than twice.
    if (publicSettingsRead) return publicSettingsRead;
    publicSettingsRead = readPublicSettings();
    return publicSettingsRead;
}

function readPublicSettings() {
    const url = (process.env.SUPABASE_URL || '').trim();
    const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
    const siteUrl = (process.env.PUBLIC_SITE_URL || '').trim();

    // A secret would be a catastrophe rather than a bug, so it is checked for
    // by shape rather than trusted to be absent. The name is reported; the
    // value never is.
    if (/service.role/i.test(anonKey) || /^sb_secret_/.test(anonKey)) {
        throw new Error('SUPABASE_ANON_KEY looks like a secret key. Use the anon/publishable key.');
    }

    const missing = [];
    if (!url) missing.push('SUPABASE_URL');
    if (!anonKey) missing.push('SUPABASE_ANON_KEY');
    if (!siteUrl) missing.push('PUBLIC_SITE_URL');

    // A build that is going to be deployed must not be allowed to produce an
    // application that cannot sign anybody in. Under Cloudflare's builder, and
    // for the private production build, this is a hard stop: a broken
    // deployment is worse than a failed one, because the failure is visible to
    // whoever ran the build and the breakage is visible to everybody else.
    const production = buildModeInUse === 'production';
    const strict = production || strictRequested || process.env.WORKERS_CI === '1';

    if (missing.length && strict) {
        throw new Error(
            'The ' +
                (production ? 'production' : 'public') +
                ' build needs these environment variables and they are not set: ' +
                missing.join(', ') +
                (production || strictRequested
                    ? '. Set them in the environment of this working tree and build again.'
                    : '. Set them in the Cloudflare project and build again.')
        );
    }

    // Set, but never filled in. Named, never quoted.
    const placeholders = placeholderProblems({
        SUPABASE_URL: url,
        SUPABASE_ANON_KEY: anonKey,
        PUBLIC_SITE_URL: siteUrl
    });

    if (placeholders.length && strict) {
        throw new Error(
            'These settings still hold placeholder or example values: ' +
                placeholders.join(', ') +
                '. Put the real public values in and build again.'
        );
    }

    if (missing.length) {
        console.warn('  Building without ' + missing.join(', ') + '.');
        console.warn('  The result runs locally; published, it cannot reach Supabase.');
    }

    if (placeholders.length) {
        console.warn('  ' + placeholders.join(', ') + ' look like placeholder or example values.');
    }

    const configured = Boolean(url && anonKey);

    // What the copy will say it is. A build handed public settings carries
    // them and needs no server; a build handed none is the same files, and
    // saying it were published would leave the person who runs the release
    // themselves with an application that ignores their own /api/config and
    // then reports that Supabase is not configured. So it says what is true.
    return {
        url: url,
        anonKey: anonKey,
        siteUrl: siteUrl,
        configured: configured,
        deployment: configured ? 'cloudflare' : 'local'
    };
}

/**
 * The settings a published copy carries, as a file it loads.
 *
 * A script rather than data on purpose: it is read before anything asks a
 * question, so nothing has to fetch it, wait for it, or decide what to do
 * while it has not arrived. A copy that has these knows what it is; a copy
 * that does not is a local checkout, and says so.
 */
/**
 * Which build this is: a short commit and a timestamp, both public.
 *
 * The point of it is to prove which code a host is actually serving. When the
 * page loads it says so in the console, and the same values sit in
 * build-info.json - so "did the deploy take" stops being a guess. The commit
 * comes from whatever the builder knows: Cloudflare and GitHub both put it in
 * the environment, and a build run by hand reads it from git. Nothing here is
 * secret; a commit hash is already public the moment it is pushed.
 */
let buildInfoCached = null;

function buildInfo() {
    if (buildInfoCached) return buildInfoCached;

    let version = '0.0.0';
    try {
        version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version;
    } catch (e) {
        /* the version is a convenience, not a requirement */
    }

    let commit = (
        process.env.CF_PAGES_COMMIT_SHA ||
        process.env.WORKERS_CI_COMMIT_SHA ||
        process.env.CI_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        ''
    ).trim();

    if (!commit) {
        try {
            commit = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: ROOT,
                encoding: 'utf8'
            }).trim();
        } catch (e) {
            commit = '';
        }
    }

    buildInfoCached = {
        commit: commit ? commit.slice(0, 7) : 'unknown',
        builtAt: new Date().toISOString(),
        version: version
    };
    return buildInfoCached;
}

/**
 * What the page is told about this build: which one it is, and - when this
 * build carries it - where the Android app can be downloaded. A page that is
 * not told about the app offers no download, so there is never a link to a
 * file that is not there.
 */
function buildMetadata(androidDownload) {
    return Object.assign({}, buildInfo(), androidDownload ? { androidApp: androidDownload } : {});
}

/** The pinned release certificate: the environment's for a one-off build, else the committed one. */
function releaseCertificatePin(override) {
    const normalize = (value) => {
        const hex = String(value || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        return hex.length === 64 ? hex : null;
    };
    if (override !== undefined) return normalize(override);
    if (process.env.SPOTIFIE_ANDROID_CERT_SHA256) return normalize(process.env.SPOTIFIE_ANDROID_CERT_SHA256);
    try {
        return normalize(JSON.parse(fs.readFileSync(ANDROID_SIGNING_PIN, 'utf8')).certificateSha256);
    } catch (e) {
        return null;
    }
}

/**
 * Copy the signed Android release into a production release, when there is one
 * fit to offer. Answers what the page should be told about it, or null for no
 * download.
 *
 * settings.androidApkPath / androidReleaseRecordPath / androidCertificatePin
 * point a test at its own files; a real build uses the release outputs and the
 * committed pin.
 */
function copyAndroidDownload(mode, options) {
    if (mode !== 'production') return null;

    const settings = options || {};
    const source = settings.androidApkPath || ANDROID_RELEASE_APK;
    const recordPath = settings.androidReleaseRecordPath || path.join(path.dirname(source), ANDROID_RELEASE_RECORD);
    const skip = (reason) => {
        console.warn('No Android download on this build: ' + reason);
        return null;
    };

    // A debug build is never offered, whatever it is called or wherever it is.
    if (/app-debug\.apk$/i.test(source) || /[\\/]debug[\\/][^\\/]+$/i.test(source)) return skip('a debug build is never offered.');
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return skip('there is no signed release APK (npm run android:release).');

    let record;
    try {
        record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    } catch (e) {
        return skip('the release APK has no verification record; build it with npm run android:release.');
    }

    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    if (record.artifact !== 'apk' || record.sha256 !== digest) return skip('the APK does not match its verification record.');

    // The app the website offers must be the release the website is. When the
    // version moves on, the previous APK is still sitting in the build output,
    // and offering it would advertise one version and hand over another - a
    // download that says 1.0.0 on the page and installs a release candidate.
    // Until the new version is signed, the site offers nothing, which is the
    // honest state rather than a stale one.
    let productVersion = settings.productVersion;
    if (productVersion === undefined) {
        try {
            productVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null;
        } catch (e) {
            productVersion = null;
        }
    }
    if (productVersion && String(record.version) !== String(productVersion)) {
        return skip('the signed APK is ' + record.version + ', but this release is ' + productVersion + '.');
    }

    const pin = releaseCertificatePin(settings.androidCertificatePin);
    if (!pin) return skip('no release certificate is pinned in android/release-signing.json.');
    if (String(record.certificateSha256 || '').toLowerCase() !== pin) {
        return skip('the APK is signed by a certificate other than the pinned release certificate.');
    }

    const bytes = fs.statSync(source).size;
    if (bytes > ANDROID_DOWNLOAD_LIMIT) {
        console.warn(
            'The Android APK is ' +
                Math.round(bytes / (1024 * 1024)) +
                ' MB, more than a static host serves. It is left out, and the website offers no download.'
        );
        return null;
    }

    // An APK is a zip. Anything else at that path is not an app to offer.
    const head = Buffer.alloc(4);
    const handle = fs.openSync(source, 'r');
    try {
        fs.readSync(handle, head, 0, 4, 0);
    } finally {
        fs.closeSync(handle);
    }
    if (head.readUInt32LE(0) !== 0x04034b50) {
        console.warn('The Android build output is not an APK. It is left out, and the website offers no download.');
        return null;
    }

    const target = path.join(OUT, ...ANDROID_DOWNLOAD.split('/'));
    ensureDirectory(path.dirname(target));
    fs.copyFileSync(source, target);

    // What any client may read about the release: public facts about the file,
    // taken from the file itself. No path, no source file name, no secret.
    const { androidReleaseName } = require('./releaseVersion.js');
    const minSdk = Number(record.minSdk) || null;
    const metadata = {
        app: 'Spotifie',
        platform: 'android',
        distribution: 'direct',
        version: String(record.version),
        versionCode: Number(record.versionCode),
        apk: '/' + ANDROID_DOWNLOAD,
        fileName: 'Spotifie-Android.apk',
        size: bytes,
        sha256: digest,
        certificateSha256: pin,
        releasedAt: record.builtAt || null,
        minSdk: minSdk,
        minimumAndroid: minSdk ? androidReleaseName(minSdk) : null
    };
    fs.writeFileSync(path.join(OUT, ...ANDROID_RELEASE_METADATA.split('/')), JSON.stringify(metadata, null, 2) + '\n');

    return {
        url: '/' + ANDROID_DOWNLOAD,
        bytes: bytes,
        version: metadata.version,
        versionCode: metadata.versionCode,
        sha256: digest,
        metadata: '/' + ANDROID_RELEASE_METADATA
    };
}

function publicRuntimeScript(androidDownload) {
    const settings = publicSettings();
    const build = buildMetadata(androidDownload);

    return (
        [
            '/**',
            ' * What this copy of Spotifie is, written when it was built.',
            ' *',
            ' * Public values only: the Supabase project, the key meant for a browser,',
            ' * and the address this was published at. A service-role key, a database',
            ' * password or a JWT secret would each be a catastrophe here, and the build',
            ' * that writes this file refuses to write one.',
            ' *',
            ' * Its presence is also the answer to "is there a Spotifie server on this',
            ' * origin?" - a published copy has none, and asks it for nothing.',
            ' */',
            'window.__SPOTIFIE_CONFIG__ = ' +
                JSON.stringify(
                    {
                        supabaseUrl: settings.url,
                        supabaseAnonKey: settings.anonKey,
                        publicSiteUrl: settings.siteUrl,
                        deployment: settings.deployment
                    },
                    null,
                    4
                ) +
                ';',
            '',
            '// Which build this is - said in the console so it is plain which code',
            '// the host is serving. A commit hash and a timestamp, both public.',
            'window.__SPOTIFIE_BUILD__ = ' + JSON.stringify(build, null, 4) + ';',
            "try { console.info('[spotifie-build] ' + window.__SPOTIFIE_BUILD__.commit); } catch (e) {}",
            ''
        ].join('\n')
    );
}

/** The same settings as data, for anything that would rather read JSON. */
function publicRuntimeConfig() {
    const settings = publicSettings();

    return (
        JSON.stringify(
            {
                supabaseUrl: settings.url,
                supabaseAnonKey: settings.anonKey,
                publicSiteUrl: settings.siteUrl,
                deployment: settings.deployment,
                configured: settings.configured
            },
            null,
            2
        ) + '\n'
    );
}

/**
 * What a static host should send with each kind of file.
 *
 * Cloudflare reads this from the root of what it publishes. It carries the
 * same protections the local server sends, written for a host that has no
 * code of its own to send them from - and a cache rule per kind of file,
 * because getting that wrong is how a private answer ends up in a shared
 * cache.
 *
 * Nothing here is private, and that is deliberate rather than lucky: a
 * published copy is the application and the public pages, and every request
 * that touches an account goes to Supabase or to a helper on somebody's own
 * machine, neither of which passes through this host at all. The rules below
 * still say so explicitly, so a future addition has to argue with them.
 */
function publicHeaders(androidDownload) {
    const supabase = (process.env.SUPABASE_URL || '').trim();
    let origin = '';
    try {
        origin = supabase ? new URL(supabase).origin : '';
    } catch (e) {
        origin = '';
    }

    // The helper on the machine somebody is sitting at. Named so a published
    // copy may reach it for the music on that device - and named as loopback
    // only, which is the one address that never leaves the machine.
    const helper = 'http://127.0.0.1:3000 http://localhost:3000';

    const csp = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        // The pages ask Google Fonts for two families: the stylesheet from one
        // host, the font files from another. Both named exactly - "any" for
        // either would open far more than a typeface.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "worker-src 'self'",
        ["img-src 'self'", origin, 'data:', 'blob:', helper, 'https://ui-avatars.com'].filter(Boolean).join(' '),
        ["media-src 'self'", origin, 'blob:', helper].filter(Boolean).join(' '),
        "font-src 'self' data: https://fonts.gstatic.com",
        ["connect-src 'self'", origin, origin.replace(/^https:/, 'wss:'), helper].filter(Boolean).join(' '),
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');

    return [
        '# What a static host sends with each kind of file.',
        '#',
        '# Generated by "npm run build:public" - edit tools/buildPublic.js, not',
        '# this file, which is written again on every build.',
        '',
        '/*',
        '  Content-Security-Policy: ' + csp,
        '  X-Content-Type-Options: nosniff',
        '  X-Frame-Options: DENY',
        '  Referrer-Policy: strict-origin-when-cross-origin',
        '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
        '  Cross-Origin-Opener-Policy: same-origin',
        '  Cross-Origin-Resource-Policy: same-origin',
        '',
        '# Pages are checked on every visit, so a deploy is seen at once rather',
        '# than after a cache somewhere decides it has waited long enough.',
        '/',
        '  Cache-Control: public, max-age=0, must-revalidate',
        '/*.html',
        '  Cache-Control: public, max-age=0, must-revalidate',
        '',
        '# The worker decides what the application caches, so it must never be',
        '# the stale thing deciding. Same for the settings a copy is built with,',
        '# and the line that says which build this is.',
        '/sw.js',
        '  Cache-Control: no-cache',
        '/config.json',
        '  Cache-Control: no-cache',
        '/build-info.json',
        '  Cache-Control: no-cache',
        '',
        '# The two scripts a stale copy of would strand the whole application on',
        '# old code: the settings/build script, and the one that signs people in',
        '# and opens the dashboard. Revalidated every load - still cached, still',
        '# a 304 when unchanged, but never served old after a deploy.',
        '/js/config.js',
        '  Cache-Control: no-cache',
        '/js/auth.js',
        '  Cache-Control: no-cache',
        '',
        '# Files that change only when the application does.',
        '/css/*',
        '  Cache-Control: public, max-age=3600',
        '/js/*',
        '  Cache-Control: public, max-age=3600',
        '/img/*',
        '  Cache-Control: public, max-age=86400',
        '/favicons/*',
        '  Cache-Control: public, max-age=86400',
        ''
    ]
        .concat(
            androidDownload
                ? [
                      '# The Android app, offered for download: sent as an Android package,',
                      '# saved under a readable name, and revalidated so a new build is seen.',
                      '/' + ANDROID_DOWNLOAD,
                      '  Content-Type: application/vnd.android.package-archive',
                      '  Content-Disposition: attachment; filename="Spotifie-Android.apk"',
                      '  Cache-Control: public, max-age=0, must-revalidate',
                      '# What the release is, for anything that checks before downloading.',
                      '/' + ANDROID_RELEASE_METADATA,
                      '  Content-Type: application/json; charset=utf-8',
                      '  Cache-Control: no-cache',
                      ''
                  ]
                : []
        )
        .join('\n');
}

/**
 * What a static host must not publish.
 *
 * The release is a Node application: it carries the server that runs it, the
 * modules behind that server, and the database schema somebody sets up once.
 * A static host has no use for any of them, and would serve every one of them
 * as a file anybody could download - the server's source, and the SQL that
 * describes the database, at addresses anybody could guess.
 *
 * Wrangler reads this file from the assets directory and leaves what it names
 * out of the upload. The files stay in the release, where somebody running
 * Spotifie themselves still needs them; they are simply not part of a website.
 */
function assetsIgnore() {
    return [
        '# Files a static host must not publish.',
        '#',
        '# The release is also a Node application, and these are the parts of it',
        '# that run on a machine rather than in a browser. Read by Wrangler from',
        '# the assets directory; everything not named here is uploaded.',
        '',
        '# The server, and the modules it is built from.',
        'server.js',
        'lib/',
        '',
        '# How to run it, and how to set its database up. Neither is a page.',
        'package.json',
        'package-lock.json',
        'supabase-setup.sql',
        '',
        '# Written for whoever runs or reads the project, not for a visitor.',
        'README.md',
        'SECURITY.md',
        '',
        '# Configuration a person copies and fills in. It holds placeholders and',
        '# no secret, but it is not a page and there is nothing to gain from',
        '# answering a request for it.',
        '#',
        '# Written anchored, with a leading slash. A bare name is matched for an',
        '# ordinary file and not for one beginning with a dot, so ".env.example"',
        '# on its own is read and ignored - the file is uploaded and served all',
        '# the same. "/.env.example" is the form that holds.',
        '/.env.example',
        '/.gitignore',
        '',
        '# Wrangler own configuration, if a copy ever lands here.',
        '.assetsignore',
        'wrangler.jsonc',
        'wrangler.toml',
        ''
    ].join('\n');
}

/**
 * The manifest for the release: the same application, without the parts of the
 * toolchain that only make sense in the working copy.
 */
function publicPackageJson(source) {
    const manifest = JSON.parse(source);

    const scripts = {};
    for (const name of PUBLIC_SCRIPTS) {
        if (manifest.scripts[name]) scripts[name] = manifest.scripts[name];
    }

    // The syntax check names every module; the release has fewer of them.
    if (scripts.check) {
        scripts.check = scripts.check
            .split(' && ')
            .filter((command) => {
                const match = /node --check (\S+)/.exec(command);
                if (!match) return true;
                return fs.existsSync(path.join(OUT, match[1]));
            })
            .join(' && ');
    }

    // Nothing to run: the tests stay in the working copy.
    delete scripts.test;

    manifest.scripts = scripts;
    manifest.private = false;
    delete manifest.devDependencies;

    // The Android shell's packages belong to the working copy that builds the
    // app, not to a release somebody runs with npm start.
    if (manifest.dependencies) {
        Object.keys(manifest.dependencies)
            .filter((name) => name.indexOf('@capacitor/') === 0)
            .forEach((name) => delete manifest.dependencies[name]);
    }

    return JSON.stringify(manifest, null, 2) + '\n';
}

// ============================================
// Build
// ============================================

function build(options) {
    const settings = options || {};
    const mode = settings.mode || detectMode();
    const adminModulePath = settings.adminModulePath || ADMIN_DOCUMENT_MODULE;

    // Every build reads its settings afresh and knows which rules apply.
    buildModeInUse = mode;
    strictRequested = Boolean(settings.strict);
    publicSettingsRead = null;

    // A release is built from nothing, so a file that was in the last one and
    // is not in this list cannot survive into it.
    fs.rmSync(OUT, { recursive: true, force: true });
    ensureDirectory(OUT);

    // The dashboard and its script are part of the private half of the working
    // copy: a public checkout that does not have them builds a release without
    // them, rather than failing. When they are absent the page must not link to
    // them either, so the link goes with them - a release that named a page it
    // did not have would be the same fault in the other direction.
    const dashboard = ADMIN_FILES.every((file) => fs.existsSync(path.join(ROOT, file))) && !settings.withoutAdmin;

    // A production build is the exception: it is deployed from this private
    // working tree and must carry the dashboard, so it stops here if the source
    // is missing rather than shipping a worker that serves nothing.
    requireProductionSource(dashboard, mode);

    // The settings are checked before anything is written, so a build with
    // missing or placeholder values stops here rather than half-way through.
    publicSettings();

    for (const page of PAGES) {
        if (ADMIN_FILES.indexOf(page) !== -1 && !dashboard) continue;
        const strip = page === 'index.html' && !dashboard;
        copyFile(page, {
            transform: (html) => withSiteMeta(strip ? stripDashboardLink(html) : html, page)
        });
    }

    for (const script of BROWSER_SCRIPTS) {
        if (ADMIN_FILES.indexOf(script) !== -1) {
            // Absent from this copy: nothing to publish.
            if (!dashboard) continue;
            // Present, but a production build holds it inside the worker's
            // dashboard document rather than answering it as a public file, so
            // it is not copied into the assets at all.
            if (mode === 'production') continue;
        }
        copyFile(script);
    }
    for (const style of STYLES) copyFile(style);
    for (const directory of ASSET_DIRECTORIES) copyDirectory(directory);

    // The Android app, for a production website to offer. One file, when it
    // exists; nothing else from the Android project is ever copied.
    const androidDownload = copyAndroidDownload(mode, settings);

    // The dashboard document, into the worker rather than the assets - so it is
    // never a file anybody can request, only something the worker serves once
    // it has proven who is asking.
    writeAdminDocument(dashboard, mode, adminModulePath);

    for (const file of SERVER_FILES) {
        copyFile(file, { transform: file === 'lib/publicConfig.js' ? neutralisePublicConfig : null });
    }

    // robots.txt, llms.txt and - when this build knows where it will be
    // published - sitemap.xml. A static host has no server to answer them, so
    // they are written here from the same source the local server uses.
    writeDiscoveryFiles();

    for (const file of PROJECT_FILES) copyFile(file, { optional: true });

    // What a browser reads to install the application. It has to sit at the
    // root, like the service worker, or its scope would be wrong.
    copyFile('manifest.webmanifest');

    // And what a static host must leave alone when it publishes this.
    fs.writeFileSync(path.join(OUT, '.assetsignore'), assetsIgnore());

    // What this copy is, and the two public Supabase values with it. The
    // script is what the application reads; the JSON is the same thing for
    // anything that would rather have data.
    fs.writeFileSync(path.join(OUT, 'js', 'config.js'), publicRuntimeScript(androidDownload));
    fs.writeFileSync(path.join(OUT, 'config.json'), publicRuntimeConfig());

    // Which build this is, as data anyone or anything can read to prove which
    // code the host is serving.
    fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify(buildMetadata(androidDownload), null, 2) + '\n');

    // What a static host should send with each kind of file.
    fs.writeFileSync(path.join(OUT, '_headers'), publicHeaders(androidDownload));

    // The service worker keeps the application itself so it opens offline.
    // It must sit at the root: served anywhere else it would control nothing.
    copyFile('sw.js');

    copyFile('SECURITY.md', { optional: true });
    copyPublicReadme();
    copyPublicSchema();

    // Last, because it reads what is already in the release.
    copyFile('package.json', { transform: publicPackageJson });

    // A build is only worth anything if it shipped the current code. This is
    // the guard against the one failure this whole change exists to catch: a
    // release that looks built but carries a stale js/auth.js.
    assertFreshness();

    // A production build must prove it actually embedded a real dashboard, not
    // a null document, before anything deploys the worker.
    if (mode === 'production') assertAdminDocument(adminModulePath);

    report(mode, androidDownload);
}

/**
 * Refuse a build whose js/auth.js is not the current source.
 *
 * Copied, not transformed, so the two must be identical - and identical is
 * checked, byte for byte. The named markers are checked on top of that, so the
 * failure names what a stale copy is missing rather than only that it differs:
 * the click log, the enterAdmin log, the endpoint entry posts to, and the
 * address it opens.
 */
function assertFreshness() {
    const builtPath = path.join(OUT, 'js', 'auth.js');
    if (!fs.existsSync(builtPath)) {
        throw new Error('The release is missing js/auth.js.');
    }

    const built = fs.readFileSync(builtPath, 'utf8');
    const markers = ['[admin-enter] click', '[admin-enter] function', '/api/admin/enter', '/admin-dashboard'];
    const missing = markers.filter((marker) => built.indexOf(marker) === -1);

    if (missing.length) {
        throw new Error(
            'The built js/auth.js is missing current markers (' +
                missing.join(', ') +
                '). The build copied a stale source; there is nothing to publish.'
        );
    }

    const source = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
    if (built !== source) {
        throw new Error('The built js/auth.js does not match the source js/auth.js.');
    }
}

/** The public README, which is a separate document from the working one. */
function copyPublicReadme() {
    const source = path.join(ROOT, 'public-release', 'README.public.md');
    if (!fs.existsSync(source)) {
        throw new Error('public-release/README.public.md is missing; the release needs its own README');
    }
    fs.writeFileSync(path.join(OUT, 'README.md'), fs.readFileSync(source));
}

/**
 * The database schema, without the section that explains how to make somebody
 * an administrator.
 *
 * The policies stay, all of them: they are what stops an ordinary account
 * writing to the catalogue, and they protect the person running the release
 * rather than hiding anything. What goes is the bootstrap procedure, which is
 * an operator's instruction and not part of the application.
 */
function copyPublicSchema() {
    const source = path.join(ROOT, 'supabase-setup.sql');
    if (!fs.existsSync(source)) return;

    const sql = fs.readFileSync(source, 'utf8');
    const start = sql.indexOf('-- 4. ONE-TIME INITIAL ADMIN BOOTSTRAP');
    if (start === -1) {
        fs.writeFileSync(path.join(OUT, 'supabase-setup.sql'), sql);
        return;
    }

    const headerStart = sql.lastIndexOf('-- =============================================', start);
    const end = sql.indexOf('-- 5. GLOBAL ADMIN CATALOGUE', start);
    const nextHeader = end === -1 ? sql.length : sql.lastIndexOf('-- =============================================', end);

    const notice = [
        '-- =============================================',
        '-- ADMINISTRATORS',
        '-- =============================================',
        '-- The policies below give write access only to accounts listed in',
        '-- public.app_admins. That table grants no writes to anon or to',
        '-- authenticated, so no account can add itself to it: an administrator',
        '-- is made by hand, in the database, by whoever owns the project.',
        '--',
        '-- The procedure for doing that is not part of this release.',
        '-- =============================================',
        '',
        ''
    ].join('\n');

    fs.writeFileSync(path.join(OUT, 'supabase-setup.sql'), sql.slice(0, headerStart) + notice + sql.slice(nextHeader));
}

function walk(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...walk(full));
        else files.push(full);
    }
    return files;
}

function report(mode, androidDownload) {
    const files = walk(OUT);
    const bytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);

    const build = buildInfo();
    const label = mode === 'production' ? 'Production worker build' : 'Public release';
    console.log(label + ' built in ' + path.relative(ROOT, OUT));
    console.log('  ' + files.length + ' files, ' + Math.round(bytes / 1024) + ' KB');
    console.log('  build ' + build.commit + ' at ' + build.builtAt);
    console.log('');
    console.log('Left out by design: the administrator sign-in page, the admin server');
    console.log('modules, the tests, the working data, and this project\'s own Supabase');
    console.log('settings. The dashboard is not a public file: the worker holds it and');
    console.log('serves it only to an administrator it has verified against Supabase.');
    console.log('');

    if (mode === 'production') {
        console.log('The administrator script is inside the dashboard document the worker');
        console.log('holds, not among the assets, so it is reachable only through the gate.');
        console.log('');
        console.log(
            androidDownload
                ? 'Android app: /' + ANDROID_DOWNLOAD + ' (' + (androidDownload.bytes / (1024 * 1024)).toFixed(1) + ' MB), offered on the website.'
                : 'Android app: no signed, pinned release APK (npm run android:release), so the website offers no download.'
        );
        console.log('');
        console.log('Check it before deploying:   npm run release:check:production');
        console.log('Then deploy from here:       npx wrangler deploy');
    } else {
        console.log('Check it before publishing:  npm run release:check');
    }
}

if (require.main === module) {
    try {
        build();
    } catch (err) {
        console.error('Could not build the release: ' + err.message);
        process.exit(1);
    }
}

module.exports = {
    build,
    OUT,
    PAGES,
    BROWSER_SCRIPTS,
    SERVER_FILES,
    ADMIN_FILES,
    ADMIN_DOCUMENT_MODULE,
    detectMode,
    placeholderProblems,
    requireProductionSource,
    inlineAdminScript,
    assertAdminDocument,
    copyAndroidDownload,
    releaseCertificatePin,
    ANDROID_RELEASE_APK,
    ANDROID_RELEASE_RECORD,
    ANDROID_DOWNLOAD,
    ANDROID_RELEASE_METADATA
};
