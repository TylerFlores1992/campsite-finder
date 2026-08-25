import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  campgroundTitle,
  campgroundDescription,
  campgroundOpeningsBody,
  campgroundOpeningsHeading,
  stateTitle,
  stateDescription,
} from './seo';
import type { Campground } from './types';

/**
 * Guards what SURVIVED the 2026-08-25 cancellation retarget — and, more usefully,
 * pins the part that was falsified so it is not re-tried by hand.
 *
 * THE ASSERTIONS ABOUT THE TITLE ARE INVERTED FROM WHAT THEY FIRST SAID, and that
 * inversion IS the finding. The titles briefly carried "Cancellations"; Search
 * Console answered within a day — a query filter for "cancel" returns NO DATA across
 * 1,000 rows and 28 days, and 23 of the top 25 queries by impressions contain
 * "camping", "campground" or "campsite". The retarget had removed the highest-
 * frequency token in the real demand from every title on the site. The full account
 * is in the header of `seo.ts`; the tests below are what stop it coming back
 * silently.
 *
 * WHY A TEST AND NOT JUST THE UNIQUENESS CHECK. `scripts/seo-check.mts` already
 * proves titles and descriptions don't collide, and it would go on passing
 * happily if every one of them reverted to "camping availability" tomorrow —
 * uniqueness is orthogonal to what the pages are ABOUT. The retarget is a
 * deliberate bet with a written falsification condition, and the thing that
 * would quietly undo it is somebody tidying a template back toward the old
 * wording without knowing a bet was placed.
 *
 * IT LIVES IN `src/lib/`, NOT `worker/`, AND THAT IS DELIBERATE. `npm test`
 * globs both. But `worker/**` is a trigger path for `worker-deploy.yml`, so a
 * guard filed there would restart both poller machines on merge — and this
 * change went in on an evening with a tapped hold releasing at 08:00 the next
 * morning. None of the three files this guards is in the worker's import
 * closure, so the merge is Vercel-only; putting its test in `worker/` would
 * have manufactured a poller restart that the change itself never needed.
 *
 * Several assertions are STRUCTURAL (they read the source of the page and the
 * component). That is on purpose: the copy functions can be perfect while
 * nothing renders them, which is the "fix present but inert" shape this repo has
 * shipped at least three times — `6006428` claiming to fix the RC URL while only
 * touching the copy is the canonical one.
 */

const src = (p: string) => readFileSync(resolve(import.meta.dirname, '..', p), 'utf8');

/** Block and line comments out, so an assertion about CODE can never be
 *  satisfied — or defeated — by a comment that merely discusses it. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const OPENINGS = 'components/v2/CampgroundOpenings.tsx';
const PAGE = 'app/(app)/campground/[id]/page.tsx';
const STATE_PAGE = 'app/camping/[state]/page.tsx';

const cg = (over: Partial<Campground> = {}): Campground =>
  ({
    id: '232447',
    source: 'ridb',
    name: 'Kirk Creek Campground',
    address: { city: 'Big Sur', state: 'CA' },
    siteTypes: ['tent', 'rv'],
    photos: [],
    amenities: [],
    ...over,
  }) as unknown as Campground;

// ---------------------------------------------------------------- the wording

test('the campground title keeps the word people actually search for', () => {
  // A SHORT NAME, DELIBERATELY. With an 11-char brand, a 14-char place and a
  // 21-char qualifier against a 65 target, only names of ~19 characters or less keep
  // the full form — which is the measured 37.3%. A "Kirk Creek Campground" fixture
  // falls to the name+place rung and would test nothing about the qualifier.
  const t = campgroundTitle(cg({ name: 'Kirk Creek' }));
  // "camping" is the load-bearing token: it is in 23 of the top 25 queries by
  // impressions ("ohiopyle camping", "watkins glen state park camping", "camping in
  // georgia"). Many campground NAMES do not contain it — "Ohiopyle State Park",
  // "Clinch River Valley State Park" — so the qualifier is the only place it appears.
  assert.match(t, /camping/i, 'the highest-frequency token in real demand must survive');
  assert.doesNotMatch(
    t,
    /Cancellation/i,
    'this was tried on 2026-08-25 and falsified the same day: a query filter for ' +
      '"cancel" returns NO DATA. Do not reinstate it without Search Console showing ' +
      'real impressions on cancellation-shaped queries. See the header of seo.ts.',
  );
  assert.match(t, /Kirk Creek/);
  assert.match(t, /Big Sur, CA/);
});

test('the title ladder drops the qualifier before the place', () => {
  // A long name forces the ladder down. Place is what separates two campgrounds
  // sharing a name ("Rock Island State Park" is in both TN and WI), so it must
  // outrank the keyword — dropping it first costs a whole distinct page.
  //
  // THE FIXTURE LENGTH IS LOAD-BEARING AND THE FIRST ONE WAS WRONG. With an
  // 11-character brand against a 65 target the head gets 54, so the name+place
  // rung needs a name of 29..41 characters; the first attempt used 58, which
  // fell PAST that rung to the bare name and made the assertion fail against
  // correct code. A guard whose fixture never reaches the branch it is testing
  // proves nothing either way.
  const long = cg({ name: 'Indian Lake State Park — Horseshoe' }); // 34 chars
  const t = campgroundTitle(long);
  assert.doesNotMatch(t, /camping availability/, 'qualifier should have been dropped first');
  assert.match(t, /Big Sur, CA/, 'place must survive longer than the qualifier');
});

test('the meta description leads with availability and still names the cancellation', () => {
  const d = campgroundDescription(cg());
  // Discovery intent, not failed-booking intent — every query this site receives is
  // somebody looking for a campground, not somebody already blocked. The cancellation
  // promise closes the sentence rather than opening it.
  assert.match(d, /Live campsite availability/i);
  assert.match(d, /Kirk Creek Campground/, 'name carries uniqueness');
  assert.match(d, /Big Sur, CA/, 'place carries uniqueness');
  assert.ok(d.length <= 158, `descriptions over 158 get truncated (${d.length})`);

  // KNOWN AND PRE-EXISTING, PINNED SO IT IS NOT MISTAKEN FOR A REGRESSION: on a row
  // with several site types the 158-char clamp eats the tail, so the cancellation
  // promise — the entire reason to subscribe — is truncated out of the snippet. It
  // survives only on shorter rows. This predates the 2026-08-25 work (the clamp and
  // the sentence order are both original) and is worth fixing on its own terms;
  // reordering it was part of the falsified retarget and is NOT the fix.
  const shortRow = campgroundDescription(cg({ siteTypes: [] }));
  assert.match(shortRow, /cancelled/i, 'a row with no site types must still reach the promise');
  const longRow = campgroundDescription(cg({ siteTypes: ['tent', 'rv', 'cabin'] }));
  assert.doesNotMatch(longRow, /cancelled/i, 'if this now passes, the clamp was fixed — good, update this');
});

test('a campground with no place still gets a unique, non-empty description', () => {
  const d = campgroundDescription(cg({ address: undefined }));
  assert.ok(d.length >= 50, 'an empty description makes Google invent one, badly');
  assert.match(d, /Kirk Creek Campground/);
});

test('state pages stay inventory-first', () => {
  // /camping/california is the highest-impression page on the site (725 in 28 days,
  // position 69.3) and its queries are pure discovery. It is the riskiest place on
  // the site to spend a title on a phrasing nobody searches.
  const t = stateTitle('California', 869);
  assert.match(t, /Campgrounds/);
  assert.doesNotMatch(t, /Cancellation/i, 'falsified 2026-08-25 — see seo.ts header');
  const d = stateDescription('California', 869);
  assert.ok(d.length <= 160, `state descriptions are capped at 160 (${d.length})`);
  assert.match(d, /869/, 'the count is what makes each state description distinct');
});

// ----------------------------------------------------------------- the body

test('the openings heading asks the question the visitor typed', () => {
  assert.equal(
    campgroundOpeningsHeading('Kirk Creek Campground'),
    'Is Kirk Creek Campground fully booked?',
  );
});

test('the auto-cart promise appears ONLY where the bot can honour it', () => {
  const withCart = campgroundOpeningsBody('X', 'Big Sur, CA', true).join(' ');
  assert.match(withCart, /cart/i, 'rec.gov pages should say we can cart it');

  // The sharp one. Promising auto-cart on a portal the bot has no account for is
  // a promise we break in front of somebody at 08:00 — the same rule
  // `supportsRcHold` enforces on the alert side, and the reason the flag exists
  // rather than the caller hand-writing two variants.
  const without = campgroundOpeningsBody('X', 'Big Sur, CA', false).join(' ');
  assert.doesNotMatch(
    without,
    /cart/i,
    'a non-rec.gov page must not promise auto-cart',
  );
});

test('the body states the real poll interval and mentions availability', () => {
  const body = campgroundOpeningsBody('Kirk Creek Campground', 'Big Sur, CA', true).join(' ');
  // 15 seconds is the poller's actual interval. This file has a long history of
  // confident figures that turned out wrong; a marketing number that drifts from
  // the code is the cheapest possible way to start another one.
  assert.match(body, /every 15 seconds/);
  // "Availability" left the title for want of room — it has to land here or it
  // has simply been dropped.
  assert.match(body, /availability/i);
  assert.match(body, /Kirk Creek Campground/, 'the copy must name the campground');
});

// ------------------------------------------------------------- the wiring

test('CampgroundOpenings is a SERVER component', () => {
  // COMMENTS ARE STRIPPED FIRST, and that is not fussiness. The component's own
  // header explains the regression it exists to prevent by NAMING `useEffect` —
  // so a bare scan of the source matched the explanation, failed against correct
  // code, and would have been "fixed" by deleting the paragraph that makes the
  // rule understandable. `worker/chromium-attribution.test.mts` records the same
  // trap. Assert against code, never against prose about the code.
  const s = stripComments(src(OPENINGS));
  assert.doesNotMatch(
    s.trimStart().slice(0, 40),
    /^["']use client["']/,
    'the SEO-load-bearing prose must not depend on client hydration — these ' +
      'pages already shipped a loading skeleton to Google once',
  );
  assert.doesNotMatch(s, /\buseState\b|\buseEffect\b/, 'a hook here forces it client-side');
});

test('the campground page actually renders it, below the detail view', () => {
  const s = src(PAGE);
  const detailAt = s.indexOf('<CampgroundDetail');
  const openingsAt = s.indexOf('<CampgroundOpenings');
  assert.ok(detailAt > -1, 'CampgroundDetail is not rendered — anchor is stale');
  assert.ok(openingsAt > -1, 'the section is not rendered: the copy exists but is inert');
  // Below the availability grid. Someone arriving from a cancellation query
  // wants to see whether anything is open RIGHT NOW; keyword prose pushed above
  // the useful widget is the doorway-page pattern.
  assert.ok(
    openingsAt > detailAt,
    'the prose must sit BELOW the availability grid, not above it',
  );
});

test('the state page h1 stays inventory-first', () => {
  const s = src(STATE_PAGE);
  const h1 = s.slice(s.indexOf('<h1'), s.indexOf('</h1>'));
  assert.match(h1, /Campgrounds in \{name\}/);
  assert.doesNotMatch(h1, /cancellation/i, 'falsified 2026-08-25 — see seo.ts header');
});
