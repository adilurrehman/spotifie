'use strict';

/**
 * Same-origin HTTP surface for the LibraryService.
 *
 * Responses are platform-neutral JSON: the browser only ever sees IDs and
 * URLs, never filesystem paths, so a different adapter (desktop, mobile)
 * can serve the same contract unchanged.
 */

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT } = require('./config');
const { LibraryService } = require('./libraryService');
const { UserArtworkStore } = require('./userArtwork');
const { UserMediaStore } = require('./userMedia');
const { DeviceMusicScanner } = require('./deviceScan');
const { DeviceLibrary } = require('./deviceLibrary');
const { MediaTickets } = require('./mediaTickets');
const { bearerToken, identifyToken } = require('./sessionAuth');

/**
 * The administrator guard, when this installation has it.
 *
 * Rescanning the music root is administrator work. Its check lives in the
 * private module, and a build without that module has no rescan route at all -
 * so the answer there is 404, the same as any path that names nothing. Checked
 * as a file rather than wrapped in a try/catch, so a module that is present
 * but broken fails loudly instead of quietly becoming an installation with no
 * guard.
 */
const ADMIN_AUTH_MODULE = path.join(__dirname, 'adminAuth.js');
const adminAuth = fs.existsSync(ADMIN_AUTH_MODULE) ? require(ADMIN_AUTH_MODULE) : null;

const PREFIX = '/api/library';
const FALLBACK_ARTWORK = path.join(PROJECT_ROOT, 'img', 'music.svg');

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function sendFallbackArtwork(res) {
    try {
        const data = fs.readFileSync(FALLBACK_ARTWORK);
        res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Content-Length': data.length,
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(data);
    } catch (e) {
        sendJson(res, 404, { error: 'Artwork not found' });
    }
}

function parseIntOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function createLibraryRoutes(options) {
    const service = (options && options.service) || new LibraryService();
    const artworkStore = (options && options.artworkStore) || new UserArtworkStore(options && options.artworkOptions);
    const userMedia = (options && options.userMedia) || new UserMediaStore(options && options.userMediaOptions);
    const tickets = (options && options.tickets) || new MediaTickets(options && options.ticketOptions);
    const deviceLibrary = (options && options.deviceLibrary) || new DeviceLibrary(options && options.deviceOptions);
    const scanner =
        (options && options.scanner) ||
        new DeviceMusicScanner(
            Object.assign({ deviceLibrary: deviceLibrary }, (options && options.scannerOptions) || {})
        );

    /**
     * The account this request speaks for, verified against Supabase.
     *
     * The browser never states who it is: only a valid session does, and the
     * id comes from that session rather than from anything the caller sent.
     * (A test may supply its own resolver; nothing else does.)
     */
    const resolveCaller =
        (options && options.resolveCaller) ||
        async function (req) {
            const token = bearerToken(req);
            if (!token) return null;
            try {
                const user = await identifyToken(token);
                return user && user.id ? user.id : null;
            } catch (e) {
                return null;
            }
        };

    function callerId(req) {
        return Promise.resolve(resolveCaller(req));
    }

    /**
     * The account allowed to read one private track on this request.
     *
     * An <audio> element cannot send a header, so a ticket in the URL carries
     * the permission instead - issued to one account for one track when the
     * catalogue was asked for over an authenticated request.
     */
    async function privateReader(req, trackId, query) {
        const ticketed = tickets.verify((query && query.ticket) || null, trackId);
        if (ticketed) return ticketed;
        return callerId(req);
    }

    /**
     * Handle a library request.
     * Returns true when the request was handled by this router.
     */
    async function handle(req, res, pathname, query) {
        if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return false;

        const rest = pathname.slice(PREFIX.length).replace(/^\/+/, '');
        const segments = rest.length ? rest.split('/').map(decodeURIComponent) : [];
        const method = req.method;

        try {
            if (segments.length === 0 || segments[0] === 'status') {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                return sendJson(res, 200, service.getStatus()), true;
            }

            // ============================================
            // Managing the music on this machine
            //
            // The folders Spotifie looks in, how the library is doing, and
            // which songs look like copies of one another. All of it is about
            // this device rather than about an account, so whoever is at the
            // machine may see and change it - the same rule that lets anyone
            // here start a search.
            //
            // Nothing in here can delete a file. Forgetting a folder stops
            // Spotifie looking at it; the music stays exactly where it is.
            // ============================================

            if (segments[0] === 'locations' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                sendJson(res, 200, {
                    permission: deviceLibrary.readState().permission,
                    // Names somebody would recognise, never the paths behind
                    // them: where a folder is on a disk is this machine's
                    // business and not the browser's.
                    locations: deviceLibrary.describeLocations()
                });
                return true;
            }

            if (segments[0] === 'locations' && segments.length === 2) {
                if (method !== 'DELETE') return methodNotAllowed(res);

                const removed = deviceLibrary.forgetLocation(segments[1]);
                if (!removed) {
                    sendJson(res, 404, { error: 'No such music folder' });
                    return true;
                }

                sendJson(res, 200, {
                    forgotten: true,
                    id: removed.id,
                    label: removed.label,
                    // Said plainly, because it is the thing somebody will want
                    // to be sure of before pressing the button.
                    filesDeleted: 0,
                    locations: deviceLibrary.describeLocations()
                });
                return true;
            }

            // How the library on this machine is doing. Counts and times: no
            // paths, no names of folders beyond the friendly ones.
            if (segments[0] === 'health' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);

                const status = service.getStatus();
                const locations = deviceLibrary.describeLocations();

                sendJson(res, 200, {
                    permission: deviceLibrary.readState().permission,
                    musicRoot: { trackCount: status.trackCount, updatedAt: status.updatedAt || null },
                    device: {
                        trackCount: deviceLibrary.getTracks().length,
                        locationCount: locations.length,
                        locations: locations
                    },
                    scan: scanner.statusFor(),
                    lastScanAt: deviceLibrary.readState().lastScanAt || null,
                    lastReconciledAt: deviceLibrary.readState().lastReconciledAt || null
                });
                return true;
            }

            // Songs that look like copies. Reported, never acted on: deciding
            // that two recordings are the same recording is a judgement about
            // music, and it belongs to whoever owns it.
            if (segments[0] === 'duplicates' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                sendJson(res, 200, deviceLibrary.findDuplicates());
                return true;
            }

            if (segments[0] === 'rescan' && segments.length === 1) {
                if (method !== 'POST') return methodNotAllowed(res);

                // A build without the guard has no such route.
                if (!adminAuth) {
                    sendJson(res, 404, { error: 'Not found' });
                    return true;
                }

                // Rescanning re-reads the whole music root: administrators only,
                // verified server-side against the caller's Supabase session.
                const adminCheck = await adminAuth.requireAdmin(req);
                if (!adminCheck.ok) {
                    sendJson(res, adminCheck.status, { error: adminCheck.error });
                    return true;
                }

                const result = await service.scan();
                return sendJson(res, 200, Object.assign({ status: 'ok' }, result)), true;
            }

            // ---- searching this device for music ----
            // This is about the machine Spotifie is running on, not about an
            // account: whoever is at it may ask, signed in or not, and what is
            // found belongs to the device. The caller chooses nothing but
            // "start" - never a folder - and is answered in counts.
            if (segments[0] === 'scan' && segments.length === 1) {
                if (method === 'GET' || method === 'HEAD') {
                    // The page says whether music is playing, so the search can
                    // get out of the way of it.
                    if (query && query.playing !== undefined) {
                        scanner.setBusy(query.playing === 'true' || query.playing === '1');
                    }
                    sendJson(res, 200, deviceScanReport(scanner, deviceLibrary));
                    return true;
                }

                if (method === 'POST') {
                    // Asking again while a search is running gives back the one
                    // already going, rather than starting a second: the job
                    // belongs to the server, so a refresh or a second tab
                    // watches it instead of starting another.
                    deviceLibrary.allowScanning();

                    // Before anything is searched for, check that what is
                    // already known is still there. One stat per known file -
                    // no tags, no hashing, no folder walked - so a song
                    // deleted from the disk leaves Local Music now, rather
                    // than waiting for somebody to press Play on it and get an
                    // error. A watcher cannot see what happened while Spotifie
                    // was closed; this can, which is why it is the pass that
                    // is always right.
                    let reconciled = null;
                    try {
                        reconciled = await deviceLibrary.reconcile();
                    } catch (err) {
                        console.warn('Could not check the device index:', err.message);
                    }

                    // 'full' reads everything again; anything else lets the
                    // scanner decide, which after the first time means reusing
                    // the index and reading only what changed.
                    scanner.start(query && query.mode === 'full' ? { mode: 'full' } : {});
                    sendJson(
                        res,
                        scanner.isRunning() ? 202 : 200,
                        Object.assign(deviceScanReport(scanner, deviceLibrary), {
                            reconciled: reconciled
                                ? {
                                      checked: reconciled.checked,
                                      removed: reconciled.removedTrackIds.length,
                                      changed: reconciled.changed.length
                                  }
                                : null
                        })
                    );
                    return true;
                }

                if (method === 'DELETE') {
                    scanner.cancel();
                    sendJson(res, 200, deviceScanReport(scanner, deviceLibrary));
                    return true;
                }

                return methodNotAllowed(res);
            }

            // ---- music imported from this person's own device ----
            // Saved on this device, under that account, and never anywhere
            // else: no Supabase row, no Storage object, no copy for anyone
            // else who signs in here.
            if (segments[0] === 'imports' && segments.length === 1) {
                if (method === 'GET' || method === 'HEAD') {
                    const userId = await callerId(req);
                    if (!userId) return unauthorized(res);
                    const items = userMedia.getTracks(userId).map((track) => withTicket(track, tickets, userId));
                    sendJson(res, 200, { total: items.length, items: items });
                    return true;
                }

                if (method === 'POST') {
                    const userId = await callerId(req);
                    if (!userId) return unauthorized(res);
                    return importDeviceFile(req, res, userMedia, tickets, userId, query);
                }

                return methodNotAllowed(res);
            }

            // ---- artwork a person added to one of their own albums ----
            // Stored on this device only. The image never goes to Supabase and
            // is never inlined as Base64: the album keeps just the id.
            if (segments[0] === 'artwork' && segments.length === 1) {
                if (method !== 'POST') return methodNotAllowed(res);
                return uploadUserArtwork(req, res, artworkStore);
            }

            if (segments[0] === 'artwork' && segments.length === 2) {
                if (method === 'GET' || method === 'HEAD') {
                    return serveUserArtwork(req, res, artworkStore, segments[1]);
                }
                if (method === 'DELETE') {
                    artworkStore.remove(segments[1]);
                    sendJson(res, 200, { removed: true });
                    return true;
                }
                return methodNotAllowed(res);
            }

            if (segments[0] === 'albums' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                return sendJson(res, 200, service.getAlbums()), true;
            }

            if (segments[0] === 'artists' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                return sendJson(res, 200, service.getArtists()), true;
            }

            if (segments[0] === 'tracks' && segments.length === 1) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                const result = service.getTracks({
                    limit: parseIntOrNull(query.limit),
                    offset: parseIntOrNull(query.offset),
                    albumId: query.albumId || null,
                    artistId: query.artistId || null
                });
                return sendJson(res, 200, result), true;
            }

            if (segments[0] === 'tracks' && segments.length === 2) {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                const track = service.getTrack(segments[1]) || deviceLibrary.getTrack(segments[1]);
                if (track) return sendJson(res, 200, track), true;

                // Not music of this device: it may be this account's own
                // imported music, which nobody else can ask for.
                const userId = await privateReader(req, segments[1], query);
                const personal = userId ? userMedia.getTrack(userId, segments[1]) : null;
                if (!personal) return sendJson(res, 404, { error: 'Track not found' }), true;
                return sendJson(res, 200, withTicket(personal, tickets, userId)), true;
            }

            if (segments[0] === 'tracks' && segments.length === 3 && segments[2] === 'artwork') {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                let artwork = await service.getArtwork(segments[1]);
                if (!artwork && !service.getTrack(segments[1])) {
                    artwork = await deviceLibrary.getArtwork(segments[1]);
                }
                if (!artwork && !service.getTrack(segments[1]) && !deviceLibrary.getTrack(segments[1])) {
                    const userId = await privateReader(req, segments[1], query);
                    artwork = userId ? await userMedia.getArtwork(userId, segments[1]) : null;
                }
                if (!artwork) {
                    sendFallbackArtwork(res);
                    return true;
                }
                res.writeHead(200, {
                    'Content-Type': artwork.mimeType,
                    'Content-Length': artwork.data.length,
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'private, max-age=3600'
                });
                if (method === 'HEAD') {
                    res.end();
                } else {
                    res.end(artwork.data);
                }
                return true;
            }

            if (segments[0] === 'tracks' && segments.length === 3 && segments[2] === 'stream') {
                if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res);
                if (service.getTrack(segments[1])) return streamTrack(req, res, service, segments[1]);

                // Music found on this device: playable by whoever is at it,
                // by track id only - there is no path to ask for.
                if (deviceLibrary.getTrack(segments[1])) {
                    return streamTrack(req, res, { openStream: (id, range) => deviceLibrary.openStream(id, range) }, segments[1]);
                }

                // Private music: served only to the account that imported it.
                const userId = await privateReader(req, segments[1], query);
                // Nothing is said about music that is not this caller's: an
                // unknown id and someone else's private track look the same.
                if (!userId) return sendJson(res, 404, { error: 'Track not found' }), true;
                return streamTrack(req, res, { openStream: (id, range) => userMedia.openStream(userId, id, range) }, segments[1]);
            }

            sendJson(res, 404, { error: 'Not found' });
            return true;
        } catch (err) {
            sendJson(res, 500, { error: 'Library error', detail: err.message });
            return true;
        }
    }

    return { handle, service, artworkStore, userMedia, tickets, scanner, deviceLibrary, prefix: PREFIX };
}

/**
 * What the page is told about searching this device: how the search is going,
 * whether searching has been agreed to here, and the music locations as names
 * and counts. Where they are on this machine stays on this machine.
 */
function deviceScanReport(scanner, deviceLibrary) {
    const state = deviceLibrary.readState();
    return {
        scan: scanner.statusFor(),
        running: scanner.isRunning(),
        permission: state.permission,
        lastScanAt: state.lastScanAt,
        lastSuccessfulScanAt: state.lastSuccessfulScanAt,
        lastScanSummary: state.lastScanSummary,
        trackCount: deviceLibrary.getTracks().length,
        locations: deviceLibrary.describeLocations()
    };
}

/**
 * A track of this person's own music, with a short-lived ticket on its media
 * URLs so the browser can play it without sending a header.
 */
function withTicket(track, tickets, userId) {
    if (!track) return track;
    const ticket = tickets.issue(userId, track.id);
    return Object.assign({}, track, {
        streamUrl: track.streamUrl + '?ticket=' + encodeURIComponent(ticket),
        artworkUrl: track.artworkUrl + '?ticket=' + encodeURIComponent(ticket),
        personal: true
    });
}

/**
 * Take one audio file from the browser and keep it on this device.
 *
 * The body is the audio itself, streamed straight to disk - never held whole
 * in memory, never encoded as Base64. The caller supplies a name and nothing
 * more: it cannot choose where the file lands.
 */
async function importDeviceFile(req, res, userMedia, tickets, userId, query) {
    const fileName = (query && query.name) || '';

    try {
        const result = await userMedia.importStream(userId, { fileName: fileName, stream: req });
        sendJson(res, result.duplicate ? 200 : 201, {
            track: withTicket(result.track, tickets, userId),
            duplicate: result.duplicate
        });
    } catch (err) {
        sendJson(res, err.status || 400, { error: err.message, code: err.code || null });
    }
    return true;
}

function unauthorized(res) {
    sendJson(res, 401, { error: 'Sign in to use your own music' });
    return true;
}

const MAX_ARTWORK_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Accept one image for a person's own album.
 *
 * The body is the raw image; the caller never supplies a name or a path, so a
 * request cannot write anywhere except the artwork folder. The response is the
 * stable id and URL to keep on the album.
 */
function uploadUserArtwork(req, res, artworkStore) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let aborted = false;

        req.on('data', (chunk) => {
            if (aborted) return;
            size += chunk.length;
            if (size > MAX_ARTWORK_UPLOAD_BYTES) {
                aborted = true;
                chunks.length = 0;
                sendJson(res, 413, { error: 'Image is larger than 2 MB' });
                // Drain the rest instead of cutting the connection, so the
                // caller can actually read that answer.
                req.resume();
                resolve(true);
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (aborted) return;
            try {
                const stored = artworkStore.save(Buffer.concat(chunks), req.headers['content-type']);
                sendJson(res, 201, stored);
            } catch (err) {
                sendJson(res, err.status || 400, { error: err.message });
            }
            resolve(true);
        });

        req.on('error', () => {
            if (aborted) return;
            aborted = true;
            sendJson(res, 400, { error: 'Upload failed' });
            resolve(true);
        });
    });
}

/** Serve a stored image by id; anything unknown falls back to the placeholder. */
function serveUserArtwork(req, res, artworkStore, id) {
    const found = artworkStore.find(id);
    if (!found) {
        // A missing file is not an error for the page: it shows the default
        // cover rather than a broken image.
        sendFallbackArtwork(res);
        return true;
    }

    res.writeHead(200, {
        'Content-Type': found.mimeType,
        'Content-Length': found.size,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600'
    });

    if (req.method === 'HEAD') {
        res.end();
        return true;
    }

    const stream = fs.createReadStream(found.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return true;
}

function methodNotAllowed(res) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
}

function streamTrack(req, res, service, trackId) {
    const result = service.openStream(trackId, req.headers.range);

    if (result.status === 404) {
        sendJson(res, 404, { error: 'Track not found' });
        return true;
    }

    if (result.status === 416) {
        res.writeHead(416, result.headers);
        res.end();
        return true;
    }

    res.writeHead(result.status, result.headers);

    if (req.method === 'HEAD') {
        if (result.stream) result.stream.destroy();
        res.end();
        return true;
    }

    if (!result.stream) {
        res.end();
        return true;
    }

    // Streamed from disk: the whole file is never held in memory.
    result.stream.on('error', () => {
        res.destroy();
    });
    res.on('close', () => {
        result.stream.destroy();
    });
    result.stream.pipe(res);
    return true;
}

module.exports = { createLibraryRoutes, LIBRARY_PREFIX: PREFIX };
