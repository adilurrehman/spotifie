'use strict';

/**
 * Spotifie's version, from its one authority: package.json.
 *
 * The web build, the Android app (versionName) and the iOS project all take
 * the version from here. Android also needs an integer that only ever rises,
 * and that is derived rather than kept by hand:
 *
 *     major * 1000000 + minor * 10000 + patch * 100 + (rc N ? N : 99)
 *
 * so every release candidate of a version comes before the version itself,
 * and every version comes before the next. android/app/build.gradle computes
 * the same number; the release tool checks the finished APK carries it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

function readVersion(root) {
    return JSON.parse(fs.readFileSync(path.join(root || ROOT, 'package.json'), 'utf8')).version;
}

function androidVersionCode(version) {
    const match = VERSION.exec(String(version || ''));
    if (!match) throw new Error('Version "' + version + '" must be x.y.z or x.y.z-rc.N.');

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const step = match[4] !== undefined ? Number(match[4]) : 99;

    if (minor > 99 || patch > 99 || step < 1 || (match[4] !== undefined && step > 98)) {
        throw new Error('Version "' + version + '" is outside what versionCode can count (minor and patch up to 99, rc.1 to rc.98).');
    }
    return major * 1000000 + minor * 10000 + patch * 100 + step;
}

/** Android's minimum API level, as people know it. */
const ANDROID_RELEASES = { 21: '5.0', 23: '6.0', 24: '7.0', 26: '8.0', 28: '9', 29: '10', 30: '11', 31: '12', 33: '13', 34: '14', 35: '15', 36: '16' };

function androidReleaseName(sdk) {
    return ANDROID_RELEASES[sdk] ? 'Android ' + ANDROID_RELEASES[sdk] : 'Android API ' + sdk;
}

module.exports = { readVersion, androidVersionCode, androidReleaseName, VERSION };
