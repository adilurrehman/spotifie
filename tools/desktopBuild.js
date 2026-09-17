'use strict';

/**
 * Package the Windows desktop application.
 *
 * 1. Build the frontend (npm run build:desktop): strict settings, no admin
 *    source, checked before anything else happens.
 * 2. Build the Tauri shell around it. Paths on this machine are remapped out
 *    of the compiled binary, so the package does not carry the name of the
 *    developer's home folder or working copy.
 * 3. Inspect what came out: the installer and the executable must not carry a
 *    machine path or anything that looks like a secret. A failure stops here.
 *
 * The result is an unsigned installer for development and testing. Signing is
 * a later step.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src-tauri', 'target', 'release');

function run(command, args, env) {
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: env || process.env, shell: true });
    if (result.status !== 0) {
        throw new Error(command + ' ' + args.join(' ') + ' failed (exit ' + result.status + ').');
    }
}

/** Every file under a directory, or nothing when it does not exist. */
function walk(directory) {
    if (!fs.existsSync(directory)) return [];
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...walk(full));
        else found.push(full);
    }
    return found;
}

/** The artefacts a person would be handed: the installer and the executable. */
function artefacts() {
    const installers = walk(path.join(TARGET, 'bundle')).filter((file) => /\.(exe|msi)$/i.test(file));
    const exe = path.join(TARGET, 'spotifie.exe');
    return installers.concat(fs.existsSync(exe) ? [exe] : []);
}

/**
 * Look inside the binaries for what must not be there.
 *
 * Binaries hold text in both 8-bit and UTF-16 form, so each thing is looked
 * for both ways. The installer is compressed, so this mostly speaks for the
 * executable - which is the file the installer unpacks.
 */
function inspectBinary(file) {
    const data = fs.readFileSync(file);
    const problems = [];

    const needles = [
        { name: 'the working-copy path', value: ROOT },
        { name: 'the home-folder path', value: os.homedir() },
        { name: 'a service-role key', value: 'service_role' },
        { name: 'a Supabase secret key', value: 'sb_secret_' },
        { name: 'the admin dashboard source', value: 'initAdminDashboard' }
    ];

    for (const needle of needles) {
        if (!needle.value || needle.value.length < 4) continue;
        const forms = [needle.value, needle.value.split(path.sep).join('/')];
        const found = forms.some(
            (form) => data.indexOf(Buffer.from(form, 'utf8')) !== -1 || data.indexOf(Buffer.from(form, 'utf16le')) !== -1
        );
        if (found) problems.push(path.basename(file) + ' contains ' + needle.name + '.');
    }

    return problems;
}

function main() {
    run('node', [path.join('tools', 'buildDesktop.js')]);

    // Rust writes source locations into a binary for its panic messages.
    // Remapped, they name the crate rather than this machine.
    const remaps = [
        '--remap-path-prefix=' + os.homedir() + '=~',
        '--remap-path-prefix=' + ROOT + '=spotifie'
    ];
    const env = Object.assign({}, process.env, {
        CARGO_ENCODED_RUSTFLAGS: (process.env.CARGO_ENCODED_RUSTFLAGS ? process.env.CARGO_ENCODED_RUSTFLAGS + '\x1f' : '') + remaps.join('\x1f')
    });

    run('npx', ['tauri', 'build'], env);

    const built = artefacts();
    if (!built.length) throw new Error('The build finished without producing an installer or an executable.');

    const problems = [].concat(...built.map(inspectBinary));
    if (problems.length) {
        throw new Error('The desktop package is not fit to hand out:\n  - ' + problems.join('\n  - '));
    }

    console.log('');
    console.log('Desktop package built (unsigned, for development and testing):');
    for (const file of built) {
        const size = fs.statSync(file).size;
        console.log('  ' + path.relative(ROOT, file) + '  ' + (size / (1024 * 1024)).toFixed(1) + ' MB');
    }
    console.log('  Checked: no machine paths, no secrets, no admin source.');
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error('Could not package the desktop application: ' + err.message);
        process.exit(1);
    }
}

module.exports = { inspectBinary, artefacts };
