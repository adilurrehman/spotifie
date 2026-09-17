package app.spotifie.android;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * The music folders a person chose, through Android's Storage Access Framework.
 *
 * The person picks a folder in the system's own picker; the app keeps a
 * persistable READ grant for that folder and nothing else. No storage
 * permission is declared or requested: nothing outside a chosen folder is
 * reachable, and a grant can be taken back from the system settings at any
 * time.
 *
 * What this never does: write, move or delete a file, copy audio anywhere,
 * encode it, or send it anywhere. It lists documents, reads their tags, and
 * hands back content:// addresses the WebView plays in place.
 *
 * Every method runs on Capacitor's plugin thread, never the UI thread.
 */
@CapacitorPlugin(name = "MusicFolders")
public class MusicFoldersPlugin extends Plugin {

    /** What counts as music: the same list every other part of Spotifie uses. */
    private static final Set<String> AUDIO = new HashSet<>(Arrays.asList("mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"));

    /** A folder chosen by mistake (a whole drive) must not become an endless walk. */
    private static final int MAX_DEPTH = 8;
    private static final int MAX_FILES = 5000;

    // ============================================
    // Choosing, listing and forgetting folders
    // ============================================

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("No folder was chosen.", "CANCELLED");
            return;
        }

        Uri tree = data.getData();
        try {
            // Read only, and kept across restarts. Never write.
            resolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Android did not grant lasting access to that folder.", "NOT_PERSISTED");
            return;
        }

        JSObject out = new JSObject();
        out.put("uri", tree.toString());
        out.put("name", displayName(tree));
        call.resolve(out);
    }

    /** The folders Android still lets the app read. */
    @PluginMethod
    public void listFolders(PluginCall call) {
        JSArray folders = new JSArray();
        for (UriPermission permission : resolver().getPersistedUriPermissions()) {
            Uri uri = permission.getUri();
            if (!permission.isReadPermission() || !DocumentsContract.isTreeUri(uri)) continue;

            JSObject folder = new JSObject();
            folder.put("uri", uri.toString());
            folder.put("name", displayName(uri));
            folders.put(folder);
        }

        JSObject out = new JSObject();
        out.put("folders", folders);
        call.resolve(out);
    }

    /** Give a folder back. The files in it are not touched. */
    @PluginMethod
    public void releaseFolder(PluginCall call) {
        String value = call.getString("uri");
        if (value == null) {
            call.reject("Which folder?", "MISSING_URI");
            return;
        }

        try {
            resolver().releasePersistableUriPermission(Uri.parse(value), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // Already gone, which is what was asked for.
        }
        call.resolve();
    }

    // ============================================
    // Reading a folder
    // ============================================

    /**
     * Every audio document inside one chosen folder: where it is inside the
     * folder, its size and when it last changed - enough for the page to tell
     * an unchanged song from a new one without opening it.
     */
    @PluginMethod
    public void scanFolder(PluginCall call) {
        Uri tree = grantedTree(call);
        if (tree == null) return;

        JSArray files = new JSArray();
        walk(tree, DocumentsContract.getTreeDocumentId(tree), "", 0, files);

        JSObject out = new JSObject();
        out.put("files", files);
        call.resolve(out);
    }

    private void walk(Uri tree, String documentId, String prefix, int depth, JSArray files) {
        if (depth > MAX_DEPTH || files.length() >= MAX_FILES) return;

        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
        String[] columns = {
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED
        };

        try (Cursor cursor = resolver().query(children, columns, null, null, null)) {
            if (cursor == null) return;

            while (cursor.moveToNext() && files.length() < MAX_FILES) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                if (id == null || name == null || name.startsWith(".")) continue;

                String path = prefix.isEmpty() ? name : prefix + "/" + name;

                if (Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(tree, id, path, depth + 1, files);
                    continue;
                }
                if (!AUDIO.contains(extension(name))) continue;

                JSObject file = new JSObject();
                file.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                file.put("path", path);
                file.put("name", name);
                file.put("size", cursor.isNull(3) ? 0 : cursor.getLong(3));
                file.put("lastModified", cursor.isNull(4) ? 0 : cursor.getLong(4));
                files.put(file);
            }
        } catch (Exception ignored) {
            // A folder that cannot be read - the grant taken back, a card
            // removed - is as far as this goes. What was found is still good.
        }
    }

    /**
     * The tags of one song, read only for a song that is new or has changed.
     * Only documents inside a chosen folder are read.
     */
    @PluginMethod
    public void readTags(PluginCall call) {
        String value = call.getString("uri");
        if (value == null) {
            call.reject("Which file?", "MISSING_URI");
            return;
        }

        Uri uri = Uri.parse(value);
        if (!insideGrant(uri)) {
            call.reject("That file is not in a chosen folder.", "NOT_GRANTED");
            return;
        }

        JSObject out = new JSObject();
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(getContext(), uri);
            putIfPresent(out, "title", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            putIfPresent(out, "artist", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            putIfPresent(out, "album", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            putIfPresent(out, "albumArtist", retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));

            String duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (duration != null) out.put("duration", Long.parseLong(duration) / 1000.0);
        } catch (Exception ignored) {
            // A file with no readable tags is named after itself by the page.
        } finally {
            try {
                retriever.release();
            } catch (Exception ignored) {
                // nothing left to release
            }
        }
        call.resolve(out);
    }

    // ============================================
    // Helpers
    // ============================================

    private ContentResolver resolver() {
        return getContext().getContentResolver();
    }

    /** The tree named in the call, if Android still lets the app read it. */
    private Uri grantedTree(PluginCall call) {
        String value = call.getString("uri");
        if (value == null) {
            call.reject("Which folder?", "MISSING_URI");
            return null;
        }

        Uri tree = Uri.parse(value);
        for (UriPermission permission : resolver().getPersistedUriPermissions()) {
            if (permission.isReadPermission() && permission.getUri().equals(tree)) return tree;
        }

        call.reject("Spotifie no longer has access to that folder. Choose it again.", "NOT_GRANTED");
        return null;
    }

    /** Is this document inside one of the folders the person chose? */
    private boolean insideGrant(Uri document) {
        String address = document.toString();
        for (UriPermission permission : resolver().getPersistedUriPermissions()) {
            if (!permission.isReadPermission()) continue;
            String tree = permission.getUri().toString();
            if (address.startsWith(tree + "/document/")) return true;
        }
        return false;
    }

    private String displayName(Uri tree) {
        try {
            Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor cursor = resolver().query(root, new String[] { Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) return cursor.getString(0);
            }
        } catch (Exception ignored) {
            // fall through to the address itself
        }
        String last = tree.getLastPathSegment();
        return last == null ? "Music" : last.substring(last.lastIndexOf(':') + 1);
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot == -1 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static void putIfPresent(JSObject out, String key, String value) {
        if (value != null && !value.trim().isEmpty()) out.put(key, value.trim());
    }
}
