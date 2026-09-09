'use strict';

/**
 * Auth module tests.
 *
 * js/auth.js is browser code, so it runs here inside a small stub of the
 * browser globals it uses, with a fake Supabase client. That keeps the
 * session rules testable without a live Supabase project.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AUTH_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');

function makeStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        clear: () => map.clear(),
        _map: map
    };
}

function makeDocument() {
    return {
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null
    };
}

/** Minimal fake of the parts of the Supabase client auth.js uses. */
function makeSupabaseStub(options) {
    const settings = options || {};
    const state = {
        session: settings.session || null,
        admins: settings.admins || [],
        profiles: settings.profiles || {},
        signUpResult: settings.signUpResult || null,
        signInResult: settings.signInResult || null,
        updateUserCalls: [],
        signOutCalls: 0,
        resetCalls: []
    };
    const listeners = [];

    function emit(event) {
        listeners.forEach((listener) => listener(event, state.session));
    }

    const client = {
        auth: {
            async getSession() {
                return { data: { session: state.session }, error: null };
            },
            async getUser() {
                return {
                    data: { user: state.session ? state.session.user : null },
                    error: state.session ? null : { message: 'no session' }
                };
            },
            onAuthStateChange(callback) {
                listeners.push(callback);
                return { data: { subscription: { unsubscribe() {} } } };
            },
            async signUp() {
                return state.signUpResult;
            },
            async signInWithPassword() {
                const result = state.signInResult;
                if (result && result.data && result.data.session) {
                    state.session = result.data.session;
                    emit('SIGNED_IN');
                }
                return result;
            },
            async signOut() {
                state.signOutCalls += 1;
                state.session = null;
                emit('SIGNED_OUT');
                return { error: null };
            },
            async resetPasswordForEmail(email, opts) {
                state.resetCalls.push({ email, opts });
                return { error: null };
            },
            async updateUser(payload) {
                state.updateUserCalls.push(payload);
                return { error: null };
            }
        },
        from(table) {
            const builder = {
                _table: table,
                _id: null,
                select() {
                    return builder;
                },
                eq(column, value) {
                    builder._id = value;
                    return builder;
                },
                async maybeSingle() {
                    if (builder._table === 'app_admins') {
                        return {
                            data: state.admins.includes(builder._id) ? { user_id: builder._id } : null,
                            error: null
                        };
                    }
                    if (builder._table === 'profiles') {
                        return { data: state.profiles[builder._id] || null, error: null };
                    }
                    return { data: null, error: null };
                },
                async upsert(row) {
                    if (builder._table === 'profiles') {
                        state.profiles[row.id] = row;
                    } else {
                        throw new Error('writes to ' + builder._table + ' are not allowed');
                    }
                    return { data: row, error: null };
                }
            };
            return builder;
        },
        _state: state,
        _setSession(session, event) {
            state.session = session;
            emit(event || 'SIGNED_IN');
        }
    };

    return client;
}

async function loadAuth(options) {
    const client = makeSupabaseStub(options);
    const localStorageStub = makeStorage();
    const sessionStorageStub = makeStorage();

    if (options && options.seedStorage) {
        Object.keys(options.seedStorage).forEach((key) => {
            localStorageStub.setItem(key, options.seedStorage[key]);
        });
    }
    if (options && options.seedSessionStorage) {
        Object.keys(options.seedSessionStorage).forEach((key) => {
            sessionStorageStub.setItem(key, options.seedSessionStorage[key]);
        });
    }

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        localStorage: localStorageStub,
        sessionStorage: sessionStorageStub,
        document: makeDocument(),
        location: { origin: 'http://127.0.0.1:3000', href: '' },
        supabase: { createClient: () => client },
        fetch: (options && options.fetch) || (async () => ({
            ok: true,
            status: 200,
            json: async () => ({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key' })
        }))
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(AUTH_SOURCE, sandbox);

    await sandbox.spotifieAuth.ready();

    return {
        auth: sandbox.spotifieAuth,
        client,
        localStorage: localStorageStub,
        sessionStorage: sessionStorageStub,
        sandbox
    };
}

function makeSession(id, email, username) {
    return {
        access_token: 'token-' + id,
        user: {
            id: id,
            email: email,
            user_metadata: username ? { username: username } : {},
            created_at: '2024-01-01T00:00:00Z'
        }
    };
}

test('stale storage cannot fake a session and is purged', async () => {
    const context = await loadAuth({
        session: null,
        seedStorage: {
            spotifie_user: JSON.stringify({ id: 'fake', email: 'attacker@example.com', username: 'Hacker' }),
            spotifie_profile_cache: JSON.stringify({ id: 'fake', username: 'Hacker' })
        },
        seedSessionStorage: {
            spotifie_admin: JSON.stringify({ email: 'attacker@example.com' })
        }
    });

    const session = await context.auth.getSession();
    assert.strictEqual(session, null, 'no session without Supabase');
    assert.strictEqual(context.localStorage.getItem('spotifie_user'), null);
    assert.strictEqual(context.localStorage.getItem('spotifie_profile_cache'), null);
    assert.strictEqual(context.sessionStorage.getItem('spotifie_admin'), null);
    assert.strictEqual(await context.auth.isAdmin(), false);
});

test('signup without a session reports that confirmation is needed', async () => {
    const context = await loadAuth({
        session: null,
        signUpResult: { data: { user: { id: 'u1', email: 'new@example.com' }, session: null }, error: null }
    });

    const result = await context.auth.signUp('new@example.com', 'password123', 'newbie');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.needsConfirmation, true);

    // An unconfirmed signup is not a login.
    assert.strictEqual(await context.auth.getSession(), null);
    assert.strictEqual(context.localStorage.getItem('spotifie_profile_cache'), null);
});

test('signup that returns a session is signed in and caches the profile', async () => {
    const session = makeSession('u2', 'auto@example.com', 'auto');
    const context = await loadAuth({
        session: null,
        signUpResult: { data: { user: session.user, session: session }, error: null }
    });

    context.client._setSession(session, 'SIGNED_IN');
    const result = await context.auth.signUp('auto@example.com', 'password123', 'auto');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.needsConfirmation, false);
    const cached = JSON.parse(context.localStorage.getItem('spotifie_profile_cache'));
    assert.strictEqual(cached.id, 'u2');
});

test('signup validates username and password before calling Supabase', async () => {
    const context = await loadAuth({ session: null });
    assert.strictEqual((await context.auth.signUp('a@b.c', 'password123', 'x')).success, false);
    assert.strictEqual((await context.auth.signUp('a@b.c', 'short', 'valid')).success, false);
});

test('sign in stores the profile and sign out clears session state', async () => {
    const session = makeSession('u3', 'user@example.com', 'user3');
    const context = await loadAuth({
        session: null,
        signInResult: { data: { user: session.user, session: session }, error: null },
        profiles: { u3: { username: 'user3' } }
    });

    const result = await context.auth.signIn('user@example.com', 'password123');
    assert.strictEqual(result.success, true);

    const cached = JSON.parse(context.localStorage.getItem('spotifie_profile_cache'));
    assert.strictEqual(cached.username, 'user3');

    await context.auth.signOut();
    assert.strictEqual(context.client._state.signOutCalls, 1, 'the Supabase session is invalidated');
    assert.strictEqual(context.localStorage.getItem('spotifie_profile_cache'), null);
    assert.strictEqual(await context.auth.getSession(), null);
});

test('sign in without a session (unconfirmed account) fails', async () => {
    const context = await loadAuth({
        session: null,
        signInResult: { data: { user: { id: 'u4' }, session: null }, error: null }
    });

    const result = await context.auth.signIn('unconfirmed@example.com', 'password123');
    assert.strictEqual(result.success, false);
    assert.match(result.error, /confirm/i);
});

test('switching accounts never inherits the previous user cached state', async () => {
    const first = makeSession('user-a', 'a@example.com', 'AAA');
    const second = makeSession('user-b', 'b@example.com', 'BBB');

    const context = await loadAuth({
        session: null,
        signInResult: { data: { user: first.user, session: first }, error: null },
        profiles: { 'user-a': { username: 'AAA' }, 'user-b': { username: 'BBB' } }
    });

    await context.auth.signIn('a@example.com', 'password123');
    assert.strictEqual(JSON.parse(context.localStorage.getItem('spotifie_profile_cache')).id, 'user-a');

    await context.auth.signOut();
    assert.strictEqual(context.localStorage.getItem('spotifie_profile_cache'), null);

    context.client._state.signInResult = { data: { user: second.user, session: second }, error: null };
    await context.auth.signIn('b@example.com', 'password123');

    const cached = JSON.parse(context.localStorage.getItem('spotifie_profile_cache'));
    assert.strictEqual(cached.id, 'user-b');
    assert.strictEqual(cached.username, 'BBB');
});

test('a session for a different user discards the cached profile', async () => {
    const first = makeSession('user-a', 'a@example.com', 'AAA');
    const second = makeSession('user-b', 'b@example.com', 'BBB');

    const context = await loadAuth({ session: first, profiles: { 'user-a': { username: 'AAA' } } });
    await context.auth.getProfile();
    assert.strictEqual(JSON.parse(context.localStorage.getItem('spotifie_profile_cache')).id, 'user-a');

    context.client._setSession(second, 'SIGNED_IN');
    assert.strictEqual(context.localStorage.getItem('spotifie_profile_cache'), null);
});

test('admin status comes from app_admins and only for the signed-in id', async () => {
    const session = makeSession('admin-1', 'admin@example.com', 'admin');

    const nonAdmin = await loadAuth({ session: session, admins: [] });
    assert.strictEqual(await nonAdmin.auth.isAdmin(), false);

    const admin = await loadAuth({ session: session, admins: ['admin-1'] });
    assert.strictEqual(await admin.auth.isAdmin(), true);

    // Another user's id is never queried, so it cannot grant admin rights.
    const other = await loadAuth({ session: makeSession('user-x', 'x@example.com', 'x'), admins: ['admin-1'] });
    assert.strictEqual(await other.auth.isAdmin(), false);
});

test('a user cannot write an admin row through the client', async () => {
    const context = await loadAuth({ session: makeSession('user-y', 'y@example.com', 'y'), admins: [] });
    const client = await context.auth.getClient();

    await assert.rejects(
        () => client.from('app_admins').upsert({ user_id: 'user-y' }),
        /not allowed/,
        'admin rows are not writable from the browser'
    );
    assert.strictEqual(await context.auth.isAdmin(), false);
});

test('password update requires a real recovery session', async () => {
    const withoutSession = await loadAuth({ session: null });
    const denied = await withoutSession.auth.updatePassword('newpassword');
    assert.strictEqual(denied.success, false);
    assert.match(denied.error, /invalid or has expired/i);
    assert.strictEqual(withoutSession.client._state.updateUserCalls.length, 0);

    const withSession = await loadAuth({ session: makeSession('u5', 'r@example.com', 'r') });
    const allowed = await withSession.auth.updatePassword('newpassword');
    assert.strictEqual(allowed.success, true);
    assert.strictEqual(withSession.client._state.updateUserCalls.length, 1);

    const tooShort = await withSession.auth.updatePassword('abc');
    assert.strictEqual(tooShort.success, false);
});

test('password recovery emails point at the reset page', async () => {
    const context = await loadAuth({ session: null });
    const result = await context.auth.resetPassword('someone@example.com');
    assert.strictEqual(result.success, true);
    const call = context.client._state.resetCalls[0];
    assert.strictEqual(call.email, 'someone@example.com');
    assert.match(call.opts.redirectTo, /\/reset-password\.html$/);
});

test('waitForRecoverySession resolves with a session and times out without one', async () => {
    const withSession = await loadAuth({ session: makeSession('u6', 'rec@example.com', 'rec') });
    assert.ok(await withSession.auth.waitForRecoverySession(500));

    const withoutSession = await loadAuth({ session: null });
    assert.strictEqual(await withoutSession.auth.waitForRecoverySession(400), null);
});

test('an existing account with no profile row gets one created safely', async () => {
    const session = makeSession('legacy-1', 'legacy@example.com', 'legacy');
    const context = await loadAuth({ session: session, profiles: {} });

    const profile = await context.auth.getProfile();
    assert.strictEqual(profile.id, 'legacy-1');
    assert.strictEqual(profile.username, 'legacy');
    assert.strictEqual(context.client._state.profiles['legacy-1'].username, 'legacy');
});

test('authorizedFetch attaches the access token only when signed in', async () => {
    const signedOut = await loadAuth({ session: null });
    let seen = null;
    signedOut.sandbox.fetch = async (url, init) => {
        seen = init;
        return { ok: true, json: async () => ({}) };
    };
    await signedOut.auth.authorizedFetch('/api/library/rescan', { method: 'POST' });
    assert.strictEqual(seen.headers.Authorization, undefined);

    const signedIn = await loadAuth({ session: makeSession('u7', 'z@example.com', 'z') });
    signedIn.sandbox.fetch = async (url, init) => {
        seen = init;
        return { ok: true, json: async () => ({}) };
    };
    await signedIn.auth.authorizedFetch('/api/library/rescan', { method: 'POST' });
    assert.strictEqual(seen.headers.Authorization, 'Bearer token-u7');
});

test('a missing config endpoint reports a configuration error, not a login failure', async () => {
    const context = await loadAuth({
        session: null,
        fetch: async () => ({ ok: false, status: 404, json: async () => ({}) })
    });

    const error = context.auth.getConfigError();
    assert.ok(error, 'the configuration failure is recorded');

    // Neither place had the settings - not the local server, and not the file
    // a published copy carries - so what is reported is the thing to do about
    // it rather than which of the two was asked first.
    assert.match(error, /Supabase is not configured/);
    assert.match(error, /SUPABASE_URL/);
    assert.match(error, /npm start/);

    // Every action reports the same configuration problem instead of a
    // misleading "invalid email or password".
    const signIn = await context.auth.signIn('user@example.com', 'password123');
    assert.strictEqual(signIn.success, false);
    assert.strictEqual(signIn.error, error);

    const signUp = await context.auth.signUp('user@example.com', 'password123', 'user');
    assert.strictEqual(signUp.success, false);
    assert.strictEqual(signUp.error, error);

    const reset = await context.auth.resetPassword('user@example.com');
    assert.strictEqual(reset.success, false);
    assert.strictEqual(reset.error, error);

    const update = await context.auth.updatePassword('newpassword');
    assert.strictEqual(update.success, false);
    assert.strictEqual(update.error, error);

    // The app still renders, signed out, rather than throwing.
    assert.strictEqual(await context.auth.getSession(), null);
    assert.strictEqual(await context.auth.isAdmin(), false);
    assert.strictEqual(await context.auth.waitForRecoverySession(100), null);
});

test('an unreachable config endpoint explains how to start the app', async () => {
    const context = await loadAuth({
        session: null,
        fetch: async () => {
            throw new Error('Failed to fetch');
        }
    });

    // Nothing answered anywhere: not the local server, not the file a
    // published copy carries. What is reported is what to do - the settings to
    // supply, and how to run it locally - rather than which address failed
    // first, which is of no use to anybody.
    const error = context.auth.getConfigError();
    assert.match(error, /Supabase is not configured/);
    assert.match(error, /SUPABASE_URL/);
    assert.match(error, /npm start/);
});

test('incomplete Supabase settings are rejected with a clear message', async () => {
    const context = await loadAuth({
        session: null,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ supabaseUrl: '' }) })
    });

    assert.match(context.auth.getConfigError(), /SUPABASE_URL and SUPABASE_ANON_KEY/);
});

test('a failed configuration load is retried rather than cached forever', async () => {
    let fail = true;
    const context = await loadAuth({
        session: null,
        fetch: async () => {
            if (fail) return { ok: false, status: 404, json: async () => ({}) };
            return {
                ok: true,
                status: 200,
                json: async () => ({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key' })
            };
        }
    });

    assert.ok(context.auth.getConfigError());

    // The server comes back; the next attempt succeeds.
    fail = false;
    const client = await context.auth.tryGetClient();
    assert.ok(client, 'the client is created on retry');
    assert.strictEqual(context.auth.getConfigError(), null);
});

test('a 503 configuration error is reported as a Supabase configuration problem', async () => {
    const context = await loadAuth({
        session: null,
        fetch: async () => ({
            ok: false,
            status: 503,
            json: async () => ({ error: 'Configuration unavailable', detail: 'SUPABASE_URL is not set.' })
        })
    });

    const error = context.auth.getConfigError();
    assert.match(error, /Supabase is not configured/);
    assert.match(error, /SUPABASE_URL/);
});

test('a missing configuration is never reported as a credentials problem', async () => {
    const context = await loadAuth({
        session: null,
        fetch: async () => ({ ok: false, status: 404, json: async () => ({}) })
    });

    const error = context.auth.getConfigError();
    assert.match(error, /Supabase is not configured/);
    assert.match(error, /Live Preview|Live Server/i, 'and still says how to run it locally');
    assert.ok(!/invalid (email|login)/i.test(error), 'it is not reported as a credentials problem');
});

test('a published copy reads its settings from the file beside it', async () => {
    const asked = [];

    const context = await loadAuth({
        session: null,
        fetch: async (url) => {
            asked.push(String(url));

            // No local server, which is what a published copy meets.
            if (String(url).indexOf('/api/config') !== -1) {
                return { ok: false, status: 404, json: async () => ({}) };
            }

            return {
                ok: true,
                status: 200,
                json: async () => ({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key' })
            };
        }
    });

    // The server first, because when there is one it is the authority; the
    // file next, which is where a published copy keeps the same two values.
    assert.ok(asked.some((url) => url.indexOf('/api/config') !== -1), 'the server was asked');
    assert.ok(asked.some((url) => url.indexOf('config.json') !== -1), 'and then the file');

    // And with settings in hand there is no configuration problem at all.
    assert.strictEqual(context.auth.getConfigError(), null);
});
