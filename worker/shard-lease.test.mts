// The shard lease, against the REAL database — same reasoning as the alerting claim
// suite: the correctness lives entirely inside one INSERT .. ON CONFLICT .. WHERE, so a
// mocked client would test a fake. Two machines must never both believe they hold the
// same index; that is what stops a campground being polled twice, or a slice being
// dropped when a machine dies.
//
// Uses shard indices far above any real SHARD_COUNT so it cannot disturb a live lease.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';

const A = 9001; // "machine A" index — nowhere near a real shard
const B = 9002;

const claim = (index: number, machineId: string, leaseMs: number) =>
  mutate<{ shard_index: number }>(
    `INSERT INTO poller_shards (shard_index, machine_id, leased_until, shard_count)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, 9999)
     ON CONFLICT (shard_index) DO UPDATE
       SET machine_id   = EXCLUDED.machine_id,
           leased_until = EXCLUDED.leased_until,
           shard_count  = EXCLUDED.shard_count,
           updated_at   = NOW()
       WHERE poller_shards.machine_id = EXCLUDED.machine_id
          OR poller_shards.leased_until < NOW()
     RETURNING shard_index`,
    [index, machineId, String(leaseMs)]
  ).then((r) => r.length > 0);

after(async () => {
  await mutate(`DELETE FROM poller_shards WHERE shard_index IN ($1, $2)`, [A, B]).catch(() => {});
});

test('shard lease', async (t) => {
  await t.test('a free index is claimable', async () => {
    await mutate(`DELETE FROM poller_shards WHERE shard_index = $1`, [A]);
    assert.equal(await claim(A, 'machine-a', 60_000), true);
  });

  await t.test('a second machine CANNOT steal a live lease', async () => {
    // The property everything else rests on. Without it two machines poll the same
    // campgrounds, doubling the request rate the budget exists to cap.
    assert.equal(await claim(A, 'machine-b', 60_000), false, 'machine-b must be refused');
    const [row] = await query<{ machine_id: string }>(
      `SELECT machine_id FROM poller_shards WHERE shard_index = $1`, [A]);
    assert.equal(row.machine_id, 'machine-a', 'holder must be unchanged');
  });

  await t.test('the holder can renew its own lease', async () => {
    assert.equal(await claim(A, 'machine-a', 60_000), true, 'renewal by the holder must succeed');
  });

  await t.test('an EXPIRED lease is taken over — a dead machine self-heals', async () => {
    // Claim with a lease already in the past, then let another machine take it. This is
    // the recovery path: a machine dies, its slice is uncovered, and the next machine
    // to look picks it up without anyone intervening.
    await mutate(`DELETE FROM poller_shards WHERE shard_index = $1`, [B]);
    assert.equal(await claim(B, 'machine-a', -1_000), true, 'seed an already-expired lease');
    assert.equal(await claim(B, 'machine-b', 60_000), true, 'expired lease must be takeable');
    const [row] = await query<{ machine_id: string }>(
      `SELECT machine_id FROM poller_shards WHERE shard_index = $1`, [B]);
    assert.equal(row.machine_id, 'machine-b', 'new holder recorded');
  });

  await t.test('concurrent claimants on one free index: exactly one wins', async () => {
    await mutate(`DELETE FROM poller_shards WHERE shard_index = $1`, [B]);
    const results = await Promise.all([
      claim(B, 'race-1', 60_000),
      claim(B, 'race-2', 60_000),
      claim(B, 'race-3', 60_000),
    ]);
    assert.equal(results.filter(Boolean).length, 1, `exactly one claim may succeed, got ${results}`);
  });
});
