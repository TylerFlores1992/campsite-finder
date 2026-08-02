// Regression tests for the one-cart-per-(watch, site) rule.
//
// Run: npm test   (node:test via tsx — no test framework dependency)
//
// These hit the REAL database, deliberately, for the same reason the claim suite
// does: the rule is a SQL predicate over autocart_jobs, so a mocked client would be
// testing a fake instead of the thing that decides.
//
// SAFETY: fixture watches are created with dates in 2020. Nothing here writes to
// watch_site_alerts and nothing enqueues real work — the autocart_jobs rows are
// inserted already-resolved and hang off the fixture watches, which are deleted on
// the way out (autocart_jobs cascades with them). No live user's cart is touched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { alreadyCartedForWatch } from './carted-history';

const SITE = 'test-site-84611';
const OTHER_SITE = 'test-site-99999';

let userId: string;
let campgroundId: string;
let watchId: string;
let otherWatchId: string;

async function makeWatch(): Promise<string> {
  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, true) RETURNING id`,
    [userId, campgroundId]
  );
  return w.id;
}

async function addJob(wId: string, siteId: string, outcome: string | null, resolution: string | null) {
  await mutate(
    `INSERT INTO autocart_jobs (watch_id, user_id, campground_id, campsite_id, payload, cart_outcome, resolution)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6)`,
    [wId, userId, campgroundId, siteId, outcome, resolution]
  );
}

before(async () => {
  const [user] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  assert.ok(user, 'need at least one user row to hang a fixture watch off');
  userId = user.id;
  const [cg] = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'ridb' ORDER BY id LIMIT 1`
  );
  assert.ok(cg, 'need at least one campground');
  campgroundId = cg.id;

  watchId = await makeWatch();
  otherWatchId = await makeWatch();
});

after(async () => {
  for (const id of [watchId, otherWatchId].filter(Boolean)) {
    await mutate(`DELETE FROM watches WHERE id = $1`, [id]);
  }
});

test('a site with no history is cartable', async () => {
  assert.equal(await alreadyCartedForWatch(watchId, SITE), false);
});

test('a carted job blocks a second cart of the same site on the same watch', async () => {
  await addJob(watchId, SITE, 'carted', 'carted');
  assert.equal(await alreadyCartedForWatch(watchId, SITE), true);
});

test('a different site on the same watch is still cartable', async () => {
  // The whole point of per-SITE rather than per-watch: the guard must not turn into
  // "one cart per watch, ever". A second site opening is a new opportunity.
  assert.equal(await alreadyCartedForWatch(watchId, OTHER_SITE), false);
});

test('a NEW watch for the same campground and site starts over', async () => {
  // The user-facing promise: re-creating the watch resets the do-not-cart list. It
  // holds because the key is watch_id and a new watch is a new id.
  assert.equal(await alreadyCartedForWatch(otherWatchId, SITE), false);
});

test('a late carted report still blocks, even when the reconciler resolved it as alerted', async () => {
  // The bot reported 'carted' after the reconciler had already given up and sent the
  // normal alert. It IS in the user's cart, so it must not be carted again — this is
  // why the predicate checks cart_outcome as well as resolution.
  await addJob(otherWatchId, OTHER_SITE, 'carted', 'alerted');
  assert.equal(await alreadyCartedForWatch(otherWatchId, OTHER_SITE), true);
});

test('a failed cart attempt does NOT block a retry', async () => {
  // 'already-booked' means the page showed the site as taken — we never got it. The
  // user is still owed a cart if it genuinely opens later.
  const w = await makeWatch();
  try {
    await addJob(w, SITE, 'already-booked', 'silent');
    await addJob(w, SITE, 'cta-not-ready', 'alerted');
    assert.equal(await alreadyCartedForWatch(w, SITE), false);
  } finally {
    await mutate(`DELETE FROM watches WHERE id = $1`, [w]);
  }
});
