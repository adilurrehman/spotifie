package app.spotifie.android;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * Spotifie's audio, played by Android rather than by the web view.
 *
 * The web application is the whole of Spotifie: the library, the queue, shuffle
 * and repeat, and what plays next are all decided there, exactly as they are on
 * the website. What this service owns on Android is the sound itself, and only
 * that. It exists because a web view stops being a reliable place to play music
 * the moment somebody leaves the app: this is a media session Android knows
 * about, so the music keeps playing with the app in the background or the
 * screen off, and the lock screen, the notification shade, Bluetooth and
 * headset buttons all control it.
 *
 * One item is loaded at a time - the track the application says is playing.
 * Next and previous are not decided here: they are handed back to the
 * application through {@link CommandListener}, so a press on the lock screen
 * does exactly what the same button in Spotifie does, including shuffle and
 * repeat. Nothing here keeps a second queue, and nothing here plays anything
 * the application did not ask for.
 *
 * ExoPlayer handles audio focus, becoming-noisy (headphones unplugged) and the
 * wake lock needed to keep streaming with the screen off. Media3 builds the
 * media notification itself; there is no hand-made one.
 */
@OptIn(markerClass = UnstableApi.class)
public class SpotifieMediaService extends MediaSessionService {

    /**
     * The notification's stop action.
     *
     * A custom session command rather than a player command, because none of
     * the player's own commands means "this listening session is over". It is
     * offered to whoever connects, and drawn as the stop button in the
     * notification and on the lock screen.
     */
    static final String COMMAND_CLOSE = "app.spotifie.media.CLOSE";

    /** How a media button that this service does not answer itself reaches the application. */
    public interface CommandListener {
        void onMediaCommand(String command);
    }

    private static volatile CommandListener commandListener;

    static void setCommandListener(@Nullable CommandListener listener) {
        commandListener = listener;
    }

    private static void send(String command) {
        CommandListener listener = commandListener;
        if (listener != null) listener.onMediaCommand(command);
    }

    @Nullable
    private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();

        ExoPlayer player = new ExoPlayer.Builder(this)
            .setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                // Android's own audio focus rules: a call, a navigation
                // prompt or another player interrupts and is respected.
                true
            )
            // Headphones pulled out, or Bluetooth gone: pause, as any music
            // player should.
            .setHandleAudioBecomingNoisy(true)
            // Keep streaming while the screen is off. Released as soon as
            // playback stops.
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build();

        // A player that has been stopped is a finished session, not a paused
        // one, so Android is told never to show a notification for it. This is
        // what makes the notification go when the last track ends, when the
        // stop action is pressed, and when the task is swiped away - rather
        // than leaving a dead notification behind for a player that has
        // nothing to play.
        setShowNotificationForIdlePlayer(SHOW_NOTIFICATION_FOR_IDLE_PLAYER_NEVER);

        MediaSession.Builder builder = new MediaSession.Builder(this, withMediaButtons(player))
            .setCallback(new SessionCallback())
            .setMediaButtonPreferences(ImmutableList.of(closeButton()));

        PendingIntent open = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        builder.setSessionActivity(open);

        session = builder.build();
    }

    /**
     * The stop button Android draws, with Android's own stop icon.
     *
     * Offered a visible place beside the transport controls, and the overflow
     * as a fallback: which one it actually gets is the system's decision and
     * differs between Android versions, the lock screen and each manufacturer's
     * shade.
     */
    private CommandButton closeButton() {
        return new CommandButton.Builder(CommandButton.ICON_STOP)
            .setSessionCommand(new SessionCommand(COMMAND_CLOSE, Bundle.EMPTY))
            .setDisplayName(getString(R.string.media_close))
            .setSlots(CommandButton.SLOT_FORWARD_SECONDARY, CommandButton.SLOT_OVERFLOW)
            .build();
    }

    /**
     * Who may press what.
     *
     * The stop action is a command of Spotifie's own, so it has to be offered
     * explicitly: a controller is only allowed to send commands the session
     * said it would accept, and the notification is itself a controller.
     */
    private final class SessionCallback implements MediaSession.Callback {

        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller
        ) {
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession)
                .setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
                        .buildUpon()
                        .add(new SessionCommand(COMMAND_CLOSE, Bundle.EMPTY))
                        .build()
                )
                .setMediaButtonPreferences(ImmutableList.of(closeButton()))
                .build();
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controller,
            @NonNull SessionCommand command,
            @NonNull Bundle args
        ) {
            if (COMMAND_CLOSE.equals(command.customAction)) {
                closePlayback();
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED));
        }
    }

    /**
     * Stop playing, and let the session go.
     *
     * The sound stops, the track is let go of, the application is told so its
     * controls do not sit there showing a Pause for a player that has stopped,
     * and the service leaves the foreground - which takes the notification with
     * it. The process itself is Android's to end; nothing here kills it.
     */
    private void closePlayback() {
        MediaSession current = session;
        if (current != null) {
            Player player = current.getPlayer();
            player.stop();
            player.clearMediaItems();
        }

        // The page may not be there to hear this - the task may already have
        // been swiped away - and then there is nothing to tell.
        send("close");

        stopSelf();
    }

    /**
     * Previous and next, offered to Android and answered by the application.
     *
     * Only one track is ever loaded here, so ExoPlayer would say it has nothing
     * to skip to and Android would draw a notification without those buttons.
     * They are offered anyway, and a press is handed to Spotifie, which knows
     * what actually comes next in the queue the listener is playing.
     */
    private Player withMediaButtons(Player player) {
        return new ForwardingPlayer(player) {
            @NonNull
            @Override
            public Commands getAvailableCommands() {
                return super.getAvailableCommands()
                    .buildUpon()
                    .add(COMMAND_SEEK_TO_NEXT)
                    .add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .add(COMMAND_SEEK_TO_PREVIOUS)
                    .add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                    .build();
            }

            @Override
            public boolean isCommandAvailable(int command) {
                if (
                    command == COMMAND_SEEK_TO_NEXT ||
                    command == COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ||
                    command == COMMAND_SEEK_TO_PREVIOUS ||
                    command == COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
                ) {
                    return true;
                }
                return super.isCommandAvailable(command);
            }

            @Override
            public void seekToNext() {
                send("next");
            }

            @Override
            public void seekToNextMediaItem() {
                send("next");
            }

            @Override
            public void seekToPrevious() {
                send("previous");
            }

            @Override
            public void seekToPreviousMediaItem() {
                send("previous");
            }
        };
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /**
     * Swiped out of Recents.
     *
     * Closing Spotifie closes the music with it: the sound stops, the service
     * leaves the foreground and the notification goes. Backgrounding is a
     * different thing entirely and is not affected - pressing Home leaves the
     * task where it is, so nothing here runs and the music plays on.
     */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        closePlayback();
    }

    @Override
    public void onDestroy() {
        MediaSession current = session;
        if (current != null) {
            current.getPlayer().release();
            current.release();
            session = null;
        }
        super.onDestroy();
    }
}
