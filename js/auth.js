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
     * The settings, from whichever of the two places has them.
     *
     * The local server first, because when there is one it is the authority on
     * this installation. A 404 or an unreachable origin is not an error here -
     * it is how a published copy answers, and the file beside the application
     * is asked next. Only when neither has anything is there a problem to
     * report.
     */
    async function loadPublicConfig() {
        const fromServer = await tryConfigSource(CONFIG_URL, { cache: 'no-store' });
        if (fromServer) return fromServer;

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
    async function isAdmin() {
        const session = await getSession();
        if (!session || !session.user) return false;

        const client = await tryGetClient();
        if (!client) return false;

        const { data, error } = await client
            .from('app_admins')
            .select('user_id')
            .eq('user_id', session.user.id)
            .maybeSingle();

        if (error) {
            console.error('Admin lookup failed:', error);
            return false;
        }
        return Boolean(data);
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
                    emailRedirectTo: global.location.origin + '/signin.html'
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
                redirectTo: global.location.origin + '/reset-password.html'
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
        const dashboardLink = document.getElementById('dashboardLink');

        const session = currentSession;
        const user = session ? session.user : null;

        if (authSkeleton) authSkeleton.classList.add('hidden');

        if (!user) {
            setDisplay(signInBtn, '');
            setDisplay(signUpBtn, '');
            setDisplay(userMenu, 'none');
            setDisplay(dashboardLink, 'none');
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
        if (dashboardLink) {
            isAdmin().then((admin) => {
                setDisplay(dashboardLink, admin ? 'flex' : 'none');
            });
        }
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
                global.location.href = 'index.html';
            });
        });

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
            global.location.href = settings.redirectTo || 'signin.html';
            return null;
        }

        if (settings.admin) {
            const admin = await isAdmin();
            if (!admin) {
                global.location.href = settings.deniedRedirectTo || 'index.html';
                return null;
            }
        }

        return session;
    }

    // Legacy session keys are dropped as early as possible so nothing stale
    // can be mistaken for a login.
    purgeLegacyAuthStorage();

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
        clearProfileCache
    };
})(typeof window !== 'undefined' ? window : globalThis);
