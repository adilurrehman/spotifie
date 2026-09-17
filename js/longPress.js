/**
 * A long press, done deliberately.
 *
 * On a touch screen there is no hover to reveal an album's options, and a
 * button drawn over every cover clutters the grid. So the options open with a
 * long press on the card instead, and a tap still opens the album.
 *
 * The rules that keep it deliberate rather than accidental:
 *
 * - only a finger or a pen starts one - never a mouse;
 * - it takes half a second of holding still;
 * - it is abandoned the moment the finger moves (a scroll starts) or lifts;
 * - the browser's own long press, a right click and the keyboard's menu key
 *   all arrive as "contextmenu" and open the same thing, once;
 * - the tap that ends a long press is not also a tap on the card.
 *
 * It opens nothing itself: the caller is handed the element and the point,
 * and uses whatever menu that element already has.
 */
(function (global) {
    'use strict';

    var DEFAULT_DELAY = 500;
    var DEFAULT_TOLERANCE = 10;

    // How long after a long press a click is still the end of that press.
    var SUPPRESS_MS = 700;

    function bind(area, options) {
        var settings = options || {};
        var delay = settings.delay || DEFAULT_DELAY;
        var tolerance = settings.tolerance || DEFAULT_TOLERANCE;
        var now =
            settings.now ||
            function () {
                return Date.now();
            };
        var timers = settings.timers || { set: global.setTimeout.bind(global), clear: global.clearTimeout.bind(global) };

        var press = null;
        var suppressUntil = 0;

        function target(event) {
            var element = event.target && event.target.closest ? event.target.closest(settings.selector) : null;
            if (!element) return null;
            if (settings.accept && !settings.accept(element)) return null;
            return element;
        }

        function cancel() {
            if (!press) return;
            timers.clear(press.timer);
            press = null;
        }

        function fire(element, point, event) {
            suppressUntil = now() + SUPPRESS_MS;
            settings.onLongPress(element, point, event);
        }

        area.addEventListener('pointerdown', function (event) {
            if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;

            var element = target(event);
            if (!element) return;

            cancel();
            var point = { x: event.clientX, y: event.clientY };
            press = {
                element: element,
                x: point.x,
                y: point.y,
                timer: timers.set(function () {
                    var held = press;
                    press = null;
                    if (held) fire(held.element, point, event);
                }, delay)
            };
        });

        area.addEventListener('pointermove', function (event) {
            if (!press) return;
            if (Math.abs(event.clientX - press.x) > tolerance || Math.abs(event.clientY - press.y) > tolerance) cancel();
        });

        // Lifted, taken over by a scroll, or gone off the card: not a long press.
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (type) {
            area.addEventListener(type, cancel);
        });

        area.addEventListener('contextmenu', function (event) {
            var element = target(event);
            if (!element) return;

            // Spotifie's menu, not the browser's.
            event.preventDefault();

            // The timer may already have opened it for the same press.
            var alreadyOpened = now() < suppressUntil;
            cancel();
            if (alreadyOpened) return;

            // The keyboard's menu key has no point; the caller anchors to the element.
            var point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : null;
            fire(element, point, event);
        });

        // The tap that ends a long press is not a tap on the card.
        area.addEventListener(
            'click',
            function (event) {
                if (now() >= suppressUntil) return;
                event.preventDefault();
                event.stopImmediatePropagation();
            },
            true
        );

        return { cancel: cancel };
    }

    global.spotifieLongPress = {
        bind: bind,
        DEFAULT_DELAY: DEFAULT_DELAY,
        DEFAULT_TOLERANCE: DEFAULT_TOLERANCE,
        SUPPRESS_MS: SUPPRESS_MS
    };
})(typeof window !== 'undefined' ? window : globalThis);
