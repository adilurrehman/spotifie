console.log('Starting The JS');

// ==================== Theme Toggle System ====================
function initializeTheme() {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) return;

    // Dark is what Spotifie looks like; the only thing that changes that is a
    // listener saying so, which is remembered here and nowhere else. The page
    // has already set this before any of it was drawn - this only agrees with
    // what is on screen and wires the switch.
    const savedTheme = localStorage.getItem('spotify_theme');
    applyTheme(savedTheme === 'light' ? 'light' : 'dark');

    themeToggle.addEventListener('click', toggleTheme);

    themeToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleTheme();
        }
    });
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    applyTheme(newTheme);
    localStorage.setItem('spotify_theme', newTheme);
}

// HTML escape function to prevent XSS attacks
/**
 * Text, made safe to put inside markup.
 *
 * The quotes matter as much as the angle brackets. Almost every use of this is
 * inside an attribute - a title, an alt, a data- value - and a song called
 * `" onerror="alert(1)` closes that attribute and starts a new one unless the
 * quote is escaped too. An element's textContent does not escape quotes,
 * because it does not have to; a string being pasted into HTML does.
 */
function escapeHTML(str) {
    if (str === undefined || str === null || str === '') return '';

    return String(str)
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

// Validate folder path to prevent path traversal
function isValidFolder(folder) {
    if (!folder || typeof folder !== 'string') return false;
    // Album keys are library album IDs or local user album keys - never file paths
    const validPrefixes = folder.startsWith('library/') || folder.startsWith('user_albums/');
    return validPrefixes && !folder.includes('..') && !folder.includes('//');
}

const pathParts = window.location.pathname.split('/').filter(part => part && !part.endsWith('.html'));
let basePath = '';
if (pathParts.length > 1 && pathParts[0] !== 'Spotify---Web-Player-Music-for-everyone') {
    basePath = '/' + pathParts[0] + '/';
}

let currentsong = new Audio();
let songs = [];
let currentFolder = '';
let currentLibButton = null;
let lastVolume = 0.5;
currentsong.volume = 0.5;

// Cache common elements - now using buttons containing images
const playBtn = document.getElementById('play');
const nextBtn = document.getElementById('next');
const prevBtn = document.getElementById('previous');
const shuffleBtn = document.getElementById('shuffle');
const repeatBtn = document.getElementById('repeat');
const expandBtn = document.getElementById('expandPlayer');
const volumeBtn = document.getElementById('volume');

// Helper to get/set image src inside button elements
function getButtonImg(btn) {
    return btn ? btn.querySelector('img') : null;
}

function setButtonImgSrc(btn, src) {
    const img = getButtonImg(btn);
    if (img) img.src = src;
}

// ==================== Playback state ====================
// The audio element is the only record of what is playing. No control keeps a
// copy of that: every one of them is drawn by syncPlaybackUI() from
// currentsong.paused and currentsong.ended, and syncPlaybackUI() runs from the
// audio events themselves. A click asks for playback; only the audio element
// says whether it happened. Local and global tracks resolve their URL in
// different ways and share this state exactly.

/** True while the current track is actually producing sound. */
function isAudioPlaying() {
    return Boolean(currentsong.src) && !currentsong.paused && !currentsong.ended;
}

/**
 * Draw one control as Play or Pause.
 *
 * A playbar button holds an <img>; a track row is an <img> itself. Both carry
 * the label the control would be read out as.
 */
function renderPlayPauseIcon(control, playing) {
    if (!control) return;

    const isImage = control.tagName === 'IMG';
    const image = isImage ? control : getButtonImg(control);
    const label = playing ? 'Pause' : 'Play';

    if (image) {
        image.src = basePath + (playing ? 'img/pause.svg' : 'img/play.svg');
        // A button carries the label itself; its image would only repeat it.
        if (isImage) image.alt = label;
    }

    if (control.setAttribute) {
        control.setAttribute('aria-label', label);
        if (control.hasAttribute && control.hasAttribute('aria-pressed')) {
            control.setAttribute('aria-pressed', playing ? 'true' : 'false');
        }
    }
}

/** Every track row back to Play; the current one is drawn after. */
function resetLibButtons() {
    document.querySelectorAll('.libPlayButton').forEach((btn) => renderPlayPauseIcon(btn, false));
}

/**
 * Every control that stands for one track: its row in the sidebar list, and
 * its row in the album detail when that is open. The same song is often on
 * screen twice, and both have to say the same thing.
 */
function controlsForTrack(encodedTrack) {
    const found = [];
    if (!encodedTrack) return found;

    const collect = (rows) => {
        rows.forEach((li) => {
            if (li.dataset && li.dataset.track === encodedTrack) {
                const button = li.querySelector('.libPlayButton');
                if (button) found.push(button);
            }
        });
    };

    collect(document.querySelectorAll('.songslist li'));
    collect(document.querySelectorAll('.album-track'));
    return found;
}

function findLibButtonByTrack(encodedTrack) {
    const found = controlsForTrack(encodedTrack);
    return found.length ? found[0] : null;
}

/**
 * The track the audio element is loaded with, or null when there is none.
 */
function getCurrentEncodedTrack() {
    if (!currentsong.src) return null;
    return window.currentPlayingTrack || null;
}

// The album card's own control, in the card's own drawing style.
const CARD_PLAY_ICON =
    '<path d="M5 20V4L19 12L5 20Z" stroke="#141B34" fill="#000" stroke-width="1.5" stroke-linejoin="round" />';
const CARD_PAUSE_ICON =
    '<path d="M6 4H9.5V20H6V4Z" stroke="#141B34" fill="#000" stroke-width="1.5" stroke-linejoin="round" />' +
    '<path d="M14.5 4H18V20H14.5V4Z" stroke="#141B34" fill="#000" stroke-width="1.5" stroke-linejoin="round" />';

/** Draw one album card's play control as Play or Pause. */
function renderCardPlayIcon(card, playing) {
    const control = card && card.querySelector ? card.querySelector('.play') : null;
    if (!control) return;

    const label = playing ? 'Pause' : 'Play';
    if (control.getAttribute && control.getAttribute('aria-label') === label) return;

    const svg = control.querySelector ? control.querySelector('svg') : null;
    if (svg) svg.innerHTML = playing ? CARD_PAUSE_ICON : CARD_PLAY_ICON;
    if (control.setAttribute) control.setAttribute('aria-label', label);
}

/** Mark the album card the current track is playing from. */
function updateNowPlayingAlbum(isPlaying) {
    document.querySelectorAll('.cardcontainer.now-playing').forEach((card) => {
        card.classList.remove('now-playing', 'paused');
    });
    document.querySelectorAll('.cardcontainer').forEach((card) => renderCardPlayIcon(card, false));

    if (!currentsong.src) return;

    // Use the album the song is being played FROM (not the song's original source)
    const playingFolder = window.currentPlayingAlbum || currentFolder;
    if (!playingFolder) return;

    const playingCard = document.querySelector(`.cardcontainer[data-folder="${playingFolder}"]`);
    if (playingCard) {
        playingCard.classList.add('now-playing');
        if (!isPlaying) {
            playingCard.classList.add('paused');
        }
        renderCardPlayIcon(playingCard, isPlaying);
    }
}

/**
 * Bring every visible playback control in line with the audio element: the
 * playbar button, the row of the current track, and the album card. This is
 * the only place any of them is drawn.
 */
/**
 * Mark the album detail view: which row the player is on, and whether the
 * album's own big Play button is currently a Pause.
 */
function syncAlbumDetailUI(playing) {
    const currentTrack = getCurrentEncodedTrack();

    document.querySelectorAll('.album-track').forEach((row) => {
        const isCurrent = Boolean(currentTrack) && row.dataset && row.dataset.track === currentTrack;
        row.classList.toggle('is-current', isCurrent);
        row.classList.toggle('is-playing', isCurrent && playing);
        if (row.setAttribute) row.setAttribute('aria-current', isCurrent ? 'true' : 'false');
    });

    const albumPlay = document.querySelector('#albumDetailPlay');
    if (!albumPlay) return;

    // The button belongs to the album that is open, so it only shows Pause
    // while that album is the one being played.
    const openFolder = albumPlay.dataset ? albumPlay.dataset.folder : null;
    const playingHere = playing && Boolean(openFolder) && openFolder === (window.currentPlayingAlbum || null);
    albumPlay.setAttribute('aria-label', playingHere ? 'Pause' : 'Play');
    albumPlay.classList.toggle('is-playing', playingHere);

    const icon = albumPlay.querySelector('svg');
    if (icon) {
        icon.innerHTML = playingHere
            ? '<path d="M6 4H9.5V20H6V4Z" fill="currentColor"/><path d="M14.5 4H18V20H14.5V4Z" fill="currentColor"/>'
            : '<path d="M5 20V4L19 12L5 20Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>';
    }
}

/**
 * Bring every visible playback control in line with the audio element: the
 * playbar button, the Now Playing button, every row showing the current track,
 * the album card and the album detail. This is the only place any of them is
 * drawn.
 */
function syncPlaybackUI() {
    const playing = isAudioPlaying();

    renderPlayPauseIcon(playBtn, playing);
    // The Now Playing view carries the same button; it is the same audio.
    document.querySelectorAll('[data-player-play]').forEach((control) => renderPlayPauseIcon(control, playing));

    resetLibButtons();
    // The list is rebuilt whenever an album is opened, so the rows on screen
    // win over the one this player started with: an old row that is no longer
    // in the page cannot be shown to anybody.
    const rowButtons = controlsForTrack(getCurrentEncodedTrack());
    if (rowButtons.length) {
        currentLibButton = rowButtons[0];
        rowButtons.forEach((button) => renderPlayPauseIcon(button, playing));
    } else if (currentLibButton) {
        renderPlayPauseIcon(currentLibButton, playing);
    }

    updateNowPlayingAlbum(playing);
    syncAlbumDetailUI(playing);
}

/**
 * Start or resume playback.
 *
 * play() is a request and it can be refused, so the controls are drawn from
 * the audio element once it has settled: a refused request leaves them on
 * Play rather than showing a Pause the sound never reached.
 */
async function startAudioPlayback() {
    try {
        await currentsong.play();
    } catch (error) {
        console.error('Playback failed:', error);
    }
    syncPlaybackUI();
}

/** The one play/pause action behind the playbar, the cards and the keyboard. */
function togglePlayback() {
    if (isAudioPlaying()) {
        currentsong.pause();
        syncPlaybackUI();
        return Promise.resolve();
    }
    return startAudioPlayback();
}

/**
 * Follow the audio element itself, whatever started or stopped it.
 *
 * Buffering is deliberately absent: a track that stalls mid-play is still
 * playing, and its controls must not flicker back to Play.
 */
function bindPlaybackStateEvents() {
    ['play', 'playing', 'pause', 'ended', 'emptied', 'error'].forEach((type) => {
        currentsong.addEventListener(type, syncPlaybackUI);
    });
}

// Bound as soon as the player exists, so the very first track is already
// followed by the controls.
bindPlaybackStateEvents();


// ==================== Playback sequence ====================
// What plays next.
//
// The context is whatever list is being played - an album, Local Music, a
// collection someone made - and that list decides the order. A file name never
// does. Shuffle lays a fresh order over the same list and walks it once
// through before anything is heard twice; repeat says what happens when the
// walk runs out. Turning either on changes what comes next and nothing else:
// the track that is playing keeps playing, from where it is.

const REPEAT_MODES = ['off', 'all', 'one'];
const PLAYER_PREFS_KEY = 'spotifie_player_prefs';

// Pressing Previous a few seconds into a track means "start this again";
// pressing it straight away means "go back".
const RESTART_THRESHOLD_SECONDS = 3;

let shuffleEnabled = false;
let repeatMode = 'off';

// The shuffled walk over the current context, and how far along it is.
let shuffleOrder = [];
let shuffleCursor = -1;

// What was actually played, oldest first. Previous follows this rather than
// guessing backwards through the list.
let playbackHistory = [];
const MAX_HISTORY = 100;

/** The list being played, as ids. */
function contextTrackIds() {
    return Array.isArray(songs) ? songs.slice() : [];
}

/** A random order over the given ids, optionally starting from one of them. */
function shuffledFrom(trackIds, firstId) {
    const order = trackIds.slice();

    for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = order[i];
        order[i] = order[j];
        order[j] = swap;
    }

    // Whatever is playing stays where it is and leads the walk, so switching
    // shuffle on never interrupts the song being listened to.
    if (firstId) {
        const at = order.indexOf(firstId);
        if (at > 0) {
            order.splice(at, 1);
            order.unshift(firstId);
        }
    }

    return order;
}

function rebuildShuffleOrder(firstId) {
    shuffleOrder = shuffledFrom(contextTrackIds(), firstId || getCurrentEncodedTrack());
    shuffleCursor = shuffleOrder.length ? 0 : -1;
    return shuffleOrder;
}

/** True when the shuffled walk no longer describes the list being played. */
function shuffleOrderIsStale() {
    const ids = contextTrackIds();
    if (ids.length !== shuffleOrder.length) return true;
    for (const id of ids) {
        if (shuffleOrder.indexOf(id) === -1) return true;
    }
    return false;
}

function setShuffleEnabled(enabled) {
    shuffleEnabled = Boolean(enabled);

    if (shuffleEnabled) {
        rebuildShuffleOrder(getCurrentEncodedTrack());
    } else {
        shuffleOrder = [];
        shuffleCursor = -1;
    }

    savePlayerPreferences();
    syncSequenceUI();
    return shuffleEnabled;
}

function toggleShuffle() {
    return setShuffleEnabled(!shuffleEnabled);
}

function setRepeatMode(mode) {
    repeatMode = REPEAT_MODES.indexOf(mode) === -1 ? 'off' : mode;
    savePlayerPreferences();
    syncSequenceUI();
    return repeatMode;
}

/** off, then all, then one, then off again. */
function cycleRepeatMode() {
    const next = (REPEAT_MODES.indexOf(repeatMode) + 1) % REPEAT_MODES.length;
    return setRepeatMode(REPEAT_MODES[next]);
}

/**
 * Record that a track has started.
 *
 * Going back through history walks the list rather than growing it, so
 * pressing Previous twice reaches the track before last.
 */
function noteTrackStarted(trackId) {
    if (!trackId) return;

    const last = playbackHistory[playbackHistory.length - 1];
    const beforeLast = playbackHistory[playbackHistory.length - 2];

    if (trackId === last) return;

    if (trackId === beforeLast) {
        playbackHistory.pop();
    } else {
        playbackHistory.push(trackId);
        if (playbackHistory.length > MAX_HISTORY) playbackHistory.shift();
    }

    if (shuffleEnabled) {
        if (shuffleOrderIsStale()) {
            rebuildShuffleOrder(trackId);
        } else {
            const at = shuffleOrder.indexOf(trackId);
            if (at !== -1) shuffleCursor = at;
        }
    }
}

/**
 * The track after this one, or null when there is nothing to follow it.
 *
 * `ended` distinguishes a track finishing on its own - where repeat-one means
 * play it again - from someone pressing Next, which always moves on.
 */
function nextTrackIdInContext(options) {
    const settings = options || {};
    const ids = contextTrackIds();
    if (!ids.length) return null;

    const current = getCurrentEncodedTrack();

    if (settings.ended && repeatMode === 'one' && current) return current;

    if (shuffleEnabled) {
        if (shuffleOrderIsStale() || !shuffleOrder.length) rebuildShuffleOrder(current);

        const at = current ? shuffleOrder.indexOf(current) : shuffleCursor;
        const from = at === -1 ? shuffleCursor : at;

        if (from + 1 < shuffleOrder.length) {
            shuffleCursor = from + 1;
            return shuffleOrder[shuffleCursor];
        }

        // The walk is finished. With repeat on it starts again in a new order;
        // without it, the context has been heard.
        if (repeatMode === 'all') {
            const reshuffled = shuffledFrom(ids, null);
            // A fresh walk should not open with the song that just ended.
            if (reshuffled.length > 1 && reshuffled[0] === current) {
                reshuffled.push(reshuffled.shift());
            }
            shuffleOrder = reshuffled;
            shuffleCursor = 0;
            return shuffleOrder[0];
        }

        return null;
    }

    const at = current ? ids.indexOf(current) : -1;
    if (at === -1) return ids[0];
    if (at + 1 < ids.length) return ids[at + 1];
    return repeatMode === 'all' ? ids[0] : null;
}

/** The track before this one, following what was actually played. */
function previousTrackIdInContext() {
    if (playbackHistory.length >= 2) return playbackHistory[playbackHistory.length - 2];

    const ids = contextTrackIds();
    if (!ids.length) return null;

    const current = getCurrentEncodedTrack();
    const at = current ? ids.indexOf(current) : -1;
    if (at > 0) return ids[at - 1];
    if (at === 0 && repeatMode === 'all') return ids[ids.length - 1];
    return null;
}

/**
 * What Previous does: start this track again when it is already under way,
 * otherwise go back to what came before it.
 */
function previousAction(currentTime) {
    const position = typeof currentTime === 'number' ? currentTime : 0;
    if (position > RESTART_THRESHOLD_SECONDS) return { restart: true, trackId: null };
    return { restart: false, trackId: previousTrackIdInContext() };
}

/** Shuffle, repeat and volume are this listener's own, kept on this device. */
function loadPlayerPreferences() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || '{}');
    } catch (e) {
        saved = null;
    }
    const prefs = saved && typeof saved === 'object' ? saved : {};

    shuffleEnabled = prefs.shuffle === true;
    repeatMode = REPEAT_MODES.indexOf(prefs.repeat) === -1 ? 'off' : prefs.repeat;

    const volume = Number(prefs.volume);
    if (Number.isFinite(volume) && volume >= 0 && volume <= 1) {
        currentsong.volume = volume;
        if (volume > 0) lastVolume = volume;
    }

    return prefs;
}

function savePlayerPreferences() {
    try {
        localStorage.setItem(
            PLAYER_PREFS_KEY,
            JSON.stringify({
                shuffle: shuffleEnabled,
                repeat: repeatMode,
                volume: currentsong.volume
            })
        );
    } catch (e) {
        /* a full or blocked store costs a preference, not playback */
    }
}

const REPEAT_LABELS = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' };

/** Draw the shuffle and repeat controls, wherever they appear. */
function syncSequenceUI() {
    document.querySelectorAll('#shuffle, #npShuffle, #albumDetailShuffle').forEach((button) => {
        button.setAttribute('aria-pressed', shuffleEnabled ? 'true' : 'false');
        button.setAttribute('aria-label', shuffleEnabled ? 'Shuffle on' : 'Shuffle');
        button.classList.toggle('is-active', shuffleEnabled);
    });

    document.querySelectorAll('#repeat, #npRepeat').forEach((button) => {
        button.dataset.repeat = repeatMode;
        button.setAttribute('aria-pressed', repeatMode === 'off' ? 'false' : 'true');
        button.setAttribute('aria-label', REPEAT_LABELS[repeatMode] || REPEAT_LABELS.off);
        button.classList.toggle('is-active', repeatMode !== 'off');
    });
}

// ==================== Playback position ====================
// Where a listener stopped, per track.
//
// Kept against the canonical track id and nowhere near Supabase: a signed-in
// listener's positions live in their own state file, a guest's live with this
// device. It is written a few times a minute rather than a few times a second,
// and a track heard to the end is forgotten so that it starts again.

const PROGRESS_SAVE_INTERVAL_MS = 7000;
const PROGRESS_MIN_SECONDS = 5;
const PROGRESS_END_MARGIN_SECONDS = 10;
const PROGRESS_END_FRACTION = 0.98;

let trackProgress = {};
let lastProgressSaveAt = 0;
// The track the saved position has already been applied to, so a pause or a
// seek never drops the listener back where they started.
let resumeAppliedFor = null;

/** True when a position is so near the end that the track should start again. */
function progressIsNearEnd(position, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (position >= duration - PROGRESS_END_MARGIN_SECONDS) return true;
    return position / duration >= PROGRESS_END_FRACTION;
}

/** Everything this listener has a position for. A failure here costs nothing. */
async function loadTrackProgress() {
    const client = getCatalogClient();
    if (!client || typeof client.getPlaybackProgress !== 'function') return {};

    try {
        const result = await client.getPlaybackProgress();
        trackProgress = result && result.trackProgress ? result.trackProgress : {};
    } catch (error) {
        console.warn('Could not read where you left off:', error.message);
        trackProgress = {};
    }
    return trackProgress;
}

/** Where this track should start, in seconds. */
function resumePositionFor(trackId) {
    const entry = trackId ? trackProgress[trackId] : null;
    if (!entry || !Number.isFinite(entry.position)) return 0;
    if (entry.position < PROGRESS_MIN_SECONDS) return 0;
    if (progressIsNearEnd(entry.position, entry.duration)) return 0;
    return entry.position;
}

/**
 * Remember where the current track is.
 *
 * Called often; it writes rarely. `force` is for the moments that matter -
 * pausing, changing track, leaving the page - where the next interval is too
 * late.
 */
function rememberProgress(options) {
    const settings = options || {};
    const trackId = window.currentPlayingTrack;
    if (!trackId) return false;

    const position = Number(currentsong.currentTime) || 0;
    const duration = Number.isFinite(currentsong.duration) ? currentsong.duration : null;

    const now = Date.now();
    if (!settings.force && now - lastProgressSaveAt < PROGRESS_SAVE_INTERVAL_MS) return false;
    lastProgressSaveAt = now;

    // Keep the page's own copy in step, so returning to a track in this
    // session does not depend on the answer coming back.
    if (position < PROGRESS_MIN_SECONDS || progressIsNearEnd(position, duration)) {
        delete trackProgress[trackId];
    } else {
        trackProgress[trackId] = { position: position, duration: duration, updatedAt: new Date().toISOString() };
    }

    const client = getCatalogClient();
    if (!client) return false;

    if (settings.onExit && typeof client.savePlaybackProgressOnExit === 'function') {
        client.savePlaybackProgressOnExit(trackId, position, duration);
        return true;
    }

    if (typeof client.savePlaybackProgress !== 'function') return false;

    Promise.resolve(client.savePlaybackProgress(trackId, position, duration)).catch(() => {
        /* a position is a convenience; losing one is not worth an interruption */
    });
    return true;
}

/**
 * Put a track back where it was left, once the browser knows how long it is.
 *
 * This only moves the playhead. It never starts playback: a restored position
 * is somewhere to begin from, not a reason to begin.
 */
function applyResumePosition(trackId) {
    if (!trackId || resumeAppliedFor === trackId) return;

    const position = resumePositionFor(trackId);
    resumeAppliedFor = trackId;
    if (position <= 0) return;

    const seek = () => {
        if (window.currentPlayingTrack !== trackId) return;
        if (Number.isFinite(currentsong.duration) && position >= currentsong.duration) return;
        try {
            currentsong.currentTime = position;
        } catch (e) {
            /* seeking before the browser is ready is best effort */
        }
    };

    if (Number.isFinite(currentsong.duration) && currentsong.duration > 0) {
        seek();
    } else {
        currentsong.addEventListener('loadedmetadata', seek, { once: true });
    }
}

// ==================== Account gating ====================
// Browsing works without an account: the published global catalogue and the
// music on this device are both readable by a guest. Anything that belongs to
// a person - their own albums, likes, hidden items, backups - needs a signed-in
// account, so those controls are hidden or routed to sign-in instead of
// pretending to work.

let hasAccount = false;

function isSignedIn() {
    return hasAccount;
}

/** True when the action was allowed; otherwise it points the guest at sign-in. */
function requireAccount(message) {
    if (hasAccount) return true;
    showToast(message || 'Sign in to use this');
    return false;
}

/** Show or hide the controls that only make sense with an account. */
function applyAccountGating() {
    const personalControls = [].concat(
        Array.from(document.querySelectorAll('.create-album-card')),
        // Every album's menu, but not the machine's: what is on this device is
        // the device's, and a guest looks after it exactly as an account does.
        Array.from(document.querySelectorAll('.cardcontainer .card-menu:not([data-system])')),
        [
            document.getElementById('addSongsToLibraryBtn'),
            document.getElementById('likeCurrentSong'),
            document.getElementById('backupRestoreBtn')
        ]
    );

    personalControls.forEach((element) => {
        if (!element) return;
        if (hasAccount) {
            element.classList.remove('hidden');
            element.removeAttribute('aria-disabled');
        } else {
            element.classList.add('hidden');
            element.setAttribute('aria-disabled', 'true');
        }
    });
}

/** Track the session so gating follows sign-in and sign-out immediately. */
async function initAccountGating() {
    if (!window.spotifieAuth) {
        applyAccountGating();
        return;
    }

    await window.spotifieAuth.ready();
    const session = await window.spotifieAuth.getSession();
    hasAccount = Boolean(session);
    applyAccountGating();

    window.spotifieAuth.onAuthChange(async (currentSession) => {
        const nowSignedIn = Boolean(currentSession);
        if (nowSignedIn === hasAccount) return;

        hasAccount = nowSignedIn;
        applyAccountGating();

        // Whatever was held for the last account goes before anything is
        // drawn for the next. Two people share this machine; neither may see
        // the other's liked songs, playlists or history, and the surest way to
        // promise that is to have nothing left in memory to show.
        const personal = getPersonal();
        if (personal) personal.clear();
        applyPersonalCollections();

        // Personal albums belong to an account, so the view is rebuilt when
        // one appears or disappears.
        loadUserAlbums();
        await loadSongsConfig();

        // And the next account's own library is read, if there is one.
        if (nowSignedIn && personal) await personal.load({ force: true });
        await checkAndCreateLikedSongsAlbum();
        await refreshAlbumCards();

        // A collection belonging to whoever just left is not one to stay
        // looking at.
        if (isPersonalFolder(currentFolder) && !predefinedSongs[currentFolder]) {
            const remaining = Object.keys(predefinedSongs);
            if (remaining.length) await getsongs(remaining[0]);
        }

        // The music found on this device belongs to the device, so it is
        // still there, still playing, and still being searched for: signing in
        // or out only changes whose likes and albums are shown.
    });
}

// Catalogue state, loaded from the unified catalogue service (same origin).
// It merges two sources behind one model: tracks on this device ('local') and
// tracks an administrator published for everyone ('global'). Track IDs are
// namespaced, so the two can never collide.
let predefinedSongs = {};
let albumInfo = {};
// Songs this person has put into an album themselves, by album folder. The
// catalogue says which they are, so the page never has to guess whether a song
// is part of an album or was added to it.
let albumTrackAdditions = {};
window.libraryTracks = {};
window.catalogSources = { local: { available: false }, global: { available: false } };

const LIBRARY_ALBUM_PREFIX = 'library/';

// ==================== Music on this device ====================
// Spotifie can look through the music folders this installation is allowed to
// read and gather what it finds into Local Music. That is a question about the
// machine, not about an account: a guest may ask it, and what is found belongs
// to the device, so everyone who opens Spotifie here sees the same songs.
//
// The search runs on the local server. This page asks for it, shows how it is
// going, and reads the library again when there is something new. It never
// reads a file itself: it sees track ids and counts.

// Everything found on this machine lives in one collection, named by the
// catalogue. The page never invents it: it is simply the album the local music
// is in, and it is always shown first.
const LOCAL_MUSIC_ALBUM_ID = 'system:local-music';
const LOCAL_MUSIC_FOLDER = LIBRARY_ALBUM_PREFIX + LOCAL_MUSIC_ALBUM_ID;
const DEVICE_SCAN_POLL_MS = 1200;
const DEVICE_SCAN_DONE_VISIBLE_MS = 8000;

// A refresh's check for new music says one short sentence, and only when
// there is something to say.
const DEVICE_SCAN_TOAST_MS = 2000;

let deviceScanTimer = null;
let deviceScanRefreshAt = 0;

// A check that nobody asked for shows nothing at all while it runs. The
// progress panel belongs to the two searches somebody is waiting on: the
// first one on this device, and a rescan asked for by hand.
let deviceScanSilent = false;
// Saying "not now" closes the question for this visit only. Nothing durable is
// written for a refusal: the next time the page is opened, it is asked again.
let deviceScanDismissedThisSession = false;
// What the server says about this device: whether searching was agreed to
// here, and when it last happened.
let deviceScanReport = null;

/**
 * Ask about searching this device, or - once that has been agreed to - look
 * again for anything new.
 *
 * The songs found before are already on screen by the time this runs: the
 * index is read at startup like any other music, and looking again happens
 * behind it. The answer lives with the installation, not with an account, so
 * signing in or out changes nothing about it.
 */
async function initDeviceMusicScan() {
    const prompt = document.getElementById('deviceScanPrompt');
    if (!prompt) return;

    const client = getCatalogClient();
    if (!client) return;

    // Is there a helper on this machine at all?
    //
    // Spotifie runs in two places now. Opened from the server somebody started
    // themselves, there is one, and everything about the music on the device
    // works as it always has. Opened from a published copy there is not, and
    // that is an ordinary state rather than a fault: the published catalogue
    // and signing in both work, and the music on the device is reported as out
    // of reach rather than pretended away.
    const platform = getPlatform();
    if (platform) {
        const here = await platform.detectLocalCapability();
        if (!here) {
            platform.setLocalMusic('unavailable');
            markLocalMusicUnavailable();
            return;
        }
    }

    try {
        deviceScanReport = await client.getDeviceScanStatus();
    } catch (err) {
        // Asked for and not answered: the helper was there a moment ago and is
        // not now. Said once, and looked for again on the schedule below.
        if (platform) platform.setLocalMusic('unavailable');
        markLocalMusicUnavailable();
        return;
    }

    if (platform) platform.setLocalMusic('available');

    updateScanMenuLabel();

    // A search already running - started in this page, in another tab, or
    // before a refresh - is watched, not started again. The server owns the
    // job, so its progress carries on from where it is. One job to a device
    // means a second tab joins the first rather than searching again.
    if (deviceScanReport.running) {
        deviceScanSilent = deviceScanReport.scan ? deviceScanReport.scan.mode !== 'full' : true;
        if (!deviceScanSilent) renderDeviceScanProgress(deviceScanReport.scan);
        watchDeviceScan();
        return;
    }

    // Already agreed to. The songs found last time are already on screen -
    // they came from the saved index with the rest of the catalogue - so this
    // is only a look for what has changed since: the folders are walked and
    // each file is recognised by its path, size and modified time. Nothing
    // unchanged is opened, hashed or read for tags, and nothing is shown
    // unless something new turns up.
    if (deviceScanReport.permission === 'allowed') {
        await startDeviceScan({ silent: true });
        return;
    }

    if (deviceScanDismissedThisSession) return;

    prompt.classList.remove('hidden');
}

function initDeviceScanControls() {
    const prompt = document.getElementById('deviceScanPrompt');

    document.getElementById('deviceScanStart')?.addEventListener('click', async () => {
        if (prompt) prompt.classList.add('hidden');
        await startDeviceScan();
    });

    document.getElementById('deviceScanLater')?.addEventListener('click', () => {
        if (prompt) prompt.classList.add('hidden');
        // Closed for this visit. Nothing is written down, so the question
        // comes back next time the page is opened - and nothing is searched.
        deviceScanDismissedThisSession = true;
        showToast('You can scan for music later from the menu');
    });

    document.getElementById('scanDeviceLink')?.addEventListener('click', async () => {
        document.getElementById('userDropdown')?.classList.remove('show');
        // Asked for by hand: read everything again, rather than trusting what
        // the index says about files that look unchanged.
        const searchedBefore = Boolean(deviceScanReport && deviceScanReport.lastSuccessfulScanAt);
        // Asked for by hand, so it shows its progress and reads every file
        // again rather than trusting what the index says about them.
        await startDeviceScan(searchedBefore ? { mode: 'full' } : {});
    });

    document.getElementById('deviceScanCancel')?.addEventListener('click', async () => {
        const client = getCatalogClient();
        if (!client) return;
        try {
            await client.cancelDeviceScan();
        } catch (err) {
            console.error('Could not stop the scan:', err);
        }
    });

    // Closing the notice hides it; the search itself carries on.
    document.getElementById('deviceScanDismiss')?.addEventListener('click', () => {
        document.getElementById('deviceScanProgress')?.classList.add('hidden');
    });
}

/** Say when this device was last searched. */
function updateScanMenuLabel() {
    const label = document.getElementById('scanDeviceLabel');
    if (!label) return;

    const lastScanAt = deviceScanReport ? deviceScanReport.lastScanAt : null;
    if (lastScanAt) {
        label.textContent = 'Rescan Local Music';
        label.title = 'Last scanned ' + new Date(lastScanAt).toLocaleString();
        return;
    }

    label.textContent = 'Scan device for music';
    label.title = 'Scan permitted music locations on this device';
}

/**
 * Start a search, unless one is already going.
 *
 * A search someone asked for is worth showing whatever it finds; the one that
 * runs by itself when the page opens says so only when there is something new,
 * so an unchanged library is not announced on every refresh.
 */
/**
 * Start searching this device.
 *
 * `silent` is the refresh's own check: it runs in the background with no
 * panel and no notice, and speaks only if it finds something. Everything else
 * - the first search here, and a rescan asked for by hand - is something
 * somebody is waiting on, and shows its progress.
 */
/**
 * Draw the library again after this device's music changed underneath it.
 *
 * Used when songs have gone: the catalogue is read again and everything built
 * from it - the album grid, the list being looked at, the personal collections
 * - is rebuilt from what is actually there. Playback is not touched, and
 * neither is anything personal: a playlist that named a song which has gone
 * still names it, and says so, because somebody's arrangement is theirs to
 * change and not the disk's.
 */
async function refreshAfterDeviceChange() {
    await loadSongsConfig();
    await refreshAlbumCards();
    await refreshPersonalViews();

    if (currentFolder && predefinedSongs[currentFolder]) {
        await getsongs(currentFolder);
    }
}

async function startDeviceScan(options) {
    const settings = options || {};
    const client = getCatalogClient();
    if (!client) return;

    try {
        const result = await client.startDeviceScan(settings.mode ? { mode: settings.mode } : {});
        deviceScanReport = result;

        // Before searching, the server checked that the music it already knew
        // about is still on the disk. Anything deleted has gone from the index
        // by now, so the library is redrawn to match - quietly. Songs
        // disappearing because their files did is not news worth a message;
        // seeing them still listed would be.
        if (result.reconciled && result.reconciled.removed > 0) {
            await refreshAfterDeviceChange();
        }

        // A full search is always one somebody asked for, whatever asked for it.
        deviceScanSilent = Boolean(settings.silent) && (!result.scan || result.scan.mode !== 'full');

        if (!deviceScanSilent) renderDeviceScanProgress(result.scan);
        updateScanMenuLabel();
        watchDeviceScan();
    } catch (err) {
        console.error('Could not scan this device:', err);
        // A background check that cannot start is not worth interrupting for.
        if (!settings.silent) showToast('Could not scan this device');
    }
}

/**
 * Follow the search until it ends.
 *
 * Local Music grows while it runs, but the page is redrawn every few seconds
 * at most: someone watching a thousand files arrive does not want the page
 * rebuilt a thousand times.
 */
function watchDeviceScan() {
    if (deviceScanTimer) return;

    deviceScanTimer = setInterval(async () => {
        const client = getCatalogClient();
        if (!client) return;

        let status;
        try {
            // Playback comes first: the search slows down while a song plays.
            status = await client.getDeviceScanStatus({ playing: isAudioPlaying() });
        } catch (err) {
            stopWatchingDeviceScan();
            return;
        }

        deviceScanReport = status;
        if (!deviceScanSilent) renderDeviceScanProgress(status.scan);

        // Reloading the catalogue is the expensive part, so it happens when
        // the library has actually changed - not merely because the walk has
        // recognised more files it already knew about.
        if (deviceScanChanges(status.scan) > 0 && Date.now() - deviceScanRefreshAt > 4000) {
            deviceScanRefreshAt = Date.now();
            await refreshLibraryQuietly();
        }

        if (!status.running) {
            stopWatchingDeviceScan();
            updateScanMenuLabel();

            const changed = deviceScanChanges(status.scan);
            if (changed > 0) await refreshLibraryQuietly();

            const added = status.scan ? numberOf(status.scan.newTracks) : 0;
            const silent = deviceScanSilent;
            deviceScanSilent = false;

            if (silent) {
                // A background check says one short thing when there is
                // something to say, and nothing at all when there is not.
                if (added > 0) {
                    showToast(
                        countOf(added) +
                            (added === 1 ? ' new song added to Local Music' : ' new songs added to Local Music'),
                        DEVICE_SCAN_TOAST_MS
                    );
                }
                return;
            }

            setTimeout(
                () => document.getElementById('deviceScanProgress')?.classList.add('hidden'),
                DEVICE_SCAN_DONE_VISIBLE_MS
            );
        }
    }, DEVICE_SCAN_POLL_MS);
}

/**
 * How much of the library a search has actually altered.
 *
 * A file the index already knew, unchanged on disk, is not a change: counting
 * it would mean reloading the whole catalogue on every refresh for a library
 * that is exactly as it was.
 */
function deviceScanChanges(scan) {
    if (!scan) return 0;
    return numberOf(scan.newTracks) + numberOf(scan.changedTracks) + numberOf(scan.missingTracks);
}

function stopWatchingDeviceScan() {
    if (!deviceScanTimer) return;
    clearInterval(deviceScanTimer);
    deviceScanTimer = null;
}

/** Read the catalogue again and redraw, without disturbing playback. */
async function refreshLibraryQuietly() {
    await loadSongsConfig();
    await refreshAlbumCards();
    if (currentFolder) await getsongs(currentFolder);
}

/**
 * Show how the search is going.
 *
 * While the files are still being counted there is no honest percentage to
 * show, so none is shown; once the total is known the bar means something.
 */
function renderDeviceScanProgress(scan) {
    const panel = document.getElementById('deviceScanProgress');
    if (!panel || !scan) return;

    const title = document.getElementById('deviceScanTitle');
    const detail = document.getElementById('deviceScanDetail');
    const bar = document.getElementById('deviceScanBar');
    const fill = document.getElementById('deviceScanFill');
    const cancel = document.getElementById('deviceScanCancel');

    panel.classList.remove('hidden');
    const running = scan.status === 'discovering' || scan.status === 'scanning';
    if (cancel) cancel.hidden = !running;

    if (scan.status === 'discovering') {
        if (title) title.textContent = scan.mode === 'full' ? 'Finding local music…' : 'Checking for new music…';
        if (detail) detail.textContent = 'Looking through permitted music locations';
        if (bar) bar.classList.add('indeterminate');
        if (fill) fill.style.width = '100%';
        return;
    }

    if (bar) bar.classList.remove('indeterminate');

    if (scan.status === 'scanning') {
        if (title) title.textContent = 'Scanning Local Music — ' + (scan.percent === null ? '' : scan.percent + '%');
        if (fill) fill.style.width = (scan.percent || 0) + '%';
        if (detail) {
            // What is counted is what happened: files looked at, and songs
            // that were not in the library before.
            detail.textContent =
                countOf(scan.filesChecked) +
                ' / ' +
                countOf(scan.total) +
                ' files checked · ' +
                countOf(scan.newTracks) +
                ' new ' +
                (scan.newTracks === 1 ? 'song' : 'songs') +
                ' found';
        }
        return;
    }

    if (fill) fill.style.width = '100%';

    if (scan.status === 'complete') {
        const parts = [countOf(scan.filesChecked) + ' files checked'];
        if (scan.filesSkipped) parts.push(countOf(scan.filesSkipped) + ' files skipped');

        if (scan.newTracks > 0) {
            if (title) title.textContent = 'Local Music updated';
            if (detail) {
                detail.textContent =
                    countOf(scan.newTracks) +
                    ' new ' +
                    (scan.newTracks === 1 ? 'song' : 'songs') +
                    ' found · ' +
                    parts.join(' · ');
            }
            return;
        }

        // Nothing new. Said plainly, and briefly.
        if (title) title.textContent = 'Local Music is up to date';
        if (detail) detail.textContent = parts.join(' · ');
        return;
    }

    if (scan.status === 'cancelled') {
        if (title) title.textContent = 'Scan stopped';
        if (detail) {
            detail.textContent =
                countOf(scan.newTracks) + ' new ' + (scan.newTracks === 1 ? 'song' : 'songs') + ' found';
        }
        return;
    }

    if (title) title.textContent = 'Scan failed';
    if (detail) detail.textContent = scan.error || 'The scan could not finish';
}

/** A count as someone would read it: 1,247 rather than 1247. */
/** A counter from the server as a number, or zero when it says nothing. */
function numberOf(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

/** The same counter written out for someone to read. */
function countOf(value) {
    return numberOf(value).toLocaleString();
}

/**
 * Where an album belongs in the library, before anything else is considered.
 *
 * Local Music is what is on this machine, so it comes first; then the albums
 * someone made here; then what an administrator published. Within each of
 * those the order they already had is kept.
 */
function albumPriority(folder) {
    const info = albumInfo[folder];
    if (!info) return 3;
    if (info.isSystemCollection) return 0;
    if (info.isUserAlbum || info.isLikedAlbum) return 1;
    if (info.source === 'global') return 2;
    return 1;
}


function libraryFolderForAlbum(albumId) {
    return LIBRARY_ALBUM_PREFIX + albumId;
}

function getLibraryTrack(trackId) {
    return window.libraryTracks[trackId] || null;
}

function getCatalogClient() {
    return window.spotifieCatalog || null;
}

/** Human-readable title for a track ID, used by list rows and the playbar. */
/**
 * What a song is called, for someone reading it.
 *
 * Its title if it has one; otherwise the name of the file it came from,
 * tidied up. An id is a last resort, and only when there is nothing else.
 */
function trackDisplayTitle(trackId) {
    const track = getLibraryTrack(trackId);
    if (track && track.title && track.title !== 'Unknown Album') return track.title;

    const fileName = track && track.metadata ? track.metadata.fileName : null;
    if (fileName) return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

    try {
        return decodeURIComponent(trackId);
    } catch (e) {
        return String(trackId);
    }
}

/** Who a song is by; a song that does not say is by Unknown Artist. */
function trackDisplayArtist(trackId) {
    const track = getLibraryTrack(trackId);
    if (!track) return '';
    return track.artist || 'Unknown Artist';
}

/**
 * Load albums and tracks from the unified catalogue.
 * Albums are keyed by "library/<albumId>" and songs are namespaced track IDs.
 * If one source is unavailable the other still loads.
 */
async function loadSongsConfig() {
    const client = getCatalogClient();
    if (!client) {
        console.error('Catalogue client unavailable');
        return false;
    }

    try {
        const [albums, tracks] = await Promise.all([client.getAlbums(), client.getTracks()]);

        applyCatalogData({
            albums: albums.items || [],
            tracks: tracks.items || [],
            sources: tracks.sources || albums.sources || null
        });

        // What was read is worth keeping. The published half of it is the part
        // that took a journey, and having a copy of it here is what lets the
        // next visit draw the library before making that journey again.
        rememberPublishedCatalogue(albums.items || [], tracks.items || []);

        // And what that journey found, so the rest of the application can
        // decide from one place whether the published catalogue is there.
        const platform = getPlatform();
        if (platform) {
            const sources = (tracks.sources || albums.sources || {}).global;
            platform.setCloudCatalogue(sources && sources.available === false ? 'unavailable' : 'available');
        }

        // And what this machine's own half looked like, so a later check knows
        // whether it has moved rather than assuming it has.
        renderedLocalFingerprint = localFingerprint(
            (albums.items || []).filter((album) => album.source !== 'global'),
            (tracks.items || []).filter((track) => track.source !== 'global')
        );

        const sources = window.catalogSources || {};
        console.log(
            'Loaded catalogue:',
            Object.keys(predefinedSongs).length,
            'albums,',
            (tracks.items || []).length,
            'tracks (local:',
            sources.local && sources.local.available,
            'global:',
            sources.global && sources.global.available,
            ')'
        );
        return true;
    } catch (error) {
        console.error('Could not load the music catalogue:', error);

        const platform = getPlatform();
        if (platform) platform.setCloudCatalogue('unavailable');
        return false;
    }
}

/**
 * Arrange one catalogue into what the page draws from.
 *
 * The same arrangement whatever the catalogue came from: a fresh read, or the
 * copy this device kept of the published half joined to the music it can see
 * for itself. Everything below this line works from albumInfo, predefinedSongs
 * and libraryTracks, and none of it knows or cares which of the two filled
 * them.
 */
function applyCatalogData(catalogue) {
    const albums = { items: (catalogue && catalogue.albums) || [] };
    const tracks = { items: (catalogue && catalogue.tracks) || [] };

    predefinedSongs = {};
    albumInfo = {};
    window.libraryTracks = {};

    if (catalogue && catalogue.sources) window.catalogSources = catalogue.sources;

    albumTrackAdditions = {};

    for (const track of tracks.items || []) {
        // A track that appears in an album because this person put it
        // there is the same track, listed again under that album. The
        // first entry stays the one the page describes.
        if (!window.libraryTracks[track.id]) window.libraryTracks[track.id] = track;
    }

    for (const album of albums.items || []) {
        const folder = libraryFolderForAlbum(album.id);
        predefinedSongs[folder] = [];
        albumInfo[folder] = {
            title: album.title,
            // Cards show the artist. The description is carried for album
            // detail views, and is never rendered on a card.
            artist: album.artist || album.albumArtist || '',
            // Local Music is the machine's own collection, not an album
            // anybody made: it cannot be edited, deleted or published.
            isSystemCollection: Boolean(album.system),
            description: album.description || '',
            cover: album.artworkUrl || '',
            // Whether there is a picture to fetch at all; without it a
            // published album with none would be asked about every time.
            hasArtwork: album.metadata ? Boolean(album.metadata.hasArtwork) : undefined,
            // Which picture, so the address for it changes when the cover
            // does and stays the same when it does not.
            artworkVersion: album.metadata ? album.metadata.artworkVersion || null : null,
            albumId: album.id,
            source: album.source,
            isLibraryAlbum: true,
            // For a published album: what everyone else sees, and whether
            // this account has its own version of it.
            globalTitle: album.published ? album.published.title : album.title,
            globalArtist: album.published ? album.published.artist : album.artist,
            globalDescription: album.published ? album.published.description || '' : '',
            globalCover: album.published ? album.published.artworkUrl : album.artworkUrl,
            hasLocalEdits: Boolean(album.hasLocalEdits),
            localEdits: album.localEdits || null
        };
    }

    for (const track of tracks.items || []) {
        const folder = libraryFolderForAlbum(track.albumId);

        if (track.addedToAlbum) {
            if (!albumTrackAdditions[folder]) albumTrackAdditions[folder] = [];
            if (!albumTrackAdditions[folder].includes(track.id)) albumTrackAdditions[folder].push(track.id);
        }

        if (!predefinedSongs[folder]) {
            predefinedSongs[folder] = [];
            albumInfo[folder] = {
                title: track.album,
                artist: track.albumArtist || '',
                description: '',
                cover: track.artworkUrl || '',
                albumId: track.albumId,
                source: track.source,
                isLibraryAlbum: true
            };
        }
        // One entry per track: the same id from two sources is one song.
        if (!predefinedSongs[folder].includes(track.id)) predefinedSongs[folder].push(track.id);
    }

    return true;
}

// ============================================
// Drawing the library before the catalogue arrives
//
// The published catalogue lives in Supabase, and asking for it takes as long
// as a journey there and back. Doing that before anything is drawn means the
// library is empty for as long as the network says it is - on every refresh,
// for a catalogue that has usually not changed at all.
//
// So the copy this device kept is drawn first, joined to the music the machine
// can see for itself, and the real catalogue is checked afterwards. When
// nothing has changed - the ordinary case - nothing is redrawn.
// ============================================

/** The copy this device keeps, when the browser lets us keep one. */
function getCatalogCache() {
    return window.spotifieCatalogCache || null;
}

/** What was in the copy that was drawn, so a check can tell whether it moved. */
let renderedCatalogFingerprint = null;

/**
 * And what this machine's own half looked like when it was drawn.
 *
 * Kept apart from the published half because the two change for different
 * reasons and at different times. A song deleted from the disk moves this one
 * and leaves the other exactly as it was - so one number cannot answer for
 * both, and a check that tried would miss whichever half it was not watching.
 */
let renderedLocalFingerprint = null;

/**
 * A short string for the music on this machine.
 *
 * Ids and counts: enough to notice a song appearing, disappearing or changing
 * collection, and cheap enough to work out on every check. Sorted, because the
 * order two reads happen to come back in is not a change.
 */
function localFingerprint(albums, tracks) {
    const parts = [];

    for (const album of albums || []) parts.push('a:' + album.id + ':' + (album.trackCount || 0));
    for (const track of tracks || []) parts.push('t:' + track.id);

    parts.sort();
    return parts.length + ':' + parts.join('|');
}

/** Keep the published half of a catalogue that has just been read. */
function rememberPublishedCatalogue(albums, tracks) {
    const cache = getCatalogCache();
    if (!cache) return;

    // A catalogue that could not be reached is not an empty catalogue. Writing
    // it as one would replace a perfectly good copy with nothing.
    const sources = window.catalogSources || {};
    if (sources.global && sources.global.available === false) return;

    const published = {
        albums: (albums || []).filter((album) => album.source === 'global'),
        tracks: (tracks || []).filter((track) => track.source === 'global')
    };

    renderedCatalogFingerprint = cache.fingerprint(published.albums, published.tracks);

    cache.write(published).catch(() => {
        /* a copy is a convenience; not having one changes nothing */
    });
}

/**
 * Draw the library from what this device already has.
 *
 * The published half comes from the copy, the local half from this machine,
 * and the listener's own edits to published albums are applied on top - so
 * what appears is what they left, not the published version of it. Answers
 * false when there is no copy, which is a first visit, and the page loads the
 * way it always did.
 */
async function loadCatalogFromCache() {
    const cache = getCatalogCache();
    const client = getCatalogClient();
    if (!cache || !client || typeof client.getLocalCatalog !== 'function') return false;

    let snapshot = null;
    let local = null;

    try {
        [snapshot, local] = await Promise.all([
            cache.read(),
            client.getLocalCatalog().catch(() => null)
        ]);
    } catch (e) {
        return false;
    }

    if (!snapshot || (!snapshot.albums.length && !snapshot.tracks.length)) return false;

    // The music on this machine could not be read.
    //
    // Drawing anyway would put up a library made of the published half alone -
    // no Local Music, no albums anybody made here - and the check that follows
    // compares only the published half, so it would find nothing amiss and
    // never correct it. The library would stay wrong until something forced a
    // full reload, which is exactly how Local Music came to vanish for a whole
    // session.
    //
    // So a local half that did not arrive is not drawn around. The ordinary
    // path reads the catalogue properly, and is slower by one request.
    if (!local || !Array.isArray(local.albums)) {
        console.warn('This device could not be read from the copy; loading the catalogue instead.');
        return false;
    }

    const personal = personalStateFrom(local);
    const published = applyPersonalState(snapshot.albums, snapshot.tracks, personal, (local && local.tracks) || []);

    applyCatalogData({
        albums: ((local && local.albums) || []).concat(published.albums),
        tracks: ((local && local.tracks) || []).concat(published.tracks, published.attached),
        // The published half was not asked about - it came from the copy. That
        // is not the same as knowing it is there, and not the same as knowing
        // it is gone; the check that follows settles it.
        sources: Object.assign({}, (local && local.sources) || null, {
            global: { available: null, cached: true, trackCount: published.tracks.length, error: null }
        })
    });

    // What was drawn, so the check that follows can say in one comparison
    // whether anything on screen is out of date. Both halves: a check that
    // only knew about the published catalogue could not see that the music on
    // this device had changed, and would leave a stale library alone believing
    // it was current.
    renderedCatalogFingerprint = snapshot.fingerprint;
    renderedLocalFingerprint = localFingerprint(local.albums, local.tracks);

    // Drawn from the copy this device kept, which is not the same as knowing
    // the published catalogue is reachable - the check that follows settles
    // that.
    const platform = getPlatform();
    if (platform) platform.setCloudCatalogue('cached');

    console.log(
        'Drew the library from this device:',
        Object.keys(predefinedSongs).length,
        'albums (published copy kept',
        new Date(snapshot.cachedAt).toISOString(),
        ')'
    );
    return true;
}

/** The listener's own state, out of a local read, or the empty one. */
function personalStateFrom(local) {
    const state = local || {};
    const hidden = state.hidden || {};

    return {
        overrides: state.overrides || {},
        added: state.addedToGlobalAlbums || {},
        hiddenAlbums: new Set(hidden.globalAlbums || []),
        hiddenTracks: new Set(hidden.globalTracks || [])
    };
}

/**
 * The published catalogue as this listener has it.
 *
 * What they hid is gone, what they renamed or re-covered reads the way they
 * left it, and songs of their own that they put into a published album appear
 * inside it. The copy itself is never written to: it holds what everyone sees,
 * and this is a view of it.
 */
function applyPersonalState(albums, tracks, personal, localTracks) {
    const visibleAlbums = [];

    for (const album of albums || []) {
        if (personal.hiddenAlbums.has(album.id)) continue;
        visibleAlbums.push(applyAlbumOverrideLocally(album, personal.overrides[globalAlbumUuid(album.id)]));
    }

    const visibleAlbumIds = new Set(visibleAlbums.map((album) => album.id));
    const visibleTracks = (tracks || []).filter(
        (track) => !personal.hiddenTracks.has(track.id) && !(track.albumId && personal.hiddenAlbums.has(track.albumId))
    );

    return {
        albums: visibleAlbums,
        tracks: visibleTracks,
        attached: attachPersonalTracksLocally(localTracks, visibleAlbumIds, personal.added)
    };
}

/**
 * Songs of this listener's own that they have put into published albums.
 *
 * The song keeps its own id and its own audio - it is the same song, listed
 * again under that album, and only for them. A song already listed there is
 * not listed twice, and an album they cannot see gets nothing.
 */
function attachPersonalTracksLocally(localTracks, visibleAlbumIds, added) {
    const albums = Object.keys(added || {});
    if (!albums.length) return [];

    const byId = new Map((localTracks || []).map((track) => [track.id, track]));
    const attached = [];
    const placed = new Set();

    for (const uuid of albums) {
        const albumId = 'global-album:' + uuid;
        if (!visibleAlbumIds.has(albumId)) continue;

        for (const trackId of added[uuid] || []) {
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

/** The uuid inside a published album's id, or null. */
function globalAlbumUuid(albumId) {
    if (typeof albumId !== 'string') return null;
    const prefix = 'global-album:';
    return albumId.startsWith(prefix) ? albumId.slice(prefix.length) : null;
}

/**
 * One published album, shown the way this listener has it.
 *
 * The same rules the server applies when it merges the two: their title, their
 * artist, their description, their cover - each only where they set one, and
 * the published version kept alongside so they can see the difference and go
 * back to it.
 */
function applyAlbumOverrideLocally(album, override) {
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

/**
 * Check the published catalogue, quietly, after the library is already up.
 *
 * The comparison is one string against another: every album and song reduced
 * to its id, when it last changed and which picture it carries. Equal means
 * nothing an eye could see is different, and nothing is redrawn - which is
 * what a refresh usually is. Different means the catalogue is arranged again
 * and the library drawn again, once.
 *
 * A catalogue that cannot be reached leaves what is on screen exactly as it
 * is. An outage is not a reason to empty someone's library, and it is not a
 * reason to throw away the copy that is making it work.
 */
async function revalidateCatalog() {
    const cache = getCatalogCache();
    const client = getCatalogClient();
    if (!cache || !client) return false;

    let albums;
    let tracks;

    try {
        [albums, tracks] = await Promise.all([client.getAlbums(), client.getTracks()]);
    } catch (error) {
        console.warn('Could not check the catalogue; keeping what is on screen:', error.message);
        return false;
    }

    const sources = tracks.sources || albums.sources || {};
    if (sources.global && sources.global.available === false) {
        console.warn('The published catalogue is unavailable; keeping the copy this device has.');
        return false;
    }

    const publishedAlbums = (albums.items || []).filter((album) => album.source === 'global');
    const publishedTracks = (tracks.items || []).filter((track) => track.source === 'global');
    const fingerprint = cache.fingerprint(publishedAlbums, publishedTracks);

    // The other half, and the reason this is checked at all: the published
    // catalogue can be perfectly unchanged while the music on this machine is
    // not. A check that only looked at the published half would find nothing
    // amiss and leave a library missing its local music exactly as it was.
    const localAlbums = (albums.items || []).filter((album) => album.source !== 'global');
    const localTracks = (tracks.items || []).filter((track) => track.source !== 'global');
    const localPrint = localFingerprint(localAlbums, localTracks);

    if (fingerprint === renderedCatalogFingerprint && localPrint === renderedLocalFingerprint) {
        // Nothing has moved, on either side. The copy is already right, the
        // screen is already right, and there is nothing to draw.
        window.catalogSources = sources;
        return false;
    }

    applyCatalogData({
        albums: albums.items || [],
        tracks: tracks.items || [],
        sources: sources
    });
    rememberPublishedCatalogue(albums.items || [], tracks.items || []);
    renderedLocalFingerprint = localPrint;

    return true;
}

/** Throw away the copy, so the next visit reads the catalogue afresh. */
function forgetPublishedCatalogue() {
    const cache = getCatalogCache();
    renderedCatalogFingerprint = null;
    if (cache) cache.clear();
}

/** One check at a time, and never two of them running together. */
let catalogRevalidation = null;

/**
 * Check the catalogue once the library is up, and redraw only if it moved.
 *
 * Nothing here touches the player. A song that is playing keeps playing
 * through the check and through a redraw: what is rebuilt is the list of
 * albums and the list of songs in the one being looked at, not the audio or
 * anything the audio is driving.
 */
function scheduleCatalogRevalidation() {
    if (catalogRevalidation) return catalogRevalidation;

    catalogRevalidation = revalidateCatalog()
        .then(async (changed) => {
            if (!changed) return false;

            console.log('The published catalogue has changed; redrawing the library.');
            await redrawAfterCatalogChange();
            return true;
        })
        .catch((error) => {
            console.warn('Could not check the catalogue:', error && error.message);
            return false;
        })
        .finally(() => {
            catalogRevalidation = null;
        });

    return catalogRevalidation;
}

/**
 * Put the library back on screen after the catalogue turned out to have moved.
 *
 * The album the listener is looking at stays the one they are looking at, as
 * long as it still exists; an album that has been withdrawn leaves them on the
 * first one there is, rather than on an empty page. Playback is not touched.
 */
async function redrawAfterCatalogChange() {
    await refreshAlbumCards();

    if (currentFolder && predefinedSongs[currentFolder]) {
        await getsongs(currentFolder);
        return;
    }

    const remaining = Object.keys(predefinedSongs);
    if (remaining.length) {
        await getsongs(remaining[0]);
    } else {
        songs = [];
        window.currentSongsMeta = [];
        showEmptyLibraryState();
    }
}


/**
 * A length that is not known yet.
 *
 * A song whose metadata has not arrived has no duration, and saying 00:00 for
 * it reads as a fact rather than as a gap. This is the placeholder until the
 * real number is there; the moment it is, the clock says it.
 */
const UNKNOWN_DURATION = '\u2014:\u2014';

/** A length, or the placeholder when there is not one to show. */
function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return UNKNOWN_DURATION;
    return secondsToMinutesSeconds(seconds);
}

function secondsToMinutesSeconds(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function bindLibraryItemEvents() {
    Array.from(document.querySelectorAll('.songslist li')).forEach(li => {
        // The empty-list placeholder is not a track: no click, no playback.
        if (li.classList.contains('empty-libcard')) return;

        li.addEventListener('click', (e) => {
            // Don't trigger if clicking on menu button
            if (e.target.closest('.song-menu-btn')) return;
            
            closeSidebarOnMobile();

            const trackEncoded = li.dataset.track;
            const sourceFolder = li.dataset.sourceFolder || currentFolder;
            const btn = li.querySelector('.libPlayButton');
            
            // Check if this song is already the current song
            const currentTrack = getCurrentEncodedTrack();
            const isSameSong = currentTrack === trackEncoded && window.currentPlayingSourceFolder === sourceFolder;
            
            if (isSameSong) {
                // The same track: play or pause the audio and let its events
                // redraw every control.
                if (btn) currentLibButton = btn;
                togglePlayback();
            } else {
                // Play new song with sourceFolder
                playmusic(trackEncoded, btn, false, sourceFolder);
            }
        });
    });
}

async function getsongs(folder) {
    currentFolder = folder;
    localStorage.setItem('lastFolder', folder);

    // Track IDs indexed by the local library for this album
    const serverSongs = predefinedSongs[folder] || [];

    // A collection somebody made is already the list they made: in their
    // order, with anything they put in twice still there twice. An album's
    // membership is deduplicated because an album holds each song once; a
    // playlist is an arrangement, and repeating something in it is allowed.
    const effectiveSongs = isPersonalFolder(folder)
        ? {
              serverSongs: serverSongs,
              userSongs: [],
              allSongs: serverSongs.map((track, index) => ({
                  track: track,
                  sourceFolder: folder,
                  isUserAdded: false,
                  // Which entry this is, so removing one copy of a song does
                  // not remove the others.
                  position: index
              }))
          }
        : await LibraryDB.getEffectiveSongsForAlbum(folder, serverSongs);

    // For playback, we need a flat list of tracks with their source info
    songs = effectiveSongs.allSongs.map(s => s.track);

    // Store song metadata for playback
    window.currentSongsMeta = effectiveSongs.allSongs;

    const songslist = document.querySelector('.songslist ul');
    songslist.innerHTML = '';

    if (effectiveSongs.allSongs.length === 0) {
        // An album that happens to be empty is still a row in the list, not a
        // full-size notice.
        //
        // Local Music with nothing in it is not an empty album - it is this
        // machine, currently holding no music Spotifie can see. Saying so is
        // an ordinary state, not a fault, and the collection stays exactly
        // where it was.
        const info = albumInfo[folder];
        songslist.innerHTML = info && info.isSystemCollection
            ? emptyLibraryCard('No local songs found', 'Music on this device will appear here')
            : emptyLibraryCard('No songs', 'This album is empty');
        bindLibraryItemEvents();
        currentLibButton = null;
        await checkAndUpdateLikeButton();
        return songs;
    }

    // Use DocumentFragment for better performance
    const fragment = document.createDocumentFragment();

    for (const songData of effectiveSongs.allSongs) {
        const li = document.createElement('li');
        li.className = 'libcard bg-black pointer p-1 m-1';
        li.dataset.track = songData.track;
        li.dataset.sourceFolder = songData.sourceFolder;
        if (songData.isUserAdded) {
            li.dataset.userAdded = 'true';
        }

        const songTitle = trackDisplayTitle(songData.track);
        const songArtist = trackDisplayArtist(songData.track);
        const songName = escapeHTML(songTitle);
        const artistName = escapeHTML(songArtist);

        const badge = songData.isUserAdded ? '<span class="user-added-badge">Added</span>' : '';

        li.innerHTML = `
            <img class="pointer song-icon" src="${escapeHTML(trackArtworkSrc(songData.track, folder))}" alt="" width="40" height="40" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${basePath}img/music.svg'">
            <div class="musicinfo pointer">
                <div title="${songName}">${songName}${badge}</div>
                <div title="${artistName}">${artistName}</div>
            </div>
            <img class="libPlayButton invert pointer" src="${basePath}img/play.svg" alt="Play song">
            <button class="song-menu-btn" aria-label="More options">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="6" r="1.5" fill="currentColor"/>
                    <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                    <circle cx="12" cy="18" r="1.5" fill="currentColor"/>
                </svg>
            </button>`;

        fragment.appendChild(li);
    }

    songslist.appendChild(fragment);

    bindLibraryItemEvents();
    bindSongMenuEvents();
    currentLibButton = null;

    // The album detail is another view of the same songs: when it is showing
    // this album, it is redrawn from the same list.
    if (typeof albumDetailFolder !== 'undefined' && albumDetailFolder === folder) renderAlbumDetail(folder);

    // Update like button state for current song
    await checkAndUpdateLikeButton();

    return songs;
}

// Bind song menu (three dots) events
function bindSongMenuEvents() {
    document.querySelectorAll('.songslist .song-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const li = btn.closest('li');
            if (!li) return;
            
            const songData = {
                folder: currentFolder,
                track: li.dataset.track,
                sourceFolder: li.dataset.sourceFolder || currentFolder,
                isUserAdded: li.dataset.userAdded === 'true'
            };
            
            showContextMenu(e, songData);
        });
        
        // Long press for touch devices
        let pressTimer;
        btn.addEventListener('touchstart', (e) => {
            pressTimer = setTimeout(() => {
                const li = btn.closest('li');
                if (!li) return;
                
                const songData = {
                    folder: currentFolder,
                    track: li.dataset.track,
                    sourceFolder: li.dataset.sourceFolder || currentFolder,
                    isUserAdded: li.dataset.userAdded === 'true'
                };
                
                showContextMenu(e, songData);
            }, 500);
        });
        
        btn.addEventListener('touchend', () => clearTimeout(pressTimer));
        btn.addEventListener('touchmove', () => clearTimeout(pressTimer));
    });
}

/**
 * Load and play a global track.
 *
 * The playable URL is short-lived, so it is resolved when it is needed and
 * resolved again (once) if the browser rejects it - typically because the
 * signature expired while the page stayed open. No session is required: the
 * published catalogue is readable by anyone.
 */
function playGlobalTrack(trackId, pause, isRetry) {
    const client = getCatalogClient();
    if (!client) return Promise.resolve();

    return Promise.resolve(client.resolveStreamUrl(trackId, { refresh: Boolean(isRetry) }))
        .then((url) => {
            if (!url || window.currentPlayingTrack !== trackId) return;

            currentsong.src = url;
            if (pause) {
                syncPlaybackUI();
                return;
            }
            return startAudioPlayback();
        })
        .catch((error) => {
            console.error('Could not resolve this track:', error);
            if (!isRetry) return playGlobalTrack(trackId, pause, true);
            showToast('This track is not available right now');
        });
}

/** A failed global source is usually an expired URL: resolve it again once. */
function handleGlobalPlaybackError() {
    const trackId = window.currentPlayingTrack;
    if (!trackId) return;

    const track = getLibraryTrack(trackId);
    if (!track || track.source !== 'global') return;
    if (window.globalRetryFor === trackId) return;

    window.globalRetryFor = trackId;
    const wasPaused = currentsong.paused;
    const position = currentsong.currentTime || 0;

    playGlobalTrack(trackId, wasPaused, true).then(() => {
        if (position > 0) {
            currentsong.addEventListener(
                'loadedmetadata',
                () => {
                    try {
                        currentsong.currentTime = position;
                    } catch (e) {
                        /* seeking is best effort */
                    }
                },
                { once: true }
            );
        }
        window.globalRetryFor = null;
    });
}

function playmusic(trackEncoded, libButton = null, pause = false, sourceFolder = null) {
    // Validate track before playing
    if (!trackEncoded || typeof trackEncoded !== 'string') {
        console.error('Invalid track provided');
        return;
    }

    // Where the track being left off got to, before it is replaced.
    if (window.currentPlayingTrack && window.currentPlayingTrack !== trackEncoded) {
        rememberProgress({ force: true });
    }
    
    // Playback resolves by stable track ID through the catalogue, never by a
    // client-supplied path. Local tracks stream from this server; global
    // tracks resolve to a short-lived signed URL.
    const track = getLibraryTrack(trackEncoded);
    if (!track) {
        console.warn('Track is not in the catalogue:', trackEncoded);
        showToast('This track is no longer in your catalogue. Refresh to update.');
        return;
    }

    window.currentPlayingTrack = trackEncoded;
    window.currentPlayingSourceFolder = sourceFolder || currentFolder;
    window.currentPlayingAlbum = currentFolder; // Track which album user is playing from
    // Choosing a track again is a fresh attempt, not the same failure.
    window.playbackFailureFor = null;

    if (track.source === 'global') {
        // Resolve first, then play: the source is set when the URL arrives.
        // The URL is short-lived, so it is never cached beyond its lifetime and
        // is resolved again if it expires mid-session.
        currentsong.removeAttribute('src');
        playGlobalTrack(trackEncoded, pause, false);
    } else {
        // This device's own music, read by whatever can read this device.
        // Never through Supabase, so it plays with or without the internet.
        currentsong.src = resolveLocalStreamUrl(track);
    }

    renderPlaybarTrack(trackEncoded, track);

    // A new track starts at zero on screen until the audio says otherwise.
    resumeAppliedFor = null;
    updateProgressUI();
    applyResumePosition(trackEncoded);
    noteTrackStarted(trackEncoded);
    renderNowPlaying();
    updateMediaSessionMetadata();

    resetLibButtons();

    const btn = libButton || findLibButtonByTrack(trackEncoded);
    currentLibButton = btn || null;

    // The controls follow the audio element, so they are drawn now for the
    // track that is loading and again when playback actually starts or fails.
    // A global track is already on its way through playGlobalTrack().
    syncPlaybackUI();
    if (!pause && track.source !== 'global') {
        startAudioPlayback();
    }
    
    // Update like button state for the new song
    checkAndUpdateLikeButton();
}

/**
 * A single placeholder row for a list that has nothing in it.
 *
 * It reuses the track-card classes, so it lines up with real rows: same
 * height, border, radius and padding. It carries no track id and no play
 * control, so nothing here can be played or queued.
 */
function emptyLibraryCard(primary, secondary) {
    return `
        <li class="libcard empty-libcard bg-black p-1 m-1" aria-disabled="true">
            <img class="invert" src="${basePath}img/music.svg" alt="">
            <div class="musicinfo">
                <div>${escapeHTML(primary)}</div>
                <div>${escapeHTML(secondary)}</div>
            </div>
        </li>`;
}

/** Empty state shown when the local library has no indexed tracks. */
function showEmptyLibraryState() {
    const songslist = document.querySelector('.songslist ul');
    if (!songslist) return;
    songslist.innerHTML = `
        <li class="no-songs-message">
            <img class="invert" width="48" height="48" src="${basePath}img/music.svg" alt="">
            <p>Your music library is empty</p>
            <p>Add audio files to your music folder, then rescan the library</p>
        </li>`;
}

async function getAlbums() {
    // Use the refreshAlbumCards function for consistent rendering
    await refreshAlbumCards();
}

// ============================================
// The opening screen
//
// It is already on the page when this script runs - written into the document
// rather than built here - so the first thing painted is the splash and never
// a half-assembled player.
//
// What it waits for is deliberate. It covers the startup that has to happen
// anyway: reading what this device already knows and getting the player ready.
// It does not wait on Supabase. A slow catalogue is checked quietly behind a
// library that is already usable, because making somebody watch a logo while
// the network decides is the thing this is supposed to prevent.
//
// Two floors, because the two read differently: a phone is often opened for a
// moment, a desktop is settled into.
// ============================================

/**
 * How far along starting up is, from 0 to 1.
 *
 * Real milestones, not a loop. Each step of starting reports itself as it
 * finishes and the bar is widened to match, so what somebody watches is the
 * work actually completing. The weights are what a first run spends its time
 * on, roughly in proportion - reading what is stored, checking the catalogue,
 * loading the library, getting the player ready.
 *
 * The numbers are never shown. They decide a width and nothing else.
 */
const SPLASH_STEPS = {
    bootstrap: 0.05,
    storage: 0.2,
    catalogue: 0.35,
    library: 0.5,
    player: 0.65,
    content: 0.8,
    artwork: 0.9,
    ready: 1
};

/**
 * How long the finished bar is left on screen before the fade begins.
 *
 * Slightly longer than the width transition, so the bar is seen arriving at
 * the end rather than disappearing on its way there.
 */
const SPLASH_COMPLETE_MS = 460;

let splashProgress = 0;

/**
 * Report that a step of starting up has finished.
 *
 * Only ever forwards: a step that finishes out of order, or twice, cannot make
 * the bar go back. A step that completes instantly still shows as movement,
 * because the width is animated to its new value rather than set at it.
 */
function splashReached(step) {
    const target = SPLASH_STEPS[step];
    if (target === undefined || target <= splashProgress) return;

    splashProgress = target;

    const bar = document.querySelector('#appSplash .splash-progress-bar');
    if (bar) bar.style.width = Math.round(splashProgress * 100) + '%';
}

const SPLASH_MINIMUM_MOBILE_MS = 2000;
const SPLASH_MINIMUM_DESKTOP_MS = 3000;

// The width below which this is a phone. The same number the layout uses.
const SPLASH_MOBILE_WIDTH = 768;

/**
 * The mark that says Spotifie has been set up on this browser.
 *
 * Written once the first load has finished. Persisted rather than kept for a
 * session, because a refresh is not a new installation and must not be treated
 * as one. Clearing this site's data removes it along with everything else, and
 * the opening screen comes back - which is correct: at that point there really
 * is nothing here.
 */
const SPLASH_READY_KEY = 'spotifie_ready';

// When the page began. Read at once, so the floor is measured from the moment
// somebody opened Spotifie rather than from whenever this line ran.
const splashStartedAt = Date.now();

/**
 * Is the opening screen on this page at all?
 *
 * Decided in the document's head, before the first paint, and recorded on the
 * root element. Reading it here rather than deciding again means the script
 * and the stylesheet cannot disagree about whether this is a first run.
 */
function isFirstRun() {
    return document.documentElement.getAttribute('data-first-run') === 'yes';
}

/** How long the opening screen stays, at the size it is being read at. */
function splashMinimumMs() {
    const width = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : SPLASH_MOBILE_WIDTH;
    return width < SPLASH_MOBILE_WIDTH ? SPLASH_MINIMUM_MOBILE_MS : SPLASH_MINIMUM_DESKTOP_MS;
}

/** Remember that this browser has Spotifie set up, so it is not shown again. */
function rememberFirstRunComplete() {
    try {
        localStorage.setItem(SPLASH_READY_KEY, new Date().toISOString());
    } catch (e) {
        /* a browser that keeps nothing will show the opening screen again */
    }
}

/**
 * Take the opening screen away.
 *
 * Called once the library is up. Waits out whatever is left of the floor, then
 * fades - a cut would read as a glitch - and removes it from the page so it can
 * never sit invisibly over anything.
 *
 * Moving around inside the application does not bring it back: it belongs to
 * starting, and starting happens once per launch.
 */
function hideSplash() {
    // Whatever happens below, this browser has now had a working Spotifie on
    // it, and the next visit is a return rather than a first run.
    rememberFirstRunComplete();

    const splash = document.getElementById('appSplash');
    if (!splash || splash.dataset.leaving === 'yes') return Promise.resolve();

    splash.dataset.leaving = 'yes';

    // A returning visitor has no opening screen on the page. There is nothing
    // to fade and nothing to wait for: the floor exists so a first run does
    // not flash past, not to delay somebody who has been here before.
    if (!isFirstRun()) {
        splash.hidden = true;
        return Promise.resolve();
    }

    const remaining = Math.max(0, splashMinimumMs() - (Date.now() - splashStartedAt));

    return new Promise((resolve) => {
        setTimeout(() => {
            // Everything that had to happen has happened. The bar goes to the
            // end first and is given a moment to get there: a screen that
            // fades while the bar is still half full reads as having given up
            // rather than as having finished.
            splashReached('ready');

            setTimeout(() => {
                splash.classList.add('is-leaving');

                // Gone from the page, not merely transparent.
                const remove = () => {
                    splash.hidden = true;
                    resolve();
                };

                splash.addEventListener('transitionend', remove, { once: true });
                // A browser that skips the transition - reduced motion, or a
                // tab that was in the background - must still see it go.
                setTimeout(remove, 600);
            }, SPLASH_COMPLETE_MS);
        }, remaining);
    });
}

// ============================================
// Where a track's audio actually comes from
//
// One seam, named once, so the player never has to know. A song on this device
// is read by whatever can read this device's files; a published song is signed
// and fetched from storage. The player asks for audio and is given audio.
//
// Today the local half is this machine's own server, reached over loopback.
// Packaged later - as a desktop application, or a native one - that half is
// replaced by a platform adapter and nothing above this line changes. The
// browser is not pretended to have filesystem access it does not have: it asks
// something that does.
//
// The consequence that matters to a listener: music on this device does not go
// through Supabase to be played, so it does not stop when the internet does.
// ============================================

/**
 * The adapter that turns a local track id into something playable.
 *
 * Replaceable: a packaged build sets window.spotifieMediaAdapter before the
 * player starts, and local playback goes through that instead. The contract is
 * one function - given a track, answer a URL the audio element can play.
 */
function getMediaAdapter() {
    return (typeof window !== 'undefined' && window.spotifieMediaAdapter) || null;
}

/**
 * A local track's audio, from this device.
 *
 * The address the library gave for it, or whatever a platform adapter offers
 * instead. Nothing here reaches the network beyond this machine, and nothing
 * here needs an account to have been checked recently: the file is already
 * here, and playing it is not a thing that requires permission from a server
 * on the internet.
 */
function resolveLocalStreamUrl(track) {
    const adapter = getMediaAdapter();
    if (adapter && typeof adapter.resolveStreamUrl === 'function') {
        const url = adapter.resolveStreamUrl(track);
        if (url) return url;
    }

    return track ? track.streamUrl : null;
}

// ============================================
// Being offline
//
// Losing the internet is not losing Spotifie. The music on this device plays,
// the library it is in works, and the published catalogue stays on screen from
// the copy this device kept. What genuinely needs the network - the audio of a
// published song - says so when it is asked for, and only then.
//
// Said once, quietly, in one place. A banner that reappears every time a
// request fails is worse than no banner at all.
// ============================================

let networkAvailable = typeof navigator === 'undefined' || navigator.onLine !== false;

/** True when this machine believes it can reach the internet. */
function isOnline() {
    return networkAvailable;
}

/**
 * Keep the application itself, so it opens without the network.
 *
 * The worker holds the pages, styles, scripts and icons the interface is drawn
 * from - and no audio, from either source. Music on this device is read from
 * this device; published audio needs a connection and is not quietly
 * downloaded to pretend otherwise.
 *
 * Registered after the page is up, so fetching the shell never competes with
 * drawing it. A browser without service workers, or a page not served over a
 * secure origin, simply does not get one: everything still works, it just has
 * to be online to start.
 */
function initAppShellCache() {
    if (!('serviceWorker' in navigator)) return;

    // Secure contexts only, which localhost counts as.
    if (!window.isSecureContext) return;

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((error) => {
            // Not being able to keep a copy is not a failure worth interrupting
            // anybody for.
            console.warn('The offline app shell is unavailable:', error && error.message);
        });
    });
}

/**
 * Watch for the connection coming and going.
 *
 * The page is marked, so anything that wants to read differently offline can,
 * and a single quiet line is shown the first time it happens rather than a
 * popup each time something fails.
 */
/**
 * Catch what nothing else caught.
 *
 * A promise nobody handled, or an error thrown where no caller was waiting,
 * used to reach the console and stop there - which is fine for whoever wrote
 * the code and no use at all to whoever is looking at the page. Neither should
 * ever put a stack trace in front of somebody, and neither should be silent.
 *
 * So: one short line, said at most once in a while, in the words of what
 * actually stopped working. The details still go to the console, where they
 * belong. Nothing here reads a token, a path or anything out of a library.
 */
function initErrorBoundary() {
    let lastToldAt = 0;

    const tell = (message) => {
        const now = Date.now();
        // A page that has genuinely broken tends to break repeatedly. Saying so
        // forty times helps nobody.
        if (now - lastToldAt < 30000) return;
        lastToldAt = now;
        showToast(message);
    };

    const describe = (error) => {
        if (!error) return null;

        // The two that a person can act on, said in their own terms.
        const text = String((error && error.message) || error);
        if (/NetworkError|Failed to fetch|network/i.test(text)) {
            return 'Something could not be reached. Spotifie will try again.';
        }
        if (/QuotaExceeded|storage/i.test(text)) {
            return 'This browser is out of room to keep things in.';
        }
        return null;
    };

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event && event.reason;
        console.warn('Spotifie: an operation failed', reason);

        const message = describe(reason);
        if (message) tell(message);
    });

    window.addEventListener('error', (event) => {
        // A picture or a script that would not load is reported here too, and
        // is not something to interrupt anybody about: the resolver already
        // falls back, and the page carries on.
        if (event && event.target && event.target !== window) return;
        console.warn('Spotifie: ' + ((event && event.message) || 'an error occurred'));
    });
}

/** What this installation can do, or null in a page that did not load it. */
function getPlatform() {
    return window.spotifiePlatform || null;
}

/**
 * Say that the music on this device is out of reach, without losing it.
 *
 * The collection stays exactly where it is - the card, its name, and whatever
 * was last known about it. What changes is one line saying it cannot be
 * reached from here, because a collection that quietly emptied itself would
 * look like the music had gone rather than like the helper had.
 *
 * Nothing is deleted, nothing is forgotten, and the moment a helper answers
 * again the ordinary path puts the real contents back.
 */
function markLocalMusicUnavailable() {
    document.body.classList.add('local-music-unavailable');

    const card = document.querySelector('.local-music-card');
    if (!card) return;

    const line = card.querySelector('p');
    if (line) line.textContent = 'Not reachable from here';
    card.setAttribute('title', 'Spotifie is not running on this device, so the music on it cannot be read.');
}

/** And that it is reachable again. */
function markLocalMusicAvailable() {
    document.body.classList.remove('local-music-unavailable');

    const card = document.querySelector('.local-music-card');
    if (card) card.removeAttribute('title');
}

/**
 * Watch for a helper appearing or disappearing, and answer either.
 *
 * The looking backs off while there is nothing there, so a page left open
 * beside no helper costs a handful of requests rather than thousands, and it
 * looks again at once when somebody comes back to the tab - which is usually a
 * second after they started the helper.
 *
 * A helper that returns is used without a reload: the library is read again
 * and the music on the device simply reappears.
 */
function watchLocalHelper() {
    const platform = getPlatform();
    if (!platform) return;

    let connected = null;

    platform.watch(async (state) => {
        const nowConnected = state.localHelper === 'connected';
        if (nowConnected === connected) return;

        const first = connected === null;
        connected = nowConnected;
        if (first) return;

        if (!nowConnected) {
            platform.setLocalMusic('unavailable');
            markLocalMusicUnavailable();
            return;
        }

        // Back. Read what is here again, and put it on screen where it was.
        try {
            platform.setLocalMusic('available');
            markLocalMusicAvailable();
            await refreshAfterDeviceChange();
            showToast('Reconnected to this device');
        } catch (error) {
            console.warn('Could not read this device after reconnecting:', error && error.message);
        }
    });
}

function initOfflineState() {
    const apply = (online) => {
        if (networkAvailable === online) return;
        networkAvailable = online;

        document.body.classList.toggle('is-offline', !online);

        // One message per change of state, not one per failed request.
        showToast(
            online
                ? 'Back online'
                : 'Offline. Music on this device keeps playing; published songs need a connection.'
        );
    };

    document.body.classList.toggle('is-offline', !networkAvailable);

    window.addEventListener('online', () => apply(true));
    window.addEventListener('offline', () => apply(false));
}

async function main() {
    // Each of these says so as it finishes, and the bar on the opening screen
    // is widened to match. On a return visit there is no opening screen and
    // the reports go nowhere.
    splashReached('bootstrap');

    // Before anything else that can fail: what happens when something does.
    initErrorBoundary();

    // Initialize Theme first for immediate visual feedback
    initializeTheme();

    // Shuffle, repeat and volume are this listener's own; they are read before
    // anything can be played, so the first track already obeys them.
    loadPlayerPreferences();
    syncSequenceUI();
    syncVolumeUI();

    // Initialize Library Database
    await LibraryDB.init();
    splashReached('storage');

    // The library, as fast as this device can draw it: the copy it kept of the
    // published catalogue, joined to the music it can see for itself. On a
    // first visit there is no copy and the catalogue is read the usual way.
    const drewFromCache = await loadCatalogFromCache();
    splashReached('catalogue');

    if (!drewFromCache) {
        // Nothing was kept from a previous visit, so the catalogue has to be
        // read before there is anything to draw. The grid holds the shape of
        // itself while that happens, which is the one moment a placeholder is
        // the honest thing to show: there is genuinely nothing here yet.
        //
        // A visit that did draw from the copy skips this entirely - real cards
        // are already on screen, and covering them would be a step backwards.
        showLibrarySkeleton();
        await loadSongsConfig();
    }
    splashReached('library');

    // Work out whether there is an account before personal data is loaded
    await initAccountGating();

    // Liked songs, playlists and what they have been listening to. All of it
    // is theirs and all of it is on this machine; a guest has none of it.
    const personal = getPersonal();
    if (personal && isSignedIn()) await personal.load();
    watchPersonalLibrary();

    // Where this listener stopped in each track. Signed in it is their own;
    // as a guest it belongs to this machine. Never Supabase, either way.
    await loadTrackProgress();
    splashReached('player');

    // Load user-created albums from localStorage
    loadUserAlbums();

    // Initialize Liked Songs album (this loads the config from localStorage and creates the album if needed)
    await checkAndCreateLikedSongsAlbum();
    splashReached('content');
    
    // Load last selected folder (or default) with validation
    let lastFolder = localStorage.getItem('lastFolder');
    
    // Validate the folder and fall back to the first album the library has.
    // With an empty library there is nothing to select - and nothing is faked.
    if (!isValidFolder(lastFolder) || !predefinedSongs[lastFolder]) {
        const availableFolders = Object.keys(predefinedSongs);
        lastFolder = availableFolders.length > 0 ? availableFolders[0] : '';
    }
    
    if (lastFolder) {
        await getsongs(lastFolder);
    } else {
        songs = [];
        window.currentSongsMeta = [];
        showEmptyLibraryState();
    }

    await getAlbums();
    splashReached('artwork');

    // The library is on screen. That is what the opening screen was covering,
    // so it goes now - not at the end of this function, and not when the
    // network has finished. Everything below is finishing touches on a page
    // somebody can already use, and the device search that follows runs in the
    // background for as long as it needs.
    hideSplash();

    // Load first song but DO NOT autoplay (due to browser restrictions)
    if (songs.length > 0) {
        playmusic(songs[0], null, true);
    }
    
    // Initialize create album functionality
    initCreateAlbum();
    
    // Initialize delete confirmation modal
    initDeleteConfirmModal();
    
    // Initialize edit album modal
    initEditAlbumModal();
    
    // Initialize card size toggle
    initCardSizeToggle();
    
    // Initialize library management (like button, context menu, add to album)
    initLibraryManagement();

    // The library is up. Now check whether the published catalogue has moved
    // since the copy was made - quietly, and only redrawing if it has.
    if (drewFromCache) scheduleCatalogRevalidation();

    // Losing the connection changes what can be played, not whether the
    // application works. Said once, when it happens.
    initOfflineState();
    // A helper started, or stopped, after the page was opened.
    watchLocalHelper();
    initAppShellCache();

    // Searching this device for music: the controls, and the one-time question
    // for an account that has not been asked here yet.
    initDeviceScanControls();
    await initDeviceMusicScan();

    /* ---------- Play/Pause (playbar button) ---------- */
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            togglePlayback();
        });
    }

    /* ---------- Shuffle and repeat ---------- */
    if (shuffleBtn) shuffleBtn.addEventListener('click', () => toggleShuffle());
    if (repeatBtn) repeatBtn.addEventListener('click', () => cycleRepeatMode());

    /* ---------- Now Playing, and the album detail behind it ---------- */
    initNavigation();
    initCardMenuPlacement();
    initNowPlaying();
    initAlbumDetail();
    initMediaSession();
    initSeekbars();

    /* ---------- Time / Seekbar ---------- */
    // Progress is text and two widths; nothing else is redrawn here, so a long
    // library stays as responsive while playing as it is while idle.
    currentsong.addEventListener('timeupdate', () => {
        updateProgressUI();
        rememberProgress({});
    });

    /**
     * Note that a song was played, once it actually is being played.
     *
     * On 'playing', not on choosing a track and not on every timeupdate: what
     * is being recorded is that somebody listened to something, which happens
     * once per song rather than four times a second. Pausing and resuming the
     * same track is the same listen, so the id is remembered and a repeat of
     * it is not written again.
     */
    currentsong.addEventListener('playing', () => {
        const track = getCurrentEncodedTrack();
        if (!track || track === lastNotedPlay) return;

        lastNotedPlay = track;

        const personal = getPersonal();
        if (personal) personal.notePlayed(track);
    });

    currentsong.addEventListener('loadedmetadata', () => updateProgressUI());
    currentsong.addEventListener('durationchange', () => updateProgressUI());
    currentsong.addEventListener('pause', () => rememberProgress({ force: true }));

    /* ---------- What happens when a track ends, or will not play ---------- */
    currentsong.addEventListener('error', () => {
        handleGlobalPlaybackError();
        handlePlaybackFailure();
    });

    currentsong.addEventListener('ended', () => {
        // The end of a track is where the position stops meaning anything, so
        // it is forgotten before anything else happens.
        rememberProgress({ force: true });
        playNextTrack({ ended: true });
    });

    /* ---------- Next / Previous (buttons) ---------- */
    if (nextBtn) nextBtn.addEventListener('click', () => playNextTrack({ ended: false }));
    if (prevBtn) prevBtn.addEventListener('click', () => playPreviousTrack());

    /* ---------- Leaving: keep where everyone got to ---------- */
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') rememberProgress({ force: true, onExit: true });
    });
    window.addEventListener('pagehide', () => rememberProgress({ force: true, onExit: true }));

    /* ---------- Keyboard controls ---------- */
    document.addEventListener('keydown', (event) => {
        // Don't trigger playback controls when user is typing in input fields
        const activeElement = document.activeElement;
        const isTyping = activeElement && (
            activeElement.tagName === 'INPUT' || 
            activeElement.tagName === 'TEXTAREA' || 
            activeElement.isContentEditable
        );
        
        if (isTyping) return; // Allow normal typing in input fields
        
        if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            togglePlayback();
        }

        // Ctrl + Arrow keys for seeking forward/backward (5 seconds)
        if (event.ctrlKey && event.key === 'ArrowLeft') {
            event.preventDefault();
            if (!isNaN(currentsong.duration)) {
                currentsong.currentTime = Math.max(0, currentsong.currentTime - 5);
            }
        }

        if (event.ctrlKey && event.key === 'ArrowRight') {
            event.preventDefault();
            if (!isNaN(currentsong.duration)) {
                currentsong.currentTime = Math.min(currentsong.duration, currentsong.currentTime + 5);
            }
        }

        // Arrow keys (without Ctrl) for previous/next song
        if (!event.ctrlKey && event.key === 'ArrowLeft') {
            event.preventDefault();
            playPreviousTrack();
        }

        if (!event.ctrlKey && event.key === 'ArrowRight') {
            event.preventDefault();
            playNextTrack({ ended: false });
        }

        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setPlayerVolume(currentsong.volume + (event.key === 'ArrowUp' ? 0.1 : -0.1));
        }
    });

    /* ---------- Volume ---------- */
    document.querySelectorAll('.volumeRange').forEach((slider) => {
        const applyVol = (e) => setPlayerVolume(parseInt(e.target.value, 10) / 100);
        slider.addEventListener('change', applyVol);
        slider.addEventListener('input', applyVol);
    });

    if (volumeBtn) {
        volumeBtn.addEventListener('click', () => {
            // Where the slider opens instead, muting is a press inside it.
            if (volumeSliderIsBeside()) toggleMute();
        });
    }
    initVolumePopover();

    /* ---------- Sidebar (hamburger/close) ---------- */
    const hamburger = document.querySelector('.hamburger');
    if (hamburger) hamburger.addEventListener('click', () => openSidebar());

    const closeBtn = document.querySelector('.close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeSidebar());

    const sidebarBackdrop = document.getElementById('sidebarBackdrop');
    if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => closeSidebar());

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
            closeSidebar();
        }
    });

    // Volume control with mouse wheel
    const volumeControl = document.querySelector('.volumeRange');
    if (volumeControl) {
        volumeControl.addEventListener('wheel', (e) => {
            e.preventDefault();
            setPlayerVolume(currentsong.volume + (e.deltaY < 0 ? 0.05 : -0.05));
        });
    }

    // Initialize search functionality
    initSearch();
    
    // Initialize sidebar navigation
    initSidebarNav();
}

/* ========== SIDEBAR NAVIGATION ========== */

function initSidebarNav() {
    const sidebarHome = document.getElementById('sidebarHome');
    const sidebarSearch = document.getElementById('sidebarSearch');
    const searchInput = document.getElementById('searchInput');
    
    // Home button - scroll to top and show all albums
    if (sidebarHome) {
        sidebarHome.addEventListener('click', () => {
            // Update active state
            updateSidebarActive('home');

            // Home is the library, so an open album closes - through the
            // navigation manager, so Back can bring it straight back.
            closeAlbumDetail();
            
            // Clear search if any
            if (searchInput) {
                searchInput.value = '';
                hideSearchResults();
                const clearBtn = document.getElementById('clearSearch');
                if (clearBtn) clearBtn.classList.add('hidden');
            }
            
            // Scroll playlist area to top
            const cardsArea = document.querySelector('.cardsarea');
            if (cardsArea) {
                cardsArea.scrollTo({ top: 0, behavior: 'smooth' });
            }
            
            // Close sidebar on mobile
            closeSidebarOnMobile();
        });
    }
    
    // Search button - focus on search input
    if (sidebarSearch) {
        sidebarSearch.addEventListener('click', () => {
            // Update active state
            updateSidebarActive('search');
            
            // Focus on search input
            if (searchInput) {
                searchInput.focus();
                
                // If there's already text, show results
                if (searchInput.value.trim().length > 0) {
                    performSearch(searchInput.value.trim());
                }
            }
            
            // Close sidebar on mobile
            closeSidebarOnMobile();
        });
    }
}

function updateSidebarActive(active) {
    const sidebarHome = document.getElementById('sidebarHome');
    const sidebarSearch = document.getElementById('sidebarSearch');
    
    if (sidebarHome && sidebarSearch) {
        if (active === 'home') {
            sidebarHome.classList.remove('color-2');
            sidebarHome.classList.add('sidebar-active');
            sidebarSearch.classList.add('color-2');
            sidebarSearch.classList.remove('sidebar-active');
        } else if (active === 'search') {
            sidebarSearch.classList.remove('color-2');
            sidebarSearch.classList.add('sidebar-active');
            sidebarHome.classList.add('color-2');
            sidebarHome.classList.remove('sidebar-active');
        }
    }
}

/**
 * The sidebar, on a screen too narrow to keep it open.
 *
 * It slides over the page rather than pushing it, so opening and closing it
 * moves nothing underneath: one class on the page says which it is, and the
 * stylesheet does the rest. Nothing here writes a position onto the element,
 * which is what used to leave the drawer stuck half-open after a resize.
 */
function openSidebar() {
    document.body.classList.add('sidebar-open');

    const backdrop = document.getElementById('sidebarBackdrop');
    if (backdrop) backdrop.hidden = false;

    const hamburger = document.querySelector('.hamburger');
    if (hamburger) hamburger.setAttribute('aria-expanded', 'true');

    const close = document.querySelector('.close');
    if (close && close.focus) close.focus();
}

function closeSidebar() {
    document.body.classList.remove('sidebar-open');

    const backdrop = document.getElementById('sidebarBackdrop');
    if (backdrop) backdrop.hidden = true;

    const hamburger = document.querySelector('.hamburger');
    if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
}

function closeSidebarOnMobile() {
    if (window.innerWidth <= 1400) closeSidebar();
}

/* ========== SEARCH FUNCTIONALITY ========== */

// Search state
let searchTimeout = null;
let selectedResultIndex = -1;
let currentSearchResults = [];

function initSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    const clearSearch = document.getElementById('clearSearch');
    
    if (!searchInput || !searchResults) return;
    
    // Handle input changes with debounce
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        // Show/hide clear button
        if (clearSearch) {
            if (query.length > 0) {
                clearSearch.classList.remove('hidden');
            } else {
                clearSearch.classList.add('hidden');
            }
        }
        
        // Debounce search
        clearTimeout(searchTimeout);
        
        if (query.length === 0) {
            hideSearchResults();
            return;
        }
        
        // Show loading state
        showSearchLoading();
        
        searchTimeout = setTimeout(() => {
            performSearch(query);
        }, 150); // Quick response for instant feel
    });
    
    // Handle keyboard navigation
    searchInput.addEventListener('keydown', (e) => {
        if (!searchResults.classList.contains('active')) return;
        
        const items = searchResults.querySelectorAll('.search-result-item');
        
        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectedResultIndex = Math.min(selectedResultIndex + 1, items.length - 1);
                updateSelectedResult(items);
                break;
            case 'ArrowUp':
                e.preventDefault();
                selectedResultIndex = Math.max(selectedResultIndex - 1, 0);
                updateSelectedResult(items);
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedResultIndex >= 0 && items[selectedResultIndex]) {
                    items[selectedResultIndex].click();
                } else if (items.length > 0) {
                    items[0].click();
                }
                break;
            case 'Escape':
                hideSearchResults();
                searchInput.blur();
                break;
        }
    });
    
    // Clear search button
    if (clearSearch) {
        clearSearch.addEventListener('click', () => {
            searchInput.value = '';
            clearSearch.classList.add('hidden');
            hideSearchResults();
            searchInput.focus();
        });
    }
    
    // Close search results when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            hideSearchResults();
        }
    });
    
    // Show results when focusing on input with existing text
    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim().length > 0 && currentSearchResults.length > 0) {
            showSearchResults();
        }
    });
}

function showSearchLoading() {
    const searchResults = document.getElementById('searchResults');
    if (!searchResults) return;
    
    searchResults.innerHTML = `
        <div class="search-loading">
            <div class="search-loading-spinner"></div>
            <div>Searching...</div>
        </div>
    `;
    searchResults.classList.add('active');
}

// ============================================
// Searching
//
// Everything searchable is written down once, in one flat list, and searched
// from there: the songs on this device and the songs an administrator
// published, the albums both make, the playlists somebody built, and the
// artists all of it turns out to be by.
//
// It is built when the library changes and not when somebody types. Typing a
// word used to walk every album asking storage what was in it, on every
// keystroke; now a keystroke is a pass over an array of strings that were
// prepared once. Nothing here goes anywhere near the network - not on the
// first letter and not on any of them.
// ============================================

/** The prepared list, and a stamp saying which library it was prepared from. */
let searchIndex = null;
let searchIndexStamp = '';

/** Text reduced to what a search should match on. */
function normalizeForSearch(value) {
    return String(value === undefined || value === null ? '' : value)
        .toLowerCase()
        .normalize('NFD')
        // Accents are how a word is written, not which word it is: searching
        // for "bjork" should find "Björk".
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * What the library looks like right now, in one short string.
 *
 * Which collections there are and how big each one is. Unchanged means the
 * index that was built from it is still the truth, and nothing is rebuilt.
 */
function libraryStamp() {
    const parts = [];
    Object.keys(predefinedSongs)
        .sort()
        .forEach((folder) => {
            parts.push(folder + ':' + (predefinedSongs[folder] || []).length);
        });
    return parts.join('|');
}

/**
 * Build the searchable list, if the library has moved since it was last built.
 *
 * Every entry carries the text it matches on already normalized, so searching
 * is a comparison and never a transformation.
 */
function ensureSearchIndex() {
    const stamp = libraryStamp();
    if (searchIndex && stamp === searchIndexStamp) return searchIndex;

    const entries = [];
    const artists = new Map();
    const seenTracks = new Set();

    for (const folder of Object.keys(predefinedSongs)) {
        const info = albumInfo[folder] || { title: folder.split('/').pop(), artist: '' };

        const albumTitle = info.title || '';
        const albumArtist = albumCardArtist(info);

        entries.push({
            kind: info.isPlaylist ? 'playlist' : 'album',
            folder: folder,
            title: albumTitle,
            artist: albumArtist,
            cover: stableArtworkReference(info.cover) || '',
            haystack: normalizeForSearch(albumTitle + ' ' + albumArtist + ' ' + (info.description || ''))
        });

        for (const trackId of predefinedSongs[folder] || []) {
            const track = getLibraryTrack(trackId);
            if (!track || track.missing) continue;

            // An artist is a group of tracks, gathered as the tracks are read
            // rather than from a table of artists that would have to be kept
            // in step with them.
            const artistName = track.artist || 'Unknown Artist';
            if (!artists.has(artistName)) {
                artists.set(artistName, { count: 0, folder: folder });
            }
            artists.get(artistName).count += 1;

            // The same song listed under two collections is one song to find.
            const key = trackId + '::' + folder;
            if (seenTracks.has(key)) continue;
            seenTracks.add(key);

            entries.push({
                kind: 'song',
                folder: folder,
                trackId: trackId,
                title: track.title || trackDisplayTitle(trackId),
                artist: track.artist || '',
                album: track.album || albumTitle,
                cover: track.hasArtwork ? track.artworkUrl : info.cover || '',
                haystack: normalizeForSearch(
                    [track.title, track.artist, track.album, track.albumArtist].filter(Boolean).join(' ')
                )
            });
        }
    }

    artists.forEach((detail, name) => {
        entries.push({
            kind: 'artist',
            name: name,
            folder: detail.folder,
            trackCount: detail.count,
            haystack: normalizeForSearch(name)
        });
    });

    searchIndex = entries;
    searchIndexStamp = stamp;
    return searchIndex;
}

/** Throw the index away, so the next search builds it again. */
function forgetSearchIndex() {
    searchIndex = null;
    searchIndexStamp = '';
}

/**
 * Search the library for what somebody typed.
 *
 * Over the prepared list, so a keystroke costs a pass over strings that were
 * normalized once. Songs, albums, playlists and artists all come out of the
 * same pass, because they are all in the same list.
 */
async function performSearch(query) {
    const results = {
        songs: [],
        albums: [],
        artists: []
    };

    const queryLower = normalizeForSearch(query);
    const queryWords = queryLower.split(/\s+/).filter((word) => word.length > 0);

    if (!queryWords.length) {
        currentSearchResults = [];
        selectedResultIndex = -1;
        displaySearchResults(results, query);
        return;
    }

    const raw = query.toLowerCase();
    const rawWords = raw.split(/\s+/).filter((word) => word.length > 0);

    for (const entry of ensureSearchIndex()) {
        const score = calculateMatchScore(entry.haystack, queryWords, queryLower);
        if (score <= 0) continue;

        if (entry.kind === 'song') {
            results.songs.push({
                type: 'song',
                folder: entry.folder,
                file: entry.trackId,
                title: entry.title,
                artist: entry.artist,
                album: entry.album,
                cover: entry.cover,
                matchScore: score,
                matchedText: highlightMatch(entry.title, rawWords),
                isUserAdded: false,
                sourceFolder: entry.folder
            });
            continue;
        }

        if (entry.kind === 'artist') {
            results.artists.push({
                type: 'artist',
                name: entry.name,
                folder: entry.folder,
                trackCount: entry.trackCount,
                matchScore: score,
                matchedText: highlightMatch(entry.name, rawWords)
            });
            continue;
        }

        results.albums.push({
            type: 'album',
            folder: entry.folder,
            title: entry.title,
            artist: entry.artist,
            cover: entry.cover,
            isPlaylist: entry.kind === 'playlist',
            matchScore: score,
            matchedText: highlightMatch(entry.title, rawWords)
        });
    }

    // Sort by match score (higher is better)
    results.albums.sort((a, b) => b.matchScore - a.matchScore);
    results.songs.sort((a, b) => b.matchScore - a.matchScore);
    results.artists.sort((a, b) => b.matchScore - a.matchScore);

    // Limit results
    results.albums = results.albums.slice(0, 4);
    results.songs = results.songs.slice(0, 8);
    results.artists = results.artists.slice(0, 3);

    currentSearchResults = [...results.albums, ...results.songs];
    selectedResultIndex = -1;

    displaySearchResults(results, query);
}

function calculateMatchScore(text, queryWords, fullQuery) {
    const textLower = text.toLowerCase();
    let score = 0;
    
    // Exact match bonus
    if (textLower.includes(fullQuery)) {
        score += 100;
        // Start of string bonus
        if (textLower.startsWith(fullQuery)) {
            score += 50;
        }
    }
    
    // Word matching
    for (const word of queryWords) {
        if (textLower.includes(word)) {
            score += 10;
            // Start of word bonus
            if (textLower.startsWith(word) || textLower.includes(' ' + word)) {
                score += 5;
            }
        }
    }
    
    return score;
}

function highlightMatch(text, queryWords) {
    let result = escapeHTML(text);
    
    // Sort words by length (longest first) to avoid partial replacements
    const sortedWords = [...queryWords].sort((a, b) => b.length - a.length);
    
    for (const word of sortedWords) {
        const regex = new RegExp(`(${escapeRegex(word)})`, 'gi');
        result = result.replace(regex, '<span class="highlight">$1</span>');
    }
    
    return result;
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function displaySearchResults(results, query) {
    const searchResults = document.getElementById('searchResults');
    if (!searchResults) return;
    
    const artists = results.artists || [];
    const totalResults = results.albums.length + results.songs.length + artists.length;
    
    if (totalResults === 0) {
        searchResults.innerHTML = `
            <div class="no-results">
                <div class="no-results-icon">🔍</div>
                <div class="no-results-text">No results found for "${escapeHTML(query)}"</div>
                <div class="no-results-text" style="margin-top: 8px; font-size: 12px; color: #727272;">
                    Try different keywords or check the spelling
                </div>
            </div>
        `;
        searchResults.classList.add('active');
        return;
    }
    
    let html = '';
    
    // Albums and playlists: both are collections, and both are named by what
    // they are so a reader can tell them apart at a glance.
    if (results.albums.length > 0) {
        const playlists = results.albums.filter((album) => album.isPlaylist);
        const albums = results.albums.filter((album) => !album.isPlaylist);

        if (albums.length > 0) {
            html += '<div class="search-results-header">Albums</div>';
            for (const album of albums) html += createAlbumResultHTML(album);
        }

        if (playlists.length > 0) {
            html += '<div class="search-results-header">Playlists</div>';
            for (const playlist of playlists) html += createAlbumResultHTML(playlist);
        }
    }

    // Artists, worked out from the songs themselves.
    if (artists.length > 0) {
        html += '<div class="search-results-header">Artists</div>';
        for (const artist of artists) html += createArtistResultHTML(artist);
    }
    
    // Songs section
    if (results.songs.length > 0) {
        html += '<div class="search-results-header">Songs</div>';
        for (const song of results.songs) {
            html += createSongResultHTML(song);
        }
    }
    
    searchResults.innerHTML = html;
    searchResults.classList.add('active');
    
    // Bind click events
    bindSearchResultEvents();
}

// ==================== What an album looks like ====================
//
// One resolver, asked by every part of the page that shows a cover: the grid,
// the album view, the playbar, Now Playing, the search results, the dialogs.
// They differ in which element they paint, never in how the picture is found.
//
// An album keeps a stable reference and never a picture:
//  - a local cover this machine serves, at /api/library/artwork/<id>
//  - a scanned album's own artwork, at a library endpoint
//  - a published album's artwork, which lives in private storage and needs a
//    short-lived signed URL fetched when it is wanted
//
// The signed URL is asked for at the moment it is needed and is never written
// down, so an expired one is simply asked for again. Anything that is not a
// picture this browser can load - a filesystem path from an older version, a
// blob from a previous visit, a picture encoded inline - is not shown at all:
// the default cover takes its place.

const DEFAULT_COVER_SRC = 'img/music.svg';

function defaultCoverSrc() {
    return basePath + DEFAULT_COVER_SRC;
}

/** True for a value that is a filesystem path rather than a URL. */
function looksLikeFilePath(value) {
    if (typeof value !== 'string') return false;
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('file:');
}

/**
 * A reference the browser can load as a picture, or null.
 *
 * The catalogue's own artwork endpoints answer with a signed URL in JSON
 * rather than with an image, so one of those is a reference to resolve, not
 * something to point an <img> at.
 */
function usableArtworkUrl(value) {
    if (typeof value !== 'string') return null;

    const cover = value.trim();
    if (!cover) return null;

    // Not a picture: a place on a disk, a handle from a previous visit, or a
    // picture written into the page itself.
    if (looksLikeFilePath(cover)) return null;
    if (cover.startsWith('blob:') || cover.startsWith('data:')) return null;

    // Anything naming a scheme must name one that fetches a picture. A cover
    // arrives as metadata - from a file's tags, from a catalogue row, from
    // something a person typed - so a scheme that runs code instead of
    // fetching bytes is refused here rather than handed to the browser.
    if (/^[a-z][a-z0-9+.-]*:/i.test(cover) && !/^https?:\/\//i.test(cover)) return null;

    // The catalogue serves published covers from this origin, and that
    // address is a picture: it may be pointed at directly and the browser
    // keeps it like any other image. Its neighbour without /image answers
    // with a signed address instead of a picture, and is not usable here.
    if (/^\/api\/catalog\/(albums|tracks)\/[^/]+\/artwork\/image(\?|$)/.test(cover)) return cover;
    if (/^\/api\/catalog\//.test(cover)) return null;

    if (cover.startsWith('/') || cover.startsWith('http')) return cover;
    return basePath + cover;
}

/** Kept for the few places that hold a plain asset reference. */
function resolveArtworkSrc(cover) {
    return usableArtworkUrl(cover) || defaultCoverSrc();
}

/**
 * A reference that is still going to mean something tomorrow, or null.
 *
 * Only a stable reference may be written down - the id of a picture this
 * machine holds, or the catalogue endpoint that will sign a published one
 * afresh. A resolved address is temporary by nature: it carries a signature,
 * it expires, and stored anywhere it becomes a picture that loads once and is
 * broken ever after. Anything absolute, and anything carrying a query, is
 * treated as one of those and refused.
 */
function stableArtworkReference(value) {
    if (typeof value !== 'string') return null;

    const reference = value.trim();
    if (!reference) return null;

    // A place on a disk, a handle from a previous visit, or a picture written
    // into the page: none of these are references at all.
    if (looksLikeFilePath(reference)) return null;
    if (reference.startsWith('blob:') || reference.startsWith('data:')) return null;

    // Somewhere else entirely, which is where a signed address lives.
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) return null;

    // A signature, a ticket or an expiry, on an address that would otherwise
    // look local.
    if (reference.indexOf('?') !== -1 || reference.indexOf('#') !== -1) return null;

    return reference;
}

/**
 * The cover to show this instant: a listener's own picture for the album if
 * they have set one, otherwise whatever can be shown without asking anything.
 * Never empty, so nothing is ever painted as a blank square.
 */
function albumCoverSrcNow(info) {
    if (!info) return defaultCoverSrc();
    return usableArtworkUrl(info.cover) || defaultCoverSrc();
}

/** The same answer, or null when there is no picture of the album's own. */
function albumCoverIfAny(info) {
    return info ? usableArtworkUrl(info.cover) : null;
}

/**
 * The picture for one album, resolved as far as it can be.
 *
 * In order: the listener's own cover for this album, then the album's own,
 * then the first song in it that carries one, then the default. A published
 * album's artwork is signed here and now; nothing about it is kept.
 */
/**
 * The one resolver: the picture for a song, an album, or both.
 *
 * In order - the song's own picture, then the album's, then the first song in
 * that album carrying one. A published album keeps only a path in the
 * catalogue, so the address to read it with is made here and now; it is never
 * written back onto the album, into the page's state, into navigation, or into
 * anything that outlives the request.
 *
 * Answers with null when there is nothing, which is the caller's cue to show
 * the default rather than an empty square.
 */
async function resolveArtwork(request) {
    const settings = request || {};
    const folder = settings.folder || null;
    const client = getCatalogClient();

    // ---- the song's own picture ----
    const track = settings.trackId ? getLibraryTrack(settings.trackId) : null;
    if (track) {
        const own = usableArtworkUrl(track.artworkUrl);
        if (own) return own;

        // A published song keeps only a path, the same as a published album.
        const hasOwn = track.metadata ? track.metadata.hasArtwork !== false : true;
        if (client && track.source === 'global' && hasOwn) {
            const published = publishedArtworkUrl(client, settings.trackId, 'track', track.metadata);
            if (published) return published;

            // A client too old to know that address still has the older way,
            // which asks for a signed one. Slower, and good for an hour.
            const signed = await signArtwork(client, settings.trackId, 'track');
            if (signed) return signed;
        }
    }

    // ---- the album's ----
    const info =
        settings.info ||
        (track && track.albumId ? albumInfo[libraryFolderForAlbum(track.albumId)] : null) ||
        (folder ? albumInfo[folder] : null);

    if (info) {
        // A cover this machine serves - a local album's, or the one a listener
        // set for a published album - needs nothing fetched.
        const own = usableArtworkUrl(info.cover);
        if (own) return own;

        if (client && info.source === 'global' && info.albumId && info.hasArtwork !== false) {
            const published = publishedArtworkUrl(client, info.albumId, 'album', {
                artworkVersion: info.artworkVersion
            });
            if (published) return published;

            const signed = await signArtwork(client, info.albumId, 'album');
            if (signed) return signed;
        }
    }

    // ---- the first song in the album that carries one ----
    const albumFolder =
        folder || (track && track.albumId ? libraryFolderForAlbum(track.albumId) : null) || (info ? info.folder : null);
    const fromTrack = firstTrackArtwork(albumFolder);
    if (fromTrack) return fromTrack;

    return null;
}

/**
 * Where this origin serves a published cover.
 *
 * The address carries which picture it is, so the browser keeps the one it has
 * already fetched and asks again only when the cover itself has been replaced.
 * Nothing is signed here and nothing is fetched: this is an address, worked
 * out from what the catalogue already said about the item.
 */
function publishedArtworkUrl(client, id, kind, metadata) {
    if (!client || typeof client.artworkImageUrl !== 'function' || !id) return null;

    const version = metadata && metadata.artworkVersion ? metadata.artworkVersion : null;
    return usableArtworkUrl(client.artworkImageUrl(id, { kind: kind, version: version }));
}

/** Ask the catalogue for a usable address, or null. Nothing is kept here. */
async function signArtwork(client, id, kind) {
    try {
        const url = await client.resolveArtworkUrl(id, { kind: kind, fallback: null });
        return usableArtworkUrl(url);
    } catch (e) {
        return null;
    }
}

/** The album branch on its own, for callers that have an album and no song. */
async function resolveAlbumArtwork(info, folder) {
    const url = await resolveArtwork({ info: info, folder: folder });
    return url || defaultCoverSrc();
}

/** The first picture carried by any song in an album, or null. */
function firstTrackArtwork(folder) {
    const ids = folder ? predefinedSongs[folder] || [] : [];

    for (const id of ids.slice(0, 24)) {
        const track = getLibraryTrack(id);
        const artwork = track ? usableArtworkUrl(track.artworkUrl) : null;
        if (artwork) return artwork;
    }
    return null;
}

/**
 * Point one <img> at an album.
 *
 * The picture that can be shown straight away goes up first, so a refresh
 * never leaves an empty square while something is being fetched; the resolved
 * one replaces it when it arrives. A picture that fails to load falls back to
 * the default, so a broken image cannot be left on screen either.
 *
 * The element records which album it is showing, so an answer that arrives
 * after the page has moved on is discarded rather than painted over whatever
 * is there now.
 */
// Every request to paint a picture gets a number. An answer is only used if
// its element is still waiting for that same request, so an album opened and
// closed quickly can never have its picture painted over the next one's.
let artworkRequests = 0;

/** Show the default picture, and remember that it is what is showing. */
function showDefaultArtwork(image) {
    image.dataset.artworkState = 'default';
    image.dataset.artworkUrl = '';
    image.src = defaultCoverSrc();
}

/**
 * Point one <img> at a picture that has to be resolved.
 *
 * The default goes up first, so no element is ever given an empty or
 * unresolved source and nothing is ever a blank square. The resolved picture
 * replaces it only once there is one.
 *
 * A picture that fails to load is not simply given up on: the address that
 * failed is dropped from the resolver's memory and the resolution is tried
 * once more, in case it was an address that had expired. Only then does the
 * default stand. The default failing ends it - there is nothing further to
 * try, and retrying it would loop.
 */
function paintResolvedArtwork(image, key, resolve, forget) {
    if (!image) return;

    const token = String((artworkRequests += 1));
    image.dataset.artworkKey = key || '';
    image.dataset.artworkToken = token;
    image.dataset.artworkRetried = '';

    const apply = (url) => {
        if (image.dataset.artworkToken !== token) return;
        if (!usableArtworkUrl(url)) {
            showDefaultArtwork(image);
            return;
        }
        image.dataset.artworkState = 'resolved';
        image.dataset.artworkUrl = url;
        image.src = url;
    };

    // The handler stays in place for the life of the element: a second failure
    // has to be caught too, or the browser's own broken-picture mark is left
    // on screen.
    image.onerror = () => {
        if (image.dataset.artworkState === 'default') return;

        const failed = image.dataset.artworkUrl || '';
        showDefaultArtwork(image);

        // An address that did not load is not one to hand out again.
        if (typeof forget === 'function') forget();

        if (image.dataset.artworkRetried === 'yes') return;
        image.dataset.artworkRetried = 'yes';

        Promise.resolve(resolve())
            .then((url) => {
                if (image.dataset.artworkToken !== token) return;
                // The same address again would fail the same way.
                if (!url || url === failed) return;
                apply(url);
            })
            .catch(() => {
                /* the default is already showing */
            });
    };

    showDefaultArtwork(image);

    Promise.resolve(resolve())
        .then(apply)
        .catch(() => {
            if (image.dataset.artworkToken === token) showDefaultArtwork(image);
        });
}

/**
 * Point one <img> at an album's picture.
 *
 * The album is named by its stable folder id; everything about how it looks is
 * worked out again from that, so nothing resolved is carried between renders.
 */
function paintAlbumArtwork(image, info, folder) {
    if (!image) return;

    const key = folder || (info && info.albumId) || '';
    paintResolvedArtwork(
        image,
        key,
        () => resolveArtwork({ info: info, folder: folder }),
        () => forgetArtworkFor({ info: info })
    );
}

/** Drop whatever the resolver remembers about these, so the next ask is fresh. */
function forgetArtworkFor(subject) {
    const client = getCatalogClient();
    if (!client || typeof client.forgetArtwork !== 'function') return;

    const settings = subject || {};
    if (settings.trackId) client.forgetArtwork(settings.trackId);
    if (settings.info && settings.info.albumId) client.forgetArtwork(settings.info.albumId);
    if (settings.albumId) client.forgetArtwork(settings.albumId);
}

/**
 * Point one <img> at a song: its own picture, then its album's, then the
 * default - with the same guarantees about blanks and broken images.
 */
/**
 * Point one <img> at a song's picture.
 *
 * The song is named by its stable id, and the picture is worked out from that
 * every time: the playbar never copies whatever a card happens to be showing.
 */
function paintTrackArtwork(image, trackId, folder) {
    if (!image) return;

    const track = trackId ? getLibraryTrack(trackId) : null;
    const albumFolder = track && track.albumId ? libraryFolderForAlbum(track.albumId) : folder;

    paintResolvedArtwork(
        image,
        trackId || '',
        () => (trackId ? resolveArtwork({ trackId: trackId, folder: albumFolder || folder }) : Promise.resolve(null)),
        () => forgetArtworkFor({ trackId: trackId, info: albumInfo[albumFolder] || albumInfo[folder] })
    );
}

/**
 * Resolve an album cover to a displayable URL.
 * Same resolver for the album card and the edit dialog, so both always show
 * the same picture.
 */
/**
 * Store an image for one of this person's own albums.
 * The file stays on this device and the album keeps only the returned id, so
 * nothing binary is written to browser storage and nothing reaches Supabase.
 */
async function saveLocalAlbumArtwork(file) {
    const response = await fetch('/api/library/artwork', {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
        credentials: 'same-origin'
    });

    if (!response.ok) {
        let message = 'Could not save the cover image';
        try {
            const body = await response.json();
            if (body && body.error) message = body.error;
        } catch (e) {
            /* keep the generic message */
        }
        throw new Error(message);
    }

    const stored = await response.json();
    return stored.url;
}

function createAlbumResultHTML(album) {
    // An album found by searching shows what it can straight away; the row is
    // painted properly once it is in the page.
    const coverSrc = albumCoverSrcNow(album);
    return `
        <div class="search-result-item album" data-type="album" data-folder="${escapeHTML(album.folder)}">
            <img src="${escapeHTML(coverSrc)}" alt="${escapeHTML(album.title)}" onerror="this.src='${basePath}img/music.svg'">
            <div class="search-result-info">
                <div class="search-result-title">${album.matchedText}</div>
                <div class="search-result-meta">
                    <span class="search-result-type">Album</span>
                    ${album.artist ? `<span>${escapeHTML(album.artist)}</span>` : ''}
                </div>
            </div>
            <div class="search-result-play">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 20V4L19 12L5 20Z"/>
                </svg>
            </div>
        </div>
    `;
}

/**
 * One artist in the search results.
 *
 * The same row as everything else, because it is the same list. What it opens
 * is the collection that artist's songs were found in, which is the nearest
 * thing to an artist page the library already has.
 */
function createArtistResultHTML(artist) {
    const count = artist.trackCount === 1 ? '1 song' : artist.trackCount + ' songs';

    return `
        <div class="search-result-item artist" data-type="artist" data-folder="${escapeHTML(artist.folder)}">
            <img src="${basePath}img/music.svg" alt="" class="invert" onerror="this.onerror=null;this.src='${basePath}img/music.svg'">
            <div class="search-result-info">
                <div class="search-result-title">${artist.matchedText}</div>
                <div class="search-result-meta">
                    <span class="search-result-type">Artist</span>
                    <span>${escapeHTML(count)}</span>
                </div>
            </div>
        </div>
    `;
}

function createSongResultHTML(song) {
    const coverSrc = usableArtworkUrl(song.cover) || defaultCoverSrc();
    let badge = '';
    if (song.isUserAdded) {
        badge = '<span class="search-result-badge">Added</span>';
    }
    
    return `
        <div class="search-result-item song" data-type="song" data-folder="${escapeHTML(song.folder)}" data-file="${escapeHTML(song.file)}" data-source-folder="${escapeHTML(song.sourceFolder || song.folder)}">
            <img src="${escapeHTML(coverSrc)}" alt="${escapeHTML(song.title)}" onerror="this.src='${basePath}img/music.svg'">
            <div class="search-result-info">
                <div class="search-result-title">${song.matchedText}${badge}</div>
                <div class="search-result-meta">
                    <span class="search-result-type">Song</span>
                    <span>${escapeHTML(song.album)}</span>
                </div>
            </div>
            <div class="search-result-play">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 20V4L19 12L5 20Z"/>
                </svg>
            </div>
        </div>
    `;
}

function bindSearchResultEvents() {
    const items = document.querySelectorAll('.search-result-item');

    // Each row shows what it can straight away; an album whose picture has to
    // be fetched gets it here, through the same painter as everything else.
    items.forEach((item) => {
        if (item.dataset.type !== 'album') return;

        const folder = item.dataset.folder;
        const info = albumInfo[folder];
        if (info) paintAlbumArtwork(item.querySelector('img'), info, folder);
    });
    
    items.forEach((item, index) => {
        item.addEventListener('click', async () => {
            const type = item.dataset.type;
            const folder = item.dataset.folder;
            
            if (type === 'album') {
                // An album found by searching opens, the same as its card.
                await openAlbumDetail(folder);
            } else if (type === 'song') {
                const file = item.dataset.file;
                const sourceFolder = item.dataset.sourceFolder || folder;
                
                // Load the album if different
                if (currentFolder !== folder) {
                    await getsongs(folder);
                }
                // Find and play the specific song
                const btn = findLibButtonByTrack(file);
                playmusic(file, btn, false, sourceFolder);
            }
            
            // Hide search results and clear input
            hideSearchResults();
            document.getElementById('searchInput').value = '';
            document.getElementById('clearSearch').classList.add('hidden');
        });
        
        // Hover effect for keyboard navigation sync
        item.addEventListener('mouseenter', () => {
            selectedResultIndex = index;
            updateSelectedResult(items);
        });
    });
}

function updateSelectedResult(items) {
    items.forEach((item, index) => {
        if (index === selectedResultIndex) {
            item.classList.add('selected');
            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
            item.classList.remove('selected');
        }
    });
}

function showSearchResults() {
    const searchResults = document.getElementById('searchResults');
    if (searchResults) {
        searchResults.classList.add('active');
    }
}

function hideSearchResults() {
    const searchResults = document.getElementById('searchResults');
    if (searchResults) {
        searchResults.classList.remove('active');
    }
    selectedResultIndex = -1;
}

/* ========== CREATE ALBUM FUNCTIONALITY ========== */

// User albums stored in localStorage
let userAlbums = {};
const USER_ALBUMS_KEY = 'spotify_user_albums';

function loadUserAlbums() {
    // Albums a person created are account content: a guest browsing the app
    // sees the published catalogue and this device's music, not somebody's
    // personal collections.
    if (!isSignedIn()) return;

    try {
        const stored = localStorage.getItem(USER_ALBUMS_KEY);
        if (stored) {
            userAlbums = JSON.parse(stored);
            // Add user albums to predefinedSongs and albumInfo
            for (const folder in userAlbums) {
                predefinedSongs[folder] = userAlbums[folder].files || [];
                albumInfo[folder] = userAlbums[folder].info;
            }
        }
        
        // Load pinned status for all albums
        const pinnedAlbums = JSON.parse(localStorage.getItem('spotify_pinned_albums') || '[]');
        pinnedAlbums.forEach(folder => {
            if (albumInfo[folder]) {
                albumInfo[folder].isPinned = true;
            }
        });
        
        // Remove deleted built-in albums.
        //
        // Never a system collection. Local Music is not an album somebody made
        // and chose to remove - it is this machine, and it exists while the
        // machine is one Spotifie is allowed to search. A stale entry naming
        // one is taken out of the stored list as well as ignored, so a browser
        // that recorded it once stops carrying it.
        const deletedAlbums = JSON.parse(localStorage.getItem('spotify_deleted_albums') || '[]');
        const removable = deletedAlbums.filter((folder) => !isSystemFolder(folder));

        removable.forEach(folder => {
            delete predefinedSongs[folder];
            delete albumInfo[folder];
        });

        if (removable.length !== deletedAlbums.length) {
            localStorage.setItem('spotify_deleted_albums', JSON.stringify(removable));
        }
        
        // Apply edits to built-in albums
        const editedAlbums = JSON.parse(localStorage.getItem('spotify_edited_albums') || '{}');
        for (const folder in editedAlbums) {
            if (albumInfo[folder]) {
                const edits = editedAlbums[folder];
                albumInfo[folder].title = edits.title || albumInfo[folder].title;
                albumInfo[folder].description = edits.description || albumInfo[folder].description;
                if (edits.cover !== undefined) {
                    albumInfo[folder].cover = edits.cover;
                }
            }
        }
    } catch (e) {
        console.error('Error loading user albums:', e);
        userAlbums = {};
    }
}

function saveUserAlbums() {
    try {
        localStorage.setItem(USER_ALBUMS_KEY, JSON.stringify(userAlbums));
    } catch (e) {
        console.error('Error saving user albums:', e);
        alert('Failed to save album. Storage might be full.');
    }
}

function generateAlbumId(name) {
    // Create a safe folder name from album name
    const safeName = name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 30);
    const timestamp = Date.now();
    return `user_albums/${safeName}_${timestamp}`;
}

function initCreateAlbum() {
    const createBtn = document.getElementById('createAlbumBtn');
    const modal = document.getElementById('createAlbumModal');
    const closeModal = document.getElementById('closeModal');
    const cancelCreate = document.getElementById('cancelCreate');
    const form = document.getElementById('createAlbumForm');
    const imageUploadArea = document.getElementById('imageUploadArea');
    const albumCoverInput = document.getElementById('albumCover');
    const imagePreview = document.getElementById('imagePreview');
    const uploadPlaceholder = document.getElementById('uploadPlaceholder');
    const removeImageBtn = document.getElementById('removeImage');
    const modalBackdrop = modal?.querySelector('.modal-backdrop');
    
    // The address of the stored cover, plus the temporary preview URL.
    let currentImageData = null;
    let createPreviewObjectUrl = null;

    function releaseCreatePreview() {
        if (createPreviewObjectUrl) {
            URL.revokeObjectURL(createPreviewObjectUrl);
            createPreviewObjectUrl = null;
        }
    }

    if (!modal || !form) return;
    
    // Image reset function
    function resetImageUpload() {
        releaseCreatePreview();
        currentImageData = null;
        imagePreview.classList.add('hidden');
        uploadPlaceholder.classList.remove('hidden');
        removeImageBtn.classList.add('hidden');
        albumCoverInput.value = '';
    }
    
    // Open modal function - exposed globally
    window.openCreateAlbumModal = function() {
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        form.reset();
        resetImageUpload();
    };
    
    // Open modal from header button
    createBtn?.addEventListener('click', () => {
        window.openCreateAlbumModal();
    });
    
    // Close modal functions
    function closeModalFn() {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
        form.reset();
        resetImageUpload();
    }
    
    closeModal?.addEventListener('click', closeModalFn);
    cancelCreate?.addEventListener('click', closeModalFn);
    modalBackdrop?.addEventListener('click', closeModalFn);
    
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            closeModalFn();
        }
    });
    
    // Image upload handling
    function handleImageFile(file) {
        if (!file) return;
        
        // Validate file type
        if (!file.type.startsWith('image/')) {
            alert('Please select an image file.');
            return;
        }
        
        // Validate file size (2MB max)
        if (file.size > 2 * 1024 * 1024) {
            alert('Image size must be less than 2MB.');
            return;
        }
        
        // Preview from a temporary object URL; the file is stored on this
        // device and the album keeps only its address.
        releaseCreatePreview();
        createPreviewObjectUrl = URL.createObjectURL(file);
        imagePreview.src = createPreviewObjectUrl;
        imagePreview.classList.remove('hidden');
        uploadPlaceholder.classList.add('hidden');
        removeImageBtn.classList.remove('hidden');

        saveLocalAlbumArtwork(file)
            .then((url) => {
                currentImageData = url;
            })
            .catch((err) => {
                console.error('Could not save the cover image:', err);
                showToast(err.message || 'Could not save the cover image');
                resetImageUpload();
            });
    }
    
    // Click to upload
    imageUploadArea?.addEventListener('click', (e) => {
        if (e.target !== removeImageBtn && !removeImageBtn.contains(e.target)) {
            albumCoverInput.click();
        }
    });
    
    albumCoverInput?.addEventListener('change', (e) => {
        handleImageFile(e.target.files[0]);
    });
    
    // Drag and drop
    imageUploadArea?.addEventListener('dragover', (e) => {
        e.preventDefault();
        imageUploadArea.classList.add('dragover');
    });
    
    imageUploadArea?.addEventListener('dragleave', () => {
        imageUploadArea.classList.remove('dragover');
    });
    
    imageUploadArea?.addEventListener('drop', (e) => {
        e.preventDefault();
        imageUploadArea.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        handleImageFile(file);
    });
    
    // Remove image
    removeImageBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        resetImageUpload();
    });
    
    // Form submission
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const albumName = document.getElementById('albumName').value.trim();
        const albumDescription = document.getElementById('albumDescription').value.trim();
        
        if (!albumName) {
            alert('Please enter an album name.');
            return;
        }
        
        // Generate unique folder ID
        const folderId = generateAlbumId(albumName);
        
        // Create album data
        const albumData = {
            files: [],
            info: {
                title: albumName,
                description: albumDescription || 'My custom album',
                // The address of the stored image, never the image itself
                cover: currentImageData || null,
                isUserAlbum: true
            }
        };
        
        // Save to userAlbums
        userAlbums[folderId] = albumData;
        saveUserAlbums();
        
        // Add to runtime data
        predefinedSongs[folderId] = albumData.files;
        albumInfo[folderId] = albumData.info;
        
        // Refresh album display
        await refreshAlbumCards();
        
        // Close modal
        closeModalFn();
        
        // Show success message
        showNotification(`Album "${albumName}" created successfully!`);
    });
}

/**
 * The id inside a local artwork address, or null.
 *
 * A cover is stored as "/api/library/artwork/<id>" once the file has been
 * saved on this machine. What a playlist keeps is the id: an address is how
 * this server happens to serve it today, and the id is what the picture is.
 * Anything that is not one of ours - an address elsewhere, a handle from a
 * previous visit, a picture written into the page - is refused outright.
 */
function artworkReferenceFrom(cover) {
    if (typeof cover !== 'string' || !cover) return null;

    const match = /^\/api\/library\/artwork\/([A-Za-z0-9_-]+)$/.exec(cover.trim());
    return match ? match[1] : null;
}

/**
 * Make a playlist.
 *
 * Named here rather than in a dialog of its own: the same modal that makes an
 * album makes a playlist, because they are made the same way and a second
 * dialog for it would be a second thing to learn.
 */
async function createPlaylist(details) {
    if (!requireAccount('Sign in to make playlists')) return null;

    const personal = getPersonal();
    if (!personal) return null;

    const settings = details || {};
    const title = (settings.title || '').trim();
    if (!title) {
        showToast('A playlist needs a name');
        return null;
    }

    try {
        const playlist = await personal.createPlaylist({
            title: title,
            description: (settings.description || '').trim() || null,
            artworkReference: artworkReferenceFrom(settings.cover),
            trackIds: settings.trackIds || []
        });

        await refreshPersonalViews();
        showNotification('Playlist "' + playlist.title + '" created.');
        return playlist;
    } catch (error) {
        showToast(error && error.status === 401 ? 'Sign in to make playlists' : 'Could not make that playlist');
        return null;
    }
}

/**
 * Take one song out of the collection being looked at.
 *
 * A playlist may name the same song more than once, so which entry is being
 * removed matters: the row says its position, and that position is what goes.
 * Liked Songs has no positions - a song is liked or it is not - so removing
 * from it is unliking it.
 */
async function removeFromPersonalCollection(folder, trackId, position) {
    const personal = getPersonal();
    if (!personal) return false;

    const info = albumInfo[folder] || {};

    try {
        if (info.isLikedAlbum) {
            if (personal.isLiked(trackId)) await personal.toggleLike(trackId);
            return true;
        }

        if (info.isPlaylist && info.playlistId) {
            await personal.removeTrack(info.playlistId, trackId, Number.isInteger(position) ? position : undefined);
            await refreshPersonalViews();
            return true;
        }
    } catch (error) {
        showToast('Could not remove that song');
    }

    return false;
}

/**
 * Move one song within a playlist.
 *
 * By position, because the same song may be in the list twice and only one of
 * them is being moved. The list is redrawn from what the server saved, so what
 * is on screen is what is stored.
 */
async function movePlaylistEntry(folder, from, to) {
    const info = albumInfo[folder] || {};
    if (!info.isPlaylist || !info.playlistId) return false;

    const personal = getPersonal();
    if (!personal) return false;

    try {
        await personal.reorder(info.playlistId, { from: from, to: to });
        await refreshPersonalViews();
        return true;
    } catch (error) {
        showToast('Could not reorder that playlist');
        return false;
    }
}

// ============================================
// The ways into the library
//
// Albums, Playlists, Artists, Liked Songs, Recently Played, Recently Added and
// Local Music. Each is a way of choosing what the grid shows; none of them is
// a new kind of page, because they are all the same cards drawn from a
// different set of collections.
// ============================================

const LIBRARY_VIEWS = ['all', 'albums', 'playlists', 'artists', 'liked', 'recent', 'local'];

let libraryView = 'all';

/** Which view is showing. */
function getLibraryView() {
    return libraryView;
}

/**
 * Show one part of the library.
 *
 * The grid is redrawn from the same cards; what changes is which of them are
 * in it. Nothing about playback is touched, and going back returns to
 * whichever view was showing before.
 */
async function setLibraryView(view) {
    const wanted = LIBRARY_VIEWS.indexOf(view) === -1 ? 'all' : view;
    if (wanted === libraryView) return;

    libraryView = wanted;

    document.querySelectorAll('[data-library-view]').forEach((element) => {
        const active = element.dataset.libraryView === wanted;
        element.classList.toggle('active', active);
        element.setAttribute('aria-current', active ? 'page' : 'false');
    });

    await refreshAlbumCards();
}

// ============================================
// Waiting for something to arrive
//
// One placeholder, used wherever something is genuinely still loading and
// there is nothing yet to show. Built here rather than at each call site so
// every part of the application waits the same way, and so the shapes stay in
// step with the components they stand in for.
//
// The rule that matters most is when NOT to use one. A placeholder means
// "there is nothing here yet". It never means "this is being checked": a
// catalogue being revalidated, a device index being reconciled or a library
// being re-read all leave what is already drawn exactly where it is. Putting
// placeholders over content that already exists is how a library comes to
// blink on every refresh, and it is not done anywhere in here.
// ============================================

/** One placeholder block, of whatever shape was asked for. */
function skeletonBlock(className) {
    const block = document.createElement('div');
    block.className = 'skeleton ' + className;
    // Nothing here is content: a screen reader is told the region is busy
    // once, rather than being read a list of rectangles.
    block.setAttribute('aria-hidden', 'true');
    return block;
}

/** Say whether a region is waiting, for anyone reading the page aloud. */
function markBusy(region, busy) {
    if (!region) return;
    region.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/**
 * A placeholder that has been waiting long enough.
 *
 * Never left behind: whatever replaces it - the content, an empty state, or a
 * line saying it could not be read - clears the busy mark, so a request that
 * fails ends in something a person can read rather than in a shape that
 * shimmers for ever.
 */
function clearSkeleton(region) {
    markBusy(region, false);
}

/** A card the size of a real one, with nothing in it yet. */
function skeletonCard() {
    const card = document.createElement('div');
    // The real card's own classes, so every size, padding and breakpoint it
    // follows this follows too - including the ones not written yet.
    card.className = 'cardcontainer rounded skeleton-card';
    card.setAttribute('aria-hidden', 'true');

    const inner = document.createElement('div');
    inner.className = 'card';
    inner.append(
        skeletonBlock('skeleton-art'),
        skeletonBlock('skeleton-line is-title'),
        skeletonBlock('skeleton-line is-meta')
    );

    card.appendChild(inner);
    return card;
}

/**
 * Hold the library's place while it is read for the first time.
 *
 * Only ever when there is nothing to show. A visit that drew the library from
 * the copy this device kept has real cards on screen already, and a grid that
 * already holds something is left exactly as it is.
 */
function showLibrarySkeleton(count) {
    const cardsArea = document.querySelector('.cardsarea');
    if (!cardsArea || cardsArea.children.length) return;

    const grid = document.createDocumentFragment();
    for (let index = 0; index < (count || 12); index += 1) grid.appendChild(skeletonCard());

    cardsArea.replaceChildren(grid);
    markBusy(cardsArea, true);
}

/** One row of a song list, at the height a row will be. */
function skeletonTrackRow() {
    const row = document.createElement('li');
    row.className = 'skeleton-track';
    row.setAttribute('aria-hidden', 'true');

    const lines = document.createElement('div');
    lines.className = 'skeleton-lines';
    lines.append(skeletonBlock('skeleton-line is-title'), skeletonBlock('skeleton-line is-meta'));

    row.append(
        skeletonBlock('skeleton-index'),
        skeletonBlock('skeleton-thumb'),
        lines,
        skeletonBlock('skeleton-duration')
    );
    return row;
}

/** One song in the manager's list, at the height one of its rows will be. */
function skeletonLocalTrackRow() {
    const row = document.createElement('li');
    row.className = 'skeleton-local-track';
    row.setAttribute('aria-hidden', 'true');

    const lines = document.createElement('div');
    lines.className = 'skeleton-lines';
    lines.append(skeletonBlock('skeleton-line is-title'), skeletonBlock('skeleton-line is-meta'));

    row.append(skeletonBlock('skeleton-box'), lines, skeletonBlock('skeleton-box'));
    return row;
}

/** One row of the list of folders this device is searched in. */
function skeletonLocationRow() {
    const row = document.createElement('li');
    row.className = 'skeleton-location';
    row.setAttribute('aria-hidden', 'true');

    const lines = document.createElement('div');
    lines.className = 'skeleton-lines';
    lines.append(skeletonBlock('skeleton-line is-title'), skeletonBlock('skeleton-line is-meta'));

    row.append(lines, skeletonBlock('skeleton-action'));
    return row;
}

/** One of the tiles the manager reports the library's health in. */
function skeletonTile() {
    return skeletonBlock('skeleton-tile');
}

/**
 * Fill a list or a grid with placeholders.
 *
 * Called only where there is nothing yet: what is already on screen is real,
 * and replacing it would be the blink this whole system exists to avoid.
 */
function showSkeletonIn(region, count, build) {
    if (!region) return;

    const rows = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) rows.appendChild(build());

    region.replaceChildren(rows);
    markBusy(region, true);
}

/**
 * Does this collection belong in the view being shown?
 *
 * One question asked of each card as the grid is built, so switching views
 * costs a filter rather than a rebuild of everything underneath.
 */
function belongsToLibraryView(folder, info) {
    if (libraryView === 'all') return true;
    if (!info) return false;

    switch (libraryView) {
        case 'playlists':
            return Boolean(info.isPlaylist);
        case 'liked':
            return Boolean(info.isLikedAlbum);
        case 'recent':
            return Boolean(info.isRecentlyPlayed);
        case 'local':
            return info.source === 'local' || Boolean(info.isSystemCollection);
        case 'albums':
            return !info.isPlaylist && !info.isLikedAlbum && !info.isRecentlyPlayed;
        default:
            return true;
    }
}

/**
 * What the Local Music card says under its title.
 *
 * How many songs this machine currently holds, which is the useful thing to
 * know at a glance, and a plain phrase when it holds none - a machine with no
 * music on it is an ordinary state, not a fault, and the card stays exactly
 * where it was either way.
 *
 * Short on purpose. A card is around a hundred and twenty pixels wide on a
 * phone, and a line that has to be cut off to fit says less than a shorter
 * one that does not. That this is the music on this device is already said by
 * the card's name and by the collection it opens.
 */
function localCollectionStatus(folder) {
    const count = (predefinedSongs[folder] || []).length;
    if (!count) return 'No songs yet';
    return count + (count === 1 ? ' song' : ' songs');
}

/** The single line printed under an album title: the artist, or nothing. */
function albumCardArtist(info) {
    if (!info) return '';
    // Local Music has no artist; where it came from is the useful line.
    if (info.isSystemCollection) return 'On this device';
    return info.artist || info.albumArtist || '';
}

async function refreshAlbumCards() {
    const cardsArea = document.querySelector('.cardsarea');
    if (!cardsArea) return;
    
    // Built up away from the page and put in place in one go. Clearing the
    // grid first and filling it afterwards leaves a frame with nothing in it,
    // and a background refresh - a device check finishing, a catalogue arriving
    // - would make the whole library blink. Nothing is taken off the screen
    // until its replacement is ready to go on.
    const grid = document.createDocumentFragment();
    
    // Re-render all albums, with pinned albums first, then Liked Songs.
    // A view narrows which of them are drawn; it never changes what they are,
    // so switching between views costs a filter and not a rebuild.
    const albums = Object.keys(predefinedSongs).filter((folder) =>
        belongsToLibraryView(folder, albumInfo[folder])
    );
    
    // Sort: Local Music first, then pinned, then Liked Songs, then others
    albums.sort((a, b) => {
        // The music on this machine leads the library, whoever is using it and
        // whatever anyone has pinned.
        const aPriority = albumPriority(a);
        const bPriority = albumPriority(b);
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aPinned = albumInfo[a]?.isPinned ? 1 : 0;
        const bPinned = albumInfo[b]?.isPinned ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;

        // Liked Songs album comes after pinned but before others
        const aLiked = a === LIKED_SONGS_FOLDER ? 1 : 0;
        const bLiked = b === LIKED_SONGS_FOLDER ? 1 : 0;
        return bLiked - aLiked;
    });
    
    for (const folder of albums) {
        const info = albumInfo[folder] || {
            title: folder.split('/').pop(),
            artist: '',
            cover: folder + '/cover.jpg'
        };
        
        // Create card element safely
        const cardDiv = document.createElement('div');
        cardDiv.dataset.folder = folder;
        cardDiv.className = 'cardcontainer pointer rounded';

        // Add special class for Liked Songs album
        if (folder === LIKED_SONGS_FOLDER) {
            cardDiv.classList.add('liked-songs-card');
        }

        // Local Music is the machine, not an album anybody made. It is the
        // same card as every other one - the same cell, the same artwork
        // square, the same title - and differs only in what can be done with
        // it: there is nothing to rename, pin or delete, and there is
        // somewhere to go to look after what is on this device.
        const isSystem = Boolean(info.isSystemCollection);
        if (isSystem) cardDiv.classList.add('local-music-card');

        const safeTitle = escapeHTML(info.title);
        // Cards carry the artist only. An album's description belongs to a
        // detail view, so it is never printed here - and when there is no
        // artist the line is left out rather than reserved as blank space.
        // Local Music has no artist; how much of it there is, is the line
        // worth printing.
        const safeArtist = escapeHTML(isSystem ? localCollectionStatus(folder) : albumCardArtist(info));
        
        // Cover image through the shared resolver, so a card, the album view
        // and the edit dialog always show the same picture.
        const coverSrc = albumCoverSrcNow(info);
        
        // Add three-dot menu for all albums
        const isUserAlbum = info.isUserAlbum ? 'true' : 'false';
        const isLikedAlbum = info.isLikedAlbum ? 'true' : 'false';
        const isPinned = info.isPinned ? 'true' : 'false';
        
        // Every card keeps its options where every other card keeps them: one
        // button in the corner of the artwork, one menu under it. What is in
        // that menu is what makes sense for the thing it belongs to.
        //
        // Rename, pin and delete all mean something to an album and nothing to
        // a machine. Offering them on Local Music was worse than untidy:
        // deleting it wrote the collection into this browser's list of removed
        // albums, and it stayed gone through every later load. So the machine's
        // menu holds the one thing that does mean something - looking after
        // what is on this device - and no album's menu holds that.
        const menuOptions = isSystem ? `
                        <button class="menu-option manage-local-option" data-folder="${escapeHTML(folder)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M3 6h18M3 12h18M3 18h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                            <span>Manage Local Music</span>
                        </button>` : `
                        <button class="menu-option edit-option" data-folder="${escapeHTML(folder)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M11 4H4C3.46957 4 2.96086 4.21071 2.58579 4.58579C2.21071 4.96086 2 5.46957 2 6V20C2 20.5304 2.21071 21.0391 2.58579 21.4142C2.96086 21.7893 3.46957 22 4 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M18.5 2.50001C18.8978 2.10219 19.4374 1.87869 20 1.87869C20.5626 1.87869 21.1022 2.10219 21.5 2.50001C21.8978 2.89784 22.1213 3.43739 22.1213 4.00001C22.1213 4.56262 21.8978 5.10219 21.5 5.50001L12 15L8 16L9 12L18.5 2.50001Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span>Edit</span>
                        </button>
                        ${info.hasLocalEdits ? `<button class="menu-option reset-option" data-folder="${escapeHTML(folder)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M3 4v4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span>Reset local changes</span>
                        </button>` : ''}
                        <button class="menu-option pin-option ${info.isPinned ? 'pinned' : ''}" data-folder="${escapeHTML(folder)}" data-pinned="${isPinned}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 2L12 12M12 12L8 8M12 12L16 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="rotate(45 12 12)"/>
                                <path d="M5 21L19 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                            <span>${info.isPinned ? 'Unpin' : 'Pin'}</span>
                        </button>
                        <button class="menu-option delete-option" data-folder="${escapeHTML(folder)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M3 6H5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span>Delete</span>
                        </button>`;

        // A system collection's menu is not account content: the music on this
        // machine belongs to the machine, and a guest may look after it. It is
        // marked here so the gating that hides an album's menu from a guest
        // leaves this one alone.
        const menuMarkup = `
                <div class="card-menu"${isSystem ? ' data-system="true"' : ''} data-folder="${escapeHTML(folder)}" data-user-album="${isUserAlbum}" data-liked-album="${isLikedAlbum}">
                    <button class="card-menu-btn" type="button" aria-label="${isSystem ? 'Local Music options' : 'Album options'}" aria-haspopup="true" aria-expanded="false">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="5" r="2" fill="currentColor"/>
                            <circle cx="12" cy="12" r="2" fill="currentColor"/>
                            <circle cx="12" cy="19" r="2" fill="currentColor"/>
                        </svg>
                    </button>
                    <div class="card-menu-dropdown hidden">${menuOptions}
                    </div>
                </div>`;

        cardDiv.innerHTML = `
            <div class="card">
                ${menuMarkup}
                ${info.isPinned ? `<div class="pin-indicator" aria-label="Pinned album">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2L12 12M12 12L8 8M12 12L16 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="rotate(45 12 12)"/>
                        <path d="M5 21L19 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                </div>` : ''}
                <div class="card-art">
                    <img class="pointer rounded" src="${escapeHTML(coverSrc)}" alt="${safeTitle} album cover" onerror="this.onerror=null;this.src='${basePath}img/music.svg'">
                    <div class="waveform-indicator" aria-label="Now playing">
                        <div class="bar"></div>
                        <div class="bar"></div>
                        <div class="bar"></div>
                        <div class="bar"></div>
                    </div>
                    <button type="button" class="play" aria-label="Play">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <path d="M5 20V4L19 12L5 20Z" stroke="#141B34" fill="#000" stroke-width="1.5" stroke-linejoin="round" />
                        </svg>
                    </button>
                </div>
                <h2>${safeTitle}</h2>
                <p>${safeArtist}</p>
            </div>`;
        
        grid.appendChild(cardDiv);

        // Whatever can be shown at once is already showing; the resolver
        // replaces it if it finds something better - a signed URL for a
        // published album, or the picture carried by the first song in one
        // that has none of its own.
        paintAlbumArtwork(cardDiv.querySelector('.card-art img'), info, folder);
    }

    // Add "Create Album" card at the end
    const createCard = document.createElement('div');
    createCard.className = 'cardcontainer pointer rounded create-album-card';
    if (!isSignedIn()) createCard.classList.add('hidden');
    createCard.innerHTML = `
        <div class="card create-card-inner">
            <div class="create-card-plus">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </div>
            <h2>Create Album</h2>
            <p>Add your own music collection</p>
        </div>`;
    grid.appendChild(createCard);
    
    // Bind click events for cards

    // One swap: the old grid goes and the new one arrives in the same frame.
    cardsArea.replaceChildren(grid);
    // Whatever was holding the library's place has been replaced by the library.
    clearSkeleton(cardsArea);

    // Everything below asks the page about the cards, so it happens after the
    // cards are in the page. Building the grid away from the document is what
    // stops it blinking; doing anything to it while it is still detached is
    // how the whole library stopped opening.

    // The grid's own listener, attached the first time and never again: the
    // cards are new on every render, the container is not.
    bindAlbumCardEvents();

    // Re-apply gating: a re-render must not bring back controls a guest
    // cannot use.
    applyAccountGating();
}

/**
 * Wire the album grid, once.
 *
 * One listener on the grid itself rather than one per card. The cards are
 * rebuilt whenever anything changes - a catalogue arriving, a device check
 * finishing, somebody signing in - and binding to each card meant every one of
 * those rebuilds had to remember to bind again. It only had to be missed once
 * for the whole library to stop opening, which is exactly what happened when
 * the grid began being built away from the page: the cards were bound while
 * they were still in a fragment, so nothing was bound at all.
 *
 * Delegating removes the class of bug rather than the instance of it. The
 * container outlives every render, so navigation cannot be lost by one, and
 * there is nothing to attach twice.
 */
function bindAlbumCardEvents() {
    const cardsArea = document.querySelector('.cardsarea');
    if (!cardsArea || cardsArea.dataset.bound === 'yes') return;

    cardsArea.dataset.bound = 'yes';

    cardsArea.addEventListener('click', async (event) => {
        // ---- the controls inside a card, each of which is its own action ----

        const menuButton = event.target.closest('.card-menu-btn');
        if (menuButton) {
            event.stopPropagation();
            toggleCardMenu(menuButton);
            return;
        }

        // The options inside an open menu. Each closes the menu and does its
        // own thing; none of them opens the album behind it.
        const option = event.target.closest(
            '.edit-option, .reset-option, .pin-option, .delete-option, .manage-local-option'
        );
        if (option) {
            event.stopPropagation();
            const folder = option.dataset.folder;
            closeAllMenus();

            if (option.classList.contains('manage-local-option')) await openLocalManager();
            else if (option.classList.contains('edit-option')) openEditAlbumModal(folder);
            else if (option.classList.contains('reset-option')) resetPersonalAlbumEdits(folder);
            else if (option.classList.contains('pin-option')) togglePinAlbum(folder);
            else showDeleteConfirmation(folder);
            return;
        }

        // A click anywhere else inside an open menu is not a click on the card.
        if (event.target.closest('.card-menu')) return;

        if (event.target.closest('.create-album-card')) {
            if (!requireAccount('Sign in to create your own albums')) return;
            openCreateAlbumModal();
            return;
        }

        const card = event.target.closest('.cardcontainer');
        if (!card || card.classList.contains('create-album-card')) return;

        const folder = card.dataset.folder;
        if (!folder) return;

        // ---- the card itself ----

        // Play is for playing. Browsing an album no longer interrupts what is
        // already playing, so the two are separate on purpose.
        if (event.target.closest('.play')) {
            event.stopPropagation();
            await playAlbumFromCard(folder);
            return;
        }

        // Anywhere else on the card - the artwork, the title, the artist -
        // opens it. The folder is carried through exactly as it was rendered,
        // so a published album, one somebody made, Local Music and a playlist
        // all reach the same place by the same route.
        await openAlbumDetail(folder);
    });
}

/**
 * Open or close one card's menu.
 *
 * Split out because the grid's listener now handles the button, and a menu
 * that is opened has to be measured after it is in the page.
 */
function toggleCardMenu(button) {
    const menu = button.closest('.card-menu');
    if (!menu) return;

    const dropdown = menu.querySelector('.card-menu-dropdown');
    if (!dropdown) return;

    // Close every other menu first.
    closeAllMenus(dropdown);

    const open = dropdown.classList.toggle('hidden') === false;
    menu.classList.toggle('open', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');

    // It has to be in the page to be measured, so it is placed after it is
    // shown - and followed while the page moves under it.
    if (open) {
        placeCardMenu(button, dropdown);
        trackOpenCardMenu(button, dropdown);
    } else {
        trackOpenCardMenu(null, null);
    }
}

/**
 * Play an album from its card.
 *
 * The album already playing is paused or resumed; a different one is loaded
 * and started, at its first song or a shuffled one. Either way the bottom
 * player and both play controls end up saying the same thing, because all
 * three are drawn from the audio element afterwards.
 */
async function playAlbumFromCard(folder) {
    const isCurrentAlbum = folder === window.currentPlayingAlbum;

    if (isCurrentAlbum && currentsong.src) {
        togglePlayback();
        return;
    }

    await getsongs(folder);

    if (!songs.length) {
        // An empty album stops the player rather than playing something else.
        currentsong.pause();
        currentsong.removeAttribute('src');
        window.currentPlayingAlbum = null;
        window.currentPlayingSourceFolder = null;
        window.currentPlayingTrack = null;

        const songInfoEl = document.querySelector('.songinfo');
        if (songInfoEl) songInfoEl.textContent = 'No songs in this album';
        const artistEl = document.getElementById('playbarArtist');
        if (artistEl) artistEl.textContent = '';
        updateProgressUI();

        // Nothing is loaded any more, so every control is Play.
        syncPlaybackUI();
        return;
    }

    const trackId = shuffleEnabled ? shuffledFrom(songs.slice(), null)[0] : songs[0];
    const meta = (window.currentSongsMeta || []).find((entry) => entry.track === trackId);
    playmusic(trackId, findLibButtonByTrack(trackId), false, (meta && meta.sourceFolder) || folder);
}

// Close all dropdown menus
/**
 * Put an open card menu beside the button that opened it.
 *
 * The menu is placed against the window rather than inside the card, because
 * a card is often narrower than its own menu and the grid it sits in scrolls -
 * either of which used to cut the menu in half. It opens below the button and
 * aligned to its right edge; where there is not room it flips above, or slides
 * along until it fits, so a card in the first column, the last column or the
 * last row all open a menu that is wholly on screen.
 */
function placeCardMenu(button, dropdown) {
    if (!button || !dropdown || !button.getBoundingClientRect) return;

    const gap = 6;
    const edge = 8;
    const anchor = button.getBoundingClientRect();
    const menu = dropdown.getBoundingClientRect();

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    // Aligned to the button's right edge, then slid back onto the screen if
    // that would take it off either side.
    let left = anchor.right - menu.width;
    left = Math.min(left, viewportWidth - menu.width - edge);
    left = Math.max(edge, left);

    // Below the button; above it instead when the room below has run out and
    // there is more of it above.
    let top = anchor.bottom + gap;
    const roomBelow = viewportHeight - anchor.bottom - gap - edge;
    const roomAbove = anchor.top - gap - edge;

    if (menu.height > roomBelow && roomAbove > roomBelow) {
        top = Math.max(edge, anchor.top - gap - menu.height);
    } else {
        top = Math.min(top, Math.max(edge, viewportHeight - menu.height - edge));
    }

    dropdown.style.left = Math.round(left) + 'px';
    dropdown.style.top = Math.round(top) + 'px';
}

/** The menu that is open, so it can follow its card while the page moves. */
let openCardMenuButton = null;

function trackOpenCardMenu(button, dropdown) {
    openCardMenuButton = button && dropdown ? { button: button, dropdown: dropdown } : null;
}

/**
 * A card that scrolls or a window that resizes moves the button the menu
 * belongs to, so the menu is placed again rather than left behind.
 */
function initCardMenuPlacement() {
    const reposition = () => {
        if (!openCardMenuButton) return;
        if (openCardMenuButton.dropdown.classList.contains('hidden')) {
            openCardMenuButton = null;
            return;
        }
        placeCardMenu(openCardMenuButton.button, openCardMenuButton.dropdown);
    };

    window.addEventListener('resize', reposition);
    // Anywhere in the page, including the grid the cards scroll inside.
    document.addEventListener('scroll', reposition, true);
}

function closeAllMenus(except) {
    document.querySelectorAll('.card-menu-dropdown').forEach(d => {
        if (except && d === except) return;
        d.classList.add('hidden');

        if (openCardMenuButton && openCardMenuButton.dropdown === d) openCardMenuButton = null;

        const menu = d.closest('.card-menu');
        if (menu) menu.classList.remove('open');

        const btn = menu ? menu.querySelector('.card-menu-btn') : null;
        if (btn) btn.setAttribute('aria-expanded', 'false');
    });
}

// Close menus when clicking or tapping outside, and on Escape
document.addEventListener('click', (e) => {
    if (!e.target.closest('.card-menu')) {
        closeAllMenus();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    const openMenu = document.querySelector('.card-menu-dropdown:not(.hidden)');
    if (!openMenu) return;

    const menu = openMenu.closest('.card-menu');
    closeAllMenus();

    // Focus returns to the button that opened the menu.
    const btn = menu ? menu.querySelector('.card-menu-btn') : null;
    if (btn) btn.focus();
});

// Show delete confirmation modal
function showDeleteConfirmation(folder) {
    const info = albumInfo[folder];
    if (!info) return;
    
    const modal = document.getElementById('deleteConfirmModal');
    const albumNameEl = document.getElementById('deleteAlbumName');
    const confirmBtn = document.getElementById('confirmDeleteBtn');
    
    albumNameEl.textContent = info.title;
    confirmBtn.dataset.folder = folder;
    
    modal.classList.remove('hidden');
}

// Close delete confirmation modal
function closeDeleteConfirmation() {
    const modal = document.getElementById('deleteConfirmModal');
    modal.classList.add('hidden');
}

// Delete album (works for both user and built-in albums)
async function deleteAlbum(folder) {
    const info = albumInfo[folder];
    if (!info) return;

    // A system collection is not somebody's album to remove. Deleting Local
    // Music used to write it into this browser's list of deleted albums, and
    // every later load read that list and took the collection away again -
    // so one press removed the music on this machine from the library for
    // good, and no rescan brought it back.
    if (isSystemFolder(folder) || info.isSystemCollection) {
        closeDeleteConfirmation();
        showToast('Local Music follows the music on this device');
        return;
    }

    const title = info.title;

    // A playlist belongs to this account and is kept on this machine, so it is
    // deleted there. The songs in it are untouched: a playlist names music, it
    // never holds it.
    if (info.isPlaylist && info.playlistId) {
        const personal = getPersonal();
        try {
            if (personal) await personal.deletePlaylist(info.playlistId);
        } catch (error) {
            showToast('Could not delete that playlist');
            return;
        }

        closeDeleteConfirmation();
        await navForgetAlbum(folder);
        await refreshPersonalViews();
        showNotification('Playlist "' + title + '" deleted.');
        return;
    }

    // Emptying Liked Songs means unliking everything in it; the songs stay.
    if (folder === LIKED_SONGS_FOLDER) {
        const personal = getPersonal();
        if (personal) {
            const liked = personal.getLiked().slice();
            for (const track of liked) {
                try {
                    if (personal.isLiked(track.id)) await personal.toggleLike(track.id);
                } catch (error) {
                    /* one that would not unlike does not stop the rest */
                }
            }
        }

        likedSongsAlbumConfig = null;
        localStorage.removeItem('likedSongsAlbumConfig');

        closeDeleteConfirmation();
        await refreshPersonalViews();
        showNotification('All liked songs cleared.');
        return;
    }

    // If it's a user album, remove from userAlbums storage
    if (info.isUserAlbum) {
        delete userAlbums[folder];
        saveUserAlbums();
    } else {
        // For built-in albums, track them as deleted in localStorage
        let deletedAlbums = JSON.parse(localStorage.getItem('spotify_deleted_albums') || '[]');
        if (!deletedAlbums.includes(folder)) {
            deletedAlbums.push(folder);
            localStorage.setItem('spotify_deleted_albums', JSON.stringify(deletedAlbums));
        }
    }
    
    // Remove from runtime data
    delete predefinedSongs[folder];
    delete albumInfo[folder];
    
    // Remove from pinned if it was pinned
    let pinnedAlbums = JSON.parse(localStorage.getItem('spotify_pinned_albums') || '[]');
    pinnedAlbums = pinnedAlbums.filter(f => f !== folder);
    localStorage.setItem('spotify_pinned_albums', JSON.stringify(pinnedAlbums));
    
    // Close modal and refresh display
    closeDeleteConfirmation();
    // An album that is gone is nowhere to go back to either.
    await navForgetAlbum(folder);
    refreshAlbumCards();
    
    showNotification(`Album "${title}" deleted.`);
}

// Toggle pin status of an album
function togglePinAlbum(folder) {
    const info = albumInfo[folder];
    if (!info) return;

    // Local Music already leads the library, for everybody, always. There is
    // nothing pinning could add and something it could take away.
    if (isSystemFolder(folder) || info.isSystemCollection) return;
    
    let pinnedAlbums = JSON.parse(localStorage.getItem('spotify_pinned_albums') || '[]');
    
    if (pinnedAlbums.includes(folder)) {
        // Unpin
        pinnedAlbums = pinnedAlbums.filter(f => f !== folder);
        info.isPinned = false;
        showNotification(`"${info.title}" unpinned.`);
    } else {
        // Pin
        pinnedAlbums.push(folder);
        info.isPinned = true;
        showNotification(`"${info.title}" pinned to top.`);
    }
    
    localStorage.setItem('spotify_pinned_albums', JSON.stringify(pinnedAlbums));
    
    // Update albumInfo
    albumInfo[folder] = info;
    
    // Refresh display to reorder cards
    refreshAlbumCards();
}

// Open edit album modal
async function openEditAlbumModal(folder) {
    const info = albumInfo[folder];
    if (!info) return;

    // Local Music is what is on this machine, not an album anybody made: there
    // is no title or cover of its own to change.
    if (info.isSystemCollection) {
        showToast('Local Music follows the music on this device');
        return;
    }

    // A published album can be personalised: the edits below are saved for
    // this account on this device, and the shared album is left as it is.
    if (info.source === 'global' && !requireAccount('Sign in to personalise this album')) return;

    const modal = document.getElementById('editAlbumModal');
    const nameInput = document.getElementById('editAlbumName');
    const descInput = document.getElementById('editAlbumDescription');
    const imagePreview = document.getElementById('editImagePreview');
    const uploadPlaceholder = document.getElementById('editUploadPlaceholder');
    const removeBtn = document.getElementById('editRemoveImage');
    const form = document.getElementById('editAlbumForm');

    // Store current folder being edited
    form.dataset.folder = folder;

    // Fill in current values, as this account currently sees them
    nameInput.value = info.title || '';
    descInput.value = info.description || '';

    const scopeNote = document.getElementById('editAlbumScopeNote');
    if (scopeNote) {
        scopeNote.textContent =
            info.source === 'global' ? 'Changes are saved only for you on this device.' : '';
        scopeNote.classList.toggle('hidden', info.source !== 'global');
    }

    // The cover comes from the same painter the album card uses, so the dialog
    // shows exactly what the card shows - including the fallback for one that
    // cannot be loaded.
    const hasCover = Boolean(info.cover) || info.source === 'global';
    if (hasCover) {
        imagePreview.classList.remove('hidden');
        uploadPlaceholder.classList.add('hidden');
        removeBtn.classList.remove('hidden');
        // The default shows while the real cover is found, and stays if it
        // cannot be loaded.
        paintAlbumArtwork(imagePreview, info, folder);
    } else {
        imagePreview.classList.add('hidden');
        uploadPlaceholder.classList.remove('hidden');
        removeBtn.classList.add('hidden');
    }

    modal.classList.remove('hidden');
}

// Close edit album modal
function closeEditAlbumModal() {
    const modal = document.getElementById('editAlbumModal');
    const form = document.getElementById('editAlbumForm');
    form.reset();
    delete form.dataset.folder;
    modal.classList.add('hidden');
}

// Save edited album
/**
 * Save one listener's own version of a published album.
 *
 * Everything here is personal: it is stored on this device for this account,
 * and no part of it touches the shared catalogue. The published album keeps
 * its own title, artist, description and cover for everybody else.
 */
async function savePersonalAlbumEdits(folder, info, newName, newDescription, newCover) {
    const client = getCatalogClient();
    if (!client) return;

    // The cover reference is a local artwork id; an untouched cover is left
    // alone, and a removed one falls back to the published cover.
    let artworkReference = info.localEdits ? info.localEdits.artwork : null;
    if (newCover !== undefined) {
        artworkReference = newCover ? localArtworkReference(newCover) : null;
    }

    try {
        const result = await client.setAlbumOverride(info.albumId, {
            title: newName !== info.globalTitle ? newName : null,
            artist: null,
            description: newDescription !== info.globalDescription ? newDescription : null,
            artworkReference: artworkReference
        });

        applyPersonalAlbumEdits(folder, result.override);
        closeEditAlbumModal();
        await refreshAlbumCards();
        showNotification('Saved for you on this device.');
    } catch (err) {
        console.error('Could not save your changes to this album:', err);
        showToast(err.status === 401 ? 'Sign in to personalise this album' : 'Could not save your changes');
    }
}

/** The local artwork id behind a "/api/library/artwork/<id>" address. */
function localArtworkReference(cover) {
    if (typeof cover !== 'string') return null;
    const match = /\/api\/library\/artwork\/([0-9a-f]{32})$/.exec(cover);
    return match ? match[1] : null;
}

/** Put a saved personal edit into the album currently in memory. */
function applyPersonalAlbumEdits(folder, override) {
    const info = albumInfo[folder];
    if (!info) return;

    info.title = (override && override.title) || info.globalTitle || info.title;
    info.artist = (override && override.artist) || info.globalArtist || info.artist;
    info.description = (override && override.description) || info.globalDescription || '';
    info.cover =
        override && override.artwork && override.artwork.reference
            ? '/api/library/artwork/' + override.artwork.reference
            : info.globalCover || '';
    info.hasLocalEdits = Boolean(override);
    info.localEdits = override || null;
}

/**
 * Drop this listener's edits to a published album and show it as published.
 */
async function resetPersonalAlbumEdits(folder) {
    const info = albumInfo[folder];
    if (!info || info.source !== 'global') return;

    const client = getCatalogClient();
    if (!client) return;

    try {
        await client.clearAlbumOverride(info.albumId);
        applyPersonalAlbumEdits(folder, null);
        await loadSongsConfig();
        await refreshAlbumCards();
        showToast('Your changes to this album were removed');
    } catch (err) {
        console.error('Could not restore this album:', err);
        showToast(err.status === 401 ? 'Sign in to manage your library' : 'Could not restore this album');
    }
}

async function saveEditedAlbum(folder, newName, newDescription, newCover) {
    const info = albumInfo[folder];
    if (!info) return;

    // A published album is personalised for this account only. The shared
    // record stays exactly as the administrator published it; this path cannot
    // reach it, and the dashboard remains the only place that changes it.
    if (info.source === 'global') {
        await savePersonalAlbumEdits(folder, info, newName, newDescription, newCover);
        return;
    }

    // Update info
    info.title = newName;
    info.description = newDescription;
    if (newCover !== undefined) {
        // Only a reference that will still mean something later is kept. A
        // resolved address would be stored, expire, and leave this album
        // broken from then on.
        info.cover = newCover === null || newCover === '' ? newCover : stableArtworkReference(newCover) || '';
    }
    
    albumInfo[folder] = info;

    // A playlist's name, words and cover are saved where the playlist is.
    if (info.isPlaylist && info.playlistId) {
        const personal = getPersonal();
        try {
            if (personal) {
                await personal.updatePlaylist(info.playlistId, {
                    title: newName,
                    description: newDescription,
                    // The address of a picture this machine holds, reduced to
                    // the id inside it. Never the picture itself.
                    artworkReference: artworkReferenceFrom(newCover !== undefined ? newCover : info.cover)
                });
            }
        } catch (error) {
            showToast('Could not save that playlist');
            return;
        }

        closeEditAlbumModal();
        await refreshPersonalViews();
        showNotification('Playlist "' + newName + '" updated.');
        return;
    }

    // Handle Liked Songs album
    if (folder === LIKED_SONGS_FOLDER) {
        likedSongsAlbumConfig = {
            title: newName,
            description: newDescription,
            cover: newCover || likedSongsAlbumConfig?.cover || null,
            isLikedAlbum: true
        };
        saveLikedSongsConfig();
        closeEditAlbumModal();
        refreshAlbumCards();
        showNotification(`Album "${newName}" updated.`);
        return;
    }
    
    // If it's a user album, update storage
    if (info.isUserAlbum) {
        userAlbums[folder] = {
            files: predefinedSongs[folder]?.files || [],
            info: {
                title: info.title,
                description: info.description,
                cover: info.cover,
                isUserAlbum: true,
                isPinned: info.isPinned
            }
        };
        saveUserAlbums();
    } else {
        // For built-in albums, store edits in localStorage
        let editedAlbums = JSON.parse(localStorage.getItem('spotify_edited_albums') || '{}');
        editedAlbums[folder] = {
            title: info.title,
            description: info.description,
            cover: info.cover
        };
        localStorage.setItem('spotify_edited_albums', JSON.stringify(editedAlbums));
    }
    
    closeEditAlbumModal();
    refreshAlbumCards();
    showNotification(`Album "${newName}" updated.`);
}

/**
 * Say that something worked.
 *
 * The same toast as every other message, in the same place, with the same
 * timing - because two ways of telling somebody the same kind of thing is one
 * way too many. This used to build its own element with its own colours
 * written into it, its own layer above every dialog, and no limit on how many
 * could pile up at once; it looked identical to a toast and behaved worse.
 *
 * Kept as its own name because "this worked" and "this did not" read
 * differently at the call site, and there are sixty of those.
 */
function showNotification(message) {
    showToast(message, 3000);
}

// Initialize delete confirmation modal
function initDeleteConfirmModal() {
    const modal = document.getElementById('deleteConfirmModal');
    const closeBtn = document.getElementById('closeDeleteModal');
    const cancelBtn = document.getElementById('cancelDelete');
    const confirmBtn = document.getElementById('confirmDeleteBtn');
    const backdrop = modal?.querySelector('.modal-backdrop');
    
    if (!modal) return;
    
    // Close modal handlers
    closeBtn?.addEventListener('click', closeDeleteConfirmation);
    cancelBtn?.addEventListener('click', closeDeleteConfirmation);
    backdrop?.addEventListener('click', closeDeleteConfirmation);
    
    // Confirm delete handler
    confirmBtn?.addEventListener('click', () => {
        const folder = confirmBtn.dataset.folder;
        if (folder) {
            deleteAlbum(folder);
        }
    });
    
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            closeDeleteConfirmation();
        }
    });
}

// Card size options
const cardSizes = ['small', 'medium', 'large'];
const cardSizeLabels = {
    'small': 'Small',
    'medium': 'Medium', 
    'large': 'Large'
};

// Initialize card size toggle
function initCardSizeToggle() {
    const cardSizeBtn = document.getElementById('cardSizeBtn');
    const cardsarea = document.querySelector('.cardsarea');
    const sizeLabel = cardSizeBtn?.querySelector('.size-label');
    
    if (!cardSizeBtn || !cardsarea) return;
    
    // Load saved size from localStorage or default to medium
    let currentSize = localStorage.getItem('cardSize') || 'medium';
    
    // Apply saved size
    applyCardSize(currentSize);
    
    // Toggle button click handler
    cardSizeBtn.addEventListener('click', () => {
        // Cycle through sizes: small -> medium -> large -> small
        const currentIndex = cardSizes.indexOf(currentSize);
        const nextIndex = (currentIndex + 1) % cardSizes.length;
        currentSize = cardSizes[nextIndex];
        
        applyCardSize(currentSize);
        
        // Save to localStorage
        localStorage.setItem('cardSize', currentSize);
    });
    
    function applyCardSize(size) {
        // Remove all size classes
        cardsarea.classList.remove('cards-small', 'cards-medium', 'cards-large');
        
        // Add the new size class (medium has no class, it's the default)
        if (size !== 'medium') {
            cardsarea.classList.add(`cards-${size}`);
        }
        
        // Update button label
        if (sizeLabel) {
            sizeLabel.textContent = cardSizeLabels[size];
        }
        
        // Update button icon based on size
        updateSizeIcon(size);
    }
    
    function updateSizeIcon(size) {
        const svg = cardSizeBtn.querySelector('svg');
        if (!svg) return;
        
        // Different grid icons for different sizes
        if (size === 'small') {
            svg.innerHTML = `
                <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="16" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="16" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="2" y="16" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="9" y="16" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
                <rect x="16" y="16" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
            `;
        } else if (size === 'large') {
            svg.innerHTML = `
                <rect x="3" y="3" width="18" height="8" rx="1" stroke="currentColor" stroke-width="2"/>
                <rect x="3" y="13" width="18" height="8" rx="1" stroke="currentColor" stroke-width="2"/>
            `;
        } else {
            // Medium - default 2x2 grid
            svg.innerHTML = `
                <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
                <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"/>
            `;
        }
    }
}

// Initialize edit album modal
function initEditAlbumModal() {
    const modal = document.getElementById('editAlbumModal');
    const closeBtn = document.getElementById('closeEditModal');
    const cancelBtn = document.getElementById('cancelEdit');
    const form = document.getElementById('editAlbumForm');
    const imageUploadArea = document.getElementById('editImageUploadArea');
    const coverInput = document.getElementById('editAlbumCover');
    const imagePreview = document.getElementById('editImagePreview');
    const uploadPlaceholder = document.getElementById('editUploadPlaceholder');
    const removeImageBtn = document.getElementById('editRemoveImage');
    const backdrop = modal?.querySelector('.modal-backdrop');
    
    // The reference that will be saved (a local artwork URL, or null when the
    // cover is removed) and whether the cover was touched at all.
    let editImageData = null;
    let imageChanged = false;
    let editPreviewObjectUrl = null;

    function releaseEditPreview() {
        if (editPreviewObjectUrl) {
            URL.revokeObjectURL(editPreviewObjectUrl);
            editPreviewObjectUrl = null;
        }
    }
    
    if (!modal || !form) return;
    
    // Close modal handlers
    closeBtn?.addEventListener('click', closeEditAlbumModal);
    cancelBtn?.addEventListener('click', closeEditAlbumModal);
    backdrop?.addEventListener('click', closeEditAlbumModal);
    
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            closeEditAlbumModal();
        }
    });
    
    // Image upload handling. The preview is a temporary object URL; the file
    // itself is stored on this device and the album keeps only its address.
    async function handleEditImageFile(file) {
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            alert('Please select an image file.');
            return;
        }

        if (file.size > 2 * 1024 * 1024) {
            alert('Image size must be less than 2MB.');
            return;
        }

        releaseEditPreview();
        editPreviewObjectUrl = URL.createObjectURL(file);
        imagePreview.src = editPreviewObjectUrl;
        imagePreview.classList.remove('hidden');
        uploadPlaceholder.classList.add('hidden');
        removeImageBtn.classList.remove('hidden');

        try {
            // Only the stored address is kept - never the picture itself, and
            // never the temporary blob: address.
            editImageData = await saveLocalAlbumArtwork(file);
            imageChanged = true;
        } catch (err) {
            console.error('Could not save the cover image:', err);
            showToast(err.message || 'Could not save the cover image');
            releaseEditPreview();
            editImageData = null;
            imageChanged = false;
            await restoreExistingEditCover();
        }
    }

    /** Put the album's saved cover back in the preview. */
    async function restoreExistingEditCover() {
        const folder = form.dataset.folder;
        const info = folder ? albumInfo[folder] : null;

        if (!info || !info.cover) {
            imagePreview.classList.add('hidden');
            uploadPlaceholder.classList.remove('hidden');
            removeImageBtn.classList.add('hidden');
            return;
        }

        imagePreview.classList.remove('hidden');
        uploadPlaceholder.classList.add('hidden');
        removeImageBtn.classList.remove('hidden');
        paintAlbumArtwork(imagePreview, info, folder);
    }
    
    // Click to upload
    imageUploadArea?.addEventListener('click', (e) => {
        if (e.target !== removeImageBtn && !removeImageBtn.contains(e.target)) {
            coverInput.click();
        }
    });
    
    coverInput?.addEventListener('change', (e) => {
        handleEditImageFile(e.target.files[0]);
    });
    
    // Drag and drop
    imageUploadArea?.addEventListener('dragover', (e) => {
        e.preventDefault();
        imageUploadArea.classList.add('dragover');
    });
    
    imageUploadArea?.addEventListener('dragleave', () => {
        imageUploadArea.classList.remove('dragover');
    });
    
    imageUploadArea?.addEventListener('drop', (e) => {
        e.preventDefault();
        imageUploadArea.classList.remove('dragover');
        handleEditImageFile(e.dataTransfer.files[0]);
    });
    
    // Remove image. While a replacement is being previewed this cancels that
    // choice and brings the saved cover back; otherwise it marks the saved
    // cover for removal, which takes effect when the album is saved.
    removeImageBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        coverInput.value = '';

        const cancellingReplacement = Boolean(editPreviewObjectUrl);
        releaseEditPreview();

        if (cancellingReplacement) {
            editImageData = null;
            imageChanged = false;
            await restoreExistingEditCover();
            return;
        }

        editImageData = null;
        imageChanged = true;
        imagePreview.classList.add('hidden');
        uploadPlaceholder.classList.remove('hidden');
        removeImageBtn.classList.add('hidden');
    });
    
    // Form submission
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const folder = form.dataset.folder;
        if (!folder) return;
        
        const newName = document.getElementById('editAlbumName').value.trim();
        const newDescription = document.getElementById('editAlbumDescription').value.trim();
        
        if (!newName) {
            alert('Please enter an album name.');
            return;
        }
        
        // Determine the cover image to save
        let newCover = undefined;
        if (imageChanged) {
            newCover = editImageData; // Could be null if removed
        }
        
        saveEditedAlbum(folder, newName, newDescription, newCover);

        // Reset state
        releaseEditPreview();
        editImageData = null;
        imageChanged = false;
    });

    // Leaving the dialog drops any preview URL it created.
    closeBtn?.addEventListener('click', releaseEditPreview);
    cancelBtn?.addEventListener('click', releaseEditPreview);
    backdrop?.addEventListener('click', releaseEditPreview);
}

// ============================================
// Library Management (Like, Add to Album, Remove from Album)
// ============================================

let currentContextSong = null; // {folder, track, sourceFolder, isUserAdded}
let selectedSongsToAdd = new Map(); // Map of {songKey: {sourceFolder, track}}
const MAX_SONGS_PER_BATCH = 50;

// Liked Songs Album Configuration
const LIKED_SONGS_FOLDER = '__liked_songs__';
let likedSongsAlbumConfig = null;

// ============================================
// The collections somebody builds for themselves
//
// Liked Songs, the playlists they made, and what they have been listening to.
// Each one is a list of track ids kept on this machine for their account; the
// songs are looked up against the library every time, so a file that has moved
// or a track that has been withdrawn is a missing row rather than a broken
// one.
//
// They are put into the same albumInfo and predefinedSongs the rest of the
// library uses, so every card, list, detail page and search result already
// knows how to draw them. Nothing about the interface is new.
// ============================================

/**
 * Recently Played, and its own name for itself.
 *
 * A collection is what its id says it is. This one names itself the way Local
 * Music does - a system collection, with "system:" in front of it - so the two
 * can be told apart by anything that has to tell them apart, and so neither
 * can ever end up standing in the other's place. They share no id, no key, no
 * object and no slot: the grid is drawn from these keys, never from a position
 * in a list, so what a card is does not depend on where it happens to sit.
 */
const RECENTLY_PLAYED_FOLDER = 'system:recently-played';
const PLAYLIST_FOLDER_PREFIX = 'playlist/';

/** The library key for one playlist. */
function playlistFolderFor(playlistId) {
    return PLAYLIST_FOLDER_PREFIX + playlistId;
}

/** The playlist id inside a library key, or null. */
function playlistIdFromFolder(folder) {
    if (typeof folder !== 'string' || !folder.startsWith(PLAYLIST_FOLDER_PREFIX)) return null;
    return folder.slice(PLAYLIST_FOLDER_PREFIX.length);
}

/**
 * Take a resolved track from a personal collection into the library.
 *
 * A collection answers with whole tracks, and a track it could not resolve
 * comes back carrying its id and nothing else. Both are kept: the second so a
 * listener can see that something is missing and take it out, rather than
 * finding a playlist quietly one song shorter than they left it.
 */
function rememberCollectionTrack(track) {
    if (!track || !track.id) return null;

    if (track.missing) {
        if (!window.libraryTracks[track.id]) {
            window.libraryTracks[track.id] = {
                id: track.id,
                source: track.source || null,
                title: 'Unavailable',
                artist: 'This song is not on this device',
                album: null,
                albumId: null,
                duration: null,
                artworkUrl: '',
                streamUrl: null,
                missing: true,
                metadata: {}
            };
        }
        return track.id;
    }

    if (!window.libraryTracks[track.id]) window.libraryTracks[track.id] = track;
    return track.id;
}

/**
 * Put this listener's own collections into the library.
 *
 * Called after the catalogue is arranged and whenever their library changes.
 * A guest has none of these, and what is removed here is removed completely:
 * signing out must not leave one person's playlists visible to the next.
 */
function applyPersonalCollections() {
    // Whatever was there from a previous account goes first, so nothing can
    // survive a change of listener.
    Object.keys(predefinedSongs)
        .filter(isPersonalFolder)
        .forEach((folder) => {
            delete predefinedSongs[folder];
            delete albumInfo[folder];
        });

    const personal = getPersonal();
    if (!personal || !personal.signedIn) return;

    applyLikedSongs(personal);
    applyPlaylists(personal);
    applyRecentlyPlayed(personal);
}

/** Liked Songs: the built-in collection, listed when there is one. */
function applyLikedSongs(personal) {
    const liked = personal.getLiked();
    if (!liked.length) return;

    predefinedSongs[LIKED_SONGS_FOLDER] = liked.map(rememberCollectionTrack).filter(Boolean);
    albumInfo[LIKED_SONGS_FOLDER] = {
        title: (likedSongsAlbumConfig && likedSongsAlbumConfig.title) || 'Liked Songs',
        artist: 'Songs you liked',
        description: (likedSongsAlbumConfig && likedSongsAlbumConfig.description) || "Songs you've liked",
        cover: (likedSongsAlbumConfig && likedSongsAlbumConfig.cover) || null,
        isLikedAlbum: true,
        isPersonalCollection: true
    };
}

/** Every playlist this listener has made. */
function applyPlaylists(personal) {
    personal.getPlaylists().forEach((playlist) => {
        const folder = playlistFolderFor(playlist.id);

        predefinedSongs[folder] = (playlist.tracks || []).map(rememberCollectionTrack).filter(Boolean);
        albumInfo[folder] = {
            title: playlist.title,
            artist: 'Playlist',
            description: playlist.description || '',
            cover: playlist.artworkUrl || null,
            playlistId: playlist.id,
            isPlaylist: true,
            isUserAlbum: true,
            isPersonalCollection: true,
            trackCount: playlist.trackCount,
            duration: playlist.duration,
            updatedAt: playlist.updatedAt
        };
    });
}

/** What was played lately, newest first. */
function applyRecentlyPlayed(personal) {
    const recent = personal.getRecentlyPlayed();
    if (!recent.length) return;

    predefinedSongs[RECENTLY_PLAYED_FOLDER] = recent.map(rememberCollectionTrack).filter(Boolean);
    albumInfo[RECENTLY_PLAYED_FOLDER] = {
        title: 'Recently Played',
        artist: 'What you have been listening to',
        description: 'The songs you played most recently',
        cover: null,
        isRecentlyPlayed: true,
        isPersonalCollection: true
    };
}

function initLibraryManagement() {
    initLikeButton();
    initContextMenu();
    initAddToAlbumModal();
    initAddSongsToLibrary();
    initLikedSongsAlbum();
}

/** The last song written down as played, so resuming it is not a second play. */
let lastNotedPlay = null;

/** What this listener's own library holds. */
function getPersonal() {
    return window.spotifiePersonal || null;
}

/**
 * Is this song liked?
 *
 * Asked while drawing, so it answers from what is already held rather than
 * going anywhere. A guest has liked nothing, and neither has somebody whose
 * library has not arrived yet.
 */
function isTrackLiked(trackId) {
    const personal = getPersonal();
    return Boolean(personal && personal.isLiked(trackId));
}

/**
 * Like a song, or unlike it.
 *
 * The one path for every heart on the page - the playbar, Now Playing, a row
 * in a list, the menu on a card. Each of them calls this and none of them
 * decides anything: the answer comes back through the change listener, which
 * redraws every heart at once, so two of them can never disagree.
 */
async function toggleTrackLike(trackId) {
    if (!trackId) return null;
    if (!requireAccount('Sign in to like songs')) return null;

    const personal = getPersonal();
    if (!personal) return null;

    try {
        const liked = await personal.toggleLike(trackId);
        showToast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
        return liked;
    } catch (error) {
        showToast('Could not save that. Try again.');
        return null;
    }
}

/**
 * Write one "Add to Liked Songs" menu row as liked or not.
 *
 * The wording changes with the state, because the row is the action: it says
 * what clicking it will do, not what is already true.
 */
function writeLikeMenuItem(item, liked) {
    if (!item) return;

    item.classList.toggle('liked', Boolean(liked));

    const label = item.querySelector('span');
    if (label) label.textContent = liked ? 'Remove from Liked Songs' : 'Add to Liked Songs';
}

/**
 * Redraw every heart on the page from what is held.
 *
 * Called whenever the liked songs change, from wherever they changed - the
 * playbar, a row, a menu, another tab's answer arriving. Nothing works out its
 * own state and nothing is passed a state to draw: each heart is asked about
 * the song it belongs to, so they cannot end up disagreeing.
 *
 * Only hearts. A change to what is liked does not rebuild the library, and a
 * hundred rows being redrawn is a hundred class toggles, not a hundred
 * renders.
 */
function syncLikeStates() {
    const playing = getCurrentEncodedTrack();
    if (playing) updateLikeButtonState(isTrackLiked(playing));

    document.querySelectorAll('[data-like-track]').forEach((element) => {
        const liked = isTrackLiked(element.dataset.likeTrack);
        element.classList.toggle('liked', liked);
        element.setAttribute('aria-pressed', liked ? 'true' : 'false');
        element.setAttribute('title', liked ? 'Remove from Liked Songs' : 'Add to Liked Songs');
    });
}

/**
 * Keep the page and this listener's library in step.
 *
 * The hearts are redrawn on every change. The library itself is rebuilt only
 * when something structural moved - a playlist made or deleted, songs added to
 * one - because that is what changes which cards exist. Liking a song changes
 * what is in Liked Songs, so that view is redrawn when it is the one being
 * looked at, and left alone when it is not.
 */
function watchPersonalLibrary() {
    const personal = getPersonal();
    if (!personal) return;

    let lastShape = '';

    personal.onChange(() => {
        syncLikeStates();

        // Which collections the library holds, in one string: whether there is
        // a Liked Songs to show at all, and which playlists exist. Unchanged
        // means the set of cards is unchanged, and there is nothing to build.
        //
        // Deliberately not the number of liked songs. Liking a song changes
        // what is inside Liked Songs and changes no card: the hearts are
        // redrawn above, in place, and every card on the page stays exactly
        // the card it was. Counting liked songs here meant every heart pressed
        // rebuilt the whole library - and with it re-resolved the artwork of
        // every album on screen - to change one icon.
        const shape = [
            personal.liked.size > 0 ? 'liked' : 'none',
            personal.playlists
                .map((playlist) => playlist.id + ':' + playlist.trackCount + ':' + playlist.updatedAt)
                .join(',')
        ].join('|');

        if (shape === lastShape) {
            // The cards are right. What is being looked at may not be: a song
            // unliked while Liked Songs is open has to leave the list.
            if (isPersonalFolder(currentFolder)) scheduleOpenViewRefresh();
            return;
        }

        lastShape = shape;
        schedulePersonalRefresh();
    });
}

/**
 * Redraw the list being looked at, without touching the cards.
 *
 * For the changes that alter what is inside a collection but not which
 * collections there are: a song liked or unliked while Liked Songs is open, a
 * song played while Recently Played is. One rebuild for a burst of them.
 */
let openViewRefreshHandle = null;

function scheduleOpenViewRefresh() {
    if (openViewRefreshHandle) return;

    openViewRefreshHandle = setTimeout(async () => {
        openViewRefreshHandle = null;
        try {
            applyPersonalCollections();
            if (isPersonalFolder(currentFolder) && predefinedSongs[currentFolder]) {
                await getsongs(currentFolder);
            }
        } catch (error) {
            console.warn('Could not redraw this view:', error && error.message);
        }
    }, 0);
}

/** One rebuild for a burst of changes, on the next frame rather than at once. */
let personalRefreshHandle = null;

function schedulePersonalRefresh() {
    if (personalRefreshHandle) return;

    personalRefreshHandle = setTimeout(async () => {
        personalRefreshHandle = null;
        try {
            await refreshPersonalViews();
        } catch (error) {
            console.warn('Could not redraw your library:', error && error.message);
        }
    }, 0);
}

/**
 * Put the personal parts of the library back on screen.
 *
 * The cards, because a playlist may have appeared or gone; and the list being
 * looked at, but only when it is one of the views this affects. Playback is
 * never touched.
 */
async function refreshPersonalViews() {
    applyPersonalCollections();
    await refreshAlbumCards();

    if (isPersonalFolder(currentFolder) && predefinedSongs[currentFolder]) {
        await getsongs(currentFolder);
    }
}

/**
 * Is this a collection the application itself provides?
 *
 * Local Music and Recently Played are not albums: nobody made them, nobody
 * named them and nobody chose what goes in them. They are what this machine
 * holds and what this listener has been playing, and neither can be renamed,
 * pinned or deleted - so the paths that do those things ask here first.
 *
 * Answered from the key rather than from anything drawn, so it is the same
 * answer before the grid exists, while it is being built, and afterwards.
 */
function isSystemFolder(folder) {
    if (typeof folder !== 'string') return false;
    if (folder === RECENTLY_PLAYED_FOLDER) return true;
    return folder.startsWith(LIBRARY_ALBUM_PREFIX + 'system:');
}

/** Is this one of the collections built out of somebody's own library? */
function isPersonalFolder(folder) {
    if (!folder) return false;
    return folder === LIKED_SONGS_FOLDER || folder === RECENTLY_PLAYED_FOLDER || folder.startsWith(PLAYLIST_FOLDER_PREFIX);
}

// ---- Like Button in Playbar ----
function initLikeButton() {
    const likeBtn = document.getElementById('likeCurrentSong');
    if (!likeBtn) return;

    likeBtn.addEventListener('click', async () => {
        if (!currentsong.src) return;

        const track = getCurrentEncodedTrack();
        if (!track) return;

        await toggleTrackLike(track);
    });
}

function updateLikeButtonState(isLiked) {
    // The same song is liked in the playbar and in Now Playing; both say so.
    const buttons = [document.getElementById('likeCurrentSong'), document.getElementById('nowPlayingLike')];

    buttons.forEach((likeBtn) => {
        if (!likeBtn) return;

        likeBtn.classList.toggle('liked', Boolean(isLiked));
        likeBtn.setAttribute('title', isLiked ? 'Remove from Liked Songs' : 'Add to Liked Songs');
        likeBtn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');
    });
}

function checkAndUpdateLikeButton() {
    if (!currentsong.src) return;

    const track = getCurrentEncodedTrack();
    if (!track) return;

    updateLikeButtonState(isTrackLiked(track));
}

// ---- Context Menu ----
function initContextMenu() {
    const contextMenu = document.getElementById('songContextMenu');
    if (!contextMenu) return;
    
    // Close context menu when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });
    
    // Handle context menu actions
    contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            
            if (!currentContextSong) return;
            
            switch (action) {
                case 'like': {
                    const liked = await toggleTrackLike(currentContextSong.track);
                    // Every heart is redrawn by the listener; this one row is
                    // written here because the menu is about to close.
                    if (liked !== null) writeLikeMenuItem(item, liked);
                    break;
                }
                    
                case 'addToAlbum':
                    showAddToAlbumModal(currentContextSong);
                    break;
                    
                case 'removeFromAlbum':
                    await handleRemoveFromAlbum(currentContextSong);
                    break;
            }
            
            hideContextMenu();
        });
    });
}

function showContextMenu(e, songData) {
    e.preventDefault();
    e.stopPropagation();
    
    const contextMenu = document.getElementById('songContextMenu');
    if (!contextMenu) return;
    
    currentContextSong = songData;
    
    // Position the menu
    const x = e.clientX || e.touches?.[0]?.clientX || 0;
    const y = e.clientY || e.touches?.[0]?.clientY || 0;
    
    contextMenu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    contextMenu.style.top = `${Math.min(y, window.innerHeight - 150)}px`;
    
    // Update like button state
    writeLikeMenuItem(contextMenu.querySelector('[data-action="like"]'), isTrackLiked(songData.track));

    
    // Show/hide remove option based on context
    const removeItem = contextMenu.querySelector('[data-action="removeFromAlbum"]');
    if (removeItem) {
        // Show remove option only when viewing an album
        removeItem.style.display = songData.folder ? 'flex' : 'none';
    }
    
    contextMenu.classList.remove('hidden');
}

function hideContextMenu() {
    const contextMenu = document.getElementById('songContextMenu');
    if (contextMenu) {
        contextMenu.classList.add('hidden');
    }
    currentContextSong = null;
}

// ---- Add to Album Modal ----
function initAddToAlbumModal() {
    const modal = document.getElementById('addToAlbumModal');
    const closeBtn = document.getElementById('closeAddToAlbum');
    const searchInput = document.getElementById('albumSearchInput');
    
    if (!modal) return;
    
    // Close modal
    closeBtn?.addEventListener('click', () => hideAddToAlbumModal());
    modal.querySelector('.modal-backdrop')?.addEventListener('click', () => hideAddToAlbumModal());
    
    // Search filter
    searchInput?.addEventListener('input', (e) => {
        filterAlbumsList(e.target.value);
    });
    
    // Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            hideAddToAlbumModal();
        }
    });
}

function showAddToAlbumModal(songData) {
    const modal = document.getElementById('addToAlbumModal');
    const songNameEl = modal?.querySelector('.add-to-album-song-name');
    const albumsList = document.getElementById('albumsList');
    const searchInput = document.getElementById('albumSearchInput');
    
    if (!modal || !albumsList) return;
    
    // Set song name from library metadata
    if (songNameEl) songNameEl.textContent = `Adding: ${trackDisplayTitle(songData.track)}`;
    
    // Clear search
    if (searchInput) searchInput.value = '';
    
    // Populate albums list
    populateAlbumsList(songData);
    
    modal.classList.remove('hidden');
}

function hideAddToAlbumModal() {
    const modal = document.getElementById('addToAlbumModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

async function populateAlbumsList(songData) {
    const albumsList = document.getElementById('albumsList');
    if (!albumsList) return;
    
    albumsList.innerHTML = '';
    
    // Get all albums (built-in + user created)
    const allAlbums = [];
    
    for (const folder in albumInfo) {
        const info = albumInfo[folder];

        // Liked Songs and Recently Played are not places to put a song: one is
        // decided by the heart and the other by what was played.
        if (info.isLikedAlbum || info.isRecentlyPlayed) continue;

        allAlbums.push({
            folder,
            name: info.title,
            cover: info.cover,
            playlistId: info.playlistId || null,
            isPlaylist: Boolean(info.isPlaylist),
            type: info.isPlaylist ? 'Playlist' : folder.startsWith('user_albums/') ? 'Your Album' : 'Album'
        });
    }
    
    // Check which albums already have this song
    const songSourceFolder = songData.sourceFolder || songData.folder;
    
    for (const album of allAlbums) {
        const item = document.createElement('button');
        item.className = 'album-list-item';
        item.dataset.folder = album.folder;
        
        // Is this song already in that album? Asked of the album as the
        // person sees it, and by track id alone: the album a song came from
        // has nothing to do with whether it is a member of this one.
        //
        // A playlist is never marked as full of it, because a playlist is an
        // arrangement: somebody may want the same song in it twice, and the
        // list is theirs to arrange.
        const isAlreadyAdded = !album.isPlaylist && (await albumHasTrack(album.folder, songData.track));

        // Also check if this is the source album
        const isSourceAlbum = !album.isPlaylist && album.folder === songSourceFolder;

        if (isAlreadyAdded || isSourceAlbum) {
            item.classList.add('added');
        }
        
        item.innerHTML = `
            <img src="${escapeHTML(albumCoverSrcNow(album))}" alt="${escapeHTML(album.name)}" onerror="this.onerror=null;this.src='${basePath}img/music.svg'">
            <div class="album-list-item-info">
                <p class="album-list-item-name">${escapeHTML(album.name)}</p>
                <p class="album-list-item-type">${album.type}</p>
            </div>
        `;
        
        item.addEventListener('click', async () => {
            if (item.classList.contains('added')) {
                showToast('Song already in this album');
                return;
            }
            
            // Both reference library tracks by id; audio is never copied.
            try {
                if (album.isPlaylist) {
                    const personal = getPersonal();
                    if (personal) await personal.addTrack(album.playlistId, songData.track);
                } else {
                    await addTrackToAlbumLocally(album.folder, songData.track, songSourceFolder);
                }
            } catch (error) {
                console.error('Could not add this song to the album:', error);
                showToast(error.status === 401 ? 'Sign in to change your library' : 'Could not add this song');
                return;
            }

            showToast(`Added to ${album.name}`);
            if (!album.isPlaylist) item.classList.add('added');

            if (album.isPlaylist) {
                await refreshPersonalViews();
            } else {
                await refreshAfterAlbumChange(currentFolder === album.folder ? album.folder : currentFolder);
            }
        });
        
        albumsList.appendChild(item);
    }
}

function filterAlbumsList(query) {
    const albumsList = document.getElementById('albumsList');
    if (!albumsList) return;
    
    const items = albumsList.querySelectorAll('.album-list-item');
    const lowerQuery = query.toLowerCase();
    
    items.forEach(item => {
        const name = item.querySelector('.album-list-item-name')?.textContent.toLowerCase() || '';
        item.style.display = name.includes(lowerQuery) ? 'flex' : 'none';
    });
}

// ---- Remove from Album ----
/**
 * Take one song out of the album being viewed.
 *
 * Three different things can be meant by that, and they are decided here,
 * once, by where the song's place in this album actually comes from:
 *
 * - a song this person added to this album keeps existing everywhere else;
 *   only its membership of this album goes;
 * - a published song in the album it was published in is hidden for this
 *   account, exactly as before;
 * - a song of the shared music root in its own album is hidden for this
 *   account too.
 *
 * In no case is audio deleted, and in no case does the album the song came
 * from change. Songs are matched by their catalogue id - never by file name,
 * title, or the album they arrived from - and one action clears every record
 * of that id in this album, including duplicates left by older versions.
 */
async function handleRemoveFromAlbum(songData) {
    if (!songData || !songData.folder || !songData.track) return;
    // Removing something from a library is a personal choice, stored per
    // account - a guest has nowhere to store it.
    if (!requireAccount('Sign in to change your library')) return;

    const albumFolder = songData.folder;
    const track = songData.track;
    const album = albumInfo[albumFolder];
    const isPublishedAlbum = Boolean(album && album.source === 'global' && album.albumId);

    // Was this song put into this album by this person, rather than being
    // part of it? That is what decides between membership and hiding.
    const addedHere = isPublishedAlbum
        ? (albumTrackAdditions[albumFolder] || []).includes(track)
        : await LibraryDB.isSongInAlbum(albumFolder, track);

    if (addedHere) {
        try {
            if (isPublishedAlbum) {
                const client = getCatalogClient();
                if (!client) return;
                await client.removeTrackFromAlbum(album.albumId, track);
            } else {
                await LibraryDB.removeSongFromAlbum(albumFolder, track);
            }
        } catch (error) {
            console.error('Could not remove this song from the album:', error);
            showToast(error.status === 401 ? 'Sign in to change your library' : 'Could not remove this song');
            return;
        }

        showToast('Song removed from album');
        await refreshAfterAlbumChange(albumFolder);
        return;
    }

    const catalogTrack = getLibraryTrack(track);

    // Removing something an administrator published only hides it for this
    // account. The shared copy is never modified or deleted from here; other
    // listeners keep seeing it.
    if (catalogTrack && catalogTrack.source === 'global') {
        const client = getCatalogClient();
        if (!client) return;

        try {
            await client.hide(track);
        } catch (error) {
            console.error('Could not hide this track:', error);
            showToast(error.status === 401 ? 'Sign in to change your library' : 'Could not hide this track');
            return;
        }

        showToast('Hidden from your library');
        await refreshAfterAlbumChange(albumFolder);
        return;
    }

    // A song of this device in its own album: hidden for this account, with
    // the file left where it is.
    await LibraryDB.markSongAsRemoved(albumFolder, track);
    showToast('Song hidden from album');
    await refreshAfterAlbumChange(albumFolder);
}

/**
 * Read the catalogue again and redraw everything that shows an album: the
 * cards and their counts, the song list, and the queue it feeds. Done once,
 * after the change is stored, so nothing is drawn from stale membership.
 */
async function refreshAfterAlbumChange(albumFolder) {
    await loadSongsConfig();
    await refreshAlbumCards();
    await getsongs(albumFolder);
}

// ---- Toast Notification ----
function showToast(message, duration = 2500) {
    // Remove existing toast
    const existingToast = document.querySelector('.toast-notification');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Remove after duration
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ============================================
// Add Songs to Album (Browse & Multi-Select)
// ============================================

let currentAddSongsTab = 'library';

function initAddSongsToLibrary() {
    const addSongsBtn = document.getElementById('addSongsToLibraryBtn');
    const modal = document.getElementById('addSongsModal');
    const closeBtn = document.getElementById('closeAddSongs');
    const cancelBtn = document.getElementById('cancelAddSongs');
    const confirmBtn = document.getElementById('confirmAddSongs');
    const searchInput = document.getElementById('addSongsSearchInput');
    const albumFilter = document.getElementById('addSongsAlbumFilter');
    
    if (!addSongsBtn || !modal) return;
    
    // Show button when viewing an album
    addSongsBtn.addEventListener('click', () => {
        if (!requireAccount('Sign in to add songs to your own albums')) return;
        if (!currentFolder) {
            showToast('Please select an album first');
            return;
        }

        // Local Music is whatever is on this machine: songs arrive in it by
        // being on the disk, not by being put there.
        if (albumInfo[currentFolder] && albumInfo[currentFolder].isSystemCollection) {
            showToast('Local Music follows the music on this device');
            return;
        }

        showAddSongsModal(currentFolder);
    });
    
    // Close modal
    closeBtn?.addEventListener('click', hideAddSongsModal);
    cancelBtn?.addEventListener('click', hideAddSongsModal);
    modal.querySelector('.modal-backdrop')?.addEventListener('click', hideAddSongsModal);
    
    // Confirm adding songs
    confirmBtn?.addEventListener('click', async () => {
        await addSelectedSongsToAlbum();
    });
    
    // Search filter
    searchInput?.addEventListener('input', (e) => {
        filterAddSongsList(e.target.value);
    });
    
    // Album filter
    albumFilter?.addEventListener('change', (e) => {
        populateAddSongsList(currentFolder, e.target.value);
    });
    
    // Tab switching
    initAddSongsTabs();
    
    // Device file upload
    initDeviceUpload();
    
    // Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            hideAddSongsModal();
        }
    });
}

function initAddSongsTabs() {
    document.querySelectorAll('.add-songs-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            switchAddSongsTab(tabName);
        });
    });
}

function switchAddSongsTab(tabName) {
    currentAddSongsTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.add-songs-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Show/hide content
    const libraryContent = document.getElementById('libraryTabContent');
    const deviceContent = document.getElementById('deviceTabContent');
    
    if (libraryContent) libraryContent.classList.toggle('hidden', tabName !== 'library');
    if (deviceContent) deviceContent.classList.toggle('hidden', tabName !== 'device');
    
    // Update button state
    updateSelectedCount();
}

/**
 * Adding music from this device.
 *
 * The browser can only offer what the person picks, so this is an explicit
 * chooser: files are read from the picker or a drop, sent one by one to the
 * local server, and kept on this machine under this account. Nothing is
 * uploaded anywhere else, nothing is turned into Base64, and no File object
 * or blob: URL is ever stored - the server answers with a stable track id and
 * that is what the album keeps.
 *
 * The import adapter is deliberately the only part that knows about a file
 * picker: a desktop or mobile build replaces this step alone.
 */

// Formats the local library indexes (P2).
const DEVICE_AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus'];
const DEVICE_MAX_FILE_BYTES = 100 * 1024 * 1024;

let deviceFilesToImport = [];

function deviceFileKey(file) {
    return [file.name, file.size, file.lastModified || 0].join('::');
}

function hasAudioExtension(name) {
    const lower = String(name || '').toLowerCase();
    return DEVICE_AUDIO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const megabytes = bytes / (1024 * 1024);
    return megabytes >= 1 ? megabytes.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function initDeviceUpload() {
    const uploadArea = document.getElementById('deviceUploadArea');
    const fileInput = document.getElementById('deviceFileInput');

    deviceFilesToImport = [];

    if (fileInput) {
        fileInput.disabled = false;
        fileInput.addEventListener('change', () => {
            addDeviceFiles(fileInput.files);
            // Cleared so choosing the same file again still counts as a change.
            fileInput.value = '';
        });
    }

    if (!uploadArea) return;

    uploadArea.addEventListener('click', () => {
        if (!requireAccount('Sign in to add music from this device')) return;
        if (fileInput) fileInput.click();
    });

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        if (!requireAccount('Sign in to add music from this device')) return;
        addDeviceFiles(e.dataTransfer ? e.dataTransfer.files : null);
    });
}

/**
 * Take what the person chose into the pending list.
 * Anything the library cannot index is refused here, before a single byte
 * leaves the page.
 */
function addDeviceFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const known = new Set(deviceFilesToImport.map(deviceFileKey));
    const rejected = [];
    let full = false;

    for (const file of files) {
        if (deviceFilesToImport.length >= MAX_SONGS_PER_BATCH) {
            full = true;
            break;
        }
        if (!hasAudioExtension(file.name)) {
            rejected.push(file.name + ' is not a supported audio file');
            continue;
        }
        if (file.size > DEVICE_MAX_FILE_BYTES) {
            rejected.push(file.name + ' is larger than 100 MB');
            continue;
        }
        if (known.has(deviceFileKey(file))) continue;

        known.add(deviceFileKey(file));
        deviceFilesToImport.push(file);
    }

    renderDeviceFilesList();
    updateSelectedCount();

    if (full) showToast(`Maximum ${MAX_SONGS_PER_BATCH} songs can be added at once`);
    if (rejected.length) showToast(rejected.length === 1 ? rejected[0] : `${rejected.length} files were not supported`);
}

/** The pending list, rebuilt in one pass so a large selection stays smooth. */
function renderDeviceFilesList() {
    const listEl = document.getElementById('deviceFilesList');
    if (!listEl) return;

    if (!deviceFilesToImport.length) {
        listEl.innerHTML = '';
        return;
    }

    const fragment = document.createDocumentFragment();

    deviceFilesToImport.forEach((file, index) => {
        const row = document.createElement('div');
        row.className = 'device-file-item';
        row.innerHTML = `
            <div class="file-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2"/>
                    <circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2"/>
                </svg>
            </div>
            <div class="file-info">
                <div class="file-name">${escapeHTML(file.name)}</div>
                <div class="file-size">${escapeHTML(formatFileSize(file.size))}</div>
            </div>
            <button type="button" class="remove-file-btn" aria-label="Remove ${escapeHTML(file.name)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </button>`;

        row.querySelector('.remove-file-btn').addEventListener('click', () => {
            deviceFilesToImport.splice(index, 1);
            renderDeviceFilesList();
            updateSelectedCount();
        });

        fragment.appendChild(row);
    });

    listEl.innerHTML = '';
    listEl.appendChild(fragment);
}

/**
 * Import the chosen files and put them in the album.
 *
 * Files go one at a time, so a file the server refuses only costs that file:
 * everything else still arrives, and the person is told what happened.
 */
async function importDeviceFilesToAlbum(targetAlbum) {
    const client = getCatalogClient();
    if (!client || !deviceFilesToImport.length) return { added: 0, failed: 0 };

    const confirmBtn = document.getElementById('confirmAddSongs');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Adding…';
    }

    const files = deviceFilesToImport.slice(0, MAX_SONGS_PER_BATCH);
    const failures = [];
    const trackIds = [];

    for (const file of files) {
        try {
            const result = await client.importDeviceTrack(file);
            if (result && result.track && result.track.id) trackIds.push('local:' + result.track.id);
        } catch (err) {
            console.error('Could not add this file:', file.name, err);
            failures.push(err && err.status === 401 ? 'Sign in again to add music' : file.name);
        }
    }

    let added = 0;
    for (const trackId of trackIds) {
        try {
            await addTrackToAlbumLocally(targetAlbum, trackId);
            added += 1;
        } catch (err) {
            console.error('Could not put this track in the album:', trackId, err);
            failures.push('One song was saved but not added to the album');
        }
    }

    deviceFilesToImport = [];
    renderDeviceFilesList();

    return { added: added, failed: failures.length, failures: failures };
}

/**
 * Put a local track into an album, on the right side of the boundary.
 *
 * A published album takes a personal addition, recorded for this account by
 * the server; one of the person's own albums keeps its membership on this
 * device as it always has. Neither path writes to the shared catalogue.
 */
/**
 * Whether an album already holds a track, as this person sees that album:
 * what it is made of, plus anything they have added to it. Matched by
 * catalogue id only.
 */
async function albumHasTrack(albumFolder, trackId) {
    if ((predefinedSongs[albumFolder] || []).includes(trackId)) return true;
    if ((albumTrackAdditions[albumFolder] || []).includes(trackId)) return true;
    return LibraryDB.isSongInAlbum(albumFolder, trackId);
}

async function addTrackToAlbumLocally(targetAlbum, trackId, sourceFolder) {
    const info = albumInfo[targetAlbum];

    // Nothing is ever recorded as belonging to Local Music: it is the music on
    // this machine, and that is decided by the machine.
    if (info && info.isSystemCollection) return;

    // A song is a member of an album once. Adding it again changes nothing.
    if (await albumHasTrack(targetAlbum, trackId)) return;

    if (info && info.source === 'global' && info.albumId) {
        const client = getCatalogClient();
        if (!client) throw new Error('Catalogue client unavailable');
        await client.addTrackToAlbum(info.albumId, trackId);
        return;
    }

    const from = sourceFolder || libraryFolderForTrack(trackId) || targetAlbum;
    await LibraryDB.addSongToAlbum(targetAlbum, from, trackId);
}

/** The album folder a track belongs to in this page's model. */
function libraryFolderForTrack(trackId) {
    const track = (window.libraryTracks || {})[trackId];
    return track && track.albumId ? libraryFolderForAlbum(track.albumId) : null;
}


function showAddSongsModal(targetAlbum) {
    const modal = document.getElementById('addSongsModal');
    const targetAlbumEl = document.getElementById('addSongsTargetAlbum');
    const albumFilter = document.getElementById('addSongsAlbumFilter');
    const searchInput = document.getElementById('addSongsSearchInput');
    
    if (!modal) return;
    
    // Clear selection
    selectedSongsToAdd.clear();
    updateSelectedCount();
    
    // Reset to library tab
    switchAddSongsTab('library');
    
    // Set target album name
    const albumName = albumInfo[targetAlbum]?.title || targetAlbum.split('/').pop();
    if (targetAlbumEl) targetAlbumEl.textContent = `Adding to: ${albumName}`;
    
    // Clear search
    if (searchInput) searchInput.value = '';
    
    // Populate album filter dropdown
    if (albumFilter) {
        // Named collections only: Local Music, the albums someone made and
        // the albums an administrator published. Never a folder name.
        albumFilter.innerHTML = '<option value="all">All Music</option>';
        const folders = Object.keys(predefinedSongs)
            .filter((folder) => folder !== targetAlbum && folder !== LIKED_SONGS_FOLDER)
            .filter((folder) => albumInfo[folder] && albumInfo[folder].title)
            .sort((a, b) => albumPriority(a) - albumPriority(b));

        for (const folder of folders) {
            const option = document.createElement('option');
            option.value = folder;
            option.textContent = albumInfo[folder].title;
            albumFilter.appendChild(option);
        }
    }
    
    // Populate songs list
    populateAddSongsList(targetAlbum, 'all');
    
    modal.classList.remove('hidden');
}

function hideAddSongsModal() {
    const modal = document.getElementById('addSongsModal');
    if (modal) {
        modal.classList.add('hidden');
    }
    selectedSongsToAdd.clear();
    deviceFilesToImport = [];
    renderDeviceFilesList();
}

/**
 * The songs one album holds, as this person sees it.
 *
 * What the catalogue says the album is made of, plus anything they have put
 * there themselves. Ids only - the catalogue is what says what each one is.
 */
async function albumTrackIds(folder) {
    const ids = (predefinedSongs[folder] || []).slice();
    for (const trackId of albumTrackAdditions[folder] || []) ids.push(trackId);

    try {
        const added = await LibraryDB.getUserSongsForAlbum(folder);
        for (const entry of added) ids.push(entry.track);
    } catch (e) {
        /* the album simply has nothing added to it here */
    }

    return Array.from(new Set(ids));
}

/**
 * Everything this person could put in an album.
 *
 * One list, taken from the catalogue itself: the music found on this device,
 * the music they imported, the shared music root and what an administrator
 * published - each song once, whichever collection it is seen through. An id
 * the catalogue no longer knows is left out rather than shown as itself.
 */
async function libraryCandidates(targetAlbum, sourceAlbumFilter) {
    const tracks = window.libraryTracks || {};
    const chosen = new Map();

    if (sourceAlbumFilter && sourceAlbumFilter !== 'all') {
        for (const trackId of await albumTrackIds(sourceAlbumFilter)) {
            const track = tracks[trackId];
            if (track && !chosen.has(trackId)) chosen.set(trackId, track);
        }
        return Array.from(chosen.values());
    }

    // Everything the catalogue holds, plus songs an album of their own points
    // at that are not in an album of the catalogue's own.
    for (const trackId of Object.keys(tracks)) chosen.set(trackId, tracks[trackId]);

    for (const folder of Object.keys(predefinedSongs)) {
        if (folder === targetAlbum) continue;
        for (const trackId of await albumTrackIds(folder)) {
            const track = tracks[trackId];
            if (track && !chosen.has(trackId)) chosen.set(trackId, track);
        }
    }

    return Array.from(chosen.values());
}

/** The collection a song is shown as coming from. */
function trackCollectionName(track) {
    const folder = libraryFolderForAlbum(track.albumId);
    const info = albumInfo[folder];
    if (info && info.title) return info.title;
    return track.album || 'Local Music';
}

async function populateAddSongsList(targetAlbum, sourceAlbumFilter) {
    const songsList = document.getElementById('addSongsList');
    if (!songsList) return;

    songsList.innerHTML = '<div class="no-songs-message">Loading songs...</div>';

    // Songs already in the target album, by track id: a song that is
    // there is there, whichever album it was added from.
    const existingTracks = new Set(await albumTrackIds(targetAlbum));

    // Every song this person could add, each one once.
    const allSongs = (await libraryCandidates(targetAlbum, sourceAlbumFilter)).map((track) => ({
        sourceFolder: libraryFolderForAlbum(track.albumId),
        track: track.id,
        songKey: track.id,
        albumName: trackCollectionName(track),
        artist: trackDisplayArtist(track.id),
        source: track.source,
        isAlreadyAdded: existingTracks.has(track.id)
    }));

    allSongs.sort((a, b) => trackDisplayTitle(a.track).localeCompare(trackDisplayTitle(b.track)));
    
    if (allSongs.length === 0) {
        songsList.innerHTML = `
            <div class="no-songs-message">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2"/>
                    <circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2"/>
                </svg>
                <p>No songs available</p>
            </div>`;
        return;
    }
    
    songsList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    
    for (const song of allSongs) {
        const item = document.createElement('div');
        item.className = `add-songs-item${song.isAlreadyAdded ? ' already-added' : ''}`;
        item.dataset.songKey = song.songKey;
        item.dataset.sourceFolder = song.sourceFolder;
        item.dataset.track = song.track;
        
        const songName = trackDisplayTitle(song.track);
        
        // A song already in this album says so; otherwise the badge says
        // where it comes from, which is what someone choosing needs to know.
        let badge = '';
        if (song.isAlreadyAdded) {
            badge = '<span class="user-added-badge">Added</span>';
        } else if (song.source === 'local') {
            badge = '<span class="user-added-badge">LOCAL</span>';
        } else if (song.source === 'global') {
            badge = '<span class="user-added-badge">GLOBAL</span>';
        }

        // The artist under the title, and the collection it is in beside it.
        const artistLine = song.artist ? song.artist + ' · ' + song.albumName : song.albumName;

        item.innerHTML = `
            <div class="add-songs-item-checkbox">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M20 6L9 17L4 12" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
            <div class="add-songs-item-info">
                <div class="add-songs-item-name">${escapeHTML(songName)}</div>
                <div class="add-songs-item-album">${escapeHTML(artistLine)}</div>
            </div>
            ${badge}
        `;
        
        if (!song.isAlreadyAdded) {
            item.addEventListener('click', () => toggleSongSelection(item, song));
        }
        
        fragment.appendChild(item);
    }
    
    songsList.appendChild(fragment);
}

function toggleSongSelection(item, song) {
    const songKey = song.songKey;
    
    if (selectedSongsToAdd.has(songKey)) {
        selectedSongsToAdd.delete(songKey);
        item.classList.remove('selected');
    } else {
        if (selectedSongsToAdd.size >= MAX_SONGS_PER_BATCH) {
            showToast(`Maximum ${MAX_SONGS_PER_BATCH} songs can be selected at once`);
            return;
        }
        selectedSongsToAdd.set(songKey, {
            sourceFolder: song.sourceFolder,
            track: song.track
        });
        item.classList.add('selected');
    }
    
    updateSelectedCount();
}

function updateSelectedCount() {
    const countEl = document.getElementById('selectedSongsCount');
    const confirmBtn = document.getElementById('confirmAddSongs');

    // Both tabs feed one count: songs picked from the library, and files
    // waiting to come in from this device.
    const totalCount = selectedSongsToAdd.size + deviceFilesToImport.length;
    
    if (countEl) {
        countEl.textContent = `${totalCount} selected`;
        countEl.classList.toggle('has-selection', totalCount > 0);
    }
    
    if (confirmBtn) {
        confirmBtn.disabled = totalCount === 0;
        confirmBtn.textContent = totalCount > 0 ? `Add ${totalCount} Song${totalCount > 1 ? 's' : ''}` : 'Add Selected Songs';
    }
}

function filterAddSongsList(query) {
    const songsList = document.getElementById('addSongsList');
    if (!songsList) return;
    
    const items = songsList.querySelectorAll('.add-songs-item');
    const lowerQuery = query.toLowerCase();
    
    items.forEach(item => {
        // Title, artist and collection are all on screen, and all searchable.
        // A song's place on the disk is not one of them.
        const name = item.querySelector('.add-songs-item-name')?.textContent.toLowerCase() || '';
        const album = item.querySelector('.add-songs-item-album')?.textContent.toLowerCase() || '';
        const track = getLibraryTrack(item.dataset.track);
        const tagged = track && track.album ? track.album.toLowerCase() : '';

        const matches = name.includes(lowerQuery) || album.includes(lowerQuery) || tagged.includes(lowerQuery);
        item.style.display = matches ? 'flex' : 'none';
    });
}

async function addSelectedSongsToAlbum() {
    if (selectedSongsToAdd.size === 0 && deviceFilesToImport.length === 0) return;

    const targetAlbum = currentFolder;
    let addedCount = 0;
    const failures = [];

    // Songs already in the library: the album keeps a reference, and the file
    // is not copied anywhere.
    for (const [, songData] of selectedSongsToAdd) {
        try {
            await addTrackToAlbumLocally(targetAlbum, songData.track, songData.sourceFolder);
            addedCount++;
        } catch (err) {
            console.error('Failed to add song:', err);
            failures.push(err && err.status === 401 ? 'Sign in again to change this album' : 'One song could not be added');
        }
    }

    // Files from this device: saved locally first, then added the same way.
    if (deviceFilesToImport.length) {
        const imported = await importDeviceFilesToAlbum(targetAlbum);
        addedCount += imported.added;
        failures.push(...(imported.failures || []));
    }

    hideAddSongsModal();

    if (addedCount) {
        showToast(`Added ${addedCount} song${addedCount > 1 ? 's' : ''} to album`);
    }
    if (failures.length) {
        showToast(failures.length === 1 ? failures[0] : `${failures.length} songs could not be added`);
    }

    // The catalogue now holds this account's newly imported music, so the
    // albums, the sidebar and the counts are all read again.
    await loadSongsConfig();
    await getsongs(targetAlbum);
    await refreshAlbumCards();
}

// ============================================
// Liked Songs Album (Dynamic Creation)
// ============================================

async function initLikedSongsAlbum() {
    // Load saved liked album config from localStorage
    const savedConfig = localStorage.getItem('likedSongsAlbumConfig');
    if (savedConfig) {
        try {
            likedSongsAlbumConfig = JSON.parse(savedConfig);
        } catch {
            likedSongsAlbumConfig = null;
        }
    }
    
    // Note: checkAndCreateLikedSongsAlbum() is already called from main()
    // This function is kept for initialization of the likedSongsAlbumConfig variable
}

/**
 * Put Liked Songs and the rest of this listener's collections in place.
 *
 * Kept under its old name because several places call it at the point where
 * the library should be brought up to date; what it does now is read from
 * their own library rather than from the browser's storage.
 */
async function checkAndCreateLikedSongsAlbum() {
    // These are personal: a guest has none, and neither has somebody whose
    // library has not been read yet.
    if (!isSignedIn()) {
        applyPersonalCollections();
        return;
    }

    // The name and cover a listener chose for their own Liked Songs.
    if (!likedSongsAlbumConfig) {
        const savedConfig = localStorage.getItem('likedSongsAlbumConfig');
        if (savedConfig) {
            try {
                likedSongsAlbumConfig = JSON.parse(savedConfig);
            } catch {
                likedSongsAlbumConfig = null;
            }
        }
    }

    const personal = getPersonal();
    if (personal && !personal.loaded) await personal.load();

    applyPersonalCollections();
}

function saveLikedSongsConfig() {
    if (likedSongsAlbumConfig) {
        localStorage.setItem('likedSongsAlbumConfig', JSON.stringify(likedSongsAlbumConfig));
    }
}

/**
 * Liked Songs is drawn the way every other collection is.
 *
 * It used to have a rendering path of its own, reading the browser's storage
 * and building its own rows - so a change to how a song is listed had to be
 * made twice, and the two drifted. It is a list of track ids like any other
 * now, so the one list-drawing path draws it, and Liked Songs looks exactly
 * like everything else because it is exactly like everything else.
 *
 * What is kept here is the button that only makes sense once a collection is
 * open.
 */
const originalGetSongs = getsongs;
getsongs = async function (folder) {
    const result = await originalGetSongs(folder);

    const addSongsBtn = document.getElementById('addSongsToLibraryBtn');
    if (addSongsBtn) addSongsBtn.classList.remove('hidden');

    return result;
};

// ===================== Backup & Restore =====================
let pendingImportData = null;

// ============================================
// Taking a library with you
//
// A backup is a document of references: canonical track ids, the names people
// gave things, and the id of a cover this machine holds. It carries no audio,
// no pictures, nothing Base64-encoded, no address that expires and nothing
// about an account beyond what that account arranged - so it is small, it is
// safe to hand to somebody, and restoring it on another machine reconnects to
// whatever music that machine already has.
//
// The server writes it and reads it back, because the server is where the
// checking belongs: an imported file is untrusted input, and one place decides
// what it may contain.
// ============================================

const BACKUP_FORMAT = 'spotifie-backup';
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

/**
 * The albums somebody made in this page, in the shape a backup carries.
 *
 * These live in the browser rather than on the server, so they travel in the
 * document alongside the rest - a library that restores without them is not
 * the library that was backed up.
 */
function localAlbumsForBackup() {
    const albums = [];

    Object.keys(albumInfo).forEach((folder) => {
        const info = albumInfo[folder];
        if (!info || !info.isUserAlbum || info.isPlaylist) return;

        albums.push({
            folder: folder,
            title: info.title || '',
            artist: info.artist || null,
            description: info.description || null,
            // The id of a picture this machine holds, never the picture and
            // never the address it is served at today.
            artworkReference: artworkReferenceFrom(info.cover),
            trackIds: (predefinedSongs[folder] || []).slice(),
            isPinned: Boolean(info.isPinned)
        });
    });

    return albums;
}

/** Ask the server for this account's library as a document. */
async function requestLibraryBackup() {
    const client = getCatalogClient();
    if (!client) throw new Error('The catalogue is not available');

    const albums = encodeURIComponent(JSON.stringify(localAlbumsForBackup()));
    return client._request('/api/catalog/backup?localAlbums=' + albums);
}

/** Hand a document to the server to check, merge and save. */
async function restoreLibraryBackup(document) {
    const client = getCatalogClient();
    if (!client) throw new Error('The catalogue is not available');

    return client._request('/api/catalog/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(document)
    });
}

/**
 * Put restored albums back into this page's own library.
 *
 * Merged, not replaced: an album already here keeps what it has, and one from
 * the backup is added beside it. The songs are references, so an album whose
 * music this machine does not have is still restored - it simply has nothing
 * to play until that music turns up.
 */
function restoreLocalAlbums(albums) {
    if (!Array.isArray(albums) || !albums.length) return 0;

    let restored = 0;

    albums.forEach((album) => {
        if (!album || !album.folder || userAlbums[album.folder]) return;

        userAlbums[album.folder] = {
            files: album.trackIds || [],
            info: {
                title: album.title,
                artist: album.artist || '',
                description: album.description || '',
                // An artwork id becomes the address this machine serves it at.
                // If the file is gone the picture simply does not load, and the
                // album shows the default cover like any other.
                cover: album.artworkReference ? '/api/library/artwork/' + encodeURIComponent(album.artworkReference) : null,
                isUserAlbum: true,
                isPinned: Boolean(album.isPinned)
            }
        };

        predefinedSongs[album.folder] = userAlbums[album.folder].files;
        albumInfo[album.folder] = userAlbums[album.folder].info;
        restored += 1;
    });

    if (restored) saveUserAlbums();
    return restored;
}

/**
 * Say what the import did, in the terms somebody reading it cares about.
 *
 * How much came back, and how many of the songs it names this machine can
 * actually play. A song it cannot is worth saying plainly: it is not lost and
 * it is not an error, it is somewhere else, and it reconnects by itself when
 * it turns up.
 */
function showImportSummary(summary) {
    if (!summary) {
        showToast('Library restored');
        return;
    }

    const parts = [];
    if (summary.albumsRestored) parts.push(summary.albumsRestored + ' albums');
    if (summary.playlistsRestored) parts.push(summary.playlistsRestored + ' playlists');
    if (summary.likedRestored) parts.push(summary.likedRestored + ' liked songs');

    const restored = parts.length ? 'Restored ' + parts.join(', ') : 'Nothing new to restore';
    const connected = summary.tracksConnected + ' of ' + summary.tracksReferenced + ' songs found here';

    showToast(restored + '. ' + connected + '.');

    if (summary.tracksUnavailable > 0) {
        // Said once, without alarm: these are songs that live somewhere else.
        console.log(
            summary.tracksUnavailable +
                ' song(s) in this backup are not on this device. They stay in your library and reconnect if they turn up.'
        );
    }
}

/**
 * Ask a question and wait for the answer.
 *
 * The application's own dialog, not the browser's. alert() and confirm() stop
 * the page dead, cannot be styled, look like nothing else here, and on a phone
 * are somebody else's design entirely - so anything that needs an answer asks
 * through this.
 *
 * Answers true only when somebody actually chose the confirming button.
 * Closing it, pressing Escape or clicking away all mean no, because a question
 * somebody dismissed is not a question they agreed to.
 */
/**
 * Everything a dialog opened over another dialog has to do.
 *
 * The one underneath is put beyond reach - not by a pointer, not by Tab, not
 * by a screen reader - and the keyboard is kept inside the question until it
 * is answered. Answers a function that puts it all back exactly as it was.
 *
 * "inert" is the document's own word for this, so a browser that has it does
 * the work; one that does not is left with a question in front, which is the
 * layer's job and does not depend on this.
 */
function holdDialogOpen(dialog) {
    const covered = Array.from(document.querySelectorAll('.modal')).filter(
        (other) => other !== dialog && !other.classList.contains('hidden')
    );

    covered.forEach((other) => {
        other.inert = true;
    });

    const focusable = () =>
        Array.from(
            dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ).filter((element) => !element.disabled && element.offsetParent !== null);

    // Tab and Shift+Tab wrap around inside the question rather than walking
    // out of it into a dialog nobody can see.
    const onTab = (event) => {
        if (event.key !== 'Tab') return;

        const stops = focusable();
        if (!stops.length) return;

        const first = stops[0];
        const last = stops[stops.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    document.addEventListener('keydown', onTab, true);

    return () => {
        document.removeEventListener('keydown', onTab, true);
        covered.forEach((other) => {
            other.inert = false;
        });
    };
}

/** Is a question waiting for an answer? Anything else with a key handler asks. */
function dialogIsAsking() {
    return Array.from(document.querySelectorAll('.modal-confirm')).some(
        (modal) => !modal.classList.contains('hidden')
    );
}

function confirmAction(details) {
    const settings = details || {};
    const modal = document.getElementById('askModal');
    if (!modal) return Promise.resolve(false);

    const title = document.getElementById('askTitle');
    const message = document.getElementById('askMessage');
    const options = document.getElementById('askOptions');
    const confirm = document.getElementById('askConfirm');
    const cancel = document.getElementById('askCancel');
    const close = document.getElementById('askClose');
    const backdrop = modal.querySelector('.modal-backdrop');

    // Set as text: every word here may have come from a file's tags or from
    // something somebody typed.
    if (title) title.textContent = settings.title || 'Are you sure?';
    if (message) {
        message.textContent = settings.message || '';
        message.classList.toggle('hidden', !settings.message);
    }
    if (options) {
        options.replaceChildren();
        options.classList.add('hidden');
    }
    if (confirm) confirm.textContent = settings.confirmLabel || 'Confirm';

    modal.classList.remove('hidden');

    // What asked the question waits, untouchable, until it has an answer.
    const release = holdDialogOpen(modal);
    const returnFocusTo = document.activeElement;

    return new Promise((resolve) => {
        const finish = (answer) => {
            modal.classList.add('hidden');
            release();

            confirm?.removeEventListener('click', onConfirm);
            cancel?.removeEventListener('click', onCancel);
            close?.removeEventListener('click', onCancel);
            backdrop?.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey, true);

            // Back where it came from, which is usually a row in the dialog
            // underneath.
            if (returnFocusTo && returnFocusTo.focus && document.contains(returnFocusTo)) returnFocusTo.focus();

            resolve(answer);
        };

        const onConfirm = () => finish(true);
        const onCancel = () => finish(false);
        const onKey = (event) => {
            if (event.key !== 'Escape') return;

            // Escape answers the question and stops there. Without this it
            // reached the dialog underneath as well, and one press closed
            // both - so cancelling put away the thing being asked about.
            event.stopPropagation();
            finish(false);
        };

        confirm?.addEventListener('click', onConfirm);
        cancel?.addEventListener('click', onCancel);
        close?.addEventListener('click', onCancel);
        backdrop?.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey, true);

        confirm?.focus();
    });
}

/**
 * Ask which one, out of a list.
 *
 * Answers the chosen value, or null when somebody decided not to. Built from
 * the same dialog as the question above, so there is one thing to look at and
 * one thing to maintain.
 */
function chooseFromList(details) {
    const settings = details || {};
    const modal = document.getElementById('askModal');
    const options = document.getElementById('askOptions');
    if (!modal || !options) return Promise.resolve(null);

    const title = document.getElementById('askTitle');
    const message = document.getElementById('askMessage');
    const confirm = document.getElementById('askConfirm');
    const cancel = document.getElementById('askCancel');
    const close = document.getElementById('askClose');
    const backdrop = modal.querySelector('.modal-backdrop');

    if (title) title.textContent = settings.title || 'Choose one';
    if (message) {
        message.textContent = '';
        message.classList.add('hidden');
    }
    // Choosing is the action: there is nothing left for a confirm button to do.
    if (confirm) confirm.classList.add('hidden');

    options.replaceChildren(
        ...(settings.options || []).map((option) => {
            const row = document.createElement('li');
            row.append(document.createElement('span'));

            const button = document.createElement('button');
            button.type = 'button';
            // How it looks belongs to the stylesheet, so a change of theme
            // reaches it like everything else. Nothing here paints anything.
            button.className = 'local-track-main local-choice';
            button.dataset.value = option.value;
            button.textContent = option.label;

            row.append(button, document.createElement('span'));
            return row;
        })
    );
    options.classList.remove('hidden');

    modal.classList.remove('hidden');

    // The same rules as the question above: whatever asked this waits behind
    // it, out of reach, and the keyboard stays in here until it is answered.
    const release = holdDialogOpen(modal);
    const returnFocusTo = document.activeElement;

    return new Promise((resolve) => {
        const finish = (answer) => {
            modal.classList.add('hidden');
            options.classList.add('hidden');
            if (confirm) confirm.classList.remove('hidden');
            release();

            options.removeEventListener('click', onPick);
            cancel?.removeEventListener('click', onCancel);
            close?.removeEventListener('click', onCancel);
            backdrop?.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey, true);

            if (returnFocusTo && returnFocusTo.focus && document.contains(returnFocusTo)) returnFocusTo.focus();

            resolve(answer);
        };

        const onPick = (event) => {
            const button = event.target.closest('[data-value]');
            if (button) finish(button.dataset.value);
        };
        const onCancel = () => finish(null);
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            finish(null);
        };

        options.addEventListener('click', onPick);
        cancel?.addEventListener('click', onCancel);
        close?.addEventListener('click', onCancel);
        backdrop?.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey, true);

        const first = options.querySelector('[data-value]');
        if (first) first.focus();
    });
}

/** Put the account menu away, so a dialog does not open behind it. */
function closeUserMenu() {
    const menu = document.getElementById('userMenu');
    if (menu) menu.classList.remove('open');

    const button = document.getElementById('userMenuBtn');
    if (button) button.setAttribute('aria-expanded', 'false');
}

// ============================================
// Managing the music on this machine
//
// One place to see what Spotifie has found here, where it looked, and what it
// makes of it: search and sort, select several songs and do one thing to all
// of them, forget a folder, look for changes, or search again from scratch.
//
// Two rules run through the whole of it.
//
// Nothing here deletes a file. Forgetting a folder stops Spotifie looking at
// it; every file stays exactly where it is. There is deliberately no control
// anywhere in Spotifie that removes somebody's music from their own disk - a
// library manager is not a file manager, and a mistake in one should not cost
// anything in the other.
//
// And nothing here quietly changes what somebody arranged. A song that has
// gone leaves Local Music, because Local Music is what is on the machine. It
// does not leave their playlist: that is theirs, it says the song is
// unavailable, and it reconnects by itself if the music comes back.
// ============================================

/** What the manager is showing, so a redraw does not lose it. */
const localManager = {
    open: false,
    tracks: [],
    unavailable: [],
    duplicates: null,
    health: null,
    locations: [],
    search: '',
    sort: 'title',
    selecting: false,
    selected: new Set()
};

function initLocalMusicManager() {
    const open = document.getElementById('manageLocalLink');
    const modal = document.getElementById('localManagerModal');
    if (!open || !modal) return;

    open.addEventListener('click', () => {
        closeUserMenu();
        openLocalManager();
    });

    document.getElementById('closeLocalManager')?.addEventListener('click', closeLocalManager);
    modal.querySelector('.modal-backdrop')?.addEventListener('click', closeLocalManager);

    document.addEventListener('keydown', (event) => {
        // A question asked from in here answers Escape itself, and the manager
        // stays where it is: pressing Escape over a confirmation means "not
        // that", never "close everything".
        if (event.key === 'Escape' && localManager.open && !dialogIsAsking()) closeLocalManager();
    });

    // ---- looking through what is here ----

    document.getElementById('localSearch')?.addEventListener('input', (event) => {
        localManager.search = event.target.value.trim().toLowerCase();
        renderLocalTracks();
    });

    document.getElementById('localSort')?.addEventListener('change', (event) => {
        localManager.sort = event.target.value;
        renderLocalTracks();
    });

    // ---- doing something to several at once ----

    document.getElementById('localSelectToggle')?.addEventListener('click', (event) => {
        localManager.selecting = !localManager.selecting;
        localManager.selected.clear();

        event.currentTarget.setAttribute('aria-pressed', localManager.selecting ? 'true' : 'false');
        event.currentTarget.textContent = localManager.selecting ? 'Done' : 'Select';
        document.getElementById('localBulk')?.classList.toggle('hidden', !localManager.selecting);

        renderLocalTracks();
    });

    document.getElementById('localSelectAll')?.addEventListener('click', () => {
        const shown = visibleLocalTracks();
        const all = shown.length > 0 && shown.every((track) => localManager.selected.has(track.id));

        localManager.selected = all ? new Set() : new Set(shown.map((track) => track.id));
        renderLocalTracks();
    });

    document.getElementById('localBulkLike')?.addEventListener('click', () => bulkLike(true));
    document.getElementById('localBulkUnlike')?.addEventListener('click', () => bulkLike(false));
    document.getElementById('localBulkPlaylist')?.addEventListener('click', bulkAddToPlaylist);
    document.getElementById('localBulkAlbum')?.addEventListener('click', bulkAddToAlbum);

    // ---- the library itself ----

    document.getElementById('localReconcileBtn')?.addEventListener('click', () => runLocalScan({ mode: 'check' }));
    document.getElementById('localRescanBtn')?.addEventListener('click', () => runLocalScan({ mode: 'full' }));
    document.getElementById('localCancelScanBtn')?.addEventListener('click', cancelLocalScan);

    // One listener for every row and every folder: the lists are redrawn
    // constantly and binding per row would have to be remembered each time.
    document.getElementById('localTracks')?.addEventListener('click', onLocalTrackClick);
    document.getElementById('localLocations')?.addEventListener('click', onLocalLocationClick);
}

async function openLocalManager() {
    const modal = document.getElementById('localManagerModal');
    if (!modal) return;

    localManager.open = true;
    modal.classList.remove('hidden');

    await refreshLocalManager();
}

function closeLocalManager() {
    const modal = document.getElementById('localManagerModal');
    if (!modal) return;

    localManager.open = false;
    localManager.selecting = false;
    localManager.selected.clear();

    modal.classList.add('hidden');
    document.getElementById('localBulk')?.classList.add('hidden');

    const toggle = document.getElementById('localSelectToggle');
    if (toggle) {
        toggle.setAttribute('aria-pressed', 'false');
        toggle.textContent = 'Select';
    }
}

/**
 * Read everything the manager shows, in one pass.
 *
 * The songs come from the library the page already has - no second request for
 * something it is holding - and only the three things it does not know are
 * fetched: how the library is doing, where it is looking, and which songs look
 * like copies.
 */
async function refreshLocalManager() {
    const client = getCatalogClient();
    if (!client) return;

    // The first time this is opened there is nothing in it: the counts and the
    // folders both come from the server. Their places are held while that
    // happens. Every later refresh - after a scan, after forgetting a folder -
    // already has real content on screen, and it stays there until the new
    // content replaces it.
    if (!localManager.health) {
        showSkeletonIn(document.getElementById('localHealth'), 4, skeletonTile);
        showSkeletonIn(document.getElementById('localLocations'), 3, skeletonLocationRow);
        showSkeletonIn(document.getElementById('localTracks'), 6, skeletonLocalTrackRow);
    }

    localManager.tracks = Object.keys(window.libraryTracks || {})
        .map((id) => window.libraryTracks[id])
        .filter((track) => track && track.source === 'local');

    localManager.unavailable = unavailableCollectionTracks();

    const [health, duplicates] = await Promise.all([
        client._request('/api/library/health').catch(() => null),
        client._request('/api/library/duplicates').catch(() => null)
    ]);

    localManager.health = health;
    localManager.locations = (health && health.device && health.device.locations) || [];
    localManager.duplicates = duplicates;

    // Each of these draws what it has, which may be an empty state or a line
    // saying the machine could not be read. Either way something real replaces
    // the placeholder: a request that fails must never leave one waiting.
    renderLocalHealth();
    renderLocalLocations();
    renderLocalTracks();
    renderLocalUnavailable();
    renderLocalDuplicates();

    ['localHealth', 'localLocations', 'localTracks'].forEach((id) =>
        clearSkeleton(document.getElementById(id))
    );
}

/**
 * Songs named by a playlist or by liked songs that this machine cannot see.
 *
 * They are listed apart from the library rather than mixed into it: the
 * library is what is here, and these are what somebody arranged that is not.
 */
function unavailableCollectionTracks() {
    const personal = getPersonal();
    if (!personal || !personal.signedIn) return [];

    const seen = new Map();

    const consider = (entry) => {
        if (!entry || !entry.missing || !entry.id) return;
        if (!String(entry.id).startsWith('local:')) return;
        if (!seen.has(entry.id)) seen.set(entry.id, entry);
    };

    personal.getLiked().forEach(consider);
    personal.getPlaylists().forEach((playlist) => (playlist.tracks || []).forEach(consider));

    return Array.from(seen.values());
}

function renderLocalHealth() {
    const target = document.getElementById('localHealth');
    if (!target) return;

    const health = localManager.health;
    if (!health) {
        // The machine could not be read. Said, rather than left blank and
        // rather than left waiting: a placeholder that never resolves is worse
        // than a sentence admitting the answer did not arrive.
        const problem = document.createElement('p');
        problem.className = 'local-note';
        problem.textContent = 'Could not read this device just now. Check for changes to try again.';

        target.replaceChildren(problem);
        return;
    }

    const tiles = [
        { value: health.device.trackCount, label: 'songs on this device' },
        { value: localManager.unavailable.length, label: 'not on this device' },
        { value: health.device.locationCount, label: 'folders searched' },
        { value: describeWhen(health.lastReconciledAt || health.lastScanAt), label: 'last checked' }
    ];

    target.replaceChildren(
        ...tiles.map((tile) => {
            const item = document.createElement('div');
            item.className = 'local-health-item';

            const value = document.createElement('div');
            value.className = 'local-health-value';
            value.textContent = String(tile.value);

            const label = document.createElement('div');
            label.className = 'local-health-label';
            label.textContent = tile.label;

            item.append(value, label);
            return item;
        })
    );
}

/** A time somebody can read, or a dash when there has not been one. */
function describeWhen(value) {
    if (!value) return '—';

    const at = Date.parse(value);
    if (!Number.isFinite(at)) return '—';

    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + 'm ago';
    if (minutes < 60 * 24) return Math.round(minutes / 60) + 'h ago';
    return Math.round(minutes / (60 * 24)) + 'd ago';
}

function renderLocalLocations() {
    const list = document.getElementById('localLocations');
    if (!list) return;

    if (!localManager.locations.length) {
        list.replaceChildren(emptyRow('Spotifie is not looking anywhere yet.'));
        return;
    }

    list.replaceChildren(
        ...localManager.locations.map((location) => {
            const row = document.createElement('li');

            const spacer = document.createElement('span');

            const main = document.createElement('div');
            main.className = 'local-track-main';

            const label = document.createElement('div');
            label.className = 'local-location-label';
            // The name of the folder, never the path to it.
            label.textContent = location.label;

            const meta = document.createElement('div');
            meta.className = 'local-location-meta';
            meta.textContent =
                location.trackCount + (location.trackCount === 1 ? ' song' : ' songs') +
                ' · looked at ' + describeWhen(location.lastScanAt);

            main.append(label, meta);

            const forget = document.createElement('button');
            forget.type = 'button';
            forget.className = 'secondary-btn';
            forget.dataset.forget = location.id;
            forget.textContent = 'Forget';

            row.append(spacer, main, forget);
            return row;
        })
    );
}

/** The songs to show: what the search matches, in the order asked for. */
function visibleLocalTracks() {
    const term = localManager.search;

    const matches = localManager.tracks.filter((track) => {
        if (!term) return true;

        const fileName = (track.metadata && track.metadata.fileName) || '';
        return (
            String(track.title || '').toLowerCase().includes(term) ||
            String(track.artist || '').toLowerCase().includes(term) ||
            String(track.album || '').toLowerCase().includes(term) ||
            String(fileName).toLowerCase().includes(term)
        );
    });

    const by = localManager.sort;
    matches.sort((a, b) => {
        if (by === 'duration') return (b.duration || 0) - (a.duration || 0);
        if (by === 'added') {
            const left = Date.parse((a.metadata && a.metadata.addedAt) || 0) || 0;
            const right = Date.parse((b.metadata && b.metadata.addedAt) || 0) || 0;
            return right - left;
        }
        if (by === 'artist') return String(a.artist || '').localeCompare(String(b.artist || ''));
        if (by === 'fileName') {
            return String((a.metadata && a.metadata.fileName) || '').localeCompare(
                String((b.metadata && b.metadata.fileName) || '')
            );
        }
        return String(a.title || '').localeCompare(String(b.title || ''));
    });

    return matches;
}

function renderLocalTracks() {
    const list = document.getElementById('localTracks');
    if (!list) return;

    const shown = visibleLocalTracks();

    const count = document.getElementById('localSelectionCount');
    if (count) count.textContent = localManager.selected.size + ' selected';

    if (!shown.length) {
        list.replaceChildren(emptyRow(localManager.search ? 'Nothing matches that.' : 'No songs on this device yet.'));
        return;
    }

    // Drawn in one go rather than appended row by row: a few thousand songs
    // should not be a few thousand reflows.
    const rows = document.createDocumentFragment();
    for (const track of shown) rows.appendChild(localTrackRow(track));

    list.replaceChildren(rows);
}

function localTrackRow(track, options) {
    const settings = options || {};

    const row = document.createElement('li');
    row.className = 'local-track';
    row.dataset.track = track.id;
    if (settings.unavailable) row.classList.add('is-unavailable');

    // Selecting, when selecting is on.
    if (localManager.selecting && !settings.unavailable) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'local-track-select';
        box.checked = localManager.selected.has(track.id);
        box.setAttribute('aria-label', 'Select ' + (track.title || 'this song'));
        row.appendChild(box);
    } else {
        row.appendChild(document.createElement('span'));
    }

    const main = document.createElement('div');
    main.className = 'local-track-main';

    const title = document.createElement('div');
    title.className = 'local-track-title';
    // Set as text: a song is called whatever its tags say, and that is never
    // markup here however it was written.
    title.textContent = track.title || (track.metadata && track.metadata.fileName) || 'Unknown';

    const meta = document.createElement('div');
    meta.className = 'local-track-meta';
    meta.textContent = settings.unavailable
        ? 'Not on this device'
        : [track.artist, track.metadata && track.metadata.fileName].filter(Boolean).join(' · ');

    main.append(title, meta);

    const right = document.createElement('span');
    right.className = 'local-track-duration';
    right.textContent = settings.unavailable ? '' : formatDuration(track.duration);

    row.append(main, right);
    return row;
}

function renderLocalUnavailable() {
    const section = document.getElementById('localUnavailableSection');
    const list = document.getElementById('localUnavailable');
    if (!section || !list) return;

    section.classList.toggle('hidden', localManager.unavailable.length === 0);
    if (!localManager.unavailable.length) return;

    const rows = document.createDocumentFragment();
    for (const track of localManager.unavailable) {
        rows.appendChild(localTrackRow(track, { unavailable: true }));
    }
    list.replaceChildren(rows);
}

function renderLocalDuplicates() {
    const section = document.getElementById('localDuplicatesSection');
    const list = document.getElementById('localDuplicates');
    if (!section || !list) return;

    const found = localManager.duplicates;
    const groups = found ? found.identical.concat(found.probable) : [];

    section.classList.toggle('hidden', groups.length === 0);
    if (!groups.length) return;

    list.replaceChildren(
        ...groups.map((group) => {
            const row = document.createElement('li');
            row.append(document.createElement('span'));

            const main = document.createElement('div');
            main.className = 'local-track-main';

            const title = document.createElement('div');
            title.className = 'local-track-title';
            title.textContent = group.title || 'Unknown';

            const meta = document.createElement('div');
            meta.className = 'local-track-meta';
            meta.textContent =
                group.kind === 'identical'
                    ? group.copies + ' copies of the same file'
                    : (group.tracks ? group.tracks.length : 2) + ' songs that look alike';

            main.append(title, meta);
            row.append(main, document.createElement('span'));
            return row;
        })
    );
}

function emptyRow(message) {
    const row = document.createElement('li');
    row.className = 'local-empty';
    row.textContent = message;
    return row;
}

// ============================================
// What the rows and folders do
// ============================================

function onLocalTrackClick(event) {
    const row = event.target.closest('.local-track');
    if (!row || row.classList.contains('is-unavailable')) return;

    const trackId = row.dataset.track;
    if (!trackId) return;

    if (localManager.selecting) {
        if (localManager.selected.has(trackId)) localManager.selected.delete(trackId);
        else localManager.selected.add(trackId);

        renderLocalTracks();
        return;
    }

    // Not selecting: play it, from Local Music.
    closeLocalManager();
    playmusic(trackId, null, false, libraryFolderForAlbum('system:local-music'));
}

async function onLocalLocationClick(event) {
    const button = event.target.closest('[data-forget]');
    if (!button) return;

    const location = localManager.locations.find((entry) => entry.id === button.dataset.forget);
    if (!location) return;

    // Said plainly, and said before anything happens: how much this takes out
    // of the library, and the thing somebody will want to be sure of.
    const count = location.trackCount || 0;
    const songs = count === 1 ? '1 song' : count + ' songs';

    const agreed = await confirmAction({
        title: 'Stop looking in ' + location.label + '?',
        message:
            (count ? songs + ' from this folder leave Local Music. ' : 'Nothing here is in Local Music at the moment. ') +
            'No file on your device is deleted, and anything you put in a playlist stays there. ' +
            'Rescan Local Music to look here again.',
        confirmLabel: 'Stop looking'
    });
    if (!agreed) return;

    const client = getCatalogClient();
    if (!client) return;

    button.disabled = true;
    button.textContent = 'Working…';

    try {
        await client._request('/api/library/locations/' + encodeURIComponent(location.id), { method: 'DELETE' });
        showToast('Spotifie will not look in ' + location.label + ' any more');

        await refreshAfterDeviceChange();
        await refreshLocalManager();
    } catch (error) {
        button.disabled = false;
        button.textContent = 'Forget';
        showToast('Could not change that folder');
    }
}

// ============================================
// Doing one thing to several songs
// ============================================

function selectedLocalTracks() {
    return Array.from(localManager.selected);
}

async function bulkLike(liked) {
    const personal = getPersonal();
    if (!requireAccount('Sign in to like songs')) return;
    if (!personal) return;

    const chosen = selectedLocalTracks();
    if (!chosen.length) {
        showToast('Choose some songs first');
        return;
    }

    let changed = 0;
    for (const trackId of chosen) {
        if (personal.isLiked(trackId) === liked) continue;

        try {
            await personal.toggleLike(trackId);
            changed += 1;
        } catch (e) {
            // One song refusing does not stop the rest.
        }
    }

    showToast(changed + (liked ? ' added to' : ' removed from') + ' Liked Songs');
    renderLocalTracks();
}

async function bulkAddToPlaylist() {
    if (!requireAccount('Sign in to make playlists')) return;

    const chosen = selectedLocalTracks();
    if (!chosen.length) {
        showToast('Choose some songs first');
        return;
    }

    const personal = getPersonal();
    const playlists = personal ? personal.getPlaylists() : [];
    if (!playlists.length) {
        showToast('Make a playlist first');
        return;
    }

    const playlist = await chooseFromList({
        title: 'Add ' + chosen.length + (chosen.length === 1 ? ' song to' : ' songs to'),
        options: playlists.map((entry) => ({ value: entry.id, label: entry.title }))
    });
    if (!playlist) return;

    let added = 0;
    for (const trackId of chosen) {
        try {
            await personal.addTrack(playlist, trackId);
            added += 1;
        } catch (e) {
            /* the rest still go in */
        }
    }

    showToast(added + (added === 1 ? ' song added' : ' songs added'));
    await refreshPersonalViews();
}

async function bulkAddToAlbum() {
    if (!requireAccount('Sign in to make albums')) return;

    const chosen = selectedLocalTracks();
    if (!chosen.length) {
        showToast('Choose some songs first');
        return;
    }

    const albums = Object.keys(albumInfo).filter((folder) => albumInfo[folder] && albumInfo[folder].isUserAlbum);
    if (!albums.length) {
        showToast('Make an album first');
        return;
    }

    const folder = await chooseFromList({
        title: 'Add ' + chosen.length + (chosen.length === 1 ? ' song to' : ' songs to'),
        options: albums.map((entry) => ({ value: entry, label: albumInfo[entry].title }))
    });
    if (!folder) return;

    // An album holds each song once, whatever is chosen: a playlist is an
    // arrangement and may repeat a song, an album is a membership and may not.
    const current = new Set(predefinedSongs[folder] || []);
    let added = 0;

    for (const trackId of chosen) {
        if (current.has(trackId)) continue;
        current.add(trackId);
        added += 1;
    }

    predefinedSongs[folder] = Array.from(current);
    if (userAlbums[folder]) userAlbums[folder].files = predefinedSongs[folder];
    saveUserAlbums();

    showToast(added ? added + (added === 1 ? ' song added' : ' songs added') : 'Already in that album');

    await refreshAlbumCards();
    if (currentFolder === folder) await getsongs(folder);
}

// ============================================
// Searching this machine, from here
// ============================================

async function runLocalScan(options) {
    const settings = options || {};
    const state = document.getElementById('localScanState');

    if (state) {
        state.classList.remove('hidden');
        state.textContent = settings.mode === 'full' ? 'Searching this device…' : 'Checking for changes…';
    }

    document.getElementById('localCancelScanBtn')?.classList.remove('hidden');

    try {
        // A full search reads everything again. Anything else is the ordinary
        // cheap check: what is already known, confirmed against the disk.
        await startDeviceScan(settings.mode === 'full' ? { mode: 'full' } : { silent: true });
        await refreshAfterDeviceChange();
        await refreshLocalManager();

        if (state) state.textContent = 'Up to date.';
    } catch (error) {
        if (state) state.textContent = 'Could not search this device.';
    } finally {
        document.getElementById('localCancelScanBtn')?.classList.add('hidden');
    }
}

async function cancelLocalScan() {
    const client = getCatalogClient();
    if (!client || typeof client.cancelDeviceScan !== 'function') return;

    try {
        await client.cancelDeviceScan();
        const state = document.getElementById('localScanState');
        if (state) state.textContent = 'Stopped.';
    } catch (e) {
        /* a search that has already finished cannot be stopped */
    } finally {
        document.getElementById('localCancelScanBtn')?.classList.add('hidden');
    }
}

function initBackupRestore() {
    const backupBtn = document.getElementById('backupBtn');
    const backupModal = document.getElementById('backupModal');
    const closeBackupModal = document.getElementById('closeBackupModal');
    const exportBackupBtn = document.getElementById('exportBackupBtn');
    const importBackupBtn = document.getElementById('importBackupBtn');
    const importArea = document.getElementById('importArea');
    const importFileInput = document.getElementById('importFileInput');
    const importFileInfo = document.getElementById('importFileInfo');
    const importFileName = document.getElementById('importFileName');
    const removeImportFile = document.getElementById('removeImportFile');
    const clearAllDataBtn = document.getElementById('clearAllDataBtn');
    
    if (!backupBtn || !backupModal) return;
    
    // Open modal
    backupBtn.addEventListener('click', async () => {
        await updateBackupStats();
        backupModal.classList.remove('hidden');
    });
    
    // Close modal
    closeBackupModal?.addEventListener('click', () => {
        backupModal.classList.add('hidden');
        resetImportState();
    });
    
    backupModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
        backupModal.classList.add('hidden');
        resetImportState();
    });
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !backupModal.classList.contains('hidden')) {
            backupModal.classList.add('hidden');
            resetImportState();
        }
    });
    
    // Export backup
    exportBackupBtn?.addEventListener('click', async () => {
        if (!requireAccount('Sign in to export your library')) return;
        try {
            exportBackupBtn.disabled = true;
            exportBackupBtn.textContent = 'Exporting...';
            
            // A backup is references and nothing else: canonical track ids,
            // the name of a playlist, the id of a cover this machine holds.
            // No audio, no pictures, no addresses that expire, nothing about
            // an account beyond what that account arranged.
            const exportData = await requestLibraryBackup();

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `spotifie-backup-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            showToast('Backup exported successfully!');
        } catch (error) {
            console.error('Export failed:', error);
            showToast('Export failed. Please try again.');
        } finally {
            exportBackupBtn.disabled = false;
            exportBackupBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 3V16M12 16L16 12M12 16L8 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M3 15V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Export Backup
            `;
        }
    });
    
    // Import file selection
    importArea?.addEventListener('click', () => {
        importFileInput?.click();
    });
    
    // Drag and drop for import
    importArea?.addEventListener('dragover', (e) => {
        e.preventDefault();
        importArea.classList.add('dragover');
    });
    
    importArea?.addEventListener('dragleave', () => {
        importArea.classList.remove('dragover');
    });
    
    importArea?.addEventListener('drop', (e) => {
        e.preventDefault();
        importArea.classList.remove('dragover');
        const file = e.dataTransfer?.files[0];
        if (file) {
            handleImportFile(file);
        }
    });
    
    importFileInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) {
            handleImportFile(file);
        }
    });
    
    // Remove selected file
    removeImportFile?.addEventListener('click', () => {
        resetImportState();
    });
    
    // Import backup
    importBackupBtn?.addEventListener('click', async () => {
        if (!requireAccount('Sign in to restore a library backup')) return;
        if (!pendingImportData) {
            showToast('Please select a backup file first');
            return;
        }
        
        try {
            importBackupBtn.disabled = true;
            importBackupBtn.textContent = 'Importing...';

            // Checked and merged on the server, in one atomic write. What
            // comes back is a summary and the albums this page keeps for
            // itself.
            const result = await restoreLibraryBackup(pendingImportData);

            restoreLocalAlbums(result.localAlbums);
            showImportSummary(result.summary);

            const personal = getPersonal();
            if (personal) await personal.load({ force: true });

            loadUserAlbums();
            await updateBackupStats();
            await refreshPersonalViews();
            if (currentFolder && predefinedSongs[currentFolder]) {
                await getsongs(currentFolder);
            }
            
            resetImportState();
        } catch (error) {
            console.error('Import failed:', error);
            showToast('Import failed: ' + error.message);
        } finally {
            importBackupBtn.disabled = false;
            importBackupBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 16V3M12 3L8 7M12 3L16 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M3 15V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Import Backup
            `;
        }
    });
    
    // Clear all data
    clearAllDataBtn?.addEventListener('click', async () => {
        const confirmed = confirm('Are you sure you want to delete ALL your library data? This cannot be undone!');
        if (!confirmed) return;
        
        const doubleConfirm = confirm('This will delete all liked songs, device songs, playlists, and user-created albums. Are you absolutely sure?');
        if (!doubleConfirm) return;
        
        try {
            await LibraryDB.clearAll(true); // Also clear localStorage data
            
            // Reset user albums in memory
            userAlbums = {};
            
            showToast('All library data has been cleared');
            
            // Reload albums from scratch (will only show predefined albums now)
            loadUserAlbums();
            
            // Refresh the view
            await updateBackupStats();
            await refreshAlbumCards();
            
            // Clear current folder view
            const songslist = document.querySelector('.songslist ul');
            if (songslist) songslist.innerHTML = '';
            
        } catch (error) {
            console.error('Clear failed:', error);
            showToast('Failed to clear data');
        }
    });
}

async function handleImportFile(file) {
    const importFileInfo = document.getElementById('importFileInfo');
    const importFileName = document.getElementById('importFileName');
    const importArea = document.getElementById('importArea');
    const importBackupBtn = document.getElementById('importBackupBtn');
    
    if (!file.name.endsWith('.json') && !file.name.endsWith('.spotifiebackup')) {
        showToast('Please select a valid backup file (.json or .spotifiebackup)');
        return;
    }

    // A real backup is kilobytes. Reading a file far larger than any library
    // produces would only mean waiting to find out it is not one.
    if (file.size > MAX_BACKUP_BYTES) {
        showToast('That file is too large to be a Spotifie backup.');
        resetImportState();
        return;
    }

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Only enough checking here to say whether it is worth sending. The
        // server decides what a backup may contain; this decides whether to
        // show the button.
        if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) {
            throw new Error('That file is not a Spotifie backup.');
        }

        pendingImportData = data;

        if (importFileName) importFileName.textContent = file.name;
        importFileInfo?.classList.remove('hidden');
        importArea?.classList.add('hidden');
        if (importBackupBtn) importBackupBtn.disabled = false;

        const library = data.library || {};
        const preview = [];
        if (Array.isArray(library.likedTrackIds) && library.likedTrackIds.length) {
            preview.push(library.likedTrackIds.length + ' liked songs');
        }
        if (Array.isArray(library.playlists) && library.playlists.length) {
            preview.push(library.playlists.length + ' playlists');
        }
        if (Array.isArray(library.localAlbums) && library.localAlbums.length) {
            preview.push(library.localAlbums.length + ' albums');
        }

        showToast(preview.length ? 'Ready to restore: ' + preview.join(', ') : 'Ready to restore');
    } catch (error) {
        console.error('Failed to parse backup file:', error);
        showToast(error.message || 'Invalid backup file. Please select a valid backup.');
        resetImportState();
    }
}

function resetImportState() {
    pendingImportData = null;
    
    const importFileInfo = document.getElementById('importFileInfo');
    const importArea = document.getElementById('importArea');
    const importBackupBtn = document.getElementById('importBackupBtn');
    const importFileInput = document.getElementById('importFileInput');
    
    importFileInfo?.classList.add('hidden');
    importArea?.classList.remove('hidden');
    if (importBackupBtn) importBackupBtn.disabled = true;
    if (importFileInput) importFileInput.value = '';
}

async function updateBackupStats() {
    try {
        const stats = await LibraryDB.getLibraryStats();
        
        const statLikedSongs = document.getElementById('statLikedSongs');
        const statUserSongs = document.getElementById('statUserSongs');
        const statUserAlbums = document.getElementById('statUserAlbums');
        const statPlaylists = document.getElementById('statPlaylists');
        
        if (statLikedSongs) statLikedSongs.textContent = stats.likedsongs || 0;
        if (statUserSongs) statUserSongs.textContent = stats.usersongs || 0;
        if (statUserAlbums) statUserAlbums.textContent = stats.userAlbums || 0;
        if (statPlaylists) statPlaylists.textContent = stats.userplaylists || 0;
    } catch (error) {
        console.error('Failed to get library stats:', error);
    }
}

// ==================== The transport ====================
// One set of actions behind every control, wherever it is drawn: the playbar,
// the Now Playing view, the album detail and the keyboard all call these. The
// audio element is still the only thing that says what is happening; these
// only ask it for something.

/** What the playbar shows about the track it is on. */
function renderPlaybarTrack(trackId, track) {
    const title = document.querySelector('.songinfo');
    if (title) title.textContent = track ? track.title : '';

    const artist = document.getElementById('playbarArtist');
    if (artist) {
        const name = track && track.artist && track.artist !== 'Unknown Artist' ? track.artist : '';
        artist.textContent = name;
    }

    const artwork = document.getElementById('playbarArtwork');
    if (artwork) {
        artwork.alt = '';
        paintTrackArtwork(artwork, trackId, window.currentPlayingAlbum);
    }
}

/**
 * Draw the progress, everywhere it is shown.
 *
 * This runs several times a second, so it touches text and two widths and
 * nothing else: no list is rebuilt and no album is re-rendered here.
 */
function updateProgressUI() {
    const duration = Number.isFinite(currentsong.duration) && currentsong.duration > 0 ? currentsong.duration : 0;
    const position = Number(currentsong.currentTime) || 0;
    const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;

    const currentText = secondsToMinutesSeconds(position);
    // The elapsed time is always a real number; the length is not known until
    // the browser has read the file.
    const durationText = formatDuration(duration);

    ['playbarCurrentTime', 'nowPlayingCurrentTime'].forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.textContent = currentText;
    });

    ['playbarDuration', 'nowPlayingDuration'].forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.textContent = durationText;
    });

    // The same thing in words, for anyone listening to the page.
    const spoken = document.querySelector('.songtime');
    if (spoken) spoken.textContent = currentText + '/' + durationText;

    document.querySelectorAll('.seekbar').forEach((bar) => {
        // A bar being dragged shows where the finger is, not where the audio is.
        if (bar.classList.contains('is-scrubbing')) return;
        drawSeekbar(bar, percent, currentText, durationText);
    });

    const mini = document.querySelector('.playbar-mini-fill');
    if (mini) mini.style.width = percent + '%';
}

/** One seek bar, at one position. */
function drawSeekbar(bar, percent, currentText, durationText) {
    const fill = bar.querySelector('.seekbar-fill');
    if (fill) fill.style.width = percent + '%';

    const handle = bar.querySelector('.circle');
    if (handle) handle.style.left = percent + '%';

    bar.setAttribute('aria-valuenow', String(Math.round(percent)));
    if (currentText) bar.setAttribute('aria-valuetext', currentText + ' of ' + durationText);
}

/** Move the playhead to a fraction of the track. */
function seekToFraction(fraction) {
    if (!Number.isFinite(currentsong.duration) || currentsong.duration <= 0) return;

    const clamped = Math.max(0, Math.min(1, fraction));
    try {
        currentsong.currentTime = clamped * currentsong.duration;
    } catch (e) {
        /* a source that cannot be sought is left where it is */
    }
    updateProgressUI();
}

function seekBy(seconds) {
    if (!Number.isFinite(currentsong.duration) || currentsong.duration <= 0) return;
    const target = Math.max(0, Math.min(currentsong.duration, (currentsong.currentTime || 0) + seconds));
    try {
        currentsong.currentTime = target;
    } catch (e) {
        /* best effort */
    }
    updateProgressUI();
}

/**
 * Every seek bar answers a click, a drag and the keyboard.
 *
 * Dragging never touches play or pause: seeking is moving the playhead, and a
 * track that was playing carries on playing.
 */
function initSeekbars() {
    document.querySelectorAll('.seekbar').forEach((bar) => {
        const fractionAt = (clientX) => {
            const box = bar.getBoundingClientRect();
            if (!box.width) return 0;
            return Math.max(0, Math.min(1, (clientX - box.left) / box.width));
        };

        const preview = (fraction) => {
            const duration = Number.isFinite(currentsong.duration) ? currentsong.duration : 0;
            drawSeekbar(
                bar,
                fraction * 100,
                secondsToMinutesSeconds(fraction * duration),
                secondsToMinutesSeconds(duration)
            );
        };

        bar.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            bar.classList.add('is-scrubbing');
            if (bar.setPointerCapture) {
                try {
                    bar.setPointerCapture(event.pointerId);
                } catch (e) {
                    /* a pointer that cannot be captured still works by move events */
                }
            }
            preview(fractionAt(event.clientX));
        });

        bar.addEventListener('pointermove', (event) => {
            if (!bar.classList.contains('is-scrubbing')) return;
            preview(fractionAt(event.clientX));
        });

        const finish = (event) => {
            if (!bar.classList.contains('is-scrubbing')) return;
            bar.classList.remove('is-scrubbing');
            seekToFraction(fractionAt(event.clientX));
            rememberProgress({ force: true });
        };

        bar.addEventListener('pointerup', finish);
        bar.addEventListener('pointercancel', () => bar.classList.remove('is-scrubbing'));

        bar.addEventListener('keydown', (event) => {
            const step = event.key === 'PageUp' || event.key === 'PageDown' ? 10 : 5;
            let handled = true;

            if (event.key === 'ArrowRight' || event.key === 'PageUp') seekBy(step);
            else if (event.key === 'ArrowLeft' || event.key === 'PageDown') seekBy(-step);
            else if (event.key === 'Home') seekToFraction(0);
            else if (event.key === 'End') seekToFraction(0.99);
            else handled = false;

            if (!handled) return;
            event.preventDefault();
            // The page's own arrow keys change track; inside the bar they move
            // the playhead, and only that.
            event.stopPropagation();
            rememberProgress({ force: true });
        });
    });
}

/** Start one track by id, from the album it is listed under. */
function playTrackById(trackId) {
    if (!trackId) return false;

    const meta = (window.currentSongsMeta || []).find((entry) => entry.track === trackId);
    playmusic(trackId, findLibButtonByTrack(trackId), false, (meta && meta.sourceFolder) || currentFolder);
    return true;
}

/**
 * Move to the next track.
 *
 * `ended` says the track finished on its own, which is the only case where
 * repeat-one plays the same track again; pressing Next always moves on.
 */
function playNextTrack(options) {
    const settings = options || {};
    const current = getCurrentEncodedTrack();

    rememberProgress({ force: true });

    const nextId = nextTrackIdInContext(settings);
    if (!nextId) {
        // Nothing follows this track: the audio has stopped and the controls
        // say so.
        syncPlaybackUI();
        return false;
    }

    if (nextId === current) {
        // Repeat-one: the same track, from the beginning.
        try {
            currentsong.currentTime = 0;
        } catch (e) {
            /* best effort */
        }
        startAudioPlayback();
        return true;
    }

    return playTrackById(nextId);
}

/**
 * Move back.
 *
 * A track that is already under way starts again, which is what Previous means
 * once a song has been playing for a few seconds.
 */
function playPreviousTrack() {
    const action = previousAction(currentsong.currentTime);

    if (action.restart || !action.trackId) {
        try {
            currentsong.currentTime = 0;
        } catch (e) {
            /* best effort */
        }
        updateProgressUI();
        if (!isAudioPlaying() && currentsong.src) startAudioPlayback();
        return Boolean(action.restart);
    }

    rememberProgress({ force: true });
    return playTrackById(action.trackId);
}

/** Volume is one number, shown by every slider and icon that has one. */
function setPlayerVolume(value) {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    currentsong.volume = volume;
    if (volume > 0) lastVolume = volume;

    syncVolumeUI();
    savePlayerPreferences();
    return volume;
}

function toggleMute() {
    if (currentsong.volume > 0) {
        lastVolume = currentsong.volume;
        return setPlayerVolume(0);
    }
    return setPlayerVolume(lastVolume || 0.5);
}

/**
 * Whether the slider beside the button is on screen.
 *
 * The stylesheet decides that, at whatever width it decides it - so this asks
 * the page rather than repeating the breakpoint here and having the two drift
 * apart.
 */
function volumeSliderIsBeside() {
    const beside = document.querySelector('.playbar-right .volumeSeekbar');
    if (!beside) return false;
    if (typeof getComputedStyle !== 'function') return true;
    return getComputedStyle(beside).display !== 'none';
}

function volumePopoverElement() {
    return document.getElementById('volumePopover');
}

function volumePopoverIsOpen() {
    const popover = volumePopoverElement();
    return Boolean(popover) && !popover.hidden;
}

function openVolumePopover() {
    const popover = volumePopoverElement();
    if (!popover) return;

    popover.hidden = false;
    if (volumeBtn) volumeBtn.setAttribute('aria-expanded', 'true');

    // The slider is the point of opening it, so that is what gets the keyboard.
    const slider = popover.querySelector('.volumeRange');
    if (slider && slider.focus) slider.focus();
}

function closeVolumePopover(options) {
    const popover = volumePopoverElement();
    if (!popover || popover.hidden) return;

    popover.hidden = true;
    if (volumeBtn) {
        volumeBtn.setAttribute('aria-expanded', 'false');
        if ((options || {}).focusButton && volumeBtn.focus) volumeBtn.focus();
    }
}

/**
 * Wire the slider that opens on demand.
 *
 * Nothing here touches the audio: the slider inside carries the same class as
 * the one beside the button, so the volume binding and the drawing that keep
 * every slider in step already cover it.
 */
function initVolumePopover() {
    const popover = volumePopoverElement();
    if (!popover || !volumeBtn) return;

    volumeBtn.addEventListener('click', (event) => {
        // Where the slider is already beside the button, the button mutes, as
        // it always has.
        if (volumeSliderIsBeside()) return;

        event.stopPropagation();
        if (volumePopoverIsOpen()) closeVolumePopover({ focusButton: true });
        else openVolumePopover();
    });

    // Muting is still one press, from inside the slider that opened.
    const mute = document.getElementById('volumeMute');
    if (mute) mute.addEventListener('click', () => toggleMute());

    document.addEventListener('click', (event) => {
        if (!volumePopoverIsOpen()) return;
        if (event.target.closest('.volume')) return;
        closeVolumePopover();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && volumePopoverIsOpen()) {
            event.preventDefault();
            closeVolumePopover({ focusButton: true });
        }
    });

    // A window that grows until the slider is beside the button again has no
    // use for the one that opened.
    window.addEventListener('resize', () => {
        if (volumeSliderIsBeside()) closeVolumePopover();
    });
}

function syncVolumeUI() {
    const volume = currentsong.volume;
    const muted = volume <= 0;

    document.querySelectorAll('.volumeRange').forEach((slider) => {
        slider.value = String(Math.round(volume * 100));
    });

    [volumeBtn, document.getElementById('npVolume'), document.getElementById('volumeMute')].forEach((button) => {
        if (!button) return;
        setButtonImgSrc(button, basePath + (muted ? 'img/mute.svg' : 'img/volume.svg'));

        // The button in the playbar opens the slider where there is no room
        // for one beside it, so it is named for what it does there.
        const opensSlider = button === volumeBtn && !volumeSliderIsBeside();
        button.setAttribute('aria-label', opensSlider ? 'Volume' : muted ? 'Unmute' : 'Mute');
    });
}

/**
 * Tell the browser what is playing, where it offers to show it.
 *
 * Feature-detected throughout: a browser without Media Session simply does not
 * get told, and everything else works the same.
 */
function updateMediaSessionMetadata() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (typeof window.MediaMetadata !== 'function') return;

    const trackId = window.currentPlayingTrack;
    if (!trackId) {
        navigator.mediaSession.metadata = null;
        return;
    }

    const track = getLibraryTrack(trackId);
    const artwork = trackArtworkSrc(trackId, window.currentPlayingAlbum);

    try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
            title: trackDisplayTitle(trackId),
            artist: trackDisplayArtist(trackId),
            album: (track && track.album) || playbackContextName(window.currentPlayingAlbum),
            artwork: artwork ? [{ src: artwork }] : []
        });
    } catch (e) {
        /* a browser that refuses the metadata still plays the music */
    }
}

function initMediaSession() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const handlers = {
        play: () => startAudioPlayback(),
        pause: () => {
            currentsong.pause();
            rememberProgress({ force: true });
        },
        nexttrack: () => playNextTrack({ ended: false }),
        previoustrack: () => playPreviousTrack(),
        seekto: (details) => {
            if (!details || !Number.isFinite(details.seekTime)) return;
            try {
                currentsong.currentTime = details.seekTime;
            } catch (e) {
                /* best effort */
            }
            updateProgressUI();
        }
    };

    Object.keys(handlers).forEach((action) => {
        try {
            navigator.mediaSession.setActionHandler(action, handlers[action]);
        } catch (e) {
            /* an action this browser does not know is simply not offered */
        }
    });

    ['play', 'playing', 'pause', 'ended', 'emptied'].forEach((type) => {
        currentsong.addEventListener(type, () => {
            try {
                navigator.mediaSession.playbackState = isAudioPlaying() ? 'playing' : 'paused';
            } catch (e) {
                /* best effort */
            }
        });
    });
}

/**
 * A track that will not play.
 *
 * The player stays usable: the row is marked, the listener is told once, and
 * nothing is deleted - a file that is temporarily unreachable is not a file
 * that should disappear from anybody's library.
 */
function handlePlaybackFailure() {
    const trackId = window.currentPlayingTrack;
    if (!trackId) return;

    const track = getLibraryTrack(trackId);
    if (track && track.source === 'global') return;

    controlsForTrack(trackId).forEach((control) => {
        const row = control.closest ? control.closest('li') : null;
        if (row && row.classList) row.classList.add('is-unavailable');
    });

    if (window.playbackFailureFor === trackId) return;
    window.playbackFailureFor = trackId;

    syncPlaybackUI();

    // A song on this device that will not play means the file behind it has
    // gone. Rather than say so and leave it sitting in the library, the index
    // is checked there and then: if it really has gone it leaves Local Music,
    // the page is redrawn without it, and the listener is moved on to
    // something that does play. Nothing is said, because nothing needs saying
    // - the song is not there, and now neither is the row.
    if (track && track.source === 'local') {
        reconcileAfterMissingLocalTrack(trackId);
        return;
    }

    showToast('This song could not be played');
}

/**
 * A local file would not play: find out whether it is gone, and tidy up.
 *
 * The server checks its index against the disk - one stat per known file, no
 * tags, no hashing - and anything that has gone is dropped from it. The
 * library here is then rebuilt from what is actually there, and playback moves
 * on if it can.
 *
 * A playlist or a liked song that named the missing track keeps naming it.
 * The source library says what is on the machine; somebody's own arrangement
 * is theirs, and a file disappearing is not their decision to change it.
 */
async function reconcileAfterMissingLocalTrack(trackId) {
    const wasPlaying = window.currentPlayingTrack === trackId;

    try {
        // The same cheap pass that runs at startup. It also starts a search,
        // which is how a file that merely moved is found again.
        await startDeviceScan({ silent: true });
    } catch (e) {
        /* the row is already marked unavailable */
    }

    await refreshAfterDeviceChange();

    // Still in the library after the check: the file is there and something
    // else was wrong, so say so once rather than silently doing nothing.
    if (getLibraryTrack(trackId)) {
        showToast('This song could not be played');
        return;
    }

    // Gone. Move on to whatever is next, if this was the song playing.
    if (wasPlaying && songs.length) playNextTrack({ ended: true });
}

// ==================== Artwork for a track ====================
// A song shows its own picture if it has one, otherwise its album's, otherwise
// the default. Nothing here ever holds a filesystem path or a picture turned
// into text: the catalogue answers with a URL this server can serve, or with
// nothing at all.

/** The picture to show for one track, in order of what it actually has. */
/**
 * The picture to show for one song: its own, then its album's, then the
 * default. Every place a song is shown asks this, so the playbar, the Now
 * Playing view and the lists all answer alike.
 *
 * A song played from a collection that has no cover of its own - everything
 * found on this device is in one such collection - still shows the cover of
 * the album it belongs to.
 */
function trackArtworkSrc(trackId, folder) {
    const track = getLibraryTrack(trackId);
    if (track && track.artworkUrl) return track.artworkUrl;

    // The album this song belongs to, which is the one whose cover is its own.
    if (track && track.albumId) {
        const own = albumCoverIfAny(albumInfo[libraryFolderForAlbum(track.albumId)]);
        if (own) return own;
    }

    // Then the album it is being listened to from, which may be a collection
    // somebody made and gave a cover.
    const playing = albumCoverIfAny(albumInfo[folder || window.currentPlayingAlbum || currentFolder]);
    if (playing) return playing;

    // A published album's picture needs fetching, so it is not an answer this
    // function can give; paintTrackArtwork() asks for it and swaps it in.
    return defaultCoverSrc();
}

/** What the album a track is being played from is called. */
function playbackContextName(folder) {
    const info = albumInfo[folder];
    if (info && info.title) return info.title;
    const track = getLibraryTrack(window.currentPlayingTrack);
    return track && track.album ? track.album : '';
}

// ==================== Now Playing ====================
// The playbar, given the whole screen. It is a surface over the page, not a
// page of its own: opening and closing it moves nothing about the audio, which
// carries on from exactly where it is.

let nowPlayingOpen = false;

function nowPlayingOverlay() {
    return document.getElementById('nowPlayingOverlay');
}

/** Fill the Now Playing view with the track the player is on. */
function renderNowPlaying() {
    const overlay = nowPlayingOverlay();
    if (!overlay) return;

    const trackId = window.currentPlayingTrack;
    const title = document.getElementById('nowPlayingTitle');
    const artist = document.getElementById('nowPlayingArtist');
    const context = document.getElementById('nowPlayingContext');
    const artwork = document.getElementById('nowPlayingArtwork');

    if (title) title.textContent = trackId ? trackDisplayTitle(trackId) : 'Nothing playing';
    if (artist) artist.textContent = trackId ? trackDisplayArtist(trackId) : '';
    if (context) context.textContent = trackId ? playbackContextName(window.currentPlayingAlbum) : '';

    if (!artwork) return;

    // The large picture belongs to this view while it is open, and to nowhere
    // else. A closed view is given no picture to hold: starting a track fills
    // in the playbar's thumbnail and leaves this one empty until the view is
    // actually opened.
    if (!nowPlayingOpen) {
        artwork.removeAttribute('src');
        artwork.alt = '';
        return;
    }

    artwork.alt = trackId ? trackDisplayTitle(trackId) + ' cover' : '';
    paintTrackArtwork(artwork, trackId, window.currentPlayingAlbum);
}

function openNowPlaying() {
    const overlay = nowPlayingOverlay();
    if (!overlay || nowPlayingOpen) return;

    nowPlayingOpen = true;
    // The same two words the album view uses: the stylesheet's own default is
    // closed, and the document keeps it out of the page until here.
    overlay.hidden = false;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    if (expandBtn) expandBtn.setAttribute('aria-expanded', 'true');

    renderNowPlaying();
    syncPlaybackUI();
    syncSequenceUI();
    updateProgressUI();

    // Back closes the view rather than leaving the page, where the browser
    // gives us somewhere to put that.
    if (typeof history !== 'undefined' && typeof history.pushState === 'function') {
        try {
            history.pushState({ spotifieView: 'nowPlaying' }, '');
        } catch (e) {
            /* a browser that refuses this simply keeps its own history */
        }
    }

    const close = document.getElementById('closeNowPlaying');
    if (close && close.focus) close.focus();
}

function closeNowPlaying(options) {
    const overlay = nowPlayingOverlay();
    if (!overlay || !nowPlayingOpen) return;

    nowPlayingOpen = false;
    overlay.hidden = true;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');

    const artwork = document.getElementById('nowPlayingArtwork');
    if (artwork) {
        artwork.removeAttribute('src');
        artwork.alt = '';
    }
    if (expandBtn) {
        expandBtn.setAttribute('aria-expanded', 'false');
        if (expandBtn.focus) expandBtn.focus();
    }

    const settings = options || {};
    if (!settings.fromHistory && typeof history !== 'undefined' && typeof history.back === 'function') {
        const state = history.state;
        if (state && state.spotifieView === 'nowPlaying') history.back();
    }
}

function initNowPlaying() {
    if (expandBtn) {
        expandBtn.addEventListener('click', () => {
            if (nowPlayingOpen) closeNowPlaying();
            else openNowPlaying();
        });
    }

    const close = document.getElementById('closeNowPlaying');
    if (close) close.addEventListener('click', () => closeNowPlaying());

    const backdrop = document.querySelector('.now-playing-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => closeNowPlaying());

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && nowPlayingOpen) {
            event.preventDefault();
            closeNowPlaying();
        }
    });

    // The controls inside are the same controls: they do what the playbar does.
    const npPlay = document.getElementById('npPlay');
    if (npPlay) npPlay.addEventListener('click', () => togglePlayback());

    const npNext = document.getElementById('npNext');
    if (npNext) npNext.addEventListener('click', () => playNextTrack({ ended: false }));

    const npPrevious = document.getElementById('npPrevious');
    if (npPrevious) npPrevious.addEventListener('click', () => playPreviousTrack());

    const npShuffle = document.getElementById('npShuffle');
    if (npShuffle) npShuffle.addEventListener('click', () => toggleShuffle());

    const npRepeat = document.getElementById('npRepeat');
    if (npRepeat) npRepeat.addEventListener('click', () => cycleRepeatMode());

    const npLike = document.getElementById('nowPlayingLike');
    if (npLike) {
        npLike.addEventListener('click', () => {
            const likeBtn = document.getElementById('likeCurrentSong');
            if (likeBtn) likeBtn.click();
        });
    }

    const npVolume = document.getElementById('npVolume');
    if (npVolume) npVolume.addEventListener('click', () => toggleMute());

    const npVolumeRange = document.getElementById('npVolumeRange');
    if (npVolumeRange) {
        const apply = (event) => setPlayerVolume(Number(event.target.value) / 100);
        npVolumeRange.addEventListener('input', apply);
        npVolumeRange.addEventListener('change', apply);
    }
}

// ==================== Navigation ====================
// Which view the page is showing, and how it got there.
//
// The app has one navigation state at a time - the library, or one album -
// and one list of the states it has been through. The header's two chevrons
// read that list and nothing else: they never reach into the browser's own
// history, so Back can only ever move within Spotifie and can never land on
// the page somebody was on before they opened it.
//
// An entry says what to show, not what to show it with: an album is a folder
// id, and everything about that album is looked up again when it is restored.
// Nothing here touches the player, so moving between views leaves the audio
// exactly where it is.

const NAV_LIBRARY = 'library';
const NAV_ALBUM = 'album';

// The views visited, oldest first, and where in them the page currently is.
const navEntries = [{ type: NAV_LIBRARY }];
let navIndex = 0;

// True while a view is being restored, so restoring one never records itself
// as somewhere new.
let navRestoring = false;

function navCurrentEntry() {
    return navEntries[navIndex] || { type: NAV_LIBRARY };
}

function navSameEntry(first, second) {
    if (!first || !second || first.type !== second.type) return false;
    return first.type !== NAV_ALBUM || first.albumId === second.albumId;
}

function navCanGoBack() {
    return navIndex > 0;
}

function navCanGoForward() {
    return navIndex < navEntries.length - 1;
}

/**
 * Show a view without recording it.
 *
 * This is the only place either view is shown or hidden, so the two can never
 * both be on screen and neither can be left behind by a path that forgot it.
 */
async function navRenderEntry(entry) {
    const section = albumDetailSection();
    const playlist = document.querySelector('.playlist');

    if (entry && entry.type === NAV_ALBUM && entry.albumId) {
        albumDetailFolder = entry.albumId;

        // getsongs() draws the album detail when it is the album showing, and
        // applies this person's own additions and removals on the way.
        await getsongs(entry.albumId);

        if (playlist) playlist.hidden = true;
        if (section) {
            // Two words for the same thing, on purpose: the stylesheet keeps
            // this view closed by default, and the document keeps it out of
            // the page. Opening it takes both, so neither alone can leave a
            // window-sized cover on screen.
            section.hidden = false;
            section.classList.add('is-open');
            section.setAttribute('aria-hidden', 'false');
        }
        hideSearchResults();
        return;
    }

    albumDetailFolder = null;
    if (section) {
        section.hidden = true;
        section.classList.remove('is-open');
        section.setAttribute('aria-hidden', 'true');

        // The hero picture belongs to the open album; a closed view holds none.
        const cover = document.getElementById('albumDetailCover');
        if (cover) {
            cover.removeAttribute('src');
            cover.alt = '';
        }
    }
    if (playlist) playlist.hidden = false;
}

/**
 * Forget every visit to one album.
 *
 * An album that no longer exists is not somewhere Back can land, so its
 * entries go and the ones around them close up. If it was the view on
 * screen, the library takes its place.
 */
async function navForgetAlbum(albumId) {
    if (!albumId) return;

    const showing = navCurrentEntry();
    let removedBefore = 0;

    for (let i = navEntries.length - 1; i >= 0; i -= 1) {
        if (navEntries[i].type !== NAV_ALBUM || navEntries[i].albumId !== albumId) continue;
        navEntries.splice(i, 1);
        if (i <= navIndex) removedBefore += 1;
    }

    if (!navEntries.length) navEntries.push({ type: NAV_LIBRARY });
    navIndex = Math.max(0, Math.min(navIndex - removedBefore, navEntries.length - 1));

    if (showing.type === NAV_ALBUM && showing.albumId === albumId) {
        navRestoring = true;
        try {
            await navRenderEntry(navCurrentEntry());
        } finally {
            navRestoring = false;
        }
    }

    syncNavButtons();
}

/**
 * Go somewhere new.
 *
 * Anything that was ahead is dropped, the way a browser drops the forward
 * branch once you take a different turn.
 */
async function navigateTo(entry) {
    if (navRestoring) return;

    // Asking for the view already showing is not a journey.
    if (navSameEntry(navCurrentEntry(), entry)) {
        await navRenderEntry(entry);
        syncNavButtons();
        return;
    }

    navEntries.length = navIndex + 1;
    navEntries.push(entry);
    navIndex = navEntries.length - 1;

    await navRenderEntry(entry);
    syncNavButtons();
}

/** Step back through the views this app has shown. */
async function navGoBack() {
    if (!navCanGoBack()) return false;

    navIndex -= 1;
    navRestoring = true;
    try {
        await navRenderEntry(navCurrentEntry());
    } finally {
        navRestoring = false;
    }
    syncNavButtons();
    return true;
}

/** And forward again, as far as Back has been pressed. */
async function navGoForward() {
    if (!navCanGoForward()) return false;

    navIndex += 1;
    navRestoring = true;
    try {
        await navRenderEntry(navCurrentEntry());
    } finally {
        navRestoring = false;
    }
    syncNavButtons();
    return true;
}

/**
 * The chevrons say whether there is anywhere to go.
 *
 * A control that cannot do anything is disabled outright rather than left
 * clickable and merely greyed: the page and the pointer agree.
 */
function syncNavButtons() {
    const back = document.getElementById('navBack');
    if (back) back.disabled = !navCanGoBack();

    const forward = document.getElementById('navForward');
    if (forward) forward.disabled = !navCanGoForward();
}

function initNavigation() {
    const back = document.getElementById('navBack');
    if (back) back.addEventListener('click', () => navGoBack());

    const forward = document.getElementById('navForward');
    if (forward) forward.addEventListener('click', () => navGoForward());

    // The page opens on the library, whatever was open last time: a refresh
    // starts a fresh journey rather than restoring one halfway through.
    navEntries.length = 1;
    navEntries[0] = { type: NAV_LIBRARY };
    navIndex = 0;
    syncNavButtons();
}

// ==================== Album detail ====================
// One album, opened from its card: the cover, what it is, and every song in
// it. It swaps places with the library grid rather than navigating anywhere,
// so the player underneath never notices it happened.

let albumDetailFolder = null;

function albumDetailSection() {
    return document.getElementById('albumDetail');
}

/** How long a list of tracks runs, said the way a person would say it. */
function formatTotalDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours > 0) return hours + ' hr ' + minutes + ' min';
    return Math.max(1, minutes) + ' min';
}

/** What kind of collection this is, in the words the person reading it uses. */
function albumDetailKind(info) {
    if (!info) return 'Album';
    if (info.isSystemCollection) return 'On this device';
    if (info.isLikedAlbum) return 'Your songs';
    if (info.isUserAlbum) return 'Your album';
    if (info.source === 'global') return 'Published album';
    return 'Album';
}

/** Draw the header and every row of the album that is open. */
function renderAlbumDetail(folder) {
    const section = albumDetailSection();
    if (!section) return;

    const info = albumInfo[folder] || {};
    const meta = Array.isArray(window.currentSongsMeta) ? window.currentSongsMeta : [];

    const cover = document.getElementById('albumDetailCover');
    if (cover) {
        cover.alt = (info.title || '') + ' cover';
        paintAlbumArtwork(cover, info, folder);
    }

    const kind = document.getElementById('albumDetailKind');
    if (kind) kind.textContent = albumDetailKind(info);

    const title = document.getElementById('albumDetailTitle');
    if (title) title.textContent = info.title || folder.split('/').pop();

    const artist = document.getElementById('albumDetailArtist');
    // The label above already says "On this device" for Local Music, so the
    // line under the title does not repeat it.
    if (artist) artist.textContent = info.isSystemCollection ? '' : albumCardArtist(info);

    const description = document.getElementById('albumDetailDescription');
    if (description) description.textContent = info.description || '';

    const total = meta.reduce((sum, entry) => {
        const track = getLibraryTrack(entry.track);
        const duration = track && Number.isFinite(track.duration) ? track.duration : 0;
        return sum + duration;
    }, 0);

    const facts = document.getElementById('albumDetailFacts');
    if (facts) {
        const parts = [meta.length + (meta.length === 1 ? ' song' : ' songs')];
        const length = formatTotalDuration(total);
        if (length) parts.push(length);
        facts.textContent = parts.join(' · ');
    }

    const play = document.getElementById('albumDetailPlay');
    if (play) play.dataset.folder = folder;

    // Local Music is what this machine happens to hold, not an album anybody
    // made: there is nothing to rename, save or publish about it.
    const owned = !info.isSystemCollection;
    ['albumDetailLike', 'albumDetailOptions'].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.classList.toggle('hidden', !owned);
    });

    const list = document.getElementById('albumDetailTracks');
    if (!list) return;

    if (!meta.length) {
        list.innerHTML = '<li class="album-track-empty">There is nothing in this album yet.</li>';
        return;
    }

    const fragment = document.createDocumentFragment();

    meta.forEach((entry, index) => {
        const track = getLibraryTrack(entry.track);
        const row = document.createElement('li');
        row.className = 'album-track';
        row.dataset.track = entry.track;
        row.dataset.sourceFolder = entry.sourceFolder || folder;
        if (entry.isUserAdded) row.dataset.userAdded = 'true';
        // Which entry this is, so removing one copy of a song from a playlist
        // does not remove the others.
        if (Number.isInteger(entry.position)) row.dataset.position = String(entry.position);
        // Read by the one place that decides whether a song is liked.
        row.dataset.likeTrack = entry.track;
        if (isTrackLiked(entry.track)) row.classList.add('liked');
        if (track && track.missing) row.classList.add('unavailable');

        const duration = formatDuration(track ? track.duration : null);
        // A missing picture is a missing picture, never a missing song: the
        // row is shown either way.
        const artwork = trackArtworkSrc(entry.track, folder);
        const source = track && track.album ? track.album : '';
        // A scanned file name can be far longer than any row: the row shows
        // what fits and carries the whole of it for anyone who asks.
        const title = trackDisplayTitle(entry.track);
        const artist = trackDisplayArtist(entry.track);

        row.innerHTML = `
            <span class="album-track-index">${index + 1}</span>
            <span class="album-track-artwork">
                <img class="album-track-art" src="${escapeHTML(artwork)}" alt="" width="48" height="48" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${basePath}img/music.svg'">
                <button class="album-track-play" type="button" aria-label="Play">
                    <img class="libPlayButton invert pointer" src="${basePath}img/play.svg" alt="Play">
                </button>
            </span>
            <span class="album-track-meta">
                <span class="album-track-title" title="${escapeHTML(title)}">${escapeHTML(title)}</span>
                <span class="album-track-artist" title="${escapeHTML(artist)}">${escapeHTML(artist)}</span>
            </span>
            <span class="album-track-source">${escapeHTML(source)}</span>
            <span class="album-track-duration">${duration}</span>
            <button class="album-track-menu" type="button" aria-label="More options">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <circle cx="12" cy="6" r="1.5" fill="currentColor"/>
                    <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                    <circle cx="12" cy="18" r="1.5" fill="currentColor"/>
                </svg>
            </button>`;

        fragment.appendChild(row);
    });

    list.innerHTML = '';
    list.appendChild(fragment);

    bindAlbumDetailTrackEvents();
    syncPlaybackUI();
}

function bindAlbumDetailTrackEvents() {
    document.querySelectorAll('.album-track').forEach((row) => {
        row.addEventListener('click', (event) => {
            if (event.target.closest('.album-track-menu')) return;

            const trackId = row.dataset.track;
            const sourceFolder = row.dataset.sourceFolder || albumDetailFolder;

            if (getCurrentEncodedTrack() === trackId && window.currentPlayingSourceFolder === sourceFolder) {
                togglePlayback();
                return;
            }

            playmusic(trackId, row.querySelector('.libPlayButton'), false, sourceFolder);
        });

        const menu = row.querySelector('.album-track-menu');
        if (!menu) return;

        menu.addEventListener('click', (event) => {
            event.stopPropagation();
            showContextMenu(event, {
                folder: albumDetailFolder,
                track: row.dataset.track,
                sourceFolder: row.dataset.sourceFolder || albumDetailFolder,
                isUserAdded: row.dataset.userAdded === 'true'
            });
        });
    });
}

/**
 * Open one album.
 *
 * A journey to a view, recorded by the navigation manager, which is what then
 * shows it. The songs come from the same place the sidebar's list does, so the
 * album view and the list beside it always describe the same album with the
 * same personal additions and removals applied.
 */
async function openAlbumDetail(folder) {
    if (!folder || !albumDetailSection()) return;
    await navigateTo({ type: NAV_ALBUM, albumId: folder });
}

/** Back to the library, as a journey of its own. */
async function closeAlbumDetail() {
    await navigateTo({ type: NAV_LIBRARY });
}

/**
 * The album's own Play button.
 *
 * The same album already playing is paused; a paused one resumes; a different
 * album starts at its first song, or at a shuffled one when shuffle is on.
 */
function playAlbumFromDetail(folder) {
    if (!folder) return;

    if (window.currentPlayingAlbum === folder && currentsong.src) {
        togglePlayback();
        return;
    }

    const ids = contextTrackIds();
    if (!ids.length) {
        showToast('There is nothing in this album to play');
        return;
    }

    const trackId = shuffleEnabled ? shuffledFrom(ids, null)[0] : ids[0];
    const meta = (window.currentSongsMeta || []).find((entry) => entry.track === trackId);
    playmusic(trackId, findLibButtonByTrack(trackId), false, (meta && meta.sourceFolder) || folder);
}

function initAlbumDetail() {
    // There is no back control inside the album: the header's chevrons are
    // the only history controls the app has.
    const play = document.getElementById('albumDetailPlay');
    if (play) play.addEventListener('click', () => playAlbumFromDetail(play.dataset.folder || albumDetailFolder));

    const shuffle = document.getElementById('albumDetailShuffle');
    if (shuffle) {
        shuffle.addEventListener('click', () => {
            const on = toggleShuffle();
            // Turning shuffle on from an album that is not playing starts it.
            if (on && albumDetailFolder && window.currentPlayingAlbum !== albumDetailFolder) {
                playAlbumFromDetail(albumDetailFolder);
            }
        });
    }

    const like = document.getElementById('albumDetailLike');
    if (like) {
        like.addEventListener('click', () => {
            if (!requireAccount('Sign in to save albums')) return;
            const folder = albumDetailFolder;
            if (folder) togglePinAlbum(folder);
        });
    }

    const options = document.getElementById('albumDetailOptions');
    if (options) {
        options.addEventListener('click', () => {
            if (!albumDetailFolder) return;
            if (!requireAccount('Sign in to change your albums')) return;
            openEditAlbumModal(albumDetailFolder);
        });
    }

    // The one place the browser's own Back is used is Now Playing, which
    // pushes a single entry of its own when it opens; popping it closes the
    // view and goes no further. Moving between the library and an album is
    // the navigation manager's business, and stays inside the app.
    window.addEventListener('popstate', () => {
        if (nowPlayingOpen) closeNowPlaying({ fromHistory: true });
    });
}

// Starting the application.
//
// The opening screen goes when the library is up - not when the network has
// finished, which may be later or may be never.
main()
    .catch((error) => {
        console.error('Spotifie could not finish starting:', error);
    })
    .finally(() => {
        hideSplash();
    });

// Initialize backup/restore after main
initBackupRestore();

// The music on this machine: what was found, where Spotifie looked, and what
// can be done with it. Wired once, like everything else in the shell.
initLocalMusicManager();

// ==================== User Menu Dropdown ====================
// Session state, admin detection and logout all live in js/auth.js.
// This only wires the dropdown that belongs to the player shell.

function initUserMenu() {
    const userMenuBtn = document.getElementById('userMenuBtn');
    const userMenu = document.getElementById('userMenu');

    if (!userMenuBtn || !userMenu) return;

    userMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        userMenu.classList.toggle('open');
        userMenuBtn.setAttribute('aria-expanded', userMenu.classList.contains('open'));
    });

    document.addEventListener('click', (e) => {
        if (!userMenu.contains(e.target)) {
            userMenu.classList.remove('open');
            userMenuBtn.setAttribute('aria-expanded', 'false');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && userMenu.classList.contains('open')) {
            userMenu.classList.remove('open');
            userMenuBtn.setAttribute('aria-expanded', 'false');
        }
    });
}

// Initialize user menu after DOM loads
document.addEventListener('DOMContentLoaded', () => {
    initUserMenu();
});
