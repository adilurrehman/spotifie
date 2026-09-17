// Spotifie's desktop shell.
//
// One window showing the same web application every other copy runs, loaded
// from the files bundled into the executable. The shell registers no commands
// and no plugins, so the page inside it has no filesystem, shell or process
// access beyond what the web platform itself gives it. Native capabilities
// (scoped music-folder scanning, reveal-in-Explorer) are added here later, one
// command at a time, and announced to the page through
// window.__SPOTIFIE_DESKTOP__ so js/desktopNative.js can detect them.

// No console window behind the application in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Spotifie could not start");
}
