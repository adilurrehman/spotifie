'use strict';

/**
 * Build the Android application's frontend.
 *
 * The same frontend the desktop shell gets, from the same builder: the public
 * build, strictly (missing or placeholder Supabase settings stop it, and no
 * value is printed), without the administrative half, without the Node server
 * or the service worker, with a content security policy on every page, and
 * inspected for private files, secrets, audio and machine paths before
 * anything is packaged.
 *
 * Written to mobile/www, which is Capacitor's webDir.
 *
 * Run it with: npm run build:mobile (android:build and mobile:sync run it).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The shell builder writes wherever this says, so it is set before it loads.
process.env.SPOTIFIE_DESKTOP_OUT = process.env.SPOTIFIE_MOBILE_OUT
    ? path.resolve(process.env.SPOTIFIE_MOBILE_OUT)
    : path.join(ROOT, 'mobile', 'www');

const shell = require('./buildDesktop.js');

if (require.main === module) {
    try {
        shell.build({ label: 'Android' });
    } catch (err) {
        fs.rmSync(shell.STAGE, { recursive: true, force: true });
        console.error('Could not build the Android frontend: ' + err.message);
        process.exit(1);
    }
}

module.exports = { OUT: shell.OUT };
