/**
 * Spotifie library client.
 *
 * Platform-neutral access to the local music library for player/UI code.
 * It speaks only in IDs and URLs returned by the backend, so it works
 * unchanged if the backend adapter is later swapped for a desktop or mobile
 * implementation. UI code must never build filesystem paths itself.
 */
(function (global) {
    'use strict';

    var DEFAULT_BASE = '/api/library';

    function LibraryClient(options) {
        var settings = options || {};
        this.baseUrl = settings.baseUrl || DEFAULT_BASE;
        this.fetchImpl = settings.fetch || (typeof fetch === 'function' ? fetch.bind(global) : null);
    }

    LibraryClient.prototype._request = function (url, init) {
        if (!this.fetchImpl) {
            return Promise.reject(new Error('No fetch implementation available'));
        }
        return this.fetchImpl(url, init).then(function (response) {
            if (!response.ok) {
                var error = new Error('Library request failed with status ' + response.status);
                error.status = response.status;
                throw error;
            }
            return response.json();
        });
    };

    LibraryClient.prototype._query = function (params) {
        var pairs = [];
        Object.keys(params || {}).forEach(function (key) {
            var value = params[key];
            if (value === undefined || value === null || value === '') return;
            pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        });
        return pairs.length ? '?' + pairs.join('&') : '';
    };

    /** Library status: backend kind, track count, last index update. */
    LibraryClient.prototype.getStatus = function () {
        return this._request(this.baseUrl + '/status');
    };

    /** Tracks, optionally filtered by album or artist and paginated. */
    LibraryClient.prototype.getTracks = function (options) {
        return this._request(this.baseUrl + '/tracks' + this._query(options));
    };

    LibraryClient.prototype.getTrack = function (trackId) {
        return this._request(this.baseUrl + '/tracks/' + encodeURIComponent(trackId));
    };

    LibraryClient.prototype.getAlbums = function () {
        return this._request(this.baseUrl + '/albums');
    };

    LibraryClient.prototype.getArtists = function () {
        return this._request(this.baseUrl + '/artists');
    };

    LibraryClient.prototype.rescan = function () {
        return this._request(this.baseUrl + '/rescan', { method: 'POST' });
    };

    /** Playable URL for an <audio> element. Supports range requests. */
    LibraryClient.prototype.getStreamUrl = function (trackId) {
        return this.baseUrl + '/tracks/' + encodeURIComponent(trackId) + '/stream';
    };

    /** Artwork URL; the backend serves a neutral fallback when none exists. */
    LibraryClient.prototype.getArtworkUrl = function (trackId) {
        return this.baseUrl + '/tracks/' + encodeURIComponent(trackId) + '/artwork';
    };

    global.LibraryClient = LibraryClient;
    global.spotifieLibrary = new LibraryClient();

    if (typeof module === 'object' && module.exports) {
        module.exports = { LibraryClient: LibraryClient };
    }
})(typeof window !== 'undefined' ? window : globalThis);
