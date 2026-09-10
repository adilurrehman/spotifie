/**
 * The music on this device, read by the browser itself.
 *
 * Spotifie has always read a machine's music through a server running on that
 * machine: it walks the folders, reads the tags and answers questions about
 * what it found. That is still the best way when there is one, and nothing
 * here replaces it.
 *
 * A copy published to a static host has no such server, and most of the people
 * who open it never will. What their browser does have - Chrome and Edge
 * today - is a way to hand one folder to a page, with the person choosing it
 * themselves from a picker the browser draws. That is what this reads.
 *
 * What it is not: a way to look through somebody's device. A page cannot do
 * that and this does not pretend to. Nothing is read until somebody picks a
 * folder, nothing outside that folder is ever reachable, and the permission
 * belongs to the browser rather than to Spotifie - it can be taken back at any
 * time, from the browser's own interface, without asking anybody here.
 *
 * What it keeps, and what it deliberately does not:
 *
 * - the folder handle the browser gave, which is a reference rather than a
 *   copy, and which is worthless to anybody who has not been granted the
 *   permission that goes with it;
 * - a short row per song: its name inside the folder, its size, when it was
 *   last modified, and whatever the tags said it was called;
 * - never audio. A song is opened from the file when somebody plays it, given
 *   an address that lives in memory, and that address is dropped as soon as
 *   something else is playing. Nothing is copied into storage, nothing is
 *   turned into text, and nothing is sent anywhere - least of all to Supabase,
 *   which is for accounts and the published catalogue and has no business
 *   holding somebody's own music.
 */
(function (global) {
    'use strict';

    var DB_NAME = 'spotifie-device-library';
    var DB_VERSION = 1;
    var FOLDERS = 'folders';
    var TRACKS = 'tracks';

    /** The one collection everything found on this machine belongs to. */
    var LOCAL_MUSIC_ALBUM_ID = 'system:local-music';

    /** What counts as music. The same list the server walks a disk for. */
    var AUDIO = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus'];

    // The zero byte: what a tag pads its text with, and what separates the
    // parts of a name made from several pieces, since it cannot appear in any
    // of them.
    var PADDING = String.fromCharCode(0);

    /**
     * How deep to go, and what never to go into.
     *
     * A music folder is a handful of levels deep. A bound on it is what stops
     * a folder somebody picked by accident - a home directory, a drive - from
     * turning into a walk that never ends.
     */
    var MAX_DEPTH = 8;
    var MAX_FILES = 5000;
    var SKIP = ['node_modules', '$recycle.bin', 'system volume information', '.git', '.spotifie'];

    /** Is there a browser here that can be handed a folder? */
    function supported() {
        return Boolean(
            global.showDirectoryPicker &&
                global.isSecureContext &&
                global.indexedDB &&
                global.crypto &&
                global.crypto.subtle
        );
    }

    // ============================================
    // What is written down
    // ============================================

    function openDatabase() {
        return new Promise(function (resolve, reject) {
            var request = global.indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(FOLDERS)) db.createObjectStore(FOLDERS, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(TRACKS)) {
                    var tracks = db.createObjectStore(TRACKS, { keyPath: 'id' });
                    tracks.createIndex('folderId', 'folderId', { unique: false });
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
                var folders = transaction.objectStore(FOLDERS);
                var tracks = transaction.objectStore(TRACKS);

                // A handle is a reference the browser knows how to write down,
                // and most of them do. One that will not is not a failed scan:
                // the songs are still written, the folder is still listed, and
                // it is chosen again next time rather than remembered.
                try {
                    folders.put(folder);
                } catch (e) {
                    folders.put({ id: folder.id, name: folder.name, handle: null, addedAt: folder.addedAt });
                }

                // Everything this folder used to hold goes, and what it holds
                // now takes its place - so a song deleted from the disk is
                // gone from here too, rather than lingering as a row nothing
                // can open.
                var index = tracks.index('folderId');
                var cursor = index.openCursor(IDBKeyRange.only(folder.id));

                cursor.onsuccess = function () {
                    var at = cursor.result;
                    if (at) {
                        at.delete();
                        at.continue();
                        return;
                    }

                    rows.forEach(function (row) {
                        tracks.put(row);
                    });
                };

                transaction.oncomplete = function () {
                    db.close();
                    resolve(true);
                };
                transaction.onerror = function () {
                    db.close();
                    reject(transaction.error);
                };
            });
        });
    }

    function removeFolder(folderId) {
        return openDatabase().then(function (db) {
            return new Promise(function (resolve, reject) {
                var transaction = db.transaction([FOLDERS, TRACKS], 'readwrite');
                transaction.objectStore(FOLDERS).delete(folderId);

                var index = transaction.objectStore(TRACKS).index('folderId');
                var cursor = index.openCursor(IDBKeyRange.only(folderId));
                cursor.onsuccess = function () {
                    var at = cursor.result;
                    if (!at) return;
                    at.delete();
                    at.continue();
                };

                transaction.oncomplete = function () {
                    db.close();
                    resolve(true);
                };
                transaction.onerror = function () {
                    db.close();
                    reject(transaction.error);
                };
            });
        });
    }

    // ============================================
    // What a song is called
    // ============================================

    function extensionOf(name) {
        var at = name.lastIndexOf('.');
        return at === -1 ? '' : name.slice(at + 1).toLowerCase();
    }

    function isAudioName(name) {
        return AUDIO.indexOf(extensionOf(name)) !== -1;
    }

    /**
     * A title and an artist out of a file name.
     *
     * The fallback, and often the only answer: "01 - Artist - Title.mp3" is a
     * naming convention rather than metadata, but it is the one nearly every
     * collection follows, and reading it is better than showing somebody a
     * list of file names.
     */
    function fromFileName(name) {
        var base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
        var withoutNumber = base.replace(/^\s*\d{1,3}\s*[-.)]\s*/, '');

        var parts = withoutNumber.split(/\s+-\s+/);
        if (parts.length >= 2) {
            return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
        }

        return { artist: null, title: withoutNumber.trim() || name };
    }

    /**
     * What the tags say, when they say anything.
     *
     * Only the beginning of the file is read, and only the few text frames
     * that name a song: an ID3 tag sits at the front, and reading a megabyte
     * of every file to find out would make a folder of a thousand songs a
     * minutes-long wait for no more information.
     *
     * Anything unreadable is not an error. A song with no tags is a song named
     * after its file, which is exactly what the fallback is for.
     */
    function readTags(file) {
        return file
            .slice(0, 256 * 1024)
            .arrayBuffer()
            .then(function (buffer) {
                var bytes = new Uint8Array(buffer);
                if (bytes.length < 10) return null;
                if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

                var major = bytes[3];
                if (major < 3) return null;

                var size =
                    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);

                var wanted = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist', TRCK: 'trackNumber' };
                var found = {};
                var at = 10;
                var end = Math.min(10 + size, bytes.length);

                while (at + 10 <= end) {
                    var id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
                    if (!/^[A-Z0-9]{4}$/.test(id)) break;

                    var frameSize =
                        major === 4
                            ? ((bytes[at + 4] & 0x7f) << 21) |
                              ((bytes[at + 5] & 0x7f) << 14) |
                              ((bytes[at + 6] & 0x7f) << 7) |
                              (bytes[at + 7] & 0x7f)
                            : (bytes[at + 4] << 24) | (bytes[at + 5] << 16) | (bytes[at + 6] << 8) | bytes[at + 7];

                    if (frameSize <= 0 || at + 10 + frameSize > end) break;

                    if (wanted[id]) {
                        found[wanted[id]] = decodeFrame(bytes.subarray(at + 10, at + 10 + frameSize));
                    }

                    at += 10 + frameSize;
                }

                return found;
            })
            .catch(function () {
                return null;
            });
    }

    /** One text frame, in whichever of ID3's encodings it was written. */
    function decodeFrame(bytes) {
        if (!bytes.length) return null;

        var encoding = bytes[0];
        var body = bytes.subarray(1);
        var label = 'utf-8';

        if (encoding === 0) label = 'iso-8859-1';
        else if (encoding === 1) label = 'utf-16';
        else if (encoding === 2) label = 'utf-16be';

        try {
            // A tag is padded with zero bytes to whatever length it was
            // written at, and those are padding rather than part of the name.
            // A tag is padded with zero bytes out to whatever length it was
            // written at. Those are padding, not part of what a song is called.
            var text = new TextDecoder(label).decode(body).split(PADDING).join('');
            return text.trim() || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * The name a song is known by here, for as long as it is here.
     *
     * Made of where the file is inside the folder that was chosen and how big
     * it is - so the same song is the same song on the next visit, and a like
     * or a place in a playlist still points at it. It is a name, not a
     * fingerprint of the audio: reading every byte of every file to make one
     * would take minutes, and this has to be quick enough to do on a refresh.
     */
    function trackIdFor(folderId, path, size) {
        var text = folderId + PADDING + path.join('/') + PADDING + size;
        var bytes = new TextEncoder().encode(text);

        return global.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
            var out = '';
            new Uint8Array(digest).forEach(function (byte) {
                out += byte.toString(16).padStart(2, '0');
            });
            return 'local:' + out;
        });
    }

    // ============================================
    // Reading a folder
    // ============================================

    /** Every audio file inside one folder, as far down as it is worth going. */
    function walk(directory, path, depth, found) {
        if (depth > MAX_DEPTH || found.length >= MAX_FILES) return Promise.resolve(found);

        var entries = [];

        return (function collect(iterator) {
            return iterator.next().then(function (step) {
                if (step.done) return null;
                entries.push(step.value);
                return collect(iterator);
            });
        })(directory.values()[Symbol.asyncIterator]())
            .then(function () {
                return entries.reduce(function (chain, entry) {
                    return chain.then(function () {
                        if (found.length >= MAX_FILES) return null;

                        var name = entry.name;
                        if (name.charAt(0) === '.') return null;
                        if (SKIP.indexOf(name.toLowerCase()) !== -1) return null;

                        if (entry.kind === 'directory') {
                            return walk(entry, path.concat(name), depth + 1, found);
                        }

                        if (!isAudioName(name)) return null;
                        found.push({ handle: entry, path: path.concat(name) });
                        return null;
                    });
                }, Promise.resolve());
            })
            .then(function () {
                return found;
            })
            .catch(function () {
                // A folder that cannot be read - permission taken back, a
                // drive unplugged - is as far as this goes. What was found up
                // to here is still worth having.
                return found;
            });
    }

    /**
     * What is in this folder now, compared with what was in it before.
     *
     * A song whose name, size and modified time are what they were is the same
     * song, and is kept exactly as it was: nothing is opened, nothing is read,
     * and its id does not move, so a like or a playlist entry pointing at it
     * still points at it. Only what is new or has changed is opened and read.
     */
    function index(folder, existing) {
        var previous = new Map();
        (existing || []).forEach(function (row) {
            previous.set(row.path, row);
        });

        return walk(folder.handle, [], 0, []).then(function (files) {
            return files.reduce(function (chain, file) {
                return chain.then(function (rows) {
                    var path = file.path.join('/');

                    return file.handle
                        .getFile()
                        .then(function (real) {
                            var known = previous.get(path);
                            if (
                                known &&
                                known.size === real.size &&
                                known.lastModified === real.lastModified &&
                                known.id
                            ) {
                                rows.push(known);
                                return rows;
                            }

                            return Promise.all([
                                trackIdFor(folder.id, file.path, real.size),
                                readTags(real)
                            ]).then(function (answers) {
                                var id = answers[0];
                                var tags = answers[1] || {};
                                var guessed = fromFileName(file.name || real.name);

                                rows.push({
                                    id: id,
                                    folderId: folder.id,
                                    path: path,
                                    name: real.name,
                                    size: real.size,
                                    lastModified: real.lastModified,
                                    format: extensionOf(real.name),
                                    title: tags.title || guessed.title,
                                    artist: tags.artist || guessed.artist || null,
                                    album: tags.album || null,
                                    albumArtist: tags.albumArtist || tags.artist || guessed.artist || null,
                                    addedAt: known ? known.addedAt : Date.now()
                                });
                                return rows;
                            });
                        })
                        .catch(function () {
                            // One file that will not open is one file, not a
                            // failed scan.
                            return rows;
                        });
                });
            }, Promise.resolve([]));
        });
    }

    // ============================================
    // The library, as the rest of Spotifie sees it
    // ============================================

    var state = {
        loaded: false,
        folders: [],
        tracks: [],
        scanning: false
    };

    /** What is written down, read once and kept. Needs no permission at all. */
    function load() {
        if (state.loaded) return Promise.resolve(state);
        if (!supported()) {
            state.loaded = true;
            return Promise.resolve(state);
        }

        return Promise.all([readAll(FOLDERS), readAll(TRACKS)])
            .then(function (answers) {
                state.folders = answers[0];
                state.tracks = answers[1];
                state.loaded = true;
                return state;
            })
            .catch(function () {
                state.loaded = true;
                return state;
            });
    }

    /** One song, in the shape the catalogue answers everywhere else. */
    function asTrack(row) {
        var guessed = fromFileName(row.name);

        return {
            id: row.id,
            source: 'local',
            device: true,
            title: row.title || guessed.title,
            artist: row.artist || 'Unknown Artist',
            albumArtist: row.albumArtist || row.artist || 'Unknown Artist',
            album: 'Local Music',
            albumId: LOCAL_MUSIC_ALBUM_ID,
            duration: null,
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
                addedAt: row.addedAt || null
            }
        };
    }

    /**
     * The music on this device, as a catalogue.
     *
     * The same shape a Spotifie server answers with, so everything that draws
     * a library, plays a song, likes one or puts one in a playlist works the
     * same way whichever of the two found the music.
     */
    function catalogue() {
        var tracks = state.tracks.map(asTrack);

        // Nothing has been handed over here, so there is nothing to show. The
        // collection appears when somebody agrees to it, which is the page's
        // decision to make and not this file's - a card named for music that
        // nobody has pointed Spotifie at yet is a card about nothing.
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

    /** Which folders are here, and whether they can be read right now. */
    function folders() {
        return state.folders.map(function (folder) {
            return { id: folder.id, name: folder.name, addedAt: folder.addedAt, trackCount: countIn(folder.id) };
        });
    }

    function countIn(folderId) {
        return state.tracks.filter(function (row) {
            return row.folderId === folderId;
        }).length;
    }

    /** May this folder be read without anybody being asked again? */
    function permissionFor(folder) {
        if (!folder.handle || !folder.handle.queryPermission) return Promise.resolve('prompt');

        return folder.handle.queryPermission({ mode: 'read' }).catch(function () {
            return 'prompt';
        });
    }

    /**
     * Ask for a folder.
     *
     * Only ever from something somebody did: a browser refuses to open a
     * picker any other way, and rightly - a page that could open one by itself
     * could badger somebody into handing over a folder they never meant to.
     */
    function chooseFolder() {
        if (!supported()) return Promise.reject(new Error('This browser cannot open a folder for Spotifie.'));

        return global
            .showDirectoryPicker({ id: 'spotifie-music', mode: 'read', startIn: 'music' })
            .then(function (handle) {
                return load().then(function () {
                    return sameFolder(handle).then(function (already) {
                        var folder = already || {
                            id: 'folder-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
                            name: handle.name,
                            handle: handle,
                            addedAt: Date.now()
                        };

                        folder.handle = handle;
                        folder.name = handle.name;
                        return scanFolder(folder);
                    });
                });
            });
    }

    /** The same folder chosen twice is one folder, not two. */
    function sameFolder(handle) {
        return state.folders.reduce(function (chain, folder) {
            return chain.then(function (found) {
                if (found) return found;

                // A folder whose handle could not be written down - a browser
                // that will not keep one - is recognised by its name instead.
                // Choosing it again is somebody reconnecting the folder they
                // already had, and the alternative is the same songs listed
                // twice under two folders that are one folder.
                if (!folder.handle || !folder.handle.isSameEntry) {
                    return folder.name === handle.name ? folder : null;
                }

                return folder.handle
                    .isSameEntry(handle)
                    .then(function (same) {
                        return same ? folder : null;
                    })
                    .catch(function () {
                        return null;
                    });
            });
        }, Promise.resolve(null));
    }

    /** Read one folder and write down what is in it. */
    function scanFolder(folder) {
        state.scanning = true;

        var existing = state.tracks.filter(function (row) {
            return row.folderId === folder.id;
        });

        return index(folder, existing)
            .then(function (rows) {
                return writeFolder(
                    { id: folder.id, name: folder.name, handle: folder.handle, addedAt: folder.addedAt },
                    rows
                ).then(function () {
                    state.folders = state.folders
                        .filter(function (known) {
                            return known.id !== folder.id;
                        })
                        .concat([folder]);

                    state.tracks = state.tracks
                        .filter(function (row) {
                            return row.folderId !== folder.id;
                        })
                        .concat(rows);

                    return { folder: folder.name, trackCount: rows.length, total: state.tracks.length };
                });
            })
            .finally(function () {
                state.scanning = false;
            });
    }

    /**
     * Look again at the folders already chosen.
     *
     * Only the ones the browser still lets Spotifie read without asking. A
     * folder that would need somebody to say yes again is left exactly as it
     * is - the songs in it stay in the library, listed from what was written
     * down, and the question is put once, when somebody asks for their music,
     * rather than on every page load forever.
     */
    function refresh() {
        if (!supported()) return Promise.resolve({ scanned: 0, needsPermission: 0 });

        return load().then(function () {
            return state.folders.reduce(
                function (chain, folder) {
                    return chain.then(function (summary) {
                        return permissionFor(folder).then(function (permission) {
                            if (permission !== 'granted') {
                                summary.needsPermission += 1;
                                return summary;
                            }

                            return scanFolder(folder)
                                .then(function () {
                                    summary.scanned += 1;
                                    return summary;
                                })
                                .catch(function () {
                                    return summary;
                                });
                        });
                    });
                },
                Promise.resolve({ scanned: 0, needsPermission: 0 })
            );
        });
    }

    /**
     * Ask again for a folder that was chosen before.
     *
     * From something somebody did, like the picker itself. Answers how many
     * folders can be read afterwards.
     */
    function reconnect() {
        if (!supported()) return Promise.resolve(0);

        return load().then(function () {
            return state.folders.reduce(function (chain, folder) {
                return chain.then(function (granted) {
                    if (!folder.handle || !folder.handle.requestPermission) return granted;

                    return folder.handle
                        .requestPermission({ mode: 'read' })
                        .then(function (permission) {
                            if (permission !== 'granted') return granted;
                            return scanFolder(folder)
                                .then(function () {
                                    return granted + 1;
                                })
                                .catch(function () {
                                    return granted + 1;
                                });
                        })
                        .catch(function () {
                            return granted;
                        });
                });
            }, Promise.resolve(0));
        });
    }

    /** Forget one folder: the songs in it go, the files are untouched. */
    function forget(folderId) {
        return removeFolder(folderId).then(function () {
            state.folders = state.folders.filter(function (folder) {
                return folder.id !== folderId;
            });
            state.tracks = state.tracks.filter(function (row) {
                return row.folderId !== folderId;
            });
            return true;
        });
    }

    // ============================================
    // Playing one
    // ============================================

    // The address of whatever is playing, and nothing else. One at a time,
    // dropped when the next one is made: an address into memory holds the file
    // open, and a page that made one per song would hold every song somebody
    // had played all session.
    var playing = null;

    function releasePlaying() {
        if (!playing) return;

        try {
            global.URL.revokeObjectURL(playing.url);
        } catch (e) {
            /* the address was already gone */
        }
        playing = null;
    }

    /**
     * An address the player can use for one song.
     *
     * Made from the file itself, held only while it is playing, and never
     * written down anywhere: it means nothing in the next page load, and a
     * stored one would be a broken song rather than a saved one.
     */
    function trackUrl(trackId) {
        if (playing && playing.id === trackId) return Promise.resolve(playing.url);

        return load().then(function () {
            var row = state.tracks.filter(function (known) {
                return known.id === trackId;
            })[0];
            if (!row) return null;

            var folder = state.folders.filter(function (known) {
                return known.id === row.folderId;
            })[0];
            if (!folder || !folder.handle) return null;

            return fileFor(folder.handle, row.path)
                .then(function (file) {
                    if (!file) return null;

                    releasePlaying();
                    playing = { id: trackId, url: global.URL.createObjectURL(file) };
                    return playing.url;
                })
                .catch(function () {
                    return null;
                });
        });
    }

    /** Walk down to one file inside a folder that was chosen. */
    function fileFor(handle, path) {
        var parts = String(path).split('/');
        var name = parts.pop();

        return parts
            .reduce(function (chain, part) {
                return chain.then(function (directory) {
                    return directory.getDirectoryHandle(part);
                });
            }, Promise.resolve(handle))
            .then(function (directory) {
                return directory.getFileHandle(name);
            })
            .then(function (file) {
                return file.getFile();
            });
    }

    global.spotifieBrowserLibrary = {
        supported: supported,
        load: load,
        catalogue: catalogue,
        folders: folders,
        trackCount: function () {
            return state.tracks.length;
        },
        chooseFolder: chooseFolder,
        refresh: refresh,
        reconnect: reconnect,
        forget: forget,
        trackUrl: trackUrl,
        releasePlaying: releasePlaying,
        LOCAL_MUSIC_ALBUM_ID: LOCAL_MUSIC_ALBUM_ID
    };
})(typeof window !== 'undefined' ? window : globalThis);
