import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HARD_TO_BOOK, loadHardToBook } from './hardToBook';

/**
 * Guards the curated "always booked" hub — see `hardToBook.ts` for what it is
 * and why it is a judgement call rather than a measurement.
 *
 * REAL DB, AND THAT IS THE ENTIRE POINT OF THE FIRST TEST. The list is 28
 * hardcoded catalog ids. Provider reorganisations DO move ids — that is why
 * `loadHardToBook` drops an unresolvable row instead of rendering a dead link —
 * and the silent-drop behaviour that keeps the page healthy is exactly what
 * makes the rot invisible. A page quietly serving 22 of 28 entries looks fine
 * forever. So the loud half lives here, where a human sees it, and CI is what
 * notices before Search Console does three months later. Mocking the catalog
 * would test the mock.
 */

const src = (p: string) => readFileSync(resolve(import.meta.dirname, '..', p), 'utf8');
const PAGE = 'app/camping/hardest-to-book/page.tsx';
const HUB = 'app/camping/page.tsx';
const SITEMAP = 'app/sitemap.ts';

test('every curated id still resolves in the live catalog', async () => {
  const groups = await loadHardToBook();
  const found = new Set(groups.flatMap((g) => g.campgrounds.map((c) => c.id)));
  const missing = HARD_TO_BOOK.filter((e) => !found.has(e.id));
  assert.deepEqual(
    missing.map((m) => `${m.id} (${m.park})`),
    [],
    'a curated campground has vanished or been hidden — the hub is silently ' +
      'serving fewer entries than it claims. Re-derive the id from the catalog.',
  );
});

test('no id is listed twice', () => {
  const ids = HARD_TO_BOOK.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'a duplicate would render the same link twice');
});

test('grouping preserves the curated order, Yosemite first', async () => {
  const groups = await loadHardToBook();
  assert.ok(groups.length > 0, 'nothing resolved at all — is the catalog reachable?');
  // Deliberately not alphabetical: the first group is what a reader sees before
  // deciding whether to stay, and Yosemite is the query this page most wants.
  assert.equal(groups[0]?.park, 'Yosemite National Park');
  // Each park appears exactly once, or the page renders the same <h2> twice.
  const parks = groups.map((g) => g.park);
  assert.equal(new Set(parks).size, parks.length);
});

test('the page states that the list is curated, NOT measured', () => {
  // The honesty guard, and the one most likely to be "tidied" away — "our own
  // pick of famously oversubscribed campgrounds" is a weaker sentence than "the
  // 28 hardest campgrounds to book in America", and somebody will eventually
  // want the stronger one. We cannot back it: Feature E's accrual has been
  // stopped since 2026-07-30, its buckets never covered the short-lead window,
  // and the watch table is 74 rows mostly belonging to the owner. This repo's
  // expensive failures are all confident figures nobody measured.
  const s = src(PAGE);
  assert.match(
    s,
    /not a measured ranking/,
    'the page must say the list is a judgement call, because it is',
  );
  assert.doesNotMatch(
    s,
    /\b(hardest|most)\b[^<]{0,40}\bin (America|the country|the US)\b/i,
    'that is a national ranking claim and nothing here computed one',
  );
});

test('the hub is reachable and submitted, not an orphan', () => {
  // A page nothing links to is a sitemap entry, not a destination — the same
  // reasoning that made /camping exist for the 47 state pages. Both halves are
  // pinned because either alone is inert.
  assert.match(src(HUB), /href="\/camping\/hardest-to-book"/, 'nothing links to the hub');
  assert.match(src(SITEMAP), /camping\/hardest-to-book/, 'the hub is not in the sitemap');
});

test('the page links out to the campground leaves — that is its whole job', () => {
  // Concentrating internal link equity on the high-intent leaves IS the reason
  // this page exists. A version that described the campgrounds without linking
  // to them would look correct and deliver nothing.
  assert.match(src(PAGE), /href=\{`\/campground\/\$\{encodeURIComponent\(c\.id\)\}`\}/);
});
