'use strict';

/**
 * Deleting an account, and the two things that must never go wrong with it.
 *
 * The first is authority: a client may ask for *its own* account to be
 * deleted and nothing else. There is deliberately no way to name an account,
 * anywhere in the path, because the surest way to refuse to delete somebody
 * else's account is to have no way of saying whose to delete. The identity
 * comes from a token Supabase verified, inside an Edge Function, using a
 * privileged key that exists only there.
 *
 * The second is blast radius. Deleting an account deletes an account. It does
 * not touch a single file belonging to the person - not their music, not the
 * folder they granted, not anything on the device. Nothing in this path calls
 * a delete on a filesystem, and these tests hold that.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function source(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const CLIENT = source('js', 'deleteAccount.js');
const FUNCTION = source('supabase', 'functions', 'delete-account', 'index.ts');
const PAGE = source('delete-account.html');
const INDEX = source('index.html');
const ABOUT = source('about.html');
const SIGNIN = source('signin.html');
const SQL = source('supabase-setup.sql');

/**
 * The client module, with a Supabase client and a session that behave however
 * a test needs them to.
 */
function loadClient(options) {
    const settings = options || {};
    const calls = { invoked: [], signedOut: 0 };

    const client = {
        functions: {
            invoke(name, payload) {
                calls.invoked.push({ name: name, payload: payload });
                if (settings.throws) return Promise.reject(settings.throws);
                return Promise.resolve(settings.answer || { data: { deleted: true }, error: null });
            }
        }
    };

    const sandbox = {
        console: { warn() {}, error() {}, log() {} },
        Promise,
        String,
        Object
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.spotifieAuth = {
        tryGetClient: () => Promise.resolve(settings.noClient ? null : client),
        getSession: () => Promise.resolve(settings.noSession ? null : { user: { id: 'the-signed-in-user' } }),
        signOut: () => {
            calls.signedOut += 1;
            return Promise.resolve({ success: true });
        }
    };

    vm.createContext(sandbox);
    vm.runInContext(CLIENT, sandbox);

    return { api: sandbox.spotifieDeleteAccount, calls: calls };
}

// ============================================
// Authority: only ever your own account
// ============================================

test('the request names no account, because it has no way to name one', async () => {
    const { api, calls } = loadClient();
    const result = await api.deleteAccount();

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls.invoked.length, 1);
    assert.strictEqual(calls.invoked[0].name, 'delete-account');

    // An empty body. Not a user id, not an email, not a "confirm" flag that a
    // server might trust. Compared by shape: the object was made inside the
    // sandbox, so it is not the same Object as this realm's.
    const payload = calls.invoked[0].payload;
    assert.deepStrictEqual(Object.keys(payload), ['body']);
    assert.deepStrictEqual(Object.keys(payload.body), [], 'nothing is sent with the request');

    // And nothing in the module can put one there.
    assert.ok(!/user_?[Ii]d|userId|uid|email/.test(CLIENT.replace(/\*[\s\S]*?\*\//g, '')), 'no identity is assembled client-side');
});

test('the function takes who is asking from a token Supabase verified', () => {
    // The bearer token is passed to Supabase and the user comes back from it.
    assert.match(FUNCTION, /request\.headers\.get\('Authorization'\)/);
    assert.match(FUNCTION, /auth\.getUser\(\)/);
    assert.match(FUNCTION, /const userId = caller\.user\.id;/);

    // The account deleted is that one, and only that one.
    assert.match(FUNCTION, /admin\.deleteUser\(userId\)/);

    // Nothing is ever read out of the request body: there is no req.json(),
    // no body parsing, no id taken from the caller.
    assert.ok(!/request\.json\(\)|await request\.text\(\)|body\.(user|id)/.test(FUNCTION), 'the body is never read for identity');
});

test('a missing or unusable token is refused before anything is deleted', () => {
    assert.match(FUNCTION, /if \(!authorization\.startsWith\('Bearer '\)\)/);
    assert.match(FUNCTION, /return reply\(401/);

    const refusal = FUNCTION.indexOf("startsWith('Bearer ')");
    const deletion = FUNCTION.indexOf('admin.deleteUser');
    assert.ok(refusal !== -1 && deletion > refusal, 'the check comes first');
});

// ============================================
// The privileged key lives in exactly one place
// ============================================

test('no privileged key appears in anything a browser or a phone receives', () => {
    [
        ['js/deleteAccount.js', CLIENT],
        ['delete-account.html', PAGE],
        ['index.html', INDEX]
    ].forEach(([name, text]) => {
        assert.ok(!/service_role|SERVICE_ROLE|sb_secret_/.test(text), name + ' names no privileged key');
    });

    // It exists only inside the Edge Function, and only from its environment.
    assert.match(FUNCTION, /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
    assert.ok(!/SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"][A-Za-z0-9._-]{10,}/.test(FUNCTION), 'and is never written down');
});

test('the function never tells the caller what went wrong inside it', () => {
    // The reason goes to the log; the caller gets something to act on.
    assert.match(FUNCTION, /console\.error\('delete-account failed/);
    assert.match(FUNCTION, /error: 'Your account could not be deleted right now\. Please try again\.'/);

    // No database detail, token or stack is ever put in a reply.
    const replies = FUNCTION.match(/reply\(\d+, \{[^}]*\}\)/g) || [];
    replies.forEach((reply) => {
        assert.ok(!/deleteError\.message|lookupError|error\.stack|authorization/.test(reply), 'nothing internal in: ' + reply);
    });
});

// ============================================
// What deletion touches, and what it must not
// ============================================

test('deleting an account deletes an account, and never a file', () => {
    // Not the person's music, not the folder they granted, not anything on
    // the device. Neither the client nor the function may even be able to.
    [
        ['js/deleteAccount.js', CLIENT],
        ['the Edge Function', FUNCTION]
    ].forEach(([name, text]) => {
        assert.ok(!/deleteDocument|deleteFile|removeDir|unlink|rmdir|rm\(|fs\./.test(text), name + ' deletes no file');
        assert.ok(!/Filesystem|MusicFolders|forgetFolder|SAF/.test(text), name + ' touches no folder grant');
    });

    // The page says so too, because it is the part a person reads.
    assert.match(PAGE, /Music on your own device is not touched|not delete the music on your device|is not deleted/i);
});

test('the database removes the profile and any admin rights with the account', () => {
    // Not a list of blind DELETEs: the relationships do it, so a row cannot be
    // missed and nothing else can be caught by mistake.
    assert.match(SQL, /id UUID PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
    assert.match(SQL, /user_id UUID PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/);

    // The function relies on that rather than issuing its own deletes.
    assert.ok(!/DELETE FROM|\.delete\(\)/.test(FUNCTION), 'no hand-written row deletion');
    assert.match(FUNCTION, /CASCADE/, 'and it says which rules it is relying on');
});

// ============================================
// Signing out, and not signing out
// ============================================

test('a deletion that worked signs the person out', async () => {
    const { api, calls } = loadClient();
    const result = await api.deleteAccount();

    assert.strictEqual(result.success, true);
    assert.strictEqual(calls.signedOut, 1, 'the session is worthless now, so it goes');
});

test('a deletion that failed leaves the person signed in', async () => {
    const failed = loadClient({ answer: { data: null, error: { message: 'boom', status: 500 } } });
    const result = await failed.api.deleteAccount();

    assert.strictEqual(result.success, false);
    assert.strictEqual(failed.calls.signedOut, 0, 'being thrown out of an account that still exists is its own disaster');
    assert.ok(result.error, 'and they are told');

    const threw = loadClient({ throws: new Error('Failed to fetch') });
    const network = await threw.api.deleteAccount();
    assert.strictEqual(network.success, false);
    assert.strictEqual(threw.calls.signedOut, 0);
    assert.match(network.error, /connection/i, 'a network failure says so');
});

test('an expired session is refused before anything is asked of the server', async () => {
    const { api, calls } = loadClient({ noSession: true });
    const result = await api.deleteAccount();

    assert.strictEqual(result.success, false);
    assert.match(result.error, /session has expired/i);
    assert.strictEqual(calls.invoked.length, 0, 'nothing was asked');
    assert.strictEqual(calls.signedOut, 0);
});

test('what a person is shown never carries a status code or a server s words', () => {
    const { api } = loadClient();
    [
        { status: 401 },
        { status: 403 },
        { status: 404 },
        { status: 500, message: 'PGRST301: JWT expired at 1723' },
        { message: 'TypeError: Failed to fetch' }
    ].forEach((error) => {
        const said = api._readable(error);
        assert.ok(!/\d{3}|JWT|PGRST|TypeError|stack/i.test(said), 'readable: ' + said);
        assert.ok(said.length > 10, 'and says something useful');
    });
});

// ============================================
// Confirmation
// ============================================

test('deletion needs the word typed, in any case, and refuses anything else', () => {
    const { api } = loadClient();

    assert.strictEqual(api.CONFIRMATION, 'DELETE');
    ['DELETE', 'delete', ' Delete ', 'dElEtE'].forEach((typed) => {
        assert.strictEqual(api.confirms(typed), true, JSON.stringify(typed));
    });
    ['', ' ', 'D', 'delete my account', 'yes', null, undefined].forEach((typed) => {
        assert.strictEqual(api.confirms(typed), false, JSON.stringify(typed));
    });
});

test('neither the page nor the app can delete without the confirmation', () => {
    // Both ask the same helper, and both start with the button disabled.
    assert.match(PAGE, /deleter\.confirms\(/);
    assert.match(PAGE, /id="deleteBtn"[^>]*disabled/);

    assert.match(INDEX, /deleter\.confirms\(/);
    assert.match(INDEX, /id="deleteAccountConfirm"[^>]*disabled/);
});

// ============================================
// The two ways in
// ============================================

test('the website has a deletion page that needs nothing installed', () => {
    const builder = require('../tools/buildPublic.js');
    assert.ok(builder.PAGES.indexOf('delete-account.html') !== -1, 'the page is part of the release');
    assert.ok(builder.BROWSER_SCRIPTS.indexOf('js/deleteAccount.js') !== -1, 'and so is the code it uses');
});

test('opening the deletion page signed out asks the person to sign in, and brings them back', () => {
    assert.match(PAGE, /Sign in to delete your account/);
    assert.match(PAGE, /signin\.html\?next=%2Fdelete-account\.html/);

    // And the sign-in page will only return somebody to a page it knows by
    // name - never to wherever a link happens to say.
    assert.match(SIGNIN, /const RETURN_PAGES = \['\/delete-account\.html'\];/);
    assert.match(SIGNIN, /RETURN_PAGES\.indexOf\(asked\) !== -1 \? asked : null/);
});

test('the deletion page can be used with a keyboard and read by a screen reader', () => {
    assert.match(PAGE, /<h1>Delete your Spotifie account<\/h1>/);
    assert.match(PAGE, /<label class="account-field" for="confirmWord">/);
    assert.match(PAGE, /id="confirmWord"/);
    assert.match(PAGE, /role="alert"/);
    assert.match(PAGE, /:focus-visible/, 'what is focused is visible');

    // The dangerous action says what it is, so colour is not the only signal.
    assert.match(PAGE, /Permanently delete my account/);
});

test('the app offers deletion under the profile, and a guest never sees it', () => {
    assert.match(INDEX, /id="profileDeleteAccount"/);
    assert.match(INDEX, /id="profilePrivacyLink"/);

    // It lives in the profile dialog, and that dialog refuses to open without
    // a session - so there is no path to it for somebody signed out.
    const opening = INDEX.slice(INDEX.indexOf('async function openProfileModal()'), INDEX.indexOf('function closeProfileModal()'));
    assert.match(opening, /const session = await window\.spotifieAuth\.getSession\(\);\s*if \(!session\) return;/);
});

// ============================================
// What the public pages say
// ============================================

test('the privacy page describes the product as it is now, and links deletion', () => {
    // The old copy described a local Node server streaming the audio, which is
    // not what the Android app does.
    assert.ok(!/streamed by the local server/.test(ABOUT), 'the obsolete local-server description is gone');
    assert.ok(!/indexed and played by the Spotifie server running on your own machine/.test(ABOUT));

    assert.match(ABOUT, /Android's own folder picker/);
    assert.match(ABOUT, /short-lived signed links/);
    assert.match(ABOUT, /Cloudflare hosts the website/);
    assert.match(ABOUT, /no advertising identifier|no location, camera, microphone or contacts/i);

    // And it points at the page somebody can actually use.
    assert.match(ABOUT, /href="delete-account\.html"/);
    assert.match(ABOUT, /Deleting Your Account/);
    assert.match(ABOUT, /does not delete the music on your device/i);
});
