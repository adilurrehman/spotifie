# CLAUDE.md - Spotifie

Permanent project rules. These apply to every session and every change.

## Architecture rules

1. Spotifie is local-first.
2. Audio/music files must never use Supabase DB or Storage.
3. Supabase is for authentication and user profiles only.
4. The music source of truth is the local filesystem (`songs/`).
5. No Base64 audio storage.
6. The final runtime will use one local Node server.

## Change rules

7. Preserve the existing UI unless a phase explicitly changes it.
8. Never create `*_fixed`, `*_updated`, duplicate projects, or ZIPs.
9. Edit the real project directly.
10. Prefer targeted `rg`/search/read over repeatedly reading huge files.

## Security rules

11. Never store passwords or tokens manually in `localStorage`/`sessionStorage`.
12. Destructive filesystem operations must eventually be root-confined and authenticated.
12a. Authorization is decided on the server, from a Supabase session it verified itself. Nothing a browser can write may take part in it.
12b. Never weaken the Row Level Security in `supabase-setup.sql`.
12c. Metadata - titles, artists, album names, descriptions, filenames, profile names - is untrusted. Escape it, or set it with `textContent`.
12d. Never add the admin modules, `.env`, `.spotifie`, user music or this project's Supabase settings to the public release.

## Process rules

13. Do not implement P1+ work during P0.
14. Run relevant validation after edits.
15. The final response must be exactly:

```
Done
```

or, only if unavoidable:

```
Done
Manual:
- <item>
```

## Layout

- `index.html`, `signin.html`, `signup.html`, `about.html`, ... - static pages
- `css/`, `img/`, `favicons/` - static assets
- `js/script.js` - player, `js/auth.js` - Supabase session, profiles and admin checks, `js/admin.js` - admin dashboard, `js/libraryDB.js` - local library storage
- `server.js` - single local Node server: static frontend, `songs/` library API, and `/health` (default http://127.0.0.1:3000, override with HOST/PORT)
- `songs/` - music library on disk; `songs.json` - album index
- `supabase-setup.sql` - profiles, profile trigger and `app_admins` authorization (idempotent)
- `lib/publicConfig.js` - single source of the public Supabase settings, served at `/api/config`
- `lib/sessionAuth.js` - who is calling: one verified Supabase identity per token, shared by the whole server. Knows nothing about administrators
- `lib/adminAuth.js` - server-side admin verification for privileged endpoints (private half)
- `lib/adminCatalogRoutes.js`, `lib/adminAlbumRoutes.js` - administrator writes, kept in their own modules. `server.js`, `lib/catalogRoutes.js` and `lib/libraryRoutes.js` look for them on disk and build themselves without the privileged routes when they are absent, which is how the public release has none
- `tools/buildPublic.js` + `tools/releaseCheck.js` - the public release: built from an allowlist into `public-release/dist` (`npm run build:public`), then validated (`npm run release:check`). The working repository stays private; publishing means putting a checked release into a NEW repository, because deleting a file does not remove it from git history
- `lib/` - platform-neutral library layer: `libraryService.js` (LibraryService), `libraryRoutes.js` (/api/library), `adapters/localFileSystemAdapter.js` (current backend)
- `lib/catalogService.js` + `lib/catalogRoutes.js` - unified catalogue (/api/catalog): local library merged with the global admin catalogue
- `lib/globalCatalog.js` + `lib/supabaseRest.js` - global admin catalogue in Supabase (catalog_albums/catalog_tracks + private Storage buckets); public to read (guests included), admin-only to write
- `lib/userArtwork.js` - covers a person adds to their own albums, stored in `.spotifie/user-artwork/` and served at `/api/library/artwork/<id>` (never Base64, never uploaded)
- `lib/userMedia.js` + `lib/mediaTickets.js` - music a person imports from their own device: kept in `.spotifie/media/<uid>/`, indexed by its own LibraryService, and served only to that account through a short-lived ticket
- `lib/deviceScan.js` + `lib/deviceLibrary.js` - searching this machine for music: the profile folders music lives in (Music, Downloads, Desktop, Documents) plus MUSIC_ROOT, imported media and configured roots, walked recursively in the background with bounded concurrency and strict system-folder exclusions; full the first time and incremental (path/size/mtime cache, no rehash or reparse of unchanged files) afterwards; indexed under `.spotifie/device/` and shared by everyone who opens Spotifie here (guests included, never Supabase); one job per device, reported at /api/library/scan as counts (paths are logged server-side only, SPOTIFIE_SCAN_DEBUG=1 for detail); everything found on this machine is shown as one system collection, `system:local-music` ("Local Music"), which the library lists first and which never becomes albums made from file tags
- `lib/userState.js` - per-user local state in `.spotifie/users/<uid>/state.json`: liked songs, playlists, recently played, hidden global content, personal edits to published albums, and where that person stopped in each track. References only - canonical track ids and an artwork id this machine serves; never audio, a picture, Base64, a signed address or a filesystem path. Atomic writes, schema-versioned, and never sent to Supabase. Two accounts on one machine share the music and share nothing in here
- `js/personalClient.js` - the browser's one view of that state. Every heart on the page reads from it and is redrawn when it changes, so none of them can disagree; signing out clears it before the next person sees anything. A collection is resolved against the library at render time, so a song that has gone is a missing row rather than a broken page
- `lib/playbackProgress.js` - where a listener stopped, per canonical track id, served at `/api/catalog/progress`: a signed-in person's in their own state file, a guest's in `.spotifie/device/playback.json` (device-scoped, like the device library). Written a few times a minute, forgotten once a track is heard to its end, and never sent to Supabase
- `js/catalogClient.js` - browser client for the unified catalogue
- `js/catalogCache.js` - the device's copy of the published catalogue in IndexedDB, so the library is drawn before Supabase is asked; published descriptions and artwork versions only, never audio, never a signed URL, never anything belonging to an account. The catalogue is checked in the background and redrawn only if it changed; covers are served from this origin at `/api/catalog/{albums,tracks}/:id/artwork/image?v=<version>`
- `js/libraryClient.js` - browser-side library client (IDs and URLs only, never paths)
- `music/` - local music root scanned by the library (override with `MUSIC_ROOT`)
- `.spotifie/` - rebuildable local index and artwork cache (never a source of truth)
- `test/` - node:test suite (`npm test`)
