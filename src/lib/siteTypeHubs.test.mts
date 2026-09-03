import { test } from 'node:test';
import { siteTypeEntries, SITEMAP_SECTIONS } from './sitemap-sections';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SITE_TYPE_HUBS,
  hubBySlug,
  statesForType,
  campgroundsOfTypeInState,
  typeTotals,
} from './siteTypeHubs';
import { MIN_CAMPGROUNDS_FOR_STATE_PAGE } from './stateCampgrounds';
import { query } from './db/client';

/**
 * Guards the accommodation-type hubs — /camping/cabins, /camping/group-camping,
 * /camping/yurts and their 69 per-state children.
 *
 * REAL DB, DELIBERATELY. The whole build rests on one claim about the catalog: that
 * `site_types` is a clean, normalised, MULTI-SOURCE vocabulary. That claim has been
 * wrong before in exactly this repo — `showers` looked like a perfectly good facet
 * and turned out to exist on recreation.gov rows only (197 of 4,469, zero across the
 * other seven sources), which is why it was pulled from the Explore filters on
 * 2026-08-15. A single-source facet builds pages that silently exclude most of the
 * catalog while looking completely healthy. A mock cannot catch that; only the
 * catalog can.
 */

const src = (p: string) => readFileSync(resolve(import.meta.dirname, '..', p), 'utf8');
const CAMPING_HUB = 'app/camping/page.tsx';
const STATE_PAGE = 'app/camping/[state]/page.tsx';

test('every configured site type exists in the catalog and is MULTI-SOURCE', async () => {
  for (const hub of SITE_TYPE_HUBS) {
    const [r] = await query<{ n: number; srcs: number }>(
      `SELECT count(*)::int n, count(DISTINCT source)::int srcs
         FROM campgrounds
        WHERE reservable = true AND hidden = false AND $1 = ANY(site_types)`,
      [hub.siteType],
    );
    assert.ok(r.n > 0, `site type "${hub.siteType}" matches nothing — is it a real value?`);
    // The showers rule. Two or more sources is a low bar deliberately: yurts run to
    // only 50 rows nationally, so a strict floor would fail an honest facet. What it
    // catches is the single-source case, which is the one that misleads.
    assert.ok(
      r.srcs >= 2,
      `"${hub.siteType}" exists on ${r.srcs} source(s) — a single-source facet builds ` +
        `pages that silently exclude the rest of the catalog, as "showers" did`,
    );
  }
});

test('tent and rv are NOT hubs', () => {
  // They cover 4,304 and 3,486 campgrounds, so nearly everything qualifies: the pages
  // would near-duplicate the state pages, and "tent camping in Oregon" is a head term
  // owned by every outdoor publisher alive. The thesis is specificity.
  const slugs = SITE_TYPE_HUBS.map((h) => h.siteType);
  assert.ok(!slugs.includes('tent'));
  assert.ok(!slugs.includes('rv'));
});

test('each hub has a route file, and each route file has a hub', () => {
  // The inert-fix shape: config without routes renders nothing, routes without config
  // 404. Both halves are pinned because either alone looks correct in a diff.
  for (const hub of SITE_TYPE_HUBS) {
    assert.ok(
      existsSync(resolve(import.meta.dirname, '..', `app/camping/${hub.slug}/page.tsx`)),
      `no hub route for ${hub.slug}`,
    );
    assert.ok(
      existsSync(resolve(import.meta.dirname, '..', `app/camping/${hub.slug}/[state]/page.tsx`)),
      `no per-state route for ${hub.slug}`,
    );
    assert.equal(hubBySlug(hub.slug)?.siteType, hub.siteType);
  }
});

test('no hub slug can collide with a state slug', async () => {
  // /camping/cabins sits beside /camping/[state]. Next resolves static ahead of
  // dynamic so the hub wins, but a slug that is ALSO a real state slug would make one
  // of the two unreachable with nothing failing.
  const { stateSlug } = await import('./coverage');
  const stateSlugs = new Set(
    // Every 2-letter code we could produce, so this does not depend on catalog state.
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'
      .split(' ')
      .map((c) => stateSlug(c))
      .filter((s): s is string => s !== null),
  );
  for (const hub of SITE_TYPE_HUBS) {
    assert.ok(!stateSlugs.has(hub.slug), `hub slug "${hub.slug}" is also a state slug`);
  }
});

test('the state threshold is SHARED with the plain state pages', async () => {
  // One definition of "enough to be worth landing on". If these diverged,
  // /camping/cabins would advertise a state whose page 404s, or vice versa.
  const states = await statesForType('cabin');
  assert.ok(states.length > 0);
  for (const s of states) {
    assert.ok(
      s.count >= MIN_CAMPGROUNDS_FOR_STATE_PAGE,
      `${s.code} has ${s.count}, under the shared threshold`,
    );
  }
});

test('a state under the threshold gets null, not a thin page', async () => {
  // Yurts qualify in four states; everywhere else must refuse. A soft 404 (a 200
  // carrying "nothing here") gets indexed as thin content rather than dropped.
  const qualifying = new Set((await statesForType('yurt')).map((s) => s.code));
  assert.ok(qualifying.size >= 1 && qualifying.size < 50, 'yurt states look wrong');
  const notQualifying = ['NY', 'TX', 'FL', 'AK', 'MT'].filter((c) => !qualifying.has(c));
  assert.ok(notQualifying.length > 0, 'expected at least one non-qualifying state to test');
  for (const code of notQualifying) {
    assert.equal(
      await campgroundsOfTypeInState('yurt', code),
      null,
      `${code} is under the yurt threshold and must return null`,
    );
  }
});

test('hub totals equal the sum of the states it links to', async () => {
  // The hub prints a count and then lists the states. If those disagree the page
  // contradicts itself in public, which is what sharing one loader prevents.
  for (const hub of SITE_TYPE_HUBS) {
    const states = await statesForType(hub.siteType);
    const totals = await typeTotals(hub.siteType);
    assert.equal(totals.states, states.length);
    assert.equal(totals.campgrounds, states.reduce((a, s) => a + s.count, 0));
  }
});

test('the hubs are reachable and submitted, not orphans', async () => {
  const hub = src(CAMPING_HUB);
  // ANCHORED ON THE HREF, NOT ON THE IDENTIFIER. The first version asserted that
  // "SITE_TYPE_HUBS" appeared in the file, which the IMPORT LINE satisfies on its
  // own — so replacing the actual `SITE_TYPE_HUBS.map(...)` with `[].map(...)`
  // orphaned every hub and the guard passed. Caught by mutation testing, and it is
  // the same shape recorded against autocart-beta.test.mts: an assertion that
  // matches an import proves the module is imported, not that it is used.
  assert.match(
    hub,
    /href=\{`\/camping\/\$\{h\.slug\}`\}/,
    '/camping does not render links to the type hubs',
  );
  assert.match(hub, /SITE_TYPE_HUBS\.map/, 'the hub list is not driven by the config');
  // BEHAVIOURAL: `siteTypeEntries` moved out of `app/sitemap.ts` into
  // `lib/sitemap-sections.ts`, and a grep for the identifier broke over a pure refactor.
  // Loading the section is the question actually being asked.
  const typeUrls = (await siteTypeEntries()).map((e) => String(e.url));
  for (const h of SITE_TYPE_HUBS) {
    assert.ok(
      typeUrls.includes(`https://camphawk.app/camping/${h.slug}`),
      `/camping/${h.slug} is not in the sitemap`,
    );
  }
  // AND THAT IT REACHES THE SITEMAP THE SITE ACTUALLY SERVES. A section can be perfect and
  // never composed — the fix-present-but-inert shape — so this asserts membership of the
  // flattened registry, which is exactly what `app/sitemap.ts` returns. The old version
  // pinned the literal spread expression and broke when the composition became a `.map` over
  // the registry, over behaviour that had not changed.
  const whole = (await Promise.all(SITEMAP_SECTIONS.map((sec) => sec.load()))).flat();
  const wholeUrls = whole.map((e) => String(e.url));
  for (const h of SITE_TYPE_HUBS) {
    assert.ok(
      wholeUrls.includes(`https://camphawk.app/camping/${h.slug}`),
      `/camping/${h.slug} is in its section but not in the composed sitemap`,
    );
  }
});

test('state pages link DOWN to their own type pages', () => {
  // The link that actually matters: /camping/california carries 725 impressions in
  // 28 days and the type pages carry none. A hub linked only from /camping is one
  // hop from nothing; the state pages are where the crawler already goes.
  const s = src(STATE_PAGE);
  assert.match(s, /typesAvailableInState/, 'the state page computes no type links');
  assert.match(s, /\/camping\/\$\{h\.slug\}\/\$\{state\}/, 'the down-link href is missing');
});
