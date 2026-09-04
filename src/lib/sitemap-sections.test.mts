/**
 * Guards for the sitemap sections.
 *
 * Under `src/`, not `worker/` — `worker/**` is the first entry in `worker-deploy.yml`'s
 * `paths:`, so a guard over web modules there restarts both poller machines.
 *
 * THE FAILURES THESE COVER ARE ALL SILENT. A section missing from the main sitemap, a route
 * 404ing to Googlebot behind Clerk, an unescaped ampersand invalidating a whole document —
 * none of them errors, none of them is visible without opening Search Console weeks later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SITEMAP_SECTIONS, toSitemapXml, xmlEscape, BASE } from './sitemap-sections';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the main sitemap composes EVERY section, over the registry', () => {
  // A section added to SITEMAP_SECTIONS and forgotten in app/sitemap.ts would be served at
  // /sitemaps/<slug> while absent from the sitemap actually submitted — two documents
  // disagreeing about what the site is, which makes the per-segment numbers meaningless.
  // Pinned structurally because no behavioural test can see a section nobody has written yet.
  const src = code('app/sitemap.ts');
  assert.match(src, /SITEMAP_SECTIONS\.map\(\(s\) => s\.load\(\)\)/,
    'app/sitemap.ts no longer composes the registry — a new section would be silently omitted');
});

test('/sitemaps/(.*) is a PUBLIC route', () => {
  // It carries no file extension, so middleware's matcher does not skip it the way it skips
  // /sitemap.xml — and Clerk's auth.protect() answers 404, not 401. Without this Googlebot
  // gets a 404 from a route that reads perfectly correctly in source, and nothing anywhere
  // reports it.
  assert.match(code('middleware.ts'), /'\/sitemaps\/\(\.\*\)'/);
});

test('robots advertises every section, derived rather than typed out', () => {
  const src = code('app/robots.ts');
  assert.match(src, /SITEMAP_SECTIONS\.map/, 'the list is hand-written and will go stale');
  assert.match(src, /\/sitemap\.xml/, 'the main sitemap must stay advertised — it is the one already registered');
});

test('the four sections are the ones expected, and campgrounds is one of them', () => {
  assert.deepEqual(SITEMAP_SECTIONS.map((s) => s.slug), ['pages', 'states', 'type-hubs', 'campgrounds']);
});

test('/auto-cart is in the pages section', async () => {
  // The page explaining the differentiator was in no sitemap at all until 2026-09-03.
  const urls = (await SITEMAP_SECTIONS.find((s) => s.slug === 'pages')!.load()).map((e) => String(e.url));
  assert.ok(urls.includes(`${BASE}/auto-cart`), `pages section: ${urls.join(', ')}`);
});

// ── serialisation ────────────────────────────────────────────────────────────────────────

test('an ampersand in a URL is escaped — one unescaped & discards the WHOLE document', () => {
  // Google does not drop the bad URL, it drops the sitemap. Campground ids reach the path,
  // and we have not seen every id the catalog will ever hold.
  const xml = toSitemapXml([{ url: 'https://camphawk.app/campground/a&b' }]);
  assert.ok(xml.includes('<loc>https://camphawk.app/campground/a&amp;b</loc>'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'a bare ampersand reached the output');
});

test('the ampersand is escaped FIRST', () => {
  // Escaping < before & turns "<" into "&lt;" and then into "&amp;lt;" — double-escaped, so
  // the reader sees the literal text "&lt;" instead of a character.
  assert.equal(xmlEscape('<a & b>'), '&lt;a &amp; b&gt;');
});

test('an unparseable lastModified is OMITTED, never emitted as Invalid Date', () => {
  // A malformed <lastmod> invalidates the document. The field is an optimisation; the
  // document is not.
  const xml = toSitemapXml([{ url: `${BASE}/x`, lastModified: new Date('nonsense') }]);
  assert.ok(!xml.includes('lastmod'), xml);
  assert.ok(xml.includes(`<loc>${BASE}/x</loc>`), 'the URL itself must survive');
});

test('a valid lastModified is ISO-8601', () => {
  const xml = toSitemapXml([{ url: `${BASE}/x`, lastModified: new Date('2026-09-01T00:00:00Z') }]);
  assert.ok(xml.includes('<lastmod>2026-09-01T00:00:00.000Z</lastmod>'), xml);
});

test('the document is a well-formed urlset with the right namespace', () => {
  const xml = toSitemapXml([{ url: `${BASE}/`, changeFrequency: 'daily', priority: 1 }]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
  assert.ok(xml.includes('<changefreq>daily</changefreq>'));
  assert.ok(xml.includes('<priority>1</priority>'));
  assert.ok(xml.trimEnd().endsWith('</urlset>'));
});

test('an unknown section is a 404, never an empty urlset', () => {
  // An empty urlset tells Google the section genuinely has no pages — a claim about the
  // site. A 404 says we do not serve that name, which is the truth.
  const src = code('app/sitemaps/[section]/route.ts');
  assert.match(src, /if \(!found\) return new Response\('Not found', \{ status: 404 \}\)/);
  // And a failure is a 500, for the same reason: Google retries a 500 and BELIEVES an empty
  // document, so a DB blip must not drop 6,934 campgrounds from coverage.
  assert.match(src, /status: 500/);
  assert.ok(!/toSitemapXml\(\[\]\)/.test(src), 'it serves an empty urlset on some path');
});
