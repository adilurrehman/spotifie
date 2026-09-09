'use strict';

/**
 * Unified catalogue: the local library plus the global admin catalogue,
 * behind one platform-neutral model.
 *
 * Rules that hold everywhere in this file:
 * - IDs are namespaced (local:, global:, local-album:, global-album:), so the
 *   two sources can never collide or be confused for one another.
 * - Removing global content for a user is a local preference. Deleting it for
 *   everyone is a separate, admin-only path in GlobalCatalog.
 * - One source failing degrades that source only: an unreachable Supabase
 *   still leaves the local library fully usable, and vice versa.
 */

const { LibraryService } = require('./libraryService');
const { GlobalCatalog, parseGlobalAlbumId } = require('./globalCatalog');
const { UserStateStore } = require('./userState');
const { LibraryBackup } = require('./libraryBackup');
const { UserArtworkStore } = require('./userArtwork');
const { UserMediaStore } = require('./userMedia');
const { DeviceLibrary } = require('./deviceLibrary');
const { PlaybackProgressStore } = require('./playbackProgress');
const { MediaTickets } = require('./mediaTickets');

const LOCAL_TRACK_PREFIX = 'local:';
const LOCAL_ALBUM_PREFIX = 'local-album:';

function toLocalTrackId(hash) {
    return LOCAL_TRACK_PREFIX + hash;
}

function toLocalAlbumId(albumId) {
    return LOCAL_ALBUM_PREFIX + albumId;
}

function parseLocalTrackId(id) {
    if (typeof id !== 'string' || !id.startsWith(LOCAL_TRACK_PREFIX)) return null;
    const hash = id.slice(LOCAL_TRACK_PREFIX.length);
    return hash.length ? hash : null;
}

function parseLocalAlbumId(id) {
    if (typeof id !== 'string' || !id.startsWith(LOCAL_ALBUM_PREFIX)) return null;
    const albumId = id.slice(LOCAL_ALBUM_PREFIX.length);
    return albumId.length ? albumId : null;
}

// The group a track with nothing in its artist field belongs to. It is a real
// group of real tracks, not an invented artist.
const UNKNOWN_ARTIST_NAME = 'Unknown Artist';

// The one collection every song found on this machine belongs to. It is a
// name for what is there, not a record of anything: nothing is stored to make
// it exist, and it cannot be published to anybody.
const LOCAL_MUSIC_ALBUM_ID = 'system:local-music';

/** Which source an id belongs to: 'local', 'global' or null. */
function sourceOf(id) {
    if (typeof id !== 'string') return null;
    if (id.startsWith(LOCAL_TRACK_PREFIX) || id.startsWith(LOCAL_ALBUM_PREFIX)) return 'local';
    if (id.startsWith('global:') || id.startsWith('global-album:')) return 'global';
    return null;
}

/** Map a P2 library track onto the shared model. Paths never appear here. */
function mapLocalTrack(track) {
    return {
        id: toLocalTrackId(track.id),
        source: 'local',
        title: track.title,
        artist: track.artist,
        albumArtist: track.albumArtist,
        album: track.album,
        albumId: toLocalAlbumId(track.albumId),
        duration: track.duration,
        artworkUrl: track.artworkUrl,
        streamUrl: track.streamUrl,
        metadata: {
            trackNumber: track.trackNumber,
            discNumber: track.discNumber,
            year: track.year,
            genre: track.genre,
            format: track.format,
            bitrate: track.bitrate,
            hasArtwork: track.hasArtwork,
            fileName: track.fileName,
            size: track.size,
            addedAt: track.addedAt || null
        }
    };
}

function mapLocalAlbum(album) {
    return {
        id: toLocalAlbumId(album.id),
        source: 'local',
        title: album.title,
        artist: album.albumArtist,
        albumArtist: album.albumArtist,
        // Local albums come from file tags, which carry no album description.
        description: null,
        artworkUrl: album.artworkUrl,
        trackCount: album.trackCount,
        duration: album.duration,
        metadata: { year: album.year }
    };
}

/**
 * A published album as one particular listener sees it.
 *
 * The shared record is what an administrator published; a listener may keep
 * their own title, artist, description or cover for it. Those edits live in
 * that person's local state and are applied here, in the one place, so a card
 * and a dialog can never disagree about what an album looks like.
 *
 * The shared record itself is never modified.
 */
function applyAlbumOverride(album, override) {
    // What the administrator published, kept alongside so a listener can see
    // the difference and go back to it.
    const published = {
        title: album.title,
        artist: album.artist || album.albumArtist,
        description: album.description || null,
        artworkUrl: album.artworkUrl
    };

    if (!override) return Object.assign({}, album, { published: published, hasLocalEdits: false, localEdits: null });

    const personal = Object.assign({}, album, { published: published });
    if (override.title) personal.title = override.title;
    if (override.artist) {
        personal.artist = override.artist;
        personal.albumArtist = override.artist;
    }
    if (override.description) personal.description = override.description;

    if (override.artwork && override.artwork.reference) {
        // A local cover: served by this machine, with the published cover as
        // the fallback if the file has gone.
        personal.artworkUrl = '/api/library/artwork/' + encodeURIComponent(override.artwork.reference);
        personal.fallbackArtworkUrl = album.artworkUrl;
    }

    personal.hasLocalEdits = true;
    personal.localEdits = {
        title: override.title || null,
        artist: override.artist || null,
        description: override.description || null,
        artwork: override.artwork ? override.artwork.reference : null,
        updatedAt: override.updatedAt || null
    };

    return personal;
}

/** What a listener with nothing saved has, and what a failed read falls back to. */
function emptyPersonalState() {
    return {
        hiddenGlobalTrackIds: [],
        hiddenGlobalAlbumIds: [],
        hiddenLocalTrackIds: [],
        globalAlbumOverrides: {},
        globalAlbumTrackAdds: {}
    };
}

/**
 * Local Music: one collection holding everything found on this machine.
 *
 * It is not made from tags and it is not stored anywhere - it is simply what
 * the local music adds up to, named once so the library has somewhere to put
 * it. Its cover is borrowed from a song that has one.
 */
function localMusicAlbum(tracks) {
    const cover = tracks.find((track) => track.metadata && track.metadata.hasArtwork);
    const duration = tracks.reduce((total, track) => total + (track.duration || 0), 0);

    return [
        {
            id: LOCAL_MUSIC_ALBUM_ID,
            source: 'local',
            system: true,
            title: 'Local Music',
            artist: 'On this device',
            albumArtist: 'On this device',
            description: null,
            artworkUrl: cover ? cover.artworkUrl : null,
            trackCount: tracks.length,
            duration: duration,
            metadata: { year: null }
        }
    ];
}

/**
 * The albums a set of local tracks makes up, gathered from the tracks
 * themselves so that music from several folders falls together the way it
 * should. The cover comes from a track of the album, so whatever that track's
 * artwork URL needs to carry, the album's carries too.
 */
function albumsFromTracks(tracks, flags) {
    const albums = new Map();

    for (const track of tracks) {
        let album = albums.get(track.albumId);
        if (!album) {
            album = Object.assign(
                {
                    id: track.albumId,
                    source: 'local',
                    title: track.album,
                    artist: track.albumArtist,
                    albumArtist: track.albumArtist,
                    description: null,
                    artworkUrl: null,
                    trackCount: 0,
                    duration: 0,
                    metadata: { year: track.metadata ? track.metadata.year : null }
                },
                flags || {}
            );
            albums.set(track.albumId, album);
        }

        album.trackCount += 1;
        if (track.duration) album.duration += track.duration;
        if (!album.artworkUrl && track.metadata && track.metadata.hasArtwork) album.artworkUrl = track.artworkUrl;
    }

    return Array.from(albums.values());
}

/**
 * Copies of a person's own tracks, placed inside the published albums they
 * added them to.
 *
 * A copy carries the same id, the same stream and the same audio: only the
 * album it belongs to differs, so the song shows up in that album for this
 * account without the shared catalogue changing in any way.
 */
function attachPersonalTracks(localTracks, globalAlbums, adds) {
    const keys = Object.keys(adds || {});
    if (!keys.length) return [];

    const byId = new Map(localTracks.map((track) => [track.id, track]));
    const visibleAlbums = new Set(globalAlbums.map((album) => album.id));
    const attached = [];
    // One song is a member of an album once, whatever the stored list says.
    const placed = new Set();

    for (const albumUuid of keys) {
        const albumId = 'global-album:' + albumUuid;
        if (!visibleAlbums.has(albumId)) continue;

        for (const trackId of adds[albumUuid]) {
            const track = byId.get(trackId);
            if (!track) continue;

            const membership = albumId + '::' + trackId;
            if (placed.has(membership)) continue;
            placed.add(membership);

            attached.push(Object.assign({}, track, { albumId: albumId, addedToAlbum: true }));
        }
    }

    return attached;
}

/** The album's uuid, for looking its overrides up. */
function albumOverrideKey(albumId) {
    return parseGlobalAlbumId(albumId);
}

class CatalogService {
    constructor(options) {
        const settings = options || {};
        this.library = settings.library || new LibraryService();
        this.global = settings.global || new GlobalCatalog();
        this.userState = settings.userState || new UserStateStore(settings.userStateOptions);
        // Reads and writes the same state through one document format, so a
        // backup never has to know how the live state happens to be shaped.
        this.backup = settings.backup || new LibraryBackup({ userState: this.userState });
        this.userArtwork = settings.userArtwork || new UserArtworkStore(settings.userArtworkOptions);
        // Music each person imported from their own device, and the tickets
        // that let their browser play it.
        this.userMedia = settings.userMedia || new UserMediaStore(settings.userMediaOptions);
        this.tickets = settings.tickets || new MediaTickets(settings.ticketOptions);
        // Music found on this machine. It belongs to the device: a guest and
        // every account signed in here see the same songs.
        this.deviceLibrary = settings.deviceLibrary || new DeviceLibrary(settings.deviceOptions);
        // Where each listener stopped in each track: their own state file when
        // they are signed in, this machine's own file when they are not.
        this.progress =
            settings.progress ||
            new PlaybackProgressStore(
                Object.assign({ userState: this.userState, deviceDir: this.deviceLibrary.deviceDir }, settings.progressOptions)
            );
    }

    /**
     * Where this listener stopped in each track.
     *
     * A guest is answered from the device's own file, so listening still
     * carries on across a refresh without an account. Nothing here is ever
     * sent to Supabase.
     */
    getProgressFor(userId) {
        return this.progress.read(userId || null);
    }

    saveProgressFor(userId, trackId, position, duration) {
        return this.progress.save(userId || null, trackId, position, duration);
    }

    clearProgressFor(userId, trackId) {
        return this.progress.clear(userId || null, trackId || null);
    }

    /**
     * Local half of the catalogue: the music on this device.
     *
     * Two things everyone here can play - the shared music root, and whatever
     * a search of this machine has found - plus, for a signed-in caller, the
     * music that person imported themselves, which nobody else sees.
     */
    readLocal(userId) {
        // Three separate sources, read separately, on purpose.
        //
        // They used to share one try/catch, and that was the bug: a failure in
        // the part belonging to an account - a ticket that could not be
        // issued, an unreadable state file, imported media that would not be
        // listed - discarded the music on the machine along with it. Local
        // Music then vanished for whoever was signed in and came back only
        // after a manual rescan, because a rescan rebuilt the whole answer.
        //
        // The machine's music does not depend on who is looking at it. Each
        // source is read on its own now, and one failing costs only itself.
        const shared = this.readSafely('the shared music root', () => ({
            tracks: this.library.getTracks({}).items.map(mapLocalTrack),
            albums: this.library.getAlbums().items.map(mapLocalAlbum)
        }));

        const device = this.readSafely('the music on this device', () => this.readDeviceMusic(shared.tracks));

        const personal = this.readSafely('this account\'s imported music', () =>
            this.readPersonalMedia(userId, shared.tracks.concat(device.tracks))
        );

        // Everything the machine holds, whoever put it there.
        const onThisDevice = device.tracks.concat(personal.tracks);

        // The collection exists because this machine is one Spotifie searches.
        // Not because a search has found anything, not because somebody is
        // signed in, and not because the last read succeeded - a permission
        // that was given once is a fact about the installation, and it is
        // stored with the installation.
        const searchesThisDevice = this.searchesThisDevice() || onThisDevice.length > 0;
        const deviceAlbums = searchesThisDevice ? localMusicAlbum(onThisDevice) : [];

        // Only the shared root failing means the local library itself could not
        // be read. The device half and the personal half are additions to it,
        // and neither absence makes the library unavailable.
        return {
            available: shared.ok,
            tracks: shared.tracks.concat(onThisDevice),
            albums: shared.albums.concat(deviceAlbums),
            error: shared.error
        };
    }

    /**
     * Read one source, and let it fail alone.
     *
     * Answers what it read, or an empty result and the reason. Nothing that
     * fails here can take another source down with it, which is the whole
     * point: the music on a machine is not conditional on an account's state
     * being readable.
     */
    readSafely(what, read) {
        try {
            const result = read() || {};
            return {
                ok: true,
                tracks: result.tracks || [],
                albums: result.albums || [],
                error: null
            };
        } catch (err) {
            console.error('Could not read ' + what + ':', err.message);
            return { ok: false, tracks: [], albums: [], error: err.message };
        }
    }

    /**
     * Is this machine one Spotifie looks at?
     *
     * The permission lives with the installation - written to this device's
     * own state file the moment it is given - so it survives a refresh, a
     * restart, signing in, signing out and any number of accounts. It is asked
     * for here rather than read from anything to do with a session, because
     * whose library is being shown has nothing to do with whether this machine
     * is searched.
     *
     * A device whose state cannot be read is treated as not yet allowed, which
     * is the same answer a fresh installation gives.
     */
    searchesThisDevice() {
        try {
            return this.deviceLibrary.isAllowed();
        } catch (err) {
            console.error('Could not read this device\'s scan permission:', err.message);
            return false;
        }
    }

    /**
     * The music a search of this device has found.
     *
     * No account and no ticket: this is the machine's own music, played
     * straight from it by whoever is using Spotifie here. A song that is also
     * in the shared music root is left to the shared music root, so the same
     * song is never listed twice.
     *
     * These songs are gathered into Local Music rather than into albums made
     * from their tags: a folder of downloads is not an album, and a hundred
     * untagged files would otherwise become a hundred cards called Unknown
     * Album. Every song keeps its own title, artist and album tags - they are
     * simply not what decides which card it appears under.
     */
    readDeviceMusic(sharedTracks) {
        const shared = new Set((sharedTracks || []).map((track) => track.id));
        const tracks = [];

        for (const track of this.deviceLibrary.getTracks()) {
            const mapped = mapLocalTrack(track);
            if (shared.has(mapped.id)) continue;
            mapped.device = true;
            mapped.albumId = LOCAL_MUSIC_ALBUM_ID;
            tracks.push(mapped);
        }

        return { tracks: tracks, albums: localMusicAlbum(tracks) };
    }

    /**
     * One person's imported music, as catalogue entries.
     *
     * Media URLs carry a short-lived ticket, because an <audio> element
     * cannot send a header; the ticket names this account and this track and
     * nothing else. A track already in the shared root is left to the shared
     * root, so the same song is never listed twice.
     */
    readPersonalMedia(userId, sharedTracks) {
        if (!userId) return { tracks: [], albums: [] };

        const shared = new Set((sharedTracks || []).map((track) => track.id));
        const tracks = [];

        for (const track of this.userMedia.getTracks(userId)) {
            const mapped = mapLocalTrack(track);
            if (shared.has(mapped.id)) continue;

            const ticket = this.tickets.issue(userId, track.id);
            mapped.streamUrl = mapped.streamUrl + '?ticket=' + encodeURIComponent(ticket);
            mapped.artworkUrl = mapped.artworkUrl + '?ticket=' + encodeURIComponent(ticket);
            mapped.personal = true;
            tracks.push(mapped);
        }

        if (!tracks.length) return { tracks: [], albums: [] };

        // Music someone imported is on this device too, and belongs with the
        // rest of it rather than in albums of its own.
        for (const track of tracks) track.albumId = LOCAL_MUSIC_ALBUM_ID;
        return { tracks: tracks, albums: [] };
    }

    /**
     * Global half of the catalogue.
     * Readable by guests: browsing the admin catalogue needs no account.
     */
    async readGlobal(token) {
        return this.global.fetchCatalog(token || null);
    }

    /**
     * This person's own state, or the empty one for a guest.
     *
     * A state file that cannot be read answers the same as a guest's. It means
     * this listener's likes and hidden items are missing for the moment, which
     * is worth saying out loud in the log; it does not mean the music on the
     * machine is gone, and it must never be allowed to say so.
     */
    readPersonalState(userId) {
        if (userId) {
            try {
                return this.userState.read(userId);
            } catch (err) {
                console.error('Could not read this account\'s state:', err.message);
            }
        }
        return emptyPersonalState();
    }

    /**
     * The half of the catalogue this machine can answer by itself.
     *
     * Everything here is already on the device: the music found on it, the
     * music this account imported, and the personal state that decides how the
     * published catalogue is shown to this listener. Nothing in it needs
     * Supabase, so it comes back at the speed of a local read - which is what
     * lets the library be drawn before the published catalogue has been
     * checked.
     *
     * The personal part is scoped to the caller. A guest is given the empty
     * state, never somebody else's.
     */
    getLocalCatalog(options) {
        const settings = options || {};
        const userId = settings.userId || null;

        const local = this.readLocal(userId);
        const state = this.readPersonalState(userId);

        const hiddenLocal = new Set(state.hiddenLocalTrackIds || []);
        const tracks = local.tracks.filter((track) => !hiddenLocal.has(track.id));
        const albumIds = new Set(tracks.map((track) => track.albumId));
        // Local Music stays whether or not anything is in it, so the card is
        // on the page from the first paint and is never taken away and put
        // back while the index is still being read.
        const albums = local.albums.filter((album) => album.system || albumIds.has(album.id));

        return {
            total: albums.length,
            albums: albums,
            tracks: tracks,
            sources: {
                local: { available: local.available, trackCount: local.tracks.length, error: local.error },
                // The published catalogue was not asked about here. Saying so
                // is not the same as saying it is unavailable, and a caller
                // must not read this as an outage.
                global: { available: null, skipped: true, trackCount: 0, error: null }
            },
            // How this listener has personalised published albums, and what
            // they have put inside them. Applied to the cached catalogue in
            // the browser so nothing waits on Supabase to look right.
            overrides: state.globalAlbumOverrides || {},
            addedToGlobalAlbums: state.globalAlbumTrackAdds || {},
            hidden: {
                globalTracks: Array.from(state.hiddenGlobalTrackIds || []),
                globalAlbums: Array.from(state.hiddenGlobalAlbumIds || []),
                localTracks: Array.from(hiddenLocal)
            }
        };
    }

    /**
     * Merged catalogue for one caller.
     * `userId` scopes hidden items; without it nothing is hidden.
     */
    async getCatalog(options) {
        const settings = options || {};
        const token = settings.token || null;
        const userId = settings.userId || null;

        const local = this.readLocal(userId);
        const global = await this.readGlobal(token);

        const hidden = this.readPersonalState(userId);

        const overrides = hidden.globalAlbumOverrides || {};

        const hiddenTracks = new Set(hidden.hiddenGlobalTrackIds || []);
        const hiddenAlbums = new Set(hidden.hiddenGlobalAlbumIds || []);
        const hiddenLocal = new Set(hidden.hiddenLocalTrackIds || []);

        // A hidden album takes its tracks with it, for this user only.
        const visibleGlobalTracks = global.tracks.filter(
            (track) => !hiddenTracks.has(track.id) && !(track.albumId && hiddenAlbums.has(track.albumId))
        );
        // Each published album is shown as this listener has it: their own
        // edits on top of the shared record, which is left as it is.
        const visibleGlobalAlbums = global.albums
            .filter((album) => !hiddenAlbums.has(album.id))
            .map((album) => applyAlbumOverride(album, overrides[albumOverrideKey(album.id)]));

        const visibleLocalTracks = local.tracks.filter((track) => !hiddenLocal.has(track.id));
        const visibleLocalAlbumIds = new Set(visibleLocalTracks.map((track) => track.albumId));
        // An album made from tags is only there while some song still says it
        // is. A system collection is not: Local Music is what this machine
        // holds, and holding nothing is an answer rather than a reason to
        // disappear.
        const visibleLocalAlbums = local.albums.filter(
            (album) => album.system || visibleLocalAlbumIds.has(album.id)
        );

        // Songs of their own that this person has put into published
        // albums. The track keeps its own id and its own audio; it simply also
        // appears inside that album, for this account.
        const attached = attachPersonalTracks(
            visibleLocalTracks,
            visibleGlobalAlbums,
            hidden.globalAlbumTrackAdds || {}
        );

        const tracks = visibleLocalTracks.concat(attached, visibleGlobalTracks);
        const albums = visibleLocalAlbums.concat(visibleGlobalAlbums);

        return {
            tracks: tracks,
            albums: albums,
            sources: {
                local: { available: local.available, trackCount: local.tracks.length, error: local.error },
                global: { available: global.available, trackCount: global.tracks.length, error: global.error }
            },
            addedToGlobalAlbums: hidden.globalAlbumTrackAdds || {},
            hidden: {
                globalTracks: Array.from(hiddenTracks),
                globalAlbums: Array.from(hiddenAlbums),
                localTracks: Array.from(hiddenLocal)
            },
            overriddenAlbums: Object.keys(overrides)
        };
    }

    async getTracks(options) {
        const catalog = await this.getCatalog(options);
        const settings = options || {};

        let tracks = catalog.tracks;
        if (settings.albumId) tracks = tracks.filter((track) => track.albumId === settings.albumId);
        if (settings.source) tracks = tracks.filter((track) => track.source === settings.source);

        tracks.sort((a, b) => {
            const albumCompare = String(a.album || '').localeCompare(String(b.album || ''));
            if (albumCompare !== 0) return albumCompare;
            const aNumber = (a.metadata && a.metadata.trackNumber) || 0;
            const bNumber = (b.metadata && b.metadata.trackNumber) || 0;
            if (aNumber !== bNumber) return aNumber - bNumber;
            return String(a.title).localeCompare(String(b.title));
        });

        return { total: tracks.length, items: tracks, sources: catalog.sources };
    }

    async getAlbums(options) {
        const catalog = await this.getCatalog(options);
        const settings = options || {};

        const albums = settings.source
            ? catalog.albums.filter((album) => album.source === settings.source)
            : catalog.albums;

        return { total: albums.length, items: albums, sources: catalog.sources };
    }

    /**
     * Artists, worked out from the tracks themselves.
     *
     * There is no artist table and there does not need to be one: an artist is
     * what a group of tracks say they are by. A track with nothing in that
     * field belongs to Unknown Artist - a real group of real tracks - and
     * never to an artist invented from an id or a file name.
     *
     * Each one carries the albums it appears on, from the library as this
     * person has it, so an artist page can be drawn without a second pass.
     */
    async getArtists(options) {
        const catalog = await this.getCatalog(options);
        const settings = options || {};

        const albumTitles = new Map(catalog.albums.map((album) => [album.id, album.title]));
        const artists = new Map();

        for (const track of catalog.tracks) {
            const name = track.artist || UNKNOWN_ARTIST_NAME;
            let artist = artists.get(name);

            if (!artist) {
                artist = {
                    id: 'artist:' + name.toLowerCase(),
                    name: name,
                    trackCount: 0,
                    duration: 0,
                    sources: [],
                    albums: [],
                    _albumIds: new Set()
                };
                artists.set(name, artist);
            }

            artist.trackCount += 1;
            if (Number.isFinite(track.duration)) artist.duration += track.duration;
            if (artist.sources.indexOf(track.source) === -1) artist.sources.push(track.source);

            // Only albums that are actually in the library as it stands. A
            // track whose album has been hidden or withdrawn adds nothing.
            if (track.albumId && !artist._albumIds.has(track.albumId) && albumTitles.has(track.albumId)) {
                artist._albumIds.add(track.albumId);
                artist.albums.push({ id: track.albumId, title: albumTitles.get(track.albumId) });
            }

            if (settings.artistName && name === settings.artistName) {
                if (!artist.tracks) artist.tracks = [];
                artist.tracks.push(track);
            }
        }

        const items = Array.from(artists.values()).map((artist) => {
            delete artist._albumIds;
            return artist;
        });

        // By name, so the list reads the way a list of names should.
        items.sort((a, b) => a.name.localeCompare(b.name));

        const wanted = settings.artistName ? items.filter((artist) => artist.name === settings.artistName) : items;
        return { total: wanted.length, items: wanted };
    }

    // ============================================
    // What somebody has made of the library
    //
    // Likes, playlists and listening history are lists of track ids and
    // nothing else. The songs they name are looked up against the library
    // every time they are asked for, so a file that has moved, a track an
    // administrator has withdrawn, or music on a machine this account has not
    // used, is a missing entry rather than a broken one. Nothing here is ever
    // sent to Supabase.
    // ============================================

    /**
     * Turn a list of track ids into the tracks they name.
     *
     * Order is kept exactly as given - a playlist is an arrangement - and the
     * same id appearing twice yields the track twice, because somebody put it
     * there twice. An id that names nothing this library can see comes back as
     * a missing entry carrying only the id, so a caller can show it as
     * unavailable and offer to remove it, rather than pretending it is not
     * there.
     */
    resolveTrackIds(trackIds, tracksById) {
        const items = [];
        const missing = [];

        for (const id of trackIds || []) {
            const track = tracksById.get(id);
            if (track) {
                items.push(track);
            } else {
                const entry = { id: id, source: sourceOf(id), missing: true };
                items.push(entry);
                missing.push(id);
            }
        }

        return { items: items, missing: missing };
    }

    /** Every track in the effective library, by id, for looking ids up. */
    indexTracksById(tracks) {
        const byId = new Map();
        for (const track of tracks) {
            // A track that also appears inside a published album is the same
            // track listed again; the first entry is the one that describes it.
            if (!byId.has(track.id)) byId.set(track.id, track);
        }
        return byId;
    }

    /**
     * Everything this person has made, resolved against the library as it is
     * now.
     *
     * One read of the catalogue answers all of it, so opening the library does
     * not cost one journey per collection. A guest has none of this and is
     * given empty collections rather than somebody else's.
     */
    async getPersonalCollections(options) {
        const settings = options || {};
        const userId = settings.userId || null;

        const catalog = await this.getCatalog(settings);
        const byId = this.indexTracksById(catalog.tracks);

        if (!userId) {
            return {
                signedIn: false,
                liked: { total: 0, items: [], missing: [] },
                playlists: [],
                recentlyPlayed: { total: 0, items: [], missing: [] },
                sources: catalog.sources
            };
        }

        const state = this.userState.read(userId);

        const liked = this.resolveTrackIds(state.likedTrackIds, byId);
        const recent = this.resolveTrackIds(
            state.recentlyPlayed.map((entry) => entry.id),
            byId
        );

        // The time each was played, put back beside the track it belongs to.
        const playedAt = new Map(state.recentlyPlayed.map((entry) => [entry.id, entry.playedAt]));
        for (const item of recent.items) item.playedAt = playedAt.get(item.id) || null;

        const playlists = state.playlists.map((playlist) => this.describePlaylist(playlist, byId));

        return {
            signedIn: true,
            liked: { total: liked.items.length, items: liked.items, missing: liked.missing },
            playlists: playlists,
            recentlyPlayed: { total: recent.items.length, items: recent.items, missing: recent.missing },
            sources: catalog.sources
        };
    }

    /**
     * One playlist, with its songs and the two numbers a listener reads first:
     * how many there are and how long they run.
     *
     * A missing song counts towards neither. It is still listed, because it is
     * still in the playlist and its owner may want to take it out.
     */
    describePlaylist(playlist, byId) {
        const resolved = this.resolveTrackIds(playlist.trackIds, byId);

        let duration = 0;
        let playable = 0;
        for (const track of resolved.items) {
            if (track.missing) continue;
            playable += 1;
            if (Number.isFinite(track.duration)) duration += track.duration;
        }

        return {
            id: playlist.id,
            source: 'playlist',
            title: playlist.title,
            description: playlist.description,
            artworkUrl: playlist.artwork && playlist.artwork.reference
                ? '/api/library/artwork/' + encodeURIComponent(playlist.artwork.reference)
                : null,
            trackCount: resolved.items.length,
            playableCount: playable,
            duration: duration,
            createdAt: playlist.createdAt,
            updatedAt: playlist.updatedAt,
            tracks: resolved.items,
            missing: resolved.missing
        };
    }

    /** One playlist by id, resolved. Null when this person has no such list. */
    async getPlaylist(playlistId, options) {
        const settings = options || {};
        if (!settings.userId) return null;

        const playlist = this.userState.getPlaylist(settings.userId, playlistId);
        if (!playlist) return null;

        const catalog = await this.getCatalog(settings);
        return this.describePlaylist(playlist, this.indexTracksById(catalog.tracks));
    }

    /**
     * The music that arrived most recently.
     *
     * For a file on this device, when the file was written; for a published
     * track, when it was published. Neither is invented and neither is
     * written back - both are already known, and this only sorts by them.
     * A track with no date at all is left out rather than being given one.
     */
    async getRecentlyAdded(options) {
        const settings = options || {};
        const limit = Number.isFinite(settings.limit) && settings.limit > 0 ? Math.floor(settings.limit) : 100;

        const catalog = await this.getCatalog(settings);

        const dated = [];
        for (const track of catalog.tracks) {
            const metadata = track.metadata || {};
            const when = track.source === 'global' ? metadata.createdAt : metadata.addedAt;
            if (!when) continue;

            const at = Date.parse(when);
            if (!Number.isFinite(at)) continue;

            dated.push({ track: track, at: at });
        }

        dated.sort((a, b) => b.at - a.at);

        return {
            total: dated.length,
            items: dated.slice(0, limit).map((entry) => Object.assign({ addedAt: new Date(entry.at).toISOString() }, entry.track))
        };
    }

    async getTrack(trackId, options) {
        const settings = options || {};
        const localHash = parseLocalTrackId(trackId);

        if (localHash) {
            const track = this.library.getTrack(localHash);
            return track ? mapLocalTrack(track) : null;
        }

        const catalog = await this.getCatalog(settings);
        return catalog.tracks.find((track) => track.id === trackId) || null;
    }

    /**
     * Where to actually play a track from.
     * Local tracks stream from this server; global tracks resolve to a
     * short-lived signed Supabase URL. Either way the caller gets a URL, never
     * a filesystem path or a storage path.
     */
    async resolveStreamUrl(trackId, options) {
        const settings = options || {};
        const localHash = parseLocalTrackId(trackId);

        if (localHash) {
            const track = this.library.getTrack(localHash);
            if (track) return { url: track.streamUrl, source: 'local', expiresIn: null };

            // Music found on this device: played by whoever is using Spotifie
            // here, signed in or not.
            const onDevice = this.deviceLibrary.getTrack(localHash);
            if (onDevice) return { url: onDevice.streamUrl, source: 'device', expiresIn: null };

            // Music this person imported themselves: playable by them alone,
            // through a ticket that lasts a few hours.
            const personal = settings.userId ? this.userMedia.getTrack(settings.userId, localHash) : null;
            if (!personal) return null;

            const ticket = this.tickets.issue(settings.userId, localHash);
            return {
                url: personal.streamUrl + '?ticket=' + encodeURIComponent(ticket),
                source: 'local-personal',
                expiresIn: this.tickets.ttlSeconds
            };
        }

        if (sourceOf(trackId) !== 'global') return null;
        const resolved = await this.global.getStreamUrl(trackId, settings.token);
        if (!resolved) return null;
        return { url: resolved.url, source: 'global', expiresIn: resolved.expiresIn, mimeType: resolved.mimeType };
    }

    /** Artwork URL, or null when there is none - callers use the default cover. */
    async resolveArtworkUrl(id, options) {
        const settings = options || {};
        const localHash = parseLocalTrackId(id);

        if (localHash) {
            const track = this.library.getTrack(localHash);
            if (track) return { url: track.artworkUrl, source: 'local' };

            const onDevice = this.deviceLibrary.getTrack(localHash);
            if (onDevice) return { url: onDevice.artworkUrl, source: 'device' };

            const personal = settings.userId ? this.userMedia.getTrack(settings.userId, localHash) : null;
            if (!personal) return null;

            const ticket = this.tickets.issue(settings.userId, localHash);
            return { url: personal.artworkUrl + '?ticket=' + encodeURIComponent(ticket), source: 'local-personal' };
        }

        const localAlbum = parseLocalAlbumId(id);
        if (localAlbum) {
            const album = this.library.getAlbums().items.find((entry) => entry.id === localAlbum);
            if (album && album.artworkUrl) return { url: album.artworkUrl, source: 'local' };

            // An album made of music found on this device, or of music
            // this person imported themselves.
            const shared = this.library.getTracks({}).items.map(mapLocalTrack);
            const device = this.readDeviceMusic(shared);
            const wanted = toLocalAlbumId(localAlbum);

            const onDevice = device.albums.find((entry) => entry.id === wanted);
            if (onDevice && onDevice.artworkUrl) return { url: onDevice.artworkUrl, source: 'device' };

            const personal = settings.userId
                ? this.readPersonalMedia(settings.userId, shared.concat(device.tracks))
                : { albums: [] };
            const mine = personal.albums.find((entry) => entry.id === wanted);
            if (!mine || !mine.artworkUrl) return null;
            return { url: mine.artworkUrl, source: 'local-personal' };
        }

        if (sourceOf(id) !== 'global') return null;

        // A listener who replaced this album's cover sees their own image; if
        // that file has gone, the published cover is used instead.
        const albumUuid = parseGlobalAlbumId(id);
        if (albumUuid && settings.userId) {
            const override = this.userState.getAlbumOverride(settings.userId, albumUuid);
            const reference = override && override.artwork ? override.artwork.reference : null;
            if (reference && this.userArtwork.find(reference)) {
                return { url: '/api/library/artwork/' + encodeURIComponent(reference), source: 'local-override' };
            }
        }

        const resolved = await this.global.getArtworkUrl(id, settings.token);
        return resolved ? { url: resolved.url, source: 'global', expiresIn: resolved.expiresIn } : null;
    }

    /**
     * Where the published artwork for this id can be read, and what it is
     * currently called.
     *
     * Deliberately the published picture and nothing else: a listener's own
     * cover is a file on this machine with its own address, and is never
     * served from here. Answering null means there is no published artwork,
     * which is not an error.
     */
    async findGlobalArtwork(id, options) {
        const settings = options || {};
        if (sourceOf(id) !== 'global') return null;
        return this.global.findArtworkObject(id, settings.token || null);
    }

    // ============================================
    // Changing what somebody has made
    //
    // Each of these needs an account, because each of them belongs to one.
    // A guest is refused here rather than being given a place to put things
    // that nobody would own.
    // ============================================

    requireUser(userId, what) {
        if (!userId) throw new Error(what + ' needs you to be signed in');
        return userId;
    }

    /** Like a song, or unlike it if it is already liked. */
    toggleLikeForUser(userId, trackId) {
        this.requireUser(userId, 'Liking a song');
        return this.userState.toggleLike(userId, trackId);
    }

    likeForUser(userId, trackId) {
        this.requireUser(userId, 'Liking a song');
        return this.userState.like(userId, trackId);
    }

    unlikeForUser(userId, trackId) {
        this.requireUser(userId, 'Liking a song');
        return this.userState.unlike(userId, trackId);
    }

    getLikedForUser(userId) {
        return userId ? this.userState.getLiked(userId) : [];
    }

    createPlaylistForUser(userId, details) {
        this.requireUser(userId, 'Making a playlist');
        return this.userState.createPlaylist(userId, details);
    }

    updatePlaylistForUser(userId, playlistId, patch) {
        this.requireUser(userId, 'Editing a playlist');
        return this.userState.updatePlaylist(userId, playlistId, patch);
    }

    /**
     * Delete a playlist, and the cover made for it.
     *
     * The songs stay exactly where they were: a playlist names music, it does
     * not hold it. A cover the owner chose is a file on this machine and goes
     * with the list, because nothing else refers to it.
     */
    deletePlaylistForUser(userId, playlistId) {
        this.requireUser(userId, 'Deleting a playlist');

        const removed = this.userState.deletePlaylist(userId, playlistId);
        if (!removed) return null;

        const reference = removed.artwork ? removed.artwork.reference : null;
        if (reference) this.userArtwork.remove(reference);

        return removed;
    }

    addPlaylistTrackForUser(userId, playlistId, trackId, options) {
        this.requireUser(userId, 'Adding to a playlist');
        return this.userState.addPlaylistTrack(userId, playlistId, trackId, options);
    }

    removePlaylistTrackForUser(userId, playlistId, trackId, options) {
        this.requireUser(userId, 'Removing from a playlist');
        return this.userState.removePlaylistTrack(userId, playlistId, trackId, options);
    }

    movePlaylistTrackForUser(userId, playlistId, from, to) {
        this.requireUser(userId, 'Reordering a playlist');
        return this.userState.movePlaylistTrack(userId, playlistId, from, to);
    }

    reorderPlaylistForUser(userId, playlistId, trackIds) {
        this.requireUser(userId, 'Reordering a playlist');
        return this.userState.reorderPlaylist(userId, playlistId, trackIds);
    }

    /**
     * Note that a song was played.
     *
     * A guest is not refused here, only ignored: listening without an account
     * works, and there is simply nowhere personal to write it down.
     */
    notePlayedForUser(userId, trackId, playedAt) {
        if (!userId) return [];
        return this.userState.notePlayed(userId, trackId, playedAt);
    }

    clearRecentlyPlayedForUser(userId) {
        this.requireUser(userId, 'Clearing your history');
        return this.userState.clearRecentlyPlayed(userId);
    }

    // ============================================
    // Taking a library with you
    //
    // A backup is references and nothing else: the songs it names are looked
    // up against whatever library it is restored into. That is what makes it
    // portable - the same file restored on a machine that has the music
    // reconnects to it, and on one that does not, keeps the arrangement until
    // the music turns up.
    // ============================================

    /**
     * This account's library as a document.
     *
     * The catalogue is read so hints can be written for the local tracks it
     * names: enough to recognise the same song elsewhere, and nothing about
     * where it lives.
     */
    async exportBackupFor(userId, options) {
        this.requireUser(userId, 'Exporting your library');

        const settings = options || {};
        const catalog = await this.getCatalog(Object.assign({}, settings, { userId: userId }));

        return this.backup.export(userId, {
            tracks: catalog.tracks,
            localAlbums: settings.localAlbums
        });
    }

    /**
     * Restore a backup into this account's library.
     *
     * The catalogue is read first so the summary can say how many of the songs
     * this machine can actually play. Merged rather than replaced, and written
     * in one step: an import that fails leaves the library as it was.
     */
    async importBackupFor(userId, document, options) {
        this.requireUser(userId, 'Restoring a library');

        const settings = options || {};
        const catalog = await this.getCatalog(Object.assign({}, settings, { userId: userId }));

        return this.backup.import(userId, document, {
            knownTrackIds: new Set(catalog.tracks.map((track) => track.id))
        });
    }

    /**
     * Which of these songs this library can play, and which it cannot.
     *
     * Asked when a restored collection is drawn. A local id is the fingerprint
     * of a file's contents, so the same song on this machine already answers to
     * the same id and reconnects by itself - moved, renamed, in another folder,
     * it makes no difference. This says which ones did.
     */
    async resolveReferences(trackIds, options) {
        const settings = options || {};
        const catalog = await this.getCatalog(settings);
        const known = new Set(catalog.tracks.map((track) => track.id));

        const connected = [];
        const unavailable = [];

        for (const id of trackIds || []) {
            if (known.has(id)) connected.push(id);
            else unavailable.push(id);
        }

        return { connected: connected, unavailable: unavailable };
    }

    // ============================================
    // Personal edits to published albums
    //
    // Three separate paths, deliberately kept apart:
    // - a person's own album is edited in their local library;
    // - a published album is personalised here, for that account only;
    // - the published album itself is edited in the dashboard, through
    //   GlobalCatalog, which nothing in this section can reach.
    // ============================================

    /** Save one listener's edits to a published album. Local state only. */
    setAlbumOverrideForUser(userId, albumId, override) {
        if (!userId) throw new Error('Personalising an album requires a signed-in user');

        const albumUuid = parseGlobalAlbumId(albumId);
        if (!albumUuid) throw new Error('Only published albums can be personalised');

        const previous = this.userState.getAlbumOverride(userId, albumUuid);
        const state = this.userState.setAlbumOverride(userId, albumUuid, override);

        // A replaced cover leaves its old file behind; remove it once the new
        // reference is safely stored.
        const previousReference = previous && previous.artwork ? previous.artwork.reference : null;
        const currentReference =
            state.globalAlbumOverrides[albumUuid] && state.globalAlbumOverrides[albumUuid].artwork
                ? state.globalAlbumOverrides[albumUuid].artwork.reference
                : null;

        if (previousReference && previousReference !== currentReference) {
            this.userArtwork.remove(previousReference);
        }

        return state.globalAlbumOverrides[albumUuid] || null;
    }

    /** Forget one listener's edits, restoring the published album for them. */
    clearAlbumOverrideForUser(userId, albumId) {
        if (!userId) throw new Error('Restoring an album requires a signed-in user');

        const albumUuid = parseGlobalAlbumId(albumId);
        if (!albumUuid) throw new Error('Only published albums can be personalised');

        const removed = this.userState.clearAlbumOverride(userId, albumUuid);
        if (removed && removed.artwork && removed.artwork.reference) {
            this.userArtwork.remove(removed.artwork.reference);
        }
        return Boolean(removed);
    }

    /**
     * Put one of this person's own local tracks into a published album.
     *
     * Their album only. Nothing is uploaded, nothing is copied, and the
     * shared record in Supabase is not touched - this writes one id into this
     * account's local state and stops there.
     */
    addTrackToAlbumForUser(userId, albumId, trackId) {
        if (!userId) throw new Error('Adding a song to an album requires a signed-in user');

        const albumUuid = parseGlobalAlbumId(albumId);
        if (!albumUuid) throw new Error('Only published albums take personal additions');

        const hash = parseLocalTrackId(trackId);
        if (!hash) throw new Error('Only music on this device can be added');

        const owned =
            Boolean(this.library.getTrack(hash)) ||
            Boolean(this.deviceLibrary.getTrack(hash)) ||
            Boolean(this.userMedia.getTrack(userId, hash));
        if (!owned) throw new Error('That track is not in your library');

        return this.userState.addAlbumTrack(userId, albumUuid, trackId);
    }

    /**
     * Take one of this person's tracks back out of a published album.
     * Membership only: the file on this device stays exactly where it is.
     */
    removeTrackFromAlbumForUser(userId, albumId, trackId) {
        if (!userId) throw new Error('Changing an album requires a signed-in user');

        const albumUuid = parseGlobalAlbumId(albumId);
        if (!albumUuid) throw new Error('Only published albums take personal additions');

        return this.userState.removeAlbumTrack(userId, albumUuid, trackId);
    }

    getAlbumTrackAddsForUser(userId) {
        if (!userId) return {};
        return this.userState.getAlbumTrackAdds(userId);
    }

    getAlbumOverridesForUser(userId) {
        if (!userId) return {};
        return this.userState.read(userId).globalAlbumOverrides || {};
    }

    // ============================================
    // Removal
    //
    // Two separate, deliberately dissimilar paths:
    // - hideForUser(): a per-user preference stored on this device. It cannot
    //   reach Supabase; the admin copy is untouched and other users still see
    //   the item.
    // - GlobalCatalog.deleteTrack/deleteAlbum(): permanent, admin only, and
    //   never called from here.
    // ============================================

    /** Hide a catalogue item for one user. Never deletes anything anywhere. */
    hideForUser(userId, id) {
        if (!userId) throw new Error('Hiding requires a signed-in user');

        const source = sourceOf(id);
        if (!source) throw new Error('Unknown catalogue id');

        if (source === 'local') {
            const kind = parseLocalAlbumId(id) ? 'album' : 'track';
            if (kind === 'album') throw new Error('Local albums are hidden by hiding their tracks');
            const state = this.userState.read(userId);
            const list = Array.isArray(state.hiddenLocalTrackIds) ? state.hiddenLocalTrackIds : [];
            if (!list.includes(id)) list.push(id);
            state.hiddenLocalTrackIds = list;
            return this.writeState(userId, state);
        }

        const kind = id.startsWith('global-album:') ? 'album' : 'track';
        return this.userState.hide(userId, kind, id);
    }

    /** Restore a previously hidden item for one user. */
    restoreForUser(userId, id) {
        if (!userId) throw new Error('Restoring requires a signed-in user');

        const source = sourceOf(id);
        if (!source) throw new Error('Unknown catalogue id');

        if (source === 'local') {
            const state = this.userState.read(userId);
            state.hiddenLocalTrackIds = (state.hiddenLocalTrackIds || []).filter((entry) => entry !== id);
            return this.writeState(userId, state);
        }

        const kind = id.startsWith('global-album:') ? 'album' : 'track';
        return this.userState.restore(userId, kind, id);
    }

    getHiddenForUser(userId) {
        if (!userId) return { hiddenGlobalTrackIds: [], hiddenGlobalAlbumIds: [], hiddenLocalTrackIds: [] };
        const state = this.userState.read(userId);
        return {
            hiddenGlobalTrackIds: state.hiddenGlobalTrackIds || [],
            hiddenGlobalAlbumIds: state.hiddenGlobalAlbumIds || [],
            hiddenLocalTrackIds: state.hiddenLocalTrackIds || []
        };
    }

    writeState(userId, state) {
        return this.userState.write(userId, state);
    }
}

module.exports = {
    LOCAL_MUSIC_ALBUM_ID,
    CatalogService,
    LOCAL_TRACK_PREFIX,
    LOCAL_ALBUM_PREFIX,
    toLocalTrackId,
    toLocalAlbumId,
    parseLocalTrackId,
    parseLocalAlbumId,
    sourceOf,
    mapLocalTrack,
    mapLocalAlbum
};
