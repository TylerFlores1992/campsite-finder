// Shard assignment. Gets the campground split wrong and campgrounds are either polled
// twice (wasting the rate budget that this whole mechanism exists to protect) or by
// nobody at all — which is silent, and the worst failure this product has.
//
// The hash is pure, so this needs no DB and no network. The lease itself is exercised
// against the real database in shard-lease.test.mts, for the same reason the alerting
// claim is: its correctness lives inside one INSERT .. ON CONFLICT .. WHERE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shardOf } from './shard';

// Real ids from the catalog: rec.gov numerics, and the prefixed forms the other
// sources use. A hash that behaves well on one shape and badly on another would split
// unevenly in exactly the way that is hard to notice.
const IDS = [
  '232447', '10039845', '232194', '234330', '234406', '255122', '233653', '254094',
  'rc-1103', 'rc-712', 'rc-713', 'az-45', 'il-130', 'va-74', 'fl-202', 'oh-854',
  'gtc-MI--2147483293', 'ra-AK-1180124', 'tnsc-TN-1',
];

test('shard assignment', async (t) => {
  await t.test('is stable across calls — the whole point', () => {
    // If this ever varies, two machines disagree about ownership and a campground is
    // polled twice or not at all. Stability is the property, not the distribution.
    for (const id of IDS) {
      const first = shardOf(id, 8);
      for (let i = 0; i < 50; i++) assert.equal(shardOf(id, 8), first, `unstable for ${id}`);
    }
  });

  await t.test('SHARD_COUNT=1 assigns everything to shard 0', () => {
    // The shipped configuration. Anything else here means shipping it "dark" changed
    // behaviour, which is precisely what it must not do.
    for (const id of IDS) assert.equal(shardOf(id, 1), 0, `${id} must land on the only shard`);
  });

  await t.test('every id lands in range for any count', () => {
    for (const count of [1, 2, 3, 4, 8, 16]) {
      for (const id of IDS) {
        const s = shardOf(id, count);
        assert.ok(Number.isInteger(s) && s >= 0 && s < count, `${id} → ${s} out of range for ${count}`);
      }
    }
  });

  await t.test('splits reasonably evenly, so one machine is not doing all the work', () => {
    // Capacity per machine is ~4 campground-months. A lopsided hash means one shard
    // saturates its budget while another idles, and the extra machine buys nothing.
    const ids = Array.from({ length: 600 }, (_, i) => `${200000 + i * 7}`);
    for (const count of [2, 4, 8]) {
      const buckets = new Array<number>(count).fill(0);
      for (const id of ids) buckets[shardOf(id, count)]++;
      const ideal = ids.length / count;
      for (const [i, n] of buckets.entries()) {
        assert.ok(
          n > ideal * 0.6 && n < ideal * 1.4,
          `shard ${i}/${count} got ${n} of ${ids.length} (ideal ${ideal}) — distribution too skewed`
        );
      }
    }
  });

  await t.test('all months of a campground share a shard', () => {
    // Sharding by campground, NOT by watch or by campground-month, is what preserves
    // the dedup that makes this scale: one fetch serves every watch on that campground.
    // Splitting a campground across machines would refetch the same URL from two IPs.
    for (const id of IDS) {
      const s = shardOf(id, 8);
      for (const month of ['2026-07', '2026-08', '2026-09', '2026-12']) {
        assert.equal(shardOf(id, 8), s, `${id} must not depend on ${month}`);
      }
    }
  });
});
