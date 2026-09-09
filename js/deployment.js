/**
 * Which Spotifie this is, decided once.
 *
 * Spotifie runs in two places, and almost every mistake in getting it onto a
 * static host came from code that could not tell them apart.
 *
 * Run from the server somebody starts themselves, the application and its API
 * are the same origin: /api/config, /api/catalog and /api/library all answer,
 * and asking for them is right. Published to a static host they answer
 * nothing - and a browser that asks anyway spends every page load collecting
 * 404s, then reports that Supabase is not configured because the one endpoint
 * that would have told it otherwise was among them.
 *
 * So the question is asked once, here, from something the build wrote rather
 * than from the address bar. A published copy carries its own settings, says
 * so, and never asks a static host for an API it does not have. Everything
 * else reads the answer.
 *
 * What is in those settings is public by design and nothing more: the Supabase
 * project URL, the anon key that is meant to sit in a browser, and the address
 * the copy was published at. A service-role key, a database password or a JWT
 * secret would each be a catastrophe here, and none of them is ever read,
 * written or accepted - the build refuses to write one and the release check
 * refuses to pass one.
 */
(function (global) {
    'use strict';

    /**
     * The helper on the machine somebody is sitting at.
     *
     * Written out rather than taken from the address bar, and that is the
     * whole point: a page served from a static host has an origin that has
     * nothing to do with anybody's computer, and building a helper address out
     * of it produced requests to workers.dev/api/library/health - a question
     * asked of the wrong machine entirely, answered 404, and repeated.
     *
     * Loopback is the only address a helper is ever at. It never leaves the
     * machine, which is exactly why the music on that machine can be reached
     * through it and by nothing else.
     */
    var LOCAL_HELPER_ORIGIN = 'http://127.0.0.1:3000';

    /** What the build wrote, when the build wrote anything. */
    function published() {
        var settings = global.__SPOTIFIE_CONFIG__;
        return settings && typeof settings === 'object' ? settings : null;
    }

    /**
     * Is this a copy published to a static host?
     *
     * Answered from what the build left behind, never from the hostname. A
     * copy built for publishing says so whatever address it ends up at, and a
     * checkout run locally says nothing - so a developer opening
     * http://127.0.0.1:3000 is a local run even if they put it behind a
     * tunnel, and a published copy is a published copy even on localhost while
     * somebody tests it.
     */
    function isPublished() {
        var settings = published();
        return Boolean(settings && settings.deployment && settings.deployment !== 'local');
    }

    /**
     * Does this origin serve the Spotifie API?
     *
     * The one question the rest of the application asks before reaching for
     * /api/anything. A published copy answers no, and nothing asks.
     */
    function hasLocalApi() {
        return !isPublished();
    }

    /** The public Supabase settings, from the build or from nowhere. */
    function supabase() {
        var settings = published();
        if (!settings) return null;

        if (!settings.supabaseUrl || !settings.supabaseAnonKey) return null;
        return { url: settings.supabaseUrl, anonKey: settings.supabaseAnonKey };
    }

    /** Where this copy was published, or null when it was not published. */
    function siteUrl() {
        var settings = published();
        return (settings && settings.publicSiteUrl) || null;
    }

    /**
     * Where to look for a helper.
     *
     * The same answer in both runtimes, and deliberately: a local run is
     * already on loopback, and a published copy asks loopback rather than the
     * host it was served from.
     */
    function localHelperOrigin() {
        var settings = published();
        if (settings && settings.localHelperOrigin) return settings.localHelperOrigin;
        return isPublished() ? LOCAL_HELPER_ORIGIN : '';
    }

    /** What this is, in one word, for a log or a decision. */
    function describe() {
        var settings = published();
        return {
            deployment: (settings && settings.deployment) || 'local',
            hasLocalApi: hasLocalApi(),
            configured: Boolean(supabase()),
            publicSiteUrl: siteUrl()
        };
    }

    global.spotifieDeployment = {
        isPublished: isPublished,
        hasLocalApi: hasLocalApi,
        supabase: supabase,
        siteUrl: siteUrl,
        localHelperOrigin: localHelperOrigin,
        describe: describe,
        LOCAL_HELPER_ORIGIN: LOCAL_HELPER_ORIGIN
    };
})(typeof window !== 'undefined' ? window : globalThis);
