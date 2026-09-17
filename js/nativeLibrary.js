/**
 * Local Music inside a native app shell - the Android app and the iOS app.
 *
 * Both shells reach the music on the device the same way from the page's
 * point of view: the person chooses a folder (or, on iOS, some files) in the
 * system's own picker, the shell keeps a lasting, read-only grant for exactly
 * that, and the page walks it through a small native plugin named
 * "MusicFolders". How the grant is kept is the shell's business - a
 * persistable Storage Access Framework grant on Android, a security-scoped
 * bookmark on iOS - and never the page's.
 *
 * This is the one library both shells use. It offers the same interface as the
 * browser's folder library (js/browserLibrary.js), so the Local Music card,
 * Manage Local Music, playback, likes and playlists work unchanged on top of it:
 *
 * - an index kept in IndexedDB, so the library is drawn at once on the next
 *   launch without walking a single folder;
 * - stable ids: the folder, the place in it and the size - a name, not a
 *   fingerprint of the audio;
 * - tags read only for a song that is new or has changed;
 * - a folder the system no longer lets the app read keeps its songs listed and
 *   is marked as needing to be chosen again;
 * - forgetting a folder releases the grant and drops its songs. No file is ever
 *   copied, encoded, uploaded, moved or deleted.
 */
(function (global) {
    'use strict';

    /** What counts as music: the same list every other adapter uses. */
    var AUDIO = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus'];

    var LOCAL_MUSIC_ALBUM_ID = 'system:local-music';

    var DB_VERSION = 1;
    var FOLDERS = 'folders';
    var TRACKS = 'tracks';

    var PADDING = String.fromCharCode(0);

    function extensionOf(name) {
        var dot = String(name || '').lastIndexOf('.');
        return dot === -1 ? '' : String(name).slice(dot + 1).toLowerCase();
    }

    /** "Artist - Title.mp3" says both; anything else is a title. */
    function fromFileName(name) {
        var base = String(name || '').replace(/\.[^.]+$/, '').trim();
        var parts = base.split(' - ');
        if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join(' - ').trim()) {
            return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
        }
        return { artist: null, title: base || 'Untitled' };
    }

    /**
     * A song's name, stable between launches: the folder it is in, where it is
     * inside that folder, and its size. A name, not a fingerprint of the audio.
     */
    function trackIdFor(folderId, path, size) {
        var bytes = new TextEncoder().encode(folderId + PADDING + path + PADDING + size);
        return global.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
            var out = '';
            new Uint8Array(digest).forEach(function (byte) {
                out += byte.toString(16).padStart(2, '0');
            });
            return 'local:' + out;
        });
    }

    function abort(message, cause) {
        var error = new Error(message);
        error.name = 'AbortError';
        if (cause) error.cause = cause;
        return error;
    }

    /**
     * One shell's library.
     *
     * options.dbName   - where its index is kept (one per shell)
     * options.plugin   - () => the shell's MusicFolders plugin, or null
     * options.fileUrl  - (uri) => an address the page's player can load, or null
     * options.formats  - () => the file extensions this shell can play
     */
    function create(options) {
        var settings = options || {};
        var dbName = settings.dbName;
        var formats =
            typeof settings.formats === 'function'
                ? settings.formats
                : function () {
                      return AUDIO;
                  };

        function folderPlugin() {
            return settings.plugin ? settings.plugin() : null;
        }

        function isAudioName(name) {
            return formats().indexOf(extensionOf(name)) !== -1;
        }

        // ============================================
        // What is written down
        // ============================================

        function openDatabase() {
            return new Promise(function (resolve, reject) {
                var request = global.indexedDB.open(dbName, DB_VERSION);

                request.onupgradeneeded = function () {
                    var db = request.result;
                    if (!db.objectStoreNames.contains(FOLDERS)) db.createObjectStore(FOLDERS, { keyPath: 'id' });
                    if (!db.objectStoreNames.contains(TRACKS)) {
                        db.createObjectStore(TRACKS, { keyPath: 'id' }).createIndex('folderId', 'folderId', { unique: false });
                    }
                };
                request.onsuccess = function () {
                    resolve(request.result);
                };
                request.onerror = function () {
                    reject(request.error);
                };
            });
        }

        function readAll(store) {
            return openDatabase().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var request = db.transaction(store, 'readonly').objectStore(store).getAll();
                    request.onsuccess = function () {
                        resolve(request.result || []);
                    };
                    request.onerror = function () {
                        reject(request.error);
                    };
                    request.transaction.oncomplete = function () {
                        db.close();
                    };
                });
            });
        }

        /** Replace what is written down for one folder, in one go. */
        function writeFolder(folder, rows) {
            return openDatabase().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var transaction = db.transaction([FOLDERS, TRACKS], 'readwrite');
                    var tracks = transaction.objectStore(TRACKS);

                    transaction.objectStore(FOLDERS).put(folder);

                    var old = tracks.index('folderId').getAllKeys(folder.id);
                    old.onsuccess = function () {
                        (old.result || []).forEach(function (key) {
                            tracks.delete(key);
                        });
                        rows.forEach(function (row) {
                            tracks.put(row);
                        });
                    };

                    transaction.oncomplete = function () {
                        db.close();
                        resolve();
                    };
                    transaction.onerror = function () {
                        reject(transaction.error);
                    };
                });
            });
        }

        function removeFolder(folderId) {
            return openDatabase().then(function (db) {
                return new Promise(function (resolve, reject) {
                    var transaction = db.transaction([FOLDERS, TRACKS], 'readwrite');
                    var tracks = transaction.objectStore(TRACKS);

                    transaction.objectStore(FOLDERS).delete(folderId);
                    var old = tracks.index('folderId').getAllKeys(folderId);
                    old.onsuccess = function () {
                        (old.result || []).forEach(function (key) {
                            tracks.delete(key);
                        });
                    };

                    transaction.oncomplete = function () {
                        db.close();
                        resolve();
                    };
                    transaction.onerror = function () {
                        reject(transaction.error);
                    };
                });
            });
        }

        // ============================================
        // The library, in the shape the rest of Spotifie reads
        // ============================================

        var state = { loaded: false, folders: [], tracks: [], scanning: false };

        function supported() {
            return Boolean(folderPlugin() && global.indexedDB && global.crypto && global.crypto.subtle);
        }

        /**
         * Which folders the system still lets the app read. A grant can be
         * taken back at any time; a folder without one keeps its songs listed
         * and is marked as needing to be chosen again.
         */
        function grantedUris() {
            var folders = folderPlugin();
            if (!folders) return Promise.resolve(new Set());

            return Promise.resolve(folders.listFolders())
                .then(function (answer) {
                    return new Set(
                        ((answer && answer.folders) || []).map(function (entry) {
                            return entry.uri;
                        })
                    );
                })
                .catch(function () {
                    return new Set();
                });
        }

        function load() {
            if (state.loaded) return Promise.resolve(state);
            if (!supported()) {
                state.loaded = true;
                return Promise.resolve(state);
            }

            return Promise.all([readAll(FOLDERS), readAll(TRACKS), grantedUris()])
                .then(function (answers) {
                    var granted = answers[2];
                    state.folders = answers[0].map(function (folder) {
                        folder.needsPermission = !granted.has(folder.id);
                        return folder;
                    });
                    state.tracks = answers[1];
                    state.loaded = true;
                    return state;
                })
                .catch(function () {
                    state.loaded = true;
                    return state;
                });
        }

        function countIn(folderId) {
            return state.tracks.filter(function (row) {
                return row.folderId === folderId;
            }).length;
        }

        function asTrack(row) {
            var guessed = fromFileName(row.name);
            var folder = state.folders.filter(function (known) {
                return known.id === row.folderId;
            })[0];

            return {
                id: row.id,
                source: 'local',
                device: true,
                title: row.title || guessed.title,
                artist: row.artist || 'Unknown Artist',
                albumArtist: row.albumArtist || row.artist || 'Unknown Artist',
                album: 'Local Music',
                albumId: LOCAL_MUSIC_ALBUM_ID,
                duration: typeof row.duration === 'number' ? row.duration : null,
                artworkUrl: null,
                streamUrl: null,
                metadata: {
                    trackNumber: null,
                    discNumber: null,
                    year: null,
                    genre: null,
                    format: row.format || null,
                    bitrate: null,
                    hasArtwork: false,
                    fileName: row.name,
                    size: row.size,
                    addedAt: row.addedAt || null,
                    folderId: row.folderId,
                    folderName: folder ? folder.name : null
                }
            };
        }

        function catalogue() {
            var tracks = state.tracks.map(asTrack);
            if (!state.folders.length && !tracks.length) return { albums: [], tracks: [] };

            return {
                albums: [
                    {
                        id: LOCAL_MUSIC_ALBUM_ID,
                        source: 'local',
                        system: true,
                        title: 'Local Music',
                        artist: 'On this device',
                        albumArtist: 'On this device',
                        description: null,
                        artworkUrl: null,
                        trackCount: tracks.length,
                        duration: 0,
                        metadata: { year: null }
                    }
                ],
                tracks: tracks
            };
        }

        function folders() {
            return state.folders.map(function (folder) {
                return {
                    id: folder.id,
                    name: folder.name,
                    addedAt: folder.addedAt,
                    lastScanAt: folder.lastScanAt || null,
                    needsPermission: Boolean(folder.needsPermission),
                    trackCount: countIn(folder.id)
                };
            });
        }

        /**
         * What is in one folder now, compared with what was there before.
         *
         * A song at the same place with the same size and modified time is the
         * same song: kept exactly as it was, not read again, and its id does
         * not move. Only new or changed files have their tags read.
         */
        function scanFolder(folder) {
            var plugin = folderPlugin();
            state.scanning = true;

            var existing = state.tracks.filter(function (row) {
                return row.folderId === folder.id;
            });
            var previous = new Map();
            existing.forEach(function (row) {
                previous.set(row.path, row);
            });
            var knownIds = new Set(
                existing.map(function (row) {
                    return row.id;
                })
            );

            return Promise.resolve(plugin.scanFolder({ uri: folder.id }))
                .then(function (answer) {
                    var files = ((answer && answer.files) || []).filter(function (file) {
                        return file && isAudioName(file.name);
                    });

                    return files.reduce(function (chain, file) {
                        return chain.then(function (rows) {
                            var known = previous.get(file.path);
                            if (known && known.size === file.size && known.lastModified === file.lastModified && known.id) {
                                // The address can change between grants; keep
                                // the current one.
                                known.uri = file.uri;
                                rows.push(known);
                                return rows;
                            }

                            return Promise.all([
                                trackIdFor(folder.id, file.path, file.size),
                                Promise.resolve(plugin.readTags({ uri: file.uri })).catch(function () {
                                    return {};
                                })
                            ]).then(function (answers) {
                                var tags = answers[1] || {};
                                var guessed = fromFileName(file.name);

                                rows.push({
                                    id: answers[0],
                                    folderId: folder.id,
                                    path: file.path,
                                    uri: file.uri,
                                    name: file.name,
                                    size: file.size,
                                    lastModified: file.lastModified,
                                    format: extensionOf(file.name),
                                    title: tags.title || guessed.title,
                                    artist: tags.artist || guessed.artist || null,
                                    album: tags.album || null,
                                    albumArtist: tags.albumArtist || tags.artist || guessed.artist || null,
                                    duration: typeof tags.duration === 'number' ? tags.duration : null,
                                    addedAt: known ? known.addedAt : Date.now()
                                });
                                return rows;
                            });
                        });
                    }, Promise.resolve([]));
                })
                .then(function (rows) {
                    folder.lastScanAt = Date.now();
                    folder.needsPermission = false;

                    var record = {
                        id: folder.id,
                        name: folder.name,
                        addedAt: folder.addedAt,
                        lastScanAt: folder.lastScanAt
                    };

                    return writeFolder(record, rows).then(function () {
                        state.folders = state.folders
                            .filter(function (other) {
                                return other.id !== folder.id;
                            })
                            .concat([folder]);
                        state.tracks = state.tracks
                            .filter(function (row) {
                                return row.folderId !== folder.id;
                            })
                            .concat(rows);

                        var added = rows.filter(function (row) {
                            return !knownIds.has(row.id);
                        }).length;

                        return {
                            folder: folder.name,
                            trackCount: rows.length,
                            added: added,
                            removed: Math.max(0, existing.length - (rows.length - added)),
                            total: state.tracks.length
                        };
                    });
                })
                .finally(function () {
                    state.scanning = false;
                });
        }

        /** Take what a picker handed back and index it. A cancel is a cancel, not an error. */
        function adoptPicked(pick, fallbackName) {
            return Promise.resolve(pick)
                .catch(function (error) {
                    throw abort('Nothing was chosen.', error);
                })
                .then(function (picked) {
                    if (!picked || !picked.uri) throw abort('Nothing was chosen.');

                    return load().then(function () {
                        var folder =
                            state.folders.filter(function (known) {
                                return known.id === picked.uri;
                            })[0] || { id: picked.uri, name: picked.name || fallbackName, addedAt: Date.now() };
                        folder.name = picked.name || folder.name;
                        return scanFolder(folder);
                    });
                });
        }

        /** The system folder picker, from a tap. */
        function chooseFolder() {
            var plugin = folderPlugin();
            if (!plugin) return Promise.reject(new Error('This app cannot open a folder yet.'));
            return adoptPicked(plugin.pickFolder(), 'Music');
        }

        /**
         * The system file picker, for several songs at once - where a folder
         * cannot be chosen, or its provider will not list what is inside it.
         * Only offered by a shell whose plugin can do it.
         */
        function chooseFiles() {
            var plugin = folderPlugin();
            if (!plugin || typeof plugin.pickFiles !== 'function') {
                return Promise.reject(new Error('This app cannot choose files.'));
            }
            return adoptPicked(plugin.pickFiles(), 'Chosen songs');
        }

        function canChooseFiles() {
            var plugin = folderPlugin();
            return Boolean(plugin && typeof plugin.pickFiles === 'function');
        }

        /** Look again at every folder the system still lets the app read. */
        function refresh() {
            if (!supported()) return Promise.resolve({ scanned: 0, needsPermission: 0, added: 0, removed: 0 });

            return load()
                .then(grantedUris)
                .then(function (granted) {
                    return state.folders.reduce(
                        function (chain, folder) {
                            return chain.then(function (summary) {
                                if (!granted.has(folder.id)) {
                                    folder.needsPermission = true;
                                    summary.needsPermission += 1;
                                    return summary;
                                }

                                return scanFolder(folder)
                                    .then(function (result) {
                                        summary.scanned += 1;
                                        summary.added += result.added || 0;
                                        summary.removed += result.removed || 0;
                                        return summary;
                                    })
                                    .catch(function () {
                                        return summary;
                                    });
                            });
                        },
                        Promise.resolve({ scanned: 0, needsPermission: 0, added: 0, removed: 0 })
                    );
                });
        }

        /**
         * A shell cannot re-ask for one folder without its picker, so
         * reconnecting is choosing it again - the same folder comes back as the
         * same folder.
         */
        function reconnect() {
            return chooseFolder()
                .then(function () {
                    return 1;
                })
                .catch(function () {
                    return 0;
                });
        }

        /** Forget one folder: the grant is released and its songs go; the files are untouched. */
        function forget(folderId) {
            var plugin = folderPlugin();
            var release = plugin
                ? Promise.resolve(plugin.releaseFolder({ uri: folderId })).catch(function () {})
                : Promise.resolve();

            return release
                .then(function () {
                    return removeFolder(folderId);
                })
                .then(function () {
                    state.folders = state.folders.filter(function (folder) {
                        return folder.id !== folderId;
                    });
                    state.tracks = state.tracks.filter(function (row) {
                        return row.folderId !== folderId;
                    });
                    return true;
                });
        }

        /**
         * An address the one player can use: the file itself, served by the
         * app's own local server on the page's origin. Nothing is copied.
         */
        function trackUrl(trackId) {
            return load().then(function () {
                var row = state.tracks.filter(function (known) {
                    return known.id === trackId;
                })[0];
                if (!row || !row.uri || typeof settings.fileUrl !== 'function') return null;
                return settings.fileUrl(row.uri) || null;
            });
        }

        return {
            supported: supported,
            load: load,
            catalogue: catalogue,
            folders: folders,
            trackCount: function () {
                return state.tracks.length;
            },
            chooseFolder: chooseFolder,
            chooseFiles: chooseFiles,
            canChooseFiles: canChooseFiles,
            refresh: refresh,
            reconnect: reconnect,
            forget: forget,
            trackUrl: trackUrl,
            formats: function () {
                return formats().slice();
            },
            releasePlaying: function () {
                /* nothing is held: the address is the file itself */
            },
            LOCAL_MUSIC_ALBUM_ID: LOCAL_MUSIC_ALBUM_ID
        };
    }

    global.spotifieNativeLibrary = {
        create: create,
        AUDIO: AUDIO,
        LOCAL_MUSIC_ALBUM_ID: LOCAL_MUSIC_ALBUM_ID,
        extensionOf: extensionOf
    };
})(typeof window !== 'undefined' ? window : globalThis);
