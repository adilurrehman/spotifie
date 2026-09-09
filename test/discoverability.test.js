'use strict';

/**
 * What Spotifie says about itself, and what it refuses to say.
 *
 * Two questions run through this file, and the second matters more than the
 * first.
 *
 * Is what it says true? There are no ratings, no download counts and no
 * awards anywhere in the structured record, because there are none to report,
 * and a page that invented them would be lying to a search engine in order to
 * be ranked by it. The description is a list of things the application
 * actually does.
 *
 * And is it public? Nothing here may carry an administrator's address, a path
 * on somebody's disk, a name, an email, or anything belonging to a library.
 * The sitemap lists three pages that are the same for everybody. Being found
 * is worth nothing that costs somebody their privacy.
 *
 * The address is the third thread. An installation does not know where it has
 * been deployed until it is told, so with nothing configured it claims nothing
 * - no canonical, no sitemap, no og:url. A canonical URL pointing at somebody's
 * own machine is worse than none at all, and these hold that line.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** The module, read fresh, with the environment a test wants. */
function metaWith(siteUrl) {
    const before = process.env.PUBLIC_SITE_URL;

    if (siteUrl === null) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = siteUrl;

    delete require.cache[require.resolve('../lib/siteMeta')];
    const meta = require('../lib/siteMeta');

    // Read while the variable is set; the caller uses the returned functions
    // immediately, so it is restored after they have.
    return {
        meta: meta,
        restore() {
            if (before === undefined) delete process.env.PUBLIC_SITE_URL;
            else process.env.PUBLIC_SITE_URL = before;
            delete require.cache[require.resolve('../lib/siteMeta')];
        }
    };
}

const PUBLIC_PAGES = [
    'index.html',
    'about.html',
    'developer.html',
    'signin.html',
    'signup.html',
    'forgot-password.html',
    'reset-password.html'
];

function pageSource(name) {
    return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function headOf(name) {
    const html = pageSource(name);
    return html.slice(0, html.indexOf('</head>'));
}

// ============================================
// Every page says what it is
// ============================================

test('every public page has its own title and its own description', () => {
    const titles = new Map();
    const descriptions = new Map();

    PUBLIC_PAGES.forEach((name) => {
        const head = headOf(name);

        const title = /<title>([^<]+)<\/title>/.exec(head);
        assert.ok(title, name + ' has a title');
        assert.ok(title[1].trim().length > 10, name + ' says something in it');

        const description = /<meta name="description" content="([^"]+)"/.exec(head);
        assert.ok(description, name + ' has a description');
        assert.ok(description[1].length > 40, name + ' describes itself in a sentence');

        // Two pages that describe themselves the same way are two pages
        // nothing can tell apart.
        assert.ok(!titles.has(title[1]), name + ' does not share its title with ' + titles.get(title[1]));
        assert.ok(
            !descriptions.has(description[1]),
            name + ' does not share its description with ' + descriptions.get(description[1])
        );

        titles.set(title[1], name);
        descriptions.set(description[1], name);
    });
});

test('a page that is a form asks not to be indexed, and the rest ask to be', () => {
    const forms = ['signin.html', 'signup.html', 'forgot-password.html', 'reset-password.html'];

    forms.forEach((name) => {
        assert.match(headOf(name), /<meta name="robots" content="noindex, nofollow">/, name + ' is not an answer to a search');
        // And nothing about it is prepared for sharing, because there is
        // nothing there to share.
        assert.ok(!/og:title/.test(headOf(name)), name + ' has no social card');
    });

    ['index.html', 'about.html', 'developer.html'].forEach((name) => {
        assert.match(headOf(name), /<meta name="robots" content="index, follow/, name + ' is a public page');
        assert.match(headOf(name), /<meta property="og:title"/, name + ' can be shared');
        assert.match(headOf(name), /<meta name="twitter:card" content="summary">/);
    });

    // The two pages a private installation has are excluded from the release
    // entirely, and where they exist they say so themselves.
    ['admin-login.html', 'admin-dashboard.html'].forEach((name) => {
        assert.match(pageSource(name), /<meta name="robots" content="noindex, nofollow">/, name + ' stays out of an index');
    });
});

test('every page carries the same identity, and the marker the server fills in', () => {
    PUBLIC_PAGES.forEach((name) => {
        const head = headOf(name);

        assert.match(head, /<link rel="icon" type="image\/x-icon" href="favicons\/favicon\.ico">/, name);
        assert.match(head, /<link rel="apple-touch-icon" sizes="180x180"/, name);
        assert.match(head, /<link rel="manifest" href="manifest\.webmanifest">/, name);
        assert.match(head, /<meta name="theme-color" content="#121212">/, name);
        assert.match(head, /<!--site-meta-->/, name + ' leaves room for what only the server knows');
    });

    // Every icon named is a file that exists.
    const named = new Set();
    PUBLIC_PAGES.forEach((name) => {
        const head = headOf(name);
        const pattern = /href="(favicons\/[^"]+)"/g;
        let match;
        while ((match = pattern.exec(head))) named.add(match[1]);
    });

    assert.ok(named.size >= 4, 'the icons are named');
    named.forEach((file) => {
        assert.ok(fs.existsSync(path.join(ROOT, file)), file + ' exists');
    });
});

// ============================================
// The address is configuration, never a guess
// ============================================

test('an installation that has not been told where it is claims no address', () => {
    const { meta, restore } = metaWith(null);

    try {
        assert.strictEqual(meta.siteUrl(), null);
        assert.strictEqual(meta.sitemapXml(), null, 'a sitemap of nowhere is not a sitemap');
        assert.ok(!/canonical/.test(meta.headTagsFor('/')), 'and no page claims a canonical address');
        assert.ok(!/og:url/.test(meta.headTagsFor('/')));

        // robots is still answered: what may be crawled does not depend on
        // where this is.
        assert.match(meta.robotsTxt(), /User-agent: \*/);
        assert.ok(!/Sitemap:/.test(meta.robotsTxt()), 'and names no sitemap it cannot serve');
    } finally {
        restore();
    }
});

test('this machine is not a public address', () => {
    ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000', 'not a url', 'ftp://example.com'].forEach(
        (value) => {
            const { meta, restore } = metaWith(value);
            try {
                assert.strictEqual(meta.siteUrl(), null, value + ' is refused');
            } finally {
                restore();
            }
        }
    );
});

test('a configured address reaches the canonical, the sitemap and the record', () => {
    const { meta, restore } = metaWith('https://example.com/');

    try {
        assert.strictEqual(meta.siteUrl(), 'https://example.com', 'and loses its trailing slash');

        const head = meta.headTagsFor('/');
        assert.match(head, /<link rel="canonical" href="https:\/\/example\.com\/">/);
        assert.match(head, /<meta property="og:url" content="https:\/\/example\.com\/">/);
        assert.match(head, /<meta property="og:image" content="https:\/\/example\.com\/favicons\//);

        const sitemap = meta.sitemapXml();
        assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
        assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
        assert.match(sitemap, /<loc>https:\/\/example\.com\/<\/loc>/);
        assert.match(sitemap, /<\/urlset>/);

        assert.match(meta.robotsTxt(), /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
    } finally {
        restore();
    }
});

// ============================================
// What is said is true, and what is private stays private
// ============================================

test('the structured record parses, and claims nothing it cannot support', () => {
    const { meta, restore } = metaWith('https://example.com');

    try {
        ['/', '/about.html', '/developer.html'].forEach((page) => {
            const head = meta.headTagsFor(page);
            const json = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/.exec(head);
            assert.ok(json, page + ' carries a record');

            const record = JSON.parse(json[1].replace(/\\u003c/g, '<'));
            assert.strictEqual(record['@context'], 'https://schema.org');
            assert.ok(record['@type'], page + ' says what kind of thing it is');
            assert.ok(record.description && record.description.length > 40);

            // Nothing invented in order to be ranked.
            ['aggregateRating', 'review', 'reviewCount', 'ratingValue', 'award', 'offers', 'price', 'downloadUrl'].forEach(
                (field) => {
                    assert.ok(!(field in record), page + ' claims no ' + field);
                }
            );
        });

        const app = meta.applicationSchema();
        assert.strictEqual(app['@type'], 'WebApplication');
        assert.strictEqual(app.name, 'Spotifie');
        assert.strictEqual(app.applicationCategory, 'MultimediaApplication');
        assert.strictEqual(app.operatingSystem, 'Web');
        assert.ok(Array.isArray(app.featureList) && app.featureList.length >= 5);
    } finally {
        restore();
    }
});

test('nothing published describes a person, a machine or a library', () => {
    const { meta, restore } = metaWith('https://example.com');

    try {
        // Everything said to a machine, except robots.txt - which is the one
        // file whose whole job is to name what must be left alone, so naming
        // a private area there is the point rather than a leak.
        const published = [
            meta.sitemapXml(),
            meta.llmsTxt(),
            meta.headTagsFor('/'),
            meta.headTagsFor('/about.html'),
            meta.headTagsFor('/developer.html'),
            JSON.stringify(meta.applicationSchema())
        ].join('\n');

        // Nothing belonging to an account or to a disk.
        [
            /\.spotifie/,
            /[A-Za-z]:\\\\/,
            /\/home\/[a-z]/i,
            /\/Users\//,
            /@[a-z0-9-]+\.[a-z]{2,}/i,
            // The secrets, not the name of the service. That Supabase handles
            // sign-in is public architecture - the README and the About page
            // both say it - and saying so leaks nothing. A key would.
            /SUPABASE_URL|SUPABASE_ANON_KEY|anon key|service.role|eyJ[A-Za-z0-9_-]{10}/i,
            /playlist:|local:[0-9a-f]{8}|global-album:/,
            /password|token|secret/i
        ].forEach((pattern) => {
            assert.ok(!pattern.test(published), 'nothing published matches ' + pattern);
        });

        // And robots names no account, no person and no path on a disk either
        // - only addresses this application serves.
        const robots = meta.robotsTxt();
        assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(robots), 'robots names nobody');
        assert.ok(!/[A-Za-z]:\\\\|\/Users\//.test(robots), 'robots names no path on a disk');

        // The sitemap is the three public pages and nothing else.
        const locations = (meta.sitemapXml().match(/<loc>([^<]+)<\/loc>/g) || []).map((entry) =>
            entry.replace(/<\/?loc>/g, '')
        );
        assert.deepStrictEqual(locations, [
            'https://example.com/',
            'https://example.com/about.html',
            'https://example.com/developer.html'
        ]);

        locations.forEach((url) => {
            assert.ok(!/127\.0\.0\.1|localhost/.test(url), 'no address of this machine');
            assert.ok(!/admin|signin|signup|password|api/.test(url), 'nothing private or personal');
        });

        // And what may not be crawled is named.
        ['/api/', '/signin.html', '/.spotifie/'].forEach((entry) => {
            assert.ok(meta.robotsTxt().includes('Disallow: ' + entry), entry + ' is kept out');
        });
    } finally {
        restore();
    }
});

test('the summary written for machines is documentation, and only that', () => {
    const { meta, restore } = metaWith(null);

    try {
        const text = meta.llmsTxt();

        assert.match(text, /^# Spotifie/);
        assert.match(text, /## Capabilities/);
        assert.match(text, /## Architecture/);
        assert.match(text, /## Privacy/);
        assert.match(text, /about\.html#features/);
        assert.match(text, /about\.html#privacy/);
        assert.match(text, /about\.html#accessibility/);
        assert.match(text, /about\.html#terms/);

        // Short enough to be read, and factual enough to be worth reading.
        assert.ok(text.length < 4000, 'it is a summary, not a brochure');
        assert.ok(!/best|world.class|revolutionary|clone|demo/i.test(text), 'it makes no claims it cannot keep');
    } finally {
        restore();
    }
});

// ============================================
// A crawler that cannot run the player still learns what this is
// ============================================

test('the front page describes itself without running anything', () => {
    const html = pageSource('index.html');
    const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'));

    assert.ok(noscript.length > 200, 'there is something to read');
    assert.match(noscript, /<h1>Spotifie - Hybrid Local &amp; Global Music Player<\/h1>/);
    assert.match(noscript, /<h2>What it does<\/h2>/);
    assert.match(noscript, /about\.html#features/);
    assert.match(noscript, /about\.html#privacy/);

    // It describes what the application does. Nothing in it is anybody's
    // library: no song, no album and no collection of a real one appears here,
    // and none of the ids the application addresses them by.
    [/local:[0-9a-f]/, /global(-album)?:/, /playlist\//, /data-folder/, /system:local-music/].forEach((pattern) => {
        assert.ok(!pattern.test(noscript), 'no library content matches ' + pattern);
    });
});

test('each page has one heading that says what the page is', () => {
    ['index.html', 'about.html', 'developer.html'].forEach((name) => {
        const html = pageSource(name);

        // The <noscript> copy is what a crawler reads when the player cannot
        // run, and its heading is the same page's heading, not a second one.
        const withoutNoScript = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
        const headings = withoutNoScript.match(/<h1[\s>]/g) || [];

        assert.strictEqual(headings.length, 1, name + ' has exactly one h1');
    });

    // And the landmarks a reader navigates by.
    const index = pageSource('index.html');
    assert.match(index, /<main class="right/);
    assert.match(index, /<nav /);
    assert.match(index, /<header /);
    assert.match(index, /<footer/);
});

// ============================================
// The manifest
// ============================================

test('the manifest is complete, and claims nothing that is not built', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));

    assert.strictEqual(manifest.name, 'Spotifie - Hybrid Local & Global Music Player');
    assert.strictEqual(manifest.short_name, 'Spotifie');
    assert.strictEqual(manifest.start_url, '/');
    assert.strictEqual(manifest.scope, '/');
    assert.strictEqual(manifest.display, 'standalone');
    assert.strictEqual(manifest.theme_color, '#121212');
    assert.strictEqual(manifest.background_color, '#121212');
    assert.ok(manifest.description.length > 40);

    assert.ok(manifest.icons.length >= 4, 'it names icons');
    manifest.icons.forEach((icon) => {
        assert.ok(fs.existsSync(path.join(ROOT, icon.src)), icon.src + ' exists');
        assert.match(icon.sizes, /^\d+x\d+$/);
        assert.strictEqual(icon.type, 'image/png');
    });

    // Nothing here promises a capability that has not been built.
    ['share_target', 'file_handlers', 'protocol_handlers', 'shortcuts', 'related_applications'].forEach((field) => {
        assert.ok(!(field in manifest), 'the manifest does not claim ' + field);
    });
});
