// The shared rec.gov fetch lane. This decides how often the worker is allowed to talk
// to rec.gov at all, so a bug here is either "we get rate-limited again" or "auto-cart
// goes slow" — both expensive, neither loud.
//
// No network and no clock dependence: the fetcher is injected and `now` is passed in,
// so the budget arithmetic is exercised deterministically rather than by sleeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CampgroundAvailability } from '../src/lib/types';

process.env.RECGOV_BUDGET_PER_MIN = '60'; // 1/sec — round numbers for the arithmetic
process.env.RECGOV_BUDGET_BURST = '3';
process.env.RECGOV_BUDGET_LOW_RESERVE = '1.5';

const { getAvailability, schedulerStats, __resetScheduler } = await import('./recgov-scheduler');

const avail = (campgroundId: string, month: string, n = 1): CampgroundAvailability => ({
  campgroundId,
  month,
  campsites: [],
  availableCount: n,
});

/** Counts calls so "did this actually hit the network" is directly assertable. */
function countingFetcher(delayResolve?: { promise: Promise<void> }) {
  const calls: string[] = [];
  const fn = async (id: string, month: string) => {
    calls.push(`${id}|${month}`);
    if (delayResolve) await delayResolve.promise;
    return avail(id, month, calls.length);
  };
  return { fn, calls };
}

test('recgov scheduler', async (t) => {
  await t.test('a fresh-enough cache entry costs no request', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    const f = countingFetcher();
    await getAvailability('c1', '2026-09', { maxAgeMs: 15_000, now: t0, fetcher: f.fn });
    const second = await getAvailability('c1', '2026-09', { maxAgeMs: 15_000, now: t0 + 5_000, fetcher: f.fn });
    assert.equal(f.calls.length, 1, 'second call must be served from cache');
    assert.equal(second.ageMs, 5_000);
    assert.equal(second.stale, false);
  });

  await t.test('a caller needing fresher data than the cache holds does refetch', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    const f = countingFetcher();
    await getAvailability('c1', '2026-09', { maxAgeMs: 15_000, now: t0, fetcher: f.fn });
    // Auto-cart's view: 5s-old data is too old for it, even though the main cycle is happy.
    await getAvailability('c1', '2026-09', { maxAgeMs: 3_000, now: t0 + 5_000, priority: 'high', fetcher: f.fn });
    assert.equal(f.calls.length, 2, 'high-priority freshness requirement must win');
  });

  await t.test('concurrent callers for the same key share ONE request', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    let release!: () => void;
    const gate = { promise: new Promise<void>((r) => (release = r)) };
    const f = countingFetcher(gate);
    // Both lanes wanting the same campground in the same tick is the common case.
    const all = Promise.all([
      getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0, priority: 'high', fetcher: f.fn }),
      getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0, priority: 'low', fetcher: f.fn }),
      getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0, priority: 'low', fetcher: f.fn }),
    ]);
    release();
    const results = await all;
    assert.equal(f.calls.length, 1, 'single-flight: three callers, one request');
    for (const r of results) assert.equal(r.value.availableCount, 1, 'all three get the same value');
  });

  await t.test('the budget denies LOW before HIGH, and never fabricates data', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    const f = countingFetcher();
    // Burst is 3, low-priority floor is 1.5 → low may spend twice (3->2, 2->1 would
    // breach the floor, so exactly one more after the first). Drain with distinct keys
    // at the same instant so no refill happens.
    const spent: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await getAvailability(`low${i}`, '2026-09', { maxAgeMs: 0, now: t0, priority: 'low', fetcher: f.fn });
      spent.push(!r.stale);
    }
    assert.ok(f.calls.length < 4, 'the budget must have refused at least one low-priority fetch');
    const lowCalls = f.calls.length;

    // HIGH may dip into the reserve the low callers were kept out of.
    const hi = await getAvailability('hi', '2026-09', { maxAgeMs: 0, now: t0, priority: 'high', fetcher: f.fn });
    assert.equal(f.calls.length, lowCalls + 1, 'high priority must still get through');
    assert.equal(hi.stale, false);

    // A denied caller with NO prior value must report unknown — an empty result here
    // reads as "fully booked" downstream, which is the bug that shipped in search.
    const denied = await getAvailability('never-seen', '2026-09', { maxAgeMs: 0, now: t0, priority: 'low', fetcher: f.fn });
    assert.equal(denied.stale, true);
    assert.equal(denied.value.unknown, true, 'unknown, NOT an empty "nothing available"');
  });

  await t.test('a denied refresh returns the previous value marked stale', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    const f = countingFetcher();
    await getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0, priority: 'high', fetcher: f.fn });
    // Drain the bucket at the same instant.
    for (let i = 0; i < 5; i++) {
      await getAvailability(`drain${i}`, '2026-09', { maxAgeMs: 0, now: t0, priority: 'high', fetcher: f.fn });
    }
    const r = await getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0 + 100, priority: 'low', fetcher: f.fn });
    assert.equal(r.stale, true, 'budget denied the refresh');
    assert.equal(r.value.availableCount, 1, 'previous value preserved, not blanked');
    assert.equal(r.value.unknown, undefined, 'a real prior reading is not "unknown"');
  });

  await t.test('an unknown result never clobbers a real cached reading', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    const good = async () => avail('c1', '2026-09', 7);
    const unknown = async () => ({ ...avail('c1', '2026-09', 0), unknown: true });

    await getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0, priority: 'high', fetcher: good });
    await getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0 + 10, priority: 'high', fetcher: unknown });
    // A failed read is the ABSENCE of a reading, not a newer one. Overwriting here
    // would turn a known-good campground into "we don't know" on one bad fetch.
    const after = await getAvailability('c1', '2026-09', { maxAgeMs: 60_000, now: t0 + 20, fetcher: good });
    assert.equal(after.value.availableCount, 7, 'previous real reading must survive');
    assert.equal(after.value.unknown, undefined);
  });

  await t.test('an open breaker costs no budget and preserves the last reading', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    const f = countingFetcher();
    await getAvailability('c1', '2026-09', { maxAgeMs: 0, now: t0, priority: 'high', fetcher: f.fn });
    // Advance the clock: at a frozen instant age is 0, which counts as fresh and would
    // return from cache before the breaker check is ever reached. Sample the budget at
    // the SAME instant as the call so refill isn't mistaken for a spend.
    const at = t0 + 100;
    const tokensBefore = schedulerStats(at).tokens;

    // The rec.gov breaker short-circuits without touching the network, so a call made
    // while it is open would burn a token and buy nothing.
    const r = await getAvailability('c1', '2026-09', {
      maxAgeMs: 0, now: at, priority: 'high', fetcher: f.fn, breakerOpen: () => true,
    });
    assert.equal(f.calls.length, 1, 'no fetch attempted while the breaker is open');
    assert.equal(schedulerStats(at).tokens, tokensBefore, 'and no budget spent on a no-op');
    assert.equal(r.stale, true);
    assert.equal(r.value.availableCount, 1, 'last real reading served, not blanked to unknown');
  });

  await t.test('tokens refill over time at the configured rate', async () => {
    const t0 = 1_000_000;
    __resetScheduler(t0);
    const f = countingFetcher();
    for (let i = 0; i < 5; i++) {
      await getAvailability(`d${i}`, '2026-09', { maxAgeMs: 0, now: t0, priority: 'high', fetcher: f.fn });
    }
    const drained = f.calls.length;
    // 60/min = 1/sec, so 3 seconds later the bucket is back to its cap of 3.
    await getAvailability('later', '2026-09', { maxAgeMs: 0, now: t0 + 3_000, priority: 'low', fetcher: f.fn });
    assert.equal(f.calls.length, drained + 1, 'refilled budget lets a low-priority call through');
    assert.equal(schedulerStats(t0 + 3_000).budgetPerMin, 60);
  });
});
