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

// ============================================
// What goes in
// ============================================

/**
 * Pages a visitor can open.
 *
 * admin-login.html is deliberately not here: it belongs to a copy somebody
 * runs themselves, and this being a list of what to include is what makes that
 * a fact rather than something to remember.
 *
 * The dashboard is here, and is not an exception to that.
 *
 * It grants nothing. Opening it asks the database whether this account is an
 * administrator and sends anybody else away; every action inside it is refused
 * again by the row-level policies, which read the same table and do not care
 * what page asked. Publishing it is publishing an interface that is useless to
 * everybody except the accounts the database already trusts - and leaving it
 * out was why an administrator signing in to the published copy had a link to
 * a page that was not there.
 *
 * What stays out is what actually decides anything: the server modules that
 * check administrators and perform privileged writes. They are absent, so the
 * released server has no privileged endpoints at all.
 */
const PAGES = [
    'index.html',
    'about.html',
    'developer.html',
    'signin.html',
    'signup.html',
    'forgot-password.html',
    'reset-password.html',
    'admin-dashboard.html'
];

/** Browser code the pages load. */
const BROWSER_SCRIPTS = [
    // The dashboard's own script, which is what asks the database whether the
    // account reading it is an administrator and sends everybody else away. It
    // decides nothing: the row-level policies refuse every write it attempts
    // on behalf of an account the database does not trust.
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
    'js/libraryDB.js'
];

/**
 * The dashboard, and the script that decides who may see it.
 *
 * Published together or not at all, and only when this working copy has them:
 * they live in the private half of the project, so a checkout without them
 * builds a release without them and without the link to them.
 */
const ADMIN_FILES = ['admin-dashboard.html', 'js/admin.js'];

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

    const closing = html.indexOf('</a>', start);
    if (closing === -1) return html;

    const end = closing + '</a>'.length;
    const lineStart = html.lastIndexOf('\n', start) + 1;
    let lineEnd = html.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = html.length;

    return html.slice(0, lineStart) + html.slice(lineEnd + 1);
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
    // application that cannot sign anybody in. Under Cloudflare's builder this
    // is a hard stop: a broken deployment is worse than a failed one, because
    // the failure is visible to whoever ran the build and the breakage is
    // visible to everybody else.
    if (missing.length && process.env.WORKERS_CI === '1') {
        throw new Error(
            'The public build needs these environment variables and they are not set: ' +
                missing.join(', ') +
                '. Set them in the Cloudflare project and build again.'
        );
    }

    if (missing.length) {
        console.warn('  Building without ' + missing.join(', ') + '.');
        console.warn('  The result runs locally; published, it cannot reach Supabase.');
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
function publicRuntimeScript() {
    const settings = publicSettings();

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
function publicHeaders() {
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
        '# the stale thing deciding. Same for the settings a copy is built with.',
        '/sw.js',
        '  Cache-Control: no-cache',
        '/config.json',
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
    ].join('\n');
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

    return JSON.stringify(manifest, null, 2) + '\n';
}

// ============================================
// Build
// ============================================

function build() {
    // A release is built from nothing, so a file that was in the last one and
    // is not in this list cannot survive into it.
    fs.rmSync(OUT, { recursive: true, force: true });
    ensureDirectory(OUT);

    // The dashboard and its script are part of the private half of the working
    // copy: a checkout that does not have them builds a release without them,
    // rather than failing. When they are absent the page must not link to
    // them either, so the link goes with them - a release that named a page it
    // did not have would be the same fault in the other direction.
    const dashboard = ADMIN_FILES.every((file) => fs.existsSync(path.join(ROOT, file)));

    for (const page of PAGES) {
        if (ADMIN_FILES.indexOf(page) !== -1 && !dashboard) continue;
        copyFile(page, { transform: page === 'index.html' && !dashboard ? stripDashboardLink : null });
    }

    for (const script of BROWSER_SCRIPTS) {
        if (ADMIN_FILES.indexOf(script) !== -1 && !dashboard) continue;
        copyFile(script);
    }
    for (const style of STYLES) copyFile(style);
    for (const directory of ASSET_DIRECTORIES) copyDirectory(directory);

    for (const file of SERVER_FILES) {
        copyFile(file, { transform: file === 'lib/publicConfig.js' ? neutralisePublicConfig : null });
    }

    // robots.txt, sitemap.xml and llms.txt are not files here. The server
    // answers all three, because two of them say where the installation is
    // published and only the running server knows whether anybody has said.
    for (const file of PROJECT_FILES) copyFile(file, { optional: true });

    // What a browser reads to install the application. It has to sit at the
    // root, like the service worker, or its scope would be wrong.
    copyFile('manifest.webmanifest');

    // And what a static host must leave alone when it publishes this.
    fs.writeFileSync(path.join(OUT, '.assetsignore'), assetsIgnore());

    // What this copy is, and the two public Supabase values with it. The
    // script is what the application reads; the JSON is the same thing for
    // anything that would rather have data.
    fs.writeFileSync(path.join(OUT, 'js', 'config.js'), publicRuntimeScript());
    fs.writeFileSync(path.join(OUT, 'config.json'), publicRuntimeConfig());

    // What a static host should send with each kind of file.
    fs.writeFileSync(path.join(OUT, '_headers'), publicHeaders());

    // The service worker keeps the application itself so it opens offline.
    // It must sit at the root: served anywhere else it would control nothing.
    copyFile('sw.js');

    copyFile('SECURITY.md', { optional: true });
    copyPublicReadme();
    copyPublicSchema();

    // Last, because it reads what is already in the release.
    copyFile('package.json', { transform: publicPackageJson });

    report();
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

function report() {
    const files = walk(OUT);
    const bytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);

    console.log('Public release built in ' + path.relative(ROOT, OUT));
    console.log('  ' + files.length + ' files, ' + Math.round(bytes / 1024) + ' KB');
    console.log('');
    console.log('Left out by design: the administrator sign-in page, the admin server');
    console.log('modules, the tests, the working data, and this project\'s own Supabase');
    console.log('settings. The dashboard is included and grants nothing: the database');
    console.log('decides who may use it.');
    console.log('');
    console.log('Check it before publishing:  npm run release:check');
}

if (require.main === module) {
    try {
        build();
    } catch (err) {
        console.error('Could not build the public release: ' + err.message);
        process.exit(1);
    }
}

module.exports = { build, OUT, PAGES, BROWSER_SCRIPTS, SERVER_FILES };
