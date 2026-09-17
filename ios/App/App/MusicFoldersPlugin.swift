import AVFoundation
import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

/// The music a person chose in the Files app, for Spotifie's Local Music.
///
/// The person picks a folder - or, where a Files provider will not list a
/// folder, some songs - in the system document picker. iOS grants access to
/// exactly that, and the plugin keeps a security-scoped bookmark so the grant
/// survives a restart. No permission prompt is involved and none is declared:
/// nothing outside what was chosen is reachable.
///
/// What this never does: write, move or delete a file, copy audio anywhere,
/// encode it, or send it anywhere. It lists files, reads their tags, and hands
/// back file addresses the web view plays in place. The bookmarks stay in the
/// app's own container, excluded from backup, and are never sent anywhere.
///
/// The same JavaScript interface as the Android plugin of the same name
/// (android/app/src/main/java/app/spotifie/android/MusicFoldersPlugin.java), so
/// one library (js/nativeLibrary.js) drives both.
///
/// NOT YET COMPILED OR RUN: written on Windows. Build and test it on a Mac
/// before relying on it - see P15_MAC_HANDOFF.private.md.
@objc(MusicFoldersPlugin)
public class MusicFoldersPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "MusicFoldersPlugin"
    public let jsName = "MusicFolders"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFolders", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readTags", returnType: CAPPluginReturnPromise)
    ]

    /// What counts as music: the same list every other part of Spotifie uses.
    /// Which of these the web view can actually play is decided by the page.
    private static let audio: Set<String> = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"]

    /// A folder chosen by mistake (a whole drive) must not become an endless walk.
    private static let maxDepth = 8
    private static let maxFiles = 5000

    /// One thing the person chose: a folder, or a set of songs.
    private struct Source: Codable {
        let id: String
        var name: String
        let kind: String
        var bookmarks: [Data]
    }

    private var sources: [Source] = []
    /// The addresses whose security-scoped access is open, per source. Kept
    /// open while the app runs, so the web view can read the files it plays.
    private var opened: [String: [URL]] = [:]
    private var pendingCall: PluginCall?
    private var pendingKind = "folder"
    private let queue = DispatchQueue(label: "app.spotifie.ios.music-folders")

    override public func load() {
        queue.async {
            self.sources = self.readSources()
            for source in self.sources {
                self.openAccess(source)
            }
        }
    }

    // ============================================
    // Choosing, listing and forgetting
    // ============================================

    @objc func pickFolder(_ call: PluginCall) {
        present(call, kind: "folder")
    }

    @objc func pickFiles(_ call: PluginCall) {
        present(call, kind: "files")
    }

    private func present(_ call: PluginCall, kind: String) {
        DispatchQueue.main.async {
            guard self.pendingCall == nil else {
                call.reject("A picker is already open.", "BUSY")
                return
            }

            let types: [UTType] = kind == "folder" ? [.folder] : [.audio]
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.allowsMultipleSelection = kind == "files"
            picker.delegate = self

            self.pendingCall = call
            self.pendingKind = kind
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingCall?.reject("Nothing was chosen.", "CANCELLED")
        pendingCall = nil
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        let kind = pendingKind

        queue.async {
            var bookmarks: [Data] = []
            for url in urls {
                let started = url.startAccessingSecurityScopedResource()
                defer {
                    if started { url.stopAccessingSecurityScopedResource() }
                }
                if let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                    bookmarks.append(data)
                }
            }

            guard !bookmarks.isEmpty else {
                call.reject("iOS did not grant lasting access to that choice.", "NOT_PERSISTED")
                return
            }

            // The same folder chosen again is the same folder, with its grant renewed.
            if kind == "folder", let chosen = urls.first,
               let index = self.sources.firstIndex(where: { $0.kind == "folder" && self.resolve($0).first?.standardizedFileURL.path == chosen.standardizedFileURL.path }) {
                self.closeAccess(self.sources[index].id)
                self.sources[index].bookmarks = bookmarks
                self.writeSources()
                self.openAccess(self.sources[index])
                call.resolve(["uri": self.sources[index].id, "name": self.sources[index].name])
                return
            }

            let name: String
            if kind == "folder" {
                name = urls.first?.lastPathComponent ?? "Music"
            } else {
                name = urls.count == 1 ? urls[0].deletingPathExtension().lastPathComponent : "\(urls.count) chosen songs"
            }

            let source = Source(id: (kind == "folder" ? "ios-folder:" : "ios-files:") + UUID().uuidString, name: name, kind: kind, bookmarks: bookmarks)
            self.sources.append(source)
            self.writeSources()
            self.openAccess(source)
            call.resolve(["uri": source.id, "name": source.name])
        }
    }

    /// What iOS still lets the app read.
    @objc func listFolders(_ call: PluginCall) {
        queue.async {
            let folders: [[String: Any]] = self.sources.compactMap { source in
                guard let urls = self.opened[source.id], !urls.isEmpty else { return nil }
                return ["uri": source.id, "name": source.name]
            }
            call.resolve(["folders": folders])
        }
    }

    /// Give a choice back. The files are not touched.
    @objc func releaseFolder(_ call: PluginCall) {
        guard let id = call.getString("uri") else {
            call.reject("Which folder?", "MISSING_URI")
            return
        }
        queue.async {
            self.closeAccess(id)
            self.sources.removeAll { $0.id == id }
            self.writeSources()
            call.resolve()
        }
    }

    // ============================================
    // Reading what was chosen
    // ============================================

    /// Every audio file in one choice: where it is inside it, its size and
    /// when it last changed - enough for the page to tell an unchanged song
    /// from a new one without opening it.
    @objc func scanFolder(_ call: PluginCall) {
        guard let id = call.getString("uri") else {
            call.reject("Which folder?", "MISSING_URI")
            return
        }
        queue.async {
            guard let source = self.sources.first(where: { $0.id == id }), let roots = self.opened[id], !roots.isEmpty else {
                call.reject("Spotifie no longer has access to that folder. Choose it again.", "NOT_GRANTED")
                return
            }

            var files: [[String: Any]] = []
            if source.kind == "folder", let root = roots.first {
                self.walk(root, into: &files)
            } else {
                for url in roots where files.count < MusicFoldersPlugin.maxFiles {
                    if let entry = self.describe(url, path: url.lastPathComponent) { files.append(entry) }
                }
            }
            call.resolve(["files": files])
        }
    }

    private func walk(_ root: URL, into files: inout [[String: Any]]) {
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return }

        let base = root.standardizedFileURL.path
        for case let url as URL in enumerator {
            if files.count >= MusicFoldersPlugin.maxFiles { break }
            if enumerator.level > MusicFoldersPlugin.maxDepth {
                enumerator.skipDescendants()
                continue
            }
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
            if values?.isDirectory == true { continue }

            var path = url.standardizedFileURL.path
            if path.hasPrefix(base + "/") { path = String(path.dropFirst(base.count + 1)) }
            if let entry = describe(url, path: path) { files.append(entry) }
        }
    }

    private func describe(_ url: URL, path: String) -> [String: Any]? {
        guard MusicFoldersPlugin.audio.contains(url.pathExtension.lowercased()) else { return nil }
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        return [
            "uri": url.absoluteString,
            "path": path,
            "name": url.lastPathComponent,
            "size": values?.fileSize ?? 0,
            "lastModified": Int64((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)
        ]
    }

    /// The tags of one song, read only for a song that is new or has changed.
    /// Only files inside something the person chose are read.
    @objc func readTags(_ call: PluginCall) {
        guard let value = call.getString("uri"), let url = URL(string: value), url.isFileURL else {
            call.reject("Which file?", "MISSING_URI")
            return
        }
        queue.async {
            guard self.insideGrant(url) else {
                call.reject("That file is not in something you chose.", "NOT_GRANTED")
                return
            }

            let asset = AVURLAsset(url: url)
            var out: [String: Any] = [:]
            for item in asset.commonMetadata {
                guard let key = item.commonKey, let text = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { continue }
                switch key {
                case .commonKeyTitle: out["title"] = text
                case .commonKeyArtist: out["artist"] = text
                case .commonKeyAlbumName: out["album"] = text
                default: break
                }
            }
            let seconds = CMTimeGetSeconds(asset.duration)
            if seconds.isFinite && seconds > 0 { out["duration"] = seconds }
            call.resolve(out)
        }
    }

    // ============================================
    // Bookmarks and access
    // ============================================

    private func resolve(_ source: Source) -> [URL] {
        return source.bookmarks.compactMap { data in
            var stale = false
            return try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        }
    }

    /// Open security-scoped access to one choice, renewing a stale bookmark.
    private func openAccess(_ source: Source) {
        var urls: [URL] = []
        var renewed = source.bookmarks
        var changed = false

        for (index, data) in source.bookmarks.enumerated() {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { continue }
            guard url.startAccessingSecurityScopedResource() else { continue }
            urls.append(url)
            if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                renewed[index] = fresh
                changed = true
            }
        }

        opened[source.id] = urls
        if changed, let index = sources.firstIndex(where: { $0.id == source.id }) {
            sources[index].bookmarks = renewed
            writeSources()
        }
    }

    private func closeAccess(_ id: String) {
        opened[id]?.forEach { $0.stopAccessingSecurityScopedResource() }
        opened[id] = nil
    }

    private func insideGrant(_ file: URL) -> Bool {
        let path = file.standardizedFileURL.path
        for (_, urls) in opened {
            for url in urls {
                let root = url.standardizedFileURL.path
                if path == root || path.hasPrefix(root + "/") { return true }
            }
        }
        return false
    }

    // ============================================
    // What is kept
    // ============================================

    /// Application Support/SpotifieMusicSources.json: bookmarks only, never
    /// audio and never a copy of a file. Excluded from iCloud and device backup.
    private func storeURL() -> URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        return support.appendingPathComponent("SpotifieMusicSources.json")
    }

    private func readSources() -> [Source] {
        guard let url = storeURL(), let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Source].self, from: data)) ?? []
    }

    private func writeSources() {
        guard var url = storeURL(), let data = try? JSONEncoder().encode(sources) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}
