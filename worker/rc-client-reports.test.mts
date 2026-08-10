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
import { query, mutate } from '../src/lib/db/client';
import { recordClientReports } from '../src/lib/rc-holds';

const SENTINEL = '__camphawk-clientreport-test__';

async function fixture() {
  // Dated 2020 for the same reason the poller fixtures are: nothing live can ever see it.
  const [w] = await query<{ id: string; user_id: string; campground_id: string }>(
    `SELECT id, user_id, campground_id FROM watches ORDER BY created_at LIMIT 1`,
  );
  if (!w) return null;
  const [row] = await mutate<{ id: string }>(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, unit_name, arrival_date, nights, release_at)
     VALUES ($1, $2, $3, $4, $5, '2020-01-02', 1, '2020-01-01T08:00:00')
     ON CONFLICT (watch_id, unit_id, arrival_date) DO UPDATE SET unit_name = EXCLUDED.unit_name
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

test('a flood is capped, keeping the TAIL', async () => {
  const id = await fixture();
  if (!id) return;
  await mutate(`UPDATE rc_hold_requests SET client_reports = '[]'::jsonb WHERE id = $1`, [id]);

  // The end of a hand-off is the part that matters; the token rebroadcasts at the start
  // are the bulkiest and least informative. An unbounded array on a row the cart path also
  // writes is a way to make the 08:00 write slow.
  await recordClientReports(id, Array.from({ length: 100 }, (_, i) => ({ n: i, stage: `s${i}`, detail: null })));
  const row = await read(id);
  assert.ok(row.client_reports.length <= 40, `capped, got ${row.client_reports.length}`);
  const last = row.client_reports[row.client_reports.length - 1] as { stage: string };
  assert.equal(last.stage, 's99', 'the tail is kept, not the head');
});

test('an empty batch is a no-op, not a write', async () => {
  const id = await fixture();
  if (!id) return;
  const before = await read(id);
  await recordClientReports(id, []);
  const afterRow = await read(id);
  assert.equal(afterRow.client_reports.length, before.client_reports.length);
});
