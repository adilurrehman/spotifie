'use strict';

/**
 * Checking the shared catalogue for things that have come apart.
 *
 * Four kinds of trouble are possible between a database of rows and a bucket
 * of files, and each is worth knowing about:
 *
 * - a track whose audio is not in the bucket. The row plays nothing;
 * - a row pointing at artwork that is not there. The album shows the default
 *   cover and nobody can tell why;
 * - a file in the bucket that no row mentions. It costs storage and will never
 *   be played;
 * - a track belonging to an album that does not exist. It appears nowhere.
 *
 * This finds them and says so. It does not fix them.
 *
 * That restraint is the point. Every one of these has an innocent explanation -
 * an upload finishing a second after the audit read the bucket, a publish
 * halfway done, a migration in progress - and a tidy-up that deleted on its
 * own judgement would eventually delete somebody's music. So the audit reports,
 * an administrator reads, and anything destructive is a separate act with the
 * consequence written on it.
 *
 * Administrator-only, and part of the private half of the server: the public
 * release does not ship this file, and the route that uses it is absent there.
 */

const { listStorageObjects } = require('./supabaseRest');

/** How much of a bucket one audit will look at. */
const MAX_OBJECTS = 5000;

/** How many findings of one kind are listed before the count speaks for them. */
const MAX_REPORTED = 200;

/**
 * Everything in a bucket, as a set of object paths.
 *
 * Supabase lists one folder at a time, so folders are followed. An entry with
 * no id is a folder rather than a file - that is how the listing distinguishes
 * them.
 */
async function readBucket(bucket, token, list) {
    const objects = new Set();
    const pending = [''];

    while (pending.length && objects.size < MAX_OBJECTS) {
        const prefix = pending.shift();

        let page;
        try {
            page = await list(bucket, { prefix: prefix, limit: 1000 }, token);
        } catch (err) {
            // A bucket that cannot be read is reported as unread rather than
            // as empty: treating "could not look" as "nothing there" would
            // make every file in it an orphan.
            return { objects: objects, complete: false, error: err.message };
        }

        for (const entry of page) {
            if (!entry || !entry.name) continue;

            const full = prefix ? prefix + '/' + entry.name : entry.name;

            if (entry.id) objects.add(full);
            else pending.push(full);

            if (objects.size >= MAX_OBJECTS) break;
        }
    }

    return { objects: objects, complete: objects.size < MAX_OBJECTS, error: null };
}

/**
 * What is wrong with the shared catalogue, if anything.
 *
 * Nothing is changed. What comes back is a description, and every part of it
 * says how sure it is: a row pointing at a file that is not in the bucket is a
 * fact, while a file no row mentions is only a candidate - the row that
 * mentions it may be being written as this runs.
 */
async function auditCatalogue(options) {
    const settings = options || {};
    const global = settings.global;
    const token = settings.token || null;
    const list = settings.listStorageObjects || listStorageObjects;

    const catalogue = await global.fetchCatalog(token);
    if (!catalogue.available) {
        return {
            available: false,
            error: catalogue.error,
            checkedAt: new Date().toISOString()
        };
    }

    // The rows, with the object paths they name. Paths stay inside the audit:
    // what leaves is a count and enough of a name to recognise a track by.
    const rows = await settings.readRows(token);

    const audio = await readBucket(global.audioBucket, token, list);
    const artwork = await readBucket(global.artworkBucket, token, list);

    const albumIds = new Set(rows.albums.map((album) => album.id));

    const missingAudio = [];
    const missingArtwork = [];
    const orphanedTracks = [];

    for (const track of rows.tracks) {
        if (!track.audio_path) {
            missingAudio.push(describeTrack(track, 'no audio was ever recorded for it'));
        } else if (audio.complete && !audio.objects.has(track.audio_path)) {
            missingAudio.push(describeTrack(track, 'the audio is not in storage'));
        }

        if (track.artwork_path && artwork.complete && !artwork.objects.has(track.artwork_path)) {
            missingArtwork.push(describeTrack(track, 'its artwork is not in storage'));
        }

        if (track.album_id && !albumIds.has(track.album_id)) {
            orphanedTracks.push(describeTrack(track, 'it belongs to an album that no longer exists'));
        }
    }

    for (const album of rows.albums) {
        if (album.artwork_path && artwork.complete && !artwork.objects.has(album.artwork_path)) {
            missingArtwork.push({
                kind: 'album',
                id: album.id,
                title: album.title || 'Untitled',
                reason: 'its cover is not in storage'
            });
        }
    }

    // Files nothing points at. Only worth listing when the bucket was read in
    // full - a partial listing would call everything it did not reach an
    // orphan.
    const referencedAudio = new Set(rows.tracks.map((track) => track.audio_path).filter(Boolean));
    const referencedArtwork = new Set(
        rows.tracks
            .map((track) => track.artwork_path)
            .concat(rows.albums.map((album) => album.artwork_path))
            .filter(Boolean)
    );

    const orphanedAudio = audio.complete ? difference(audio.objects, referencedAudio) : [];
    const orphanedArtwork = artwork.complete ? difference(artwork.objects, referencedArtwork) : [];

    return {
        available: true,
        checkedAt: new Date().toISOString(),
        counts: {
            albums: rows.albums.length,
            tracks: rows.tracks.length,
            audioObjects: audio.objects.size,
            artworkObjects: artwork.objects.size
        },
        // Certain: a row names a file the bucket does not have.
        missingAudio: trim(missingAudio),
        missingArtwork: trim(missingArtwork),
        orphanedTracks: trim(orphanedTracks),
        // Candidates: a file nothing currently names. It may be an upload in
        // progress, so nothing is done about it here.
        orphanedAudio: trim(orphanedAudio.map((path) => ({ objectPath: path }))),
        orphanedArtwork: trim(orphanedArtwork.map((path) => ({ objectPath: path }))),
        // How far the audit could see. A bucket that could not be read in full
        // means its orphan list is not to be trusted, and says so.
        coverage: {
            audioComplete: audio.complete,
            artworkComplete: artwork.complete,
            audioError: audio.error,
            artworkError: artwork.error,
            limit: MAX_OBJECTS
        },
        duplicates: findDuplicates(rows.tracks)
    };
}

/**
 * Catalogue rows that look like the same track published twice.
 *
 * Two rows pointing at the same stored file are certainly duplicates - one
 * upload, two records. Two rows with the same title and artist under one album
 * are probably duplicates, and probably is as far as this goes: a single and
 * an album version share both.
 */
function findDuplicates(tracks) {
    const bySource = new Map();
    const byName = new Map();

    for (const track of tracks) {
        if (track.audio_path) {
            const rows = bySource.get(track.audio_path) || [];
            rows.push(track);
            bySource.set(track.audio_path, rows);
        }

        const key = [
            String(track.album_id || ''),
            String(track.title || '').trim().toLowerCase(),
            String(track.artist || '').trim().toLowerCase()
        ].join('~');

        const rows = byName.get(key) || [];
        rows.push(track);
        byName.set(key, rows);
    }

    const sameFile = [];
    bySource.forEach((rows) => {
        if (rows.length < 2) return;
        sameFile.push({
            kind: 'same-file',
            title: rows[0].title,
            artist: rows[0].artist,
            trackIds: rows.map((row) => row.id)
        });
    });

    const sameName = [];
    byName.forEach((rows) => {
        if (rows.length < 2) return;

        // Already reported as the stronger finding.
        const sources = new Set(rows.map((row) => row.audio_path).filter(Boolean));
        if (sources.size < 2) return;

        sameName.push({
            kind: 'same-name',
            title: rows[0].title,
            artist: rows[0].artist,
            trackIds: rows.map((row) => row.id)
        });
    });

    return { sameFile: trim(sameFile), sameName: trim(sameName) };
}

function describeTrack(track, reason) {
    return {
        kind: 'track',
        id: track.id,
        title: track.title || 'Untitled',
        artist: track.artist || null,
        reason: reason
    };
}

function difference(objects, referenced) {
    const out = [];
    objects.forEach((objectPath) => {
        if (!referenced.has(objectPath)) out.push(objectPath);
    });
    return out;
}

/** Enough to read, with the count kept honest when there is more. */
function trim(items) {
    return { total: items.length, items: items.slice(0, MAX_REPORTED) };
}

module.exports = { auditCatalogue, MAX_OBJECTS, MAX_REPORTED };
