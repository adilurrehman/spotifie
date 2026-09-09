'use strict';

/**
 * Short-lived tickets for one person's own media.
 *
 * Music a listener imported from their device is private to them, but an
 * <audio> element cannot send an Authorization header. So the catalogue,
 * which is asked for over an authenticated request, hands out a URL carrying
 * a ticket: a signed statement that this account may read this track, valid
 * for a few hours and verifiable without any lookup.
 *
 * A ticket names one track and one account. It is not a session, it cannot be
 * extended, and it grants nothing else.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./config');
const { ensureDir } = require('./safeFs');

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const SECRET_FILE = path.join(DATA_DIR, 'media-secret');

/**
 * The signing secret for this installation.
 *
 * Taken from the environment when it is set, so several processes can agree;
 * otherwise generated once and kept beside the other local state, so tickets
 * survive a restart.
 */
function loadSecret(file) {
    const configured = process.env.SPOTIFIE_MEDIA_SECRET && process.env.SPOTIFIE_MEDIA_SECRET.trim();
    if (configured) return Buffer.from(configured, 'utf8');

    const target = file || SECRET_FILE;
    try {
        const existing = fs.readFileSync(target);
        if (existing && existing.length >= 32) return existing;
    } catch (e) {
        /* written below */
    }

    const secret = crypto.randomBytes(48);
    try {
        ensureDir(path.dirname(target));
        const temporary = target + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, secret, { mode: 0o600 });
        fs.renameSync(temporary, target);
    } catch (e) {
        // A read-only data folder is not fatal: tickets then last only as long
        // as this process, which is still correct, just shorter-lived.
    }
    return secret;
}

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class MediaTickets {
    constructor(options) {
        const settings = options || {};
        this.secret = settings.secret ? Buffer.from(settings.secret) : loadSecret(settings.secretFile);
        this.ttlSeconds = settings.ttlSeconds || DEFAULT_TTL_SECONDS;
    }

    sign(userId, trackId, expiresAt) {
        const payload = String(userId) + '|' + String(trackId) + '|' + String(expiresAt);
        return base64url(crypto.createHmac('sha256', this.secret).update(payload).digest());
    }

    /** A ticket for one account and one track: "<userId>.<expiry>.<signature>". */
    issue(userId, trackId) {
        const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
        return base64url(Buffer.from(String(userId), 'utf8')) + '.' + expiresAt + '.' + this.sign(userId, trackId, expiresAt);
    }

    /**
     * The account a ticket belongs to, or null when it does not hold up:
     * wrong shape, wrong track, expired, or not signed by this installation.
     */
    verify(ticket, trackId) {
        if (typeof ticket !== 'string') return null;

        const parts = ticket.split('.');
        if (parts.length !== 3) return null;

        let userId;
        try {
            userId = Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        } catch (e) {
            return null;
        }
        if (!userId) return null;

        const expiresAt = Number(parts[1]);
        if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;

        const expected = this.sign(userId, trackId, expiresAt);
        const given = parts[2];
        if (given.length !== expected.length) return null;
        if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;

        return userId;
    }
}

module.exports = { MediaTickets, DEFAULT_TTL_SECONDS };
