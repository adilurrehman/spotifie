package app.spotifie.android;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Spotifie's Android shell: one WebView showing the same web application every
 * other copy runs. Its own native code is the music-folder plugin and the media
 * bridge that lets Android play the audio, both registered here before the
 * bridge starts.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MusicFoldersPlugin.class);
        registerPlugin(SpotifieMediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
