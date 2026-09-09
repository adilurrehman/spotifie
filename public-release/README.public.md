# Spotifie

A full-featured hybrid music player: a catalogue published for everyone through Supabase, and the music already on your own device, in one library behind one player.

---

## Overview

Spotifie runs from a single Node server on the machine you start it on. That one process serves the interface, indexes the audio already present on the device, streams it, and reads the catalogue published for everyone.

Two sources of music sit side by side in one library:

- **Global** — published albums. Metadata lives in Supabase tables, media in private Supabase Storage buckets. Anyone who opens Spotifie can browse and play it, signed in or not.
- **Local** — the audio on this machine, discovered by a background search and served by the local server. It is indexed locally, played locally, and never uploaded anywhere.

Both are namespaced (`global:<uuid>`, `local:<sha256>`) so they can never collide, and both reach the browser as identifiers and URLs — never as filesystem paths.

## Key Features

**Music sources**

- Published catalogue, available to guests and signed-in listeners alike
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
- Personal overrides: rename, re-cover or re-describe a published album for yourself without touching the shared record
- Hide global content for your own account only
- Export and restore your collections and preferences

**Interface**

- Full light and dark themes built from semantic colour tokens
- Layouts designed for phone, tablet and desktop rather than scaled from one of them
- Keyboard navigation, visible focus, accessible names, live regions and reduced-motion support

**Accounts**

- Optional sign-in through Supabase, with profiles created by a database trigger
- Guest listening for the published catalogue and this device's music

## What this release is

This is the Spotifie application: the part a listener uses.

Publishing to the shared catalogue is an operator's job, done with tooling that is not part of this release. The server here has no route that can write to the published catalogue, and no page that offers to. The database policies that enforce that are in `supabase-setup.sql` and are applied along with the rest of the schema.

If you run your own copy, the catalogue is yours: create the Supabase project, apply the schema, and the account you make an administrator in the database can publish to it. See [SECURITY.md](SECURITY.md) for how authorization is decided.

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
        │  GLOBAL PUBLISHED MUSIC  │    │  USER / DEVICE MUSIC        │
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

- **Global published music** → Supabase catalogue tables (`catalog_albums`, `catalog_tracks`) plus private Storage buckets (`catalog-audio`, `catalog-artwork`). Public to read, administrator-only to write, enforced by Row Level Security.
- **User / device music** → the local filesystem and a local index only. Nothing about it is written to Supabase.
- **Personal state** → local state files beside the server (`.spotifie/users/<uid>/state.json` for an account, `.spotifie/device/` for a guest), plus theme and player preferences in browser storage.

If one source is unavailable the other still works: an unreachable Supabase leaves the device library fully usable, and a broken local index does not hide the published catalogue.

## Technology Stack

| Layer | What is used |
| --- | --- |
| Server | Node.js 18+, the built-in `http` module — no web framework |
| Runtime dependency | `music-metadata` (tag and embedded-artwork reading) |
| Frontend | Vanilla HTML, CSS and JavaScript — no build step, no bundler |
| Styling | CSS custom properties with light and dark token sets |
| Local storage | JSON index files under `.spotifie/`, plus browser `localStorage` and IndexedDB |
| Cloud | Supabase — authentication, profiles, catalogue tables and Storage |

## Local Music Discovery

The device search looks in the folders music normally lives in, and nowhere else:

- the profile's Music, Downloads, Desktop and Documents folders
- the configured music root (`MUSIC_ROOT`, default `./music`)
- any extra locations listed in `SPOTIFIE_MUSIC_LOCATIONS`
- the account's own imported media

System, program, dependency, cache and version-control folders are excluded outright, and the walk is depth- and count-limited.

- Supported files: `.mp3`, `.flac`, `.wav`, `.m4a`, `.aac`, `.ogg`, `.opus`
- The first run is a full pass; afterwards a file whose path, size and modification time are unchanged is neither rehashed nor reparsed
- Everything found appears as one system collection, `system:local-music` ("Local Music"), listed first in the library
- The device index lives under `.spotifie/device/` and is shared by everyone who opens Spotifie on that machine, guests included
- The index and artwork cache are rebuildable: delete `.spotifie/` and the next start rebuilds them from the files themselves

The audio always stays in the original files — nothing is copied into a database and nothing is Base64-encoded.

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

Optional:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_SITE_URL` | Where this installation is published, e.g. `https://example.com`. See below |
| `SPOTIFIE_MUSIC_LOCATIONS` | Extra folders to search, separated by the platform path delimiter |
| `SPOTIFIE_SCAN_DEBUG` | Set to `1` to log the folders the search visits |
| `SPOTIFIE_SCAN_CONCURRENCY`, `SPOTIFIE_SCAN_BUSY_CONCURRENCY` | Parallelism of the walk |
| `SPOTIFIE_SCAN_MAX_DEPTH`, `SPOTIFIE_SCAN_MAX_FILES` | Limits on how far and how wide the walk goes |

A service-role key must never be placed in this project, in `.env`, or in browser code.

## Being Found

The application answers `/robots.txt`, `/sitemap.xml` and `/llms.txt` itself, and fills each page's
canonical URL, social image and JSON-LD record in as the page is served.

All of it follows one setting. Set `PUBLIC_SITE_URL` to the origin this installation is published at and
the canonical URLs, the sitemap and the structured data use it. Leave it unset — or point it at this
machine — and nothing claims an address at all: no canonical, no `og:url`, and `/sitemap.xml` answers
404. That is deliberate; a canonical URL pointing at somebody's own computer is worse than none.

Nothing about a library is published. The structured record describes the application; the sitemap lists
the pages that are the same for everybody. Playlists, liked songs, local albums and the music on a device
appear in none of it.

## Running Locally

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

The server binds `127.0.0.1` by default, so the library is reachable from the machine it runs on and not from the network. The server reads `HOST` and `PORT` from the process environment, so export them before starting rather than relying on `.env` being loaded automatically.

Opening the HTML files with `file://` is not supported, and a separate static server will not work either: the frontend loads its Supabase settings from `GET /api/config` on the same origin, which only this server provides.

### "Port 3000 is already in use" / "/api/config was not found"

Both symptoms have one cause: another program is answering on the port, so the pages you are looking at are not being served by Spotifie. Stop the other server, or run Spotifie elsewhere:

```bash
PORT=3010 npm start
```

## Supabase Setup

1. Create a Supabase project.
2. Open the SQL Editor and run `supabase-setup.sql` in full. It is idempotent and safe to re-run. It creates the profiles table and its trigger, the `app_admins` authorization table, the catalogue tables, the private `catalog-audio` and `catalog-artwork` buckets, and the Row Level Security policies for all of them.
3. Put the project URL and anon key in `.env`.
4. Sign up so the trigger creates your profile.

Apply the SQL before signing in for the first time.

## Privacy

- Audio found on the device, and audio imported from it, is read from disk and streamed by the local server. It is never uploaded to Supabase or anywhere else
- The browser receives identifiers, tag data and URLs. Filesystem paths and Storage paths never leave the server
- A person's imported media is served only to that account, through a short-lived HMAC ticket
- Personal state — hidden content, personal edits to published albums, listening positions — lives in local state files, not in Supabase
- Theme and player preferences live in `localStorage`; collections and the cached copy of the published catalogue live in IndexedDB. That copy holds published descriptions only — no audio, no signed URL, and nothing belonging to an account
- Spotifie sets no cookies of its own and loads no analytics, advertising or tracking scripts

## Security

See [SECURITY.md](SECURITY.md) for the security architecture and how to report a vulnerability.

## Current Platform Scope

Spotifie is a web application served by a local Node server, run on the machine whose music it indexes. It is developed and tested on Node 18+, and the library layer sits behind an adapter interface so the filesystem backend is replaceable.

It is not a native iOS or Android application. The published catalogue requires network access to Supabase; there is no offline cache of it.

## Future Packaging / Roadmap

Clearly future work, not present behaviour:

- Desktop packaging around the existing local server
- Additional library adapters behind the existing `LibraryService` interface
- Formal accessibility audit against a WCAG conformance level

## License

See `LICENSE` if one is included with this release; otherwise all rights are reserved by the author.

Spotifie is an independent project. It is not affiliated with, endorsed by or connected to Spotify AB, and the Spotify name and logo are trademarks of Spotify AB.
