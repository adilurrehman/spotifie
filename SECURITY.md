# Security Policy

## Supported versions

Spotifie is developed on a single line. Only the latest release receives security fixes.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No |

## Reporting a vulnerability

Please report security issues privately, and give the project a chance to fix them before they are described publicly.

- Open a **private security advisory** on the repository (Security → Report a vulnerability), or contact the maintainer through the address on the repository profile.
- Include what you did, what happened, and what you expected — enough for the behaviour to be reproduced.
- Expect an acknowledgement within a few days, and an assessment shortly after.

**Do not put credentials in an issue, a pull request, a discussion or a screenshot.** That includes access tokens, API keys, `.env` contents, database URLs and session cookies — your own as much as anyone else's. If demonstrating a problem seems to require one, say so in the report and it will be arranged privately instead. Anything posted publicly must be assumed compromised and rotated.

Please do not test against anyone else's installation, and do not access, modify or retain data that is not yours.

## Security architecture

**Authorization is decided on the server, always.**

Every privileged endpoint verifies the caller's Supabase access token against the Supabase Auth API, takes the user id from that verified answer, and checks it against the `app_admins` table. Nothing the browser can write takes any part in that decision — not a `localStorage` flag, not a request body, not a header of the caller's choosing. Editing the page's JavaScript changes what the page shows and nothing else.

The failure modes are distinct on purpose: no token, or one Supabase does not recognise, is `401`; a valid session belonging to somebody who is not an administrator is `403`. A check that cannot reach Supabase refuses the request rather than allowing it.

**Row Level Security enforces the same rules again.**

The server holds no service-role key, so every request it makes on a caller's behalf runs as that caller. The published catalogue is public to read and writable only by an account listed in `app_admins`; the Storage buckets are private and follow the same rule; profiles are readable and writable only by their owner. `app_admins` grants no `INSERT`, `UPDATE` or `DELETE` to `anon` or `authenticated`, so no account can add itself: an administrator is made by hand, in the database. A request that somehow reached a privileged handler without rights would still change nothing.

**Local audio stays local.**

Music found on the device, and music imported from it, is read from disk and streamed by the local server. It is never uploaded to Supabase or anywhere else. The browser receives identifiers, tag data and URLs — a filesystem path or a Storage path never leaves the server. Imports are limited in size, restricted to known audio extensions, and confined to their own directory by real-path checks that reject traversal and symlink escapes.

**The server binds loopback by default.**

`HOST` defaults to `127.0.0.1`, so the library is reachable from the machine it runs on and not from the network. Static serving works from a list of what may be served rather than a list of what may not: pages, `css/`, `js/`, `img/`, `favicons/` and `songs/`. The server's own source, its modules, the database script, the tests and the working data have no route at all. There is no directory listing, and traversal is rejected in every spelling.

**Media addresses are short-lived and never stored.**

Supabase Storage objects are reached through signed URLs generated on demand, used once, and never written to the database, to browser storage, or to the cached catalogue. Published artwork is served from the application's own origin at an address that names the version of the picture, so nothing signed reaches the page.

**Untrusted metadata is treated as text.**

Titles, artists, album names, descriptions, filenames and profile names all come from outside. They are escaped before being placed in markup, and names are written with `textContent` rather than assembled into HTML. Cover addresses are refused unless they are `http(s)` or this origin's own.

**Responses carry a content security policy.**

Scripts, connections, images and media are limited to this origin, the Supabase project and the one CDN the Supabase client is loaded from. Framing is refused outright. HSTS is deliberately not set: the server is meant to be reached over plain HTTP on loopback, and a deployment behind TLS adds it at the proxy.

## What is not a vulnerability

- The Supabase **anon key** appearing in browser configuration. It is a public, browser-safe project setting by design, and Row Level Security decides what it can reach. A **service-role key** in any client-visible place would be a serious issue — it belongs nowhere in this project.
- The absence of the administrator dashboard from a public release. That is packaging, not access control: the authorization above applies whether or not the dashboard is present.
