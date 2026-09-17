/**
 * Spotifie inside its desktop shell.
 *
 * The desktop application is this same web application, loaded by a small
 * native shell (Tauri) instead of a browser tab. There is one frontend: the
 * player, the catalogue, signing in and the library are the files every other
 * copy runs. This file is the one place the rest of the application learns
 * that it is inside the shell, and what the shell can do there.
 *
 * Both are asked, never assumed. The shell is recognised by the bridge it
 * injects, not by a user-agent string, and each native capability is reported
 * only when the shell says it offers the command behind it. The shell
 * announces those commands in window.__SPOTIFIE_DESKTOP__.commands.
 *
 * This first shell offers no native command at all. It grants no filesystem,
 * shell or process permission, so every native capability below answers
 * false and Local Music uses the same folder picker the browser offers. When
 * scoped native folder scanning is added to the shell, it is switched on here
 * and nowhere else.
 */
(function (global) {
    'use strict';

    // The commands a future shell may offer, by what they let the application
    // do. Nothing here calls them yet.
    var COMMANDS = {
        chooseFolders: 'choose_music_folders',
        scanFolders: 'scan_music_folders',
        openTrack: 'open_local_track',
        revealFile: 'reveal_file'
    };

    /** Running inside the desktop shell? Recognised by the bridge it injects. */
    function isDesktop() {
        return Boolean(global.__TAURI_INTERNALS__);
    }

    /** Does this shell offer one named command? */
    function offers(command) {
        if (!isDesktop()) return false;
        var described = global.__SPOTIFIE_DESKTOP__;
        return Boolean(described && Array.isArray(described.commands) && described.commands.indexOf(command) !== -1);
    }

    /**
     * The native half of the platform, as one adapter.
     *
     * Only capabilities for now. The methods that scan and read folders arrive
     * with the commands behind them, in the same shape the other adapters use.
     */
    function DesktopNativeAdapter() {}

    DesktopNativeAdapter.prototype.name = 'desktop-native';

    DesktopNativeAdapter.prototype.available = function () {
        return isDesktop();
    };

    /** What the shell can do, one plain yes or no each. Safe to show or log. */
    DesktopNativeAdapter.prototype.capabilities = function () {
        return {
            canUseNativeFilesystem: offers(COMMANDS.scanFolders),
            canChooseDirectory: offers(COMMANDS.chooseFolders),
            canScanManagedFolders: offers(COMMANDS.scanFolders),
            canPersistFolderAccess: offers(COMMANDS.chooseFolders),
            canOpenLocalTrack: offers(COMMANDS.openTrack),
            canRevealFile: offers(COMMANDS.revealFile)
        };
    };

    /**
     * Open the protected dashboard on the published site. The shell carries
     * no dashboard; the site's worker verifies the administrator itself.
     * A window of its own where the shell allows one, so the app stays where
     * it was; otherwise this window goes there.
     */
    function openAdmin(url) {
        var opened = null;
        try {
            opened = global.open(url, '_blank');
        } catch (e) {
            opened = null;
        }
        if (!opened && global.location) global.location.assign(url);
        return true;
    }

    global.spotifieDesktop = {
        isDesktop: isDesktop,
        openAdmin: openAdmin,
        offers: offers,
        adapter: new DesktopNativeAdapter(),
        DesktopNativeAdapter: DesktopNativeAdapter,
        COMMANDS: COMMANDS
    };
})(typeof window !== 'undefined' ? window : globalThis);
