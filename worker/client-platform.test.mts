// THE PLATFORM MUST SURVIVE THE TRIM — it never has.
//
// `scripts/rc-holds-readout.mts` has printed "platform not reported" on every hand-off it has
// ever summarised, and that was read as the feature being unbuilt. It is not:
// `ClaimFlow.notePlatform` has emitted a `platform` report from six call sites all along.
//
// The report is EMITTED and then THROWN AWAY. `recordClientReports` keeps the last
// CLIENT_REPORT_CAP (40) reports — deliberately, because the interesting part of a hand-off is
// the end — and the platform is reported ONCE, FIRST, so it sits at the head of exactly the
// region that gets discarded. Measured on hold 4734 (2026-08-20): 40 reports stored, earliest
// survivor `session {n:2}`, the platform long gone.
//
// WHY THIS IS A REAL-DB TEST. The fix is `client_platform = COALESCE($6, client_platform)`
// inside one UPDATE that also does the trimming. A test asserting the source text of that
// statement would assert a copy of it; only running it proves the platform outlives the trim
// and that a later batch cannot erase it. Same reasoning as `worker/watch-mutes.test.mts`.
//
// The fixture unit id is NON-NUMERIC (`__t9401`), because real RC unit ids are numeric and the
// production hold runner does not care whether a watch is active — see
// worker/hold-fixture-safety.test.mts. A numeric id here could lock a stranger's campsite.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client.js';
import { recordClientReports, type ClientReport } from '../src/lib/rc-holds.js';

const HOLD = '0f1e2d3c-4b5a-4968-8877-665544332211';
const UNIT = '__t9401';

async function fixture(): Promise<void> {
  const [watch] = await query<{ id: string; campground_id: string; user_id: string }>(
    `SELECT id, campground_id, user_id FROM watches ORDER BY created_at LIMIT 1`);
  if (!watch) throw new Error('no watch to hang a fixture off');
  await mutate(
    `INSERT INTO rc_hold_requests
       (id, watch_id, campground_id, user_id, unit_id, arrival_date, nights, release_at, status)
     VALUES ($1, $2, $3, $4, $5, '2030-12-01', 1, '2030-12-01T08:00:00', 'offered')
     ON CONFLICT (id) DO UPDATE
       SET client_reports = '[]'::jsonb, client_platform = NULL, client_app_build = NULL`,
    [HOLD, watch.id, watch.campground_id, watch.user_id, UNIT]);
}

const say = (n: number, stage: string, detail: Record<string, unknown> = {}): ClientReport =>
  ({ n, stage, detail });

before(fixture);
after(async () => { await mutate(`DELETE FROM rc_hold_requests WHERE id = $1`, [HOLD]); });

test('the platform outlives a trim that discards the report carrying it', async () => {
  // Exactly the shape of a real hand-off: the platform first, then far more than the cap.
  await recordClientReports(HOLD, [
    say(0, 'platform', { platform: 'android', appBuild: '19' }),
    ...Array.from({ length: 60 }, (_, i) => say(i + 1, 'token', { captured: true })),
    say(99, 'status', { status: '✓ Added to cart' }),
  ]);

  const [row] = await query<{
    client_platform: string | null; client_app_build: string | null;
    reports: Array<{ stage: string }>;
  }>(`SELECT client_platform, client_app_build, client_reports AS reports
        FROM rc_hold_requests WHERE id = $1`, [HOLD]);

  // The precondition: the report really was discarded. Without asserting this the test could
  // pass on a run where nothing was trimmed, and would prove nothing about the fix.
  assert.ok(!row.reports.some((r) => r.stage === 'platform'),
    'the trim must actually have discarded the platform report, or this proves nothing');

  assert.equal(row.client_platform, 'android', 'and the column must still carry it');
  assert.equal(row.client_app_build, '19');
});

test('a later batch with no platform cannot erase one already recorded', async () => {
  // A hand-off flushes several times on a 1.5s debounce and only the FIRST carries the
  // platform. Without COALESCE the second flush would blank it, which is worse than never
  // having stored it: the readout would say "not reported" for a claim that did report.
  await fixture();
  await recordClientReports(HOLD, [say(0, 'platform', { platform: 'ios', appBuild: '21' })]);
  await recordClientReports(HOLD, [say(1, 'status', { status: 'Adding to your cart…' })]);

  const [row] = await query<{ client_platform: string | null; client_app_build: string | null }>(
    `SELECT client_platform, client_app_build FROM rc_hold_requests WHERE id = $1`, [HOLD]);
  assert.equal(row.client_platform, 'ios', 'the second flush must not blank it');
  assert.equal(row.client_app_build, '21');
});

test('a non-string platform is stored as NULL, never as a coerced value', async () => {
  // Anything holding the manage token can post this and it renders on a readout a human
  // reads at 07:50. `unknown` must not round to a verdict, and `[object Object]` must never
  // reach the column — the exact shape that switched off the memory series for ten minutes
  // when a plain object was handed to `sqlit`.
  await fixture();
  await recordClientReports(HOLD, [
    say(0, 'platform', { platform: { evil: true } as never, appBuild: 42 as never }),
  ]);

  const [row] = await query<{ client_platform: string | null; client_app_build: string | null }>(
    `SELECT client_platform, client_app_build FROM rc_hold_requests WHERE id = $1`, [HOLD]);
  assert.equal(row.client_platform, null, 'a non-string platform is NOT REPORTED, not coerced');
  assert.equal(row.client_app_build, null);
});

test('recording a report still never moves status or updated_at', async () => {
  // The rule migration 046 exists for: this is an observation about the CLIENT, not a change
  // to the hold. Conflating them destroys the "unchanged since the tap" tell that exposed the
  // 2026-08-07 outage. The platform columns must not have quietly changed that.
  await fixture();
  const [before_] = await query<{ status: string; updated_at: string }>(
    `SELECT status, updated_at::text FROM rc_hold_requests WHERE id = $1`, [HOLD]);
  await new Promise((r) => setTimeout(r, 20));
  await recordClientReports(HOLD, [say(0, 'platform', { platform: 'ios', appBuild: '21' })]);
  const [after_] = await query<{ status: string; updated_at: string }>(
    `SELECT status, updated_at::text FROM rc_hold_requests WHERE id = $1`, [HOLD]);

  assert.equal(after_.status, before_.status, 'status must not move');
  assert.equal(after_.updated_at, before_.updated_at, 'updated_at must not move');
});
