'use strict';

/**
 * Test fixtures: synthetic MP3 files with real ID3v2 tags.
 * Building them here keeps the tests independent of the user's music folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 1x1 transparent PNG, used as embedded artwork in fixtures only.
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

function textFrame(id, value) {
    const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(value, 'latin1')]);
    const header = Buffer.alloc(10);
    header.write(id, 0, 4, 'latin1');
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

function pictureFrame(imageData) {
    const payload = Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from('image/png', 'latin1'),
        Buffer.from([0x00]),
        Buffer.from([0x03]),
        Buffer.from([0x00]),
        imageData
    ]);
    const header = Buffer.alloc(10);
    header.write('APIC', 0, 4, 'latin1');
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

function synchsafe(size) {
    return Buffer.from([
        (size >> 21) & 0x7f,
        (size >> 14) & 0x7f,
        (size >> 7) & 0x7f,
        size & 0x7f
    ]);
}

function mpegFrames(count) {
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding -> 417 byte frames.
    const frames = [];
    for (let i = 0; i < count; i += 1) {
        const frame = Buffer.alloc(417);
        frame[0] = 0xff;
        frame[1] = 0xfb;
        frame[2] = 0x90;
        frame[3] = 0x00;
        frames.push(frame);
    }
    return Buffer.concat(frames);
}

/**
 * Build an MP3 buffer with the given tags.
 * `options.artwork` embeds a picture, `options.filler` changes the audio bytes
 * so two fixtures can be made to differ in content.
 */
function buildMp3(options) {
    const settings = options || {};
    const frames = [];

    if (settings.title) frames.push(textFrame('TIT2', settings.title));
    if (settings.artist) frames.push(textFrame('TPE1', settings.artist));
    if (settings.album) frames.push(textFrame('TALB', settings.album));
    if (settings.albumArtist) frames.push(textFrame('TPE2', settings.albumArtist));
    if (settings.track) frames.push(textFrame('TRCK', settings.track));
    if (settings.disc) frames.push(textFrame('TPOS', settings.disc));
    if (settings.year) frames.push(textFrame('TYER', String(settings.year)));
    if (settings.genre) frames.push(textFrame('TCON', settings.genre));
    if (settings.artwork) frames.push(pictureFrame(TINY_PNG));

    const body = Buffer.concat(frames);
    const header = Buffer.concat([
        Buffer.from('ID3', 'latin1'),
        Buffer.from([0x03, 0x00, 0x00]),
        synchsafe(body.length)
    ]);

    const audio = mpegFrames(settings.frames || 12);
    if (settings.filler) {
        Buffer.from(settings.filler, 'latin1').copy(audio, 4);
    }

    return Buffer.concat([header, body, audio]);
}

function writeFile(root, relativePath, buffer) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    return target;
}

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'spotifie-test-'));
}

function removeDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
        /* best effort cleanup */
    }
}

module.exports = { buildMp3, writeFile, makeTempDir, removeDir, TINY_PNG };
