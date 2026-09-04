/**
 * The device's own account of the hand-off.
 *
 * REAL DB ON PURPOSE, like the alerting claim: the interesting behaviour lives inside one
 * UPDATE — the append-and-cap, and the promise that this never moves `status` or
 * `updated_at`. A mock would test a fake.
 *
 * The rule under test that is easiest to break by accident: this is an OBSERVATION about
 * the client, not a state change to the hold. `updated_at` means "the hold changed", and
 * it is what makes "unchanged since the tap" a usable tell — the signal that exposed the
 * 2026-08-07 outage. `noteAttempt` learned this the same way.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, mutate } from '../src/lib/db/client';
import { recordClientReports } from '../src/lib/rc-holds';

const SENTINEL = '__camphawk-clientreport-test__';

async function fixture() {
  /**
   * DATED IN THE FUTURE, which is the OPPOSITE of the 2020 rule used for watch fixtures —
   * do not "fix" it back.
   *
   * A watch is hidden from the poller by being in the past (`end_date > CURRENT_DATE`).
   * A HOLD is the reverse: `expireStaleHolds` sweeps `status = 'offered' AND release_at <
   * now` and rewrites status and updated_at — so a past-dated fixture is exactly what the
   * production sweep on Fly eats, mid-test, an hour at a time. That is a flaky failure of
   * the two assertions this file exists for, caused by the real system rather than by the
   * code under test.
   *
   * `offered` in the future is invisible to everything: dueHolds, holdAtRisk,
   * nextHoldRelease and pendingClaims all filter to requested/carted/claiming, so the
   * runner can never be served it either.
   */
  const [w] = await query<{ id: string; user_id: string; campground_id: string }>(
    `SELECT id, user_id, campground_id FROM watches ORDER BY created_at LIMIT 1`,
  );
  if (!w) return null;
  const [row] = await mutate<{ id: string }>(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, unit_name, arrival_date, nights, release_at)
     VALUES ($1, $2, $3, $4, $5, '2099-01-02', 1, '2099-01-01T08:00:00')
     -- FOUR COLUMNS SINCE MIGRATION 074: the unique key carries release_at now, so a
     -- campsite locked again for a later release is a new offer rather than silently
     -- nothing. ON CONFLICT needs a target matching an index exactly, and this
     -- hand-rolled copy of offerHold's own statement threw the moment the index widened.
     ON CONFLICT (watch_id, unit_id, arrival_date, release_at) DO UPDATE SET unit_name = EXCLUDED.unit_name
     RETURNING id`,
    [w.id, w.user_id, w.campground_id, SENTINEL, SENTINEL],
  );
  return row?.id ?? null;
}

after(async () => {
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id = $1`, [SENTINEL]).catch(() => {});
});

const read = async (id: string) =>
  (await query<{
    status: string; updated_at: string; client_reports: unknown[];
    client_last_stage: string | null; client_last_note: string | null;
  }>(`SELECT status, updated_at::text, client_reports, client_last_stage, client_last_note
        FROM rc_hold_requests WHERE id = $1`, [id]))[0];

test('reports append, and never move status or updated_at', async () => {
  const id = await fixture();
  if (!id) return; // no watches in this environment — nothing to hang a hold off
  const before = await read(id);

  await recordClientReports(id, [{ n: 1, stage: 'injected', detail: { job: true } }]);
  await recordClientReports(id, [{ n: 2, stage: 'status', detail: { status: '✓ Added to cart' } }]);

  const afterRow = await read(id);
  assert.equal(afterRow.client_reports.length, 2, 'appends rather than replaces');
  assert.equal(afterRow.status, before.status, 'an observation is not a state change');
  assert.equal(afterRow.updated_at, before.updated_at,
    'updated_at means "the hold changed" — moving it destroys the unchanged-since-the-tap tell');
  assert.equal(afterRow.client_last_note, '✓ Added to cart');
});

test('the verdict comes from an outcome line, not merely the last line', async () => {
  const id = await fixture();
  if (!id) return;
  await mutate(`UPDATE rc_hold_requests SET client_reports = '[]'::jsonb, client_last_note = NULL WHERE id = $1`, [id]);

  // `token` and `reinjected` are progress, not verdicts. A readout that surfaced "token
  // captured" as the final word would report a cart nobody ever saw succeed — the same
  // error as `IsSuccess: true` on a cart that held nothing.
  await recordClientReports(id, [
    { n: 1, stage: 'status', detail: { status: 'RC declined (200) — unit not available' } },
    { n: 2, stage: 'token', detail: { captured: true, length: 939 } },
    { n: 3, stage: 'reinjected', detail: null },
  ]);

  const row = await read(id);
  assert.match(row.client_last_note ?? '', /RC declined/);
  assert.equal(row.client_last_stage, 'reinjected', 'the raw last stage is still recorded');
});

test('a flood is still CAPPED — an unbounded array slows the 08:00 write', async () => {
  const id = await fixture();
  if (!id) return;
  await mutate(`UPDATE rc_hold_requests SET client_reports = '[]'::jsonb WHERE id = $1`, [id]);

  // The bound is the point: this row is written on the cart path, and an array that grows
  // without limit is a way to make the one write that must be fast, slow.
  //
  // IT USED TO ASSERT "the tail is kept, not the head", and that assertion WAS the defect —
  // see the head-and-tail test below. Widened rather than deleted, because the CAP is a real
  // property and dropping the test with the behaviour would leave nothing bounding it.
  await recordClientReports(id, Array.from({ length: 300 }, (_, i) => ({ n: i, stage: `s${i}`, detail: null })));
  const row = await read(id);
  assert.ok(row.client_reports.length <= 80, `capped, got ${row.client_reports.length}`);
  const last = row.client_reports[row.client_reports.length - 1] as { stage: string };
  assert.equal(last.stage, 's299', 'the newest report is always kept');
});

test('an empty batch is a no-op, not a write', async () => {
  const id = await fixture();
  if (!id) return;
  const before = await read(id);
  await recordClientReports(id, []);
  const afterRow = await read(id);
  assert.equal(afterRow.client_reports.length, before.client_reports.length);
});

// ---------------------------------------------------------------------------
// A WHOLE HAND-OFF MUST FIT (2026-08-29).
//
// The trim kept the last 40 and nothing else. The 2026-08-24 iOS run — the baseline every
// later run is compared against — used ALL FORTY to cover arriving signed out, the Okta
// round trip, the cart, and the cart page. So the 08-29 Android run lost its cart sequence
// off the FRONT, and a line-by-line comparison against the baseline was impossible: the
// decisive middle had already been deleted by the time anyone looked.
//
// THIRD TIME THE TAIL-TRIM HAS EATEN THE EVIDENCE. `✓ Added to cart` went off the front of
// both 2026-08-13 hand-offs, and the platform tag was gone from every summary until
// migration 064 gave it columns. Rescuing one field at a time does not fix the shape.
//
// REAL-DB, because the trim is one SQL statement and a test asserting against a copy of it
// would assert the copy.
// ---------------------------------------------------------------------------

test('a long hand-off keeps BOTH ends — the head is where the platform and sign-in live', async () => {
  const id = await fixture();
  if (!id) return;
  // `fixture()` upserts the SAME row for every test in this file, so without this the "first
  // report" is the previous test's flood. Found by the assertion reading a null detail.
  await mutate(`UPDATE rc_hold_requests SET client_reports = '[]'::jsonb WHERE id = $1`, [id]);

  // 200 reports: far past the cap, and numbered so their positions are checkable.
  for (let batch = 0; batch < 10; batch++) {
    await recordClientReports(id, Array.from({ length: 20 }, (_, i) => ({
      n: batch * 20 + i, stage: 'session', detail: { n: batch * 20 + i },
    })));
  }

  const kept = (await read(id)).client_reports as { detail: { n: number } }[];
  assert.ok(kept.length > 40,
    `the cap must exceed the 40 that could not hold one hand-off — got ${kept.length}`);

  // THE HEAD SURVIVED. This is the half the old trim deleted, and it carries the platform
  // report, the arriving session state, and whether a sign-in was needed at all.
  assert.equal(kept[0].detail.n, 0,
    'the FIRST report must survive — it is the one that says which device this was');

  // THE TAIL SURVIVED. `✓ Added to cart` and `cart-verified` land here.
  assert.equal(kept[kept.length - 1].detail.n, 199,
    'the newest report must survive — the cart outcome is the last thing to happen');

  // AND THE ORDER IS INTACT ACROSS THE GAP. `jsonb_agg` without an explicit ORDER BY is not
  // guaranteed to preserve it, and a reordered trace is worse than a trimmed one: it invites
  // a reconstruction of a sequence that never happened.
  const ns = kept.map((r) => r.detail.n);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b), 'reports must stay in order');
});

test('the ORDER BY is pinned STRUCTURALLY, because behaviour cannot see it', () => {
  // `jsonb_agg` without an explicit ORDER BY follows the scan order, and for this input that
  // is already sorted — so removing it passes every behavioural assertion above. Verified by
  // mutation. Postgres does not promise that ordering, and a trace reordered by a future plan
  // change is worse than a trimmed one: it invites reconstructing a sequence that never
  // happened. When behaviour cannot distinguish, pin the source.
  const src = readFileSync(new URL('../src/lib/rc-holds.ts', import.meta.url), 'utf8');
  assert.match(src, /jsonb_agg\(x ORDER BY rn\)/,
    'the aggregate must order explicitly by the row number the window assigned');
});
