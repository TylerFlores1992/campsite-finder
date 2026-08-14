// Regression tests for the nightly-catalog-sync claim — the thing that stops every
// shard machine running the whole sync at once.
//
// Run: npm test   (node:test via tsx — no test framework dependency)
//
// Hits the REAL database, deliberately, for the same reason the claim suite does: the
// correctness lives inside one INSERT .. ON CONFLICT .. WHERE, and a mocked client
// would test a fake instead of the statement that decides.
//
// SAFETY: every test uses job names prefixed `test-`, never the live 'usedirect' or
// 'goingtocamp' rows, so nothing here can gate a real catalog sync. Rows are deleted
// on the way out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mutate, query } from '../src/lib/db/client';
import { claimSyncJob, renewSyncClaim, releaseSyncJob, withSyncClaim } from './sync-claim';

const JOB = 'test-sync-claim';
const JOB2 = 'test-sync-claim-2';

/** Impersonate a DIFFERENT machine by writing the row directly. */
async function claimAsOtherMachine(job: string, ttlMs: number) {
  await mutate(
    `INSERT INTO sync_claims (job, machine_id, claimed_until)
     VALUES ($1, 'some-other-machine', NOW() + ($2 || ' milliseconds')::interval)
     ON CONFLICT (job) DO UPDATE
       SET machine_id = EXCLUDED.machine_id, claimed_until = EXCLUDED.claimed_until`,
    [job, String(ttlMs)]
  );
}

const cleanup = async () => {
  await mutate(`DELETE FROM sync_claims WHERE job LIKE 'test-%'`);
};

before(cleanup);
after(cleanup);

test('an unclaimed job is claimable', async () => {
  assert.equal(await claimSyncJob(JOB), true);
  await releaseSyncJob(JOB);
});

test('a job another machine holds is NOT claimable', async () => {
  // The whole point: machine B must not start a second copy of the sync.
  await claimAsOtherMachine(JOB, 60_000);
  assert.equal(await claimSyncJob(JOB), false);
});

test('an EXPIRED claim is takeable, so a dead machine cannot block the catalog forever', async () => {
  await claimAsOtherMachine(JOB, -1000); // already expired
  assert.equal(await claimSyncJob(JOB), true);
  await releaseSyncJob(JOB);
});

test('re-claiming our own job succeeds — a restart need not wait out its own TTL', async () => {
  assert.equal(await claimSyncJob(JOB), true);
  assert.equal(await claimSyncJob(JOB), true);
  await releaseSyncJob(JOB);
});

test('renew extends OUR claim and refuses someone else\'s', async () => {
  assert.equal(await claimSyncJob(JOB, 5_000), true);
  const [before1] = await query<{ claimed_until: string }>(
    `SELECT claimed_until::text FROM sync_claims WHERE job = $1`, [JOB]);
  assert.equal(await renewSyncClaim(JOB, 60_000), true);
  const [after1] = await query<{ claimed_until: string }>(
    `SELECT claimed_until::text FROM sync_claims WHERE job = $1`, [JOB]);
  assert.ok(Date.parse(after1.claimed_until) > Date.parse(before1.claimed_until), 'renew must push the deadline out');
  await releaseSyncJob(JOB);

  await claimAsOtherMachine(JOB2, 60_000);
  assert.equal(await renewSyncClaim(JOB2), false, 'must not renew a claim we do not hold');
});

test('release only drops OUR claim, never another machine\'s', async () => {
  await claimAsOtherMachine(JOB2, 60_000);
  await releaseSyncJob(JOB2);
  const rows = await query(`SELECT job FROM sync_claims WHERE job = $1`, [JOB2]);
  assert.equal(rows.length, 1, "another machine's claim must survive our release");
});

test('withSyncClaim runs the body once and frees the claim afterwards', async () => {
  let ran = 0;
  assert.equal(await withSyncClaim(JOB, async () => { ran++; }), true);
  assert.equal(ran, 1);
  const rows = await query(`SELECT job FROM sync_claims WHERE job = $1`, [JOB]);
  assert.equal(rows.length, 0, 'claim must be released so the next run is not gated on the TTL');
});

test('withSyncClaim does NOT run the body when another machine holds the job', async () => {
  // This is the bug, expressed directly: the second machine must not sync.
  await claimAsOtherMachine(JOB, 60_000);
  let ran = 0;
  assert.equal(await withSyncClaim(JOB, async () => { ran++; }), false);
  assert.equal(ran, 0);
});

test('withSyncClaim releases the claim even when the sync THROWS', async () => {
  // A crashed sync that kept its claim would block the catalog until the TTL expired.
  //
  // ── WHY THIS IS NOT A BARE assert.rejects (2026-08-14) ─────────────────────────────
  // It used to be, and it flaked — failing on `ba63dca`, a commit touching two .md files
  // and a .ps1, twenty minutes after the identical code passed.
  //
  // `claimSyncJob` fails CLOSED on a DB error and returns false, which is correct and must
  // stay: a doubled catalog sync is the bug this whole module exists to prevent, and a
  // missed nightly sync costs one day of freshness against a 403 storm. But it means a
  // transient blip and "another machine holds it" are the same `false`, `withSyncClaim`
  // then returns without running the body, and `assert.rejects` reports
  // `Missing expected rejection` — which reads as THE RELEASE IS BROKEN. It is not, and
  // nothing about that message says so. The same shape as `claimBotCommands` returning []
  // for both "nobody asked" and "the query threw".
  //
  // So the body records that it ran, and THAT is asserted first. The test still fails on a
  // blip — a green that proved nothing would be worse — but it fails saying which of the
  // two happened, which is the whole distinction.
  await mutate(`DELETE FROM sync_claims WHERE job = $1`, [JOB]);
  let ran = 0;
  const outcome = await withSyncClaim(JOB, async () => {
    ran++;
    throw new Error('sync blew up');
  }).then((v) => v as unknown, (e: unknown) => e);

  assert.equal(ran, 1,
    'the body never ran, so the claim was not won and the RELEASE WAS NEVER EXERCISED. ' +
    'That is a transient DB error (claimSyncJob fails closed by design), not a broken ' +
    'release — re-run it, and do not "fix" the release on the strength of this.');
  assert.ok(outcome instanceof Error && /sync blew up/.test(outcome.message),
    `the sync's own error must propagate to the caller, got ${String(outcome)}`);

  const rows = await query(`SELECT job FROM sync_claims WHERE job = $1`, [JOB]);
  assert.equal(rows.length, 0, 'a throwing sync must still release');
});

test('only ONE of eight DIFFERENT machines wins a free job', async () => {
  // THE bug, expressed as the race that causes it: every machine ticks at the same
  // moment, all see the sync is due, all ask at once. Exactly one may sync.
  //
  // Eight DISTINCT machine ids through the REAL claimSyncJob — not a copy of its SQL
  // re-typed here, which would keep passing after someone changed the statement it is
  // supposed to be guarding.
  await mutate(`DELETE FROM sync_claims WHERE job = $1`, [JOB]);
  const winners = (await Promise.all(
    Array.from({ length: 8 }, (_, i) => claimSyncJob(JOB, 60_000, `machine-${i}`))
  )).filter(Boolean).length;
  assert.equal(winners, 1, `exactly one machine may run the sync, got ${winners}`);
  await mutate(`DELETE FROM sync_claims WHERE job = $1`, [JOB]);
});
