/**
 * CHANGING A WATCH'S DATES MUST NOT SILENCE IT.
 *
 * `watch_site_alerts` is `PRIMARY KEY (watch_id, site_key)` and the dates are NOT in the
 * key. `worker/claim.ts` re-alerts only on a TRANSITION — it needs the hour AND a
 * `CONTINUOUS_GAP` of not having seen the site open — so a claim won while the watch
 * covered one window keeps standing after the user moves it to another, and a site that
 * was open then and is open now looks like "nothing changed" and stays SILENT.
 *
 * That is the whole risk in this feature, and it is invisible: no error, no failed write,
 * a screen that says the watch is active, and no alerts for exactly the sites most likely
 * to matter. So the write clears the claims, and these tests are what hold it there.
 *
 * REAL DB for the write half, on purpose. The clearing is one statement; a test asserting
 * a copy of that statement would assert the copy — `rc-holds-readout.test.mts` exists
 * because of that mistake.
 *
 * FIXTURES ARE `active = false` AND CARRY A `__twd` USER. `loadWatches` filters
 * `WHERE w.active = true`, so the production poller cannot see them however far in the
 * future their dates are set — and these tests set future dates by construction, so
 * relying on a past `end_date` (the usual fixture guard) is not available here.
 * `admin/page.tsx`'s `REAL_USER` is `user_id LIKE 'user\_%'`, which `__twd` does not
 * match, so they cannot reach a dashboard count either.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client.ts';
import { checkDateChange, applyWatchDates, MAX_WINDOW_DAYS } from '../src/lib/watch-dates.ts';

const USER = '__twd-user';
const W1 = '__twd-watch-1';
const W2 = '__twd-watch-2';
const TODAY = '2026-09-02';

/** A date `n` days after TODAY, so fixtures move with the constant rather than rotting. */
const day = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function sweep() {
  await mutate(`DELETE FROM watch_site_alerts WHERE watch_id IN ($1, $2)`, [W1, W2]);
  await mutate(`DELETE FROM watches WHERE user_id = $1`, [USER]);
  await mutate(`DELETE FROM users WHERE id = $1`, [USER]);
}

before(async () => {
  await sweep();
  await mutate(`INSERT INTO users (id, email) VALUES ($1, $2)`, [USER, `${USER}@example.invalid`]);

  // `watches.campground_id` is a foreign key, so the fixture BORROWS a real campground
  // rather than inventing one: a fixture row in `campgrounds` would be reachable from
  // search, which is a far worse thing to leave behind than a borrowed id on an inactive
  // watch nothing polls.
  const cg = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`);
  assert.ok(cg[0], 'no campgrounds in the database — cannot build the fixture');

  for (const id of [W1, W2]) {
    await mutate(
      `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, min_nights,
                            active, rc_hold_notified_keys, rc_hold_notified_for)
       VALUES ($1, $2, $5, $3, $4, 2, false, ARRAY['2026-9-4T8|123'], '2026-9-4T8')`,
      [id, USER, day(10), day(14), cg[0].id]
    );
    await mutate(
      `INSERT INTO watch_site_alerts (watch_id, site_key, last_alert_at, last_seen_open_at)
       VALUES ($1, 'site-A', NOW(), NOW())`,
      [id]
    );
  }
});

after(sweep);

const base = { flexNights: null, minNights: 2, today: TODAY };

test('a window that runs backwards is refused', () => {
  const r = checkDateChange({ ...base, startDate: day(10), endDate: day(5) });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /after the start date/);
});

test('an end date that has already passed is refused', () => {
  // The poller runs `end_date > CURRENT_DATE` and expire-watches closes the complement,
  // so accepting this would switch the watch off within the hour with no explanation.
  const r = checkDateChange({ ...base, startDate: day(-10), endDate: day(-1) });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /already passed/);
});

test('a window ending TODAY is refused, one ending tomorrow is not', () => {
  // The boundary is the poller's `>`, not `>=`. Pinned from both sides because an
  // off-by-one here is a watch that disappears rather than an error anyone sees.
  assert.equal(checkDateChange({ ...base, startDate: day(-3), endDate: day(0) }).ok, false);
  assert.equal(checkDateChange({ ...base, startDate: day(-3), endDate: day(1) }).ok, true);
});

test('a start date in the past is allowed when nights remain', () => {
  // A real case, not an edge one: a window that began before today can still have
  // bookable nights left in it, and refusing it would be a bug of our own invention.
  assert.equal(checkDateChange({ ...base, startDate: day(-2), endDate: day(9) }).ok, true);
});

test('nights that cannot fit the new window are refused — flex and fixed alike', () => {
  const flex = checkDateChange({
    ...base, flexNights: 5, minNights: 1, startDate: day(1), endDate: day(3),
  });
  assert.equal(flex.ok, false);
  assert.match((flex as { error: string }).error, /5 nights/);

  const fixed = checkDateChange({
    ...base, flexNights: null, minNights: 4, startDate: day(1), endDate: day(3),
  });
  assert.equal(fixed.ok, false);
  assert.match((fixed as { error: string }).error, /4 nights/);
});

test('a date that matches the shape but is not real is refused', () => {
  // `Date.parse` ACCEPTS these and rolls them over — 2026-02-31 becomes March 3rd, and
  // 2026-02-29 (not a leap year) becomes March 1st. A parse check alone passes both and
  // moves the user's watch by days without saying so, which is why the validator
  // round-trips instead. This test found that gap in the first version.
  for (const bad of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-01-32']) {
    const r = checkDateChange({ ...base, startDate: bad, endDate: day(20) });
    assert.equal(r.ok, false, `${bad} must be refused`);
  }
  // A real leap day is still fine.
  assert.equal(
    checkDateChange({ ...base, startDate: '2028-02-29', endDate: '2028-03-05', today: '2028-01-01' }).ok,
    true
  );
});

test('a window longer than the ceiling is refused', () => {
  const r = checkDateChange({ ...base, startDate: day(1), endDate: day(MAX_WINDOW_DAYS + 2) });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, new RegExp(String(MAX_WINDOW_DAYS)));
});

test('the write moves the dates', async () => {
  await applyWatchDates(W1, { startDate: day(30), endDate: day(34) });
  const rows = await query<{ start_date: string; end_date: string }>(
    `SELECT start_date::text, end_date::text FROM watches WHERE id = $1`, [W1]
  );
  assert.equal(rows[0].start_date, day(30));
  assert.equal(rows[0].end_date, day(34));
});

test('the write CLEARS this watch\'s alert claims — and only this watch\'s', async () => {
  // THE POINT OF THE WHOLE FEATURE'S SAFETY. A surviving claim silences the new dates.
  const mine = await query<{ n: number }>(
    `SELECT count(*)::int n FROM watch_site_alerts WHERE watch_id = $1`, [W1]
  );
  assert.equal(mine[0].n, 0, 'the edited watch must have no claims left');

  const other = await query<{ n: number }>(
    `SELECT count(*)::int n FROM watch_site_alerts WHERE watch_id = $1`, [W2]
  );
  assert.equal(other[0].n, 1, 'a DIFFERENT watch must keep its claims — the delete is scoped');
});

test('the write clears the RC hold claim, both the array and the pre-067 scalar', async () => {
  const rows = await query<{ keys: string[] | null; legacy: string | null }>(
    `SELECT rc_hold_notified_keys AS keys, rc_hold_notified_for AS legacy
       FROM watches WHERE id = $1`, [W1]
  );
  assert.equal(rows[0].keys, null, 'rc_hold_notified_keys must be cleared');
  assert.equal(rows[0].legacy, null, 'the pre-067 scalar must be cleared too');
});

test('the write does NOT touch `active`', async () => {
  // A watch is inactive because the user paused it OR because expire-watches closed it,
  // and nothing records which — so resuming here would restart alerts for somebody who
  // deliberately stopped them. The manage screen has an explicit Resume for that.
  const rows = await query<{ active: boolean }>(
    `SELECT active FROM watches WHERE id = $1`, [W1]
  );
  assert.equal(rows[0].active, false);
});
