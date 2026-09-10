-- =============================================
-- Spotifie Supabase Setup - run in the Supabase SQL Editor
-- =============================================
--
-- Supabase is used for authentication, user profiles, administrator
-- authorization and the global admin catalogue.
--
-- Hybrid music model:
--   * Music an administrator publishes lives in catalog_albums/catalog_tracks
--     with the files in the private catalog-audio / catalog-artwork buckets.
--   * Music a user adds stays on that user's device, indexed by the local
--     library service, and is never uploaded here.
--   * A user removing global content stores that choice locally, per user id.
--     The shared copy is never modified or deleted by an ordinary user.
--
-- If an earlier version of this project created songs/albums/deleted_items
-- tables or audio/images buckets, they are simply no longer used. Removing
-- them is a manual decision and is intentionally not scripted here.
--
-- This script is idempotent: running it again is safe.
-- =============================================


-- =============================================
-- 1. PROFILES
-- =============================================

CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT,
    email TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT TO authenticated
    USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile" ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE TO authenticated
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- Profiles are never deleted directly by users; removing the auth user
-- cascades to the profile row.


-- =============================================
-- 2. AUTOMATIC PROFILE CREATION
-- =============================================
-- The profile row is created by the database when the auth user is created,
-- so signup does not depend on a client-side insert succeeding.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, username, email)
    VALUES (
        NEW.id,
        COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'username', ''), split_part(NEW.email, '@', 1)),
        NEW.email
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- Backfill: existing accounts created before the trigger get a profile too.
INSERT INTO public.profiles (id, username, email)
SELECT
    u.id,
    COALESCE(NULLIF(u.raw_user_meta_data ->> 'username', ''), split_part(u.email, '@', 1)),
    u.email
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

-- Keep updated_at accurate.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================
-- 3. ADMINISTRATOR AUTHORIZATION
-- =============================================
-- Admin rights are rows in app_admins, keyed by auth.users.id.
-- There is no admin email in the application code.

CREATE TABLE IF NOT EXISTS public.app_admins (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;

-- A signed-in user may check whether THEIR OWN id is an admin, and nothing
-- else: this query can never list other administrators.
DROP POLICY IF EXISTS "Users can check own admin status" ON public.app_admins;
CREATE POLICY "Users can check own admin status" ON public.app_admins
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- No INSERT, UPDATE or DELETE policy exists, so with RLS enabled every write
-- from anon or authenticated roles is rejected. Privileges are revoked as
-- well, belt and braces: nobody can promote themselves.
REVOKE INSERT, UPDATE, DELETE ON public.app_admins FROM anon, authenticated;
GRANT SELECT ON public.app_admins TO authenticated;

-- Helper for later phases (for example admin-only policies on a global
-- catalogue). SECURITY DEFINER so a policy can call it without needing read
-- access to the whole table.
CREATE OR REPLACE FUNCTION public.is_admin(uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (SELECT 1 FROM public.app_admins a WHERE a.user_id = uid);
$$;

REVOKE ALL ON FUNCTION public.is_admin(UUID) FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin(UUID) TO authenticated;

-- The same question asked about whoever is calling.
--
-- The browser needs this one. It takes no argument, so a caller cannot ask
-- about anybody but themselves: the answer is about auth.uid() and nothing
-- else, and it is a single true or false - the administrator list itself is
-- never readable through it. Nothing here writes, so it cannot be used to make
-- anybody an administrator; that remains a database-side action only.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (SELECT 1 FROM public.app_admins a WHERE a.user_id = auth.uid());
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;


-- =============================================
-- 4. ONE-TIME INITIAL ADMIN BOOTSTRAP
-- =============================================
-- Run this ONCE, by hand, in the Supabase SQL Editor (which runs with
-- elevated privileges). Replace the email with an existing Supabase auth
-- user - create the account through normal signup first.
--
-- There is no application code path that inserts into app_admins: promoting
-- an account is deliberately a database-side action only.
--
--     INSERT INTO public.app_admins (user_id, note)
--     SELECT id, 'initial admin'
--     FROM auth.users
--     WHERE email = 'you@example.com'
--     ON CONFLICT (user_id) DO NOTHING;
--
-- Verify with:
--
--     SELECT u.email, a.created_at
--     FROM public.app_admins a
--     JOIN auth.users u ON u.id = a.user_id;
--
-- To revoke an administrator:
--
--     DELETE FROM public.app_admins
--     WHERE user_id = (SELECT id FROM auth.users WHERE email = 'you@example.com');
-- =============================================


-- =============================================
-- 5. GLOBAL ADMIN CATALOGUE
-- =============================================
-- Music that administrators publish for everyone. Audio and artwork live in
-- private Storage buckets; these tables only hold metadata and the object
-- path. Music a user adds on their own device is never uploaded here.
--
-- This is a new, clean schema. The legacy songs/albums/deleted_items tables
-- from earlier versions are not used and are deliberately left untouched.

CREATE TABLE IF NOT EXISTS public.catalog_albums (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    artist TEXT,
    album_artist TEXT,
    description TEXT,
    artwork_path TEXT,
    created_by UUID REFERENCES auth.users(id) DEFAULT auth.uid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.catalog_tracks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    album_id UUID REFERENCES public.catalog_albums(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    artist TEXT,
    album_artist TEXT,
    track_number INTEGER,
    disc_number INTEGER,
    duration DOUBLE PRECISION,
    mime_type TEXT,
    audio_path TEXT NOT NULL,
    artwork_path TEXT,
    created_by UUID REFERENCES auth.users(id) DEFAULT auth.uid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Added after the first release: an album's own description, independent of
-- its artist. Existing rows keep NULL - the artist is never copied into it.
ALTER TABLE public.catalog_albums ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_catalog_tracks_album_id ON public.catalog_tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_catalog_tracks_artist ON public.catalog_tracks(artist);
CREATE INDEX IF NOT EXISTS idx_catalog_albums_title ON public.catalog_albums(title);

DROP TRIGGER IF EXISTS update_catalog_albums_updated_at ON public.catalog_albums;
CREATE TRIGGER update_catalog_albums_updated_at
    BEFORE UPDATE ON public.catalog_albums
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_catalog_tracks_updated_at ON public.catalog_tracks;
CREATE TRIGGER update_catalog_tracks_updated_at
    BEFORE UPDATE ON public.catalog_tracks
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.catalog_albums ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_tracks ENABLE ROW LEVEL SECURITY;

-- The published catalogue is public to read: a visitor with no account can
-- browse, search and play it. Nothing personal lives in these tables.
DROP POLICY IF EXISTS "Signed-in users can read catalog albums" ON public.catalog_albums;
DROP POLICY IF EXISTS "Anyone can read catalog albums" ON public.catalog_albums;
CREATE POLICY "Anyone can read catalog albums" ON public.catalog_albums
    FOR SELECT TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "Signed-in users can read catalog tracks" ON public.catalog_tracks;
DROP POLICY IF EXISTS "Anyone can read catalog tracks" ON public.catalog_tracks;
CREATE POLICY "Anyone can read catalog tracks" ON public.catalog_tracks
    FOR SELECT TO anon, authenticated
    USING (true);

-- Only administrators may change it. A normal user removing global content
-- stores that choice locally on their own device instead; nothing they can do
-- reaches these rows.
DROP POLICY IF EXISTS "Admins can insert catalog albums" ON public.catalog_albums;
CREATE POLICY "Admins can insert catalog albums" ON public.catalog_albums
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can update catalog albums" ON public.catalog_albums;
CREATE POLICY "Admins can update catalog albums" ON public.catalog_albums
    FOR UPDATE TO authenticated
    USING (public.is_admin(auth.uid()))
    WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can delete catalog albums" ON public.catalog_albums;
CREATE POLICY "Admins can delete catalog albums" ON public.catalog_albums
    FOR DELETE TO authenticated
    USING (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can insert catalog tracks" ON public.catalog_tracks;
CREATE POLICY "Admins can insert catalog tracks" ON public.catalog_tracks
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can update catalog tracks" ON public.catalog_tracks;
CREATE POLICY "Admins can update catalog tracks" ON public.catalog_tracks
    FOR UPDATE TO authenticated
    USING (public.is_admin(auth.uid()))
    WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can delete catalog tracks" ON public.catalog_tracks;
CREATE POLICY "Admins can delete catalog tracks" ON public.catalog_tracks
    FOR DELETE TO authenticated
    USING (public.is_admin(auth.uid()));

GRANT SELECT ON public.catalog_albums TO anon, authenticated;
GRANT SELECT ON public.catalog_tracks TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.catalog_albums TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.catalog_tracks TO authenticated;
-- The GRANTs above are gated by the policies: without an app_admins row the
-- policies reject every write.


-- =============================================
-- 6. STORAGE BUCKETS FOR THE GLOBAL CATALOGUE
-- =============================================
-- The buckets stay private: files are reachable only through short-lived
-- signed URLs. Creating one needs SELECT on the object, which both visitors
-- and signed-in listeners have - so browsing and listening work without an
-- account, while a raw object URL on its own stays unusable.
--
-- The server signs as the anonymous role for a visitor (Storage requires an
-- Authorization header, so the public anon key is sent as the bearer). That
-- grants exactly what the SELECT policy below allows and nothing more: the
-- write policies still demand an app_admins row.
-- Nothing is stored as Base64, and no audio is ever kept in the database.

INSERT INTO storage.buckets (id, name, public)
VALUES ('catalog-audio', 'catalog-audio', false)
ON CONFLICT (id) DO UPDATE SET public = false;

INSERT INTO storage.buckets (id, name, public)
VALUES ('catalog-artwork', 'catalog-artwork', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "Signed-in users can read catalog audio" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can read catalog media" ON storage.objects;
CREATE POLICY "Anyone can read catalog media" ON storage.objects
    FOR SELECT TO anon, authenticated
    USING (bucket_id IN ('catalog-audio', 'catalog-artwork'));

DROP POLICY IF EXISTS "Admins can upload catalog media" ON storage.objects;
CREATE POLICY "Admins can upload catalog media" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id IN ('catalog-audio', 'catalog-artwork') AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can update catalog media" ON storage.objects;
CREATE POLICY "Admins can update catalog media" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id IN ('catalog-audio', 'catalog-artwork') AND public.is_admin(auth.uid()))
    WITH CHECK (bucket_id IN ('catalog-audio', 'catalog-artwork') AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins can delete catalog media" ON storage.objects;
CREATE POLICY "Admins can delete catalog media" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id IN ('catalog-audio', 'catalog-artwork') AND public.is_admin(auth.uid()));
