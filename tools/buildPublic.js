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
 * and catalogue code. What is left behind has no route to reach - the admin
 * modules are absent, so the server has no privileged endpoints to expose, and
 * the admin pages are absent, so their addresses answer 404 like any other
 * path that names nothing.
 *
 * Run it with: npm run build:public
 * Then check it with: npm run release:check
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public-release', 'dist');

// ============================================
// What goes in
// ============================================

/**
 * Pages a visitor can open.
 *
 * admin-dashboard.html and admin-login.html are deliberately not here, and
 * this being a list of what to include is what makes that a fact rather than
 * something to remember.
 */
const PAGES = [
    'index.html',
    'about.html',
    'developer.html',
    'signin.html',
    'signup.html',
    'forgot-password.html',
    'reset-password.html'
];

/** Browser code the pages load. js/admin.js is not part of the application. */
const BROWSER_SCRIPTS = [
    'js/script.js',
    'js/auth.js',
    'js/catalogClient.js',
    'js/catalogCache.js',
    'js/personalClient.js',
    'js/libraryClient.js',
    'js/libraryDB.js'
];

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
 * It is hidden until an account proves it is an administrator, and it grants
 * nothing by itself - every privileged endpoint checks for itself. But a
 * release with no dashboard should not carry a link to one, so the whole
 * element goes rather than being left to hide itself.
 */
function stripDashboardLink(html) {
    const start = html.indexOf('<!-- Dashboard link - only shown for admin -->');
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

    for (const page of PAGES) {
        copyFile(page, { transform: page === 'index.html' ? stripDashboardLink : null });
    }

    for (const script of BROWSER_SCRIPTS) copyFile(script);
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
    console.log('Left out by design: the admin pages and their script, the admin');
    console.log('server modules, the tests, the working data, and this project\'s own');
    console.log('Supabase settings.');
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
