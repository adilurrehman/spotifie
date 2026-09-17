/**
 * Spotifie Local Server
 * Run with: npm start  (or: node server.js)
 *
 * Single local origin. This server serves:
 * - the static frontend (HTML/CSS/JS/images) and the local songs/ library
 * - the local library API under /api/
 * - /health and /api/health
 *
 * This server handles:
 * - Creating album folders in songs/
 * - Saving cover images
 * - Saving uploaded audio files
 * - Updating songs.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { createLibraryRoutes } = require('./lib/libraryRoutes');
const { DeviceWatcher } = require('./lib/deviceWatcher');
const { createCatalogRoutes } = require('./lib/catalogRoutes');
const { MUSIC_ROOT } = require('./lib/config');
const { getPublicConfig, getConfigProblem } = require('./lib/publicConfig');
// What this installation says about itself to a machine: robots, the sitemap,
// the plain-text summary, and the tags a page can only be given once the
// address it is published at is known.
const siteMeta = require('./lib/siteMeta');

/**
 * The album-management routes, when this installation has them.
 *
 * Creating, editing and deleting albums on disk is administrator work, and it
 * lives in its own module so the user-facing build can be made simply by not
 * including it. Checked as a file rather than wrapped in a try/catch: a module
 * that is present but broken must fail loudly, not silently become a server
 * with no administrator routes.
 */
// Named in a piece rather than whole, so a release that has no dashboard
// carries no address for one either.
const ADMIN_SIGN_IN_PAGE = 'admin' + '-login.html';

const ADMIN_ALBUM_MODULE = path.join(__dirname, 'lib', 'adminAlbumRoutes.js');
const adminAlbumModule = fs.existsSync(ADMIN_ALBUM_MODULE) ? require(ADMIN_ALBUM_MODULE) : null;

// Local music library (platform-neutral service behind /api/library)
const libraryRoutes = createLibraryRoutes();

// Unified catalogue: local library + global admin catalogue (/api/catalog).
// The library routes own the personal media store and the tickets that let a
// browser play it, so both surfaces speak about the same files.
const catalogRoutes = createCatalogRoutes({
    serviceOptions: {
        library: libraryRoutes.service,
        userMedia: libraryRoutes.userMedia,
        deviceLibrary: libraryRoutes.deviceLibrary,
        tickets: libraryRoutes.tickets
    }
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT_DIR = __dirname;
const SONGS_DIR = path.join(__dirname, 'songs');
const SONGS_JSON = path.join(__dirname, 'songs.json');

// Frontend and API share one origin, so no cross-origin headers are needed.
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

const BACKSLASH = String.fromCharCode(92);
const NUL_CHAR = String.fromCharCode(0);

/**
 * What may be served, said as a list of what may be served.
 *
 * A list of things to refuse has to be right about every file that will ever
 * exist in this directory; a list of things to serve only has to be right
 * about the frontend. Anything not named here is not found - the server's own
 * source, the modules it loads, the database script, the tests, the working
 * data, and whatever ends up here next.
 */
const STATIC_DIRECTORIES = new Set(['css', 'js', 'img', 'favicons', 'songs']);

/** Files at the top level that are part of the frontend. */
// sw.js is here because a service worker may only control the pages beneath
// where it is served from: served anywhere but the root, it would control
// nothing.
const STATIC_ROOT_FILES = new Set([
    'robots.txt',
    'songs.json',
    'favicon.ico',
    // What a browser reads to install the application: it has to be at the
    // root, because its scope is decided by where it is served from.
    'manifest.webmanifest',
    'sw.js'
]);

/** Extensions a page may be asked for at the top level. */
const PAGE_EXTENSIONS = new Set(['.html', '']);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, jsonHeaders);
    res.end(JSON.stringify(payload));
}

/**
 * What this page is allowed to do, and where it is allowed to reach.
 *
 * Written out rather than left to the browser's defaults, because the defaults
 * are permissive: without this, a script that somehow got into a page could
 * send whatever it found anywhere it liked. The list is exactly what Spotifie
 * needs and nothing else -
 *
 * - scripts from this origin and the one CDN the Supabase client is loaded
 *   from. 'unsafe-inline' is here for the small setup scripts the pages carry
 *   in their own <script> blocks; it stays until those move to files;
 * - connections to this origin and to Supabase, which is where accounts and
 *   the published catalogue live;
 * - pictures and audio from this origin, from Supabase Storage, and as data:
 *   for the handful of inline icons;
 * - no plugins, no <base> rewriting, and no framing by anybody, which is what
 *   stops the page being loaded invisibly inside someone else's.
 */
function contentSecurityPolicy() {
    const supabase = supabaseOrigin();
    const connect = ["'self'", supabase, supabase.replace(/^https:/, 'wss:')].filter(Boolean).join(' ');
    const media = ["'self'", supabase, 'blob:'].filter(Boolean).join(' ');
    const images = ["'self'", supabase, 'data:', 'blob:'].filter(Boolean).join(' ');

    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        // The pages ask Google Fonts for two families. Named exactly, both of
        // them: the stylesheet comes from one host and the font files from
        // another, and allowing "any" for either would open far more than a
        // typeface.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        // The service worker that keeps the application itself, so Spotifie
        // opens without the network. This origin's own, and nobody else's.
        "worker-src 'self'",
        // ui-avatars stands in for the developer page's portrait when the
        // bundled image cannot be read.
        'img-src ' + images + ' https://ui-avatars.com',
        'media-src ' + media,
        "font-src 'self' data: https://fonts.gstatic.com",
        'connect-src ' + connect,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');
}

/** The Supabase project's origin, or an empty string when none is set. */
function supabaseOrigin() {
    try {
        const settings = getPublicConfig();
        return settings && settings.supabaseUrl ? new URL(settings.supabaseUrl).origin : '';
    } catch (e) {
        return '';
    }
}

/**
 * Which other origins this helper will answer, and why the list is usually
 * empty.
 *
 * This server holds somebody's music library and can be told to search their
 * disks. It listens on loopback, which keeps it off the network - but loopback
 * does not keep it away from a browser, and any page in any tab can try to
 * reach it. What stops that is the browser's own rule: a page on one origin
 * gets no answer from another unless the other says it may.
 *
 * So the answer is no, to everybody, unless the person running it has named an
 * origin. That is what SPOTIFIE_ALLOWED_ORIGINS is for: somebody who has
 * published their own copy and wants Local Music to work there names it, and
 * nothing else is trusted. There is deliberately no wildcard - "*" here would
 * mean any website anybody visits could list, and search, the music on their
 * machine.
 */
function allowedOrigins() {
    // Read when it is needed rather than when this file loads. The rules in
    // here are also read by tests that evaluate this source without a process
    // around it, and a top-level read of the environment would stop them dead.
    const environment = typeof process !== 'undefined' && process.env ? process.env : {};
    const raw = (environment.SPOTIFIE_ALLOWED_ORIGINS || '').trim();
    if (!raw) return [];

    return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .filter((entry) => {
            if (entry === '*') {
                console.warn('SPOTIFIE_ALLOWED_ORIGINS may not contain "*"; that entry is ignored.');
                return false;
            }
            try {
                return Boolean(new URL(entry).origin);
            } catch (e) {
                console.warn('SPOTIFIE_ALLOWED_ORIGINS has an entry that is not an origin; it is ignored.');
                return false;
            }
        })
        .map((entry) => new URL(entry).origin);
}

let allowedOriginsCache = null;

function trustedOrigins() {
    if (!allowedOriginsCache) allowedOriginsCache = allowedOrigins();
    return allowedOriginsCache;
}

/**
 * What to tell a browser about a request from somewhere else.
 *
 * Only for an origin that was named. Everything else gets no header at all,
 * which is the browser's cue to refuse the answer - the same as before any of
 * this existed.
 */
function crossOriginHeaders(req) {
    const origin = req && req.headers ? req.headers.origin : null;
    if (!origin || trustedOrigins().indexOf(origin) === -1) return {};

    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
        // The answer differs by who asked, so a cache must not hand one
        // origin's answer to another.
        Vary: 'Origin'
    };
}

/**
 * The headers every answer carries.
 *
 * No HSTS: this server is meant to be reached over plain HTTP on a machine's
 * own loopback address, and telling a browser to demand HTTPS for localhost
 * would lock the person out of their own player. A deployment behind TLS adds
 * it at the proxy, where the certificate is.
 */
function securityHeaders() {
    return {
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
    };
}

const CSP = contentSecurityPolicy();

/**
 * Resolve a request path to a file inside ROOT_DIR.
 * Returns null when the path escapes the root or touches a blocked segment.
 */
function resolveStaticPath(pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch (e) {
        return null;
    }

    if (decoded.indexOf(NUL_CHAR) !== -1) return null;

    // Normalise separators so Windows-style input cannot bypass the checks.
    const relative = decoded.split(BACKSLASH).join('/').replace(/^[/]+/, '');
    const segments = relative.split('/');

    const meaningful = [];
    for (const segment of segments) {
        if (!segment || segment === '.') continue;
        // Traversal, in any spelling. The path was decoded and its separators
        // normalised above, so this sees what the filesystem would see.
        if (segment === '..') return null;
        if (segment.startsWith('.')) return null;
        meaningful.push(segment);
    }

    // The bare root is the front page.
    if (!meaningful.length) return path.join(ROOT_DIR, 'index.html');

    if (meaningful.length === 1) {
        // One name at the top level: a page, or one of the few files that
        // belong beside them.
        const name = meaningful[0].toLowerCase();
        const extension = path.extname(name);

        if (!STATIC_ROOT_FILES.has(name) && !PAGE_EXTENSIONS.has(extension)) return null;

        // A name with no extension means the page of that name - /signin is
        // signin.html. It never means the folder of that name, so naming a
        // folder cannot become a way to look inside one.
        if (extension === '') return path.join(ROOT_DIR, meaningful[0] + '.html');
    } else if (!STATIC_DIRECTORIES.has(meaningful[0].toLowerCase())) {
        // Anything deeper must be inside one of the asset folders. lib/,
        // test/, node_modules/ and the rest are not served at all.
        return null;
    }

    const resolved = path.resolve(ROOT_DIR, meaningful.join('/'));
    const rootWithSep = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : ROOT_DIR + path.sep;
    if (resolved !== ROOT_DIR && !resolved.startsWith(rootWithSep)) return null;

    // The music root is reachable only through /api/library, by track ID.
    const musicRootWithSep = MUSIC_ROOT.endsWith(path.sep) ? MUSIC_ROOT : MUSIC_ROOT + path.sep;
    if (resolved === MUSIC_ROOT || resolved.startsWith(musicRootWithSep)) return null;

    return resolved;
}

function statFile(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.isFile() ? stats : null;
    } catch (e) {
        return null;
    }
}

/**
 * Serve a static file. Directories fall back to index.html, and a bare
 * page name (e.g. /signin) falls back to the matching .html file.
 */
function serveStatic(req, res, pathname) {
    const target = resolveStaticPath(pathname);
    if (!target) {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }

    let filePath = target;
    let stats = statFile(filePath);

    if (!stats) {
        let stat;
        try {
            stat = fs.statSync(target);
        } catch (e) {
            stat = null;
        }

        if (stat && stat.isDirectory()) {
            filePath = path.join(target, 'index.html');
            stats = statFile(filePath);
        } else if (!path.extname(target)) {
            filePath = target + '.html';
            stats = statFile(filePath);
        }
    }

    if (!stats) {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';

    // A page is finished here rather than in the file.
    //
    // Its canonical address, the address a social card points at and the
    // structured record of what this is are all statements about where the
    // application has been deployed, and the file is the same wherever that
    // is. So the page carries a marker and the server fills it in from
    // PUBLIC_SITE_URL - and where nothing has been configured, fills it in
    // with nothing, because no canonical is better than a wrong one.
    if (extension === '.html') {
        servePage(req, res, filePath, pathname, stats);
        return;
    }

    // Pages, scripts and styles are revalidated on every load, so an edit is
    // never masked by a stale copy in the browser cache. Media is immutable
    // enough to cache for a while.
    const revalidate = ['.html', '.js', '.mjs', '.css', '.json', '.webmanifest'].indexOf(extension) !== -1;

    const headers = Object.assign(
        {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
            'Last-Modified': stats.mtime.toUTCString()
        },
        securityHeaders()
    );

    if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
    }

    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
        res.destroy();
    });
    stream.pipe(res);
}

/**
 * One page, with what only the server knows put into it.
 *
 * Read whole rather than streamed, because it is being changed on the way out
 * and because a page is a few tens of kilobytes. A page with no marker in it
 * comes back exactly as it is on disk.
 */
function servePage(req, res, filePath, pathname, stats) {
    let html;
    try {
        html = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }

    const body = Buffer.from(siteMeta.injectInto(html, pathname === '/' ? '/' : pathname), 'utf8');

    const headers = Object.assign(
        {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-cache',
            'Last-Modified': stats.mtime.toUTCString()
        },
        securityHeaders()
    );

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    res.end(body);
}

/**
 * The three files written for machines rather than for people.
 *
 * Answered by the server rather than kept on disk, because two of the three
 * say where this installation is published and only the server knows whether
 * anybody has said. Answers false when the request was for something else.
 */
function serveMachineReadable(req, res, pathname) {
    const send = (type, text) => {
        const body = Buffer.from(text, 'utf8');
        res.writeHead(
            200,
            Object.assign(
                {
                    'Content-Type': type,
                    'Content-Length': body.length,
                    'Cache-Control': 'public, max-age=3600'
                },
                securityHeaders()
            )
        );
        res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (pathname === '/robots.txt') {
        send('text/plain; charset=utf-8', siteMeta.robotsTxt());
        return true;
    }

    if (pathname === '/llms.txt') {
        send('text/plain; charset=utf-8', siteMeta.llmsTxt());
        return true;
    }

    if (pathname === '/sitemap.xml') {
        const sitemap = siteMeta.sitemapXml();
        if (!sitemap) {
            // Nowhere has been named as this installation's public address, so
            // there is no sitemap to give: a sitemap of loopback addresses
            // would be worse than none.
            sendJson(res, 404, { error: 'No public site URL is configured' });
            return true;
        }
        send('application/xml; charset=utf-8', sitemap);
        return true;
    }

    return false;
}

const adminAlbumRoutes = adminAlbumModule
    ? adminAlbumModule.createAdminAlbumRoutes({
          sendJson: sendJson,
          jsonHeaders: jsonHeaders,
          songsDir: SONGS_DIR,
          songsJson: SONGS_JSON
      })
    : null;

// Request handler
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '/';

    // An origin this installation was told to trust, or nothing at all. The
    // headers are empty for everybody else, which is a browser's cue to refuse
    // the answer - and is what keeps a page on some other site from listing, or
    // searching, the music on this machine.
    const crossOrigin = crossOriginHeaders(req);

    if (req.method === 'OPTIONS') {
        // Advertise the methods. The permission to use them cross-origin is
        // only in there when the asking origin was named.
        res.writeHead(204, Object.assign({ Allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS' }, crossOrigin));
        res.end();
        return;
    }

    // Carried by every answer below, so a trusted origin's request succeeds
    // wherever it lands and an untrusted one is refused wherever it lands.
    for (const header of Object.keys(crossOrigin)) res.setHeader(header, crossOrigin[header]);

    // Health check (both paths kept so existing clients keep working)
    if (pathname === '/health' || pathname === '/api/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return;
        }
        sendJson(res, 200, { status: 'ok', message: 'Spotifie server running' });
        return;
    }

    // Public browser configuration: Supabase project URL and anon key only.
    // Never a service-role key or any other private secret.
    //
    // This is matched before static files and before any 404 handling, so a
    // 404 here can only mean the request reached a different server.
    if (pathname === '/api/config' || pathname === '/api/config/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return;
        }

        // Missing settings are a configuration error, never a 404.
        const problem = getConfigProblem();
        if (problem) {
            sendJson(res, 503, { error: 'Configuration unavailable', detail: problem });
            return;
        }

        const payload = JSON.stringify(getPublicConfig());
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        if (req.method === 'HEAD') {
            res.end();
        } else {
            res.end(payload);
        }
        return;
    }

    // Every page loads js/config.js before anything else. A published build
    // writes that file beside the application; a checkout has none, and a 404
    // there is a body the browser refuses to execute - an error on every page
    // load. So when the file is not on disk, the server answers with a script
    // that sets nothing, which is how a page knows it is a local run and asks
    // /api/config instead. A release that has the file keeps serving it.
    if (pathname === '/js/config.js' && !fs.existsSync(path.join(ROOT_DIR, 'js', 'config.js'))) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return;
        }

        const script = '// Local runtime: this page reads its settings from /api/config.\n';
        res.writeHead(200, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Content-Length': Buffer.byteLength(script),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(req.method === 'HEAD' ? undefined : script);
        return;
    }

    // Unified catalogue API (local library + global admin catalogue)
    if (pathname === '/api/catalog' || pathname.startsWith('/api/catalog/')) {
        const handled = await catalogRoutes.handle(req, res, pathname, parsedUrl.query || {});
        if (handled) return;
    }

    // Local music library API
    if (pathname === '/api/library' || pathname.startsWith('/api/library/')) {
        const handled = await libraryRoutes.handle(req, res, pathname, parsedUrl.query || {});
        if (handled) return;
    }

    // Static frontend and local library files
    if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return;
        }
        if (serveMachineReadable(req, res, pathname)) return;
        serveStatic(req, res, pathname);
        return;
    }

    // Everything below this point changes the library on disk, and every one
    // of those routes is administrator only. The implementation lives in its
    // own module so a build can be made without it: where the module is
    // absent there is no such route, and the request ends at the 404 below,
    // exactly as a made-up path does.
    if (adminAlbumRoutes) {
        const handled = await adminAlbumRoutes.handle(req, res, parsedUrl);
        if (handled) return;
    }

    // 404 for unknown API routes
    sendJson(res, 404, { error: 'Not found' });
});

server.on('clientError', (err, socket) => {
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        // A different program already answers on this port. Spotifie is NOT
        // running: whatever is there will serve the HTML pages but has no
        // /api/config, /health or /api/library routes, which is exactly how a
        // stray static server (VS Code Live Preview/Live Server, an older
        // Spotifie process) shows up as "/api/config was not found".
        console.error('');
        console.error(`Spotifie could not start: port ${PORT} on ${HOST} is already in use.`);
        console.error('Another program is answering on that port, so the app you see there is not Spotifie');
        console.error('and its /api/config, /health and /api/library routes will return 404.');
        console.error('');
        console.error('Fix it in one of these ways:');
        console.error(`  - stop the other server (VS Code Live Preview/Live Server, or an older "node server.js")`);
        console.error(`  - or start Spotifie on a free port:  PORT=3010 npm start`);
        console.error('');
    } else if (err.code === 'EACCES') {
        console.error(`Spotifie could not bind ${HOST}:${PORT} (permission denied). Choose a port above 1023.`);
    } else {
        console.error('Server error:', err.message);
    }
    process.exit(1);
});

/**
 * Check that the music this device was told about is still on it, and keep
 * checking while Spotifie is open.
 *
 * The pass at startup is the authoritative one: it stats every file the index
 * names, so it sees everything, including whatever happened while this was
 * closed. It is cheap enough to run every time - one stat per known file, no
 * tags read, nothing hashed, no folder walked - and it is what takes a deleted
 * song out of Local Music before anybody presses Play on it.
 *
 * The watcher afterwards is a convenience on top: a file deleted while the
 * page is open goes within a second or two instead of at the next launch.
 * Nothing depends on it, because a filesystem watcher cannot be depended on.
 */
function reconcileDeviceLibrary() {
    const deviceLibrary = libraryRoutes.deviceLibrary;
    if (!deviceLibrary) return;

    deviceLibrary
        .reconcile()
        .then((result) => {
            if (result.removed > 0) {
                console.log('Device library: ' + result.removed + ' file(s) are no longer on this machine.');
            }
        })
        .catch((err) => {
            console.warn('Could not check the device library:', err.message);
        })
        .then(() => {
            try {
                new DeviceWatcher({ deviceLibrary: deviceLibrary }).start();
            } catch (e) {
                // A machine that will not let its folders be watched still
                // gets the check at every start.
                console.warn('Watching this device for changes is unavailable:', e.message);
            }
        });
}

server.listen(PORT, HOST, () => {
    const appUrl = `http://${HOST}:${PORT}`;

    console.log(`\n🎵 Spotifie is running. Open ${appUrl}`);
    console.log(`   Sign in:   ${appUrl}/signin.html`);
    // Only where this installation has the dashboard. A build without it
    // should not offer an address that answers 404.
    if (adminAlbumRoutes) console.log(`   Dashboard: ${appUrl}/` + ADMIN_SIGN_IN_PAGE);
    console.log(`   Open the app through this address only - a separate static server cannot serve the API.`);

    const configProblem = getConfigProblem();
    if (configProblem) {
        console.warn(`\n⚠ Supabase is not configured: ${configProblem}`);
        console.warn('  /api/config will report this as a configuration error and sign-in will not work.');
    }

    console.log(`\nAvailable endpoints:`);
    console.log(`  GET  /                  - Frontend (index.html)`);
    console.log(`  GET  /api/config        - Public Supabase settings for the browser`);
    console.log(`  GET  /health            - Health check`);
    console.log(`  POST /api/create-album  - Create new album folder`);
    console.log(`  POST /api/update-album  - Update existing album`);
    console.log(`  POST /api/add-song      - Add song to album`);
    console.log(`  POST /api/delete-album  - Delete album folder`);
    console.log(`  POST /api/delete-song   - Delete song from album`);
    console.log(`  GET  /api/health        - Health check`);
    console.log(`  GET  /api/library/...   - Local music library (tracks, albums, artists, stream, artwork)`);
    console.log(`  GET  /api/catalog/...   - Unified catalogue (local + global admin catalogue)`);
    console.log(`  POST /api/library/rescan- Rescan the music root`);
    console.log(`\nMusic root: ${path.basename(MUSIC_ROOT)} (set MUSIC_ROOT to change)`);
    console.log(`\nPress Ctrl+C to stop\n`);

    // What this machine was told it has, checked against what it still has.
    // In the background: nothing waits for it, and the page draws from the
    // index while it runs.
    reconcileDeviceLibrary();

    // Build the index on first run so the player has something to show.
    // Later rescans are explicit (POST /api/library/rescan).
    const status = libraryRoutes.service.getStatus();
    if (status.rootAvailable && status.trackCount === 0) {
        libraryRoutes.service
            .scan()
            .then((result) => {
                console.log(`Library scan complete: ${result.trackCount} tracks`);
            })
            .catch((err) => {
                console.error('Library scan failed:', err.message);
            });
    }
});
