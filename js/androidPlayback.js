/**
 * Spotifie's audio on Android, played by Android.
 *
 * Everywhere else the player is an ordinary HTML audio element. In the Android
 * app that is not good enough: a web view is not a reliable place to play music
 * once somebody leaves the app, and it can put nothing on the lock screen. So
 * on Android the sound belongs to a native media session (ExoPlayer, in
 * SpotifieMediaService), and this file is the one piece that connects the two.
 *
 * It answers to exactly what the player already asks of an audio element - src,
 * currentTime, duration, volume, paused, ended, play(), pause() and the events
 * it listens for - so the player itself is the same code on every platform.
 * There is no second player and no second queue: the application still decides
 * what is playing, what comes next, shuffle and repeat, and the media buttons
 * on the lock screen are handed back to it so they do exactly what its own
 * buttons do.
 *
 * One engine per platform, never two at once: where this adapter is in use, no
 * HTML audio element is ever created, so nothing can play twice.
 */
(function (global) {
    'use strict';

    var PLUGIN = 'SpotifieMedia';

    function capacitor() {
        return global.Capacitor || null;
    }

    /** The Android app, with its media plugin. Never a user-agent string. */
    function available() {
        var bridge = capacitor();
        try {
            return Boolean(
                bridge &&
                    typeof bridge.isNativePlatform === 'function' &&
                    bridge.isNativePlatform() &&
                    typeof bridge.getPlatform === 'function' &&
                    bridge.getPlatform() === 'android' &&
                    bridge.Plugins &&
                    bridge.Plugins[PLUGIN]
            );
        } catch (e) {
            return false;
        }
    }

    function plugin() {
        var bridge = capacitor();
        return (bridge && bridge.Plugins && bridge.Plugins[PLUGIN]) || null;
    }

    /**
     * The address Android should play.
     *
     * A track on this device is served to the web view through Capacitor's own
     * local address; ExoPlayer wants the thing itself, which is the content://
     * the person granted through the folder picker. Nothing is copied and
     * nothing is re-encoded: the same file, read in place. A published track is
     * an ordinary https address and is handed over as it is.
     */
    function nativeUri(url) {
        if (typeof url !== 'string' || !url) return null;

        var marks = [
            { at: '/_capacitor_content_/', scheme: 'content://' },
            { at: '/_capacitor_file_/', scheme: 'file://' }
        ];

        for (var i = 0; i < marks.length; i += 1) {
            var found = url.indexOf(marks[i].at);
            if (found !== -1) return marks[i].scheme + url.slice(found + marks[i].at.length);
        }
        return url;
    }

    function create() {
        var media = plugin();

        var listeners = {};
        var state = {
            src: '',
            mediaId: '',
            loadedId: '',
            position: 0,
            duration: 0,
            paused: true,
            ended: false,
            volume: 1,
            pendingSeek: null,
            metadata: {}
        };

        function emit(type) {
            (listeners[type] || []).slice().forEach(function (entry) {
                if (entry.once) remove(type, entry.fn);
                try {
                    entry.fn({ type: type, target: engine });
                } catch (e) {
                    /* one listener's mistake is not the player's */
                }
            });
        }

        function remove(type, fn) {
            listeners[type] = (listeners[type] || []).filter(function (entry) {
                return entry.fn !== fn;
            });
        }

        function apply(data) {
            if (!data) return;
            if (typeof data.position === 'number') state.position = data.position;
            if (typeof data.duration === 'number' && data.duration > 0) {
                var known = state.duration;
                state.duration = data.duration;
                if (known !== data.duration) emit('durationchange');
            }
            if (typeof data.playing === 'boolean') {
                var was = state.paused;
                state.paused = !data.playing;
                if (data.playing) state.ended = false;
                if (was !== state.paused) emit(state.paused ? 'pause' : 'play');
                if (was && !state.paused) emit('playing');
            }
        }

        // ---- what Android says is happening ----

        if (media && typeof media.addListener === 'function') {
            media.addListener('playbackState', apply);

            media.addListener('ready', function (data) {
                apply(data);
                emit('loadedmetadata');
            });

            media.addListener('positionChanged', function (data) {
                apply(data);
                emit('timeupdate');
            });

            media.addListener('ended', function (data) {
                apply(data);
                state.ended = true;
                state.paused = true;
                emit('ended');
            });

            media.addListener('playbackError', function (data) {
                engine.error = { message: (data && data.message) || 'Playback failed' };
                state.paused = true;
                emit('error');
            });

            // Next and previous from the lock screen, the notification or a
            // headset: answered by the application, so they do what its own
            // buttons do - including shuffle and repeat.
            media.addListener('mediaCommand', function (data) {
                var command = data && data.command;
                if (!command) return;

                // Stop, from the notification or from Spotifie being closed.
                // Android has already stopped the sound and let the track go;
                // what is left is to say so here, so nothing in the page is
                // still describing a player that is playing. The position goes
                // back to the start because there is no longer a track loaded
                // to be part-way through.
                if (command === 'close') {
                    state.loadedId = '';
                    state.position = 0;
                    state.ended = false;
                    if (!state.paused) {
                        state.paused = true;
                        emit('pause');
                    }
                    emit('timeupdate');
                }

                if (typeof engine.onCommand === 'function') engine.onCommand(command);
            });
        }

        function load(autoplay) {
            if (!media || !state.src) return Promise.resolve();

            var url = nativeUri(state.src);
            var meta = state.metadata || {};
            var id = meta.mediaId || state.mediaId || url;

            state.loadedId = id;
            state.ended = false;

            return Promise.resolve(
                media.load({
                    url: url,
                    mediaId: id,
                    title: meta.title || '',
                    artist: meta.artist || '',
                    album: meta.album || '',
                    artworkUrl: meta.artwork || '',
                    startSeconds: state.pendingSeek || 0,
                    autoplay: Boolean(autoplay)
                })
            )
                .then(function (answer) {
                    state.pendingSeek = null;
                    apply(answer);
                })
                .catch(function (error) {
                    engine.error = { message: (error && error.message) || 'Playback failed' };
                    emit('error');
                });
        }

        var engine = {
            /** Named so the player can tell where the sound is coming from. */
            isNativeEngine: true,
            error: null,
            onCommand: null,

            get src() {
                return state.src;
            },

            set src(value) {
                var next = value == null ? '' : String(value);
                state.src = next;
                state.position = 0;
                state.duration = 0;
                state.ended = false;

                if (!next) {
                    state.loadedId = '';
                    if (media) media.stop().catch(function () {});
                    emit('emptied');
                    return;
                }
                load(false);
            },

            get currentTime() {
                return state.position;
            },

            set currentTime(value) {
                var seconds = Math.max(0, Number(value) || 0);
                state.position = seconds;
                if (!media || !state.loadedId) {
                    // Asked for before there is anything to seek: remembered,
                    // and used as the starting point when the track loads.
                    state.pendingSeek = seconds;
                    return;
                }
                media.seek({ seconds: seconds }).catch(function () {});
                emit('timeupdate');
            },

            get duration() {
                return state.duration || NaN;
            },

            get paused() {
                return state.paused;
            },

            get ended() {
                return state.ended;
            },

            get volume() {
                return state.volume;
            },

            set volume(value) {
                state.volume = Math.max(0, Math.min(1, Number(value) || 0));
                if (media) media.setVolume({ volume: state.volume }).catch(function () {});
            },

            play: function () {
                if (!media) return Promise.resolve();
                if (!state.loadedId && state.src) return load(true);
                return Promise.resolve(media.play())
                    .then(apply)
                    .catch(function (error) {
                        engine.error = { message: (error && error.message) || 'Playback failed' };
                        emit('error');
                    });
            },

            pause: function () {
                if (!media) return;
                Promise.resolve(media.pause()).then(apply).catch(function () {});
            },

            addEventListener: function (type, fn, options) {
                if (typeof fn !== 'function') return;
                (listeners[type] = listeners[type] || []).push({ fn: fn, once: Boolean(options && options.once) });
            },

            removeEventListener: function (type, fn) {
                remove(type, fn);
            },

            getAttribute: function (name) {
                return name === 'src' ? state.src || null : null;
            },

            removeAttribute: function (name) {
                if (name === 'src') engine.src = '';
            },

            /**
             * What Android shows while this track plays. Given before the
             * address is, so the notification is right from the first moment.
             */
            setMetadata: function (metadata) {
                state.metadata = metadata || {};
                state.mediaId = (metadata && metadata.mediaId) || '';

                // Said again for a track that is already playing - a published
                // picture is signed a moment after the music starts - so the
                // notification catches up without the music stopping.
                var id = state.mediaId || state.loadedId;
                if (media && state.loadedId && state.loadedId === id && typeof media.updateMetadata === 'function') {
                    media
                        .updateMetadata({
                            mediaId: id,
                            title: state.metadata.title || '',
                            artist: state.metadata.artist || '',
                            album: state.metadata.album || '',
                            artworkUrl: state.metadata.artwork || ''
                        })
                        .catch(function () {});
                }
            },

            /**
             * Nothing more to play.
             *
             * Android is let go of, so the media notification does not sit
             * there after the last track has finished. The page keeps the
             * track it was on: pressing play loads it again from the top of
             * this same address.
             */
            stop: function () {
                if (!media) return;
                state.loadedId = '';
                state.paused = true;
                Promise.resolve(media.stop()).catch(function () {});
            },

            /** Repeat-one is the one thing Android can do without asking the page. */
            setRepeatOne: function (repeatOne) {
                if (media && typeof media.setRepeatOne === 'function') {
                    media.setRepeatOne({ repeatOne: Boolean(repeatOne) }).catch(function () {});
                }
            },

            /**
             * What is playing now, asked of Android itself.
             *
             * The page may have been reloaded, or the whole window recreated,
             * while the music kept playing. The answer is what is really
             * happening, never an assumption that a fresh page means silence.
             */
            adopt: function () {
                if (!media) return Promise.resolve(null);
                return Promise.resolve(media.getState())
                    .then(function (answer) {
                        if (!answer || !answer.mediaId) return null;
                        state.loadedId = answer.mediaId;
                        state.mediaId = answer.mediaId;
                        state.src = state.src || answer.mediaId;
                        apply(answer);
                        return answer;
                    })
                    .catch(function () {
                        return null;
                    });
            }
        };

        return engine;
    }

    global.spotifieAndroidPlayback = {
        available: available,
        create: create,
        nativeUri: nativeUri,
        PLUGIN: PLUGIN
    };
})(typeof window !== 'undefined' ? window : globalThis);
