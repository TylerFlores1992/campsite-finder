/**
 * A park watch's namespaced site key must not leak into the "open now" reader.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────
 * Migration 070 lets one watch cover several divisions of a park, and `siteKeyFor` in
 * worker/claim.ts therefore namespaces the alerting key as `<campgroundId>::<campsiteId>`
 * for those watches. It has to: the per-watch `*` sentinel would otherwise collapse every
 * division onto one claim, and the first division to open would silence the rest for an
 * hour — migration 026's bug one level up.
 *
 * `watchOpenings` reads that same column and assumed the key was a bare campsite id.
 * Three things broke at once, all silently, and only for a park watch:
 *
 *   1. `AND a.site_key <> '*'` stopped excluding the sentinel, because a park watch's is
 *      `<campgroundId>::*`. That filter's own comment explains why surfacing it would be
 *      "a number we made up" — and it would have been surfaced as an open SITE.
 *   2. The name lookup joins on `payload->>'campsiteId'`, which stores the BARE id, so a
 *      namespaced key matched nothing and every open site came back unnamed.
 *   3. The id is passed to `withBookLinks`, so the booking deep link pointed at a site id
 *      that does not exist.
 *
 * ── WHY IT WAS WORTH CATCHING BEFORE MERGE ─────────────────────────────────────────────
 * The join table is empty in production, so none of this is a live regression — it is a
 * bug that fires on the FIRST park watch anyone creates, which is also the first exercise
 * of the whole path. The author flagged that they had audited the two claims and stopped;
 * this is the third consumer, wrong in exactly the way they predicted.
 *
 * Real DB because the fix is a SQL expression. A test asserting against a copy of that
 * expression would assert the copy.
 *
 * SAFETY: fixture watch dated 2020, so the poller's `end_date > CURRENT_DATE` filter can
 * never see it; no `rc_hold_requests` rows, so the hold runner cannot reach it either.
 * Deleted on the way out, and `watch_site_alerts` cascades with the watch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { watchOpenings } from '../src/lib/watch-openings';
import { siteKeyFor } from './claim';

let watchId: string;
let campgroundId: string;

before(async () => {
  const [user] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  assert.ok(user, 'need a user row to hang a fixture watch off');
  const [cg] = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'ridb' ORDER BY id LIMIT 1`,
  );
  assert.ok(cg, 'need a campground');
  campgroundId = cg.id;

  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, true) RETURNING id`,
    [user.id, cg.id],
  );
  watchId = w.id;
});

after(async () => {
  if (!watchId) return;
  await mutate(`DELETE FROM notifications WHERE watch_id = $1`, [watchId]).catch(() => {});
  await mutate(`DELETE FROM watch_site_alerts WHERE watch_id = $1`, [watchId]).catch(() => {});
  await mutate(`DELETE FROM watches WHERE id = $1`, [watchId]).catch(() => {});
});

/** Record a site as open right now under `key`, the way the poller's claim would. */
async function seeOpen(key: string): Promise<void> {
  await mutate(
    `INSERT INTO watch_site_alerts (watch_id, site_key, last_alert_at, last_seen_open_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (watch_id, site_key)
     DO UPDATE SET last_seen_open_at = NOW()`,
    [watchId, key],
  );
}

async function openIds(): Promise<string[]> {
  const m = await watchOpenings([watchId]);
  return (m.get(watchId)?.open ?? []).map((o) => o.id).sort();
}

async function openNamed(): Promise<Array<{ id: string; name: string | null }>> {
  const m = await watchOpenings([watchId]);
  return (m.get(watchId)?.open ?? []).map((o) => ({ id: o.id, name: o.name }));
}

test("a park watch's namespaced sentinel is excluded, exactly like a bare one", async () => {
  // `<campgroundId>::*` is what siteKeyFor produces for a multi-campground watch on a
  // source with no per-site id. It is the SAME fact as '*' and must be hidden the same
  // way — the filter used to test the raw key and let this straight through.
  const sentinel = siteKeyFor(null, { multi: true, campgroundId });
  assert.equal(sentinel, `${campgroundId}::*`, 'siteKeyFor changed shape — update this test');
  await mutate(`DELETE FROM watch_site_alerts WHERE watch_id = $1`, [watchId]);
  await seeOpen(sentinel);
  await seeOpen('*');
  assert.deepEqual(
    await openIds(),
    [],
    'a namespaced whole-campground sentinel was reported as an open SITE. That is the ' +
      '"number we made up" the filter exists to suppress.',
  );
});

test('a park watch reports the BARE campsite id, not the namespaced key', async () => {
  // The id is handed to withBookLinks and compared against payload->>'campsiteId'.
  // Leaving the namespace on it produces a deep link to a site that does not exist.
  await mutate(`DELETE FROM watch_site_alerts WHERE watch_id = $1`, [watchId]);
  await seeOpen(siteKeyFor('45719', { multi: true, campgroundId }));
  assert.deepEqual(await openIds(), ['45719']);
});

test("a park watch's open site resolves its NAME from the alert history", async () => {
  // The name subquery joins the site key against `payload->>'campsiteId'`, which stores
  // the BARE id. Compared against the namespaced key it matches nothing, and every open
  // site on a park watch renders as a raw number — the third of the three defects, and
  // the one the first version of this test failed to catch because it only ever asserted
  // ids and a missing name is null either way.
  await mutate(`DELETE FROM watch_site_alerts WHERE watch_id = $1`, [watchId]);
  await mutate(
    `INSERT INTO notifications (user_id, watch_id, channel, status, payload)
     SELECT w.user_id, w.id, 'email', 'sent',
            '{"campsiteId":"45719","campsiteName":"Hook Up (E ) Campsite #L006"}'::jsonb
       FROM watches w WHERE w.id = $1`,
    [watchId],
  );
  await seeOpen(siteKeyFor('45719', { multi: true, campgroundId }));
  assert.deepEqual(await openNamed(), [{ id: '45719', name: 'Hook Up (E ) Campsite #L006' }]);
  await mutate(`DELETE FROM notifications WHERE watch_id = $1`, [watchId]);
});

test('an ordinary watch is completely unaffected', async () => {
  // The safety property the whole change rests on: a single-campground watch stores a
  // bare key and must read back byte-identically.
  await mutate(`DELETE FROM watch_site_alerts WHERE watch_id = $1`, [watchId]);
  await seeOpen(siteKeyFor('A12', undefined));
  await seeOpen(siteKeyFor(null, undefined));
  assert.deepEqual(await openIds(), ['A12'], 'the bare sentinel must still be excluded');
});
