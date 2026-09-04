import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPENINGS_STAT, OPENINGS_PERCENT } from './openings-stat';

/**
 * Guards for the two problem-intent pages (2026-09-04).
 *
 * These are structural because every way they can fail is structural. The prose either
 * ranks or it does not and no test can say; what a test CAN say is that a crawler can
 * reach the page at all, that something links to it, and that the one number on it is
 * derived rather than typed twice. Each of those has a precedent in this repo: /auto-cart
 * sat in no sitemap for weeks, and Clerk's auth.protect() answers 404 rather than 401, so
 * an unlisted marketing page is one Google indexes and then serves as a dead link.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGES = [
  { path: '/sold-out-campsite', file: '../app/sold-out-campsite/page.tsx' },
  { path: '/campsite-cancellation-alerts', file: '../app/campsite-cancellation-alerts/page.tsx' },
] as const;

test('A CRAWLER CAN REACH THEM — both are public routes', () => {
  const mw = code(read('../middleware.ts'));
  for (const p of PAGES) {
    assert.ok(mw.includes(`'${p.path}'`),
      `${p.path} is not in isPublicRoute — Clerk answers 404, not 401, so Google indexes a dead link`);
  }
});

test('both are in the sitemap', () => {
  const s = code(read('./sitemap-sections.ts'));
  for (const p of PAGES) {
    assert.ok(s.includes(`${'${BASE}'}${p.path}\``), `${p.path} is missing from staticEntries`);
  }
});

test('both declare a canonical', () => {
  for (const p of PAGES) {
    const c = code(read(p.file));
    assert.ok(c.includes(`alternates: { canonical: 'https://camphawk.app${p.path}' }`),
      `${p.path} has no canonical, or it does not match its own URL`);
  }
});

test('SOMETHING LINKS TO THEM — a page nothing points at is a sitemap entry, not a destination', () => {
  const hub = code(read('../app/camping/page.tsx'));
  for (const p of PAGES) {
    assert.ok(hub.includes(`href="${p.path}"`), `/camping does not link to ${p.path}`);
  }
  // The strongest internal link this site can give: every campground page.
  const openings = code(read('../components/v2/CampgroundOpenings.tsx'));
  assert.ok(openings.includes('href="/sold-out-campsite"'),
    'the campground pages no longer link to the guide');
});

test('THE CAMPGROUND EXIT IS UNCONDITIONAL', () => {
  // Three states have no landing page, so the state link is inside a guard and those
  // leaves had no exits at all. If this link moves inside that guard it silently stops
  // covering exactly the pages that needed it.
  const c = code(read('../components/v2/CampgroundOpenings.tsx'));
  const link = c.indexOf('href="/sold-out-campsite"');
  const section = c.indexOf('<section');
  assert.ok(link > -1 && section > -1, 're-anchor this guard');
  assert.ok(section < link, 're-anchor this guard');
  // POSITION IS NOT ENOUGH, and the first version of this test proved it: a mutation that
  // wrapped the link in `{stateName && ...}` kept it above the state guard and passed.
  // What matters is that NOTHING conditional stands between the section and the link, so
  // the exit exists on every campground page including the three states with no landing
  // page — which are exactly the leaves that had no exits at all before it.
  const before = c.slice(section, link);
  for (const conditional of ['&&', '? (', 'stateName', 'stateSlug']) {
    assert.ok(!before.includes(conditional),
      `the guide link is behind a condition ("${conditional}") — it must render on every campground page`);
  }
});

test('NO PRICE ON EITHER PAGE — they render inside the native webview', () => {
  for (const p of PAGES) {
    const c = read(p.file);
    assert.ok(!/\$\d/.test(c), `${p.path} names a price; the app stores forbid it. Link /pricing instead.`);
  }
});

test('THE STATISTIC IS DERIVED, NOT TYPED TWICE', () => {
  assert.equal(OPENINGS_PERCENT, `${((100 * OPENINGS_STAT.openings) / OPENINGS_STAT.checks).toFixed(1)}%`);
  for (const p of PAGES) {
    const c = code(read(p.file));
    assert.ok(c.includes('OPENINGS_PERCENT'),
      `${p.path} must render the derived percentage, never a literal that can drift from the counts`);
    assert.ok(!/\b0\.9%/.test(c), `${p.path} hardcodes the percentage beside the counts it is computed from`);
  }
});

test('THE COUNTS ARE INTERNALLY CONSISTENT', () => {
  // A guard against the numbers being edited by hand into something impossible — the
  // page's whole claim to being different from a competitor's blog post is that these
  // are a real count.
  assert.ok(OPENINGS_STAT.openings < OPENINGS_STAT.checks, 'more openings than checks');
  assert.ok(OPENINGS_STAT.campgrounds > 0 && OPENINGS_STAT.checks > OPENINGS_STAT.campgrounds);
});

test('THE FREE-OPTION PARAGRAPH STAYS', () => {
  // It is the credibility of the whole page: recreation.gov's own alerts are free and
  // findable in a minute, so omitting them reads as hoping the reader will not check.
  // Deleting it is the change that looks like tightening the pitch.
  const c = code(read('../app/campsite-cancellation-alerts/page.tsx'));
  assert.ok(/Recreation\.gov has had its own availability alerts/.test(c),
    'the free-alternative paragraph was removed');
});

test('NO PRICE COMPARISON WITH A NAMED COMPETITOR', () => {
  // docs/GROWTH.md section 5: the free floor here is genuinely free, so undercutting is
  // not a wedge and putting it in copy invites the one comparison we lose.
  for (const p of PAGES) {
    const c = read(p.file).toLowerCase();
    for (const name of ['campnab', 'campflare', 'outdoorithm', 'schnerp', 'wandering labs']) {
      assert.ok(!c.includes(name), `${p.path} names ${name} — see docs/GROWTH.md section 5`);
    }
  }
});
