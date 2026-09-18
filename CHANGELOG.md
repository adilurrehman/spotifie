# Changelog

All notable changes to Spotifie are recorded here. Versions follow
[Semantic Versioning](https://semver.org/); release candidates carry an
`-rc.N` suffix.

## [1.0.2] - 2026-09-18

A hotfix. It replaces 1.0.1, which could not reach Supabase at all.

### Spotifie can reach its own catalogue again

- **1.0.1 shipped a Supabase publishable key the project rejects.** Every copy
  of 1.0.1 - the website, the PWA, the signed APK and the signed App Bundle -
  answered `Invalid API key` to anything that needed Supabase, so the published
  catalogue never loaded and nobody could sign in or delete an account. Local
  Music was unaffected throughout, because it never uses Supabase.
- 1.0.2 is built with the key the project accepts. **Do not install or
  distribute the 1.0.1 APK**; it is kept only as a record of what was built.

### A release now proves its settings before it is signed

- Every check 1.0.1 passed asked about the *shape* of the key: present, not a
  secret, not a placeholder, long enough. None asked Supabase whether the key
  was real, so a signed release went out that could not work.
- Building a signed APK or App Bundle, or a production website, now begins by
  reading one row of the published catalogue with the configured settings. A
  key the project rejects, or a project that cannot be reached, stops the
  release **before anything is signed or deployed**. The key itself is never
  printed.

### Unchanged

- The signing identity is the same permanent key. 1.0.2 installs over 1.0.1 as
  an ordinary update.
- `v1.0.1` stays exactly where it is. Nothing was rewritten or removed.

## [1.0.1] - 2026-09-17

**Superseded by 1.0.2.** The release configuration carried an invalid Supabase
publishable key, so the catalogue, signing in and account deletion all failed
in this version. Its artifacts must not be distributed.

### You can delete your account

- **Delete your account from inside Spotifie**, under your profile. It asks you
  to type `DELETE` first, says exactly what goes and what stays, and cannot be
  triggered by one stray tap.
- **Or from the website**, at `/delete-account.html`, which works whether or not
  you still have Spotifie installed.
- Deleting an account removes the account, the profile held for it, and any
  administrator rights it had. **It does not delete the music on your device** -
  your files and the folder you chose stay exactly as they are.
- A deletion that fails leaves you signed in and tells you why, in words rather
  than error codes.

### The privacy page says what Spotifie actually does

- It no longer describes a local server indexing and streaming your audio, which
  is not how the app works. It now describes Android's folder picker, the
  published catalogue and its short-lived links, what is cached on your device,
  exactly what an account holds, and that there is no advertising identifier and
  no location, camera, microphone or contacts access.
- A new **Deleting Your Account** section links straight to the deletion page.

## [1.0.0] - 2026-09-17

The first stable release. Spotifie is one library, one search and one player
over two sources: a published catalogue anyone can browse, and the music
already on your own device.

**What you can do with it**

- **One library from two sources.** Published albums with artwork and
  descriptions, and Local Music read from your own device - never uploaded,
  never copied, never altered.
- **On the web, and installed.** It runs in the browser and installs as a PWA
  with its own window and an offline shell.
- **On Android**, as a signed APK from the website. Not on Google Play.
- **Local Music on Android** uses the system folder picker, so the app reads
  the one folder you chose and asks for no storage permission.
- **Playlists, liked songs, recently played and history**, kept on your own
  machine rather than in an account.
- **Opens without waiting.** A return visit draws the library from what the
  device already has, then quietly checks for changes.
- **Works offline.** Local Music plays as usual, and published albums stay on
  screen from the last catalogue the device saw; their songs say when they
  need a connection.
- **Background playback on Android**, with a media notification and lock-screen
  controls: previous, play/pause, next and stop. Closing the app from Recents
  stops the music; pressing Home does not.
- **Built for a phone.** The page is never wider than the screen, and the
  layout holds at large system font sizes.

### Release hardening (P18)

- **The README says what Spotifie actually is.** The Android section no longer
  describes a debug build that "has not yet been verified on a device", and it
  lists the permissions the app really asks for - network access plus what
  background playback needs - rather than claiming it asks only for the
  network.
- **Failures are reported in words a person can use.** Importing or opening a
  backup that cannot be read now says so plainly; the parser's own complaint
  and any status code stay in the console, where they are useful.
- **A diagnostic that was printed on every restore** is behind the same debug
  gate as the rest, so an ordinary console stays quiet.
- **The card-size control has a name** for anyone using a screen reader.
- **New regression tests** hold the long-name behaviour in place: what is drawn
  is clipped rather than allowed to grow, metadata is escaped wherever it is
  written into markup, and a row still carries its whole name for anyone who
  asks.

### Stopping the music, and opening the app without waiting (P17B)

- **The Android media notification has a stop control.** It carries Android's
  own stop icon, drawn by Media3 from a command of Spotifie's own rather than
  a character typed into the text. Pressing it stops the music, lets the track
  go, leaves the foreground and takes the notification with it - it does not
  merely hide the notification and leave audio running where nobody can see
  it. The process itself is left to Android; nothing kills it.
- **Closing Spotifie now closes the music.** Swiping it out of Recents stops
  playback, stops the media service and removes the notification. Pressing
  Home is unchanged and always will be: the music keeps playing and the
  notification stays, which is the whole point of background playback.
- **A stopped session never leaves a notification behind**, whether it ended
  at the stop button, at the end of the queue, or because the app was closed.
- **The page and the notification cannot disagree.** When Android stops the
  session the player hears about it and draws its controls from what the
  engine actually says - no phantom progress, no stale "playing", and no
  second idea of playback invented anywhere.

### Opening without waiting, and working without a connection

- **A return visit draws the library before Supabase is asked anything.** The
  copy this device keeps of the published catalogue is drawn first, joined to
  the music the machine can see for itself; the catalogue is checked
  afterwards and redrawn only if it moved.
- **Being offline is decided by what requests actually do.** `navigator.onLine`
  is a hint and no more - it is true on a network with nothing behind it, true
  when a name will not resolve, and true when Supabase itself is down - so the
  requests Spotifie depends on now report what happened to them.
- **A published album kept from last time still opens offline.** Its cover and
  its words are there, with one restrained line saying its songs need a
  connection. No fake tracks, and no stale signed address handed to the player.
- **A published song is not attempted without a connection**, so there is no
  request that was always going to fail and no error to apologise for.
- **The connection coming back checks the catalogue again**, in the
  background, one check at a time. Nobody has to reopen the app.
- **A bad moment can no longer replace a good copy with nothing.** An empty
  catalogue is only written down when the read positively said the published
  catalogue was there.
- Local Music is untouched by all of this: it is read from the device and
  played from the device, with no Supabase anywhere in its path. No published
  audio is cached, downloaded or converted - this keeps descriptions and
  covers, and not one second of sound.

### The page cannot be dragged sideways on a phone

- **The main column no longer asks for the width of the window.** Where the
  library is a drawer, it took the whole window width and then added its own
  margin, which is a page wider than the screen. It now takes the row it sits
  in and is allowed to be narrower than its widest row.
- **The player bar is held to both edges** rather than given a width measured
  from the window, at phone and tablet widths, and it keeps clear of whatever
  the device reserves down its sides when the phone is on its side.
- **Full-screen views fill their own view, not the window.** Now Playing and
  the drawer no longer measure themselves against the window, which takes no
  notice of a rounded corner or a notch.
- **The guard behind all of that** now covers the document as well as the
  body, so a long word or a menu opened hard against the edge cannot turn the
  page into something that pans. It uses `clip`, which does not make a scroll
  container, with `hidden` left before it for older WebViews.
- Checked at 320, 340, 360, 375, 384, 393, 400, 412 and 430 px, in landscape,
  and on the Android app: the page is exactly as wide as the screen, and a
  horizontal swipe moves nothing.

### Android background playback and lock-screen controls (P17A)

- **Android plays the music itself.** The app's audio is now an AndroidX
  Media3 session (ExoPlayer) in a media-playback foreground service, so it
  keeps playing when Spotifie is in the background or the screen is off.
  - Android's own media notification shows the track, the artist and the
    artwork, with previous, play/pause and next.
  - The lock screen, the notification shade, Bluetooth and headset buttons
    all control it.
  - Audio focus, pausing when headphones are unplugged, and the wake lock
    needed to keep a stream alive are handled by ExoPlayer.
- **One engine per platform, never two.** The player picks its engine once:
  the browser's audio element everywhere else, the native session in the
  Android app, where no audio element is created at all. The web and PWA
  keep the browser Media Session exactly as before; on Android it steps
  aside so the two cannot disagree.
- **The application still decides everything else.** The queue, shuffle,
  repeat and what plays next stay in one place for every platform. Next and
  previous from the lock screen are handed back to Spotifie, so they do what
  its own buttons do. The service keeps no second queue.
- **Both kinds of track play natively.** A published track streams from its
  short-lived signed address; a track on this device plays in place from the
  `content://` the person granted through the folder picker. Nothing is
  copied, re-encoded or uploaded.
- **Coming back.** A page that opens, or a window Android recreated, asks the
  player what is actually playing and draws the controls from the answer,
  rather than assuming silence. Swiped out of Recents, the music carries on
  while it is playing and stops when it is not.
- **Permissions.** `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
  and `WAKE_LOCK`, plus `ACCESS_NETWORK_STATE`, which ExoPlayer declares to
  watch the connection while streaming. No notification permission is needed
  or requested: a media session's notification is exempt.

### Android release engineering (P16)

- **One version authority.** `package.json` is the only place a version is
  written.
  - Android `versionName` is it as written.
  - Android `versionCode` is derived and only ever rises
    (`major*1000000 + minor*10000 + patch*100 + (rc N or 99)`, so
    `1.0.0-rc.1` is 1000001).
  - iOS and the download metadata use the same version.
- **Release signing from the environment only.**
  - `SPOTIFIE_ANDROID_KEYSTORE`, `SPOTIFIE_ANDROID_KEY_ALIAS`,
    `SPOTIFIE_ANDROID_KEYSTORE_PASSWORD` and `SPOTIFIE_ANDROID_KEY_PASSWORD`.
  - Gradle and the release tool refuse to build a release without them. They
    also refuse a keystore inside the project and the debug key. There is no
    unsigned or debug-signed fallback.
  - Keystore and signing-file patterns are git-ignored.
- **`npm run android:release` / `npm run android:bundle`.**
  - They build the signed release APK or App Bundle.
  - They verify the signature (`apksigner`, `jarsigner`) and that it is not
    the debug certificate, plus package, version, permissions (`INTERNET`
    only) and contents: no admin source, secrets, keystore, signing password
    or machine paths.
  - They write a verification record beside the artifact.
- **The website offers only the signed release APK.**
  - It is never the debug APK.
  - It is offered only when the verification record matches the file and the
    signing certificate matches the one pinned in
    `android/release-signing.json`. Otherwise the site builds with no download.
  - `/downloads/android-release.json` describes the release: version,
    versionCode, size, SHA-256, minimum Android, certificate fingerprint.
  - The download panel shows the version, size and SHA-256 checksum.
- **Not on Google Play.** The App Bundle is prepared for it but is not
  published there, and never offered on the website.

### iOS preparation (P15)

- **Scope.** An iOS project (`ios/`, Capacitor 8, Swift Package Manager, no
  CocoaPods) wraps the same frontend. It has **not** been compiled, signed or
  run. That needs Xcode on a Mac.
- **Identity.**
  - Bundle id `app.spotifie.ios`; Android keeps `app.spotifie.android`.
  - Version `1.0.0` (from `package.json` `1.0.0-rc.1`).
  - The icon is the Spotifie mark on an opaque 1024 px tile, and the launch
    screen is plain dark.
- **Adapters.**
  - `js/iosNative.js` is the iOS adapter, recognised by Capacitor's bridge
    only.
  - `js/nativeLibrary.js` is the Local Music library now shared by the
    Android and iOS apps, extracted unchanged from the Android adapter.
- **Local Music on iOS.**
  - The document picker, with security-scoped bookmarks kept on the device
    only.
  - A "Choose music files" fallback where a Files provider will not list a
    folder.
  - FLAC, Ogg and Opus are offered only when the player says it can play
    them.
- **Auth.**
  - Login stays in the app, including on the sign-in pages that load no
    adapter.
  - Confirmation and reset emails return to `app.spotifie.ios://auth/callback`.
    The Android app's sign-up and forgot-password pages now also use the app's
    own callback.
  - Both addresses must be added to Supabase's Redirect URLs.
- **Native settings.**
  - `AVAudioSession` `.playback`, the `audio` background mode, and the URL
    scheme.
  - A privacy manifest: no tracking; file timestamps for user-chosen files;
    email and user id for sign-in.
  - No camera, microphone, location, contacts, photos or tracking permission,
    and no arbitrary HTTP.
- **Safe areas.** Public pages use `viewport-fit=cover`. The drawer and
  full-screen Now Playing keep clear of the notch and the home indicator.
- **Build and checks.** `npm run build:ios` and `npm run ios:sync` build and
  inspect the iOS frontend and project. They refuse:
  - an APK, admin source, private docs, `.env`, signing material, audio or
    service-role keys;
  - a Team ID committed to the project.

  A public release refuses an `ios/` directory.

### Installable app

- The manifest now includes 192 px and maskable icons. They are made from the
  existing mark, with its wave shown white on the dark tile.
- An **Install** action appears only when the browser offers installation. It
  is hidden once installed or inside the desktop shell. A "not now" is
  respected for two weeks.
- An **Update available** notice appears when a newer build is served or a new
  service worker takes over. Reloading is the person's choice.
- The header shows a persistent **Offline** label that says what still works.
- The offline app shell now also keeps the settings script, the catalogue
  reader and the new modules.
- The page is marked with its display mode (browser, standalone or desktop),
  for layout only.

### Desktop foundation

- A Tauri 2 shell for Windows wraps the same frontend. It has least privilege:
  core window permissions only, and no filesystem, shell or process access.
- `npm run build:desktop` produces a strict, admin-free frontend with its own
  content security policy, inspected before packaging.
- `npm run desktop:dev` and `npm run desktop:build` produce an unsigned NSIS
  installer. Machine paths are remapped out of the binary, and the output is
  checked for leaks.
- A desktop adapter and feature-detected Local Music capabilities
  (`platform.localMusicFeatures()`) have been added, so the interface asks
  what is possible instead of which browser it runs in.
- The admin dashboard item is not offered inside the shell. Administration
  stays on the protected web dashboard.

### Android foundation

- A Capacitor 8 Android project (`app.spotifie.android`) wraps the same
  frontend. `npm run build:mobile` reuses the strict, admin-free shell build.
- Local Music on Android goes through the Storage Access Framework, with an
  in-repo read-only plugin:
  - folder picker and persistable read grants;
  - recursive scan and tags for new or changed files only;
  - stable IDs and incremental rescans;
  - forgetting a folder releases the grant and never touches files.

  It sits behind the same interface as the browser folder library.
- `AndroidNativeAdapter` adds feature-detected capabilities:
  - `canReadLocalAudio`, `canUseBackgroundAudio`, `canUseMediaControls`;
  - `canShareFile`, `canPersistFolderAccess` and the others.

  Background audio and system media controls are reported as unavailable
  until a native media service is added.
- The hardware Back button closes overlays, then Now Playing, then goes back a
  view, and minimizes the app only at the root.
- Least privilege and hardening:
  - `INTERNET` is the only permission requested;
  - no storage permission;
  - HTTPS only (cleartext disabled);
  - Android backup and device transfer are disabled.
- `npm run android:build` produces a debug APK and inspects it. The build
  fails on administrator source, server files, audio, secrets or machine
  paths.
- The admin dashboard item is not offered in native shells.

### Android app download on the website

- The website header has a **Download Android App** action. It opens a short
  panel with the app's version, taken from the build, and a restrained note:
  "Android APK - direct installation". The panel's link saves the file as
  `Spotifie-Android.apk`, and the browser downloads it itself.
- The action is shown in browser tabs and installed web apps. It is never
  shown inside the Android app or the desktop app. The web-app install action
  is now labelled **Install Web App**, so the two are not confused.
- `npm run build:production` copies the Android debug APK to
  `/downloads/spotifie-android.apk` only if it exists, and records it in the
  build metadata. Without an APK, the site still builds and offers no
  download, so there is never a broken link. `npm run build:public`, the
  desktop build and the Android web bundle never carry an APK.
- `_headers` sends the APK as `application/vnd.android.package-archive`, as
  an attachment. The service worker never caches it.
- `release:check:production` allows exactly that one file. It opens and
  inspects the APK, and requires it to be offered exactly when it is present.
  It refuses anything else under `downloads/`, any part of the Android
  project, and signing material (`.jks`, `.keystore`, `*.properties`, `.aab`,
  `google-services.json`).

### Tests leave deployable output alone

- `npm test` no longer rewrites `worker/generated/adminDocument.mjs` or
  `public-release/dist`. `test/security.test.js` was the only culprit. It
  built the release with the builder's defaults, which wrote the public-mode
  dashboard document (about 56 KB) over the production one (about 137 KB), and
  replaced the whole release directory. It now builds into a throwaway
  temporary directory and removes it afterwards, once the released server it
  starts has exited. A regression test compares the exact bytes of both
  artifacts before and after that build. `npm run build:public` and
  `npm run build:production` behave as before.

### Android fixes (P14.1)

- **Signing in stays inside the app.** After sign-in, the Android app used to
  navigate to the published site's address, which is a different host from
  the app's `https://localhost`. Android then handed that address to Chrome.
  Inside a native shell, "home" now means the app itself. Links in emails can
  return to the app through `app.spotifie.android://auth/callback`.
- **Sign-in pages recognise the app, too.** The first fix asked only
  Spotifie's shell adapters whether it was running inside a shell. The
  sign-in, sign-up and password pages load no adapter, so a successful
  email/password sign-in still went to the published site, and Android still
  opened it in Chrome. The session module now also asks Capacitor's bridge,
  or Tauri's, which every page of the app has. Signing in, and a restored
  session on those pages, now land on `https://localhost/`. Tests run the real
  sign-in page, including Supabase's `SIGNED_IN` event, and fail on any
  browser opened or any address outside the app.
- **The Admin Dashboard appears for a verified administrator on every
  platform.** The rule is the database's answer, not which shell is running.
- In the app, the dashboard opens inside Spotifie. It uses a separate in-app
  browser view (`@capacitor/inappbrowser`) on the protected site, with no
  access to the phone's native bridge. The app still carries no dashboard
  source, and the site's worker gate is unchanged. Back returns to Spotifie.
- **Touch screens no longer show a three-dot circle on every album cover.** A
  long press on a card opens the same options menu. A tap still opens the
  album. The right mouse button and the keyboard's menu key reach the menu
  too. Mouse users keep the hover button.
- Android's minimum version is now 8.0 (API 26), which the in-app browser
  requires.

## [1.0.0-rc.1] - 2026-09-14

The first release candidate. Spotifie is feature-complete for its first public
release. This candidate is for final QA before 1.0.0 and before any desktop or
mobile packaging.

### Highlights

- **A hybrid library.** A published global catalogue and the music on your own
  device, in one library behind one player.
- **Two ways to run.** A web app hosted on Cloudflare, reading the catalogue
  straight from Supabase, and a local Node runtime that also indexes and
  streams the music on that machine.
- **Local-first.** Audio from your device is read in place and never uploaded.

### Features

- **Global catalogue:** albums and tracks published by an administrator. Guests
  and signed-in listeners can both browse and play them. Metadata lives in
  Supabase tables and media in private Storage buckets, reached only through
  short-lived signed URLs.
- **Local Music in the browser:** you choose a folder with the browser's folder
  picker (Chromium browsers). Songs are indexed in IndexedDB, rescans are
  incremental, and folders can be reconnected or forgotten. Forgetting a folder
  never touches the files.
- **Local runtime:** background discovery of the usual music folders,
  incremental rescans, private per-account imports, and a Manage Local Music
  view.
- **Accounts:** Supabase sign-up, sign-in, sign-out, password reset and session
  restore, with profiles created by a database trigger. Guest listening is
  supported.
- **Personal library:** liked songs, playlists (create, rename, describe,
  re-cover, reorder), Recently Played, Recently Added, artists, your own
  albums, and personal edits to published albums. Backups can be exported and
  imported.
- **Player:** one canonical player shared by the desktop, tablet and phone
  layouts, plus an expanded Now Playing view. It has shuffle, three repeat
  modes, seek and volume sliders you can use from the keyboard, Media Session
  integration, and it remembers where each track stopped.
- **Interface:** light and dark themes, responsive layouts from 320 px up,
  keyboard navigation, visible focus, accessible names and reduced-motion
  support.
- **Offline:** an app-shell service worker, and local tracks keep playing
  without a connection.
- **Discoverability:** page metadata, Open Graph and Twitter cards, JSON-LD,
  `robots.txt`, `sitemap.xml`, `llms.txt` and an installable web app manifest.

### Administration

- A catalogue dashboard for publishing, editing and deleting albums and tracks,
  including artwork, audio and descriptions.
- On the hosted deployment the dashboard is served only after the server has
  verified the account with Supabase. Row Level Security remains the boundary
  for every write.
- The dashboard's Total Users card now shows the number of registered accounts,
  from an administrator-only aggregate function. Before, it counted only the
  profile rows the viewer was allowed to see.

### Release engineering

- Two builds. `npm run build:public` produces the sanitized public release, and
  a separate private build produces the hosted deployment.
- Build guards. Deploying builds refuse to run when public settings are missing
  or still hold placeholder values. They name the setting and never print a
  value.
- `npm run release:check` rejects secrets, private files, user audio and
  administrator source in anything meant to be published.
- `robots.txt`, `sitemap.xml`, `llms.txt`, canonical URLs and structured data
  are now written into the static build, so a hosted copy has them without a
  server.
- Diagnostic console output is off by default. It can be turned on per browser
  with `localStorage.setItem('spotifie_debug', '1')`.

### Known limitations

- Choosing a music folder needs the File System Access API. That means desktop
  Chrome, Edge or another Chromium browser; other browsers can still play the
  global catalogue.
- On the web-only deployment, liked songs, playlists, history, backups and
  custom album covers are not stored yet. They need the local runtime. The web
  app says so instead of failing silently.
- The global catalogue needs a network connection. Only local music plays
  offline.
