package app.spotifie.android;

import android.content.ComponentName;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;

/**
 * The bridge between Spotifie's player and Android's media session.
 *
 * The page asks for one track at a time - here is its address, its name, who it
 * is by, its picture - and asks for play, pause, seek and volume. Everything
 * else stays where it already is: the queue, shuffle, repeat and what follows
 * this track are the application's, on every platform.
 *
 * What comes back the other way: what the player is doing (playing, paused,
 * ready, ended, failed), where it has got to (about once a second while
 * playing, and not at all while paused), and any media button Android handed to
 * the session that the service does not answer itself - next and previous.
 *
 * No audio address is kept here. A published track's address is signed and
 * short-lived, and is handed over when it is needed; a track on this device is
 * a content:// address the person already granted, played in place.
 */
@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "SpotifieMedia")
public class SpotifieMediaPlugin extends Plugin implements SpotifieMediaService.CommandListener {

    /** How often the page is told where playback has got to, while it is playing. */
    private static final long POSITION_EVERY_MS = 1000;

    private final Handler main = new Handler(Looper.getMainLooper());

    @Nullable
    private MediaController controller;

    @Nullable
    private ListenableFuture<MediaController> connecting;

    private final Runnable positionTick = new Runnable() {
        @Override
        public void run() {
            MediaController player = controller;
            if (player == null) return;
            if (player.isPlaying()) {
                notifyListeners("positionChanged", position(player));
                main.postDelayed(this, POSITION_EVERY_MS);
            }
        }
    };

    @Override
    public void load() {
        SpotifieMediaService.setCommandListener(this);
        main.post(this::connect);
    }

    @Override
    protected void handleOnDestroy() {
        SpotifieMediaService.setCommandListener(null);
        main.removeCallbacks(positionTick);
        main.post(() -> {
            MediaController player = controller;
            controller = null;
            connecting = null;
            if (player != null) player.release();
        });
        super.handleOnDestroy();
    }

    // ============================================
    // The connection to the service
    // ============================================

    private void connect() {
        if (controller != null || connecting != null) return;

        SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), SpotifieMediaService.class));
        ListenableFuture<MediaController> future = new MediaController.Builder(getContext(), token).buildAsync();
        connecting = future;

        future.addListener(
            () -> {
                try {
                    MediaController player = future.get();
                    controller = player;
                    connecting = null;
                    player.addListener(new PlayerEvents());
                    // The page may have been reloaded while the music kept
                    // playing; it is told what is already happening.
                    notifyListeners("playbackState", state(player));
                } catch (Exception error) {
                    connecting = null;
                    notifyListeners("playbackError", message(error.getMessage()));
                }
            },
            MoreExecutors.directExecutor()
        );
    }

    /** Run something with the player, on the thread the player belongs to. */
    private void withPlayer(PluginCall call, PlayerAction action) {
        main.post(() -> {
            MediaController player = controller;
            if (player == null) {
                connect();
                call.reject("The media service is not connected yet.", "NOT_READY");
                return;
            }
            try {
                action.run(player);
            } catch (Exception error) {
                call.reject("The player refused that.", "PLAYER_ERROR", error);
            }
        });
    }

    private interface PlayerAction {
        void run(MediaController player) throws Exception;
    }

    // ============================================
    // What the page asks for
    // ============================================

    /**
     * Play this track: its address, and what Android should show while it
     * plays. A position can be given, so a track resumes where it was left.
     */
    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url");
        if (TextUtils.isEmpty(url)) {
            call.reject("Which track?", "MISSING_URL");
            return;
        }

        String mediaId = call.getString("mediaId", "");
        double startSeconds = call.getDouble("startSeconds", 0.0);
        boolean autoplay = Boolean.TRUE.equals(call.getBoolean("autoplay", false));

        MediaItem item = new MediaItem.Builder()
            .setUri(Uri.parse(url))
            .setMediaId(TextUtils.isEmpty(mediaId) ? url : mediaId)
            .setMediaMetadata(metadataFrom(call))
            .build();

        withPlayer(call, player -> {
            player.setMediaItem(item, Math.max(0, (long) (startSeconds * 1000)));
            player.prepare();
            player.setPlayWhenReady(autoplay);
            call.resolve(state(player));
        });
    }

    /**
     * New words or a new picture for the track already playing.
     *
     * A published track's picture has to be signed before it can be fetched,
     * which takes a moment longer than starting the music does - so the track
     * plays first and its artwork arrives after. The address of the audio is
     * unchanged, so the music carries on while the notification and the lock
     * screen catch up.
     */
    @PluginMethod
    public void updateMetadata(PluginCall call) {
        String mediaId = call.getString("mediaId", "");
        MediaMetadata metadata = metadataFrom(call);

        withPlayer(call, player -> {
            MediaItem current = player.getCurrentMediaItem();
            if (current == null) {
                call.resolve();
                return;
            }
            // The listener may already have moved on; then this is about a
            // track that is no longer playing, and is dropped.
            if (!TextUtils.isEmpty(mediaId) && !mediaId.equals(current.mediaId)) {
                call.resolve();
                return;
            }

            player.replaceMediaItem(player.getCurrentMediaItemIndex(), current.buildUpon().setMediaMetadata(metadata).build());
            call.resolve();
        });
    }

    private static MediaMetadata metadataFrom(PluginCall call) {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(call.getString("title", ""))
            .setArtist(call.getString("artist", ""))
            .setAlbumTitle(call.getString("album", ""))
            .setIsBrowsable(false)
            .setIsPlayable(true);

        // Only an address Android can fetch. Anything else (a picture the page
        // made for itself, or one bundled in the web assets) is left out, and
        // the notification shows the app's own icon instead. Artwork is never
        // waited for: the music starts either way.
        String artworkUrl = call.getString("artworkUrl", "");
        if (artworkUrl.startsWith("http://") || artworkUrl.startsWith("https://")) {
            metadata.setArtworkUri(Uri.parse(artworkUrl));
        }
        return metadata.build();
    }

    @PluginMethod
    public void play(PluginCall call) {
        withPlayer(call, player -> {
            player.play();
            call.resolve(state(player));
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withPlayer(call, player -> {
            player.pause();
            call.resolve(state(player));
        });
    }

    /** Stop and let go: no track, no notification. */
    @PluginMethod
    public void stop(PluginCall call) {
        withPlayer(call, player -> {
            player.stop();
            player.clearMediaItems();
            call.resolve(state(player));
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double seconds = call.getDouble("seconds");
        if (seconds == null) {
            call.reject("Seek to where?", "MISSING_SECONDS");
            return;
        }
        withPlayer(call, player -> {
            player.seekTo(Math.max(0, (long) (seconds * 1000)));
            notifyListeners("positionChanged", position(player));
            call.resolve(state(player));
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        if (volume == null) {
            call.reject("Which volume?", "MISSING_VOLUME");
            return;
        }
        withPlayer(call, player -> {
            player.setVolume((float) Math.max(0, Math.min(1, volume)));
            call.resolve();
        });
    }

    /**
     * Repeat one, as the application means it: the same track again without
     * asking the page for anything, so it still repeats with the app closed.
     * Every other repeat and shuffle mode is the application's own business -
     * it decides what plays next and asks for it.
     */
    @PluginMethod
    public void setRepeatOne(PluginCall call) {
        boolean repeatOne = Boolean.TRUE.equals(call.getBoolean("repeatOne", false));
        withPlayer(call, player -> {
            player.setRepeatMode(repeatOne ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            call.resolve();
        });
    }

    /** What is playing right now, for a page that has just opened or come back. */
    @PluginMethod
    public void getState(PluginCall call) {
        main.post(() -> {
            MediaController player = controller;
            if (player == null) {
                connect();
                JSObject empty = new JSObject();
                empty.put("connected", false);
                empty.put("playing", false);
                empty.put("mediaId", "");
                empty.put("position", 0);
                empty.put("duration", 0);
                call.resolve(empty);
                return;
            }
            call.resolve(state(player));
        });
    }

    // ============================================
    // What the page is told
    // ============================================

    private class PlayerEvents implements Player.Listener {

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            MediaController player = controller;
            if (player == null) return;

            notifyListeners("playbackState", state(player));
            main.removeCallbacks(positionTick);
            if (isPlaying) main.postDelayed(positionTick, POSITION_EVERY_MS);
        }

        @Override
        public void onPlaybackStateChanged(int playbackState) {
            MediaController player = controller;
            if (player == null) return;

            if (playbackState == Player.STATE_READY) {
                notifyListeners("ready", state(player));
            } else if (playbackState == Player.STATE_ENDED) {
                main.removeCallbacks(positionTick);
                notifyListeners("ended", state(player));
            } else if (playbackState == Player.STATE_IDLE) {
                // Stopped rather than paused - the notification's stop action,
                // or the task being swiped away. The page is told, so a window
                // that is still open does not sit there showing a Pause for a
                // player that has nothing loaded.
                main.removeCallbacks(positionTick);
                notifyListeners("playbackState", state(player));
            }
        }

        @Override
        public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
            JSObject data = new JSObject();
            data.put("mediaId", item != null ? item.mediaId : "");
            notifyListeners("trackChanged", data);
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            main.removeCallbacks(positionTick);
            notifyListeners("playbackError", message(error.getErrorCodeName() + ": " + error.getMessage()));
        }
    }

    /** A media button Android gave the session that the application must answer. */
    @Override
    public void onMediaCommand(String command) {
        JSObject data = new JSObject();
        data.put("command", command);
        notifyListeners("mediaCommand", data);
    }

    // ============================================
    // Shapes
    // ============================================

    private static JSObject position(MediaController player) {
        JSObject data = new JSObject();
        data.put("position", player.getCurrentPosition() / 1000.0);
        data.put("duration", duration(player));
        return data;
    }

    private static JSObject state(MediaController player) {
        MediaItem item = player.getCurrentMediaItem();
        JSObject data = position(player);
        data.put("connected", true);
        data.put("playing", player.isPlaying());
        data.put("playWhenReady", player.getPlayWhenReady());
        data.put("ended", player.getPlaybackState() == Player.STATE_ENDED);
        data.put("mediaId", item != null ? item.mediaId : "");
        return data;
    }

    private static double duration(MediaController player) {
        long length = player.getDuration();
        return length > 0 ? length / 1000.0 : 0;
    }

    private static JSObject message(@Nullable String text) {
        JSObject data = new JSObject();
        data.put("message", text == null ? "" : text);
        return data;
    }
}
