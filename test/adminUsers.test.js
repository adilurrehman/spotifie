'use strict';

/**
 * The dashboard's Total Users card.
 *
 * It used to count public.profiles, whose row-level security shows each
 * account only its own row - so every administrator saw "1" however many
 * accounts existed. It now asks admin_user_count(), which counts auth.users
 * for a caller the database trusts as an administrator and returns only that
 * number.
 *
 * The SQL is read where it is written (there is no database in the suite);
 * the dashboard half is run.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase-setup.sql'), 'utf8');
const ADMIN_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'admin.js'), 'utf8');
const DASHBOARD = fs.readFileSync(path.join(ROOT, 'admin-dashboard.html'), 'utf8');

const admin = require('../js/admin.js');

/** The body of admin_user_count(), from CREATE to the closing $$. */
function functionBody() {
    const start = SQL.indexOf('CREATE OR REPLACE FUNCTION public.admin_user_count()');
    assert.ok(start !== -1, 'the function is defined');
    const end = SQL.indexOf('$$;', start);
    return SQL.slice(start, end + 3);
}

// ============================================
// The function
// ============================================

test('admin_user_count() counts auth.users and returns only the number', () => {
    const body = functionBody();

    // No argument: nobody can ask on behalf of anybody else.
    assert.match(body, /FUNCTION public\.admin_user_count\(\)\s*\nRETURNS bigint/);

    // Definer rights are what let it read auth.users; the empty search path
    // means every name inside is qualified and cannot be shadowed.
    assert.match(body, /SECURITY DEFINER/);
    assert.match(body, /SET search_path = ''/);
    assert.match(body, /STABLE/);

    // A count of every registered account - one aggregate, never rows.
    assert.match(body, /RETURN \(\s*SELECT count\(\*\)\s*FROM auth\.users\s*\);/);
    assert.ok(!/SELECT\s+(\*|id|email)\b[^;]*FROM auth\.users/i.test(body), 'no user row is selected');
    assert.ok(!/RETURNS (TABLE|SETOF)/i.test(body), 'it returns a single value');

    // Not profiles, which RLS narrows to the caller's own row.
    assert.ok(!/profiles/.test(body), 'profiles are not what is counted');
});

test('an authenticated non-administrator is refused with 42501', () => {
    const body = functionBody();

    // The check comes before the count, and is about the caller: the zero-arg
    // is_admin() reads auth.uid(), so no id can be supplied.
    assert.match(body, /IF NOT public\.is_admin\(\) THEN\s*RAISE EXCEPTION 'not authorized'\s*USING ERRCODE = '42501';\s*END IF;/);
    assert.ok(body.indexOf('public.is_admin()') < body.indexOf('count(*)'), 'the check comes first');
    assert.ok(!/is_admin\(\s*[a-z_]/i.test(body), 'is_admin is never asked about somebody else');
});

test('anon cannot execute it; only authenticated callers can reach the check', () => {
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.admin_user_count\(\) FROM PUBLIC;/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.admin_user_count\(\) FROM anon;/);
    assert.match(SQL, /REVOKE ALL ON FUNCTION public\.admin_user_count\(\) FROM authenticated;/);
    assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.admin_user_count\(\) TO authenticated;/);

    assert.ok(!/GRANT[^;]*admin_user_count[^;]*TO[^;]*\banon\b/.test(SQL), 'anon is never granted it');
    assert.ok(!/GRANT[^;]*admin_user_count[^;]*TO[^;]*\bPUBLIC\b/i.test(SQL), 'nor is PUBLIC');

    // And nothing else became readable to get there.
    assert.ok(!/GRANT[^;]*ON auth\.users/i.test(SQL), 'auth.users itself is not granted to anybody');
    assert.match(SQL, /CREATE POLICY "Users can view own profile"[\s\S]*?USING \(auth\.uid\(\) = id\);/);
});

// ============================================
// The dashboard
// ============================================

test('the card shows the number the RPC returns', async () => {
    const asked = [];
    const client = {
        rpc(name) {
            asked.push(name);
            return Promise.resolve({ data: 5, error: null });
        }
    };

    assert.strictEqual(await admin.totalRegisteredUsers(client), '5');
    assert.deepStrictEqual(asked, ['admin_user_count'], 'one call, to the admin-only RPC');
});

test('a failed RPC shows a dash, never 0', async () => {
    const warn = console.warn;
    const logged = [];
    console.warn = (...args) => logged.push(args.join(' '));

    try {
        const refused = {
            rpc: () => Promise.resolve({ data: null, error: { code: '42501', message: 'not authorized' } })
        };
        assert.strictEqual(await admin.totalRegisteredUsers(refused), '—');

        const unreachable = {
            rpc: () => Promise.reject(new Error('Failed to fetch'))
        };
        assert.strictEqual(await admin.totalRegisteredUsers(unreachable), '—');
    } finally {
        console.warn = warn;
    }

    assert.ok(logged.every((line) => /Could not load total registered user count/.test(line)));
    assert.ok(!logged.some((line) => /eyJ|Bearer|access_token/i.test(line)), 'no token is logged');
});

test('the old profiles count is gone and the card reads the RPC', () => {
    // Nothing in the dashboard counts profiles any more.
    assert.ok(!/\.from\('profiles'\)/.test(ADMIN_SOURCE), 'profiles are not queried for the metric');
    assert.ok(!/count: 'exact', head: true/.test(ADMIN_SOURCE), 'no head count of any table stands in for it');

    // The card is filled from the RPC.
    assert.match(
        ADMIN_SOURCE,
        /getElementById\('totalUsers'\)\.textContent = await totalRegisteredUsers\(supabaseAdmin\);/
    );
    assert.match(ADMIN_SOURCE, /client\.rpc\('admin_user_count'\)/);

    // The label keeps its name, says what it counts, and starts unknown
    // rather than at a false 0.
    assert.match(DASHBOARD, /<div class="stat-value" id="totalUsers"[^>]*>—<\/div>/);
    assert.match(DASHBOARD, /title="Registered accounts">Total Users<\/div>/);
});
