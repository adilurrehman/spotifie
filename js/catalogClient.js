/**
 * Spotifie catalogue client.
 *
 * One view of all music: tracks the user has on this device (source 'local')
 * and tracks an administrator published for everyone (source 'global').
 *
 * Browsing and playing the published catalogue works without an account.
 * Personal actions - hiding something, restoring it - need a signed-in user
 * and are refused with 401 otherwise.
 *
 * The player only ever handles IDs and URLs. It never sees a filesystem path
 * or a Supabase Storage path, and it never needs to know which backend a
 * track came from to play it.
 */
(function (global) {
    'use strict';

    var DEFAULT_BASE = '/api/catalog';
    var DEFAULT_ARTWORK = 'img/music.svg';

    // ============================================
    // The pictures this device has already fetched
    // ============================================
    //
    // A published copy signs its own address for a published cover, and a
    // signed address is good for an hour and different every time. So the
    // browser's own cache cannot help: every visit asks for the same picture
    // at an address it has never seen.
    //
    // What is kept instead is the picture itself, under a name made of the
    // things about it that do not change - which album it belongs to, and
    // which version of its cover this is. A refresh finds it under that name
    // and paints it immediately, without signing anything or waiting for the
    // catalogue to be checked. A replaced cover is a different name, so the
    // old one is never shown in its place and is deleted when the new one
    // arrives.
    //
    // Nothing temporary is written down: the store holds image bytes, and the
    // signed address that fetched them is used once and dropped.

    var ARTWORK_CACHE = 'spotifie-artwork-v1';

    // The made-up address a kept picture is filed under. Never fetched - it
    // exists so the store has a stable key to hold, and the parts of it are
    // the album and the version of its cover.
    var ARTWORK_KEY_BASE = 'https://artwork.spotifie.local/';

    // Addresses for pictures this page has taken out of the store, so one
    // picture is unpacked once however many cards ask for it. Memory only, and
    // gone with the page.
    var artworkObjectUrls = new Map();

    // Items whose kept picture has just been thrown away because it did not
    // load. Written down the moment it happens, because emptying the store
    // itself takes a turn or two and the retry comes immediately after - and a
    // retry served the very copy that just failed is not a retry.
    var artworkDropped = new Set();

    function artworkStore() {
        try {
            if (typeof caches === 'undefined' || !caches || !caches.open) return Promise.resolve(null);
            return caches.open(ARTWORK_CACHE).catch(function () {
                return null;
            });
        } catch (e) {
            // Storage a browser refuses to open - a private window, a setting -
            // is a slower page and nothing worse.
            return Promise.resolve(null);
        }
    }

    /** What this picture is filed under: the item, and which cover it is. */
    function artworkKeyFor(id, version) {
        return ARTWORK_KEY_BASE + encodeURIComponent(id) + '/' + encodeURIComponent(version || 'current');
    }

    /** And the same for every version of that item's cover, kept or not. */
    function artworkKeyPrefix(id) {
        return ARTWORK_KEY_BASE + encodeURIComponent(id) + '/';
    }

    /**
     * The picture this device already has for one item, or null.
     *
     * An address into memory, so it can be painted straight into an <img>
     * without a request going anywhere.
     */
    function keptArtwork(key, id) {
        if (artworkDropped.has(id)) return Promise.resolve(null);

        var held = artworkObjectUrls.get(key);
        if (held) return Promise.resolve(held);

        return artworkStore()
            .then(function (store) {
                if (!store) return null;
                return store.match(key);
            })
            .then(function (response) {
                if (!response || !response.ok) return null;
                return response.blob();
            })
            .then(function (blob) {
                if (!blob || !blob.size) return null;

                var url = URL.createObjectURL(blob);
                artworkObjectUrls.set(key, url);
                return url;
            })
            .catch(function () {
                return null;
            });
    }

    /**
     * Keep the picture at this address under a name that will still mean
     * something tomorrow.
     *
     * The fetch is the same one the <img> is making, so this costs the network
     * nothing extra in practice. A picture that cannot be fetched - refused,
     * expired, offline - is simply not kept, and the page carries on with the
     * address it already has.
     */
    function keepArtwork(key, id, url) {
        if (!key || !url || /^data:|^blob:/.test(url)) return Promise.resolve(false);

        return artworkStore()
            .then(function (store) {
                if (!store) return false;

                return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (response) {
                    if (!response || !response.ok) return false;

                    var type = response.headers.get('content-type') || '';
                    if (type && type.indexOf('image/') !== 0) return false;

                    return store.put(key, response.clone()).then(function () {
                        // A picture that has arrived and been kept is one to
                        // serve again.
                        artworkDropped.delete(id);
                        return forgetOtherVersions(store, id, key);
                    });
                });
            })
            .catch(function () {
                return false;
            });
    }

    /** A cover that has been replaced is not one to keep a copy of. */
    function forgetOtherVersions(store, id, keep) {
        if (!id) return true;

        var prefix = artworkKeyPrefix(id);

        return store
            .keys()
            .then(function (requests) {
                var stale = requests.filter(function (request) {
                    return request.url.indexOf(prefix) === 0 && request.url !== keep;
                });

                return Promise.all(
                    stale.map(function (request) {
                        var held = artworkObjectUrls.get(request.url);
                        if (held) {
                            try {
                                URL.revokeObjectURL(held);
                            } catch (e) {
                                /* the address was already gone */
                            }
                        }
                        artworkObjectUrls.delete(request.url);
                        return store.delete(request);
                    })
                );
            })
            .then(function () {
                return true;
            })
            .catch(function () {
                return true;
            });
    }

    /**
     * Drop every copy of one item's picture, so the next ask is a fresh one.
     *
     * Called when a picture failed to load. Whatever was wrong with it, the
     * copy that was handed out is not one to hand out again - and that
     * includes the one in the store, because if that is what failed, keeping
     * it would fail the same way on every visit from here on.
     */
    function releaseKeptArtwork(id) {
        var prefix = artworkKeyPrefix(id);
        artworkDropped.add(id);

        artworkObjectUrls.forEach(function (url, key) {
            if (key.indexOf(prefix) !== 0) return;

            try {
                URL.revokeObjectURL(url);
            } catch (e) {
                /* the address was already gone */
            }
            artworkObjectUrls.delete(key);
        });

        artworkStore()
            .then(function (store) {
                if (!store) return null;
                return forgetOtherVersions(store, id, null);
            })
            .catch(function () {
                /* a copy that could not be dropped is fetched over next time */
            });
    }

    function CatalogClient(options) {
        var settings = options || {};
        this.baseUrl = settings.baseUrl || DEFAULT_BASE;
        this.fetchImpl = settings.fetch || null;
        // Signed URLs expire, so resolved media is cached only briefly.
        this.mediaCache = new Map();
        // Reads already on their way. Two parts of the page wanting the same
        // catalogue at the same moment share one journey rather than each
        // making the server work the whole thing out again.
        this.pending = new Map();
    }

    /**
     * Ask once, however many callers are asking.
     *
     * The entry is removed as soon as the answer arrives, so this shares a
     * journey rather than remembering one: the next caller starts a fresh
     * request and gets fresh rows.
     */
    CatalogClient.prototype._shared = function (key, start) {
        var self = this;

        var running = this.pending.get(key);
        if (running) return running;

        var journey = start().finally(function () {
            self.pending.delete(key);
        });

        this.pending.set(key, journey);
        return journey;
    };

    /**
     * Requests carry the Supabase session when there is one.
     * Reading the published catalogue does not need an account, so a missing
     * or broken session is not an error here - the request simply goes out
     * unauthenticated and the server answers with the public content.
     */
    /**
     * Where a request actually goes.
     *
     * The music on a machine is answered by the helper on that machine, and
     * with a server running that is this origin, so the address is left alone.
     * A published copy is served from somewhere that has nothing to do with
     * anybody's computer: asking it about /api/library is how a static host
     * came to be asked whether somebody's music folders had changed. Those
     * requests are addressed to the helper instead, at the one address a
     * helper is ever at, and never at the address this page came from.
     */
    CatalogClient.prototype._addressed = function (url) {
        if (typeof url !== 'string' || url.indexOf('/api/library') !== 0) return url;

        var deployment = global.spotifieDeployment;
        if (!deployment || !deployment.isPublished()) return url;

        var origin = deployment.localHelperOrigin();
        return origin ? origin + url : url;
    };

    CatalogClient.prototype._fetch = function (url, init) {
        url = this._addressed(url);
        if (this.fetchImpl) return this.fetchImpl(url, init);

        if (global.spotifieAuth && global.spotifieAuth.authorizedFetch) {
            try {
                return global.spotifieAuth.authorizedFetch(url, init).catch(function () {
                    return fetch(url, Object.assign({ credentials: 'same-origin' }, init));
                });
            } catch (e) {
                return fetch(url, Object.assign({ credentials: 'same-origin' }, init));
            }
        }

        return fetch(url, Object.assign({ credentials: 'same-origin' }, init));
    };

    CatalogClient.prototype._request = function (url, init) {
        return this._fetch(url, init).then(function (response) {
            if (response.ok) return response.json();

            // Carry the server's explanation through, so the interface can say
            // what went wrong instead of quoting a status code.
            return response
                .json()
                .catch(function () {
                    return null;
                })
                .then(function (body) {
                    var message =
                        (body && (body.error || body.detail)) ||
                        'Catalogue request failed with status ' + response.status;
                    if (body && body.error && body.detail && body.detail !== body.error) {
                        message += ' (' + body.detail + ')';
                    }

                    var error = new Error(message);
                    error.status = response.status;
                    error.detail = body ? body.detail : null;
                    throw error;
                });
        });
    };

    CatalogClient.prototype._query = function (params) {
        var pairs = [];
        Object.keys(params || {}).forEach(function (key) {
            var value = params[key];
            if (value === undefined || value === null || value === '') return;
            pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        });
        return pairs.length ? '?' + pairs.join('&') : '';
    };

    /** Per-source availability, hidden items and counts. */
    CatalogClient.prototype.getStatus = function () {
        return this._request(this.baseUrl + '/status');
    };

    /**
     * The published catalogue, from whichever half of Spotifie is running.
     *
     * A Spotifie server assembles it and hands it over, which is the path
     * whenever there is one. A published copy has no server, so the same two
     * tables are read straight from Supabase - the rows are public and the
     * browser holds the key that may read them and change nothing.
     *
     * Both answer the same shape, so nothing above here learns which it was.
     */
    CatalogClient.prototype._catalogue = function (kind, options) {
        var url = this.baseUrl + '/' + kind + this._query(options);
        var self = this;

        return this._shared(url, function () {
            // A published copy has no server on this origin, and knows it. It
            // reads the two published tables itself rather than asking a static
            // host for an API and collecting a 404 on every load.
            if (self._published()) return self._fromCloud(kind);

            return self._request(url).catch(function (error) {
                // A copy served as files without having been built. The same
                // path, reached the other way. Anything but a missing route -
                // refused, broken, unreachable - is passed on, because
                // pretending otherwise would hide it.
                if (error.status !== 404) throw error;
                return self._fromCloud(kind);
            });
        });
    };

    /** Is this a copy published to a host that serves files and nothing else? */
    CatalogClient.prototype._published = function () {
        var deployment = typeof window !== 'undefined' ? window.spotifieDeployment : null;
        return Boolean(deployment && deployment.isPublished());
    };

    /**
     * The music this browser itself can read, or nothing.
     *
     * A copy with no server still has a device under it, and a browser that
     * can be handed one folder of it. Whatever was handed over before is here
     * without anybody being asked again: it was written down when it was
     * chosen, and reading that back needs no permission.
     */
    CatalogClient.prototype._browserLibrary = function () {
        var library = typeof window !== 'undefined' ? window.spotifieBrowserLibrary : null;
        if (!library || !library.supported()) return Promise.resolve(null);

        return library
            .load()
            .then(function () {
                return library;
            })
            .catch(function () {
                return null;
            });
    };

    /** Everything published, read from Supabase and shaped as a server would. */
    CatalogClient.prototype._fromCloud = function (kind) {
        var self = this;

        return this._cloudCatalogue().then(function (catalogue) {
            if (!catalogue) {
                var missing = new Error('The published catalogue is not reachable from here.');
                missing.status = 503;
                throw missing;
            }

            return Promise.all([catalogue.read(), self._browserLibrary()]).then(function (answers) {
                var answer = answers[0];
                var library = answers[1];
                self._cloud = catalogue;

                // The two halves, joined here exactly as a server joins them:
                // what an administrator published, and what is on the machine
                // this is being read on.
                var here = library ? library.catalogue() : { albums: [], tracks: [] };
                var items = kind === 'albums' ? here.albums.concat(answer.albums) : here.tracks.concat(answer.tracks);

                return {
                    total: items.length,
                    items: items,
                    sources: {
                        local: {
                            available: Boolean(library),
                            trackCount: here.tracks.length,
                            error: null
                        },
                        global: { available: true, trackCount: answer.tracks.length, error: null }
                    }
                };
            });
        });
    };

    /**
     * The reader for a copy with no server, made once.
     *
     * Needs a signed-in-or-not Supabase client, which the page already has for
     * authentication - so there is one key, one session and one place that
     * knows anything about Supabase.
     */
    CatalogClient.prototype._cloudCatalogue = function () {
        var self = this;
        if (this._cloudPromise) return this._cloudPromise;

        var auth = typeof window !== 'undefined' ? window.spotifieAuth : null;
        var Catalogue = typeof window !== 'undefined' ? window.SpotifieCloudCatalog : null;

        if (!auth || !Catalogue) return Promise.resolve(null);

        this._cloudPromise = auth
            .tryGetClient()
            .then(function (supabase) {
                // No client yet is not "no client ever": this is asked while
                // the page is still starting, and remembering a no would leave
                // the catalogue, the covers and the audio unreachable for the
                // rest of the visit.
                if (!supabase) {
                    self._cloudPromise = null;
                    return null;
                }

                self._cloud = new Catalogue({ client: supabase });
                return self._cloud;
            })
            .catch(function () {
                self._cloudPromise = null;
                return null;
            });

        return this._cloudPromise;
    };

    /** The reader in use, when there is one. Used to resolve media addresses. */
    CatalogClient.prototype.cloudCatalogue = function () {
        return this._cloud || null;
    };

    CatalogClient.prototype.getTracks = function (options) {
        return this._catalogue('tracks', options);
    };

    CatalogClient.prototype.getAlbums = function (options) {
        return this._catalogue('albums', options);
    };

    /**
     * The half of the catalogue this machine answers by itself: the music on
     * the device, and this listener's own state. Supabase is not consulted, so
     * it arrives at the speed of a local read.
     */
    CatalogClient.prototype.getLocalCatalog = function () {
        var url = this.baseUrl + '/local';
        var self = this;

        // The music on a device is answered by whatever can read that device.
        // A published copy has no server on its own origin to ask, so it asks
        // the browser: whatever folder somebody handed over is written down
        // here, and reading that back needs nobody's permission and no
        // network. A browser that was never handed one answers with an empty
        // library rather than with a failure, and the card stays where it is.
        if (this._published()) {
            return this._browserLibrary().then(function (library) {
                var here = library ? library.catalogue() : { albums: [], tracks: [] };

                return {
                    total: here.albums.length,
                    albums: here.albums,
                    tracks: here.tracks,
                    sources: {
                        local: { available: Boolean(library), trackCount: here.tracks.length, error: null },
                        global: { available: null, skipped: true, trackCount: 0, error: null }
                    },
                    overrides: {},
                    addedToGlobalAlbums: {},
                    hidden: { globalTracks: [], globalAlbums: [], localTracks: [] }
                };
            });
        }

        return this._shared(url, function () {
            return self._request(url);
        });
    };

    CatalogClient.prototype.getArtists = function () {
        return this._request(this.baseUrl + '/artists');
    };

    CatalogClient.prototype.getTrack = function (trackId) {
        return this._request(this.baseUrl + '/tracks/' + encodeURIComponent(trackId));
    };

    /**
     * A URL the <audio> element can play.
     * Local tracks stream from this server; global tracks resolve to a
     * short-lived signed URL.
     */
    CatalogClient.prototype.resolveStreamUrl = function (trackId, options) {
        var self = this;
        var settings = options || {};

        if (settings.refresh) {
            this.mediaCache.delete('stream:' + trackId);
        }

        var cached = this.mediaCache.get('stream:' + trackId);
        if (cached && cached.expiresAt > Date.now()) {
            return Promise.resolve(cached.url);
        }

        if (this._published()) {
            return this._cloudCatalogue()
                .then(function (reader) {
                    if (!reader) return null;
                    return reader.resolveAudio(trackId);
                })
                .then(function (signed) {
                    if (!signed) return null;

                    self.mediaCache.set('stream:' + trackId, {
                        url: signed,
                        expiresAt: Date.now() + (3600 - 60) * 1000
                    });
                    return signed;
                })
                .catch(function () {
                    return null;
                });
        }

        return this._request(this.baseUrl + '/tracks/' + encodeURIComponent(trackId) + '/stream')
            .catch(function (error) {
                // No server to ask. A published copy signs the address itself,
                // for a published song; a song on somebody's device is not
                // reachable from here at all, and says so by answering nothing.
                if (error.status !== 404) throw error;

                var cloud = self.cloudCatalogue();
                if (!cloud) return null;

                return cloud.resolveAudio(trackId).then(function (signed) {
                    return signed ? { url: signed, expiresIn: 3600 } : null;
                });
            })
            .then(function (result) {
            if (!result || !result.url) return null;
            if (result.expiresIn) {
                // Refresh a minute before Supabase expires the signature.
                self.mediaCache.set('stream:' + trackId, {
                    url: result.url,
                    expiresAt: Date.now() + Math.max(0, result.expiresIn - 60) * 1000
                });
            }
            return result.url;
        });
    };

    /**
     * Where this origin serves the published picture for an album or a song.
     *
     * The address names the version of the artwork, which is what makes it
     * worth keeping: the same cover is always the same address, so a browser
     * that has it does not ask again, and a replaced cover is a different
     * address, so the old one is never shown in its place.
     *
     * Nothing signed appears here. The signature is made inside the server,
     * used once to read the file, and never reaches the page.
     */
    CatalogClient.prototype.artworkImageUrl = function (id, options) {
        if (!id) return null;

        // This address is served by a Spotifie server, and a published copy
        // has none: it would answer nothing, and the picture would fall back
        // to the default while a perfectly good one waited in storage.
        // Answering null here sends the caller to the signed address instead,
        // which is the one that works where there is no server.
        if (this._cloud || this._published()) return null;

        var settings = options || {};
        var kind = settings.kind === 'album' ? 'albums' : 'tracks';
        var url = this.baseUrl + '/' + kind + '/' + encodeURIComponent(id) + '/artwork/image';

        return settings.version ? url + '?v=' + encodeURIComponent(settings.version) : url;
    };

    /**
     * Artwork URL for a track or album; resolves to the default cover when
     * there is no artwork, so a missing image never breaks an album.
     */
    CatalogClient.prototype.resolveArtworkUrl = function (id, options) {
        var self = this;
        var settings = options || {};
        var kind = settings.kind === 'album' ? 'albums' : 'tracks';
        var fallback = settings.fallback || DEFAULT_ARTWORK;

        // The one place a resolved artwork address is held, and only until it
        // expires. Nothing else in the application keeps one.
        //
        // Held under which picture it is as well as which item, so a cover an
        // administrator has replaced is a different question rather than the
        // old answer given again for the next hour.
        var held = 'artwork:' + id + ':' + (settings.version || 'current');

        var cached = this.mediaCache.get(held);
        if (cached && cached.expiresAt > Date.now()) {
            return Promise.resolve(cached.url);
        }
        this.mediaCache.delete(held);

        // The same distinction as the catalogue: a published copy signs its own
        // address rather than asking an origin that has no route to answer.
        //
        // The reader is waited for rather than required to be ready. A card is
        // often painted while the catalogue is still arriving, and giving up
        // then would show the fallback cover for a picture that was moments
        // away - which is exactly what happened when this asked for a reader
        // that had not been made yet.
        if (this._published()) {
            // Which picture this is, as far as the catalogue on this device
            // knows. The name it is kept under is made of that, so a cover
            // this browser already has is painted without signing anything.
            var key = artworkKeyFor(id, settings.version);

            return keptArtwork(key, id)
                .then(function (kept) {
                    if (kept) return kept;

                    return self
                        ._cloudCatalogue()
                        .then(function (cloud) {
                            if (!cloud) return null;

                            // What the catalogue on this device already said
                            // about where the picture is, handed over before
                            // anything is asked of Supabase.
                            var path = self._artworkPaths ? self._artworkPaths.get(id) : null;
                            if (path && typeof cloud.learn === 'function') {
                                cloud.learn([{ id: id, metadata: { artworkPath: path } }]);
                            }

                            return cloud.resolveArtwork(id);
                        })
                        .then(function (signed) {
                            if (!signed) return null;

                            self.mediaCache.set(held, {
                                url: signed,
                                expiresAt: Date.now() + (3600 - 60) * 1000
                            });

                            // Kept for next time, behind the picture going up
                            // now. A failure here changes nothing on screen.
                            keepArtwork(key, id, signed);
                            return signed;
                        });
                })
                .then(function (url) {
                    return url || fallback;
                })
                .catch(function () {
                    return fallback;
                });
        }

        return this._request(this.baseUrl + '/' + kind + '/' + encodeURIComponent(id) + '/artwork')
            .catch(function (error) {
                // No server to ask. A published copy signs an address for the
                // picture itself, from the same storage the server would have
                // signed one from - and gets the fallback if there is nothing
                // there, exactly as it would have.
                if (error.status !== 404) throw error;

                var cloud = self.cloudCatalogue();
                if (!cloud) return null;

                return cloud.resolveArtwork(id).then(function (signed) {
                    // Answered in the shape the server answers, so what follows
                    // does not care which of the two signed it.
                    return signed ? { url: signed, expiresIn: 3600 } : null;
                });
            })
            .then(function (result) {
                var url = result && result.url;
                if (!url) return fallback;

                // Only a real address is remembered, and only for as long as
                // it is good for - a minute short of its life, so one is never
                // handed out at the moment it stops working.
                if (result.expiresIn) {
                    self.mediaCache.set(held, {
                        url: url,
                        expiresAt: Date.now() + Math.max(0, result.expiresIn - 60) * 1000
                    });
                }
                return url;
            })
            .catch(function () {
                self.mediaCache.delete(held);
                return fallback;
            });
    };

    /**
     * Remove an item from THIS user's view.
     *
     * For global content this hides it for the signed-in user only: the shared
     * copy stays exactly as the administrator published it, and other users
     * still see it. Permanently deleting global content is a separate,
     * administrator-only action.
     */
    CatalogClient.prototype.hide = function (id) {
        return this._request(this.baseUrl + '/hidden', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
    };

    /** Bring back something this user had hidden. */
    CatalogClient.prototype.restore = function (id) {
        return this._request(this.baseUrl + '/hidden/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
    };

    /** Forget any cached media URL for a track, forcing a fresh resolve. */
    CatalogClient.prototype.forgetMedia = function (id) {
        this.mediaCache.delete('stream:' + id);
        this._forgetHeldArtwork(id);
    };

    /**
     * Drop every address held for one item's picture.
     *
     * One item can have an address held for more than one version of its cover
     * - the one on screen, and the one a redraw asked for a moment later - and
     * forgetting is always about the item rather than about a version of it.
     */
    CatalogClient.prototype._forgetHeldArtwork = function (id) {
        var prefix = 'artwork:' + id + ':';
        var self = this;

        Array.from(this.mediaCache.keys()).forEach(function (key) {
            if (key === 'artwork:' + id || key.indexOf(prefix) === 0) self.mediaCache.delete(key);
        });
    };

    /**
     * Forget one remembered artwork address.
     *
     * An address that did not load is not one to hand out again: the page
     * calls this the moment a picture fails, so the next attempt asks for a
     * fresh one rather than reusing the address that just failed.
     */
    CatalogClient.prototype.forgetArtwork = function (id) {
        this._forgetHeldArtwork(id);

        // The address a copy with no server signed for itself, too. Without
        // this, an expired address is handed back for as long as the reader
        // thinks it is still good, and the retry that exists to recover from
        // exactly that fails the same way.
        if (this._cloud && typeof this._cloud.forgetSigned === 'function') this._cloud.forgetSigned(id);

        // And the copy this page unpacked, in case that was what failed.
        releaseKeptArtwork(id);
    };

    /**
     * Take note of where the published pictures are kept.
     *
     * Called with whatever catalogue has just been drawn, wherever it came
     * from. With a server it does nothing: the server signs its own addresses
     * and the page never learns a path. Published, it is what lets the first
     * paint after a refresh sign an address for a cover straight away instead
     * of showing the default one until the catalogue has been read again.
     */
    /**
     * Is this address one this client made, for a picture it fetched itself?
     *
     * A cover arrives as metadata almost everywhere - out of a file's tags,
     * out of a catalogue row, out of something a person typed - and the page
     * refuses an address into this browser's own memory from any of those,
     * because nothing it was handed should be able to name one. A picture this
     * client fetched and kept is the exception, and this is how the page tells
     * the two apart rather than trusting the shape of the string.
     */
    CatalogClient.prototype.ownsObjectUrl = function (url) {
        if (typeof url !== 'string' || url.indexOf('blob:') !== 0) return false;

        var mine = false;
        artworkObjectUrls.forEach(function (held) {
            if (held === url) mine = true;
        });
        return mine;
    };

    CatalogClient.prototype.rememberArtworkPaths = function (items) {
        if (!this._published() || !items || !items.length) return;

        // Written down here and now, rather than only handed to a reader that
        // may not exist yet. The library is painted in the same turn this is
        // called in, and a card that asked for its cover before the reader had
        // been made would fall back to asking Supabase where the picture was -
        // one question, made by every card at once, and a library of default
        // covers if it did not answer.
        if (!this._artworkPaths) this._artworkPaths = new Map();
        var known = this._artworkPaths;

        (items || []).forEach(function (item) {
            if (!item || !item.id) return;

            var path = item.metadata ? item.metadata.artworkPath : null;
            if (path) known.set(item.id, path);
        });

        this._cloudCatalogue().then(function (cloud) {
            if (cloud && typeof cloud.learn === 'function') cloud.learn(items);
        });
    };

    /**
     * Save this account's own version of a published album.
     * Personal presentation only: the shared catalogue is never written to
     * from here.
     */
    /**
     * Put one of this person's own local tracks into a published album.
     *
     * Personal: the track keeps its own file on this device and the published
     * album is not changed for anybody else.
     */
    CatalogClient.prototype.addTrackToAlbum = function (albumId, trackId) {
        return this._request(this.baseUrl + '/albums/' + encodeURIComponent(albumId) + '/tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trackId })
        });
    };

    /** Take one of their tracks back out of a published album. The file stays. */
    CatalogClient.prototype.removeTrackFromAlbum = function (albumId, trackId) {
        return this._request(
            this.baseUrl + '/albums/' + encodeURIComponent(albumId) + '/tracks/' + encodeURIComponent(trackId),
            { method: 'DELETE' }
        );
    };

    /**
     * Send one audio file from this device to the local server, which keeps it
     * on this machine for this account and indexes it like any other local
     * music. The file is sent as itself - never Base64, never through storage
     * in the browser - and nothing about it reaches Supabase.
     */
    CatalogClient.prototype.importDeviceTrack = function (file) {
        var url = '/api/library/imports?name=' + encodeURIComponent(file.name || 'track');
        return this._request(url, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file
        });
    };

    /**
     * Ask this device to be searched for music.
     *
     * The search runs on the local server, over the music locations this
     * installation is allowed to look in; the page only says yes and then
     * watches the counts. Nothing found is uploaded anywhere.
     */
    CatalogClient.prototype.startDeviceScan = function (options) {
        var settings = options || {};
        // A full pass reads every file again; without one the server reuses
        // what it already knows and looks only at what changed.
        var query = settings.mode === 'full' ? '?mode=full' : '';
        return this._request('/api/library/scan' + query, { method: 'POST' });
    };

    /** How the search is going. 'playing' tells it to give way to playback. */
    CatalogClient.prototype.getDeviceScanStatus = function (options) {
        var settings = options || {};
        var query = settings.playing === undefined ? '' : '?playing=' + (settings.playing ? 'true' : 'false');
        return this._request('/api/library/scan' + query);
    };

    CatalogClient.prototype.cancelDeviceScan = function () {
        return this._request('/api/library/scan', { method: 'DELETE' });
    };

    CatalogClient.prototype.setAlbumOverride = function (albumId, override) {
        return this._request(this.baseUrl + '/overrides/' + encodeURIComponent(albumId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(override || {})
        });
    };

    /** Drop this account's edits and show the album as published. */
    CatalogClient.prototype.clearAlbumOverride = function (albumId) {
        return this._request(this.baseUrl + '/overrides/' + encodeURIComponent(albumId), { method: 'DELETE' });
    };

    CatalogClient.prototype.getAlbumOverrides = function () {
        return this._request(this.baseUrl + '/overrides');
    };

    CatalogClient.prototype.getHidden = function () {
        return this._request(this.baseUrl + '/hidden');
    };

    // ---- where this listener stopped, per track ----
    // Kept on this machine: this account's own state file when signed in, the
    // device's own file when not. Never Supabase.

    // Where a published copy keeps it, since there is no state file to keep it
    // in. This browser, this device, and nowhere else: a position in a song is
    // as personal as the listening was, and it is not something to send to a
    // host that has no business knowing what anybody played.
    var PROGRESS_KEY = 'spotifie_progress';

    /** What this browser remembers, or nothing. */
    CatalogClient.prototype._localProgress = function () {
        try {
            var raw = window.localStorage.getItem(PROGRESS_KEY);
            var stored = raw ? JSON.parse(raw) : null;
            return stored && typeof stored === 'object' ? stored : {};
        } catch (e) {
            // A browser that keeps nothing, or something unreadable in the way.
            // Either is a listener who starts each song at the beginning, which
            // is a small loss and not a failure.
            return {};
        }
    };

    CatalogClient.prototype._rememberLocally = function (trackId, position, duration) {
        try {
            var all = this._localProgress();

            if (!trackId) return false;
            all[trackId] = { position: position, duration: duration, at: Date.now() };

            window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
            return true;
        } catch (e) {
            return false;
        }
    };

    CatalogClient.prototype.getPlaybackProgress = function () {
        if (this._published()) return Promise.resolve({ trackProgress: this._localProgress() });
        return this._request(this.baseUrl + '/progress');
    };

    CatalogClient.prototype.savePlaybackProgress = function (trackId, position, duration) {
        if (this._published()) {
            return Promise.resolve({ saved: this._rememberLocally(trackId, position, duration) });
        }

        return this._request(this.baseUrl + '/progress', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trackId, position: position, duration: duration })
        });
    };

    /**
     * Save a position on the way out of the page.
     *
     * A normal request is abandoned when the tab closes, so this one is marked
     * to outlive it. It carries the session the same way every other request
     * does, so a signed-in listener's position lands in their own state file
     * and a guest's lands in this device's.
     */
    CatalogClient.prototype.savePlaybackProgressOnExit = function (trackId, position, duration) {
        // Writing to this browser is immediate, so there is nothing that has to
        // outlive the page.
        if (this._published()) return this._rememberLocally(trackId, position, duration);

        try {
            this._request(this.baseUrl + '/progress', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: trackId, position: position, duration: duration }),
                keepalive: true
            }).catch(function () {
                /* the page is going away; there is nothing to report to */
            });
            return true;
        } catch (e) {
            return false;
        }
    };

    // ---- administrator actions (rejected for everyone else) ----

    CatalogClient.prototype.createGlobalAlbum = function (album) {
        return this._request(this.baseUrl + '/admin/albums', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(album)
        });
    };

    CatalogClient.prototype.createGlobalTrack = function (track) {
        return this._request(this.baseUrl + '/admin/tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(track)
        });
    };

    CatalogClient.prototype.updateGlobalTrack = function (trackId, patch) {
        return this._request(this.baseUrl + '/admin/tracks/' + encodeURIComponent(trackId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
    };

    CatalogClient.prototype.updateGlobalAlbum = function (albumId, patch) {
        return this._request(this.baseUrl + '/albums/' + encodeURIComponent(albumId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
    };

    /** Permanent, for everyone. Administrators only. */
    CatalogClient.prototype.deleteGlobalTrack = function (trackId) {
        return this._request(this.baseUrl + '/tracks/' + encodeURIComponent(trackId), { method: 'DELETE' });
    };

    CatalogClient.prototype.deleteGlobalAlbum = function (albumId) {
        return this._request(this.baseUrl + '/albums/' + encodeURIComponent(albumId), { method: 'DELETE' });
    };

    global.CatalogClient = CatalogClient;
    global.spotifieCatalog = new CatalogClient();

    if (typeof module === 'object' && module.exports) {
        module.exports = { CatalogClient: CatalogClient };
    }
})(typeof window !== 'undefined' ? window : globalThis);
