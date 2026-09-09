'use strict';

/**
 * What Spotifie says about itself to a machine.
 *
 * Search engines, social cards and the assistants people ask about software
 * all read the same few things: a title, a description, an address, and a
 * short structured record of what the application is. This is the one place
 * any of that is written, so the page, the sitemap, robots.txt and the plain
 * text summary can never drift apart or contradict one another.
 *
 * Two rules run through the whole file.
 *
 * The address is configuration, never a guess. A canonical URL, a sitemap and
 * a structured record are all statements about where something lives, and this
 * installation does not know where it has been deployed until somebody says
 * so. Without PUBLIC_SITE_URL nothing here claims an address at all - it is
 * better to publish no canonical than to publish a wrong one, and 127.0.0.1 is
 * always the wrong one.
 *
 * And everything said here is public and true. There are no ratings, no
 * download counts and no awards, because there are none to report; there are
 * no admin addresses, no filesystem paths and nothing belonging to an account,
 * because none of that is the world's business. What is described is the
 * application, not anybody's library.
 */

const APP_NAME = 'Spotifie';
const TAGLINE = 'Hybrid Local & Global Music Player';

/**
 * How Spotifie is described wherever a description is asked for.
 *
 * One sentence, and every clause of it is something the application actually
 * does. Nothing here is aspiration.
 */
const DESCRIPTION =
    'Spotifie is a hybrid music player that brings the music already on your device together with a ' +
    'published global catalogue in one library - with playlists, liked songs, offline playback of local ' +
    'files, and a responsive player for desktop, tablet and phone.';

/** What it does, said plainly, one capability per line. */
const FEATURES = [
    'Plays music found on this device, indexed locally and never uploaded',
    'Browses a published global catalogue alongside that local music',
    'Keeps imported audio private to the account that imported it',
    'Playlists, liked songs, recently played and personal album edits',
    'Local music keeps playing without a connection',
    'One responsive player for desktop, tablet and phone',
    'Light and dark themes, keyboard navigation and reduced-motion support'
];

/**
 * The public pages, in the order somebody would meet them.
 *
 * Only pages that are the same for everybody. A sign-in form is not something
 * to send anyone to from a search result, and there is deliberately nothing
 * here that belongs to an account or to this machine.
 */
const PUBLIC_PAGES = [
    {
        path: '/',
        title: APP_NAME + ' - ' + TAGLINE,
        description: DESCRIPTION,
        priority: '1.0',
        changefreq: 'weekly'
    },
    {
        path: '/about.html',
        title: 'About ' + APP_NAME + ' - Features, Privacy, Terms and Accessibility',
        description:
            'What Spotifie does, how it handles your music and your data, the terms it is offered under, ' +
            'and how it works with a keyboard, a screen reader and reduced motion.',
        priority: '0.8',
        changefreq: 'monthly'
    },
    {
        path: '/developer.html',
        title: 'Developer - ' + APP_NAME,
        description: 'Who builds Spotifie, and how to get in touch.',
        priority: '0.5',
        changefreq: 'yearly'
    }
];

/**
 * Addresses no crawler should follow.
 *
 * The application's own interfaces, which answer to a person's session rather
 * than to a crawler; the pages that are a form rather than an answer to
 * anybody's search; and this installation's own working data.
 *
 * The administrator pages are deliberately not listed. They do not exist in a
 * published release at all, and where they do exist each one already asks not
 * to be indexed in its own head - which is the control that actually binds a
 * crawler. Writing their addresses into a file served to everybody would
 * publish where to look on the installations that have them, in exchange for
 * nothing their own pages do not already say.
 */
const DISALLOWED = [
    '/api/',
    '/signin.html',
    '/signup.html',
    '/forgot-password.html',
    '/reset-password.html',
    '/.spotifie/'
];

/**
 * Where this installation is published, or null.
 *
 * Answered from configuration and from nothing else. A loopback address is
 * refused rather than corrected: it means the variable was set from a
 * development machine, and a canonical URL pointing at somebody's own computer
 * is worse than none at all.
 */
function siteUrl() {
    const configured = (process.env.PUBLIC_SITE_URL || '').trim();
    if (!configured) return null;

    let parsed;
    try {
        parsed = new URL(configured);
    } catch (e) {
        console.warn('PUBLIC_SITE_URL is not a URL; nothing will claim a public address.');
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        console.warn('PUBLIC_SITE_URL must be http or https; nothing will claim a public address.');
        return null;
    }

    // An address in brackets is how a URL writes IPv6; the brackets are
    // punctuation rather than part of the host, and ::1 is this machine either
    // way round.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
        console.warn('PUBLIC_SITE_URL names this machine; nothing will claim a public address.');
        return null;
    }

    // No trailing slash, so joining a path to it is one rule everywhere.
    return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
}

/** One public page's address, or null when there is no public address. */
function absoluteUrl(pathname) {
    const base = siteUrl();
    if (!base) return null;

    const suffix = pathname === '/' ? '/' : pathname;
    return base + suffix;
}

/** The page description for one address, or the application's own. */
function pageFor(pathname) {
    const normalized = pathname === '/index.html' ? '/' : pathname;
    return PUBLIC_PAGES.find((page) => page.path === normalized) || null;
}

/**
 * The structured record of what Spotifie is.
 *
 * A WebApplication, because that is what it is: something used in a browser.
 * Every field is either a fact about the application or absent. There is no
 * price, no rating and no review count - inventing any of them would be
 * telling a search engine something untrue in order to be ranked by it.
 */
function applicationSchema() {
    const url = absoluteUrl('/');

    const schema = {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: APP_NAME,
        alternateName: APP_NAME + ' - ' + TAGLINE,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Web',
        browserRequirements: 'Requires JavaScript and a modern browser',
        description: DESCRIPTION,
        featureList: FEATURES,
        inLanguage: 'en'
    };

    if (url) {
        schema.url = url;
        // The application's own icon: a real file in this release, at a size
        // a card can use. There is no screenshot to point at, so none is
        // claimed.
        schema.image = url.replace(/\/$/, '') + '/favicons/favicon-512x512.png';
    }

    return schema;
}

/** The About page, as the page it is: one document about this application. */
function aboutSchema() {
    const url = absoluteUrl('/about.html');
    const app = absoluteUrl('/');

    const schema = {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        name: 'About ' + APP_NAME,
        description: pageFor('/about.html').description,
        inLanguage: 'en'
    };

    if (url) schema.url = url;
    if (app) schema.mainEntityOfPage = app;

    return schema;
}

/** The developer page, which is about a person and says only what they publish. */
function developerSchema() {
    const url = absoluteUrl('/developer.html');

    const schema = {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        name: 'Developer - ' + APP_NAME,
        description: pageFor('/developer.html').description,
        inLanguage: 'en'
    };

    if (url) schema.url = url;
    return schema;
}

function schemaFor(pathname) {
    const normalized = pathname === '/index.html' ? '/' : pathname;
    if (normalized === '/') return applicationSchema();
    if (normalized === '/about.html') return aboutSchema();
    if (normalized === '/developer.html') return developerSchema();
    return null;
}

/**
 * robots.txt, written from the list above.
 *
 * The sitemap is named only when there is an address to name it at: a
 * Sitemap line pointing at a machine nobody can reach is an error rather than
 * an omission.
 */
function robotsTxt() {
    const lines = ['# ' + APP_NAME, 'User-agent: *'];

    for (const path of DISALLOWED) lines.push('Disallow: ' + path);

    // Everything else, including the stylesheets, scripts and artwork a page
    // needs in order to be rendered and judged at all.
    lines.push('Allow: /');

    const sitemap = absoluteUrl('/sitemap.xml');
    if (sitemap) {
        lines.push('');
        lines.push('Sitemap: ' + sitemap);
    }

    lines.push('');
    return lines.join('\n');
}

/** Text that is safe inside an XML document. */
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * The sitemap, or null when this installation has no public address.
 *
 * Only the pages above: nothing generated from a catalogue, nothing belonging
 * to an account, and no address of this machine.
 */
function sitemapXml() {
    if (!siteUrl()) return null;

    const entries = PUBLIC_PAGES.map((page) => {
        return [
            '    <url>',
            '        <loc>' + escapeXml(absoluteUrl(page.path)) + '</loc>',
            '        <changefreq>' + page.changefreq + '</changefreq>',
            '        <priority>' + page.priority + '</priority>',
            '    </url>'
        ].join('\n');
    });

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        entries.join('\n'),
        '</urlset>',
        ''
    ].join('\n');
}

/**
 * A short, plain-text account of Spotifie for anything that reads software
 * documentation rather than pages.
 *
 * Documentation, not an argument: what the application is, what it does, how
 * it is put together, and where the public pages are. It says nothing a public
 * page does not already say, and nothing about anybody's library.
 */
function llmsTxt() {
    const base = siteUrl();
    const link = (pathname, label) => '- [' + label + '](' + (base ? absoluteUrl(pathname) : pathname) + ')';

    return [
        '# ' + APP_NAME,
        '',
        '> ' + DESCRIPTION,
        '',
        '## What it is',
        '',
        APP_NAME +
            ' is a web music player with two halves of one library. One half is the music already on the ' +
            'device it runs on. The other is a catalogue an administrator publishes, which everyone sees. ' +
            'They are browsed, searched and played as a single library.',
        '',
        '## Capabilities',
        '',
        ...FEATURES.map((feature) => '- ' + feature),
        '',
        '## Architecture',
        '',
        '- One local server serves the application, the local library API and the unified catalogue.',
        '- Music found on the device is indexed locally. Audio files are never uploaded.',
        '- The published catalogue is stored separately and is public to read.',
        '- Audio a person imports is private to that account and served only to it.',
        '- Supabase is used for authentication and profiles only, never for audio.',
        '',
        '## Local and global',
        '',
        'Local music belongs to the device: a guest and every account signed in on that machine see the ' +
        'same songs. The published catalogue is the same for everybody. What stays personal is what an ' +
        'account does with either - playlists, liked songs, history and personal edits.',
        '',
        '## Privacy',
        '',
        '- Playlists, liked songs, listening history and personal edits are kept on the device.',
        '- Audio and artwork are never uploaded to a third-party service.',
        '- No audio is stored in a database, and no file is ever deleted from a disk by the application.',
        '',
        '## Pages',
        '',
        link('/', APP_NAME + ' - the player'),
        link('/about.html#features', 'Features'),
        link('/about.html#privacy', 'Privacy'),
        link('/about.html#terms', 'Terms of use'),
        link('/about.html#accessibility', 'Accessibility'),
        link('/developer.html', 'Developer'),
        ''
    ].join('\n');
}

/**
 * The tags that can only be written once an address is known.
 *
 * Injected into a page as it is served rather than written into the file,
 * because the file is the same wherever it is deployed and the address is not.
 * A page served by an installation with no public address gets no canonical
 * and no og:url, which is the honest answer.
 */
function headTagsFor(pathname) {
    const page = pageFor(pathname);
    if (!page) return '';

    const url = absoluteUrl(page.path);
    const tags = [];

    if (url) {
        tags.push('<link rel="canonical" href="' + escapeHtml(url) + '">');
        tags.push('<meta property="og:url" content="' + escapeHtml(url) + '">');
        tags.push('<meta name="twitter:url" content="' + escapeHtml(url) + '">');

        const image = siteUrl() + '/favicons/favicon-512x512.png';
        tags.push('<meta property="og:image" content="' + escapeHtml(image) + '">');
        tags.push('<meta name="twitter:image" content="' + escapeHtml(image) + '">');
    }

    const schema = schemaFor(page.path);
    if (schema) {
        // JSON, so nothing in it can close the script element it sits in.
        tags.push(
            '<script type="application/ld+json">' +
                JSON.stringify(schema).replace(/</g, '\\u003c') +
                '</script>'
        );
    }

    return tags.join('\n    ');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Where a page says the generated tags belong. */
const MARKER = '<!--site-meta-->';

/** One page, with what only the server knows put into it. */
function injectInto(html, pathname) {
    if (html.indexOf(MARKER) === -1) return html;
    return html.replace(MARKER, headTagsFor(pathname));
}

module.exports = {
    APP_NAME,
    TAGLINE,
    DESCRIPTION,
    FEATURES,
    PUBLIC_PAGES,
    DISALLOWED,
    MARKER,
    siteUrl,
    absoluteUrl,
    pageFor,
    schemaFor,
    applicationSchema,
    robotsTxt,
    sitemapXml,
    llmsTxt,
    headTagsFor,
    injectInto
};
