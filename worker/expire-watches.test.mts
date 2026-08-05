// The expired-watch sweep, and the one way it could do damage.
//
// Run: npm test
//
// Hits the REAL database, like the claim suites, because the rule under test IS a SQL
// predicate — a mocked client would be asserting against a fake.
//
// SAFETY: every case runs through `expireFinishedWatches(onlyIds)`, so the UPDATE can
// only ever touch the fixture rows created here. Without that narrowing this file would
// close every real user's finished watches as a side effect of `npm test` — correct
// behaviour, wrong time, no way to undo it.
//
// The case that matters is `never closes a watch the poller is still running`. Closing
// a live watch produces no error, no log line and no user-visible signal: alerts simply
// stop for that trip. Break the predicate to `end_date <= CURRENT_DATE + 1` and that
// test is the only thing in the repo that notices.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { expireFinishedWatches } from './expire-watches';

let userId: string;
let campgroundId: string;
const created: string[] = [];

/** `offsetDays` is relative to the DB's CURRENT_DATE, computed BY the DB — the sweep
 *  compares against Postgres' today, so a fixture dated by the test process's clock
 *  would be testing the gap between two clocks rather than the predicate. */
async function makeWatch(offsetDays: number): Promise<string> {
  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, CURRENT_DATE - 30, CURRENT_DATE + ($3)::int, 1, true) RETURNING id`,
    [userId, campgroundId, offsetDays]
  );
  created.push(w.id);
  return w.id;
}

async function isActive(id: string): Promise<boolean> {
  const rows = await query<{ active: boolean }>(`SELECT active FROM watches WHERE id = $1`, [id]);
  return rows[0]?.active === true;
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
});

after(async () => {
  for (const id of created) await mutate(`DELETE FROM watches WHERE id = $1`, [id]);
});

test('closes a watch whose trip is over', async () => {
  const id = await makeWatch(-3);
  const closed = await expireFinishedWatches([id]);
  assert.deepEqual(closed, [id]);
  assert.equal(await isActive(id), false);
});

test('closes a watch ending TODAY — the poller already stopped running it', async () => {
  // The boundary. The poller's filter is `end_date > CURRENT_DATE`, so a watch ending
  // today is dropped the moment the date rolls over; leaving it `active` would be the
  // divergence this sweep exists to remove.
  const id = await makeWatch(0);
  assert.deepEqual(await expireFinishedWatches([id]), [id]);
  assert.equal(await isActive(id), false);
});

test('never closes a watch the poller is still running', async () => {
  // The damage case, at the tightest margin: end_date is tomorrow, so the poller runs
  // it today. Anything that closes this row is a silent alerting outage.
  const tomorrow = await makeWatch(1);
  const later = await makeWatch(45);
  assert.deepEqual(await expireFinishedWatches([tomorrow, later]), []);
  assert.equal(await isActive(tomorrow), true);
  assert.equal(await isActive(later), true);
});

test('running twice closes nothing the second time', async () => {
  // Both shard machines could run this; the claim makes that unlikely, the WHERE makes
  // it harmless. A sweep that "closed 5 watches" every hour forever would look like
  // five users a hour giving up.
  const id = await makeWatch(-2);
  assert.deepEqual(await expireFinishedWatches([id]), [id]);
  assert.deepEqual(await expireFinishedWatches([id]), []);
});

test('leaves an already-paused expired watch alone', async () => {
  // Paused-then-expired is already inactive; re-closing it would report work it did
  // not do, which is how a quiet log line becomes a misleading one.
  const id = await makeWatch(-5);
  await mutate(`UPDATE watches SET active = false WHERE id = $1`, [id]);
  assert.deepEqual(await expireFinishedWatches([id]), []);
});
