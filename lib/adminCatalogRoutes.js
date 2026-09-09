'use strict';

/**
 * Administrator writes to the shared catalogue.
 *
 * Publishing, editing and permanently deleting global albums and tracks: the
 * operations that change what every listener sees. They are kept in their own
 * module so that a build of the user-facing application can be made simply by
 * not including it - there is then no route to reach, rather than a route that
 * refuses.
 *
 * Every entry point here begins with requireAdmin, which verifies the caller's
 * Supabase session server-side and checks the verified user id against the
 * app_admins table. That is the authorization; the absence of this module from
 * a public build is a separate matter, and neither stands in for the other.
 * Supabase Row Level Security refuses the same writes again on its own side,
 * so a request that somehow reached here without rights would still change
 * nothing.
 */

const { requireAdmin, bearerToken } = require('./adminAuth');
const { auditCatalogue } = require('./adminMaintenance');

/**
 * Build the administrator routes.
 *
 * The helpers come from the public surface rather than being written again
 * here, so an answer from this half looks exactly like an answer from that
 * one.
 */
function createAdminCatalogRoutes(tools) {
    const sendJson = tools.sendJson;
    const readJsonBody = tools.readJsonBody;
    const methodNotAllowed = tools.methodNotAllowed;
    const sourceOf = tools.sourceOf;

    /**
     * Answer true when this request was an administrator route, false when it
     * was not one at all. False means the caller carries on and eventually
     * answers 404, exactly as it would for any unknown path.
     */
    async function handle(req, res, segments, method, service) {
        // What is wrong with the shared catalogue, if anything: rows whose
        // audio or artwork is not in storage, files nothing points at any
        // more, tracks belonging to albums that have gone, and rows that look
        // like the same track published twice.
        //
        // It reports and changes nothing. Every one of these findings has an
        // innocent explanation - an upload finishing a second late, a publish
        // half done - and a tidy-up acting on its own judgement would
        // eventually delete somebody's music. Anything destructive is a
        // separate, deliberate act.
        if (segments[0] === 'admin' && segments[1] === 'maintenance' && segments.length === 2) {
            if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);

            const admin = await requireAdmin(req);
            if (!admin.ok) {
                sendJson(res, admin.status, { error: admin.error });
                return true;
            }

            const token = bearerToken(req);
            try {
                const report = await auditCatalogue({
                    global: service.global,
                    token: token,
                    readRows: (t) => service.global.readRawRows(t)
                });
                sendJson(res, 200, report);
            } catch (err) {
                sendJson(res, 502, { error: 'Could not audit the catalogue: ' + err.message });
            }
            return true;
        }

        if (segments[0] === 'tracks' && segments.length === 2) {
            if (method === 'DELETE') return deleteGlobalTrack(req, res, service, segments[1]);
            return false;
        }

        if (segments[0] === 'albums' && segments.length === 2) {
            if (method === 'DELETE') return deleteGlobalAlbum(req, res, service, segments[1]);
            if (method === 'PATCH') return updateGlobalAlbum(req, res, service, segments[1]);
            return false;
        }

        if (segments[0] === 'admin' && segments[1] === 'albums' && segments.length === 2) {
            if (method !== 'POST') return methodNotAllowed(res);
            return createGlobalAlbum(req, res, service);
        }

        if (segments[0] === 'admin' && segments[1] === 'tracks' && segments.length === 2) {
            if (method !== 'POST') return methodNotAllowed(res);
            return createGlobalTrack(req, res, service);
        }

        if (segments[0] === 'admin' && segments[1] === 'tracks' && segments.length === 3) {
            if (method !== 'PATCH') return methodNotAllowed(res);
            return updateGlobalTrack(req, res, service, segments[2]);
        }

        return false;
    }

    /**
     * Permanent global delete. Verified admin only, twice over: this check, and
     * Supabase RLS when the delete actually runs as the caller.
     */
    async function deleteGlobalTrack(req, res, service, trackId) {
        if (sourceOf(trackId) !== 'global') {
            sendJson(res, 400, {
                error: 'Only global catalogue tracks can be deleted here. Local tracks are removed from your own view with POST /api/catalog/hidden.'
            });
            return true;
        }

        const admin = await requireAdmin(req);
        if (!admin.ok) {
            sendJson(res, admin.status, { error: admin.error });
            return true;
        }

        const result = await service.global.deleteTrack(trackId, bearerToken(req));
        sendJson(res, result.deleted ? 200 : 404, result);
        return true;
    }

    async function deleteGlobalAlbum(req, res, service, albumId) {
        if (sourceOf(albumId) !== 'global') {
            sendJson(res, 400, {
                error: 'Only global catalogue albums can be deleted here. Hiding an album for yourself uses POST /api/catalog/hidden.'
            });
            return true;
        }

        const admin = await requireAdmin(req);
        if (!admin.ok) {
            sendJson(res, admin.status, { error: admin.error });
            return true;
        }

        const result = await service.global.deleteAlbum(albumId, bearerToken(req));
        sendJson(res, result.deleted ? 200 : 404, result);
        return true;
    }

    async function createGlobalAlbum(req, res, service) {
        const admin = await requireAdmin(req);
        if (!admin.ok) {
            sendJson(res, admin.status, { error: admin.error });
            return true;
        }

        const body = await readJsonBody(req);
        if (!body.title) {
            sendJson(res, 400, { error: 'An album title is required' });
            return true;
        }

        const album = await service.global.createAlbum(body, bearerToken(req));
        sendJson(res, 201, withSchemaWarning(album, service, body));
        return true;
    }

    async function updateGlobalAlbum(req, res, service, albumId) {
        const admin = await requireAdmin(req);
        if (!admin.ok) {
            sendJson(res, admin.status, { error: admin.error });
            return true;
        }

        // Each field is patched only when the caller sent it, and each one maps to
        // its own column: editing a description never touches the artist, and
        // editing the artist never touches the description.
        const body = await readJsonBody(req);
        const patch = {};
        if (body.title !== undefined) patch.title = body.title;
        if (body.artist !== undefined) patch.artist = body.artist;
        if (body.albumArtist !== undefined) patch.album_artist = body.albumArtist;
        if (body.description !== undefined) patch.description = body.description === '' ? null : body.description;
        if (body.artworkPath !== undefined) patch.artwork_path = body.artworkPath;

        const album = await service.global.updateAlbum(albumId, patch, bearerToken(req));
        if (!album) {
            sendJson(res, 404, { error: 'Album not found' });
            return true;
        }
        sendJson(res, 200, withSchemaWarning(album, service, body));
        return true;
    }

    async function createGlobalTrack(req, res, service) {
        const admin = await requireAdmin(req);
        if (!admin.ok) {
            sendJson(res, admin.status, { error: admin.error });
            return true;
        }

        const body = await readJsonBody(req);
        if (!body.title || !body.audioPath) {
            sendJson(res, 400, { error: 'A track title and an uploaded audio path are required' });
            return true;
        }

        const track = await service.global.createTrack(body, bearerToken(req));
        sendJson(res, 201, track);
        return true;
    }

    async function updateGlobalTrack(req, res, service, trackId) {
        const admin = await requireAdmin(req);
        if (!admin.ok) {
            sendJson(res, admin.status, { error: admin.error });
            return true;
        }

        const body = await readJsonBody(req);
        const patch = {};
        if (body.title !== undefined) patch.title = body.title;
        if (body.artist !== undefined) patch.artist = body.artist;
        if (body.albumArtist !== undefined) patch.album_artist = body.albumArtist;
        if (body.albumId !== undefined) {
            patch.album_id = body.albumId ? String(body.albumId).replace('global-album:', '') : null;
        }
        if (body.trackNumber !== undefined) patch.track_number = body.trackNumber;
        if (body.discNumber !== undefined) patch.disc_number = body.discNumber;
        if (body.duration !== undefined) patch.duration = body.duration;
        if (body.audioPath !== undefined) patch.audio_path = body.audioPath;
        if (body.artworkPath !== undefined) patch.artwork_path = body.artworkPath;
        if (body.mimeType !== undefined) patch.mime_type = body.mimeType;

        const track = await service.global.updateTrack(trackId, patch, bearerToken(req));
        if (!track) {
            sendJson(res, 404, { error: 'Track not found' });
            return true;
        }
        sendJson(res, 200, track);
        return true;
    }

    return { handle: handle };
}

module.exports = { createAdminCatalogRoutes };
