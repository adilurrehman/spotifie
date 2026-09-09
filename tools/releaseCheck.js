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
const DIST = path.join(ROOT, 'public-release', 'dist');

// ============================================
// What must never be in a release
// ============================================

/** Files and paths that would mean the administrator tooling was included. */
const FORBIDDEN_PATHS = [
    /(^|[/\\])admin-dashboard\.html$/i,
    /(^|[/\\])admin-login\.html$/i,
    /(^|[/\\])admin\.js$/i,
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
    /\.(pem|key|p12|pfx)$/i
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
    { name: 'a link to the admin dashboard', pattern: /admin-dashboard\.html/i },
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
            if (pattern.test(name)) failures.push(name + ' must not be in a public release.');
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
        'css/style.css',
        'lib/sessionAuth.js',
        'lib/catalogRoutes.js'
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

    if (failures.length) {
        console.error('The release is not fit to publish:');
        for (const failure of failures) console.error('  - ' + failure);
        console.error('');
        console.error('Fix the build, run npm run build:public again, and check again.');
        process.exit(1);
    }

    console.log('The release is clean: no admin tooling, no secrets, no music, no private data.');
    console.log('');
    console.log('Publish it by copying ' + path.relative(ROOT, DIST) + ' into a NEW, EMPTY repository.');
    console.log('Deleting a file does not remove it from this repository\'s history, so this');
    console.log('repository itself must stay private.');
}

if (require.main === module) main();

module.exports = { checkRelease, FORBIDDEN_PATHS, FORBIDDEN_CONTENT, AUDIO_EXTENSIONS, DIST };
