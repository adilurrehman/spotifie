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
 *
 * One rule matters more than every optimisation in here: a page must open.
 *
 * A worker answers navigation, and a worker that answers a navigation badly
 * takes the whole site down for the people who have it installed - the browser
 * shows its own failure page, and the application is unreachable until they
 * think to go back. That happened here: a request the network could not answer
 * and the cache did not hold ended as a rejected response, which Chrome
 * reports as ERR_FAILED. So navigation is handled first, separately, and every
 * path through it ends in a real Response.
 */

'use strict';

/** Raise this to retire every previous cache. */
const CACHE_VERSION = 'v5';
const SHELL_CACHE = 'spotifie-shell-' + CACHE_VERSION;

/**
 * The one address the application is at.
 *
 * Every navigation this worker cannot answer from the network is answered with
 * this, and this is what an installed copy launches into. index.html is the
 * same document, and opening it directly still works - but nothing inside the
 * application sends anybody there, so there is one page in the cache and one
 * page in the history rather than two of each.
 */
const APP_SHELL = '/';

/**
 * What the interface needs before it can draw anything.
 *
 * Named rather than discovered: a list of what to keep is right about the
 * application, where a rule about what to keep has to be right about every
 * request that will ever be made.
 */
const SHELL_ASSETS = [
    APP_SHELL,
    '/css/style.css',
    '/css/utlity.css',
    '/js/script.js',
    '/js/auth.js',
    '/js/deployment.js',
    '/js/platform.js',
    '/js/catalogClient.js',
    '/js/catalogCache.js',
    '/js/browserLibrary.js',
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

/**
 * The last answer a navigation can be given.
 *
 * Only reached when the network failed and the shell was never cached - a
 * first visit that lost its connection halfway through. A page saying so is a
 * far better answer than a rejected response, which the browser turns into its
 * own error page and which leaves people pressing Back to get the application
 * to appear again.
 */
function offlinePage() {
    return new Response(
        '<!doctype html><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>Spotifie is offline</title>' +
            '<body style="margin:0;display:grid;place-items:center;min-height:100vh;' +
            'background:#121212;color:#fff;font:16px system-ui,sans-serif;text-align:center">' +
            '<div><h1 style="font-size:1.25rem">Spotifie cannot be reached</h1>' +
            '<p style="opacity:.7">This device is offline and Spotifie has not been saved here yet.</p>' +
            '<p><a href="/" style="color:#1db954">Try again</a></p></div>',
        {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        }
    );
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
            .catch(() => {
                /* no cache is a slower Spotifie, not a broken one */
            })
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((name) => name.startsWith('spotifie-shell-') && name !== SHELL_CACHE)
                        .map((name) => caches.delete(name))
                )
            )
            .catch(() => {
                /* an old cache that will not go is not worth failing over */
            })
            .then(() => self.clients.claim())
    );
});

/**
 * Open the application, whatever state the network is in.
 *
 * The network first, so a deploy is seen on the next visit rather than after a
 * cache decides it has waited long enough - and because a stale document is
 * how an application ends up loading scripts that are no longer there. What
 * comes back is kept, so the visit after this one opens with no network at
 * all.
 *
 * Then, in order: the copy of this exact page, the copy of the application's
 * one address, and a page saying Spotifie is offline. Never a rejected
 * response, and never undefined.
 */
function openApplication(request) {
    return caches.open(SHELL_CACHE).then((cache) =>
        fetch(request)
            .then((response) => {
                if (response && response.ok && response.type === 'basic') {
                    cache.put(request, response.clone()).catch(() => {
                        /* a full cache is not a failed request */
                    });
                }

                // A 404 or a 500 is the site's own answer and belongs to the
                // visitor; only a network that did not answer falls through.
                return response;
            })
            .catch(() =>
                cache
                    .match(request)
                    .then((cached) => cached || cache.match(APP_SHELL))
                    .then((cached) => cached || offlinePage())
                    .catch(() => offlinePage())
            )
    );
}

/**
 * Code, asked for the same way the page was.
 *
 * A page comes from the network and its scripts must come from the same place,
 * or a release can be half old: a new page loading a script from before it, or
 * the other way round. That is not theoretical - it is how a sign-in page came
 * to call something its own script did not have yet, and to sit forever saying
 * it was redirecting.
 *
 * The cached copy is still there for a device with no network, which is what
 * it is for.
 */
function openCode(request) {
    return caches.open(SHELL_CACHE).then((cache) =>
        fetch(request)
            .then((response) => {
                if (response && response.ok && response.type === 'basic') {
                    cache.put(request, response.clone()).catch(() => {
                        /* a full cache is not a failed request */
                    });
                }
                return response;
            })
            .catch(() => cache.match(request).then((cached) => cached || Response.error()))
    );
}

/**
 * Answer from the cache and check afterwards.
 *
 * For everything that is not a page: what is held goes up at once, and what is
 * held is replaced by whatever the network says a moment later - so the next
 * launch is current without this one having waited.
 */
function openAsset(request) {
    return caches.open(SHELL_CACHE).then((cache) =>
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
                .catch(() => null);

            if (cached) return cached;

            return live.then((response) => response || Response.error());
        })
    );
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return;
    }

    // Somebody else's origin is somebody else's business: Supabase, the fonts,
    // the helper on this machine at its own address. None of it is this
    // worker's to answer, and a worker that answered it would be the reason
    // signing in stopped working.
    if (url.origin !== self.location.origin) return;

    // Anything privileged or personal is never this worker's to answer, and
    // that is true of a navigation to it as much as a fetch of it. The
    // protected admin route is decided live by the server on every request -
    // a short-lived entry session it grants and can withhold - so it must
    // reach the network untouched, never a page this worker cached a moment
    // when access happened to be allowed. Left before the navigation branch
    // for exactly that reason.
    if (isAlwaysLive(url)) return;

    // A page. Handled first and on its own, because getting this wrong is the
    // difference between a slow Spotifie and no Spotifie.
    if (request.mode === 'navigate') {
        event.respondWith(openApplication(request));
        return;
    }

    if (isAudio(url, request)) return;

    // Scripts and stylesheets belong to the page that asked for them, so they
    // are fetched the way the page was. Pictures, fonts and the manifest do
    // not change with a release in a way that can break anything, and are
    // still answered from what is held.
    if (request.destination === 'script' || request.destination === 'style') {
        event.respondWith(openCode(request));
        return;
    }

    event.respondWith(openAsset(request));
});
