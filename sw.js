/**
 * The app shell, kept so Spotifie opens without the network.
 *
 * What this caches is the application itself: the pages, the stylesheets, the
 * scripts and the handful of icons the interface is drawn from. Perhaps two
 * hundred kilobytes, fetched once. With those in hand the player starts,
 * reads this device's own music index and plays the music on this device -
 * with or without an internet connection.
 *
 * What this deliberately does not cache:
 *
 * - audio, of any kind. Music on this device is read from this device, by the
 *   local media resolver, and putting a second copy of it into browser storage
 *   would double the space it takes to no purpose. Published audio is not
 *   downloaded quietly either: promising a song is available offline when
 *   nobody chose to make it so is a promise that breaks;
 * - anything signed. Storage addresses expire, and a cached expired address is
 *   a picture that loads once and is broken ever after;
 * - anything belonging to a person. Their library is answered by the local
 *   server from their own state file, and a shared cache is the wrong place
 *   for it on a machine other people use.
 *
 * The cache is named with a version. Changing that name is what retires the
 * previous one: the new worker takes over, deletes what it does not recognise,
 * and there is never a half-old shell made of files from two releases.
 */

'use strict';

/** Raise this to retire every previous cache. */
const CACHE_VERSION = 'v2';
const SHELL_CACHE = 'spotifie-shell-' + CACHE_VERSION;

/**
 * What the interface needs before it can draw anything.
 *
 * Named rather than discovered: a list of what to keep is right about the
 * application, where a rule about what to keep has to be right about every
 * request that will ever be made.
 */
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/css/utlity.css',
    '/js/script.js',
    '/js/auth.js',
    '/js/catalogClient.js',
    '/js/catalogCache.js',
    '/js/personalClient.js',
    '/js/libraryClient.js',
    '/js/libraryDB.js',
    // The cover shown when there is no cover. It has to be there precisely
    // when other things are not.
    '/img/music.svg',
    '/img/logo.webp',
    '/img/play.svg',
    '/img/pause.svg',
    '/img/nextsong.svg',
    '/img/prevsong.svg',
    '/img/volume.svg',
    '/img/mute.svg',
    '/img/search.svg',
    '/img/home.svg',
    '/img/hamburger.svg',
    '/img/close.svg',
    '/img/playlist.svg',
    '/favicons/favicon.ico',
    // What a browser reads to install the application. Kept with the shell so
    // an installed copy still knows its own name and icon offline.
    '/manifest.webmanifest'
];

/** Requests that must always go to the server, cache or no cache. */
function isAlwaysLive(url) {
    // Anything personal, anything privileged, and anything that streams.
    if (url.pathname.startsWith('/api/')) return true;
    if (url.pathname.startsWith('/admin')) return true;
    return false;
}

/** Audio, wherever it comes from. Never cached here. */
function isAudio(url, request) {
    if (request.destination === 'audio') return true;
    return /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4)$/i.test(url.pathname);
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(SHELL_CACHE)
            .then((cache) =>
                // One missing file must not fail the whole install: the shell
                // is still worth having without an icon.
                Promise.all(
                    SHELL_ASSETS.map((asset) =>
                        cache.add(asset).catch(() => {
                            /* that one is fetched from the network instead */
                        })
                    )
                )
            )
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names.filter((name) => name.startsWith('spotifie-shell-') && name !== SHELL_CACHE).map((name) => caches.delete(name))
                )
            )
            .then(() => self.clients.claim())
    );
});

/**
 * Answer from the cache and check afterwards.
 *
 * The page opens at once from what is held, and what is held is replaced by
 * whatever the network says a moment later - so the next launch is current
 * without this one having waited. A request the network cannot answer falls
 * back to the cached copy, which is the whole point of keeping one.
 */
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Somebody else's origin is somebody else's business.
    if (url.origin !== self.location.origin) return;

    if (isAlwaysLive(url) || isAudio(url, request)) return;

    event.respondWith(
        caches.open(SHELL_CACHE).then((cache) =>
            cache.match(request).then((cached) => {
                const live = fetch(request)
                    .then((response) => {
                        if (response && response.ok && response.type === 'basic') {
                            cache.put(request, response.clone()).catch(() => {
                                /* a full cache is not a failed request */
                            });
                        }
                        return response;
                    })
                    .catch(() => cached);

                // Held copy first when there is one; otherwise wait for the
                // network, and fall back to the page itself for a navigation
                // so an offline launch still opens Spotifie.
                if (cached) return cached;

                return live.then((response) => {
                    if (response) return response;
                    if (request.mode === 'navigate') return cache.match('/index.html');
                    return Response.error();
                });
            })
        )
    );
});
