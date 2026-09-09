'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { LibraryService, parseRange } = require('../lib/libraryService');
const { LibraryIndex } = require('../lib/libraryIndex');
const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');
const { containPath } = require('../lib/safeFs');
const { createLibraryRoutes } = require('../lib/libraryRoutes');
const { buildMp3, writeFile, makeTempDir, removeDir } = require('./helpers/fixtures');

function makeService(root, dataDir) {
    return new LibraryService({
        musicRoot: root,
        adapter: new LocalFileSystemAdapter({ musicRoot: root }),
        index: new LibraryIndex(path.join(dataDir, 'library.json')),
        indexFile: path.join(dataDir, 'library.json'),
        artworkDir: path.join(dataDir, 'artwork'),
        dataDir: dataDir
    });
}

function withTempLibrary(build) {
    const root = makeTempDir('spotifie-music-');
    const dataDir = makeTempDir('spotifie-data-');
    if (build) build(root);
    return {
        root,
        dataDir,
        service: makeService(root, dataDir),
        cleanup() {
            removeDir(root);
            removeDir(dataDir);
        }
    };
}

test('scanning an empty library succeeds and stores no tracks', async () => {
    const context = withTempLibrary();
    try {
        const result = await context.service.scan();
        assert.strictEqual(result.trackCount, 0);
        assert.strictEqual(context.service.getTracks({}).total, 0);
        assert.strictEqual(context.service.getAlbums().total, 0);
        assert.strictEqual(context.service.getArtists().total, 0);
    } finally {
        context.cleanup();
    }
});

test('scanning a missing music root does not throw', async () => {
    const dataDir = makeTempDir('spotifie-data-');
    const missingRoot = path.join(dataDir, 'does-not-exist');
    const service = makeService(missingRoot, dataDir);
    try {
        const result = await service.scan();
        assert.strictEqual(result.trackCount, 0);
        assert.strictEqual(service.getStatus().rootAvailable, false);
    } finally {
        removeDir(dataDir);
    }
});

test('scans nested folders and extracts metadata', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, path.join('Artist', 'Album', '01 song.mp3'), buildMp3({
            title: 'First Song',
            artist: 'Test Artist',
            album: 'Test Album',
            albumArtist: 'Test Album Artist',
            track: '1/10',
            disc: '1/2',
            year: 2021,
            genre: 'Electronic',
            artwork: true
        }));
        writeFile(root, path.join('Artist', 'Album', 'deeper', 'nested', '02 song.flac'), buildMp3({
            title: 'Nested Song',
            artist: 'Test Artist',
            album: 'Test Album',
            filler: 'nested-song'
        }));
    });

    try {
        const result = await context.service.scan();
        assert.strictEqual(result.trackCount, 2);

        const tracks = context.service.getTracks({}).items;
        const first = tracks.find((track) => track.title === 'First Song');
        assert.ok(first, 'tagged track was indexed');
        assert.strictEqual(first.artist, 'Test Artist');
        assert.strictEqual(first.album, 'Test Album');
        assert.strictEqual(first.albumArtist, 'Test Album Artist');
        assert.strictEqual(first.trackNumber, 1);
        assert.strictEqual(first.trackTotal, 10);
        assert.strictEqual(first.discNumber, 1);
        assert.strictEqual(first.year, 2021);
        assert.deepStrictEqual(first.genre, ['Electronic']);
        assert.strictEqual(first.hasArtwork, true);
        assert.ok(first.format, 'format is reported');
        assert.strictEqual(typeof first.streamUrl, 'string');
        assert.ok(first.streamUrl.includes(first.id));
    } finally {
        context.cleanup();
    }
});

test('untagged files fall back to Unknown Artist and Unknown Album only', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, 'untagged.mp3', buildMp3({ filler: 'untagged' }));
    });

    try {
        await context.service.scan();
        const track = context.service.getTracks({}).items[0];
        assert.strictEqual(track.artist, 'Unknown Artist');
        assert.strictEqual(track.album, 'Unknown Album');
        assert.strictEqual(track.albumArtist, 'Unknown Artist');
    } finally {
        context.cleanup();
    }
});

test('identical file names in different folders stay distinct tracks', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, path.join('A', 'song.mp3'), buildMp3({ title: 'A Song', filler: 'aaaa' }));
        writeFile(root, path.join('B', 'song.mp3'), buildMp3({ title: 'B Song', filler: 'bbbb' }));
    });

    try {
        const result = await context.service.scan();
        assert.strictEqual(result.trackCount, 2);
        const tracks = context.service.getTracks({}).items;
        assert.strictEqual(new Set(tracks.map((track) => track.id)).size, 2);
        assert.deepStrictEqual(tracks.map((track) => track.fileName).sort(), ['song.mp3', 'song.mp3']);
    } finally {
        context.cleanup();
    }
});

test('a moved and renamed unchanged file keeps the same track ID', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, path.join('Before', 'original.mp3'), buildMp3({ title: 'Stable', filler: 'stable' }));
    });

    try {
        await context.service.scan();
        const before = context.service.getTracks({}).items[0];

        const source = path.join(context.root, 'Before', 'original.mp3');
        const destinationDir = path.join(context.root, 'After', 'Deeper');
        fs.mkdirSync(destinationDir, { recursive: true });
        fs.renameSync(source, path.join(destinationDir, 'renamed.mp3'));

        await context.service.scan();
        const after = context.service.getTracks({}).items;

        assert.strictEqual(after.length, 1);
        assert.strictEqual(after[0].id, before.id);
        assert.strictEqual(after[0].fileName, 'renamed.mp3');
        assert.strictEqual(after[0].title, before.title);
    } finally {
        context.cleanup();
    }
});

test('unchanged files are not rehashed on a second scan', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, 'one.mp3', buildMp3({ title: 'One', filler: 'one1' }));
        writeFile(root, 'two.mp3', buildMp3({ title: 'Two', filler: 'two2' }));
    });

    try {
        const first = await context.service.scan();
        assert.strictEqual(first.hashed, 2);
        assert.strictEqual(first.reused, 0);

        const second = await context.service.scan();
        assert.strictEqual(second.hashed, 0);
        assert.strictEqual(second.reused, 2);
    } finally {
        context.cleanup();
    }
});

test('corrupt and non-audio files do not break the scan', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, 'good.mp3', buildMp3({ title: 'Good', filler: 'good' }));
        writeFile(root, 'broken.mp3', Buffer.from('this is definitely not audio data'));
        writeFile(root, 'notes.txt', Buffer.from('ignored'));
        writeFile(root, path.join('.hidden', 'hidden.mp3'), buildMp3({ title: 'Hidden', filler: 'hide' }));
        writeFile(root, 'partial.mp3.part', buildMp3({ title: 'Partial', filler: 'part' }));
    });

    try {
        const result = await context.service.scan();
        // good.mp3 and broken.mp3 are indexed; hidden, temp and non-audio files are skipped.
        assert.strictEqual(result.fileCount, 2);
        const titles = context.service.getTracks({}).items.map((track) => track.title);
        assert.ok(titles.includes('Good'));
        assert.ok(titles.includes('broken'));
    } finally {
        context.cleanup();
    }
});

test('public payloads never contain filesystem paths', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, path.join('Deep', 'Folder', 'song.mp3'), buildMp3({ title: 'Deep', filler: 'deep' }));
    });

    try {
        await context.service.scan();
        const payload = JSON.stringify({
            tracks: context.service.getTracks({}),
            albums: context.service.getAlbums(),
            artists: context.service.getArtists(),
            status: context.service.getStatus()
        });

        assert.ok(!payload.includes(context.root), 'absolute music root is not exposed');
        assert.ok(!payload.includes('Deep/Folder'), 'folder structure is not exposed');
        assert.ok(!payload.includes('relativePath'), 'internal path field is not exposed');
    } finally {
        context.cleanup();
    }
});

test('index persists across service instances and survives corruption', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, 'persist.mp3', buildMp3({ title: 'Persist', filler: 'persist' }));
    });

    try {
        await context.service.scan();
        const originalId = context.service.getTracks({}).items[0].id;

        const reopened = makeService(context.root, context.dataDir);
        assert.strictEqual(reopened.getTracks({}).items[0].id, originalId);

        fs.writeFileSync(path.join(context.dataDir, 'library.json'), '{ this is not valid json');
        const recovered = makeService(context.root, context.dataDir);
        assert.strictEqual(recovered.getTracks({}).total, 0);
        assert.strictEqual(recovered.getStatus().indexRecovered, true);

        await recovered.scan();
        assert.strictEqual(recovered.getTracks({}).items[0].id, originalId);
    } finally {
        context.cleanup();
    }
});

test('range parsing handles full, partial, suffix and invalid ranges', () => {
    assert.strictEqual(parseRange(undefined, 100), null);
    assert.strictEqual(parseRange('items=0-10', 100), null);
    assert.deepStrictEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepStrictEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
    assert.deepStrictEqual(parseRange('bytes=-20', 100), { start: 80, end: 99 });
    assert.deepStrictEqual(parseRange('bytes=0-500', 100), { start: 0, end: 99 });
    assert.strictEqual(parseRange('bytes=200-300', 100), 'invalid');
    assert.strictEqual(parseRange('bytes=50-10', 100), 'invalid');
    assert.strictEqual(parseRange('bytes=-', 100), 'invalid');
});

test('path containment rejects traversal, absolute paths and escapes', () => {
    const root = makeTempDir('spotifie-safe-');
    try {
        fs.mkdirSync(path.join(root, 'inside'), { recursive: true });
        assert.ok(containPath(root, 'inside'), 'plain relative path is allowed');
        assert.strictEqual(containPath(root, '../escape'), null);
        assert.strictEqual(containPath(root, 'inside/../../escape'), null);
        assert.strictEqual(containPath(root, path.resolve(root, '..')), null);
        assert.strictEqual(containPath(root, 'bad' + String.fromCharCode(0) + 'name'), null);
    } finally {
        removeDir(root);
    }
});

test('symlinked files outside the music root are not scanned or resolved', async () => {
    const outside = makeTempDir('spotifie-outside-');
    const context = withTempLibrary((root) => {
        writeFile(root, 'inside.mp3', buildMp3({ title: 'Inside', filler: 'inside' }));
    });

    try {
        fs.writeFileSync(path.join(outside, 'secret.mp3'), buildMp3({ title: 'Secret', filler: 'secret' }));

        let linked = false;
        try {
            fs.symlinkSync(path.join(outside, 'secret.mp3'), path.join(context.root, 'linked.mp3'));
            linked = true;
        } catch (e) {
            // Creating symlinks can require elevated rights on Windows.
        }

        await context.service.scan();
        const titles = context.service.getTracks({}).items.map((track) => track.title);
        assert.ok(titles.includes('Inside'));
        if (linked) {
            assert.ok(!titles.includes('Secret'), 'symlinked file outside the root is skipped');
        }

        const adapter = new LocalFileSystemAdapter({ musicRoot: context.root });
        assert.strictEqual(adapter.resolve('../secret.mp3'), null);
        assert.strictEqual(adapter.statFile('../secret.mp3'), null);
        assert.strictEqual(adapter.openStream('../secret.mp3', null), null);
    } finally {
        removeDir(outside);
        context.cleanup();
    }
});

test('streaming serves full content, byte ranges and 416 for bad ranges', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, 'stream.mp3', buildMp3({ title: 'Stream', filler: 'strm' }));
    });

    // Drain a stream fully so no file handle work outlives the test.
    function drain(stream) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('close', () => resolve(Buffer.concat(chunks)));
        });
    }

    try {
        await context.service.scan();
        const track = context.service.getTracks({}).items[0];
        const size = fs.statSync(path.join(context.root, 'stream.mp3')).size;

        const full = context.service.openStream(track.id, undefined);
        assert.strictEqual(full.status, 200);
        assert.strictEqual(full.headers['Content-Length'], size);
        assert.strictEqual(full.headers['Accept-Ranges'], 'bytes');
        assert.strictEqual(full.headers['Content-Type'], 'audio/mpeg');
        assert.strictEqual((await drain(full.stream)).length, size);

        const partial = context.service.openStream(track.id, 'bytes=0-99');
        assert.strictEqual(partial.status, 206);
        assert.strictEqual(partial.headers['Content-Length'], 100);
        assert.strictEqual(partial.headers['Content-Range'], 'bytes 0-99/' + size);
        assert.strictEqual((await drain(partial.stream)).length, 100);

        const invalid = context.service.openStream(track.id, 'bytes=' + (size + 10) + '-' + (size + 20));
        assert.strictEqual(invalid.status, 416);
        assert.strictEqual(invalid.headers['Content-Range'], 'bytes */' + size);

        assert.strictEqual(context.service.openStream('not-a-track', undefined).status, 404);
    } finally {
        context.cleanup();
    }
});

test('HTTP endpoints expose tracks, albums, artists, artwork and stream', async () => {
    const context = withTempLibrary((root) => {
        writeFile(root, path.join('Album', 'with-art.mp3'), buildMp3({
            title: 'With Art',
            artist: 'Cover Artist',
            album: 'Cover Album',
            artwork: true,
            filler: 'art1'
        }));
        writeFile(root, path.join('Album', 'no-art.mp3'), buildMp3({
            title: 'No Art',
            artist: 'Cover Artist',
            album: 'Cover Album',
            filler: 'art2'
        }));
    });

    const routes = createLibraryRoutes({ service: context.service });
    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const query = Object.fromEntries(parsed.searchParams.entries());
        const handled = await routes.handle(req, res, parsed.pathname, query);
        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    function request(pathname, options) {
        const settings = options || {};
        return new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port, path: pathname, method: settings.method || 'GET', headers: settings.headers || {} },
                (res) => {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    try {
        // Rescanning is administrator only: an unauthenticated call is refused
        // and the library is left untouched.
        const rescan = await request('/api/library/rescan', { method: 'POST' });
        assert.strictEqual(rescan.status, 401);

        const scanResult = await context.service.scan();
        assert.strictEqual(scanResult.trackCount, 2);

        const tracksResponse = await request('/api/library/tracks');
        assert.strictEqual(tracksResponse.status, 200);
        const tracks = JSON.parse(tracksResponse.body.toString());
        assert.strictEqual(tracks.total, 2);

        const withArt = tracks.items.find((track) => track.title === 'With Art');
        const withoutArt = tracks.items.find((track) => track.title === 'No Art');

        const single = await request('/api/library/tracks/' + withArt.id);
        assert.strictEqual(single.status, 200);
        assert.strictEqual(JSON.parse(single.body.toString()).id, withArt.id);

        assert.strictEqual((await request('/api/library/tracks/missing-id')).status, 404);

        const albums = JSON.parse((await request('/api/library/albums')).body.toString());
        assert.strictEqual(albums.total, 1);
        assert.strictEqual(albums.items[0].trackCount, 2);

        const artists = JSON.parse((await request('/api/library/artists')).body.toString());
        assert.strictEqual(artists.total, 1);
        assert.strictEqual(artists.items[0].name, 'Cover Artist');

        const filtered = JSON.parse((await request('/api/library/tracks?albumId=' + albums.items[0].id)).body.toString());
        assert.strictEqual(filtered.total, 2);

        const artwork = await request('/api/library/tracks/' + withArt.id + '/artwork');
        assert.strictEqual(artwork.status, 200);
        assert.strictEqual(artwork.headers['content-type'], 'image/png');
        assert.ok(artwork.body.length > 0);

        const fallback = await request('/api/library/tracks/' + withoutArt.id + '/artwork');
        assert.strictEqual(fallback.status, 200);
        assert.strictEqual(fallback.headers['content-type'], 'image/svg+xml');

        const fullStream = await request(withArt.streamUrl);
        assert.strictEqual(fullStream.status, 200);
        assert.strictEqual(fullStream.headers['accept-ranges'], 'bytes');
        assert.strictEqual(fullStream.headers['content-type'], 'audio/mpeg');
        assert.strictEqual(fullStream.body.length, Number(fullStream.headers['content-length']));

        const ranged = await request(withArt.streamUrl, { headers: { Range: 'bytes=0-49' } });
        assert.strictEqual(ranged.status, 206);
        assert.strictEqual(ranged.body.length, 50);
        assert.ok(ranged.headers['content-range'].startsWith('bytes 0-49/'));

        const badRange = await request(withArt.streamUrl, { headers: { Range: 'bytes=999999999-1000000000' } });
        assert.strictEqual(badRange.status, 416);
        assert.ok(badRange.headers['content-range'].startsWith('bytes */'));

        const traversal = await request('/api/library/tracks/..%2F..%2Fpackage.json/stream');
        assert.strictEqual(traversal.status, 404);

        const wrongMethod = await request('/api/library/tracks', { method: 'POST' });
        assert.strictEqual(wrongMethod.status, 405);

        assert.strictEqual(fullStream.headers['access-control-allow-origin'], undefined);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        context.cleanup();
    }
});

// ============================================
// Artwork on a person's own albums
// ============================================

test('a local artwork file is stored by id and served back', () => {
    const dataDir = makeTempDir('spotifie-userart-');
    try {
        const { UserArtworkStore } = require('../lib/userArtwork');
        const store = new UserArtworkStore({ directory: path.join(dataDir, 'user-artwork') });
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        );

        const stored = store.save(png, 'image/png');
        assert.match(stored.id, /^[0-9a-f]{32}$/, 'the id is generated here, never supplied');
        assert.strictEqual(stored.url, '/api/library/artwork/' + stored.id);

        const found = store.find(stored.id);
        assert.ok(found, 'the file can be found again');
        assert.strictEqual(found.mimeType, 'image/png');
        assert.ok(fs.readFileSync(found.path).equals(png), 'the original bytes are kept');

        // The file lives on this device, under the rebuildable data folder.
        assert.ok(found.path.startsWith(path.join(dataDir, 'user-artwork')));

        // Unknown or hostile ids resolve to nothing at all.
        assert.strictEqual(store.find('../../package.json'), null);
        assert.strictEqual(store.find('not-an-id'), null);
        assert.strictEqual(store.find('0'.repeat(32)), null);

        assert.strictEqual(store.remove(stored.id), true);
        assert.strictEqual(store.find(stored.id), null);
    } finally {
        removeDir(dataDir);
    }
});

test('the artwork store refuses anything that is not a small image', () => {
    const dataDir = makeTempDir('spotifie-userart-');
    try {
        const { UserArtworkStore } = require('../lib/userArtwork');
        const store = new UserArtworkStore({ directory: path.join(dataDir, 'user-artwork') });

        assert.throws(() => store.save(Buffer.from('<b>x</b>'), 'text/html'), /Unsupported image type/);
        assert.throws(() => store.save(Buffer.from('x'), 'application/octet-stream'), /Unsupported image type/);
        assert.throws(() => store.save(Buffer.alloc(0), 'image/png'), /No image data/);
        assert.throws(() => store.save(Buffer.alloc(3 * 1024 * 1024), 'image/png'), /larger than 2 MB/);

        // Nothing was written for any of those attempts.
        const written = fs.existsSync(path.join(dataDir, 'user-artwork'))
            ? fs.readdirSync(path.join(dataDir, 'user-artwork'))
            : [];
        assert.deepStrictEqual(written, []);
    } finally {
        removeDir(dataDir);
    }
});

test('the player resolves album covers through one shared function', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // One resolver and one painter, asked by the card, the album view, the
    // playbar, Now Playing and both dialogs alike.
    assert.match(player, /function albumCoverSrcNow\(info\)/);
    assert.match(player, /async function resolveAlbumArtwork\(info, folder\)/);
    assert.match(player, /function paintAlbumArtwork\(image, info, folder\)/);
    assert.match(player, /const coverSrc = albumCoverSrcNow\(info\);/);

    // Every place a cover is shown hands its element to that one painter.
    const painted = player.match(/paintAlbumArtwork\(/g) || [];
    assert.ok(painted.length >= 5, 'the painter is what draws a cover, everywhere');

    // A filesystem path is never handed to the browser, and neither is a
    // handle from a previous visit or a picture written into the page.
    assert.match(player, /function looksLikeFilePath\(value\)/);
    assert.match(player, /if \(looksLikeFilePath\(cover\)\) return null;/);
    assert.match(player, /if \(cover\.startsWith\('blob:'\) \|\| cover\.startsWith\('data:'\)\) return null;/);

    // A cover that cannot load falls back rather than showing a broken image,
    // and the handler stays in place so a second failure is caught as well.
    assert.match(player, /image\.onerror = \(\) => \{[\s\S]{0,200}showDefaultArtwork\(image\);/);
    assert.match(player, /function showDefaultArtwork\(image\) \{[\s\S]{0,200}image\.src = defaultCoverSrc\(\);/);
});

test('a chosen cover is stored on this device, never inline and never remotely', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The file goes to the local artwork endpoint; the album keeps its URL.
    assert.match(player, /async function saveLocalAlbumArtwork\(file\)/);
    assert.match(player, /fetch\('\/api\/library\/artwork', \{[\s\S]{0,200}method: 'POST'/);
    assert.match(player, /editImageData = await saveLocalAlbumArtwork\(file\);/);
    assert.match(player, /saveLocalAlbumArtwork\(file\)\s*\n\s*\.then\(\(url\) => \{\s*\n\s*currentImageData = url;/);

    // No Base64, and no blob address is ever persisted.
    assert.ok(!/readAsDataURL/.test(player), 'artwork is never read as a data URL');
    assert.ok(!/cover:\s*createPreviewObjectUrl|cover:\s*editPreviewObjectUrl/.test(player), 'no blob: address is saved');

    // Preview URLs are temporary and released.
    assert.match(player, /createPreviewObjectUrl = URL\.createObjectURL\(file\);/);
    assert.match(player, /editPreviewObjectUrl = URL\.createObjectURL\(file\);/);
    assert.match(player, /function releaseCreatePreview\(\)[\s\S]{0,200}URL\.revokeObjectURL/);
    assert.match(player, /function releaseEditPreview\(\)[\s\S]{0,200}URL\.revokeObjectURL/);

    // Nothing in the player uploads artwork to Supabase.
    assert.ok(!/storage\.from/.test(player), 'the player never touches Supabase Storage');
});

test('editing an album leaves an untouched cover exactly as it was', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The cover is only part of the save when it was actually changed, so a
    // rename or a description edit cannot clear or rewrite it.
    assert.match(player, /let newCover = undefined;\s*\n\s*if \(imageChanged\) \{\s*\n\s*newCover = editImageData;/);
    // And what is kept is a reference that will still mean something later,
    // never a resolved address that would expire while it sat in storage.
    assert.match(player, /if \(newCover !== undefined\) \{[\s\S]{0,300}stableArtworkReference\(newCover\)/);

    // Cancelling a replacement restores the saved cover and changes nothing.
    assert.match(player, /const cancellingReplacement = Boolean\(editPreviewObjectUrl\);/);
    assert.match(player, /if \(cancellingReplacement\) \{[\s\S]{0,200}imageChanged = false;[\s\S]{0,120}restoreExistingEditCover\(\);/);

    // Removing a saved cover is a deliberate change that takes effect on save.
    assert.match(player, /editImageData = null;\s*\n\s*imageChanged = true;/);
});

test('editing a published album from the listener side stays personal', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');

    // The dialog opens for a published album, and says who the change is for.
    assert.ok(!player.includes('can only be edited from the dashboard'), 'the old block is gone');
    assert.match(player, /if \(info\.source === 'global' && !requireAccount\('Sign in to personalise this album'\)\) return;/);
    assert.match(player, /Changes are saved only for you on this device\./);

    // Saving a published album takes a separate path that writes to this
    // account's own state, never to the shared catalogue.
    assert.match(
        player,
        /async function saveEditedAlbum\([\s\S]{0,400}if \(info\.source === 'global'\) \{[\s\S]{0,200}await savePersonalAlbumEdits\(/
    );
    assert.match(player, /client\.setAlbumOverride\(info\.albumId,/);
    assert.match(player, /async function resetPersonalAlbumEdits\(folder\)/);

    // Nothing in the player can write to the shared catalogue or its storage.
    assert.ok(!/createGlobalAlbum|updateGlobalAlbum|deleteGlobalAlbum|deleteGlobalTrack/.test(player), 'no catalogue write from the player');
    assert.ok(!/storage\.from|catalog-artwork/.test(player), 'no global storage access from the player');
});

test('the local artwork endpoints serve and refuse the right things', async (t) => {
    const musicRoot = makeTempDir('spotifie-artwork-music-');
    const dataDir = makeTempDir('spotifie-artwork-data-');

    const { createLibraryRoutes } = require('../lib/libraryRoutes');
    const { UserArtworkStore } = require('../lib/userArtwork');
    const { LibraryService } = require('../lib/libraryService');
    const { LibraryIndex } = require('../lib/libraryIndex');
    const { LocalFileSystemAdapter } = require('../lib/adapters/localFileSystemAdapter');

    const routes = createLibraryRoutes({
        service: new LibraryService({
            musicRoot,
            adapter: new LocalFileSystemAdapter({ musicRoot }),
            index: new LibraryIndex(path.join(dataDir, 'library.json')),
            artworkDir: path.join(dataDir, 'artwork'),
            dataDir
        }),
        artworkStore: new UserArtworkStore({ directory: path.join(dataDir, 'user-artwork') })
    });

    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const handled = await routes.handle(req, res, parsed.pathname, {});
        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        }
    });

    const port = await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

    t.after(() => {
        server.close();
        removeDir(musicRoot);
        removeDir(dataDir);
    });

    function send(pathname, options) {
        const settings = options || {};
        return new Promise((resolve, reject) => {
            const request = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: pathname,
                    method: settings.method || 'GET',
                    headers: settings.headers || {}
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
                }
            );
            request.on('error', reject);
            request.end(settings.body);
        });
    }

    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
    );

    const upload = await send('/api/library/artwork', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: png
    });
    assert.strictEqual(upload.status, 201);

    const stored = JSON.parse(upload.body.toString());
    assert.match(stored.url, /^\/api\/library\/artwork\/[0-9a-f]{32}$/, 'a same-origin URL, not a path');

    const fetched = await send(stored.url);
    assert.strictEqual(fetched.status, 200);
    assert.strictEqual(fetched.headers['content-type'], 'image/png');
    assert.ok(fetched.body.equals(png), 'the same image comes back');

    // Missing and hostile ids answer with the default cover, never an error
    // page and never a file from elsewhere on the machine.
    for (const attempt of ['/api/library/artwork/' + '0'.repeat(32), '/api/library/artwork/..%2F..%2Fpackage.json']) {
        const response = await send(attempt);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers['content-type'], 'image/svg+xml', attempt + ' falls back to the placeholder');
        assert.ok(!response.body.toString().includes('"name"'), 'no project file is served');
    }

    // Only small images are accepted.
    assert.strictEqual(
        (await send('/api/library/artwork', { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: Buffer.from('<b>x</b>') })).status,
        415
    );
    assert.strictEqual(
        (await send('/api/library/artwork', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(3 * 1024 * 1024) })).status,
        413
    );

    // The rest of the library API is unaffected.
    assert.strictEqual((await send('/api/library/tracks')).status, 200);
});
