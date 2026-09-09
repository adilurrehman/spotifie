# Spotifie

A full-featured hybrid music player: a catalogue published for everyone through Supabase, and the music already on your own device, in one library behind one player.

---

## Overview

Spotifie runs from a single Node server on the machine you start it on. That one process serves the interface, indexes the audio already present on the device, streams it, and reads the catalogue an administrator has published for everyone.

Two sources of music sit side by side in one library:

- **Global** — albums an administrator publishes. Metadata lives in Supabase tables, media in private Supabase Storage buckets. Anyone who opens Spotifie can browse and play it, signed in or not.
- **Local** — the audio on this machine, discovered by a background search and served by the local server. It is indexed locally, played locally, and never uploaded anywhere.

Both are namespaced (`global:<uuid>`, `local:<sha256>`) so they can never collide, and both reach the browser as identifiers and URLs — never as filesystem paths.

## Key Features

**Music sources**

- Global catalogue published by an administrator, available to guests and signed-in listeners alike
- Automatic discovery of the music already on the device, presented as one **Local Music** collection listed first in the library
- Incremental rescanning: a full pass the first time, then only what changed, matched by path, size and modification time
- Personal imports of audio from the device, kept private to the account that imported them
- No user audio is ever uploaded to Supabase

**Player**

- One canonical player across the whole application: desktop, tablet and mobile play bars, plus an expanded Now Playing view
- Play/pause, previous/next, seek with a keyboard-operable slider, volume
- Shuffle, and repeat in three modes: off, all, one
- Playback position remembered per track and restored on the next listen
- Artwork resolved once, centrally, with a track → album → default fallback chain
- System media controls where the browser provides them

**Library**

- Album detail pages with track lists, playing indication and a single play action
- Search across every album and song in the merged library
- Albums of your own, built from anything in the library
- A Liked Songs collection
- Playlists you make: create, rename, describe, re-cover, delete, and add, remove or reorder tracks
- Recently Played and Recently Added, and artist browsing derived from the music itself
- Personal overrides: rename, re-cover or re-describe a published album for yourself without touching the shared record
- Hide global content for your own account only
- Export and restore your collections and preferences

**Interface**

- Full light and dark themes built from semantic colour tokens
- Layouts designed for phone, tablet and desktop rather than scaled from one of them
- Keyboard navigation, visible focus, accessible names, live regions and reduced-motion support

**Accounts**

- Optional sign-in through Supabase, with profiles created by a database trigger
- Guest listening for the global catalogue and this device's music
- Administrator dashboard for publishing and removing global content

## Architecture

```
                        ┌─────────────────────────────┐
                        │        Browser (SPA)        │
                        │  player · library · search  │
                        └──────────────┬──────────────┘
                                       │  one origin
                        ┌──────────────┴──────────────┐
                        │   Local Node server         │
                        │   server.js + lib/          │
                        └───┬──────────────────────┬──┘
                            │                      │
        ┌───────────────────┴──────┐    ┌──────────┴──────────────────┐
        │  GLOBAL ADMIN MUSIC      │    │  USER / DEVICE MUSIC        │
        │  Supabase catalogue      │    │  local filesystem + index   │
        │  tables + private        │    │  (.spotifie/device, media)  │
        │  Storage buckets         │    │  never uploaded             │
        └──────────────────────────┘    └─────────────────────────────┘
                            │
                 ┌──────────┴───────────┐
                 │  PERSONAL STATE      │
                 │  local state files   │
                 │  + browser storage   │
                 └──────────────────────┘
```

- **Global admin music** → Supabase catalogue tables (`catalog_albums`, `catalog_tracks`) plus private Storage buckets (`catalog-audio`, `catalog-artwork`). Public to read, administrator-only to write, enforced by Row Level Security.
- **User / device music** → the local filesystem and a local index only. Nothing about it is written to Supabase.
- **Personal state** → local state files beside the server (`.spotifie/users/<uid>/state.json` for an account, `.spotifie/device/` for a guest), plus theme and player preferences in browser storage.

The catalogue service merges the two sources into a single model before the browser sees either, so the player has one shape of track to deal with regardless of where the audio comes from. If one source is unavailable the other still works: an unreachable Supabase leaves the device library fully usable, and a broken local index does not hide the global catalogue.

## Local vs Global Music Model

| | Local | Global |
| --- | --- | --- |
| Identifier | `local:<sha256 of file contents>` | `global:<uuid>` |
| Where the audio lives | the device's own filesystem | private Supabase Storage bucket |
| Who can play it | anyone using this installation | anyone who opens Spotifie, guests included |
| Who can add to it | the person using the machine | administrators only |
| Uploaded to Supabase | never | yes, by an administrator |
| Removing it | affects this device only; the file is not deleted | hidden per account, or deleted for everyone by an administrator |

Every track, from either source, carries `id`, `source`, `title`, `artist`, `album`, `albumId`, `duration`, `artworkUrl`, `streamUrl` and `metadata`. No filesystem path and no Storage path ever reaches the browser.

Content-hash identifiers mean a local file that is moved or renamed keeps the same id, so likes, personal albums and listening positions survive a reorganised music folder.

## Technology Stack

| Layer | What is used |
| --- | --- |
| Server | Node.js 18+, the built-in `http` module — no web framework |
| Runtime dependency | `music-metadata` (tag and embedded-artwork reading) |
| Frontend | Vanilla HTML, CSS and JavaScript — no build step, no bundler |
| Styling | CSS custom properties with light and dark token sets |
| Local storage | JSON index files under `.spotifie/`, plus browser `localStorage` and IndexedDB (collections, and a copy of the published catalogue) |
| Cloud | Supabase — authentication, profiles, catalogue tables and Storage |
| Tests | `node:test` |

## Local Music Discovery

The device search looks in the folders music normally lives in, and nowhere else:

- the profile's Music, Downloads, Desktop and Documents folders
- the configured music root (`MUSIC_ROOT`, default `./music`)
- any extra locations listed in `SPOTIFIE_MUSIC_LOCATIONS`
- the account's own imported media

System, program, dependency, cache and version-control folders are excluded outright, and the walk is depth- and count-limited.

How it behaves:

- Supported files: `.mp3`, `.flac`, `.wav`, `.m4a`, `.aac`, `.ogg`, `.opus`
- The first run is a full pass; afterwards a file whose path, size and modification time are unchanged is neither rehashed nor reparsed
- The walk runs in the background with bounded concurrency and yields between batches, so the interface stays responsive
- One scan job per device at a time; a second request joins the running one, so a refresh or a second tab watches it rather than starting another
- Progress is reported as counts at `GET /api/library/scan`. Folder names are logged server-side only — set `SPOTIFIE_SCAN_DEBUG=1` to see them
- Everything found appears as one system collection, `system:local-music` ("Local Music"), listed first in the library. It is never split into albums invented from file tags
- The device index lives under `.spotifie/device/` and is shared by everyone who opens Spotifie on that machine, guests included

The index and artwork cache are rebuildable at any time: delete `.spotifie/` and the next start rebuilds them from the files themselves. The audio always stays in the original files — nothing is copied into a database and nothing is Base64-encoded.

## Global Admin Catalogue

Administrators publish albums and tracks from the admin dashboard. Metadata goes to `catalog_albums` and `catalog_tracks`; audio and artwork go to the private `catalog-audio` and `catalog-artwork` Storage buckets.

- Reading is public: a visitor with no account sees the same albums and tracks a member does, because the read request goes out with the anon key and Row Level Security decides what comes back
- Writing requires an `app_admins` row, checked server-side by `lib/adminAuth.js` and again by Row Level Security
- Only stable Storage object paths are stored in the database — never a signed URL. Playback asks for a short-lived signed URL when needed, and an expired one is simply resolved again
- A track uses its own artwork if it has any, otherwise its album's, otherwise the default cover

### Drawn before the catalogue arrives

Waiting on Supabase before anything could be shown made every refresh as slow as the network, for a catalogue that had usually not changed. The published catalogue is now cached on the device and checked afterwards:

- The browser keeps a copy of the published albums and tracks in IndexedDB — descriptions and the version of each cover, never audio, never a signed URL, and nothing belonging to a person. It is device-level: a guest reads the same copy a signed-in listener does
- On load, the library is drawn from that copy joined to `GET /api/catalog/local`, which answers from this machine alone and carries the listener's own overrides and hidden items. Nothing waits on Supabase
- The real catalogue is then read in the background. Every album and track is reduced to its id, its `updated_at` and its artwork version; if that fingerprint is unchanged, nothing is redrawn and nothing is re-fetched
- A catalogue that cannot be reached leaves the library exactly as it is, and never replaces a good copy with an empty one
- The copy carries a schema version. A record it does not understand is dropped, not migrated, and a corrupt one cannot break startup

Covers are served from this origin at `GET /api/catalog/{albums,tracks}/:id/artwork/image?v=<version>`. The server signs the Storage object internally, streams the bytes, and sets an `ETag` with `Cache-Control: public, max-age=31536000, immutable` — so the same cover is the same address the browser already has, and a replaced cover is a different address it fetches. No signed URL ever reaches the page. Catalogue JSON stays `no-store`, because it is one person's view.

An administrator's write clears both halves: the server forgets what it read from Supabase, and the dashboard drops the browser's copy.

### Who can see what

| | Guest | Signed-in listener | Administrator |
| --- | --- | --- | --- |
| Browse, search and play the global catalogue | yes | yes | yes |
| Play the music on this device | yes | yes | yes |
| Personal albums, likes, hidden items, backups | no | yes | yes |
| Import audio from the device to an account | no | yes | yes |
| Publish or delete global content | no | no | yes |

While signed out, the actions that belong to a person — Create Album, adding music, Like, hiding global content, backup and restore — are hidden or ask the visitor to sign in rather than pretending to work. No other account's personal state is ever returned.

## Your Own Library

Everything a listener builds on top of the music belongs to their account and lives on this machine, in `.spotifie/users/<uid>/state.json`. None of it goes to Supabase, which holds accounts and the published catalogue and nothing personal.

| | Where it lives | What is written |
| --- | --- | --- |
| Liked songs | that account's state file | canonical track ids, newest first |
| Playlists | that account's state file | a title, a description, an artwork id, and an ordered list of track ids |
| Recently played | that account's state file | track id and time, one entry per song, latest 200 |
| Personal album edits, hidden content | that account's state file | as before |

What is stored is references and nothing else. No audio, no pictures, no Base64, no signed addresses, and no filesystem paths — so the file stays small, readable, and ready for a later export.

**Resolved at render time.** A collection is a list of ids; the songs are looked up against the library every time it is shown. A file that has moved, a track an administrator has withdrawn, or music on a machine this account has not used, is a **missing row** — still listed, so its owner can see it and take it out, never a broken page and never invented audio.

**Two people, one machine.** They share the device library and the published catalogue. They share nothing else: separate playlists, likes, history, album overrides and hidden content. Signing out empties what is held in memory before the guest view is drawn, so the next person starts from nothing.

**Guests.** A guest browses and plays both the published catalogue and this device's music. Every personal write is refused with `401` and an invitation to sign in; every personal read answers empty. Listening is not refused — there is simply nowhere of their own to write it down.

### Playlists

Create, rename, describe, re-cover, delete; add, remove and reorder tracks; play or shuffle. A playlist may name the same song more than once, because somebody may have meant to put it there twice — an album's membership stays deduplicated, because an album holds each song once. Removing one entry from a playlist removes that entry, by position, and not every copy of the song.

A cover is a file saved on this machine; the playlist keeps only its id. Nothing is uploaded and nothing is encoded into the state.

### Views

Albums, Playlists, Artists, Liked Songs, Recently Played, Recently Added and Local Music. Each narrows which cards the grid shows; none is a new kind of page, and back and forward work across them as they do everywhere else.

**Artists** are worked out from the tracks themselves — there is no artist table to keep in step. A track that says nothing about who it is by belongs to `Unknown Artist`, a real group of real tracks; no artist is ever invented from an id or a file name.

**Recently Added** sorts by dates that already exist: when a file was last written, for music on this device, and when a track was published, for the catalogue. No tag is touched to produce it.

### Searching

One normalized index, built when the library changes and not when somebody types. Songs, albums, playlists and artists all come out of the same pass, across both the published catalogue and this device's music. Nothing is fetched while somebody is typing.

| Route | Purpose |
| --- | --- |
| `GET /api/catalog/me` | Everything this account has, resolved, in one request |
| `GET`/`POST /api/catalog/liked`, `DELETE /api/catalog/liked/:id` | Liked songs |
| `GET`/`POST /api/catalog/playlists` | List and create |
| `GET`/`PATCH`/`DELETE /api/catalog/playlists/:id` | One playlist |
| `POST`/`PUT /api/catalog/playlists/:id/tracks` | Add, move, rearrange |
| `DELETE /api/catalog/playlists/:id/tracks/:trackId?position=` | Remove one entry |
| `GET`/`POST`/`DELETE /api/catalog/recent` | Listening history |
| `GET /api/catalog/recently-added` | The newest music |
| `GET /api/catalog/artists?name=` | Artists, or one of them with their tracks |

Every one of these answers `Cache-Control: no-store`: they belong to one person.

## Authentication

Supabase handles authentication and profiles. It holds no user audio.

- The Supabase session is the only proof of a login. Nothing written to `localStorage` or `sessionStorage` grants access, and keys left by older versions are purged on load
- Profiles are created by a database trigger on `auth.users`, not by the browser
- Administrators are rows in `app_admins`, keyed by user id. A signed-in user can check whether their own id is an admin and nothing else; the table grants no writes, so nobody can promote themselves
- Privileged endpoints verify the caller's access token and admin row server-side. Hiding the dashboard link is not the control
- Public Supabase settings come from `lib/publicConfig.js` and are served to the browser at `GET /api/config`

Pages: `signin.html`, `signup.html`, `forgot-password.html`, `reset-password.html`, `admin-login.html`.

## Player Features

| Area | Behaviour |
| --- | --- |
| Transport | Play/pause, previous, next |
| Seek | A focusable `role="slider"` bar: drag it, or use the arrow keys, Page Up/Down, Home and End |
| Volume | Native range input, with an on-demand popover on tablet and mobile |
| Shuffle | Walks a collection once through, without repeats, before wrapping |
| Repeat | Off, all, one |
| Now Playing | An expanded view over the page that never interrupts what is playing |
| Position memory | Where you stopped is remembered per track and restored on the next listen; a finished track is forgotten |
| Artwork | Resolved by one canonical resolver, cached in memory with expiry, invalidated and retried once on failure, then the default cover |
| Media Session | System media controls where the browser supports them |

Position memory is served at `GET /api/catalog/progress`: a signed-in listener's is written to their own state file, a guest's to `.spotifie/device/playback.json`. Neither is sent to Supabase.

## Responsive Experience

- **Desktop** — persistent library sidebar, three-zone play bar, full album detail hero
- **Tablet** — the same controls with volume in an on-demand popover
- **Mobile** — an off-canvas library drawer with backdrop, Escape and scroll lock; a compact multi-row play bar that respects `env(safe-area-inset-bottom)`; a two-column album grid; a compact horizontal album-detail hero

Touch targets are sized for a finger, hover effects are confined to `@media (hover: hover) and (pointer: fine)`, and `prefers-reduced-motion` turns animations and transitions off.

## Privacy Architecture

- Audio found on the device, and audio imported from it, is read from disk and streamed by the local server. It is never uploaded to Supabase or anywhere else
- The browser receives identifiers, tag data and URLs. Filesystem paths and Storage paths never leave the server
- A person's imported media is served only to that account, through a short-lived HMAC ticket, because an `<audio>` element cannot send an authorization header
- Supabase holds the account and profile, and the catalogue an administrator published. The two are kept apart in the model and on disk
- Personal state — hidden global content, personal edits to published albums, listening positions — lives in local state files, not in Supabase
- Theme and player preferences live in this browser's `localStorage`; collections and the cached copy of the published catalogue live in IndexedDB. That copy holds published descriptions only — no audio, no signed URL, and nothing belonging to an account
- Spotifie sets no cookies of its own and loads no analytics, advertising or tracking scripts
- Everything under `.spotifie/` is a rebuildable cache. Deleting it loses nothing that cannot be rebuilt from the files themselves

## Project Structure

| Path | Purpose |
| --- | --- |
| `server.js` | The single local Node server: static frontend, library API, catalogue API, `/health` |
| `index.html` and the other `*.html` pages | Player, about, developer, authentication and admin pages |
| `css/` | `style.css` (application), `auth.css` (authentication pages), `utlity.css` |
| `js/script.js` | Player, library UI, search, album detail, themes |
| `js/auth.js` | Supabase session, profiles and admin checks |
| `js/admin.js` | Admin dashboard for the global catalogue |
| `js/catalogClient.js` | Browser client for the unified catalogue |
| `js/libraryClient.js` | Browser client for the library API (identifiers and URLs only) |
| `js/libraryDB.js` | Local collection storage (IndexedDB) |
| `js/catalogCache.js` | The device's copy of the published catalogue (IndexedDB) |
| `js/personalClient.js` | The browser's one view of this account's liked songs, playlists and history |
| `lib/config.js`, `lib/safeFs.js` | Configuration and root-confined filesystem helpers |
| `lib/libraryService.js`, `lib/libraryIndex.js`, `lib/libraryRoutes.js` | Local library layer and its HTTP routes |
| `lib/adapters/localFileSystemAdapter.js` | The current library backend |
| `lib/catalogService.js`, `lib/catalogRoutes.js` | The merged local + global catalogue |
| `lib/globalCatalog.js`, `lib/supabaseRest.js` | The Supabase catalogue and a minimal REST client |
| `lib/deviceScan.js`, `lib/deviceLibrary.js` | Device music discovery and the device-wide index |
| `lib/userMedia.js`, `lib/mediaTickets.js` | Per-account imported audio and its short-lived access tickets |
| `lib/userArtwork.js` | Covers a person adds to their own albums |
| `lib/userState.js`, `lib/playbackProgress.js` | Per-account local state and listening positions |
| `lib/sessionAuth.js` | Who is calling: one verified identity per token, shared by the whole server |
| `lib/adminAuth.js`, `lib/publicConfig.js` | Server-side admin verification (private), public Supabase settings |
| `lib/adminCatalogRoutes.js`, `lib/adminAlbumRoutes.js` | Administrator writes (private; absent from the public release) |
| `tools/buildPublic.js`, `tools/releaseCheck.js` | Building and validating the public release |
| `SECURITY.md` | Security policy and architecture |
| `img/`, `favicons/`, `robots.txt` | Static assets |
| `music/` | Default local music root (`MUSIC_ROOT`) |
| `songs/`, `songs.json` | On-disk album folders used by the `/api/*-album` endpoints |
| `.spotifie/` | Rebuildable index, artwork cache, imported media and local state |
| `supabase-setup.sql` | Profiles, admin authorization and the global catalogue schema |
| `test/` | `node:test` suite |
| `CLAUDE.md` | Permanent project rules |

## Installation

Requires Node.js 18 or newer.

```bash
npm install
```

## Environment Setup

```bash
cp .env.example .env
```

Fill in your own values. Never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `HOST` | Interface to bind (default `127.0.0.1`) |
| `PORT` | Port to listen on (default `3000`) |
| `MUSIC_ROOT` | Local music root, scanned recursively (default `./music`) |
| `SUPABASE_URL` | Supabase project URL — a public, browser-safe setting |
| `SUPABASE_ANON_KEY` | Supabase anon key — a public, browser-safe setting |

Optional, read from the process environment:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_SITE_URL` | Where this installation is published, e.g. `https://example.com`. Unset in development |
| `SPOTIFIE_MUSIC_LOCATIONS` | Extra folders to search, separated by the platform path delimiter |
| `SPOTIFIE_SCAN_DEBUG` | Set to `1` to log the folders the search visits |
| `SPOTIFIE_SCAN_CONCURRENCY`, `SPOTIFIE_SCAN_BUSY_CONCURRENCY` | Parallelism of the walk |
| `SPOTIFIE_SCAN_MAX_DEPTH`, `SPOTIFIE_SCAN_MAX_FILES` | Limits on how far and how wide the walk goes |

A service-role key must never enter this project, `.env`, or browser code. Administrators are rows in `app_admins`, not an address in configuration.

## Running Locally

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

The server reads `HOST` and `PORT` from the process environment, so export them before starting rather than relying on `.env` being loaded automatically.

Opening the HTML files with `file://` is not supported, and a separate static server (an editor's live-server extension, for example) will not work either: the frontend loads its Supabase settings from `GET /api/config` on the same origin, which only this server provides.

### "Port 3000 is already in use" / "/api/config was not found"

Both symptoms have one cause: another program is answering on the port, so the pages you are looking at are not being served by Spotifie. A live-preview extension or an older `node server.js` are the usual suspects — they serve the HTML fine but have no `/api/config`, `/health` or `/api/library` routes, so every API call returns 404 and sign-in fails.

Stop the other server, or run Spotifie elsewhere:

```bash
PORT=3010 npm start
```

On Windows, find what holds the port with `Get-NetTCPConnection -LocalPort 3000 -State Listen`.

## Supabase Setup

1. Create a Supabase project.
2. Open the SQL Editor and run `supabase-setup.sql` in full. It is idempotent and safe to re-run. It creates the profiles table and its trigger, the `app_admins` authorization table, the catalogue tables, the private `catalog-audio` and `catalog-artwork` buckets, and the Row Level Security policies for all of them.
3. Put the project URL and anon key in `.env` (or leave the defaults in `lib/publicConfig.js` if they are already correct for your project).
4. Sign up through `signup.html` so the trigger creates your profile.

Apply the SQL before signing in for the first time.

## Device Music Scan

The page asks for a scan when Spotifie loads; the server owns the job.

| Request | Purpose |
| --- | --- |
| `POST /api/library/scan` | Start a scan, reusing the index and reading only what changed |
| `POST /api/library/scan?mode=full` | Start a full pass that reads every file again |
| `GET /api/library/scan` | Current job state and counts (`?playing=true` tells it to give way to playback) |
| `DELETE /api/library/scan` | Cancel the running scan |
| `POST /api/library/rescan` | Rescan the configured music root (`MUSIC_ROOT`) |

The first full pass shows progress in the interface. Later passes are silent unless something changed, in which case a brief toast reports how many tracks were added. To search additional folders, set `SPOTIFIE_MUSIC_LOCATIONS` before starting the server.

## Admin Setup

Administrators are created in the database, once, by hand — there is no application code path that inserts into `app_admins`.

1. Create the account through normal signup first.
2. In the Supabase SQL Editor, run the bootstrap statement documented at the end of `supabase-setup.sql`, which inserts that user's id into `public.app_admins`.
3. Sign in at `admin-login.html` and open `admin-dashboard.html` to publish albums and tracks.

Revoking an administrator is a matching `DELETE`, also documented in that file.

## Public App vs Private Admin Tooling

**This repository is the private working copy.** It holds both halves of the project, and it is not the thing to publish.

| | Public app | Private admin tooling |
| --- | --- | --- |
| Pages | `index.html`, `about.html`, `developer.html`, the sign-in and password pages | `admin-login.html`, `admin-dashboard.html` |
| Browser code | `js/script.js`, `js/auth.js`, `js/catalogClient.js`, `js/catalogCache.js`, `js/libraryClient.js`, `js/libraryDB.js` | `js/admin.js` |
| Server | `server.js` and the shared `lib/` modules | `lib/adminAuth.js`, `lib/adminCatalogRoutes.js`, `lib/adminAlbumRoutes.js` |
| Can do | browse, search and play; the device library; personal collections and overrides | publish, edit and delete global albums and tracks; rescan the music root |

The seam is a real one, not a naming convention. `server.js`, `lib/catalogRoutes.js` and `lib/libraryRoutes.js` look for the admin modules on disk and build themselves without the privileged routes when they are absent. A release that does not ship them has no such route to reach: a request for one ends at the same 404 as a made-up path.

That is packaging, not access control. The authorization described under [Security Notes](#security-notes) applies whether or not the admin half is present, and is what actually stops an ordinary account writing to the catalogue.

### Building the public release

```bash
npm run build:public
```

Writes `public-release/dist` from an allowlist in `tools/buildPublic.js` — a list of what goes in, never a copy-then-delete. A file nobody named is simply not there. On the way out it also:

- removes the dashboard link from `index.html`
- clears this project's own Supabase settings from `lib/publicConfig.js`, so the release arrives pointed at nobody's project
- gives the release its own `README.md` (from `public-release/README.public.md`) and `robots.txt`
- strips the administrator bootstrap procedure from `supabase-setup.sql`, keeping every policy

### Checking it

```bash
npm run release:check
```

Reads what was actually produced and fails if it finds admin pages or modules, a service-role key, a private key, a password literal, `.env`, `.spotifie`, user audio, or a release missing half the application. It also reports what `git ls-files` tracks in this working copy, as a reminder of what publishing *this* repository would expose.

### Publishing

**Deleting a file does not remove it from git history.** This repository has carried the admin code and its configuration from the beginning, so making it public — now or after any amount of deleting — would publish all of it to anyone who runs `git log`.

The safe route is a fresh repository:

1. keep this repository **private**;
2. `npm run build:public`;
3. `npm run release:check`, and fix anything it reports;
4. create a **new, empty** public repository;
5. copy the contents of `public-release/dist` into it and make the first commit there.

The public repository then has no history to leak, because it starts at the release.

## Discoverability

Everything Spotifie says about itself to a machine is written in `lib/siteMeta.js` and served by the
application, so the pages, the sitemap, `robots.txt` and the plain-text summary cannot drift apart.

| Address | What it is |
| --- | --- |
| `/robots.txt` | What may be crawled. The API, the auth forms and `.spotifie` are excluded |
| `/sitemap.xml` | The stable public pages only. 404 until `PUBLIC_SITE_URL` is set |
| `/llms.txt` | A short factual summary of what Spotifie is, for anything reading documentation |

Each page carries its own title, description, robots directive, theme colour and Open Graph and Twitter
card metadata. The canonical URL, the social image and the JSON-LD record are filled in as the page is
served, at the `<!--site-meta-->` marker in its head — they are statements about where the application
is deployed, and the files are the same wherever that is.

**`PUBLIC_SITE_URL` is the whole configuration.** Set it to the deployed origin and the canonical URLs,
the sitemap and the structured data all follow. Leave it unset — or set it to a loopback address — and
nothing claims an address at all: no canonical, no `og:url`, and `/sitemap.xml` answers 404. That is
deliberate. A canonical URL pointing at somebody's own machine is worse than none.

Nothing about a person's library is published. The structured data describes the application; the
sitemap lists three pages that are the same for everybody; playlists, liked songs, local albums and the
music on a device appear in none of it.

Before deploying:

- [ ] `PUBLIC_SITE_URL` is set to the real origin, over HTTPS
- [ ] `/robots.txt`, `/sitemap.xml` and `/llms.txt` all answer
- [ ] The canonical URL on `/` is the deployed address, not `127.0.0.1`
- [ ] The JSON-LD in the served page parses
- [ ] `npm run release:check` passes

## Testing

```bash
npm test
npm run check
```

`npm test` runs the `node:test` suite in `test/` — the library layer, the catalogue, authentication, admin authorization, the device scan and import, playback, playback sequence and progress, artwork, navigation, album detail and membership, theming and responsive layout, and the security rules in `test/security.test.js` — authorization, the database policies, static serving and traversal, escaping, and the shape of the public release. `npm run check` runs a syntax check over every server and browser module.

## Security Notes

- Filesystem access is confined to configured roots and checked with `lib/safeFs.js`; paths never leave the server
- Privileged endpoints verify the access token and the `app_admins` row server-side
- `app_admins` grants no writes to `anon` or `authenticated`, so an account cannot promote itself
- Storage buckets are private. Media is reached only through short-lived signed URLs, and only object paths are persisted
- A person's imported audio is served only to that account, through a short-lived HMAC ticket bound to the track
- No passwords or tokens are written to `localStorage` or `sessionStorage` by the application
- The anon key is a public, browser-safe setting by design. A service-role key belongs nowhere in this project
- Static serving works from a list of what may be served — pages, `css/`, `js/`, `img/`, `favicons/` and `songs/`. The server's own source, its modules, the database script, the tests and the working data have no route at all, there is no directory listing, and traversal is rejected in every spelling
- Every response carries a content security policy, `nosniff`, a referrer policy, a permissions policy and `frame-ancestors 'none'`. HSTS is deliberately not set: this server is reached over plain HTTP on loopback
- Titles, artists, album names, descriptions and profile names are treated as untrusted text. They are escaped — quotes included, because most of them land in attributes — and names are written with `textContent` rather than built into markup

Full detail, and how to report a vulnerability, is in [SECURITY.md](SECURITY.md).

## Current Platform Scope

Spotifie today is a web application served by a local Node server, run on the machine whose music it indexes. It is developed and tested on Windows with Node 18+, and the library layer sits behind an adapter interface so the filesystem backend is replaceable.

It is not a native iOS or Android application. The global catalogue requires network access to Supabase; there is no offline cache of it.

## Future Packaging / Roadmap

Clearly future work, not present behaviour:

- Desktop packaging around the existing local server
- Additional library adapters behind the existing `LibraryService` interface
- Formal accessibility audit against a WCAG conformance level

## License

Private and unlicensed (`"private": true`, `"license": "UNLICENSED"` in `package.json`). All rights reserved.

Spotifie is an independent project. It is not affiliated with, endorsed by or connected to Spotify AB, and the Spotify name and logo are trademarks of Spotify AB.

## Rules

Permanent project rules for contributors and agents are in [CLAUDE.md](CLAUDE.md).
"# spotifie" 
