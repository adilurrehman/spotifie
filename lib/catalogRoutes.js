'use strict';

/**
 * Same-origin HTTP surface for the unified catalogue: /api/catalog/...
 *
 * Read routes merge the local library with the global admin catalogue.
 * Removal routes are deliberately split:
 *   POST /api/catalog/hidden           - per-user hide (never deletes)
 *   DELETE /api/catalog/tracks/:id     - permanent global delete, admin only
 * so the two can never be reached by accident from the same call.
 */

const fs = require('fs');
const path = require('path');

const { CatalogService, sourceOf } = require('./catalogService');
const { bearerToken, identifyToken } = require('./sessionAuth');
const { MAX_BACKUP_BYTES } = require('./libraryBackup');

/**
 * The administrator half of this surface, when this installation has it.
 *
 * Publishing to the shared catalogue is a privileged operation, and its
 * implementation lives in its own module so a build can be made without it.
 * The check is for the file itself rather than a try/catch around the require:
 * a module that is present but broken must fail loudly, not quietly turn into
 * an installation that has no administrator routes.
 */
const ADMIN_MODULE = path.join(__dirname, 'adminCatalogRoutes.js');
const adminModule = fs.existsSync(ADMIN_MODULE) ? require(ADMIN_MODULE) : null;

const PREFIX = '/api/catalog';
const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit) {
    // Ordinary requests are small; a restored library is the one thing that is
    // legitimately larger, and it is still bounded.
    const maximum = Number.isFinite(limit) && limit > 0 ? limit : MAX_BODY_BYTES;

    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maximum) {
                const error = new Error('That backup is too large to read.');
                error.code = 'BODY_TOO_LARGE';
                reject(error);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(new Error('Request body is not valid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Identify the caller from their Supabase access token, or null.
 *
 * This shares the admin guard's short-lived cache, so a privileged request
 * verifies the session once instead of asking Supabase again a moment later.
 * Reading the catalogue never depends on it: an unreachable Supabase leaves
 * the caller anonymous rather than failing the request.
 */
async function identify(req) {
    const token = bearerToken(req);
    if (!token) return { token: null, user: null };

    try {
        return { token: token, user: await identifyToken(token) };
    } catch (e) {
        console.warn('Could not identify the caller:', e.message);
        return { token: token, user: null };
    }
}

function createCatalogRoutes(options) {
    const settings = options || {};
    const service = settings.service || new CatalogService(settings.serviceOptions);

    // The private half, given the few helpers it needs rather than its own
    // copies of them, so both halves answer in exactly the same shapes.
    const adminRoutes = adminModule
        ? adminModule.createAdminCatalogRoutes({
              sendJson: sendJson,
              readJsonBody: readJsonBody,
              methodNotAllowed: methodNotAllowed,
              sourceOf: sourceOf
          })
        : null;

    async function handle(req, res, pathname, query) {
        if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return false;

        const rest = pathname.slice(PREFIX.length).replace(/^\/+/, '');
        const segments = rest.length ? rest.split('/').map(decodeURIComponent) : [];
        const method = req.method;

        try {
            const caller = await identify(req);
            const context = { token: caller.token, userId: caller.user ? caller.user.id : null };

            // ---- reads ----
            if (segments.length === 0 || segments[0] === 'status') {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                const catalog = await service.getCatalog(context);
                sendJson(res, 200, {
                    signedIn: Boolean(context.userId),
                    sources: catalog.sources,
                    trackCount: catalog.tracks.length,
                    albumCount: catalog.albums.length,
                    hidden: catalog.hidden
                });
                return true;
            }

            // The local half on its own: the music on this device plus this
            // listener's own state. Supabase is not consulted, so the library
            // can be drawn from it and from a cached catalogue while the
            // published one is being checked in the background.
            if (segments[0] === 'local' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                sendJson(res, 200, service.getLocalCatalog(context));
                return true;
            }

            // ============================================
            // What this person has made of the library
            //
            // Likes, playlists and listening history. Every one of these needs
            // an account, because every one of them belongs to one: a guest is
            // answered 401 and asked to sign in, never given a place to put
            // things that nobody would own, and never given somebody else's.
            //
            // All of it is written to this machine, in that account's own
            // state file. None of it goes to Supabase.
            // ============================================

            // ============================================
            // Taking a library with you
            //
            // Export writes a document of references; import reads one back.
            // Both belong to one account, so both need a session - a backup is
            // somebody's library, and restoring one into the wrong account
            // would be as wrong as handing it to a stranger.
            // ============================================

            if (segments[0] === 'backup' && segments.length === 1) {
                if (!context.userId) return unauthorized(res);

                if (method === 'GET' || method === 'HEAD') {
                    // The albums the page keeps for itself travel in the same
                    // document, so a library restores whole. They arrive as a
                    // parameter because the server does not store them.
                    let localAlbums = [];
                    if (query && typeof query.localAlbums === 'string') {
                        try {
                            localAlbums = JSON.parse(query.localAlbums);
                        } catch (e) {
                            localAlbums = [];
                        }
                    }

                    const document = await service.exportBackupFor(context.userId, {
                        token: context.token,
                        localAlbums: Array.isArray(localAlbums) ? localAlbums : []
                    });

                    sendJson(res, 200, document);
                    return true;
                }

                if (method === 'POST') {
                    let body;
                    try {
                        body = await readJsonBody(req, MAX_BACKUP_BYTES);
                    } catch (err) {
                        sendJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, {
                            error: err.code === 'BODY_TOO_LARGE' ? err.message : 'That file is not readable as a backup.'
                        });
                        return true;
                    }

                    try {
                        const result = await service.importBackupFor(context.userId, body, {
                            token: context.token
                        });

                        sendJson(res, 200, {
                            imported: true,
                            summary: result.summary,
                            localAlbums: result.localAlbums,
                            trackHints: result.trackHints
                        });
                    } catch (err) {
                        // A backup that cannot be read is the caller's file
                        // being wrong, not the server failing. The library is
                        // untouched either way.
                        const status = err.code === 'INVALID_BACKUP' ? 400 : 500;
                        sendJson(res, status, { error: err.message });
                    }
                    return true;
                }

                return methodNotAllowed(res);
            }

            // Which of these songs this library can play, and which it cannot.
            // Asked when a restored collection is drawn.
            if (segments[0] === 'resolve' && segments.length === 1) {
                if (method !== 'POST') return methodNotAllowed(res);

                const body = await readJsonBody(req);
                const ids = Array.isArray(body.ids) ? body.ids.slice(0, 5000) : [];

                sendJson(res, 200, await service.resolveReferences(ids, context));
                return true;
            }

            if (segments[0] === 'me' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                sendJson(res, 200, await service.getPersonalCollections(context));
                return true;
            }

            if (segments[0] === 'liked' && segments.length === 1) {
                if (method === 'GET' || method === 'HEAD') {
                    const collections = await service.getPersonalCollections(context);
                    sendJson(res, 200, Object.assign({ signedIn: collections.signedIn }, collections.liked));
                    return true;
                }

                if (method === 'POST') {
                    if (!context.userId) return unauthorized(res);

                    const body = await readJsonBody(req);
                    if (!body.id || !sourceOf(body.id)) {
                        sendJson(res, 400, { error: 'A track id is required' });
                        return true;
                    }

                    const result = service.toggleLikeForUser(context.userId, body.id);
                    sendJson(res, 200, { liked: result.liked, id: body.id, trackIds: result.trackIds });
                    return true;
                }

                return methodNotAllowed(res);
            }

            if (segments[0] === 'liked' && segments.length === 2) {
                if (method !== 'DELETE') return methodNotAllowed(res);
                if (!context.userId) return unauthorized(res);

                const trackIds = service.unlikeForUser(context.userId, segments[1]);
                sendJson(res, 200, { liked: false, id: segments[1], trackIds: trackIds });
                return true;
            }

            if (segments[0] === 'playlists' && segments.length === 1) {
                if (method === 'GET' || method === 'HEAD') {
                    const collections = await service.getPersonalCollections(context);
                    sendJson(res, 200, {
                        signedIn: collections.signedIn,
                        total: collections.playlists.length,
                        items: collections.playlists
                    });
                    return true;
                }

                if (method === 'POST') {
                    if (!context.userId) return unauthorized(res);

                    const body = await readJsonBody(req);
                    try {
                        const created = service.createPlaylistForUser(context.userId, {
                            title: body.title,
                            description: body.description,
                            artwork: body.artworkReference ? { type: 'local', reference: body.artworkReference } : null,
                            trackIds: body.trackIds
                        });
                        sendJson(res, 201, created);
                    } catch (err) {
                        sendJson(res, 400, { error: err.message });
                    }
                    return true;
                }

                return methodNotAllowed(res);
            }

            if (segments[0] === 'playlists' && segments.length === 2) {
                if (!context.userId) return unauthorized(res);
                const playlistId = segments[1];

                if (method === 'GET' || method === 'HEAD') {
                    const playlist = await service.getPlaylist(playlistId, context);
                    if (!playlist) {
                        sendJson(res, 404, { error: 'No such playlist' });
                        return true;
                    }
                    sendJson(res, 200, playlist);
                    return true;
                }

                if (method === 'PATCH') {
                    const body = await readJsonBody(req);
                    const patch = {};

                    // Only what was named is changed. Sending null for the
                    // description or the cover clears it; leaving the field
                    // out keeps what is there.
                    if (body.title !== undefined) patch.title = body.title;
                    if (body.description !== undefined) patch.description = body.description;
                    if (body.artworkReference !== undefined) {
                        patch.artwork = body.artworkReference ? { type: 'local', reference: body.artworkReference } : null;
                    }

                    try {
                        const updated = service.updatePlaylistForUser(context.userId, playlistId, patch);
                        if (!updated) {
                            sendJson(res, 404, { error: 'No such playlist' });
                            return true;
                        }
                        sendJson(res, 200, updated);
                    } catch (err) {
                        sendJson(res, 400, { error: err.message });
                    }
                    return true;
                }

                if (method === 'DELETE') {
                    const removed = service.deletePlaylistForUser(context.userId, playlistId);
                    if (!removed) {
                        sendJson(res, 404, { error: 'No such playlist' });
                        return true;
                    }
                    sendJson(res, 200, { deleted: true, id: playlistId, title: removed.title });
                    return true;
                }

                return methodNotAllowed(res);
            }

            if (segments[0] === 'playlists' && segments.length === 3 && segments[2] === 'tracks') {
                if (!context.userId) return unauthorized(res);
                const playlistId = segments[1];

                if (method === 'POST') {
                    const body = await readJsonBody(req);
                    if (!body.id || !sourceOf(body.id)) {
                        sendJson(res, 400, { error: 'A track id is required' });
                        return true;
                    }

                    try {
                        const updated = service.addPlaylistTrackForUser(context.userId, playlistId, body.id, {
                            position: Number.isInteger(body.position) ? body.position : undefined
                        });
                        if (!updated) {
                            sendJson(res, 404, { error: 'No such playlist' });
                            return true;
                        }
                        sendJson(res, 200, updated);
                    } catch (err) {
                        sendJson(res, 400, { error: err.message });
                    }
                    return true;
                }

                // Rearranging the whole list at once, or moving one entry.
                if (method === 'PUT') {
                    const body = await readJsonBody(req);

                    const updated = Number.isInteger(body.from) && Number.isInteger(body.to)
                        ? service.movePlaylistTrackForUser(context.userId, playlistId, body.from, body.to)
                        : service.reorderPlaylistForUser(context.userId, playlistId, body.trackIds);

                    if (!updated) {
                        sendJson(res, 400, { error: 'That is not a rearrangement of this playlist' });
                        return true;
                    }
                    sendJson(res, 200, updated);
                    return true;
                }

                return methodNotAllowed(res);
            }

            if (segments[0] === 'playlists' && segments.length === 4 && segments[2] === 'tracks') {
                if (method !== 'DELETE') return methodNotAllowed(res);
                if (!context.userId) return unauthorized(res);

                // A playlist may name the same song twice, so a position says
                // which entry to take out. Without one, every copy goes.
                const position = query && query.position !== undefined ? Number(query.position) : undefined;
                const updated = service.removePlaylistTrackForUser(context.userId, segments[1], segments[3], {
                    position: Number.isInteger(position) ? position : undefined
                });

                if (!updated) {
                    sendJson(res, 404, { error: 'That track is not in this playlist' });
                    return true;
                }
                sendJson(res, 200, updated);
                return true;
            }

            if (segments[0] === 'recent' && segments.length === 1) {
                if (method === 'GET' || method === 'HEAD') {
                    const collections = await service.getPersonalCollections(context);
                    sendJson(res, 200, Object.assign({ signedIn: collections.signedIn }, collections.recentlyPlayed));
                    return true;
                }

                if (method === 'POST') {
                    const body = await readJsonBody(req);
                    if (!body.id || !sourceOf(body.id)) {
                        sendJson(res, 400, { error: 'A track id is required' });
                        return true;
                    }

                    // A guest is not refused, only not recorded: listening
                    // without an account works, and there is nowhere personal
                    // to write it down.
                    const recent = service.notePlayedForUser(context.userId, body.id, body.playedAt);
                    sendJson(res, 200, { noted: Boolean(context.userId), total: recent.length });
                    return true;
                }

                if (method === 'DELETE') {
                    if (!context.userId) return unauthorized(res);
                    service.clearRecentlyPlayedForUser(context.userId);
                    sendJson(res, 200, { cleared: true });
                    return true;
                }

                return methodNotAllowed(res);
            }

            if (segments[0] === 'recently-added' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                const limit = query && query.limit ? Number(query.limit) : undefined;
                sendJson(res, 200, await service.getRecentlyAdded(Object.assign({}, context, { limit: limit })));
                return true;
            }

            if (segments[0] === 'tracks' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                const result = await service.getTracks(
                    Object.assign({}, context, { albumId: query.albumId || null, source: query.source || null })
                );
                sendJson(res, 200, result);
                return true;
            }

            if (segments[0] === 'albums' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                sendJson(res, 200, await service.getAlbums(context));
                return true;
            }

            if (segments[0] === 'artists' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                // Naming one brings back that artist alone, with their tracks.
                sendJson(
                    res,
                    200,
                    await service.getArtists(Object.assign({}, context, { artistName: query.name || null }))
                );
                return true;
            }

            // ---- a listener's own edits to a published album ----
            // Personal presentation only, stored on this device for this
            // account. Nothing here can change the shared record: that is the
            // dashboard's job, through a different code path entirely.
            if (segments[0] === 'overrides' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                if (!context.userId) return unauthorized(res);
                sendJson(res, 200, { albums: service.getAlbumOverridesForUser(context.userId) });
                return true;
            }

            if (segments[0] === 'overrides' && segments.length === 2) {
                if (!context.userId) return unauthorized(res);

                if (method === 'PUT') {
                    const body = await readJsonBody(req);
                    const saved = service.setAlbumOverrideForUser(context.userId, segments[1], {
                        title: body.title,
                        artist: body.artist,
                        description: body.description,
                        artwork: body.artworkReference ? { type: 'local', reference: body.artworkReference } : null
                    });
                    sendJson(res, 200, { id: segments[1], override: saved, scope: 'this account, on this device' });
                    return true;
                }

                if (method === 'DELETE') {
                    const cleared = service.clearAlbumOverrideForUser(context.userId, segments[1]);
                    sendJson(res, 200, { id: segments[1], cleared: cleared });
                    return true;
                }

                return methodNotAllowed(res);
            }

            // ---- a listener's own songs inside a published album ----
            // The song stays this person's own local file; the album simply
            // shows it for them. The published album in Supabase is not
            // written to here, and cannot be from this path.
            if (segments[0] === 'albums' && segments.length === 3 && segments[2] === 'tracks') {
                if (method !== 'POST') return methodNotAllowed(res);
                if (!context.userId) return unauthorized(res);

                const body = await readJsonBody(req);
                try {
                    const tracks = service.addTrackToAlbumForUser(context.userId, segments[1], body.id);
                    sendJson(res, 200, {
                        albumId: segments[1],
                        tracks: tracks,
                        scope: 'this account, on this device'
                    });
                } catch (err) {
                    sendJson(res, 400, { error: err.message });
                }
                return true;
            }

            if (segments[0] === 'albums' && segments.length === 4 && segments[2] === 'tracks') {
                if (method !== 'DELETE') return methodNotAllowed(res);
                if (!context.userId) return unauthorized(res);

                try {
                    // Membership only: the file on this device is left alone.
                    const result = service.removeTrackFromAlbumForUser(context.userId, segments[1], segments[3]);
                    sendJson(res, 200, { albumId: segments[1], removed: result.removed, tracks: result.tracks });
                } catch (err) {
                    sendJson(res, 400, { error: err.message });
                }
                return true;
            }

            // ---- where this listener stopped, per track ----
            // A convenience kept on this machine: their own state file when
            // signed in, the device's own file when not. A guest is answered
            // too - listening carries on across a refresh without an account -
            // and none of it is ever written to Supabase.
            if (segments[0] === 'progress' && segments.length === 1) {
                if (method === 'GET' || method === 'HEAD') {
                    sendJson(res, 200, {
                        signedIn: Boolean(context.userId),
                        scope: context.userId ? 'this account' : 'this device',
                        trackProgress: service.getProgressFor(context.userId)
                    });
                    return true;
                }

                if (method === 'PUT' || method === 'POST') {
                    const body = await readJsonBody(req);
                    try {
                        const saved = service.saveProgressFor(
                            context.userId,
                            body.id,
                            Number(body.position),
                            body.duration === undefined || body.duration === null ? null : Number(body.duration)
                        );
                        sendJson(res, 200, Object.assign({ saved: true }, saved));
                    } catch (err) {
                        sendJson(res, 400, { error: err.message });
                    }
                    return true;
                }

                if (method === 'DELETE') {
                    const progress = service.clearProgressFor(context.userId, query.id || null);
                    sendJson(res, 200, { cleared: true, trackProgress: progress });
                    return true;
                }

                return methodNotAllowed(res);
            }

            // ---- per-user hidden items ----
            if (segments[0] === 'hidden' && segments.length === 1) {
                if (method === 'GET') {
                    if (!context.userId) return unauthorized(res);
                    sendJson(res, 200, service.getHiddenForUser(context.userId));
                    return true;
                }

                if (method === 'POST') {
                    // Hiding is a personal preference: it never deletes global
                    // content and never reaches Supabase.
                    if (!context.userId) return unauthorized(res);
                    const body = await readJsonBody(req);
                    if (!body.id || !sourceOf(body.id)) {
                        sendJson(res, 400, { error: 'A catalogue id is required' });
                        return true;
                    }
                    const state = service.hideForUser(context.userId, body.id);
                    sendJson(res, 200, { hidden: true, id: body.id, state: state });
                    return true;
                }

                return methodNotAllowed(res);
            }

            if (segments[0] === 'hidden' && segments.length === 2 && segments[1] === 'restore') {
                if (method !== 'POST') return methodNotAllowed(res);
                if (!context.userId) return unauthorized(res);

                const body = await readJsonBody(req);
                if (!body.id || !sourceOf(body.id)) {
                    sendJson(res, 400, { error: 'A catalogue id is required' });
                    return true;
                }
                const state = service.restoreForUser(context.userId, body.id);
                sendJson(res, 200, { restored: true, id: body.id, state: state });
                return true;
            }

            // ---- single track, media resolution ----
            if (segments[0] === 'tracks' && segments.length === 2) {
                if (method === 'GET' || method === 'HEAD') {
                    const track = await service.getTrack(segments[1], context);
                    if (!track) {
                        sendJson(res, 404, { error: 'Track not found' });
                        return true;
                    }
                    sendJson(res, 200, track);
                    return true;
                }

                // Permanently deleting a published track is an administrator
                // write, and lives with the rest of them. Without that module
                // there is no such route, and the request ends at the 404
                // below.
                if (method === 'DELETE' && adminRoutes) {
                    const handled = await adminRoutes.handle(req, res, segments, method, service);
                    if (handled) return true;
                }

                if (method === 'DELETE') {
                    sendJson(res, 404, { error: 'Not found' });
                    return true;
                }

                return methodNotAllowed(res);
            }

            if (segments[0] === 'tracks' && segments.length === 3 && segments[2] === 'stream') {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                const resolved = await service.resolveStreamUrl(segments[1], context);
                if (!resolved) {
                    sendJson(res, 404, { error: 'No playable audio for this track' });
                    return true;
                }
                sendJson(res, 200, resolved);
                return true;
            }

            // The picture itself, served from this origin so the browser can
            // keep it the way it keeps any other image. The address names the
            // version of the artwork, so a replaced cover is a different
            // address and the old copy is never shown for it.
            if (
                segments.length === 4 &&
                segments[2] === 'artwork' &&
                segments[3] === 'image' &&
                (segments[0] === 'tracks' || segments[0] === 'albums')
            ) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                return sendGlobalArtworkImage(req, res, service, segments[1], context, query);
            }

            if (
                segments.length === 3 &&
                segments[2] === 'artwork' &&
                (segments[0] === 'tracks' || segments[0] === 'albums')
            ) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                const resolved = await service.resolveArtworkUrl(segments[1], context);
                if (!resolved) {
                    // Missing artwork is normal: the caller uses the default
                    // cover rather than treating the album as broken.
                    sendJson(res, 200, { url: null, fallbackUrl: '/img/music.svg', source: sourceOf(segments[1]) });
                    return true;
                }
                sendJson(res, 200, Object.assign({ fallbackUrl: '/img/music.svg' }, resolved));
                return true;
            }

            // ---- administrator writes (global catalogue only) ----
            // Handled by the private module when this installation has it. A
            // build without it has no route to reach: the request falls
            // through to the 404 below, which is the same answer a made-up
            // path gets, because there is nothing there to find.
            if (adminRoutes) {
                const handled = await adminRoutes.handle(req, res, segments, method, service);
                if (handled) return true;
            }

            sendJson(res, 404, { error: 'Not found' });
            return true;
        } catch (err) {
            // Report what actually went wrong upstream instead of one blanket
            // status. The detail is a message, never a token or a key.
            const status = mapUpstreamStatus(err);
            console.error('Catalogue request failed:', req.method, pathname, '->', status, err.message);
            sendJson(res, status, { error: describeUpstream(status), detail: err.message });
            return true;
        }
    }

    return { handle, service, prefix: PREFIX };
}

/**
 * Turn a Supabase failure into the status the browser should see.
 * A rejected write stays a 4xx; only a genuine upstream problem becomes 5xx.
 */
function mapUpstreamStatus(err) {
    const status = Number(err && err.status);
    if (!Number.isFinite(status)) return 500;

    if (status === 401) return 401;
    if (status === 403) return 403;
    if (status === 404) return 404;
    if (status === 409) return 409;
    if (status === 429) return 429;
    if (status >= 400 && status < 500) return 400;
    if (status === 504) return 504;
    if (status === 503 || status === 502) return 502;
    return 500;
}

function describeUpstream(status) {
    if (status === 401) return 'Your session has expired. Sign in again.';
    if (status === 403) return 'Administrator access required';
    if (status === 404) return 'Not found';
    if (status === 429) return 'Too many requests. Try again in a moment.';
    if (status === 400) return 'Supabase rejected the change';
    if (status === 504) return 'Supabase did not answer in time';
    if (status === 502) return 'Could not reach Supabase';
    return 'Catalogue error';
}

/**
 * Say so when a field could not be stored because the database is behind.
 * The album still saves; the admin is told which part did not stick.
 */
function withSchemaWarning(album, service, body) {
    const wantedDescription = body && body.description !== undefined && body.description !== null && body.description !== '';
    if (!service.global.albumDescriptionMissing || !wantedDescription) return album;

    return Object.assign({}, album, {
        warning:
            'Saved, but the description was not stored: this Supabase project has no catalog_albums.description column yet. Apply the latest supabase-setup.sql.'
    });
}

function methodNotAllowed(res) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
}

/** How long a browser may keep a published cover it has already fetched. */
const ARTWORK_IMMUTABLE_SECONDS = 31536000;
const ARTWORK_UNVERSIONED_SECONDS = 300;

/**
 * Serve the bytes of a published cover from this origin.
 *
 * Without this the page is handed a Supabase address that carries a signature
 * and expires within the hour, so every visit signs every cover again and the
 * browser can never reuse one it already has. Here the address is this
 * server's own and names the version of the artwork: the same cover is the
 * same address, which the browser keeps, and a replaced cover is a different
 * address, which it fetches. The signed address is used once, inside this
 * process, and never reaches the page.
 *
 * Published artwork only, and the published catalogue is public to read, so
 * the copy may be kept by whoever is using this machine. A listener's own
 * cover for an album is a local file with its own address and never comes
 * through here.
 */
async function sendGlobalArtworkImage(req, res, service, id, context, query) {
    const version = query && typeof query.v === 'string' ? query.v : null;

    // The browser saying it already has this exact version is answered before
    // anything is fetched.
    if (version && req.headers['if-none-match'] === '"' + version + '"') {
        res.writeHead(304, {
            ETag: '"' + version + '"',
            'Cache-Control': 'public, max-age=' + ARTWORK_IMMUTABLE_SECONDS + ', immutable'
        });
        res.end();
        return true;
    }

    let artwork = null;
    try {
        artwork = await service.findGlobalArtwork(id, context);
    } catch (e) {
        artwork = null;
    }

    // No published cover, or the catalogue could not be reached: the page
    // shows the default rather than a broken picture.
    if (!artwork || !artwork.url) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'No artwork for this item' }));
        return true;
    }

    let upstream;
    try {
        upstream = await fetch(artwork.url);
    } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Could not read the artwork' }));
        return true;
    }

    if (!upstream.ok) {
        res.writeHead(upstream.status === 404 ? 404 : 502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify({ error: 'Could not read the artwork' }));
        return true;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    const tag = artwork.version || version;

    // An address that names the version may be kept indefinitely, because a
    // different picture would be a different address. One that does not is
    // kept only briefly.
    const headers = {
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        'Content-Length': String(body.length),
        'Cache-Control':
            version && tag === version
                ? 'public, max-age=' + ARTWORK_IMMUTABLE_SECONDS + ', immutable'
                : 'public, max-age=' + ARTWORK_UNVERSIONED_SECONDS
    };
    if (tag) headers.ETag = '"' + tag + '"';

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }

    res.end(body);
    return true;
}

function unauthorized(res) {
    sendJson(res, 401, { error: 'Sign in to use this' });
    return true;
}

module.exports = { createCatalogRoutes, CATALOG_PREFIX: PREFIX };
