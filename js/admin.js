/**
 * Spotifie Admin Dashboard
 * ============================================
 * SECURITY NOTES:
 * 1. The Supabase session is the only proof of identity; nothing in
 *    localStorage or sessionStorage can grant access.
 * 2. Administrator rights come from the app_admins table, keyed by the
 *    authenticated user id. Users cannot write to that table.
 * 3. Every privileged endpoint re-checks admin rights server-side, so a
 *    visible dashboard is never enough to change anything.
 */

let adminUser = null;
let supabaseAdmin = null;

async function initAdminDashboard() {
    const loadingOverlay = document.getElementById('loadingOverlay');

    try {
        await window.spotifieAuth.ready();
        supabaseAdmin = await window.spotifieAuth.tryGetClient();

        // A configuration failure is not an authorization failure: say so
        // rather than bouncing to the home page for no visible reason.
        const configError = window.spotifieAuth.getConfigError();
        if (configError) {
            console.error(configError);
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            showToast(configError, 'error');
            return;
        }

        const session = await window.spotifieAuth.getSession();
        if (!session) {
            redirectToHome('No active session');
            return;
        }

        const isAdmin = await window.spotifieAuth.isAdmin();
        if (!isAdmin) {
            redirectToHome('Account is not an administrator');
            return;
        }

        adminUser = session.user;

        const emailDisplay = document.getElementById('adminEmailDisplay');
        if (emailDisplay) {
            emailDisplay.textContent = adminUser.email || '';
        }

        // Sign-out elsewhere (or an expired session) closes the dashboard.
        window.spotifieAuth.onAuthChange((currentSession) => {
            if (!currentSession) {
                window.location.replace('index.html');
            }
        });

        // Refresh the local library index, then load the dashboard
        try {
            await rescanLibrary();
        } catch (scanError) {
            console.warn('Library rescan failed (non-fatal):', scanError);
        }

        try {
            await loadDashboardData();
        } catch (dataError) {
            console.warn('Dashboard data load error (non-fatal):', dataError);
        }

        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
        }
    } catch (err) {
        console.error('Admin init error:', err);
        redirectToHome('Authentication failed: ' + err.message);
    }
}

function redirectToHome(reason) {
    console.warn('Dashboard access denied:', reason);
    window.location.replace('index.html');
}

// ============================================
// GLOBAL CATALOGUE DATA
// ============================================
// The dashboard manages the global catalogue only: albums and tracks that
// every signed-in listener sees, stored in Supabase with the files in private
// Storage buckets. Music a user adds on their own device is local to that
// device and is never visible or editable here.

let allSongs = [];
let allAlbums = [];
let localTrackCount = 0;

const AUDIO_BUCKET = 'catalog-audio';
const ARTWORK_BUCKET = 'catalog-artwork';

const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/opus'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// The shipped placeholder cover, used whenever artwork is missing.
const DEFAULT_COVER = 'img/music.svg';

// Set only when the administrator deliberately removes a saved cover. Opening
// the edit modal, or cancelling a replacement, never sets it.
let albumCoverRemoved = false;

function catalogClient() {
    return window.spotifieCatalog;
}

/**
 * Throw away the copy of the published catalogue this device keeps.
 *
 * Called after every change made here. The server has already forgotten what
 * it read, so the next listener gets the new catalogue; this is the other half
 * of the same thing - the browser's copy is dropped, so the library is drawn
 * from what was just published rather than from what was there before it.
 *
 * Covers on their own need no clearing: the address of a picture carries which
 * picture it is, so a replaced cover is a different address and the old one is
 * never shown in its place.
 */
function forgetCachedCatalogue() {
    const cache = window.spotifieCatalogCache;
    if (!cache) return;

    try {
        cache.clear();
    } catch (e) {
        /* a copy is a convenience; not having one changes nothing */
    }
}

async function loadDashboardData() {
    try {
        const [tracks, albums] = await Promise.all([
            catalogClient().getTracks(),
            catalogClient().getAlbums()
        ]);

        const sources = tracks.sources || {};
        if (sources.global && sources.global.available === false && sources.global.error) {
            showToast('Global catalogue unavailable: ' + sources.global.error, 'error');
        }

        allSongs = (tracks.items || []).filter(track => track.source === 'global');
        allAlbums = (albums.items || []).filter(album => album.source === 'global');
        localTrackCount = (tracks.items || []).length - allSongs.length;

        // Load user count (from profiles - authentication data, not music)
        let userCount = 0;
        try {
            const { count } = await supabaseAdmin
                .from('profiles')
                .select('*', { count: 'exact', head: true });
            userCount = count || 0;
        } catch (e) {
            console.log('Could not load user count');
        }

        document.getElementById('totalSongs').textContent = allSongs.length;
        document.getElementById('totalAlbums').textContent = allAlbums.length;
        document.getElementById('totalUsers').textContent = userCount;

        renderRecentSongs();
        renderAllSongs();
        renderAllAlbums();
        updateAlbumDropdown();
        resolveArtworkThumbnails();
    } catch (err) {
        console.error('Error loading dashboard data:', err);
        showToast('Failed to load the global catalogue', 'error');
    }
}

/**
 * Fill in every artwork thumbnail in the dashboard.
 *
 * The catalogue client is the one place that knows how to turn a catalogue id
 * into a viewable image: it asks the server, which signs the private Storage
 * object. The dashboard never builds a Storage URL itself, so it shows exactly
 * the same cover the player does - and falls back to the default cover when a
 * track and its album both have none.
 */
function resolveArtworkThumbnails(root) {
    const scope = root || document;
    const client = catalogClient();
    if (!client) return;

    scope.querySelectorAll('img[data-artwork-id]').forEach((image) => {
        const id = image.dataset.artworkId;
        if (!id || image.dataset.artworkResolved === id) return;
        image.dataset.artworkResolved = id;

        client
            .resolveArtworkUrl(id, { kind: image.dataset.artworkKind, fallback: DEFAULT_COVER })
            .then((url) => {
                if (url) image.src = url;
            })
            .catch(() => {
                /* the default cover stays */
            });
    });
}

// ============================================
// STORAGE UPLOADS
// ============================================
// Files go straight to private Supabase Storage buckets. Nothing is ever
// encoded as Base64 and no audio is stored in the database.

function fileExtension(file, fallback) {
    const name = file && file.name ? file.name : '';
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
    return fallback;
}

function storageObjectName(file, fallbackExtension) {
    const unique = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    return unique + '.' + fileExtension(file, fallbackExtension);
}

function validateUpload(file, allowedTypes, maxBytes, label) {
    if (!file) throw new Error('No ' + label + ' selected');
    if (file.size > maxBytes) {
        throw new Error(label + ' is too large (limit ' + Math.round(maxBytes / (1024 * 1024)) + ' MB)');
    }
    if (file.type && allowedTypes.indexOf(file.type.toLowerCase()) === -1) {
        throw new Error('Unsupported ' + label + ' type: ' + file.type);
    }
}

async function uploadToBucket(bucket, file, objectPath) {
    const { error } = await supabaseAdmin.storage.from(bucket).upload(objectPath, file, {
        cacheControl: '3600',
        contentType: file.type || undefined,
        upsert: false
    });
    if (error) throw new Error('Upload failed: ' + error.message);
    return objectPath;
}

/** Best-effort cleanup so a failed save does not leave an orphan object. */
async function removeFromBucket(bucket, objectPath) {
    if (!objectPath) return;
    try {
        await supabaseAdmin.storage.from(bucket).remove([objectPath]);
    } catch (e) {
        console.warn('Could not remove orphaned object', bucket + '/' + objectPath, e);
    }
}

async function uploadAudio(file) {
    validateUpload(file, ALLOWED_AUDIO_TYPES, MAX_AUDIO_BYTES, 'audio file');
    return uploadToBucket(AUDIO_BUCKET, file, storageObjectName(file, 'mp3'));
}

async function uploadArtwork(file) {
    validateUpload(file, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, 'image');
    return uploadToBucket(ARTWORK_BUCKET, file, storageObjectName(file, 'jpg'));
}
function renderRecentSongs() {
    const tbody = document.getElementById('recentSongsTable');
    
    // Most recently published global tracks
    const dbSongs = allSongs.slice(0, 5);

    if (dbSongs.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4">
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/>
                        </svg>
                        <h3>No recent songs</h3>
                        <p>Songs you add will appear here</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = dbSongs.map(song => {
        const coverUrl = DEFAULT_COVER;
        const artworkId = song.id;
        const artworkKind = 'track';
        const title = song.title || 'Unknown';
        const artist = song.artist || 'Unknown Artist';
        
        return `
            <tr>
                <td>
                    <div class="song-info">
                        <img src="${coverUrl}" alt="${escapeHtml(title)}" class="song-cover" data-artwork-id="${artworkId}" data-artwork-kind="${artworkKind}" onerror="this.src='img/music.svg'">
                        <div class="song-details">
                            <h4>${escapeHtml(title)}</h4>
                            <p>${escapeHtml(artist)}</p>
                        </div>
                    </div>
                </td>
                <td>${escapeHtml(song.album || '-')}</td>
                <td>${song.duration ? formatDuration(song.duration) : '-'}</td>
                <td>
                    <div class="action-btns">
                        <button class="action-btn" data-action="edit-song" data-id="${escapeHtml(song.id)}" title="Edit">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="action-btn delete" data-action="delete" data-type="global-song" data-id="${escapeHtml(song.id)}" data-name="${escapeHtml(title)}" title="Delete">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function renderAllSongs(filter = '') {
    const tbody = document.getElementById('allSongsTable');
    let filteredSongs = allSongs;

    if (filter) {
        const lowerFilter = filter.toLowerCase();
        filteredSongs = allSongs.filter(song => 
            (song.title && song.title.toLowerCase().includes(lowerFilter)) ||
            (song.artist && song.artist.toLowerCase().includes(lowerFilter)) ||
            (song.album && song.album.toLowerCase().includes(lowerFilter))
        );
    }

    if (filteredSongs.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5">
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/>
                        </svg>
                        <h3>${filter ? 'No matching songs' : 'No songs yet'}</h3>
                        <p>${filter ? 'Try a different search term' : 'Add your first song to get started'}</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filteredSongs.map(song => {
        const coverUrl = DEFAULT_COVER;
        const artworkId = song.id;
        const artworkKind = 'track';
        const title = song.title || 'Unknown';
        const artist = song.artist || 'Unknown Artist';
        const albumName = song.album || '-';
        const duration = song.duration ? formatDuration(song.duration) : '-';
        const date = (song.metadata && song.metadata.createdAt) ? new Date(song.metadata.createdAt).toLocaleDateString() : '-';
        const sourceTag = '<span class="source-tag db">Global</span>';
        const songId = song.id;
        const songSource = 'global';
        const deleteType = 'global-song';
        const songPath = song.albumId || '';
        
        return `
            <tr data-id="${songId}" data-source="${songSource}">
                <td class="select-column">
                    <input type="checkbox" class="row-select" data-id="${escapeHtml(songId)}" aria-label="Select ${escapeHtml(title)}">
                </td>
                <td>
                    <div class="song-info">
                        <img src="${coverUrl}" alt="${escapeHtml(title)}" class="song-cover" data-artwork-id="${artworkId}" data-artwork-kind="${artworkKind}" onerror="this.src='img/music.svg'">
                        <div class="song-details">
                            <h4>${escapeHtml(title.substring(0, 40))}${title.length > 40 ? '...' : ''}</h4>
                            <p>${escapeHtml(artist)}</p>
                        </div>
                    </div>
                </td>
                <td>${escapeHtml(albumName)} ${sourceTag}</td>
                <td>${duration}</td>
                <td>${date}</td>
                <td>
                    <div class="action-btns">
                        <button class="action-btn" data-action="edit-song" data-id="${escapeHtml(songId)}" title="Edit">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="action-btn delete" data-action="delete" data-type="${escapeHtml(deleteType)}" data-id="${escapeHtml(songId)}" data-name="${escapeHtml(title)}" title="Delete">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function renderAllAlbums(filter = '') {
    const tbody = document.getElementById('allAlbumsTable');
    let filteredAlbums = allAlbums;

    if (filter) {
        const lowerFilter = filter.toLowerCase();
        filteredAlbums = allAlbums.filter(album => 
            album.title.toLowerCase().includes(lowerFilter) ||
            (album.artist && album.artist.toLowerCase().includes(lowerFilter))
        );
    }

    if (filteredAlbums.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4">
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
                        </svg>
                        <h3>${filter ? 'No matching albums' : 'No albums yet'}</h3>
                        <p>${filter ? 'Try a different search term' : 'Add your first album to get started'}</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filteredAlbums.map(album => {
        const coverUrl = DEFAULT_COVER;
        const artworkId = album.id;
        const artworkKind = 'album';
        const title = album.title || 'Unknown Album';
        const artist = album.albumArtist || 'Various Artists';
        const songCount = album.trackCount || allSongs.filter(s => s.albumId === album.id).length || 0;
        const date = (album.metadata && album.metadata.createdAt) ? new Date(album.metadata.createdAt).toLocaleDateString() : '-';
        const sourceTag = '<span class="source-tag db">Global</span>';
        const albumId = album.id;
        const albumSource = 'global';
        const deleteType = 'global-album';
        const albumPath = '';
        
        return `
            <tr data-id="${albumId}" data-source="${albumSource}" data-path="${albumPath}">
                <td>
                    <div class="song-info">
                        <img src="${coverUrl}" alt="${escapeHtml(title)}" class="song-cover" data-artwork-id="${artworkId}" data-artwork-kind="${artworkKind}" onerror="this.src='img/music.svg'">
                        <div class="song-details">
                            <h4>${escapeHtml(title)}</h4>
                            <p>${escapeHtml(artist)}</p>
                        </div>
                    </div>
                </td>
                <td>${songCount} song${songCount !== 1 ? 's' : ''} ${sourceTag}</td>
                <td>${date}</td>
                <td>
                    <div class="action-btns">
                        <button class="action-btn" data-action="edit-album" data-id="${escapeHtml(albumId)}" title="Edit">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="action-btn delete" data-action="delete" data-type="${escapeHtml(deleteType)}" data-id="${escapeHtml(albumId)}" data-name="${escapeHtml(title)}" title="Delete">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function updateAlbumDropdown() {
    const select = document.getElementById('songAlbum');
    select.innerHTML = '<option value="">No album</option>' + 
        allAlbums.map(album => {
            const value = album.id;
            return `<option value="${value}">${escapeHtml(album.title)}</option>`;
        }).join('');
}

// ============================================
// SONG CRUD OPERATIONS
// ============================================
let editingSongId = null;

function openSongModal(edit = false) {
    const modal = document.getElementById('songModal');
    const title = document.getElementById('songModalTitle');
    
    if (!edit) {
        editingSongId = null;
        title.textContent = 'Add New Song';
        document.getElementById('songForm').reset();
    }
    
    modal.classList.add('active');
}

function closeSongModal() {
    document.getElementById('songModal').classList.remove('active');
    editingSongId = null;
    
    // Reset file upload state
    selectedSongFile = null;
    const songDropZone = document.getElementById('songDropZone');
    const songFilePreview = document.getElementById('songFilePreview');
    const songFileInput = document.getElementById('songFileInput');
    
    if (songDropZone) songDropZone.style.display = '';
    if (songFilePreview) songFilePreview.classList.add('hidden');
    if (songFileInput) songFileInput.value = '';
    
    // Reset toggle to upload mode
    const songUploadToggle = document.getElementById('songUploadToggle');
    const songUrlToggle = document.getElementById('songUrlToggle');
    const songUploadArea = document.getElementById('songUploadArea');
    const songUrlArea = document.getElementById('songUrlArea');
    
    if (songUploadToggle) songUploadToggle.classList.add('active');
    if (songUrlToggle) songUrlToggle.classList.remove('active');
    if (songUploadArea) songUploadArea.classList.remove('hidden');
    if (songUrlArea) songUrlArea.classList.add('hidden');
}

async function editSong(id) {
    const song = allSongs.find(s => String(s.id) === String(id));
    if (!song) {
        console.error('Song not found:', id);
        return;
    }

    // Store both id and source for saving
    editingSongId = { id: song.id, source: song.source, originalData: song };

    document.getElementById('songModalTitle').textContent = 'Edit Song';
    document.getElementById('songTitle').value = song.title || '';
    document.getElementById('songArtist').value = song.artist || '';
    document.getElementById('songAlbum').value = song.albumId || '';
    document.getElementById('songCover').value = '';
    document.getElementById('songAudio').value = '';
    document.getElementById('songDuration').value = song.duration || '';

    openSongModal(true);
}

/** Refresh the local music index. Administrator only, server-verified. */
async function rescanLibrary() {
    // Carries the Supabase access token: the server verifies admin rights.
    const response = await window.spotifieAuth.authorizedFetch('/api/library/rescan', { method: 'POST' });
    if (!response.ok) throw new Error('Rescan failed with status ' + response.status);
    return response.json();
}

/**
 * Publish or update a global track.
 *
 * Order matters: the new file is uploaded first, the row is written second,
 * and the file it replaces is removed last. A failure at any step leaves the
 * previously working track intact, and an upload with no row is cleaned up.
 */
async function saveSong(e) {
    e.preventDefault();

    const saveBtn = document.getElementById('saveSongBtn');
    const title = document.getElementById('songTitle').value.trim();
    const artist = document.getElementById('songArtist').value.trim();
    const albumId = document.getElementById('songAlbum').value || null;
    const durationValue = Number(document.getElementById('songDuration').value);

    if (!title) {
        showToast('A song title is required', 'error');
        return;
    }

    const isEdit = Boolean(editingSongId);
    if (!isEdit && !selectedSongFile) {
        showToast('Choose an audio file to upload', 'error');
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    let uploadedAudioPath = null;
    let uploadedArtworkPath = null;

    try {
        if (selectedSongFile) {
            uploadedAudioPath = await uploadAudio(selectedSongFile);
        }
        if (selectedAlbumCoverFile && !isEdit) {
            uploadedArtworkPath = await uploadArtwork(selectedAlbumCoverFile);
        }

        const duration = Number.isFinite(durationValue) && durationValue > 0
            ? durationValue
            : (selectedSongFile ? await getAudioDuration(selectedSongFile) : null);

        if (isEdit) {
            const patch = {
                title: title,
                artist: artist || null,
                albumId: albumId,
                duration: duration || undefined
            };
            if (uploadedAudioPath) {
                patch.audioPath = uploadedAudioPath;
                patch.mimeType = selectedSongFile.type || null;
            }
            if (uploadedArtworkPath) patch.artworkPath = uploadedArtworkPath;

            await catalogClient().updateGlobalTrack(editingSongId.id, patch);

            // Only now is the replaced file safe to remove.
            if (uploadedAudioPath) {
                const previous = editingSongId.originalData;
                if (previous && previous.metadata && previous.metadata.audioPath) {
                    await removeFromBucket(AUDIO_BUCKET, previous.metadata.audioPath);
                }
            }
            showToast('Song updated');
        } else {
            await catalogClient().createGlobalTrack({
                title: title,
                artist: artist || null,
                albumId: albumId,
                duration: duration,
                mimeType: selectedSongFile ? selectedSongFile.type : null,
                audioPath: uploadedAudioPath,
                artworkPath: uploadedArtworkPath
            });
            showToast('Song published to the global catalogue');
        }

        forgetCachedCatalogue();
        closeSongModal();
        await loadDashboardData();
    } catch (err) {
        console.error('Save song failed:', err);

        // The row was never written, so the uploads would be orphans.
        await removeFromBucket(AUDIO_BUCKET, uploadedAudioPath);
        await removeFromBucket(ARTWORK_BUCKET, uploadedArtworkPath);

        showToast(err.status === 403 ? 'Administrator access required' : (err.message || 'Could not save the song'), 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Song';
    }
}

// ============================================
// ALBUM CRUD OPERATIONS
// ============================================
let editingAlbumId = null;

function openAlbumModal(edit = false) {
    const modal = document.getElementById('albumModal');
    const title = document.getElementById('albumModalTitle');
    
    if (!edit) {
        editingAlbumId = null;
        title.textContent = 'Add New Album';
        document.getElementById('albumForm').reset();
    }
    
    modal.classList.add('active');
}

function closeAlbumModal() {
    document.getElementById('albumModal').classList.remove('active');
    editingAlbumId = null;

    // Reset file upload state
    selectedAlbumCoverFile = null;
    albumCoverRemoved = false;
    const albumCoverPreviewContainer = document.getElementById('albumCoverPreviewContainer');
    const albumCoverDropContent = document.getElementById('albumCoverDropContent');
    const albumCoverPreviewImg = document.getElementById('albumCoverPreviewImg');
    const albumCoverFileInput = document.getElementById('albumCoverFileInput');
    const albumCoverHint = document.getElementById('albumCoverHint');

    if (albumCoverPreviewContainer) albumCoverPreviewContainer.classList.add('hidden');
    if (albumCoverDropContent) albumCoverDropContent.classList.remove('hidden');
    if (albumCoverPreviewImg) {
        if (albumCoverPreviewImg.dataset.objectUrl) {
            URL.revokeObjectURL(albumCoverPreviewImg.dataset.objectUrl);
            delete albumCoverPreviewImg.dataset.objectUrl;
        }
        // Reset to the placeholder rather than an empty src, which browsers
        // render as a broken-image icon.
        albumCoverPreviewImg.src = DEFAULT_COVER;
        delete albumCoverPreviewImg.dataset.existing;
    }
    if (albumCoverFileInput) albumCoverFileInput.value = '';
    if (albumCoverHint) albumCoverHint.textContent = 'Upload an image, or leave this as it is to keep the current cover.';
}

/**
 * Show an album's current cover in the edit modal.
 *
 * The image comes from the same resolver the player and the dashboard lists
 * use, so it is a signed URL created on demand - the database keeps only the
 * Storage path. Leaving the modal without choosing a file keeps that path.
 */
async function showExistingAlbumCover(album) {
    const previewContainer = document.getElementById('albumCoverPreviewContainer');
    const previewImg = document.getElementById('albumCoverPreviewImg');
    const dropContent = document.getElementById('albumCoverDropContent');
    const hint = document.getElementById('albumCoverHint');
    const client = catalogClient();

    if (!previewContainer || !previewImg || !client) return;

    const hasArtwork = Boolean(album.metadata && album.metadata.hasArtwork);
    if (!hasArtwork) {
        // No cover yet: the drop zone stays, and the default cover is what
        // listeners see until one is uploaded.
        if (hint) hint.textContent = 'This album has no cover yet. Upload one to replace the default.';
        return;
    }

    // Show the placeholder straight away, then swap in the real cover: the
    // box is never empty and never shows a broken-image icon.
    previewImg.onerror = () => {
        previewImg.onerror = null;
        previewImg.src = DEFAULT_COVER;
    };
    previewImg.src = DEFAULT_COVER;
    previewImg.dataset.existing = 'true';
    previewContainer.classList.remove('hidden');
    if (dropContent) dropContent.classList.add('hidden');
    if (hint) hint.textContent = 'Current cover. Choose a file to replace it, or save to keep it.';

    try {
        // Always ask for a fresh URL: a signature cached from an earlier open
        // may have expired by now.
        if (typeof client.forgetMedia === 'function') client.forgetMedia(album.id);
        const url = await client.resolveArtworkUrl(album.id, { kind: 'album', fallback: DEFAULT_COVER });
        if (url) previewImg.src = url;
    } catch (e) {
        console.warn('Could not load the current cover:', e);
    }
}

async function editAlbum(id) {
    const album = allAlbums.find(a => String(a.id) === String(id));
    if (!album) {
        console.error('Album not found:', id);
        return;
    }

    editingAlbumId = { id: album.id, source: album.source, originalData: album };

    // Each field comes from its own property. The description is the album's
    // own text: an album without one shows an empty box, never the artist name.
    document.getElementById('albumModalTitle').textContent = 'Edit Album';
    document.getElementById('albumTitle').value = album.title || '';
    document.getElementById('albumArtist').value = album.artist || album.albumArtist || '';
    document.getElementById('albumDescription').value = album.description == null ? '' : album.description;

    // Nothing is selected for upload and nothing is marked for removal:
    // saving keeps the stored artwork exactly as it is.
    selectedAlbumCoverFile = null;
    albumCoverRemoved = false;
    const fileInput = document.getElementById('albumCoverFileInput');
    if (fileInput) fileInput.value = '';

    openAlbumModal(true);
    await showExistingAlbumCover(album);
}

/**
 * Create or update a global album.
 * Artwork is uploaded before the row is written, and the replaced cover is
 * only removed once the new one is safely referenced.
 */
async function saveAlbum(e) {
    e.preventDefault();

    const saveBtn = document.getElementById('saveAlbumBtn');
    const title = document.getElementById('albumTitle').value.trim();
    const artist = document.getElementById('albumArtist').value.trim();
    const descriptionField = document.getElementById('albumDescription');
    const description = descriptionField ? descriptionField.value.trim() : '';

    if (!title) {
        showToast('An album title is required', 'error');
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    let uploadedArtworkPath = null;

    try {
        if (selectedAlbumCoverFile) {
            uploadedArtworkPath = await uploadArtwork(selectedAlbumCoverFile);
        }

        if (editingAlbumId) {
            // Named fields, one per column: an empty description is a real value
            // (cleared), not a reason to reuse the artist.
            const patch = {
                title: title,
                artist: artist || null,
                albumArtist: artist || null,
                description: description
            };

            // artworkPath is sent only when something actually changed about
            // the cover: a new upload, or a deliberate removal. Editing text
            // alone leaves the stored path exactly as it is.
            if (uploadedArtworkPath) {
                patch.artworkPath = uploadedArtworkPath;
            } else if (albumCoverRemoved) {
                patch.artworkPath = null;
            }

            const saved = await catalogClient().updateGlobalAlbum(editingAlbumId.id, patch);
            showToast(saved && saved.warning ? saved.warning : 'Album updated', saved && saved.warning ? 'error' : 'success');
        } else {
            const created = await catalogClient().createGlobalAlbum({
                title: title,
                artist: artist || null,
                albumArtist: artist || null,
                description: description || null,
                artworkPath: uploadedArtworkPath
            });
            showToast(
                created && created.warning ? created.warning : 'Album published to the global catalogue',
                created && created.warning ? 'error' : 'success'
            );
        }

        forgetCachedCatalogue();
        closeAlbumModal();
        await loadDashboardData();
    } catch (err) {
        console.error('Save album failed:', err);

        // Only the file uploaded during this failed save is cleaned up. The
        // cover already on the album is never touched.
        await removeFromBucket(ARTWORK_BUCKET, uploadedArtworkPath);
        showToast('Could not save the album: ' + (err.message || 'unknown error'), 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Album';
    }
}

// ============================================
// DELETE OPERATIONS
// ============================================
// This dashboard deletes GLOBAL catalogue content permanently, for everyone.
// It is a different action from a listener removing something from their own
// view, which only hides it for that account and never touches Supabase.

let deleteTarget = { type: null, id: null, name: '' };

/**
 * Wire the row buttons once, for every table.
 *
 * A title is written by whoever published the song, and it used to travel to
 * these handlers inside an onclick attribute - as part of a JavaScript string
 * inside an HTML attribute, where a quote in the title ends the string and
 * whatever follows is code. Carried in a data- attribute instead it is only
 * ever a value: the browser hands it back as text and it never gets parsed.
 */
function initRowActions() {
    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;

        const action = button.dataset.action;
        if (action === 'edit-song') {
            editSong(button.dataset.id);
        } else if (action === 'edit-album') {
            editAlbum(button.dataset.id);
        } else if (action === 'delete') {
            confirmDelete(button.dataset.type, button.dataset.id, button.dataset.name || '');
        }
    });
}

// ============================================
// Several tracks at once
//
// Publishing is careful work and undoing it is not possible, so nothing here
// is a single click. Selecting is deliberate, the count is always visible, and
// the destructive action asks first and says plainly what it will do and to
// how many.
// ============================================

const bulkSelection = new Set();

function initBulkActions() {
    const table = document.getElementById('allSongsTable');
    if (!table) return;

    table.addEventListener('change', (event) => {
        const box = event.target.closest('.row-select');
        if (!box) return;

        if (box.checked) bulkSelection.add(box.dataset.id);
        else bulkSelection.delete(box.dataset.id);

        renderBulkBar();
    });

    document.getElementById('songsSelectHeader')?.addEventListener('change', (event) => {
        const boxes = Array.from(table.querySelectorAll('.row-select'));
        boxes.forEach((box) => {
            box.checked = event.target.checked;
            if (event.target.checked) bulkSelection.add(box.dataset.id);
            else bulkSelection.delete(box.dataset.id);
        });
        renderBulkBar();
    });

    document.getElementById('songsSelectAll')?.addEventListener('click', () => {
        const header = document.getElementById('songsSelectHeader');
        if (header) {
            header.checked = !header.checked;
            header.dispatchEvent(new Event('change'));
        }
    });

    document.getElementById('songsBulkDelete')?.addEventListener('click', bulkDeleteSelected);
    document.getElementById('songsMoveToAlbum')?.addEventListener('click', bulkMoveSelected);
}

function renderBulkBar() {
    const bar = document.getElementById('songsBulkBar');
    const count = document.getElementById('songsSelectionCount');

    if (count) count.textContent = bulkSelection.size + ' selected';
    if (bar) bar.classList.toggle('hidden', bulkSelection.size === 0);

    // The albums a selection could be moved into, kept current with what is
    // actually published.
    const target = document.getElementById('songsAlbumTarget');
    if (!target) return;

    const chosen = target.value;
    target.replaceChildren(
        ...allAlbums.map((album) => {
            const option = document.createElement('option');
            option.value = album.id;
            // Set as text: an album is called whatever it was published as.
            option.textContent = album.title;
            return option;
        })
    );
    if (chosen) target.value = chosen;
}

/**
 * Ask, in the dashboard's own dialog.
 *
 * The browser's confirm() stops the page, cannot be styled and looks like
 * nothing else here. This reuses the delete dialog that is already on the
 * page, so a destructive question always looks like the destructive questions
 * an administrator already knows.
 */
function askToConfirm(message) {
    const modal = document.getElementById('deleteModal');
    const text = document.getElementById('deleteMessage');
    const confirm = document.getElementById('confirmDeleteBtn');
    const cancel = document.getElementById('cancelDeleteBtn');
    const close = document.getElementById('closeDeleteModal');

    if (!modal || !confirm) return Promise.resolve(false);

    if (text) text.textContent = message;
    modal.classList.add('active');

    return new Promise((resolve) => {
        const finish = (answer) => {
            modal.classList.remove('active');
            confirm.removeEventListener('click', onYes);
            cancel?.removeEventListener('click', onNo);
            close?.removeEventListener('click', onNo);
            resolve(answer);
        };

        const onYes = (event) => {
            // This dialog is shared with the single-item delete, so its own
            // handler must not also fire for a question it did not ask.
            event.stopImmediatePropagation();
            finish(true);
        };
        const onNo = () => finish(false);

        // Added first, so it runs before the handler the dashboard wired at
        // startup and can stop it.
        confirm.addEventListener('click', onYes, { capture: true });
        cancel?.addEventListener('click', onNo);
        close?.addEventListener('click', onNo);
    });
}

/**
 * Delete several published tracks.
 *
 * Asked once, with the number and the consequence written out: this removes
 * them for everybody, everywhere, and cannot be undone. Each deletion is the
 * ordinary single-track path - the same server check, the same Row Level
 * Security, the same removal of the stored file - so a bulk action is a
 * sequence of careful acts rather than a shortcut past them.
 */
async function bulkDeleteSelected() {
    const chosen = Array.from(bulkSelection);
    if (!chosen.length) return;

    // The dashboard's own dialog, saying the number and the consequence.
    const agreed = await askToConfirm(
        'Delete ' + chosen.length + (chosen.length === 1 ? ' track' : ' tracks') +
            ' from the global catalogue? Every listener loses access and the stored audio is removed. This cannot be undone.'
    );
    if (!agreed) return;

    const button = document.getElementById('songsBulkDelete');
    if (button) {
        button.disabled = true;
        button.textContent = 'Deleting…';
    }

    let deleted = 0;
    const failed = [];

    for (const id of chosen) {
        try {
            await catalogClient().deleteGlobalTrack(id);
            deleted += 1;
        } catch (err) {
            failed.push(id);
        }
    }

    bulkSelection.clear();
    renderBulkBar();

    // The copy every browser keeps is dropped, so the next library render is
    // given what is actually published rather than what was.
    forgetCachedCatalogue();
    await loadDashboardData();

    showToast(
        failed.length
            ? deleted + ' deleted, ' + failed.length + ' could not be'
            : deleted + (deleted === 1 ? ' track deleted' : ' tracks deleted'),
        failed.length ? 'error' : 'success'
    );
}

/** Put several tracks into one album. Metadata only: no audio is touched. */
async function bulkMoveSelected() {
    const chosen = Array.from(bulkSelection);
    if (!chosen.length) return;

    const target = document.getElementById('songsAlbumTarget');
    const albumId = target ? target.value : '';
    const album = allAlbums.find((entry) => entry.id === albumId);

    if (!album) {
        showToast('Choose an album to move them to', 'error');
        return;
    }

    let moved = 0;
    for (const id of chosen) {
        try {
            await catalogClient().updateGlobalTrack(id, { albumId: album.id });
            moved += 1;
        } catch (err) {
            /* the rest still move */
        }
    }

    bulkSelection.clear();
    renderBulkBar();

    forgetCachedCatalogue();
    await loadDashboardData();

    showToast(moved + (moved === 1 ? ' track moved' : ' tracks moved'));
}

// ============================================
// What is wrong with the catalogue, if anything
// ============================================

function initMaintenance() {
    document.getElementById('runAuditBtn')?.addEventListener('click', runMaintenanceAudit);
}

/**
 * Ask the server to compare the catalogue against storage.
 *
 * Reports and changes nothing. Findings come in two strengths and are shown as
 * such: a row naming a file that is not in the bucket is a fact, while a file
 * no row names is a candidate - the row naming it may be being written as the
 * audit runs.
 */
async function runMaintenanceAudit() {
    const button = document.getElementById('runAuditBtn');
    const summary = document.getElementById('maintenanceSummary');
    const report = document.getElementById('maintenanceReport');
    if (!report) return;

    if (button) {
        button.disabled = true;
        button.textContent = 'Checking…';
    }
    report.textContent = 'Checking the catalogue against storage…';

    try {
        const audit = await catalogClient()._request('/api/catalog/admin/maintenance');

        if (!audit.available) {
            report.textContent = 'The catalogue could not be read: ' + (audit.error || 'unknown reason');
            return;
        }

        renderMaintenanceSummary(summary, audit);
        renderMaintenanceFindings(report, audit);
    } catch (err) {
        report.textContent = 'Could not run the audit: ' + err.message;
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = 'Run audit';
        }
    }
}

function renderMaintenanceSummary(target, audit) {
    if (!target) return;

    const tiles = [
        { value: audit.counts.albums, label: 'albums' },
        { value: audit.counts.tracks, label: 'tracks' },
        { value: audit.missingAudio.total, label: 'tracks with no audio' },
        { value: audit.orphanedAudio.total + audit.orphanedArtwork.total, label: 'files nothing points at' }
    ];

    target.replaceChildren(
        ...tiles.map((tile) => {
            const card = document.createElement('div');
            card.className = 'stat-card';

            const value = document.createElement('div');
            value.className = 'stat-value';
            value.textContent = String(tile.value);

            const label = document.createElement('div');
            label.className = 'stat-label';
            label.textContent = tile.label;

            card.append(value, label);
            return card;
        })
    );
}

function renderMaintenanceFindings(target, audit) {
    const groups = [
        { title: 'Tracks whose audio is not in storage', finding: audit.missingAudio, certain: true },
        { title: 'Artwork that is not in storage', finding: audit.missingArtwork, certain: true },
        { title: 'Tracks whose album no longer exists', finding: audit.orphanedTracks, certain: true },
        { title: 'Audio files nothing points at', finding: audit.orphanedAudio, certain: false },
        { title: 'Artwork files nothing points at', finding: audit.orphanedArtwork, certain: false },
        { title: 'Tracks sharing one stored file', finding: audit.duplicates.sameFile, certain: true },
        { title: 'Tracks that look like the same recording', finding: audit.duplicates.sameName, certain: false }
    ];

    const found = groups.filter((group) => group.finding.total > 0);

    if (!found.length) {
        target.textContent = 'Nothing wrong was found. Checked ' + new Date(audit.checkedAt).toLocaleString() + '.';
        return;
    }

    target.replaceChildren(
        ...found.map((group) => {
            const section = document.createElement('section');
            section.className = 'maintenance-group';

            const heading = document.createElement('h3');
            heading.textContent = group.title + ' (' + group.finding.total + ')';

            const note = document.createElement('p');
            note.className = 'maintenance-note';
            note.textContent = group.certain
                ? 'These are certain. Nothing has been changed.'
                : 'These may be uploads still in progress. Nothing has been changed, and nothing should be removed without checking.';

            const list = document.createElement('ul');
            list.className = 'maintenance-list';

            group.finding.items.forEach((item) => {
                const row = document.createElement('li');
                // Set as text: a title comes from whatever somebody published.
                row.textContent = item.title
                    ? item.title + (item.artist ? ' — ' + item.artist : '') + (item.reason ? ' (' + item.reason + ')' : '')
                    : item.objectPath || String(item.trackIds || '');
                list.appendChild(row);
            });

            section.append(heading, note, list);
            return section;
        })
    );
}

function confirmDelete(type, id, name) {
    deleteTarget = { type, id, name };

    document.getElementById('deleteMessage').textContent =
        `Permanently delete "${name}" from the global catalogue? Every listener loses access, and the stored file is removed. This cannot be undone.`;
    document.getElementById('deleteModal').classList.add('active');
}

function closeDeleteModal() {
    document.getElementById('deleteModal').classList.remove('active');
    deleteTarget = { type: null, id: null, name: '' };
}

async function performDelete() {
    if (!deleteTarget.type || !deleteTarget.id) return;

    const confirmBtn = document.getElementById('confirmDeleteBtn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting...';

    try {
        if (deleteTarget.type === 'global-album') {
            await catalogClient().deleteGlobalAlbum(deleteTarget.id);
            showToast('Album deleted from the global catalogue');
        } else {
            await catalogClient().deleteGlobalTrack(deleteTarget.id);
            showToast('Track deleted from the global catalogue');
        }

        forgetCachedCatalogue();
        closeDeleteModal();
        await loadDashboardData();
    } catch (err) {
        console.error('Delete failed:', err);
        showToast(err.status === 403 ? 'Administrator access required' : 'Could not delete this item', 'error');
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete';
    }
}

// ============================================
// RESPONSIVE NAVIGATION
// ============================================
// Desktop keeps the fixed sidebar. On tablet and phone it becomes an
// off-canvas drawer: the hamburger opens it, and the close button, the
// backdrop, Escape or choosing a section closes it again.

const SIDEBAR_BREAKPOINT = 1024;

function isCompactLayout() {
    return window.matchMedia('(max-width: ' + SIDEBAR_BREAKPOINT + 'px)').matches;
}

function isSidebarOpen() {
    const sidebar = document.getElementById('adminSidebar');
    return Boolean(sidebar && sidebar.classList.contains('open'));
}

function setSidebarOpen(open) {
    const sidebar = document.getElementById('adminSidebar');
    const toggle = document.getElementById('adminMenuToggle');
    const backdrop = document.getElementById('adminSidebarBackdrop');
    if (!sidebar) return;

    sidebar.classList.toggle('open', open);
    if (backdrop) {
        backdrop.classList.toggle('visible', open);
        backdrop.hidden = !open;
    }
    if (toggle) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    }

    // The page behind the drawer must not scroll while it is open.
    document.body.classList.toggle('sidebar-open', open);

    if (open) {
        const firstItem = sidebar.querySelector('.nav-item');
        if (firstItem) firstItem.focus();
    } else if (toggle && isCompactLayout()) {
        toggle.focus();
    }
}

function initResponsiveNavigation() {
    const toggle = document.getElementById('adminMenuToggle');
    const closeBtn = document.getElementById('adminSidebarClose');
    const backdrop = document.getElementById('adminSidebarBackdrop');

    if (toggle) {
        toggle.addEventListener('click', () => setSidebarOpen(!isSidebarOpen()));
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', () => setSidebarOpen(false));
    }
    if (backdrop) {
        backdrop.addEventListener('click', () => setSidebarOpen(false));
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isSidebarOpen()) {
            setSidebarOpen(false);
        }
    });

    // Back on a wide screen the sidebar is permanent again, so any drawer
    // state is cleared.
    window.addEventListener('resize', () => {
        if (!isCompactLayout() && isSidebarOpen()) {
            setSidebarOpen(false);
        }
    });

    setSidebarOpen(false);
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
/**
 * Text, made safe to put inside markup.
 *
 * The quotes matter as much as the angle brackets. Almost every use of this is
 * inside an attribute - a title, an alt, a data- value - and a song called
 * `" onerror="alert(1)` closes that attribute and starts a new one unless the
 * quote is escaped too. An element's textContent does not escape quotes,
 * because it does not have to; a string being pasted into HTML does.
 */
function escapeHtml(text) {
    if (text === undefined || text === null || text === '') return '';

    return String(text)
        .split('&')
        .join('&amp;')
        .split('<')
        .join('&lt;')
        .split('>')
        .join('&gt;')
        .split('"')
        .join('&quot;')
        .split("'")
        .join('&#39;');
}

function formatDuration(seconds) {
    if (!seconds) return '-';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    
    toastMessage.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// ============================================
// FILE UPLOAD HANDLING
// ============================================
let selectedSongFile = null;
let selectedAlbumCoverFile = null;

function initFileUploadHandlers() {
    // Song audio source toggle
    const songUploadToggle = document.getElementById('songUploadToggle');
    const songUrlToggle = document.getElementById('songUrlToggle');
    const songUploadArea = document.getElementById('songUploadArea');
    const songUrlArea = document.getElementById('songUrlArea');

    if (songUploadToggle && songUrlToggle) {
        songUploadToggle.addEventListener('click', () => {
            songUploadToggle.classList.add('active');
            songUrlToggle.classList.remove('active');
            songUploadArea.classList.remove('hidden');
            songUrlArea.classList.add('hidden');
        });

        songUrlToggle.addEventListener('click', () => {
            songUrlToggle.classList.add('active');
            songUploadToggle.classList.remove('active');
            songUrlArea.classList.remove('hidden');
            songUploadArea.classList.add('hidden');
        });
    }

    // Song file drag & drop
    const songDropZone = document.getElementById('songDropZone');
    const songFileInput = document.getElementById('songFileInput');
    const songFilePreview = document.getElementById('songFilePreview');
    const songFileName = document.getElementById('songFileName');
    const removeSongFile = document.getElementById('removeSongFile');

    if (songDropZone) {
        setupDropZone(songDropZone, songFileInput, (file) => {
            selectedSongFile = file;
            songFileName.textContent = file.name;
            songFilePreview.classList.remove('hidden');
            songDropZone.style.display = 'none';
            
            // Auto-fill title if empty
            const titleInput = document.getElementById('songTitle');
            if (titleInput && !titleInput.value) {
                titleInput.value = file.name.replace(/\.[^/.]+$/, '');
            }
            
            // Get audio duration
            getAudioDuration(file).then(duration => {
                const durationInput = document.getElementById('songDuration');
                if (durationInput) {
                    durationInput.value = Math.round(duration);
                }
            });
        }, 'audio/*');

        if (removeSongFile) {
            removeSongFile.addEventListener('click', () => {
                selectedSongFile = null;
                songFilePreview.classList.add('hidden');
                songDropZone.style.display = '';
                songFileInput.value = '';
            });
        }
    }

    // Album cover drag & drop
    const albumCoverDropZone = document.getElementById('albumCoverDropZone');
    const albumCoverFileInput = document.getElementById('albumCoverFileInput');
    const albumCoverPreviewContainer = document.getElementById('albumCoverPreviewContainer');
    const albumCoverPreviewImg = document.getElementById('albumCoverPreviewImg');
    const albumCoverDropContent = document.getElementById('albumCoverDropContent');
    const removeAlbumCover = document.getElementById('removeAlbumCover');

    if (albumCoverDropZone) {
        setupDropZone(albumCoverDropZone, albumCoverFileInput, (file) => {
            selectedAlbumCoverFile = file;
            // Choosing a file is a replacement, not a removal.
            albumCoverRemoved = false;

            // Preview from an object URL: the image is never encoded as
            // Base64, and the original file is what gets uploaded.
            if (albumCoverPreviewImg.dataset.objectUrl) {
                URL.revokeObjectURL(albumCoverPreviewImg.dataset.objectUrl);
            }
            const previewUrl = URL.createObjectURL(file);
            albumCoverPreviewImg.dataset.objectUrl = previewUrl;
            albumCoverPreviewImg.src = previewUrl;
            delete albumCoverPreviewImg.dataset.existing;
            albumCoverPreviewContainer.classList.remove('hidden');
            albumCoverDropContent.classList.add('hidden');

            const hint = document.getElementById('albumCoverHint');
            if (hint) hint.textContent = 'This image replaces the current cover when you save.';
        }, 'image/*');

        if (removeAlbumCover) {
            removeAlbumCover.addEventListener('click', async () => {
                const hint = document.getElementById('albumCoverHint');
                const showingExisting = albumCoverPreviewImg.dataset.existing === 'true';

                if (albumCoverPreviewImg.dataset.objectUrl) {
                    URL.revokeObjectURL(albumCoverPreviewImg.dataset.objectUrl);
                    delete albumCoverPreviewImg.dataset.objectUrl;
                }
                albumCoverFileInput.value = '';

                if (!showingExisting && selectedAlbumCoverFile && editingAlbumId) {
                    // Cancelling a replacement: the album's saved cover comes
                    // back into view, and nothing is removed.
                    selectedAlbumCoverFile = null;
                    albumCoverRemoved = false;
                    await showExistingAlbumCover(editingAlbumId.originalData);
                    return;
                }

                selectedAlbumCoverFile = null;
                albumCoverPreviewContainer.classList.add('hidden');
                albumCoverDropContent.classList.remove('hidden');
                albumCoverPreviewImg.src = DEFAULT_COVER;
                delete albumCoverPreviewImg.dataset.existing;

                if (showingExisting) {
                    // Removing the saved cover: recorded now, applied when the
                    // album is saved, and only then is the file deleted.
                    albumCoverRemoved = true;
                    if (hint) hint.textContent = 'The cover will be removed when you save. Upload an image instead to replace it.';
                } else {
                    albumCoverRemoved = false;
                    if (hint) hint.textContent = 'Upload an image, or leave this as it is to keep the current cover.';
                }
            });
        }
    }
}

function setupDropZone(dropZone, fileInput, onFileSelected, acceptType) {
    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // Highlight on drag
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('dragover');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('dragover');
        });
    });

    // Handle drop
    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            if (validateFileType(file, acceptType)) {
                onFileSelected(file);
            } else {
                showToast('Invalid file type', 'error');
            }
        }
    });

    // Handle file input change
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                onFileSelected(e.target.files[0]);
            }
        });
    }
}

function validateFileType(file, acceptType) {
    if (acceptType === 'audio/*') {
        return file.type.startsWith('audio/');
    } else if (acceptType === 'image/*') {
        return file.type.startsWith('image/');
    }
    return true;
}

function getAudioDuration(file) {
    return new Promise((resolve) => {
        const audio = new Audio();
        audio.addEventListener('loadedmetadata', () => {
            resolve(audio.duration);
        });
        audio.addEventListener('error', () => {
            resolve(0);
        });
        audio.src = URL.createObjectURL(file);
    });
}

// ============================================
// EVENT LISTENERS
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initAdminDashboard();
    initRowActions();
    initBulkActions();
    initMaintenance();

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const section = item.dataset.section;
            
            // Update nav active state
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            
            // Show corresponding section
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            document.getElementById(`${section}Section`).classList.add('active');

            // On a small screen the drawer closes once a section is chosen.
            if (isCompactLayout()) setSidebarOpen(false);
        });
    });

    // Logout
    document.getElementById('adminLogout').addEventListener('click', async () => {
        await window.spotifieAuth.signOut();
        window.location.href = 'admin-login.html';
    });

    // Song Modal
    document.getElementById('addSongBtn').addEventListener('click', () => openSongModal());
    document.getElementById('closeSongModal').addEventListener('click', closeSongModal);
    document.getElementById('cancelSongBtn').addEventListener('click', closeSongModal);
    document.getElementById('songForm').addEventListener('submit', saveSong);
    document.querySelector('#songModal .modal-overlay').addEventListener('click', closeSongModal);

    // Album Modal
    document.getElementById('addAlbumBtn').addEventListener('click', () => openAlbumModal());
    document.getElementById('closeAlbumModal').addEventListener('click', closeAlbumModal);
    document.getElementById('cancelAlbumBtn').addEventListener('click', closeAlbumModal);
    document.getElementById('albumForm').addEventListener('submit', saveAlbum);
    document.querySelector('#albumModal .modal-overlay').addEventListener('click', closeAlbumModal);

    // Delete Modal
    document.getElementById('closeDeleteModal').addEventListener('click', closeDeleteModal);
    document.getElementById('cancelDeleteBtn').addEventListener('click', closeDeleteModal);
    document.getElementById('confirmDeleteBtn').addEventListener('click', performDelete);
    document.querySelector('#deleteModal .modal-overlay').addEventListener('click', closeDeleteModal);

    // Search
    document.getElementById('searchSongs').addEventListener('input', (e) => {
        renderAllSongs(e.target.value);
        resolveArtworkThumbnails();
    });

    document.getElementById('searchAlbums').addEventListener('input', (e) => {
        renderAllAlbums(e.target.value);
        resolveArtworkThumbnails();
    });

    // Escape key to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeSongModal();
            closeAlbumModal();
            closeDeleteModal();
        }
    });

    // Initialize file upload handlers
    initFileUploadHandlers();

    // Responsive sidebar drawer
    initResponsiveNavigation();
});

// Prevent direct access via URL manipulation
window.addEventListener('beforeunload', () => {
    // Session persists until browser closes (sessionStorage)
});
