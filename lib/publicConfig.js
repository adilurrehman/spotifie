'use strict';

/**
 * Public runtime configuration.
 *
 * Single source of truth for the Supabase project settings used by both the
 * server and the browser. Only browser-safe values belong here: the project
 * URL and the public anon key. A service-role key must never be placed in
 * this file, in the environment used by the browser, or in any client code.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://pkntkyvdekaykhzfecky.supabase.co').trim();
const SUPABASE_ANON_KEY = (
    process.env.SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrbnRreXZkZWtheWtoemZlY2t5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyODQ1NjksImV4cCI6MjA4NTg2MDU2OX0.V06htoEzkOguIa7Ya3HfjvOcJhDfzigotVXC5D15UDA'
).trim();

/**
 * Why the published configuration is unusable, or null when it is fine.
 * Missing settings are reported as a configuration error, never as a 404.
 */
function getConfigProblem() {
    if (!SUPABASE_URL) {
        return 'SUPABASE_URL is not set. Copy .env.example, set SUPABASE_URL and SUPABASE_ANON_KEY, then restart the server.';
    }
    if (!/^https?:\/\//i.test(SUPABASE_URL)) {
        return 'SUPABASE_URL must be a full URL, for example https://your-project-ref.supabase.co';
    }
    if (!SUPABASE_ANON_KEY) {
        return 'SUPABASE_ANON_KEY is not set. Use the project anon/publishable key - never a service-role key.';
    }
    return null;
}

function isConfigured() {
    return getConfigProblem() === null;
}

/** Configuration handed to the browser. Public values only. */
function getPublicConfig() {
    return {
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_ANON_KEY
    };
}

module.exports = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    getPublicConfig,
    getConfigProblem,
    isConfigured
};
