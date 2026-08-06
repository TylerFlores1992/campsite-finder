// Regression tests for the alerting claim — the decision that, when wrong, means a
// user does not hear about a campsite.
//
// Run: npm test   (node:test via tsx — no test framework dependency)
//
// These hit the REAL database, deliberately. The claim's whole correctness lives in
// one INSERT .. ON CONFLICT .. WHERE statement, so a mocked client would be testing
// a fake instead of the thing that actually decides. Postgres is the unit here.
//
// SAFETY: the fixture watch is created with dates in the PAST. `claimNotification`
// only requires `active = true`, but the poller's candidate query requires
// `end_date > CURRENT_DATE` — so this watch is claimable by the test and invisible to
// production alerting. It is deleted on the way out, and `watch_site_alerts` cascades
// with it. Nothing here can suppress a real user's alert.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { claimNotification, WHOLE_CAMPGROUND_SITE_KEY } from './claim';

let watchId: string;
let inactiveWatchId: string;

before(async () => {
  const [user] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  assert.ok(user, 'need at least one user row to hang a fixture watch off');
  const [cg] = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'ridb' ORDER BY id LIMIT 1`
  );
  assert.ok(cg, 'need at least one campground');

  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, true) RETURNING id`,
    [user.id, cg.id]
  );
  watchId = w.id;

  const [iw] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, false) RETURNING id`,
    [user.id, cg.id]
  );
  inactiveWatchId = iw.id;
});

after(async () => {
  for (const id of [watchId, inactiveWatchId]) {
    if (!id) continue;
    await mutate(`DELETE FROM watch_site_alerts WHERE watch_id = $1`, [id]).catch(() => {});
    await mutate(`DELETE FROM notifications WHERE watch_id = $1`, [id]).catch(() => {});
    await mutate(`DELETE FROM watches WHERE id = $1`, [id]).catch(() => {});
  }
});

/**
 * Age a pair so it is claimable again — which since migration 039 takes BOTH clocks.
 *
 * `last_alert_at` alone is no longer enough: a site whose `last_seen_open_at` is recent
 * has been open continuously, and re-alerting it is the Silver Lake bug. Ageing both is
 * the simulation of "the site went away, and later came back", which is the only thing
 * that should re-alert.
 */
const age = (siteKey: string, minutes: number) =>
  mutate(
    `UPDATE watch_site_alerts
        SET last_alert_at     = NOW() - ($2 || ' minutes')::interval,
            last_seen_open_at = NOW() - ($2 || ' minutes')::interval
      WHERE watch_id = $1 AND site_key = $3`,
    [watchId, String(minutes), siteKey]
  );

/** Age ONLY the alert clock: the site has stayed open the whole time. */
const ageAlertOnly = (siteKey: string, minutes: number) =>
  mutate(
    `UPDATE watch_site_alerts SET last_alert_at = NOW() - ($2 || ' minutes')::interval
      WHERE watch_id = $1 AND site_key = $3`,
    [watchId, String(minutes), siteKey]
  );

const seenOpenAt = async (siteKey: string) => {
  const [r] = await query<{ last_seen_open_at: string | null }>(
    `SELECT last_seen_open_at FROM watch_site_alerts WHERE watch_id = $1 AND site_key = $2`,
    [watchId, siteKey]
  );
  return r?.last_seen_open_at ?? null;
};

test('a first alert for a site is claimable', async () => {
  assert.equal((await claimNotification(watchId, '84671')).won, true);
});

test('THE BUG: a different site is claimable immediately after another alerted', async () => {
  // This is the regression. Before migration 026 the cooldown was one timestamp per
  // WATCH, so site 84937 opening seconds after 84671 alerted was silently dropped for
  // an hour — no alert AND no auto-cart job, because the watch was excluded from the
  // candidate query outright rather than merely having its notification suppressed.
  // Observed live: 008 alerted 23:17, 015 opened minutes later, user heard at 00:19.
  assert.equal((await claimNotification(watchId, '84937')).won, true);
});

test('the same site is not claimable twice inside the window', async () => {
  assert.equal((await claimNotification(watchId, '84671')).won, false);
  assert.equal((await claimNotification(watchId, '84937')).won, false);
});

test('a site becomes claimable again once it has CLOSED and re-opened', async () => {
  await age('84671', 61);
  assert.equal((await claimNotification(watchId, '84671')).won, true);
  // …and that must not have reopened the OTHER site, whose clock is independent.
  assert.equal((await claimNotification(watchId, '84937')).won, false);
});

test('THE SILVER LAKE BUG: a site that stays open does not re-alert every hour', async () => {
  // The regression this migration exists for. On 2026-08-05 one Silver Lake opening
  // produced SIXTEEN identical alerts in a day — one an hour, for a site that never
  // closed. The window had passed each time, and nothing recorded that the site had
  // been open continuously, so every hour looked like fresh news.
  //
  // A cancellation is an event. We report it once.
  await age('84671', 61);
  assert.equal((await claimNotification(watchId, '84671')).won, true, 'the opening itself alerts');

  // Now the hours roll by with the site still open. The poller calls the claim every
  // cycle (that is how "still open" is recorded), so simulate several cycles and then
  // push the alert clock past the window — exactly the state the old code re-fired on.
  for (let i = 0; i < 3; i++) assert.equal((await claimNotification(watchId, '84671')).won, false);
  await ageAlertOnly('84671', 61);
  assert.equal((await claimNotification(watchId, '84671')).won, false,
    'still open since the last alert — this is the same opening, not a new one',
  );
  await ageAlertOnly('84671', 300);
  assert.equal((await claimNotification(watchId, '84671')).won, false, 'five hours: still not news');
});

test('ONE "still open" nudge at six hours, and never a second', async () => {
  // Alerting on the transition removed the hourly repeat — and with it the accidental
  // retry it provided for an alert that never landed. This is that retry, made
  // deliberate and finite: one follow-up while the site is still open.
  await age('84671', 61);
  assert.equal((await claimNotification(watchId, '84671')).won, true, 'the opening');

  await ageAlertOnly('84671', 6 * 60 + 1);
  const nudge = await claimNotification(watchId, '84671');
  assert.equal(nudge.won, true, 'six hours on and still open — one follow-up');
  assert.equal(nudge.reason, 'nudge', 'the caller must be able to word it differently');

  // …and that is the whole allowance. A six-hour repeat is just a slower drumbeat.
  for (const hours of [7, 24, 240]) {
    await ageAlertOnly('84671', hours * 60);
    assert.equal(
      (await claimNotification(watchId, '84671')).won,
      false,
      `already nudged — ${hours}h later must stay quiet`,
    );
  }
});

test('a genuine re-open clears the nudge, so the next opening gets its own', async () => {
  // Without the reset, `nudged_at` would latch for the life of the (watch, site) pair
  // and every later stay would silently lose its follow-up.
  await age('84671', 61);
  const reopened = await claimNotification(watchId, '84671');
  assert.equal(reopened.won, true);
  assert.equal(reopened.reason, 'reopened', 'a gap means a new opening, not a nudge');

  await ageAlertOnly('84671', 6 * 60 + 1);
  const second = await claimNotification(watchId, '84671');
  assert.equal(second.won, true, 'the new opening is entitled to its own nudge');
  assert.equal(second.reason, 'nudge');
});

test('a quiet cycle still records that the site was seen open', async () => {
  // The suppression above only works if every cycle stamps the observation, including
  // the ones that decline to alert. If a quiet cycle left the stamp alone, ten minutes
  // of silence would look exactly like the site vanishing and re-alert.
  await age('84671', 61);
  assert.equal((await claimNotification(watchId, '84671')).won, true);
  await mutate(
    `UPDATE watch_site_alerts SET last_seen_open_at = NOW() - interval '30 minutes'
      WHERE watch_id = $1 AND site_key = '84671'`,
    [watchId],
  );
  assert.equal((await claimNotification(watchId, '84671')).won, false, 'quiet, but observing');
  const stamped = await seenOpenAt('84671');
  assert.ok(stamped, 'the observation must be recorded');
  assert.ok(
    Date.now() - new Date(stamped).getTime() < 60_000,
    `a declining cycle must still refresh last_seen_open_at (got ${stamped})`,
  );
});

test('a pre-039 row with no observation keeps the old hourly behaviour', async () => {
  // Backfilling a value for rows that predate the column would be a guess about
  // history we do not have, and guessing "seen recently" would SILENCE a real
  // re-opening. NULL means "we do not know", and not-knowing must not suppress.
  await claimNotification(watchId, 'legacy-site');
  await mutate(
    `UPDATE watch_site_alerts
        SET last_alert_at = NOW() - interval '61 minutes', last_seen_open_at = NULL
      WHERE watch_id = $1 AND site_key = 'legacy-site'`,
    [watchId],
  );
  assert.equal((await claimNotification(watchId, 'legacy-site')).won, true);
});

test('sources with no site id share one key, keeping per-watch behaviour', async () => {
  assert.equal((await claimNotification(watchId, null)).won, true);
  assert.equal((await claimNotification(watchId, null)).won, false);
  // undefined must behave as null, not as the string "undefined".
  assert.equal((await claimNotification(watchId)).won, false);
  const rows = await query<{ site_key: string }>(
    `SELECT site_key FROM watch_site_alerts WHERE watch_id = $1 AND site_key = $2`,
    [watchId, WHOLE_CAMPGROUND_SITE_KEY]
  );
  assert.equal(rows.length, 1, 'null and undefined must collapse onto one sentinel row');
});

test('an inactive watch can never claim', async () => {
  // A paused watch must not alert. The guard is `active = true` inside the statement,
  // not a check by the caller, so it holds for every call site.
  assert.equal((await claimNotification(inactiveWatchId, '84671')).won, false);
});

test('a nonexistent watch claims nothing and does not throw', async () => {
  assert.equal((await claimNotification('00000000-0000-0000-0000-000000000000', '84671')).won, false);
});

test('winning a claim stamps notification_sent_at for the UI and webhook dedupe', async () => {
  await age('84671', 61);
  await mutate(`UPDATE watches SET notification_sent_at = NULL WHERE id = $1`, [watchId]);
  assert.equal((await claimNotification(watchId, '84671')).won, true);
  const [w] = await query<{ notification_sent_at: string | null }>(
    `SELECT notification_sent_at FROM watches WHERE id = $1`,
    [watchId]
  );
  assert.ok(w.notification_sent_at, 'WatchCard "last alerted" and Campflare dedupe read this');
});

test('concurrent claims on one pair produce exactly one winner', async () => {
  // The race the single-statement design exists to prevent: the main cycle and the
  // auto-cart lane can both see the same opening in the same instant.
  await age('84671', 61);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => claimNotification(watchId, '84671').then((r) => r.won))
  );
  assert.equal(
    results.filter(Boolean).length,
    1,
    `expected exactly one winner, got ${results.filter(Boolean).length}`
  );
});
