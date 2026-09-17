/**
 * Library Database Module
 * Uses IndexedDB for scalable, async storage of user's music library
 */

const LibraryDB = (function() {
    const DB_NAME = 'SpotifyLibrary';
    const DB_VERSION = 2; // Incremented for new store
    let db = null;

    // Store names
    const STORES = {
        LIKED_SONGS: 'likedSongs',
        USER_SONGS: 'userSongs',           // Songs added by user to albums (references)
        REMOVED_SONGS: 'removedSongs',     // Songs removed by user from built-in albums
        USER_PLAYLISTS: 'userPlaylists'    // Custom playlists
    };

    // Stores from earlier versions that are no longer written to or read from.
    // Audio is never kept in the browser: it streams from the local library
    // service. Legacy data is only cleared, never used.
    const LEGACY_STORES = ['deviceSongs'];

    /**
     * Initialize the database
     */
    async function init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                console.error('Failed to open IndexedDB:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                db = request.result;
                resolve(db);
            };

            request.onupgradeneeded = (event) => {
                const database = event.target.result;

                // Liked Songs store
                if (!database.objectStoreNames.contains(STORES.LIKED_SONGS)) {
                    const likedStore = database.createObjectStore(STORES.LIKED_SONGS, { keyPath: 'id' });
                    likedStore.createIndex('folder', 'folder', { unique: false });
                    likedStore.createIndex('addedAt', 'addedAt', { unique: false });
                }

                // User Songs added to albums
                if (!database.objectStoreNames.contains(STORES.USER_SONGS)) {
                    const userSongsStore = database.createObjectStore(STORES.USER_SONGS, { keyPath: 'id' });
                    userSongsStore.createIndex('albumFolder', 'albumFolder', { unique: false });
                    userSongsStore.createIndex('sourceFolder', 'sourceFolder', { unique: false });
                }

                // Removed Songs from built-in albums
                if (!database.objectStoreNames.contains(STORES.REMOVED_SONGS)) {
                    const removedStore = database.createObjectStore(STORES.REMOVED_SONGS, { keyPath: 'id' });
                    removedStore.createIndex('albumFolder', 'albumFolder', { unique: false });
                }

                // User Playlists
                if (!database.objectStoreNames.contains(STORES.USER_PLAYLISTS)) {
                    database.createObjectStore(STORES.USER_PLAYLISTS, { keyPath: 'id' });
                }
            };
        });
    }

    /**
     * Generate unique ID for a song
     */
    function generateSongId(folder, track) {
        return `${folder}::${track}`;
    }

    /**
     * Like/Unlike a song
     */
    async function toggleLikeSong(folder, track) {
        const id = generateSongId(folder, track);
        const existing = await getLikedSong(id);
        
        if (existing) {
            await removeLikedSong(id);
            return false; // unliked
        } else {
            await addLikedSong(folder, track);
            return true; // liked
        }
    }

    /**
     * Add a song to liked songs
     */
    async function addLikedSong(folder, track) {
        const id = generateSongId(folder, track);
        const song = {
            id,
            folder,
            track,
            addedAt: Date.now()
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.LIKED_SONGS], 'readwrite');
            const store = transaction.objectStore(STORES.LIKED_SONGS);
            const request = store.put(song);

            request.onsuccess = () => resolve(song);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Remove a song from liked songs
     */
    async function removeLikedSong(id) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.LIKED_SONGS], 'readwrite');
            const store = transaction.objectStore(STORES.LIKED_SONGS);
            const request = store.delete(id);

            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get a liked song by ID
     */
    async function getLikedSong(id) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.LIKED_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.LIKED_SONGS);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Check if a song is liked
     */
    async function isSongLiked(folder, track) {
        const id = generateSongId(folder, track);
        const song = await getLikedSong(id);
        return !!song;
    }

    /**
     * Get all liked songs
     */
    async function getAllLikedSongs() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.LIKED_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.LIKED_SONGS);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * A song's membership of an album, identified the way the catalogue
     * identifies tracks: by the namespaced track id. The album a song came
     * from is remembered, but it is not part of the identity - the same song
     * added from two places is still one member of this album.
     */
    function membershipId(albumFolder, track) {
        return `${albumFolder}::${track}`;
    }

    /**
     * Add a song to an album (user addition).
     * A song already in the album is left as it is rather than added twice.
     */
    async function addSongToAlbum(albumFolder, sourceFolder, track) {
        const existing = await getUserSongsForAlbum(albumFolder);
        const already = existing.find((entry) => entry.track === track);
        if (already) return already;

        const entry = {
            id: membershipId(albumFolder, track),
            albumFolder,
            sourceFolder,
            track,
            addedAt: Date.now()
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.USER_SONGS], 'readwrite');
            const store = transaction.objectStore(STORES.USER_SONGS);
            const request = store.put(entry);

            request.onsuccess = () => resolve(entry);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Take a song out of an album.
     *
     * Every record of that track in this album goes in one operation, however
     * many there are: older records were keyed by the album the song came
     * from, so the same song could be recorded more than once and appear to
     * survive being removed. The audio, the library entry and the album the
     * song came from are all untouched - this is membership only.
     */
    async function removeSongFromAlbum(albumFolder, track) {
        const entries = await getUserSongsForAlbum(albumFolder);
        const doomed = entries.filter((entry) => entry.track === track).map((entry) => entry.id);
        doomed.push(membershipId(albumFolder, track));

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.USER_SONGS], 'readwrite');
            const store = transaction.objectStore(STORES.USER_SONGS);

            // One transaction: the album never sits half-changed.
            new Set(doomed).forEach((id) => store.delete(id));

            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    /** Whether this album already holds that track as a user addition. */
    async function isSongInAlbum(albumFolder, track) {
        const entries = await getUserSongsForAlbum(albumFolder);
        return entries.some((entry) => entry.track === track);
    }

    /**
     * Get all user-added songs for an album
     */
    async function getUserSongsForAlbum(albumFolder) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.USER_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.USER_SONGS);
            const index = store.index('albumFolder');
            const request = index.getAll(albumFolder);

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Mark a song as removed from a built-in album
     */
    async function markSongAsRemoved(albumFolder, track) {
        const id = `${albumFolder}::${track}`;
        const entry = {
            id,
            albumFolder,
            track,
            removedAt: Date.now()
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.REMOVED_SONGS], 'readwrite');
            const store = transaction.objectStore(STORES.REMOVED_SONGS);
            const request = store.put(entry);

            request.onsuccess = () => resolve(entry);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Unmark a song as removed (restore it)
     */
    async function unmarkSongAsRemoved(albumFolder, track) {
        const id = `${albumFolder}::${track}`;
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.REMOVED_SONGS], 'readwrite');
            const store = transaction.objectStore(STORES.REMOVED_SONGS);
            const request = store.delete(id);

            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all removed songs for an album
     */
    async function getRemovedSongsForAlbum(albumFolder) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.REMOVED_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.REMOVED_SONGS);
            const index = store.index('albumFolder');
            const request = index.getAll(albumFolder);

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Check if a song is removed from an album
     */
    async function isSongRemoved(albumFolder, track) {
        const id = `${albumFolder}::${track}`;
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.REMOVED_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.REMOVED_SONGS);
            const request = store.get(id);

            request.onsuccess = () => resolve(!!request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get effective tracks for an album (library tracks - removed + user added).
     * All entries are library track IDs; no audio data is stored or returned.
     */
    async function getEffectiveSongsForAlbum(albumFolder, serverSongs) {
        const [removedSongs, userSongs] = await Promise.all([
            getRemovedSongsForAlbum(albumFolder),
            getUserSongsForAlbum(albumFolder)
        ]);

        const removedTracks = new Set(removedSongs.map(s => s.track));

        // Filter out removed songs from the library-provided list
        const filteredServerSongs = serverSongs.filter(track => !removedTracks.has(track));

        const userSongsList = userSongs
            .filter(s => !removedTracks.has(s.track))
            .map(s => ({
                track: s.track,
                sourceFolder: s.sourceFolder,
                isUserAdded: true
            }));

        // One row per track. Two records of the same song - one from the
        // catalogue, one from an addition - are the same song, and the album
        // shows it once.
        const byTrack = new Map();
        for (const track of filteredServerSongs) {
            byTrack.set(track, { track, sourceFolder: albumFolder, isUserAdded: false });
        }
        for (const entry of userSongsList) {
            if (!byTrack.has(entry.track)) byTrack.set(entry.track, entry);
        }

        return {
            serverSongs: filteredServerSongs,
            userSongs: userSongsList,
            allSongs: Array.from(byTrack.values())
        };
    }

    /**
     * Get count of liked songs
     */
    async function getLikedSongsCount() {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.LIKED_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.LIKED_SONGS);
            const request = store.count();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Clear all data (for testing/reset)
     * @param {boolean} includeLocalStorage - Whether to also clear localStorage data
     */
    async function clearAll(includeLocalStorage = false) {
        const stores = Object.values(STORES).concat(
            LEGACY_STORES.filter(name => db.objectStoreNames.contains(name))
        );
        
        for (const storeName of stores) {
            await new Promise((resolve, reject) => {
                const transaction = db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.clear();

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        }
        
        // Clear localStorage data if requested
        if (includeLocalStorage) {
            localStorage.removeItem('spotify_user_albums');
            localStorage.removeItem('spotify_pinned_albums');
            localStorage.removeItem('spotify_deleted_albums');
            localStorage.removeItem('spotify_edited_albums');
        }
        
    }

    /**
     * Export all library data to JSON
     * Backups hold references and settings only - never audio data.
     */
    async function exportLibrary() {
        const exportData = {
            version: DB_VERSION,
            exportDate: new Date().toISOString(),
            likedSongs: [],
            userSongs: [],
            removedSongs: [],
            userPlaylists: [],
            // LocalStorage data
            localStorage: {
                userAlbums: null,
                pinnedAlbums: null,
                deletedAlbums: null,
                editedAlbums: null
            }
        };

        // Export liked songs
        exportData.likedSongs = await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.LIKED_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.LIKED_SONGS);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        // Export user songs (references)
        exportData.userSongs = await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.USER_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.USER_SONGS);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        // Export removed songs
        exportData.removedSongs = await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.REMOVED_SONGS], 'readonly');
            const store = transaction.objectStore(STORES.REMOVED_SONGS);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        // Export user playlists
        exportData.userPlaylists = await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.USER_PLAYLISTS], 'readonly');
            const store = transaction.objectStore(STORES.USER_PLAYLISTS);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        // Export localStorage data (user albums, pinned, deleted, edited, liked songs config)
        try {
            const userAlbumsData = localStorage.getItem('spotify_user_albums');
            if (userAlbumsData) {
                exportData.localStorage.userAlbums = JSON.parse(userAlbumsData);
            }
            
            const pinnedAlbums = localStorage.getItem('spotify_pinned_albums');
            if (pinnedAlbums) {
                exportData.localStorage.pinnedAlbums = JSON.parse(pinnedAlbums);
            }
            
            const deletedAlbums = localStorage.getItem('spotify_deleted_albums');
            if (deletedAlbums) {
                exportData.localStorage.deletedAlbums = JSON.parse(deletedAlbums);
            }
            
            const editedAlbums = localStorage.getItem('spotify_edited_albums');
            if (editedAlbums) {
                exportData.localStorage.editedAlbums = JSON.parse(editedAlbums);
            }
            
            const likedSongsConfig = localStorage.getItem('likedSongsAlbumConfig');
            if (likedSongsConfig) {
                exportData.localStorage.likedSongsConfig = JSON.parse(likedSongsConfig);
            }
        } catch (e) {
            console.error('Error exporting localStorage data:', e);
        }

        return exportData;
    }

    /**
     * Import library data from JSON
     * @param {Object} importData - The data to import
     * @param {boolean} merge - If true, merge with existing data; if false, replace
     */
    async function importLibrary(importData, merge = true) {
        if (!importData || typeof importData !== 'object') {
            throw new Error('Invalid import data');
        }

        // Validate version
        if (importData.version && importData.version > DB_VERSION) {
            throw new Error('Import data is from a newer version. Please update the app.');
        }

        if (!merge) {
            // Clear existing data first (including localStorage)
            await clearAll(true);
        }

        let imported = {
            likedSongs: 0,
            userSongs: 0,
            removedSongs: 0,
            userPlaylists: 0,
            userAlbums: 0
        };

        // Import liked songs
        if (importData.likedSongs && Array.isArray(importData.likedSongs)) {
            for (const song of importData.likedSongs) {
                if (song.id && song.folder && song.track) {
                    await new Promise((resolve, reject) => {
                        const transaction = db.transaction([STORES.LIKED_SONGS], 'readwrite');
                        const store = transaction.objectStore(STORES.LIKED_SONGS);
                        const request = store.put(song);
                        request.onsuccess = () => { imported.likedSongs++; resolve(); };
                        request.onerror = () => reject(request.error);
                    });
                }
            }
        }

        // Import user songs
        if (importData.userSongs && Array.isArray(importData.userSongs)) {
            for (const song of importData.userSongs) {
                if (song.id && song.albumFolder && song.track) {
                    await new Promise((resolve, reject) => {
                        const transaction = db.transaction([STORES.USER_SONGS], 'readwrite');
                        const store = transaction.objectStore(STORES.USER_SONGS);
                        const request = store.put(song);
                        request.onsuccess = () => { imported.userSongs++; resolve(); };
                        request.onerror = () => reject(request.error);
                    });
                }
            }
        }

        // Import removed songs
        if (importData.removedSongs && Array.isArray(importData.removedSongs)) {
            for (const song of importData.removedSongs) {
                if (song.id && song.albumFolder && song.track) {
                    await new Promise((resolve, reject) => {
                        const transaction = db.transaction([STORES.REMOVED_SONGS], 'readwrite');
                        const store = transaction.objectStore(STORES.REMOVED_SONGS);
                        const request = store.put(song);
                        request.onsuccess = () => { imported.removedSongs++; resolve(); };
                        request.onerror = () => reject(request.error);
                    });
                }
            }
        }

        // Import user playlists
        if (importData.userPlaylists && Array.isArray(importData.userPlaylists)) {
            for (const playlist of importData.userPlaylists) {
                if (playlist.id) {
                    await new Promise((resolve, reject) => {
                        const transaction = db.transaction([STORES.USER_PLAYLISTS], 'readwrite');
                        const store = transaction.objectStore(STORES.USER_PLAYLISTS);
                        const request = store.put(playlist);
                        request.onsuccess = () => { imported.userPlaylists++; resolve(); };
                        request.onerror = () => reject(request.error);
                    });
                }
            }
        }

        // Device songs from older backups are ignored: audio is never
        // imported into the browser.

        // Import localStorage data (user albums, pinned, deleted, edited)
        if (importData.localStorage) {
            try {
                // Import user albums
                if (importData.localStorage.userAlbums) {
                    if (merge) {
                        // Merge with existing user albums
                        const existingAlbums = JSON.parse(localStorage.getItem('spotify_user_albums') || '{}');
                        const mergedAlbums = { ...existingAlbums, ...importData.localStorage.userAlbums };
                        localStorage.setItem('spotify_user_albums', JSON.stringify(mergedAlbums));
                    } else {
                        localStorage.setItem('spotify_user_albums', JSON.stringify(importData.localStorage.userAlbums));
                    }
                    imported.userAlbums = Object.keys(importData.localStorage.userAlbums).length;
                }
                
                // Import pinned albums
                if (importData.localStorage.pinnedAlbums) {
                    if (merge) {
                        const existingPinned = JSON.parse(localStorage.getItem('spotify_pinned_albums') || '[]');
                        const mergedPinned = [...new Set([...existingPinned, ...importData.localStorage.pinnedAlbums])];
                        localStorage.setItem('spotify_pinned_albums', JSON.stringify(mergedPinned));
                    } else {
                        localStorage.setItem('spotify_pinned_albums', JSON.stringify(importData.localStorage.pinnedAlbums));
                    }
                }
                
                // Import deleted albums
                if (importData.localStorage.deletedAlbums) {
                    if (merge) {
                        const existingDeleted = JSON.parse(localStorage.getItem('spotify_deleted_albums') || '[]');
                        const mergedDeleted = [...new Set([...existingDeleted, ...importData.localStorage.deletedAlbums])];
                        localStorage.setItem('spotify_deleted_albums', JSON.stringify(mergedDeleted));
                    } else {
                        localStorage.setItem('spotify_deleted_albums', JSON.stringify(importData.localStorage.deletedAlbums));
                    }
                }
                
                // Import edited albums
                if (importData.localStorage.editedAlbums) {
                    if (merge) {
                        const existingEdited = JSON.parse(localStorage.getItem('spotify_edited_albums') || '{}');
                        const mergedEdited = { ...existingEdited, ...importData.localStorage.editedAlbums };
                        localStorage.setItem('spotify_edited_albums', JSON.stringify(mergedEdited));
                    } else {
                        localStorage.setItem('spotify_edited_albums', JSON.stringify(importData.localStorage.editedAlbums));
                    }
                }
                
                // Import liked songs config
                if (importData.localStorage.likedSongsConfig) {
                    localStorage.setItem('likedSongsAlbumConfig', JSON.stringify(importData.localStorage.likedSongsConfig));
                }
            } catch (e) {
                console.error('Error importing localStorage data:', e);
            }
        }

        return imported;
    }

    /**
     * Get library statistics
     */
    async function getLibraryStats() {
        const stats = {
            likedSongs: 0,
            userSongs: 0,
            removedSongs: 0,
            userPlaylists: 0,
            userAlbums: 0
        };

        for (const [key, storeName] of Object.entries(STORES)) {
            stats[key.toLowerCase().replace('_', '')] = await new Promise((resolve, reject) => {
                const transaction = db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.count();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }

        // Count user albums from localStorage
        try {
            const userAlbumsData = localStorage.getItem('spotify_user_albums');
            if (userAlbumsData) {
                const userAlbums = JSON.parse(userAlbumsData);
                stats.userAlbums = Object.keys(userAlbums).length;
            }
        } catch (e) {
            console.error('Error counting user albums:', e);
        }

        return stats;
    }

    // Public API
    return {
        init,
        generateSongId,
        // Liked songs
        toggleLikeSong,
        addLikedSong,
        removeLikedSong,
        getLikedSong,
        isSongLiked,
        getAllLikedSongs,
        getLikedSongsCount,
        // User songs in albums
        addSongToAlbum,
        removeSongFromAlbum,
        isSongInAlbum,
        getUserSongsForAlbum,
        // Removed songs
        markSongAsRemoved,
        unmarkSongAsRemoved,
        getRemovedSongsForAlbum,
        isSongRemoved,
        // Device songs
        // Combined
        getEffectiveSongsForAlbum,
        // Import/Export
        exportLibrary,
        importLibrary,
        getLibraryStats,
        // Utils
        clearAll
    };
})();

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LibraryDB;
}
