/**
 * Spotifie Authentication Module
 *
 * The Supabase session is the only authority on whether someone is signed in.
 * Nothing in localStorage or sessionStorage can grant access: cached profile
 * values exist purely so the header can render a name without a flash, and
 * they are discarded whenever the real session disagrees.
 *
 * Admin rights come from the `app_admins` table, keyed by the authenticated
 * user id. The browser can only read its own row; privileged actions are
 * additionally checked server-side.
 *
 * Setup lives in supabase-setup.sql. Public configuration (project URL and
 * anon key) is served by the local server at /api/config.
 */

(function (global) {
    'use strict';

    // Cached profile fields for rendering only - never proof of a session.
    const PROFILE_CACHE_KEY = 'spotifie_profile_cache';

    // Keys written by older versions that could be mistaken for a session.
    const LEGACY_AUTH_KEYS = ['spotifie_user', 'spotifie_admin', 'spotifie_admin_pending'];

    // Where the public Supabase settings come from.
    //
    // Two places, asked in that order, because Spotifie runs in two. Served by
    // the local Node server when there is one; written into a file beside the
    // application when it was published to a static host, which has no server
    // to ask. Both carry the same two values, and both are public: the project
    // URL and the anon key. A service-role key belongs in neither, and in no
    // browser.
    const CONFIG_URL = '/api/config';
    const STATIC_CONFIG_URL = 'config.json';
    const START_HINT =
        'If you are running Spotifie yourself, stop any other server on this port (VS Code Live ' +
        'Preview / Live Server, or an older "node server.js"), run "npm start", and open the ' +
        'address it prints - http://127.0.0.1:3000 by default.';
    const CONFIG_UNAVAILABLE = 'Authentication is unavailable: the app configuration could not be loaded. ' + START_HINT;

    /**
     * Step-by-step admin diagnostics, off unless this browser asks for them.
     *
     * Turned on by hand, from the console: localStorage.setItem('spotifie_debug', '1').
     * The lines name an account id and which check answered - never a token,
     * a cookie or a key - but a production console has no reason to print
     * them on every load. Warnings and errors are not affected.
     */
    function debugEnabled() {
        try {
            return Boolean(global.localStorage && global.localStorage.getItem('spotifie_debug') === '1');
        } catch (e) {
            return false;
        }
    }

    function debugInfo(message) {
        if (debugEnabled()) console.info(message);
    }

    /**
     * Where Spotifie is, said one way.
     *
     * The application has one address - the root - and every page that sends
     * somebody back into it sends them there. index.html is the same document
     * and opening it by hand still works, but nothing here points at it: two
     * addresses for one page means two entries in a cache, two entries in the
     * history, and a Back button that goes to whichever of them somebody
     * happened to arrive by.
     *
     * A published copy knows the address it was published at and says so, so a
     * link Supabase sends by email comes back to the site rather than to the
     * machine a build happened on. A copy somebody is running says nothing,
     * and the address the page is open at is the right answer.
     */
    function siteOrigin() {
        const deployment = global.spotifieDeployment;
        const published = deployment && deployment.siteUrl ? deployment.siteUrl() : null;

        if (published) {
            try {
                return new URL(published).origin;
            } catch (e) {
                /* a setting that is not an address is no address at all */
            }
        }

        return global.location ? global.location.origin : '';
    }

    /** An address inside Spotifie, from the one place that knows where it is. */
    function siteUrlFor(path) {
        try {
            return new URL(path, siteOrigin() + '/').toString();
        } catch (e) {
            return path;
        }
    }

    /**
     * An address inside the copy that is running, for navigating within it.
     *
     * In a browser that is the published site. Inside a native shell (the
     * Android app, the desktop app) the application is served by the shell
     * itself, and the published address is somewhere else entirely - going
     * there hands the person to the system browser and leaves the app behind.
     * So inside a shell, moving around the application stays on the origin
     * the page is already on.
     */
    function appUrlFor(path) {
        if (inNativeShell() && global.location && global.location.origin) {
            try {
                return new URL(path, global.location.origin + '/').toString();
            } catch (e) {
                return path;
            }
        }
        return siteUrlFor(path);
    }

    /**
     * Where a link in an email should bring somebody back to.
     *
     * The published site, as always - except in the phone apps, each of which
     * has its own callback address so a confirmation or reset link reopens the
     * app rather than the website. That address must be listed in Supabase's
     * Redirect URLs; until it is, Supabase sends the link to the site instead,
     * which still works.
     *
     * The sign-up and password pages load no shell adapter, and they are
     * exactly the pages that ask for these links, so the app's own address is
     * also known from Capacitor's bridge alone.
     */
    function authRedirectFor(path) {
        const shell = nativeShellAdapter();
        if (shell && typeof shell.authCallbackUrl === 'function') return shell.authCallbackUrl(path);
        const callback = APP_CALLBACKS[capacitorPlatform()];
        if (callback) return callback + '?next=' + encodeURIComponent(CALLBACK_PAGES.indexOf(path) !== -1 ? path : '/');
        return siteUrlFor(path);
    }

    /**
     * Each app's callback address: its own URL scheme, which is its
     * application id. The adapters (js/androidNative.js, js/iosNative.js) carry
     * the same addresses, and follow a link to one of them when the system
     * hands it to the app. Each must also be listed in Supabase's Redirect URLs;
     * until it is, Supabase sends the link to the site instead.
     */
    const APP_CALLBACKS = {
        android: 'app.spotifie.android://auth/callback',
        ios: 'app.spotifie.ios://auth/callback'
    };
    const CALLBACK_PAGES = ['/', '/signin.html', '/reset-password.html'];

    /** The application itself. Never index.html: one page, one address. */
    function homeUrl() {
        if (inNativeShell()) return appUrlFor('/');
        return siteUrlFor('/');
    }

    let configError = null;

    let clientPromise = null;
    let supabaseClient = null;
    let currentSession = null;
    let sessionReady = null;
    let resolveSessionReady = null;
    let recoveryMode = false;
    const listeners = new Set();

    function purgeLegacyAuthStorage() {
        LEGACY_AUTH_KEYS.forEach((key) => {
            try {
                localStorage.removeItem(key);
                sessionStorage.removeItem(key);
            } catch (e) {
                /* storage may be unavailable */
            }
        });
    }

    function readProfileCache() {
        try {
            const raw = localStorage.getItem(PROFILE_CACHE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function writeProfileCache(profile) {
        try {
            localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
        } catch (e) {
            /* ignore */
        }
    }

    function clearProfileCache() {
        try {
            localStorage.removeItem(PROFILE_CACHE_KEY);
        } catch (e) {
            /* ignore */
        }
    }

    /** Display profile for a user id, but only when it belongs to that user. */
    function cachedProfileFor(userId) {
        const cached = readProfileCache();
        if (!cached || cached.id !== userId) return null;
        return cached;
    }

/**
     * The settings, from whichever place this copy of Spotifie keeps them.
     *
     * A published copy carries them: the build wrote them into a script the
     * page loads, so they are already here and nothing is fetched at all. That
     * is asked first, and when it answers nothing else is.
     *
     * A checkout somebody is running asks its own server, which is the
     * authority on that installation.
     *
     * The two are not tried in turn on a guess. Asking a static host for
     * /api/config is how a published copy came to collect a 404 on every load
     * and then report that Supabase was not configured - the one endpoint that
     * would have said otherwise being the one that was missing.
     */
    async function loadPublicConfig() {
        const deployment = global.spotifieDeployment;

        if (deployment && deployment.isPublished()) {
            const carried = deployment.supabase();
            if (carried) return { supabaseUrl: carried.url, supabaseAnonKey: carried.anonKey };

            throw new Error(
                'This copy of Spotifie was published without its Supabase settings. ' +
                    'Set SUPABASE_URL and SUPABASE_ANON_KEY in the build environment and build it again.'
            );
        }

        const fromServer = await tryConfigSource(CONFIG_URL, { cache: 'no-store' });
        if (fromServer) return fromServer;

        // A copy served as files without having been built - opened from a
        // folder, or from a static server during development. The settings
        // beside it, if a build put any there.
        const fromFile = await tryConfigSource(STATIC_CONFIG_URL, {});
        if (fromFile) return fromFile;

        throw new Error(
            'Supabase is not configured for this copy of Spotifie. ' +
                'Set SUPABASE_URL and SUPABASE_ANON_KEY (see .env.example) before building it. ' +
                START_HINT
        );
    }

    /**
     * One place the settings might be, or null.
     *
     * Answers null for every way of not being there - no route, no file, not
     * reachable, not JSON, incomplete - because the caller's next move is the
     * same for all of them: ask somewhere else. A source that answers with
     * something unusable is worth a line in the console, and nothing more.
     */
    async function tryConfigSource(url, init) {
        let response;
        try {
            response = await fetch(url, Object.assign({ credentials: 'same-origin' }, init));
        } catch (e) {
            return null;
        }

        if (!response.ok) {
            // A server that has the route but no settings says so, and that is
            // worth passing on rather than silently trying elsewhere.
            if (response.status === 503) {
                let detail = '';
                try {
                    const body = await response.json();
                    detail = (body && (body.detail || body.error)) || '';
                } catch (e) {
                    detail = '';
                }
                throw new Error('Supabase is not configured.' + (detail ? ' ' + detail : ''));
            }
            return null;
        }

        let config;
        try {
            config = await response.json();
        } catch (e) {
            return null;
        }

        if (!config || !config.supabaseUrl || !config.supabaseAnonKey) return null;
        return config;
    }

    /** Kept for the tests that describe how a broken server is reported. */
    async function loadConfigFromServer() {
        let response;
        try {
            response = await fetch(CONFIG_URL, { credentials: 'same-origin', cache: 'no-store' });
        } catch (e) {
            throw new Error(
                'Could not reach ' + CONFIG_URL + '. ' + START_HINT + ' (network error: ' + e.message + ')'
            );
        }

        if (response.status === 404) {
            throw new Error(CONFIG_URL + ' was not found. ' + START_HINT);
        }
        if (!response.ok) {
            // The server reports a missing/incomplete configuration as JSON.
            let detail = '';
            try {
                const body = await response.json();
                if (body && body.detail) detail = ' ' + body.detail;
                else if (body && body.error) detail = ' ' + body.error;
            } catch (e) {
                detail = '';
            }

            if (response.status === 503 && detail) {
                throw new Error('Supabase is not configured.' + detail);
            }
            throw new Error(CONFIG_URL + ' returned HTTP ' + response.status + '.' + detail + ' ' + START_HINT);
        }

        let config;
        try {
            config = await response.json();
        } catch (e) {
            throw new Error(CONFIG_URL + ' did not return JSON. ' + START_HINT);
        }

        if (!config || !config.supabaseUrl || !config.supabaseAnonKey) {
            throw new Error(
                'The server returned incomplete Supabase settings. Set SUPABASE_URL and ' +
                    'SUPABASE_ANON_KEY (see .env.example) and restart the server.'
            );
        }

        return config;
    }

    /** The last configuration/startup problem, or null. */
    function getConfigError() {
        return configError;
    }

    /**
     * Create (once) and return the Supabase client.
     * A failed attempt is not cached, so a later call can succeed once the
     * server is running.
     */
    function getClient() {
        if (clientPromise) return clientPromise;

        clientPromise = (async () => {
            if (typeof global.supabase === 'undefined') {
                throw new Error('The Supabase SDK did not load. Check your network connection and reload.');
            }

            const config = await loadPublicConfig();
            supabaseClient = global.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    // Supabase parses recovery/confirmation links itself; the app
                    // never trusts tokens it reads out of the URL by hand.
                    detectSessionInUrl: true
                }
            });

            attachAuthListener(supabaseClient);
            configError = null;
            return supabaseClient;
        })().catch((err) => {
            // Remember why, report it plainly, and allow a retry rather than
            // failing every later call with a cached rejection.
            configError = err.message;
            clientPromise = null;
            supabaseClient = null;
            console.error('Authentication is not configured:', err.message);
            throw err;
        });

        return clientPromise;
    }

    /** Get the client, or null when authentication is unavailable. */
    async function tryGetClient() {
        try {
            return await getClient();
        } catch (e) {
            return null;
        }
    }

    /** Result shape used when nothing can work until configuration is fixed. */
    function configFailure() {
        return { success: false, error: configError || CONFIG_UNAVAILABLE };
    }

    function attachAuthListener(client) {
        sessionReady = new Promise((resolve) => {
            resolveSessionReady = resolve;
        });

        client.auth.getSession().then(({ data }) => {
            applySession(data ? data.session : null, 'INITIAL_SESSION');
            if (resolveSessionReady) resolveSessionReady(currentSession);
        });

        client.auth.onAuthStateChange((event, session) => {
            if (event === 'PASSWORD_RECOVERY') {
                recoveryMode = true;
            }
            applySession(session, event);
            if (resolveSessionReady) resolveSessionReady(currentSession);
        });
    }

    function applySession(session, event) {
        const previousUserId = currentSession && currentSession.user ? currentSession.user.id : null;
        currentSession = session || null;
        const userId = currentSession && currentSession.user ? currentSession.user.id : null;

        // Whether the last account was an administrator says nothing about
        // this one, so the answer goes with the account it was about.
        if (userId !== previousUserId) adminAnswer = { userId: null, verified: null };

        // A different user (or no user) must never inherit cached UI state.
        if (!userId) {
            clearProfileCache();
            purgeLegacyAuthStorage();
        } else if (userId !== previousUserId) {
            const cached = readProfileCache();
            if (cached && cached.id !== userId) {
                clearProfileCache();
            }
        }

        notify(event);
        renderAuthUI();
    }

    function notify(event) {
        listeners.forEach((listener) => {
            try {
                listener(currentSession, event);
            } catch (e) {
                console.error('Auth listener failed:', e);
            }
        });
    }

    /**
     * Wait until the initial session has been resolved.
     * Never throws: when configuration is missing the app renders signed out
     * and getConfigError() explains why.
     */
    async function ready() {
        const client = await tryGetClient();
        if (!client) {
            renderAuthUI();
            return null;
        }
        if (sessionReady) await sessionReady;
        return currentSession;
    }

    /** The authoritative session, or null. */
    async function getSession() {
        const client = await tryGetClient();
        if (!client) return null;

        const { data, error } = await client.auth.getSession();
        if (error) {
            console.error('Session lookup failed:', error);
            return null;
        }
        currentSession = data ? data.session : null;
        return currentSession;
    }

    /** The authenticated user verified against Supabase, or null. */
    async function getUser() {
        const client = await tryGetClient();
        if (!client) return null;

        const { data, error } = await client.auth.getUser();
        if (error || !data || !data.user) return null;
        return data.user;
    }

    async function getAccessToken() {
        const session = await getSession();
        return session && session.access_token ? session.access_token : null;
    }

    /** Fetch helper that carries the current access token, when there is one. */
    async function authorizedFetch(url, options) {
        const settings = Object.assign({}, options);
        const headers = Object.assign({}, settings.headers || {});
        const token = await getAccessToken();
        if (token) headers.Authorization = 'Bearer ' + token;
        settings.headers = headers;
        settings.credentials = 'same-origin';
        return fetch(url, settings);
    }

    /**
     * Open the administrator dashboard, the only way it opens.
     *
     * On a published copy the dashboard is not a page anybody can navigate to.
     * The Cloudflare worker serves it only after it has verified, against
     * Supabase, that the account asking is an administrator - so this asks the
     * worker for entry, carrying the current access token, and navigates only
     * once the worker has granted it. A non-administrator, or somebody whose
     * session has lapsed, is granted nothing and goes nowhere; the worker sends
     * a direct attempt at the address back to the application regardless.
     *
     * On a local checkout there is no worker and no gate: the server serves the
     * page and admin.js guards it, so this simply opens it.
     *
     * Answers whether entry was granted, so a caller can say when it was not.
     */
    async function enterAdmin() {
        // The first thing, before any await. The delegated click handler logs
        // "[admin-enter] click" the instant the item is pressed; this logs the
        // instant the function it calls actually runs. Seeing the first without
        // the second would mean the handler fired but enterAdmin did not.
        debugInfo('[admin-enter] function');
        debugInfo('[admin-enter] target: /admin-dashboard');

        const deployment = global.spotifieDeployment;
        const published = Boolean(deployment && deployment.isPublished());

        // On a local checkout there is no worker and no gate: the server serves
        // the page and admin.js guards it, so this simply opens it.
        if (!published) {
            global.location.assign('/admin-dashboard.html');
            return true;
        }

        // A native shell carries no dashboard and has no worker of its own. It
        // opens the published site - inside the app, never the system browser
        // - asking it to enter the dashboard, and the worker there verifies
        // the administrator exactly as it does for anybody else.
        if (inNativeShell()) {
            const shell = nativeShellAdapter();
            if (shell && typeof shell.openAdmin === 'function') {
                return shell.openAdmin(siteUrlFor('/?admin=enter'));
            }
            console.warn('Could not open the admin dashboard: this app cannot show it.');
            return false;
        }

        // The session's own access token is what the worker verifies. No token,
        // no session - there is nothing to ask entry with.
        const token = await getAccessToken();
        debugInfo('[admin-enter] session: ' + (token ? 'yes' : 'no'));
        if (!token) {
            console.warn('Could not open the admin dashboard: no active session.');
            return false;
        }

        try {
            // Same origin, and carrying the bearer token explicitly, so the
            // worker sets its entry cookie on this origin - the one the
            // navigation that follows sends it back to. credentials keeps that
            // Set-Cookie.
            debugInfo('[admin-enter] POST starting');
            const response = await fetch('/api/admin/enter', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token },
                credentials: 'same-origin'
            });
            debugInfo('[admin-enter] POST status: ' + response.status);
            debugInfo('[admin-enter] POST ok: ' + response.ok);

            if (!response.ok) {
                // Signed in but not granted entry. Stay put; the item only
                // shows for administrators, so this is rare.
                console.warn('Could not open the admin dashboard: entry was not granted.');
                return false;
            }

            // Only after the response - and its Set-Cookie - is in hand.
            debugInfo('[admin-enter] navigating: /admin-dashboard');
            window.location.assign('/admin-dashboard');
            return true;
        } catch (e) {
            console.warn('Could not open the admin dashboard:', e && e.message);
            return false;
        }
    }

    // ============================================
    // PROFILE
    // ============================================

    /**
     * Profile for the signed-in user. Profiles are created by a database
     * trigger; this repairs the row for accounts that predate the trigger.
     */
    async function getProfile(options) {
        const settings = options || {};
        const session = settings.session || (await getSession());
        if (!session || !session.user) return null;

        const user = session.user;
        const cached = cachedProfileFor(user.id);
        if (cached && !settings.refresh) return cached;

        const client = await tryGetClient();
        if (!client) return cached;
        let username = null;

        const { data: profile } = await client
            .from('profiles')
            .select('username')
            .eq('id', user.id)
            .maybeSingle();

        if (profile && profile.username) {
            username = profile.username;
        } else {
            username =
                (user.user_metadata && user.user_metadata.username) ||
                (user.email ? user.email.split('@')[0] : 'User');

            // Safe for existing accounts without a profile row: RLS only lets
            // a user write their own id.
            await client
                .from('profiles')
                .upsert({ id: user.id, email: user.email, username: username }, { onConflict: 'id' });
        }

        const result = { id: user.id, email: user.email, username: username };
        writeProfileCache(result);
        return result;
    }

    // ============================================
    // ADMIN AUTHORIZATION
    // ============================================

    /**
     * Is the signed-in user an administrator?
     * Row Level Security limits this query to the caller's own row, and the
     * table grants no insert/update/delete to ordinary users.
     */
    /**
     * Is the account signed in here an administrator?
     *
     * The database decides, and it decides from the account's id: there is a
     * row in app_admins or there is not. No email is compared here, nothing
     * the browser can write takes part, and a "yes" from this changes nothing
     * about what the account may do - every privileged action is checked again
     * where it happens, against the same table.
     *
     * Asked two ways, in this order. The function the database already has,
     * which answers the question directly and is the same one every admin-only
     * policy calls; and, if that is not reachable, the account's own row,
     * which the policy on that table lets it read and nobody else's.
     *
     * The answer is kept for the account it was asked about and dropped the
     * moment that account changes. A failure is never kept: an answer that
     * could not be obtained is not the same as "no", and remembering it as one
     * would hide the dashboard from an administrator for the whole visit.
     */
    let adminAnswer = { userId: null, verified: null };

    async function isAdmin(options) {
        const settings = options || {};
        const session = await getSession();
        if (!session || !session.user) {
            if (!settings.retried) debugInfo('[admin] session: no');
            adminAnswer = { userId: null, verified: null };
            return false;
        }

        const userId = session.user.id;
        if (!settings.refresh && adminAnswer.userId === userId && adminAnswer.verified !== null) {
            return adminAnswer.verified;
        }

        if (!settings.retried) {
            // The account id, never the token: an id says who the answer is
            // about and grants nothing; a token would be a way in.
            debugInfo('[admin] session: yes');
            debugInfo('[admin] uid: ' + userId);
        }

        const client = await tryGetClient();
        if (!client) return false;

        const verified = await askDatabaseAboutAdmin(client, userId);

        // Only a real answer is remembered. A session that was still settling
        // when this was asked gets one more chance rather than a permanent no -
        // which is what stops a slow first answer being cached as "not an
        // administrator" for the rest of the visit.
        if (verified === null) {
            if (settings.retried) {
                debugInfo('[admin] verifiedAdmin: false (could not reach the database)');
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
            return isAdmin({ refresh: true, retried: true });
        }

        debugInfo('[admin] verifiedAdmin: ' + verified);
        adminAnswer = { userId: userId, verified: verified };
        return verified;
    }

    /**
     * True, false, or null when the question could not be put.
     *
     * Three ways of asking the same database the same thing, in the order that
     * asks the least. The function that takes no argument answers about
     * whoever is calling, which is the narrowest question there is and the one
     * a browser should be asking. The same function by id is what older
     * projects have. The account's own row is the last resort, and the policy
     * on that table lets an account read exactly one row: its own.
     *
     * Every one of them returns a plain true or false, so none of them can be
     * used to read the administrator list, and none of them writes anything.
     */
    async function askDatabaseAboutAdmin(client, userId) {
        const attempts = [
            { name: 'is_admin()', ask: () => client.rpc('is_admin') },
            { name: 'is_admin(uid)', ask: () => client.rpc('is_admin', { uid: userId }) },
            {
                name: 'app_admins row',
                ask: () => client.from('app_admins').select('user_id').eq('user_id', userId).maybeSingle()
            }
        ];

        let lastProblem = null;

        for (const attempt of attempts) {
            try {
                const { data, error } = await attempt.ask();

                if (!error) {
                    // A function answers with the boolean itself; a row answers
                    // with the row, or with nothing when there is none.
                    const verified = typeof data === 'boolean' ? data : Boolean(data);
                    adminDiagnostic(userId, attempt.name, verified, null);
                    return verified;
                }

                lastProblem = error.message || String(error);
                adminDiagnostic(userId, attempt.name, null, lastProblem);
            } catch (err) {
                lastProblem = (err && err.message) || String(err);
                adminDiagnostic(userId, attempt.name, null, lastProblem);
            }
        }

        console.error('Could not find out whether this account is an administrator:', lastProblem);
        return null;
    }

    /**
     * What was asked, and what came back.
     *
     * Said once per account, because this is the part that is impossible to
     * diagnose from the outside: whether the question reached the database at
     * all, which way of asking answered, and what it said. The account id is
     * in it because that is what the answer is about; nothing else is - no
     * token, no key, no session.
     */
    function adminDiagnostic(userId, how, verified, problem) {
        if (problem) {
            // Which way of asking could not answer, and why. The zero-argument
            // function being absent is the expected first line on a project
            // whose database has not had the current schema applied yet - the
            // next line shows the fallback answering.
            debugInfo('[admin] rpc error: ' + how + ': ' + problem);
            return;
        }

        debugInfo('[admin] rpc data: ' + verified + ' (' + how + ')');
    }

    // ============================================
    // AUTHENTICATION ACTIONS
    // ============================================

    async function signUp(email, password, username) {
        try {
            if (!username || username.length < 2 || username.length > 10) {
                return { success: false, error: 'Username must be 2-10 characters' };
            }
            if (!password || password.length < 6) {
                return { success: false, error: 'Password must be at least 6 characters' };
            }

            const client = await tryGetClient();
            if (!client) return configFailure();

            const { data, error } = await client.auth.signUp({
                email: email,
                password: password,
                options: {
                    data: { username: username },
                    emailRedirectTo: authRedirectFor('/signin.html')
                }
            });

            if (error) {
                return { success: false, error: error.message };
            }

            // With email confirmation enabled Supabase returns no session:
            // that account is not signed in and must not be treated as one.
            const needsConfirmation = !data.session;

            if (data.session) {
                await getProfile({ session: data.session, refresh: true });
            }

            return { success: true, needsConfirmation: needsConfirmation, user: data.user || null };
        } catch (err) {
            console.error('Signup exception:', err);
            return { success: false, error: 'An unexpected error occurred' };
        }
    }

    async function signIn(email, password) {
        try {
            const client = await tryGetClient();
            if (!client) return configFailure();

            const { data, error } = await client.auth.signInWithPassword({
                email: email,
                password: password
            });

            if (error) {
                return { success: false, error: error.message };
            }
            if (!data.session) {
                return { success: false, error: 'Please confirm your email address before signing in' };
            }

            // Never carry another account's cached display data over.
            clearProfileCache();
            await getProfile({ session: data.session, refresh: true });

            return { success: true, user: data.user };
        } catch (err) {
            console.error('Signin exception:', err);
            return { success: false, error: 'An unexpected error occurred' };
        }
    }

    async function signOut() {
        try {
            const client = await tryGetClient();
            if (client) await client.auth.signOut();
        } catch (err) {
            console.error('Signout exception:', err);
        } finally {
            // Only session-scoped UI cache is cleared; the local music library
            // and its index are untouched.
            clearProfileCache();
            purgeLegacyAuthStorage();
            currentSession = null;
        }
        return { success: true };
    }

    async function resetPassword(email) {
        try {
            const client = await tryGetClient();
            if (!client) return configFailure();

            const { error } = await client.auth.resetPasswordForEmail(email, {
                redirectTo: authRedirectFor('/reset-password.html')
            });
            if (error) {
                return { success: false, error: error.message };
            }
            return { success: true };
        } catch (err) {
            console.error('Password reset exception:', err);
            return { success: false, error: 'An unexpected error occurred' };
        }
    }

    async function updatePassword(newPassword) {
        try {
            if (!newPassword || newPassword.length < 6) {
                return { success: false, error: 'Password must be at least 6 characters' };
            }

            const client = await tryGetClient();
            if (!client) return configFailure();

            // Supabase turns a valid recovery link into a session; without one
            // there is nothing to update.
            const session = await getSession();
            if (!session) {
                return { success: false, error: 'This password reset link is invalid or has expired' };
            }

            const { error } = await client.auth.updateUser({ password: newPassword });
            if (error) {
                return { success: false, error: error.message };
            }

            recoveryMode = false;
            return { success: true };
        } catch (err) {
            console.error('Password update exception:', err);
            return { success: false, error: 'An unexpected error occurred' };
        }
    }

    /**
     * Resolve once a recovery session is available (or time out).
     * Used by reset-password.html to tell a valid link from an expired one.
     */
    async function waitForRecoverySession(timeoutMs) {
        const client = await tryGetClient();
        if (!client) return null;
        const limit = typeof timeoutMs === 'number' ? timeoutMs : 5000;
        const started = Date.now();

        while (Date.now() - started < limit) {
            const session = await getSession();
            if (session) return session;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return null;
    }

    function isRecoveryMode() {
        return recoveryMode;
    }

    // ============================================
    // SHARED UI
    // ============================================

    function setDisplay(element, value) {
        if (element) element.style.display = value;
    }

    /**
     * Write "<name>'s Library" above the sidebar.
     *
     * A person chooses their own display name, and it arrives here as whatever
     * they typed. Built as a string of HTML, a name containing a tag would be
     * parsed as one and would run in every page that showed it. So the name is
     * set as text and the decoration is built as elements: nothing in the name
     * can become markup, whatever it says.
     */
    function writeLibraryTitle(element, name) {
        element.textContent = String(name === undefined || name === null ? '' : name) + "'s Library ";

        const heart = document.createElement('span');
        heart.className = 'emoji-large';
        heart.textContent = '❤';
        element.appendChild(heart);
    }

    /** Render header/session UI from the current session. Design unchanged. */
    async function renderAuthUI() {
        if (typeof document === 'undefined') return;

        const signInBtn = document.querySelector('#signInBtn, .sign-in-btn, [data-auth="signin"]');
        const signUpBtn = document.querySelector('#signUpBtn, .sign-up-btn, [data-auth="signup"]');
        const userMenu = document.querySelector('#userMenu, .user-menu, [data-auth="user-menu"]');
        const userNameDisplay = document.querySelector('#userName, .user-name, [data-auth="username"]');
        const libraryTitle = document.querySelector('#libraryTitle, .library-title, [data-auth="library-title"]');
        const authSkeleton = document.getElementById('authSkeleton');

        const session = currentSession;
        const user = session ? session.user : null;

        if (authSkeleton) authSkeleton.classList.add('hidden');

        if (!user) {
            setDisplay(signInBtn, '');
            setDisplay(signUpBtn, '');
            setDisplay(userMenu, 'none');
            // A guest never has the item made; one left over from a previous
            // account is hidden.
            setDisplay(findDashboardItem(), 'none');
            if (libraryTitle) writeLibraryTitle(libraryTitle, 'Spotifie');
            return;
        }

        const cached = cachedProfileFor(user.id);
        const displayName = (cached && cached.username) ||
            (user.user_metadata && user.user_metadata.username) ||
            (user.email ? user.email.split('@')[0] : 'User');

        setDisplay(signInBtn, 'none');
        setDisplay(signUpBtn, 'none');
        setDisplay(userMenu, 'flex');
        if (userNameDisplay) userNameDisplay.textContent = displayName;
        if (libraryTitle) writeLibraryTitle(libraryTitle, displayName);

        // Fetch the real profile, then re-render if the name changed.
        getProfile({ session: session }).then((profile) => {
            if (!profile || !currentSession || currentSession.user.id !== profile.id) return;
            if (profile.username !== displayName) {
                if (userNameDisplay) userNameDisplay.textContent = profile.username;
                if (libraryTitle) writeLibraryTitle(libraryTitle, profile.username);
            }
        });

        // The dashboard link is a convenience only: the dashboard and every
        // privileged endpoint verify admin rights independently.
        //
        // The menu is drawn before this is known - it has to be, or signing in
        // would leave somebody looking at nothing while a question went to the
        // database and came back. So the answer arrives afterwards and the
        // menu is corrected in place, without a refresh and without the item
        // ever appearing for an account it does not belong to: an answer about
        // somebody who has since signed out, or been replaced, is discarded.
        // What is already known goes up with the rest of the menu, so a render
        // that happens after the answer arrived - opening the menu, a profile
        // name coming back, signing in again in another tab - does not hide
        // the item and ask all over again.
        applyAdminUI();

        if (adminAnswer.userId !== user.id || adminAnswer.verified === null) {
            isAdmin()
                .then(() => {
                    // The menu is drawn again rather than poked at, so whatever
                    // it looks like by then is what gets the item - and an
                    // answer about somebody who has since signed out, or been
                    // replaced, changes nothing.
                    debugInfo('[admin] menu rerender');
                    applyAdminUI();
                })
                .catch((error) => {
                    console.warn('Could not decide whether this account is an administrator:', error && error.message);
                });
        }
    }

    /** The icon the item carries, matching the other menu items. */
    const DASHBOARD_ICON =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
        '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
        '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
        '<rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

    /** The admin item in the menu, whichever way it got there, or null. */
    function findDashboardItem() {
        if (typeof document === 'undefined') return null;
        return document.getElementById('dashboardLink') || document.querySelector('[data-action="admin-dashboard"]');
    }

    /**
     * The admin item, made if it is not already there.
     *
     * The menu the visitor actually sees is the source of truth, not a static
     * element that a stale page might be missing or a rebuild might drop. So
     * this puts the item into that menu - the real one, #userDropdown - when it
     * is not present, in its usual place above Log out, and returns it either
     * way. Only ever called for a verified administrator, so a menu that has no
     * item is a menu that should not have one.
     */
    function ensureDashboardItem() {
        const existing = findDashboardItem();
        if (existing) return existing;

        if (typeof document === 'undefined') return null;
        const dropdown = document.getElementById('userDropdown');
        if (!dropdown || typeof document.createElement !== 'function') return null;

        const item = document.createElement('button');
        item.type = 'button';
        item.id = 'dashboardLink';
        item.className = 'dropdown-item admin-link';
        item.setAttribute('data-action', 'admin-dashboard');
        // The one route this item stands for, named explicitly. Its highlight
        // is decided from this, not from whether the account is an
        // administrator.
        item.setAttribute('data-route', '/admin-dashboard');
        item.style.display = 'none';
        // A constant string of trusted markup: an icon and a label, nothing
        // from anybody's input.
        item.innerHTML = DASHBOARD_ICON + '<span>Admin Dashboard</span>';

        // Above Log out, and above the divider that sits before it, so the
        // order reads Profile, the device items, Admin Dashboard, Log out.
        let before = document.getElementById('logoutBtn');
        if (
            before &&
            before.previousElementSibling &&
            before.previousElementSibling.classList &&
            before.previousElementSibling.classList.contains('dropdown-divider')
        ) {
            before = before.previousElementSibling;
        }

        if (before && before.parentNode === dropdown) dropdown.insertBefore(item, before);
        else dropdown.appendChild(item);

        return item;
    }

    /**
     * The one click handler for the admin item, on the document, attached once.
     *
     * Delegation, deliberately, and this is the fix for a click that produced
     * nothing: a handler bound to the item itself is only as durable as that
     * exact element, and the item is created, hidden, shown and - on a menu
     * that rebuilds - replaced. A handler on the document survives every one of
     * those, because it matches the item by its data-action at click time
     * rather than holding a reference to it. Whatever element carries
     * data-action="admin-dashboard" when the click happens is the one that
     * opens the dashboard.
     *
     * Attached once. A second call does nothing, so a menu that renders a
     * hundred times still has exactly one listener and one enterAdmin per click.
     */
    let adminClickWired = false;

    function wireAdminEntry() {
        if (adminClickWired || typeof document === 'undefined' || !document.addEventListener) return;
        adminClickWired = true;

        document.addEventListener('click', (event) => {
            const target =
                event.target && event.target.closest ? event.target.closest('[data-action="admin-dashboard"]') : null;
            if (!target) return;

            event.preventDefault();

            // Close the menu it was in, whichever way this build opens one.
            const menu = document.getElementById('userMenu');
            if (menu && menu.classList) menu.classList.remove('open');
            const dropdown = document.getElementById('userDropdown');
            if (dropdown && dropdown.classList) dropdown.classList.remove('active');

            debugInfo('[admin-enter] click');
            enterAdmin();
        });
    }

    /**
     * Put the one thing an administrator has that nobody else does into the
     * visible menu, or take it out.
     *
     * Read from the answer this session has, about the account this session
     * has. Called when the header is drawn and again the moment the answer
     * arrives, which is what makes the item appear without a refresh - and,
     * because it works on the menu the visitor is actually looking at, an item
     * a stale page never carried is created rather than merely un-hidden.
     *
     * It grants nothing either way: the dashboard asks the database the same
     * question again when it opens, and every privileged action is refused by
     * the policies on the tables regardless of what any menu shows.
     */
    /**
     * Running inside a native shell - the desktop or the Android app? Neither
     * has the worker that grants entry to the protected dashboard, and neither
     * carries the dashboard.
     *
     * Asked of each shell's own adapter where the page loaded one, and of the
     * shell's bridge itself otherwise. The sign-in, sign-up and password pages
     * load no adapter, and the answer there decides where a successful sign-in
     * goes: asking only the adapters sent the Android app's sign-in to the
     * published site, which Android opens in Chrome.
     */
    function inNativeShell() {
        return Boolean(nativeShellAdapter() || capacitorPlatform() || global.__TAURI_INTERNALS__);
    }

    /** The adapter of the shell this page is running in, where the page loaded one. */
    function nativeShellAdapter() {
        if (global.spotifieIOS && global.spotifieIOS.isIOS()) return global.spotifieIOS;
        if (global.spotifieAndroid && global.spotifieAndroid.isAndroid()) return global.spotifieAndroid;
        if (global.spotifieDesktop && global.spotifieDesktop.isDesktop()) return global.spotifieDesktop;
        return null;
    }

    /**
     * 'android' or 'ios' inside one of the phone apps, from Capacitor's bridge -
     * which each app puts into every one of its pages - or null anywhere else.
     */
    function capacitorPlatform() {
        const bridge = global.Capacitor;
        try {
            if (!bridge || typeof bridge.isNativePlatform !== 'function' || !bridge.isNativePlatform()) return null;
            const platform = typeof bridge.getPlatform === 'function' ? bridge.getPlatform() : null;
            return platform === 'android' || platform === 'ios' ? platform : null;
        } catch (e) {
            return null;
        }
    }

    function applyAdminUI() {
        if (typeof document === 'undefined') return;

        // Idempotent: guarantees the one delegated click handler exists as soon
        // as anything renders the header, even on a page that never called
        // initAuthUI.
        wireAdminEntry();

        const user = currentSession ? currentSession.user : null;
        const verified = Boolean(user && adminAnswer.userId === user.id && adminAnswer.verified === true);

        // Made only for an account that has proven itself; anyone else who has
        // an item has it hidden, and nobody else has one made. The same rule
        // everywhere: a native shell does not carry the dashboard, but it
        // opens the protected one (see enterAdmin), so the item is offered
        // there too.
        const item = verified ? ensureDashboardItem() : findDashboardItem();
        if (!item) return;

        setDisplay(item, verified ? 'flex' : 'none');
        markAdminRouteActive(item);

        if (verified) maybeEnterAdminFromLink();
    }

    /**
     * Open the dashboard when the page was opened for that purpose.
     *
     * A native shell opens the published site with ?admin=enter so that an
     * administrator lands in the dashboard rather than on the library. Only
     * ever acted on once, only for an account the database has just confirmed
     * is an administrator, and through the same entry the menu item uses - the
     * worker still verifies the session itself before serving anything.
     */
    let adminLinkHandled = false;

    function maybeEnterAdminFromLink() {
        if (adminLinkHandled || inNativeShell()) return;
        adminLinkHandled = true;

        let params;
        try {
            params = new URLSearchParams(global.location && global.location.search ? global.location.search : '');
        } catch (e) {
            return;
        }
        if (params.get('admin') !== 'enter') return;

        // The request is spent: it is taken out of the address so a reload
        // does not ask again.
        params.delete('admin');
        try {
            const rest = params.toString();
            global.history.replaceState(
                global.history.state,
                '',
                global.location.pathname + (rest ? '?' + rest : '') + (global.location.hash || '')
            );
        } catch (e) {
            /* the address stays as it was; nothing else depends on it */
        }

        enterAdmin();
    }

    /**
     * Highlight the admin item only when the browser is on its route.
     *
     * Being an administrator is why the item is shown; it is not why it is
     * highlighted. The green, active state belongs to /admin-dashboard, so on
     * the index page - where the visitor is while the item is only offered - it
     * reads like every other item, and it lights up only once the dashboard is
     * the page.
     */
    function markAdminRouteActive(item) {
        if (!item || !item.classList) return;

        const route = item.getAttribute ? item.getAttribute('data-route') || '/admin-dashboard' : '/admin-dashboard';
        const path = typeof window !== 'undefined' && window.location ? window.location.pathname : '';
        const onRoute = path === route;

        if (onRoute) item.classList.add('active');
        else item.classList.remove('active');
    }

    /**
     * Wire the shared header controls: user menu, logout and profile modal
     * hooks. Safe to call on any page; missing elements are ignored.
     */
    function initAuthUI() {
        const userMenuBtn = document.getElementById('userMenuBtn');
        const userDropdown = document.getElementById('userDropdown');

        if (userMenuBtn && userDropdown) {
            userMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = userDropdown.classList.toggle('active');
                userMenuBtn.setAttribute('aria-expanded', isOpen);
            });

            document.addEventListener('click', (e) => {
                if (!userMenuBtn.contains(e.target) && !userDropdown.contains(e.target)) {
                    userDropdown.classList.remove('active');
                    userMenuBtn.setAttribute('aria-expanded', 'false');
                }
            });
        }

        document.querySelectorAll('#logoutBtn, #profileLogoutBtn, [data-auth="logout"]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                await signOut();
                // Back to the application, at the address the application has.
                global.location.replace(homeUrl());
            });
        });

        // One delegated handler for the admin item, on the document, whatever
        // the menu does with the item afterwards.
        wireAdminEntry();

        renderAuthUI();
    }

    function onAuthChange(listener) {
        listeners.add(listener);
        if (currentSession !== null) {
            try {
                listener(currentSession, 'CURRENT');
            } catch (e) {
                console.error('Auth listener failed:', e);
            }
        }
        return () => listeners.delete(listener);
    }

    /**
     * Send the visitor away unless they have a real session (and, optionally,
     * admin rights). Returns the session when access is allowed.
     */
    async function requireSession(options) {
        const settings = options || {};
        await ready();
        const session = await getSession();

        if (!session) {
            global.location.replace(settings.redirectTo || appUrlFor('/signin.html'));
            return null;
        }

        if (settings.admin) {
            const admin = await isAdmin();
            if (!admin) {
                global.location.replace(settings.deniedRedirectTo || homeUrl());
                return null;
            }
        }

        return session;
    }

    // Legacy session keys are dropped as early as possible so nothing stale
    // can be mistaken for a login.
    purgeLegacyAuthStorage();

    /**
     * Say, in the console, why the dashboard sent the visitor back.
     *
     * The worker gate cannot leave a message in the console of the page it
     * redirected away from - that console is wiped by the navigation - so it
     * puts the reason in the address it sends the visitor to. This reads it,
     * reports it, and takes it back out of the address so it does not linger or
     * get shared.
     */
    function reportAdminDenial() {
        try {
            if (!global.location || !global.location.search) return;
            const params = new URLSearchParams(global.location.search);
            const reason = params.get('ad');
            if (!reason) return;

            console.warn('[admin-route] denied by server: ' + reason);

            if (global.history && global.history.replaceState) {
                params.delete('ad');
                const query = params.toString();
                global.history.replaceState(
                    null,
                    '',
                    global.location.pathname + (query ? '?' + query : '') + (global.location.hash || '')
                );
            }
        } catch (e) {
            /* the reason is a convenience; failing to read it changes nothing */
        }
    }

    reportAdminDenial();

    document.addEventListener('DOMContentLoaded', () => {
        getClient().catch((err) => {
            console.error('Authentication unavailable:', err);
        });
    });

    global.spotifieAuth = {
        ready,
        getClient,
        tryGetClient,
        getConfigError,
        getSession,
        getUser,
        getAccessToken,
        authorizedFetch,
        enterAdmin,
        getProfile,
        isAdmin,
        signUp,
        signIn,
        signOut,
        resetPassword,
        updatePassword,
        waitForRecoverySession,
        isRecoveryMode,
        onAuthChange,
        requireSession,
        renderAuthUI,
        initAuthUI,
        clearProfileCache,
        // Where the application is, for the pages that send people back to it.
        homeUrl,
        siteUrlFor
    };
})(typeof window !== 'undefined' ? window : globalThis);
