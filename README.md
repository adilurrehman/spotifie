# Spotifie

**Hybrid Local & Global Music Player**

Spotifie puts a published music catalogue and the music already on your own
device into one library, one search and one player, on the web and on Android.

> Spotifie is an independent project. It is not affiliated with, endorsed by or
> connected to Spotify AB. "Spotify" is a trademark of Spotify AB.

---

## 1. Current status

**Version 1.0.2** (see [CHANGELOG.md](CHANGELOG.md)).

1.0.2 is a hotfix for 1.0.1, which shipped a Supabase publishable key the
project rejects and so could not load the catalogue or sign anybody in.
**Do not install or distribute any 1.0.1 build.** A release now proves its
settings against the real project before anything is signed or deployed.

| Platform | Status |
| --- | --- |
| Web / PWA | **Released.** The 1.0.2 build is ready; deploying it is an operator step |
| Android | **1.0.2 not yet signed.** Until it is, the website offers no download at all, rather than the broken 1.0.1 APK |
| Google Play | **Not published.** Optional future work |
| iOS | **Prepared, not released.** Building it needs a Mac with Xcode; never compiled or run |
| Desktop | **Foundation only, not released.** Tauri shell; runtime verification still pending |

## 2. Production addresses

| What | Where |
| --- | --- |
| Public app | `https://spotifie.adilurrehmanofficial.workers.dev` |
| Supabase project | `https://pkntkyvdekaykhzfecky.supabase.co` |
| Android package | `app.spotifie.android` |

No key or secret belongs in this file. The Supabase publishable key is browser
configuration and is injected at build time, not stored here.

## 3. Architecture

**Global music.** A catalogue an administrator publishes: rows in Supabase,
audio and artwork in Supabase Storage. Media is fetched through short-lived
signed links; only the stable storage path is ever saved.

**Local music.** Audio on the person's own device, read where it already is and
never uploaded. In a browser it is a folder handed over through the File System
Access API; on Android it is one folder granted through the Storage Access
Framework, which needs no storage permission. Files are never copied, moved or
deleted.

**Player.** One player everywhere. On the web it is an HTML `<audio>` element;
in the Android app the audio belongs to Media3/ExoPlayer in a
`MediaSessionService`, so it keeps playing in the background and appears on the
lock screen. Exactly one engine is ever created, so nothing can play twice.

**Cache.** The device keeps a copy of the published catalogue's descriptions and
artwork so the library draws before the network answers. **No published audio is
ever downloaded.**

**Auth.** Supabase Auth. Signing in is optional; guests can browse and play the
published catalogue.

**Admin.** Authority is a row in `app_admins`, decided by the database. The
dashboard is not a public file: a Cloudflare Worker serves it only after it has
verified an administrator against Supabase.

**Account deletion.** In the app under Profile, and on the website at
`/delete-account.html`. Both call a Supabase Edge Function that reads who is
asking from a verified token; no client can name an account.

## 4. Database objects

`profiles`, `app_admins`, `catalog_albums`, `catalog_tracks`,
`public.is_admin()`, `public.admin_user_count()`.

Schema lives in `supabase-setup.sql` and is idempotent. `profiles.id` and
`app_admins.user_id` both reference `auth.users(id)` `ON DELETE CASCADE`, which
is what makes account deletion clean up after itself.

## 5. Storage buckets

`catalog-audio`, `catalog-artwork`. Both private; access is through signed
links.

## 6. Canonical ids

```
local:<stable-id>          a track on this device
global:<uuid>              a published track
global-album:<uuid>        a published album
system:local-music         the device's own collection
system:recently-played     the recently played collection
```

Namespaced so local and global ids can never collide.

## 7. Environment variables

Names only. Never commit values.

**Nothing in this project reads a `.env` file.** There is a `.env.example` to
copy from, but no loader: every one of these is read from the real environment
of whoever runs the command. A build therefore takes whatever the shell happens
to hold, which is how 1.0.1 was signed with a key the project rejects. Set them
deliberately for each release, and let the preflight confirm them.

Public settings, needed by any build that packages the frontend:

```
SUPABASE_URL
SUPABASE_ANON_KEY
PUBLIC_SITE_URL
```

Android signing, needed only when building a release:

```
SPOTIFIE_ANDROID_KEYSTORE
SPOTIFIE_ANDROID_KEY_ALIAS
SPOTIFIE_ANDROID_KEYSTORE_PASSWORD
SPOTIFIE_ANDROID_KEY_PASSWORD
```

Local server options: `HOST`, `PORT`, `MUSIC_ROOT`.

## 8. Android signing

| | |
| --- | --- |
| Approved certificate SHA-256 | `d0855d23abad6d890cc208c1075cea2bc3d7b057000f4e074a864a9913ea049a` |
| Key alias | `spotifie` |
| Pinned in | `android/release-signing.json` |
| Keystore location | **Outside this repository.** The build refuses a keystore inside it |

**Never generate a new signing identity for a normal update.** The keystore is
Spotifie's identity on Android: replace it and no existing installation can ever
be updated again. Back it up, with its passwords stored separately. A
fingerprint is public; a password never goes in a file here.

## 9. Versioning

`package.json` is the only place a version is written. Everything else derives
from it.

```
major*1000000 + minor*10000 + patch*100 + (rc N ? N : 99)

1.0.2  ->  Android versionCode 1000299
1.1.0  ->  1010099        2.0.0 -> 2000099
1.1.0-rc.1 -> 1010001
```

To release a new version, change `package.json` and nothing else. Android
refuses an update whose versionCode does not rise.

## 10. Commands

```bash
npm install
npm test                  # the whole suite

npm start                 # the local server (frontend + library API + /health)

npm run build:public      # the public web release into public-release/dist
npm run release:check     # verify that release carries nothing private

npm run build:mobile      # the Android frontend into mobile/www
npm run android:build     # debug APK (needs the Android SDK and a JDK 21)
npm run android:dev       # build and run on a device or emulator
npm run android:release   # signed release APK (needs the signing environment)
npm run android:bundle    # signed App Bundle

npm run build:ios         # the iOS frontend (runs on any OS)
npm run ios:sync          # also copy it into ios/ and check the Xcode project

npm run build:desktop     # the desktop frontend
npm run desktop:build     # unsigned Windows installer

npx wrangler deploy --dry-run   # verify a deploy without performing one
```

Deploying production is an operator task and is described in the private
operations notes kept outside the public release, not here.

## 11. Android toolchain

- **JDK 21.** The tooling finds it from `SPOTIFIE_ANDROID_JAVA_HOME`, then
  `JAVA_HOME`, then Android Studio's bundled runtime.
- **Android SDK** with build-tools and platform-tools. `adb` lives at
  `$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe` on Windows and
  `$ANDROID_HOME/platform-tools/adb` elsewhere. Prefer those variables to a
  hard-coded path.
- compileSdk 36, targetSdk 36, minSdk 26.

## 12. Releasing a future version

1. Back up the signing keystore and its passwords, separately.
2. Set the public settings in the environment.
3. Set the signing variables.
4. `npm test` - all green.
5. `npm run android:release` - it checks the configured Supabase settings
   against the real project first, and refuses to sign anything if the key is
   rejected or the project cannot be reached.
6. `npm run android:bundle`
7. Check the printed certificate matches the approved fingerprint. If it does
   not, stop.
8. Build and check the production website (private operations notes).
9. `npx wrangler deploy --dry-run`
10. Install the signed APK **over** the previous version, without uninstalling,
    and confirm it upgrades and keeps its data.
11. Owner approval.
12. Deploy.
13. Download the live APK and check its SHA-256 against the build output.

## 13. Security rules

Never commit: `.env`, `*.jks`, `*.keystore`, passwords, service-role keys,
database passwords, Cloudflare API tokens, the private administrator source,
anybody's music, or the private QA documents.

The Supabase **publishable** key is browser configuration, not a service secret.
A **service-role** key must never appear in any client, build output or
repository; the only place one exists is inside the Supabase Edge Function's own
environment.

The working repository is private. Publishing means copying a checked
`public-release/dist` into a **new, empty** repository, because deleting a file
does not remove it from history.

## 14. Account deletion

- In the app: Profile -> Delete account, confirmed by typing `DELETE`.
- On the web: `/delete-account.html`, which works with nothing installed.
- Backed by the Supabase Edge Function `delete-account`
  (`supabase/functions/delete-account/`), which derives the account from a
  verified token. A client cannot name an account.
- Deleting an account removes the account, its profile row and any administrator
  grant. **It never deletes music on the device**, the granted folder, or any
  file.

## 15. Offline behaviour

| | |
| --- | --- |
| Local Music | Plays offline, exactly as usual |
| Cached published albums | Visible offline, with artwork |
| Published audio | Needs a connection, and says so rather than failing quietly |

A failed refresh never erases a good cache.

## 16. Android media

Media3 / ExoPlayer inside a `MediaSessionService`, with a MediaStyle
notification: artwork, title, artist, previous, play/pause, next, **stop**, and
a seek bar.

| Action | Result |
| --- | --- |
| Press Home | Keeps playing; notification stays |
| Swipe out of Recents | Playback stops, service stops, notification goes |
| Notification stop | Playback stops, notification goes |
| End of queue | Session released, no stale notification |

## 17. Folder map

```
index.html, about.html, signin.html, ...  the pages
delete-account.html                       account deletion, needs nothing installed
js/                                       browser code (player, auth, catalogue, adapters)
css/, img/, favicons/                     assets
lib/                                      server-side library, catalogue and auth modules
worker/                                   the Cloudflare Worker
server.js                                 the local Node server
tools/                                    build, release and inspection tooling
test/                                     the node:test suite
supabase/functions/                       Supabase Edge Functions
supabase-setup.sql                        database schema and policies
android/                                  Capacitor Android project (Media3, SAF plugin)
ios/                                      Capacitor iOS project (prepared, unbuilt)
src-tauri/                                desktop shell
music/                                    local music root scanned by the library
```

Generated, never committed: `node_modules/`, `public-release/dist/`,
`mobile/`, `desktop/`, `android/app/build/`, `src-tauri/target/`, `.spotifie/`,
`.wrangler/`, `release-backup/`.

## 18. Private and recovery files

Operational records live beside this repository as `*.private.md` and are
git-ignored: the signing notes, the release records, production operations, the
Play readiness and store material, the account-deletion QA, and the Mac/iOS
handoff. Read those before a release.

If a personal secrets note (for example `spotiie-secrets.md`) exists, it belongs
**outside** this repository. It is git-ignored as a safety net; do not commit it.

Signed builds that were actually published are archived in `release-backup/`
with the records describing them. Keep that folder; never commit it.

## 19. Known limitations

- **Google Play is not live.** Nothing has been submitted.
- **iOS is prepared only** and needs a Mac with Xcode to compile, sign or run.
- **Desktop runtime verification is pending** (Windows Smart App Control).
- **Local Music on Android has not been verified offline end to end**, because
  granting a folder needs a person at the system picker.
- The release APK is signed with the v2 scheme only; v3 would additionally allow
  key rotation.

## 20. Outstanding actions

### Finishing the 1.0.2 hotfix

The source, the version, the documentation and the release preflight are done.
What remains needs either the signing keystore or a person at a form.

- [ ] **Deploy the 1.0.2 website**, following the operator procedure in the
      private operations notes. The build is made and checked.
- [ ] **Build and sign the 1.0.2 APK and AAB** with the **same permanent
      signing identity**, then archive them with their checksum records. Until
      this happens the website offers no Android download, which is deliberate:
      no download is better than the broken one.
- [ ] **Never distribute a 1.0.1 build.** They are kept only as a record.

### Needs a person, not a build

- [ ] Verify account deletion end to end with a **disposable** account, on the
      web page and in the app. It needs someone to sign in at the real form.
      Never use the administrator account.
- [ ] Decide the brand/trademark question and the Play App Signing strategy
      before any Play upload; both are irreversible afterwards, and neither
      affects the current direct-download release.

## License

Private and unlicensed (`"license": "UNLICENSED"` in `package.json`). All rights
reserved.
