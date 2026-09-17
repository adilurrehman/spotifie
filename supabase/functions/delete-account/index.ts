// Delete the account of whoever is calling, and nobody else.
//
// This is the one piece of Spotifie that needs administrative rights over
// Supabase Auth, so it is the one piece that runs where a privileged key can
// exist: inside a Supabase Edge Function. That key is read from the function's
// own environment, which Supabase populates. It is never sent to a browser,
// never put in the Android app, never given to Cloudflare, and never written
// into this repository.
//
// The account that gets deleted is decided here, from a token Supabase itself
// verified - not from anything the caller sent in the body. A request may not
// name a user. There is deliberately no code path that reads a user id from
// the request, because the safest way to refuse to delete somebody else's
// account is to have no way of saying which account to delete.
//
// What deleting the auth user takes with it, by the database's own rules:
//
//   public.profiles.id    REFERENCES auth.users(id) ON DELETE CASCADE
//   public.app_admins.user_id REFERENCES auth.users(id) ON DELETE CASCADE
//
// So the profile row goes, and any administrator grant goes with it - no
// orphan, and no administrator authority surviving the account it belonged to.
// Nothing here issues a blind DELETE.
//
// What it does not touch, ever: a person's own music. Their files, the folder
// they granted through Android's picker, and everything else on their device
// are theirs. This function has no reach outside Supabase, and that is
// deliberate.
//
// Deploy with:  supabase functions deploy delete-account

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

/** One answer shape, so the caller never has to read a status code to know. */
function reply(status: number, body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' }
    });
}

Deno.serve(async (request: Request) => {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (request.method !== 'POST') return reply(405, { error: 'Method not allowed' });

    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!url || !anonKey || !serviceKey) {
        // Said without naming which one is missing: a misconfiguration should
        // not describe the shape of the configuration to whoever is asking.
        console.error('delete-account is not configured');
        return reply(500, { error: 'Account deletion is unavailable right now.' });
    }

    // Who is calling. The token is verified by Supabase, not parsed here, and
    // the identity it yields is the only identity this function will act on.
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) {
        return reply(401, { error: 'Sign in again to delete your account.' });
    }

    const asCaller = createClient(url, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: caller, error: lookupError } = await asCaller.auth.getUser();
    if (lookupError || !caller?.user) {
        return reply(401, { error: 'Your session has expired. Sign in again to delete your account.' });
    }

    const userId = caller.user.id;

    // Administrative rights, used for exactly one thing: deleting the account
    // the verified token belongs to.
    const asService = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    const { error: deleteError } = await asService.auth.admin.deleteUser(userId);

    if (deleteError) {
        // Already gone is the outcome the caller wanted.
        const message = String(deleteError.message || '');
        if (/not found/i.test(message) || (deleteError as { status?: number }).status === 404) {
            return reply(200, { deleted: true, alreadyGone: true });
        }

        // The reason goes to the function's log, never to the caller: it can
        // carry database detail, and none of that is a user's business.
        console.error('delete-account failed for a verified user:', message);
        return reply(500, { error: 'Your account could not be deleted right now. Please try again.' });
    }

    return reply(200, { deleted: true });
});
