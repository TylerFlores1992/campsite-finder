// One watch, several campgrounds (migration 070) — the two places that decide whether
// a division of a park gets its own alert or is silently swallowed by a sibling.
//
// SAFETY, same as claim.test.mts: the fixture watch is dated 2020, so the poller's
// candidate query (`end_date > CURRENT_DATE`) can never see it while the claim functions
// still can. Everything is deleted on the way out and `watch_campgrounds` cascades with
// the watch. Nothing here can suppress a real user's alert.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { claimNotification, siteKeyFor, WHOLE_CAMPGROUND_SITE_KEY } from './claim';

let watchId: string;
let cgA: string;
let cgB: string;

/** The expansion exactly as loadWatches does it — see worker/poller.ts. */
const EXPAND = `
  SELECT w.id, c.id AS campground_id,
         (COALESCE(array_length(e.ids, 1), 1) > 1) AS multi_campground
    FROM watches w
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        (SELECT array_agg(wc.campground_id ORDER BY wc.campground_id)
           FROM watch_campgrounds wc WHERE wc.watch_id = w.id),
        ARRAY[w.campground_id]) AS ids) e
    CROSS JOIN LATERAL unnest(e.ids) AS pair(campground_id)
    JOIN campgrounds c ON c.id = pair.campground_id
   WHERE w.id = $1`;

before(async () => {
  const [user] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  assert.ok(user, 'need a user row to hang a fixture watch off');
  const cgs = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'ridb' ORDER BY id LIMIT 2`
  );
  assert.equal(cgs.length, 2, 'need two campgrounds to stand in for two divisions');
  cgA = cgs[0].id;
  cgB = cgs[1].id;

  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, true) RETURNING id`,
    [user.id, cgA]
  );
  watchId = w.id;
});

after(async () => {
  if (watchId) await mutate(`DELETE FROM watches WHERE id = $1`, [watchId]);
});

test('a watch with no join rows expands to exactly one pair, and is not multi', async () => {
  // THE SAFETY PROPERTY OF THE WHOLE CHANGE. Every watch that existed before migration
  // 070 has no rows in watch_campgrounds, so it must come out of the expansion looking
  // precisely as it did before.
  const rows = await query<{ campground_id: string; multi_campground: boolean }>(EXPAND, [watchId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].campground_id, cgA);
  assert.equal(rows[0].multi_campground, false);
});

test('join rows expand the watch to one pair per campground, all flagged multi', async () => {
  await mutate(
    `INSERT INTO watch_campgrounds (watch_id, campground_id) VALUES ($1,$2),($1,$3)
     ON CONFLICT DO NOTHING`,
    [watchId, cgA, cgB],
  );
  const rows = await query<{ campground_id: string; multi_campground: boolean }>(EXPAND, [watchId]);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.campground_id)), new Set([cgA, cgB]));
  assert.ok(rows.every((r) => r.multi_campground), 'every pair of a multi watch is flagged');
});

test('THE BUG: two divisions with no campsite id do not share one claim', async () => {
  // Sources with no per-site id (ReserveAmerica, GoingToCamp, TN/SC) send campsiteId =
  // null, which used to key on `(watch_id, '*')` for the whole watch. Under one park
  // watch that means the first division to open silences every other division for an
  // hour — migration 026's bug, one level up.
  const a = await claimNotification(watchId, null, { campgroundId: cgA, multi: true });
  const b = await claimNotification(watchId, null, { campgroundId: cgB, multi: true });
  assert.equal(a.won, true, 'the first division claims');
  assert.equal(b.won, true, 'the SECOND division must claim too — it is a different site');
});

test('the same division claiming twice is still suppressed', async () => {
  // The namespacing must not become a way to alert twice for one opening.
  const first = await claimNotification(watchId, 'site-dup', { campgroundId: cgA, multi: true });
  const again = await claimNotification(watchId, 'site-dup', { campgroundId: cgA, multi: true });
  assert.equal(first.won, true);
  assert.equal(again.won, false, 'within the window, the same site stays quiet');
});

test('a single-campground watch keeps its EXACT old key', () => {
  // Pure, and the reason it matters is deployment: namespacing unconditionally would
  // change every stored key, and each currently-open site would re-alert once.
  assert.equal(siteKeyFor('12345'), '12345');
  assert.equal(siteKeyFor(null), WHOLE_CAMPGROUND_SITE_KEY);
  assert.equal(siteKeyFor('12345', { campgroundId: 'rc-1', multi: false }), '12345');
  // multi with no campground id cannot namespace, and must not invent one.
  assert.equal(siteKeyFor('12345', { multi: true }), '12345');
});

test('a multi-campground watch namespaces both the id and the sentinel', () => {
  assert.equal(siteKeyFor('12345', { campgroundId: 'rc-1', multi: true }), 'rc-1::12345');
  assert.equal(
    siteKeyFor(null, { campgroundId: 'rc-1', multi: true }),
    `rc-1::${WHOLE_CAMPGROUND_SITE_KEY}`,
  );
  // Two campgrounds, same site id, must not collide.
  assert.notEqual(
    siteKeyFor('7', { campgroundId: 'rc-1', multi: true }),
    siteKeyFor('7', { campgroundId: 'rc-2', multi: true }),
  );
});
