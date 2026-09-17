# Spotifie

**Hybrid Local & Global Music Player**

Spotifie puts a published global music catalogue and the music already on your
own device into one library, played through one player on desktop, tablet and
phone.

> Spotifie is an independent project. It is not affiliated with, endorsed by or
> connected to Spotify AB. "Spotify" is a trademark of Spotify AB.

---

## What this release is

This is the part of Spotifie a listener uses: the pages, the player, and the
local runtime that can serve them. It contains no route or page that can write
to the published catalogue. The database policies that enforce that are in
`supabase-setup.sql`.

If you run your own copy, the catalogue is yours. Create a Supabase project,
apply the schema, and make an account an administrator in the database. See
[SECURITY.md](SECURITY.md) for how authorization is decided.

Native phone apps are not part of this release. iOS support is in preparation
for the future, and Spotifie is not available as an iPhone app.

## Two ways to run it

| | Web app | Local runtime |
| --- | --- | --- |
| How | These files on any static host; the catalogue is read straight from Supabase | `npm start`: one Node server on your own machine |
| Global catalogue | Yes | Yes |
| Sign up, sign in, password reset | Yes | Yes |
| Local Music | A folder you choose in the browser | Automatic discovery of your music folders |
| Local tracks without a connection | Yes, once the app has loaded | Yes |
| Liked songs, playlists, history, backups | Not stored yet on the web-only copy | Yes |
| Custom album covers | Needs the local runtime | Yes |

## Features

- **Global catalogue:** artwork, descriptions and streaming, fetched through
  short-lived signed URLs.
- **Local Music:** one collection listed first in the library, fed by a folder
  you choose or by the local runtime's discovery. Songs are never uploaded,
  and forgetting a folder never deletes a file.
- **Player:** one canonical player with an expanded Now Playing view; shuffle
  and repeat; keyboard-operable seek and volume; Media Session; resume where
  each track stopped.
- **Library:** search, album pages, artists, Recently Played and Recently
  Added, liked songs, playlists, your own albums, and personal edits to
  published albums.
- **Interface:** light and dark themes, responsive layouts from 320 px, keyboard
  navigation, accessible names and reduced motion. Installable as a web app,
  with an offline app shell.

## Privacy

- Audio from your device is read where it is and never uploaded.
- A chosen folder is the only part of the device the web app can read.
- The browser receives ids and URLs, never filesystem or storage paths.
- No analytics, advertising or tracking scripts.
- The only Supabase values in the browser are the project URL and the
  publishable key. Both are public by design.

## Browser limitations

- Choosing a folder needs the File System Access API (desktop Chromium
  browsers). Other browsers can still play the global catalogue.
- The global catalogue needs a network connection. Only local music plays
  offline.
- A page on a web address can reach a local runtime at `http://127.0.0.1` only
  where the browser allows it.

## Running the local runtime

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Then open `http://127.0.0.1:3000`. Set the variables below in the environment
the server runs in.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL (public) |
| `SUPABASE_ANON_KEY` | Supabase anon or publishable key (public). Never a service-role or secret key |
| `PUBLIC_SITE_URL` | Where this copy is published. Drives canonical URLs and the sitemap |
| `HOST`, `PORT` | Interface and port (defaults: `127.0.0.1`, `3000`) |
| `MUSIC_ROOT` | Music folder to search (default `./music`) |
| `SPOTIFIE_MUSIC_LOCATIONS` | Extra folders to search |

## Hosting as a static site

This directory is also a complete static site. Every file a static host needs
is here:

- `config.json` and `js/config.js`;
- `_headers`;
- `.assetsignore`, which keeps the Node files out of the upload;
- `robots.txt` and `llms.txt`, plus `sitemap.xml` when the build knew its
  address.

## Supabase setup

1. Create a Supabase project.
2. Run `supabase-setup.sql` in the SQL Editor. It is idempotent.
3. Put the project URL and publishable key in the environment.
4. Sign up, and a database trigger creates your profile.

## Security

See [SECURITY.md](SECURITY.md) for the security architecture and how to report
a vulnerability.

## License

See `LICENSE` if one is included with this release. Otherwise all rights are
reserved by the author.

Spotifie is an independent project. It is not affiliated with, endorsed by or
connected to Spotify AB, and the Spotify name and logo are trademarks of
Spotify AB.
