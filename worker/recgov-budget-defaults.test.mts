// Guards the SHIPPED rec.gov budget defaults against the poller's real dispatch shape.
//
// Deliberately a separate file, with no RECGOV_BUDGET_* env set, because node:test runs
// each file in its own process — the sibling suite overrides these to make its
// arithmetic readable, and would mask exactly the regression this exists to catch.
//
// The regression: BURST was 2 while the main cycle paced 4 campground-months per cycle,
// so half the budget never reached the network and rec.gov watches refreshed at ~30s
// instead of 15s. Nothing failed. The logs said "budget exhausted" and the budget was
// nowhere near exhausted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBucket, schedulerStats } from './recgov-scheduler';

// What worker/poller.ts actually does: RECGOV_SPREAD_MS is half of POLL_INTERVAL_MS,
// so N campground-months are dispatched across 7.5s and then the cycle idles.
const CYCLE_MS = 15_000;
const PAIRS_PER_CYCLE = 4;
const PACE_MS = (CYCLE_MS * 0.5) / PAIRS_PER_CYCLE;

test('shipped budget defaults deliver the full rate under the poller cadence', () => {
  const cfg = schedulerStats(0);
  const bucket = createBucket({
    budgetPerMin: cfg.budgetPerMin,
    burst: cfg.burst,
    lowReserve: cfg.lowReserve,
    now: 0,
  });

  const CYCLES = 40;
  let served = 0;
  for (let c = 0; c < CYCLES; c++) {
    for (let i = 0; i < PAIRS_PER_CYCLE; i++) {
      if (bucket.trySpend('low', c * CYCLE_MS + i * PACE_MS)) served++;
    }
  }
  const perMin = served / ((CYCLES * CYCLE_MS) / 60_000);
  const demand = PAIRS_PER_CYCLE * (60_000 / CYCLE_MS);
  const ceiling = Math.min(demand, cfg.budgetPerMin);

  assert.ok(
    perMin >= ceiling * 0.95,
    `defaults deliver ${perMin}/min against a ceiling of ${ceiling}/min ` +
      `(budget ${cfg.budgetPerMin}, burst ${cfg.burst}, reserve ${cfg.lowReserve}). ` +
      `A burst below the ${PAIRS_PER_CYCLE} requests dispatched per cycle silently halves throughput.`
  );
});
