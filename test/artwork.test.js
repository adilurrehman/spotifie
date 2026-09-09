'use strict';

/**
 * What an album looks like.
 *
 * Four kinds of album reach the same resolver: one an administrator published,
 * one somebody made here, the collection of everything found on this device,
 * and a published album a listener has given their own cover. They differ in
 * where the picture comes from and in nothing else - and none of them may ever
 * put a place on a disk, an expired address, a handle from a previous visit or
 * a picture written into the page in front of a listener.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLAYER_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'script.js'), 'utf8');

/** The artwork section, on its own. */
function artworkSource() {
    const start = PLAYER_SOURCE.indexOf('// ==================== What an album looks like ====================');
    const end = PLAYER_SOURCE.indexOf('/**\n * Store an image for one of this person');
    assert.ok(start !== -1 && end > start, 'the artwork section was found');
    return PLAYER_SOURCE.slice(start, end);
}

// ============================================
// A stand-in for the page
// ============================================

function makeImage() {
    return {
        dataset: {},
        src: '',
        alt: '',
        onerror: null,
        /** What the browser does when a picture will not load. */
        fail() {
            if (this.onerror) this.onerror();
        }
    };
}

/**
 * Load the resolver with a catalogue: the albums the page knows about, the
 * songs in them, and a client that signs a published album's artwork.
 */
function buildArtwork(options) {
    const settings = options || {};
    const asked = [];
    const forgotten = [];
    const imaged = [];

    const sandbox = {
        console: { warn() {}, error() {}, log() {} },
        Promise: Promise,
        Boolean: Boolean,
        String: String,
        basePath: '',
        albumInfo: settings.albums || {},
        predefinedSongs: settings.songs || {},
        currentFolder: '',
        window: { currentPlayingAlbum: null },
        asked: asked,
        forgotten: forgotten,
        imaged: imaged,
        signedUrl: settings.signedUrl
    };

    sandbox.getLibraryTrack = (id) => (settings.tracks || {})[id] || null;

    // The song resolver sits in the section below this one; it answers in the
    // same order the real one does.
    sandbox.trackArtworkSrc = (trackId, folder) => {
        const track = sandbox.getLibraryTrack(trackId);
        const own = track ? sandbox.usableArtworkUrl(track.artworkUrl) : null;
        if (own) return own;

        if (track && track.albumId) {
            const album = sandbox.albumInfo[sandbox.libraryFolderForAlbum(track.albumId)];
            const cover = sandbox.albumCoverIfAny(album);
            if (cover) return cover;
        }

        const playing = sandbox.albumCoverIfAny(sandbox.albumInfo[folder]);
        return playing || sandbox.defaultCoverSrc();
    };
    sandbox.libraryFolderForAlbum = (albumId) => 'library/' + albumId;
    sandbox.getCatalogClient = () => {
        if (settings.noClient) return null;

        const client = {
            resolveArtworkUrl(id, opts) {
                asked.push({ id: id, kind: opts.kind });
                if (settings.artworkFails) return Promise.reject(new Error('gone'));
                // The sandbox may change this between attempts, the way a
                // fresh address differs from an expired one.
                const url = sandbox.signedUrl;
                return Promise.resolve(url === undefined ? null : url);
            },
            forgetArtwork(id) {
                forgotten.push(id);
            }
        };

        // Where this origin serves a published cover. The real client works
        // this out the same way: no request, just an address that names which
        // picture is wanted.
        if (!settings.noImageRoute) {
            client.artworkImageUrl = (id, opts) => {
                const settings2 = opts || {};
                imaged.push({ id: id, kind: settings2.kind, version: settings2.version || null });

                const kind = settings2.kind === 'album' ? 'albums' : 'tracks';
                const url = '/api/catalog/' + kind + '/' + encodeURIComponent(id) + '/artwork/image';
                return settings2.version ? url + '?v=' + encodeURIComponent(settings2.version) : url;
            };
        }

        return client;
    };

    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(artworkSource(), sandbox);
    return sandbox;
}

const DEFAULT = 'img/music.svg';

// ============================================
// What may be shown, and what may not
// ============================================

test('a reference is shown only when the browser can load it as a picture', () => {
    const art = buildArtwork({});

    assert.strictEqual(art.usableArtworkUrl('/api/library/artwork/abc'), '/api/library/artwork/abc');
    assert.strictEqual(art.usableArtworkUrl('img/cover.jpg'), 'img/cover.jpg');
    assert.strictEqual(art.usableArtworkUrl('https://example.test/cover.jpg'), 'https://example.test/cover.jpg');

    // An endpoint that answers with a signed address in JSON is a reference to
    // resolve, not something to point a picture at.
    assert.strictEqual(art.usableArtworkUrl('/api/catalog/albums/abc/artwork'), null);

    // Its neighbour answers with the picture itself, from this origin, and
    // names which picture it is - so it may be pointed at directly and the
    // browser is free to keep what it fetches.
    assert.strictEqual(
        art.usableArtworkUrl('/api/catalog/albums/abc/artwork/image'),
        '/api/catalog/albums/abc/artwork/image'
    );
    assert.strictEqual(
        art.usableArtworkUrl('/api/catalog/albums/abc/artwork/image?v=beef'),
        '/api/catalog/albums/abc/artwork/image?v=beef'
    );

    // A place on a disk, from a version that kept them.
    assert.strictEqual(art.usableArtworkUrl('C:\\Users\\me\\cover.jpg'), null);
    assert.strictEqual(art.usableArtworkUrl('\\\\server\\share\\cover.jpg'), null);
    assert.strictEqual(art.usableArtworkUrl('file:///home/me/cover.jpg'), null);

    // A handle that only meant something in a previous visit.
    assert.strictEqual(art.usableArtworkUrl('blob:http://localhost/9a8b'), null);

    // A picture written into the page itself.
    assert.strictEqual(art.usableArtworkUrl('data:image/png;base64,iVBORw0KGgo='), null);

    // Nothing at all.
    assert.strictEqual(art.usableArtworkUrl(''), null);
    assert.strictEqual(art.usableArtworkUrl(null), null);
});

test('an album with nothing showable is drawn with the default, never a blank', () => {
    const art = buildArtwork({});

    assert.strictEqual(art.albumCoverSrcNow(null), DEFAULT);
    assert.strictEqual(art.albumCoverSrcNow({}), DEFAULT);
    assert.strictEqual(art.albumCoverSrcNow({ cover: 'blob:http://localhost/1' }), DEFAULT);
    assert.strictEqual(art.albumCoverSrcNow({ cover: 'C:\\covers\\a.jpg' }), DEFAULT);
});

// ============================================
// Each kind of album
// ============================================

test('an album somebody made here shows the cover they gave it', async () => {
    const info = { source: 'local', albumId: 'local-album:mine', cover: '/api/library/artwork/' + 'a'.repeat(32) };
    const art = buildArtwork({});

    assert.strictEqual(art.albumCoverSrcNow(info), info.cover, 'and shows it at once');
    assert.strictEqual(await art.resolveAlbumArtwork(info, 'library/local-album:mine'), info.cover);
    assert.strictEqual(art.asked.length, 0, 'nothing had to be fetched');
});

test('a published album is read from this origin, by which picture it is', async () => {
    const info = {
        source: 'global',
        albumId: 'global-album:1111',
        // What the catalogue hands over: an endpoint, not a picture.
        cover: '/api/catalog/albums/global-album:1111/artwork',
        hasArtwork: true,
        artworkVersion: 'c0ffee'
    };
    const art = buildArtwork({ signedUrl: 'https://storage.test/cover.jpg?token=fresh' });

    // Nothing to show yet, so the default holds the space.
    assert.strictEqual(art.albumCoverSrcNow(info), DEFAULT);

    const resolved = await art.resolveAlbumArtwork(info, 'library/global-album:1111');

    // This origin, and the version of the picture in the address: the same
    // cover is always the same address, so a browser that already has it does
    // not fetch it again.
    assert.strictEqual(resolved, '/api/catalog/albums/global-album%3A1111/artwork/image?v=c0ffee');
    assert.strictEqual(art.asked.length, 0, 'nothing was signed to find it');
    assert.deepStrictEqual(Array.from(art.imaged, (entry) => entry.id), ['global-album:1111']);
    assert.strictEqual(art.imaged[0].kind, 'album');
    assert.strictEqual(art.imaged[0].version, 'c0ffee');
});

test('a published cover is the same address every time, and carries no signature', async () => {
    const info = { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true, artworkVersion: 'aa11' };
    const art = buildArtwork({ signedUrl: 'https://storage.test/cover.jpg?token=one' });

    const first = await art.resolveAlbumArtwork(info, 'library/global-album:1111');
    const second = await art.resolveAlbumArtwork(info, 'library/global-album:1111');

    // The same answer twice, because the answer does not depend on when it was
    // asked. There is no signature to expire and nothing to go stale.
    assert.strictEqual(first, second);
    assert.doesNotMatch(first, /token=|X-Amz|Signature/i, 'nothing signed is handed to the page');
    assert.strictEqual(info.cover, '', 'and nothing was written back onto the album');

    // A cover that has been replaced is a different address, so the one the
    // browser kept is never shown in its place.
    const replaced = Object.assign({}, info, { artworkVersion: 'bb22' });
    assert.notStrictEqual(await art.resolveAlbumArtwork(replaced, 'library/global-album:1111'), first);

    // The section holds no store of addresses at all.
    const source = artworkSource();
    assert.ok(!/localStorage|sessionStorage/.test(source), 'no address is kept in the browser');
});

test('a published album a listener has re-covered shows their picture, not the published one', async () => {
    // The override arrives as the album's cover, with the album still marked
    // as published - which used to send the resolver to fetch the shared one.
    const info = {
        source: 'global',
        albumId: 'global-album:1111',
        cover: '/api/library/artwork/' + 'b'.repeat(32),
        hasArtwork: true,
        hasLocalEdits: true
    };
    const art = buildArtwork({ signedUrl: 'https://storage.test/published.jpg' });

    assert.strictEqual(art.albumCoverSrcNow(info), info.cover, 'their own picture shows at once');
    assert.strictEqual(await art.resolveAlbumArtwork(info, 'library/global-album:1111'), info.cover);
    assert.strictEqual(art.asked.length, 0, 'the published picture is never fetched over it');
});

test('a collection with no cover of its own borrows the first picture in it', async () => {
    const folder = 'library/system:local-music';
    const art = buildArtwork({
        albums: { [folder]: { source: 'local', albumId: 'system:local-music', cover: '' } },
        songs: { [folder]: ['local:one', 'local:two'] },
        tracks: {
            'local:one': { artworkUrl: '' },
            'local:two': { artworkUrl: '/api/library/artwork/tracks/two' }
        }
    });

    const resolved = await art.resolveAlbumArtwork(art.albumInfo[folder], folder);
    assert.strictEqual(resolved, '/api/library/artwork/tracks/two');
});

test('an album with no picture anywhere ends at the default', async () => {
    const folder = 'library/local-album:empty';
    const art = buildArtwork({
        albums: { [folder]: { source: 'local', albumId: 'local-album:empty', cover: '' } },
        songs: { [folder]: ['local:one'] },
        tracks: { 'local:one': { artworkUrl: '' } }
    });

    assert.strictEqual(await art.resolveAlbumArtwork(art.albumInfo[folder], folder), DEFAULT);
});

test('a published album that has no picture is not asked about', async () => {
    const info = { source: 'global', albumId: 'global-album:2222', cover: '', hasArtwork: false };
    const art = buildArtwork({ signedUrl: 'https://storage.test/cover.jpg' });

    assert.strictEqual(await art.resolveAlbumArtwork(info, 'library/global-album:2222'), DEFAULT);
    assert.strictEqual(art.asked.length, 0, 'a round trip for a picture that is not there is wasted');
});

test('a client that does not know the picture address falls back to signing one', async () => {
    const info = { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true };
    const art = buildArtwork({ noImageRoute: true, signedUrl: 'https://storage.test/cover.jpg?token=old' });

    // A page left open from before this address existed still shows covers:
    // it asks for a signed one, the way it always did.
    assert.strictEqual(
        await art.resolveAlbumArtwork(info, 'library/global-album:1111'),
        'https://storage.test/cover.jpg?token=old'
    );
    assert.strictEqual(art.asked.length, 1);
});

test('a picture that can be neither addressed nor signed falls back rather than failing', async () => {
    const info = { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true };
    const art = buildArtwork({ noImageRoute: true, artworkFails: true });

    assert.strictEqual(await art.resolveAlbumArtwork(info, 'library/global-album:1111'), DEFAULT);
});

// ============================================
// Painting one element
// ============================================

test('a picture is shown at once and replaced when a better one arrives', async () => {
    const info = { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true, artworkVersion: 'v1' };
    const art = buildArtwork({});

    const image = makeImage();
    art.paintAlbumArtwork(image, info, 'library/global-album:1111');

    // Nothing is ever left blank while something is being fetched.
    assert.strictEqual(image.src, DEFAULT, 'the default holds the space');

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
        image.src,
        '/api/catalog/albums/global-album%3A1111/artwork/image?v=v1',
        'and the real one takes over'
    );
});

test('a picture that will not load falls back, and is never left broken', async () => {
    const info = { source: 'local', albumId: 'local-album:mine', cover: '/api/library/artwork/' + 'c'.repeat(32) };
    const art = buildArtwork({});

    const image = makeImage();
    art.paintAlbumArtwork(image, info, 'library/local-album:mine');

    // Nothing is ever given an unresolved source: the default holds the space.
    assert.strictEqual(image.src, DEFAULT);

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.src, info.cover, 'the real picture takes over');

    // The file has gone from this device since it was chosen.
    image.fail();
    assert.strictEqual(image.src, DEFAULT, 'a missing picture is not a broken one');

    // It is tried once more, in case the address had merely expired; the same
    // address comes back, so the default stands.
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.src, DEFAULT);

    // And a second failure is still caught, rather than leaving the browser's
    // own broken-picture mark on screen.
    assert.strictEqual(typeof image.onerror, 'function', 'the handler is still in place');
    image.fail();
    assert.strictEqual(image.src, DEFAULT);
});

test('a picture that failed is dropped from what the client remembers', async () => {
    const info = { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true, artworkVersion: 'v1' };
    const art = buildArtwork({});

    const image = makeImage();
    art.paintAlbumArtwork(image, info, 'library/global-album:1111');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.src, '/api/catalog/albums/global-album%3A1111/artwork/image?v=v1');

    // The picture would not load. Whatever was remembered about it goes, and
    // the default holds the space rather than a broken mark.
    image.fail();
    assert.deepStrictEqual(art.forgotten, ['global-album:1111']);
    assert.strictEqual(image.src, DEFAULT, 'a picture that will not load is not left broken');

    // It is tried once more. The address is the same one - it names a picture
    // rather than a moment - so the default stands.
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.src, DEFAULT);
});

test('a picture is retried once, and only once', async () => {
    const info = { source: 'local', albumId: 'local-album:mine', cover: '/api/library/artwork/' + 'e'.repeat(32) };
    const art = buildArtwork({});

    const image = makeImage();
    art.paintAlbumArtwork(image, info, 'library/local-album:mine');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.src, info.cover);

    // It failed, so the picture is looked up again - and the album now has a
    // different one, which is shown.
    info.cover = '/api/library/artwork/' + 'f'.repeat(32);
    image.fail();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.src, info.cover);

    // The second one fails as well: this time the default stands rather than
    // the page asking again for ever.
    info.cover = '/api/library/artwork/' + '9'.repeat(32);
    image.fail();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.src, DEFAULT, 'one retry, then the default');
});

test('an answer that arrives after the page has moved on is discarded', async () => {
    const first = { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true };
    const second = { source: 'local', albumId: 'local-album:other', cover: '/api/library/artwork/' + 'd'.repeat(32) };
    const art = buildArtwork({ signedUrl: 'https://storage.test/first.jpg' });

    const image = makeImage();

    // One album is asked about, and the listener opens another before the
    // answer to the first comes back.
    art.paintAlbumArtwork(image, first, 'library/global-album:1111');
    art.paintAlbumArtwork(image, second, 'library/local-album:other');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(image.src, second.cover, 'the album on screen is the one shown');
    assert.notStrictEqual(image.src, 'https://storage.test/first.jpg');
});

test('a song is painted with its own picture, then its album, then the default', async () => {
    const folder = 'library/system:local-music';
    const art = buildArtwork({
        albums: {
            [folder]: { source: 'local', albumId: 'system:local-music', cover: '' },
            'library/global-album:1111': {
                source: 'global',
                albumId: 'global-album:1111',
                cover: '',
                hasArtwork: true,
                artworkVersion: 'alb1'
            }
        },
        tracks: {
            'local:own': { artworkUrl: '/api/library/artwork/tracks/own', albumId: 'system:local-music' },
            'global:none': { artworkUrl: '', albumId: 'global-album:1111', metadata: { hasArtwork: false } }
        }
    });

    // Its own picture, and nothing fetched.
    const withOwn = makeImage();
    art.paintTrackArtwork(withOwn, 'local:own', folder);
    assert.strictEqual(withOwn.src, DEFAULT, 'the default holds the space meanwhile');

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(withOwn.src, '/api/library/artwork/tracks/own');
    assert.strictEqual(art.asked.length, 0, 'a picture it already carries needs no asking');

    // None of its own: the album it belongs to is asked for, and swapped in.
    const borrowed = makeImage();
    art.paintTrackArtwork(borrowed, 'global:none', folder);
    assert.strictEqual(borrowed.src, DEFAULT, 'the default holds the space meanwhile');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(borrowed.src, '/api/catalog/albums/global-album%3A1111/artwork/image?v=alb1');
});

// ============================================
// One resolver, asked by everything
// ============================================

test('every place a cover is drawn hands its element to the one painter', () => {
    // The card grid, the album view, the playbar, Now Playing and both
    // dialogs. None of them chooses a picture itself.
    const painted = PLAYER_SOURCE.match(/paintAlbumArtwork\(/g) || [];
    assert.ok(painted.length >= 5, 'the album painter is used throughout');

    const tracks = PLAYER_SOURCE.match(/paintTrackArtwork\(/g) || [];
    assert.ok(tracks.length >= 3, 'and the song painter is too');

    // The resolver that was duplicated is gone.
    assert.ok(!/function resolveAlbumCoverSrc/.test(PLAYER_SOURCE), 'there is one resolver, not two');
});

test('no part of the page chooses a picture for itself any more', () => {
    // Every <img> that shows a cover either goes through a painter or carries
    // the fallback inline in its markup; none takes a stored reference and
    // hands it straight to the browser.
    const resolved = /(albumCoverSrcNow|trackArtworkSrc|coverSrc|artwork|basePath)/;
    const raw = (PLAYER_SOURCE.match(/src="\$\{[^}]*\}/g) || []).filter((tag) => !resolved.test(tag));
    assert.deepStrictEqual(raw, [], 'no reference is rendered unresolved');

    // And every one of those markups names the default if it cannot load.
    const covers = PLAYER_SOURCE.match(/<img[^>]*src="\$\{[^"]*"[^>]*>/g) || [];
    covers.forEach((tag) => {
        if (!/coverSrc|artwork|albumCoverSrcNow|trackArtworkSrc/.test(tag)) return;
        assert.match(tag, /onerror=/, 'a cover that cannot load falls back: ' + tag.slice(0, 80));
    });
});

test('the dialogs and the lists ask the same painter as the grid', () => {
    // The edit dialog, the create dialog, the album view, the card grid and
    // the search results: five callers, one painter.
    const callers = ['imagePreview, info, folder', "cover, info, folder", "item.querySelector('img'), info, folder"];
    callers.forEach((call) => {
        assert.ok(PLAYER_SOURCE.includes('paintAlbumArtwork(' + call + ')'), 'painted through the shared painter: ' + call);
    });

    // Nothing wires a fallback of its own beside the painter's.
    assert.ok(!/imagePreview\.onerror = \(\) =>/.test(PLAYER_SOURCE), 'the dialog does not keep its own fallback');
});

// ============================================
// Nothing temporary is ever written down
// ============================================

test('a resolved address is refused wherever a cover is stored', () => {
    const art = buildArtwork({});

    // What may be kept: an id this machine serves, and the endpoint that will
    // sign a published cover afresh.
    assert.strictEqual(
        art.stableArtworkReference('/api/library/artwork/' + 'a'.repeat(32)),
        '/api/library/artwork/' + 'a'.repeat(32)
    );
    assert.strictEqual(
        art.stableArtworkReference('/api/catalog/albums/global-album:1/artwork'),
        '/api/catalog/albums/global-album:1/artwork'
    );

    // What may not: a signed address, whether it is written as somewhere else
    // entirely or merely carries the signature.
    assert.strictEqual(art.stableArtworkReference('https://storage.test/cover.jpg?token=abc'), null);
    assert.strictEqual(art.stableArtworkReference('https://storage.test/cover.jpg'), null);
    assert.strictEqual(art.stableArtworkReference('/api/library/artwork/abc?ticket=xyz'), null);
    assert.strictEqual(art.stableArtworkReference('//storage.test/cover.jpg'), null);

    // And nothing that was never a reference.
    assert.strictEqual(art.stableArtworkReference('blob:http://localhost/1'), null);
    assert.strictEqual(art.stableArtworkReference('data:image/png;base64,iVBOR'), null);
    assert.strictEqual(art.stableArtworkReference('C:\covers\a.jpg'), null);
    assert.strictEqual(art.stableArtworkReference(''), null);
});

test('resolving a picture never writes the answer back onto the album', async () => {
    const info = { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true, artworkVersion: 'abc' };
    const art = buildArtwork({});

    const before = JSON.stringify(info);
    const url = await art.resolveArtwork({ info: info, folder: 'library/global-album:1111' });

    assert.strictEqual(url, '/api/catalog/albums/global-album%3A1111/artwork/image?v=abc');
    assert.strictEqual(JSON.stringify(info), before, 'the album is exactly as it was');
});

test('the resolver keeps nothing of its own between asks', () => {
    const source = artworkSource();

    // The one memory of a resolved address is the catalogue client's, which
    // expires; nothing here holds one.
    assert.ok(!/localStorage|sessionStorage/.test(source), 'nothing is written to the browser');
    assert.ok(!/artworkCache|coverCache|resolvedUrls/.test(source), 'the resolver keeps no store of its own');

    // And it never writes an answer onto what it was asked about.
    assert.ok(!/info\.cover\s*=/.test(source), 'an album is never given the address that was resolved for it');
    assert.ok(!/track\.artworkUrl\s*=/.test(source), 'nor is a song');
});

// ============================================
// One song, one album, one answer
// ============================================

test('the one resolver answers for a song and for an album alike', async () => {
    const folder = 'library/global-album:1111';
    const cover = '/api/catalog/albums/global-album%3A1111/artwork/image?v=one';
    const art = buildArtwork({
        albums: {
            [folder]: {
                source: 'global',
                albumId: 'global-album:1111',
                cover: '',
                hasArtwork: true,
                artworkVersion: 'one'
            }
        },
        tracks: {
            'global:song': { artworkUrl: '', albumId: 'global-album:1111', source: 'global', metadata: { hasArtwork: false } }
        }
    });

    // Asked about the song: it has none of its own, so its album answers.
    assert.strictEqual(await art.resolveArtwork({ trackId: 'global:song', folder: folder }), cover);

    // Asked about the album: the same answer, by the same route.
    assert.strictEqual(await art.resolveArtwork({ info: art.albumInfo[folder], folder: folder }), cover);

    // A song that carries its own is never asked about at all.
    assert.strictEqual(await art.resolveArtwork({ trackId: 'nothing:here', folder: null }), null);
});

test('a song shows nothing of another song while its own is being found', async () => {
    const folder = 'library/global-album:1111';
    const art = buildArtwork({
        albums: { [folder]: { source: 'global', albumId: 'global-album:1111', cover: '', hasArtwork: true } },
        tracks: {
            'global:one': { artworkUrl: '', albumId: 'global-album:1111', source: 'global', metadata: { hasArtwork: false } },
            'local:two': { artworkUrl: '/api/library/artwork/two', albumId: 'local-album:two' }
        },
        signedUrl: 'https://storage.test/album.jpg'
    });

    const image = makeImage();

    // The track changes before the first answer arrives.
    art.paintTrackArtwork(image, 'global:one', folder);
    art.paintTrackArtwork(image, 'local:two', folder);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(image.src, '/api/library/artwork/two', 'the song being played is the one shown');
});
