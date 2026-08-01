// One rec.gov fetch lane for the whole worker.
//
// THE PROBLEM THIS EXISTS TO SOLVE. There were two independent rec.gov fetch loops
// with no shared state: the main poll cycle (every 15s) and the auto-cart lane (every
// 6s, `autocartCycle`). Neither knew what the other was doing, so the worker's real
// request rate was not controllable — or even observable — from any single place. On
// 2026-07-31 that produced ~26-36 req/min, including one campground URL fetched TEN
// TIMES A MINUTE by the auto-cart lane alone, which is what kept rec.gov 429ing us at
// what looked like trivial volume. It also made every estimate of our own load wrong,
// including the one that sent the worker to a different region for nothing.
//
// Everything that reads rec.gov availability in the worker now goes through here, so
// the rate is enforced in exactly one place and can be reasoned about.
//
// Three mechanisms, in the order they matter:
//
//   1. SINGLE-FLIGHT. Concurrent callers wanting the same (campground, month) share one
//      request. This alone removes the both-lanes-want-the-same-campground waste.
//   2. SHORT-TTL CACHE. A caller states how fresh it needs the data (`maxAgeMs`). The
//      auto-cart lane asks for genuinely fresh data and gets it; the main cycle tolerates
//      more. Nobody re-fetches what somebody else just fetched.
//   3. RATE BUDGET. A token bucket caps requests per minute across the whole worker.
//      When the budget is tight, LOW-priority callers are served from cache (possibly
//      stale) while HIGH-priority ones still get the network. This is what turns growth
//      into "detection gets slower" instead of "the breaker slams shut and we go blind".
//
// Staleness is always reported, never hidden — see CachedAvailability.ageMs. A caller
// that has never had a value gets `unknown: true`, which the availability adapters
// already treat as "we don't know", NOT as "nothing is available".

import type { CampgroundAvailability } from '../src/lib/types';
import { getAvailabilityFromRecGov, recgovBreakerCoolingDown } from '../src/lib/availability/recgov';
import { recordRateEvent } from './rate-profile';

/**
 * Requests per minute this worker may make to rec.gov, across every lane.
 *
 * 15 is measured, not guessed: a probe running 16 req/min strictly sequentially from a
 * clean Fly IP took 160 requests with zero 429s, while production — doing ~26-36/min
 * across two uncoordinated lanes — was throttled continuously in the same region.
 */
const BUDGET_PER_MIN = Number(process.env.RECGOV_BUDGET_PER_MIN ?? 15);
/**
 * Burst capacity. **Must be >= the number of requests a caller dispatches inside one
 * pacing window**, or the bucket denies traffic that is already properly paced.
 *
 * This was set to 2 on the theory that a small burst is inherently safer. Wrong lever,
 * and measurably so: the main cycle paces 4 campground-months over 7.5s and then idles,
 * so with BURST=2 the second and fourth requests of every cycle arrived a few hundred
 * milliseconds short of the threshold and were refused. Measured 8 served/min against 8
 * denied/min — barely half the budget reaching the network, while rec.gov was perfectly
 * happy to serve it.
 *
 * The bucket does not create bursts; `pacedForEach` already spaces the requests out.
 * Burst capacity only decides whether the bucket LETS the paced traffic through, so
 * sizing it to the cycle's working set costs nothing upstream. 4 restores full budget
 * utilisation (15.2/min served, 0.8 denied in simulation against the real cadence).
 *
 * If the number of rec.gov campground-months per cycle grows well past this, raise it
 * to match — or the budget will silently under-deliver again.
 */
const BURST = Number(process.env.RECGOV_BUDGET_BURST ?? 4);
/**
 * LOW-priority callers may only spend down to this many tokens, leaving headroom for
 * HIGH — now the alert-health canary and the auto-cart reconciler, since auto-cart
 * detection moved into the main cycle. Small but not zero: a denied canary reads its
 * own starvation as "rec.gov is down" and raises a false banner.
 *
 * At BURST=4 this reserve costs nothing measurable (15.2/min served either way), which
 * is the whole reason to keep it.
 */
const LOW_PRIORITY_RESERVE = Number(process.env.RECGOV_BUDGET_LOW_RESERVE ?? 0.5);
/** Drop cache entries nothing has asked for in this long, so the map can't grow forever. */
const IDLE_EVICT_MS = 15 * 60 * 1000;

export type Priority = 'high' | 'low';

export interface CachedAvailability {
  value: CampgroundAvailability;
  /** How old the data is. 0 = fetched just now. */
  ageMs: number;
  /** True when the budget denied a refresh and this is the previous value. */
  stale: boolean;
}

interface Entry {
  value: CampgroundAvailability | null;
  fetchedAt: number;
  inFlight: Promise<CampgroundAvailability> | null;
  lastWantedAt: number;
}

type Fetcher = (campgroundId: string, month: string) => Promise<CampgroundAvailability>;

/**
 * The token bucket, as a value rather than module state — so a test can instantiate it
 * with arbitrary parameters and assert the arithmetic directly.
 *
 * It was module-global, and the first test written against it was worthless as a
 * result: env changes after module load did nothing, a re-import returned the cached
 * instance, and the assertions passed against a budget four times the one they claimed
 * to be testing.
 */
export function createBucket(opts: { budgetPerMin: number; burst: number; lowReserve: number; now?: number }) {
  let tokens = opts.burst;
  let lastRefillAt = opts.now ?? Date.now();
  const refill = (now: number) => {
    const elapsed = now - lastRefillAt;
    if (elapsed <= 0) return;
    lastRefillAt = now;
    tokens = Math.min(opts.burst, tokens + (elapsed / 60_000) * opts.budgetPerMin);
  };
  return {
    /** Spend a token if this caller's priority is allowed to. Never blocks. */
    trySpend(priority: Priority, now: number): boolean {
      refill(now);
      const floor = priority === 'high' ? 0 : opts.lowReserve;
      if (tokens - 1 < floor) return false;
      tokens -= 1;
      return true;
    },
    tokens(now: number): number {
      refill(now);
      return tokens;
    },
  };
}

const entries = new Map<string, Entry>();
let bucket = createBucket({ budgetPerMin: BUDGET_PER_MIN, burst: BURST, lowReserve: LOW_PRIORITY_RESERVE });
// Counters since the last takeCounters(). NOT reset by logging: the previous version
// reset them inside the denial branch and only logged when a denial happened, so the
// window they covered was however long it had been since the last denial. Sparse
// denials silently stretched it past a minute and the "per minute" label was wrong —
// a reporting bug inside the very instrumentation added to stop guessing at throughput.
let served = 0;
let denied = 0;
let countersSince = Date.now();

const trySpend = (priority: Priority, now: number) => bucket.trySpend(priority, now);

function evictIdle(now: number): void {
  for (const [key, e] of entries) {
    if (!e.inFlight && now - e.lastWantedAt > IDLE_EVICT_MS) entries.delete(key);
  }
}

/**
 * Availability for one campground-month, subject to the shared budget.
 *
 * `maxAgeMs` is how stale the CALLER can tolerate. Fresher than that → cache, no
 * request. Otherwise a request is attempted, and if the budget denies it the previous
 * value comes back marked `stale` rather than a fabricated empty one.
 */
export async function getAvailability(
  campgroundId: string,
  month: string,
  opts: {
    maxAgeMs: number;
    priority?: Priority;
    now?: number;
    fetcher?: Fetcher;
    /** Injectable so the budget rules can be tested without real breaker state. */
    breakerOpen?: () => boolean;
  }
): Promise<CachedAvailability> {
  const now = opts.now ?? Date.now();
  const priority = opts.priority ?? 'low';
  const fetch = opts.fetcher ?? getAvailabilityFromRecGov;
  const key = `${campgroundId}|${month}`;

  let e = entries.get(key);
  if (!e) entries.set(key, (e = { value: null, fetchedAt: 0, inFlight: null, lastWantedAt: now }));
  e.lastWantedAt = now;

  const age = e.value ? now - e.fetchedAt : Infinity;
  if (e.value && age <= opts.maxAgeMs) return { value: e.value, ageMs: age, stale: false };

  // Somebody is already fetching exactly this — join them instead of making a second
  // request. Both lanes wanting the same campground is the common case, not the edge.
  if (e.inFlight) {
    const value = await e.inFlight;
    return { value, ageMs: 0, stale: false };
  }

  // Skip only during the breaker's HARD cooldown, when the call is guaranteed to
  // short-circuit anyway — spending a token on that buys nothing, and its `unknown`
  // would overwrite a good cached reading.
  //
  // It MUST be recgovBreakerCoolingDown and not recgovBreakerOpen. The latter stays
  // true until a success closes the breaker, and the only thing that can produce that
  // success is the half-open probe inside getAvailabilityFromRecGov — which never runs
  // if we skip. That deadlocked rec.gov detection in production for thirteen minutes
  // until the worker was restarted.
  if ((opts.breakerOpen ?? recgovBreakerCoolingDown)()) {
    recordRateEvent('breaker_skipped');
    if (e.value) return { value: e.value, ageMs: age, stale: true };
    return {
      value: { campgroundId, month, campsites: [], availableCount: 0, unknown: true },
      ageMs: Infinity,
      stale: true,
    };
  }

  if (!trySpend(priority, now)) {
    denied++;
    recordRateEvent('denied');
    if (e.value) return { value: e.value, ageMs: age, stale: true };
    // Never fetched this one and can't afford to. `unknown` is the honest answer —
    // an empty result here would read as "fully booked" downstream.
    return {
      value: { campgroundId, month, campsites: [], availableCount: 0, unknown: true },
      ageMs: Infinity,
      stale: true,
    };
  }

  served++;
  const p = fetch(campgroundId, month)
    .then((value) => {
      // A failed/short-circuited read is `unknown` — it is not a newer reading, it is
      // the absence of one. Keeping the previous real value is strictly more useful
      // than replacing it with "we don't know".
      if (!value.unknown || !e!.value) {
        e!.value = value;
        e!.fetchedAt = now;
      }
      return value;
    })
    .finally(() => {
      e!.inFlight = null;
    });
  e.inFlight = p;
  evictIdle(now);
  const value = await p;
  return { value, ageMs: 0, stale: false };
}

/** Observability for the heartbeat line — you cannot budget what you cannot see. */
export function schedulerStats(now = Date.now()): {
  tokens: number;
  tracked: number;
  budgetPerMin: number;
  burst: number;
  lowReserve: number;
} {
  return {
    tokens: Math.round(bucket.tokens(now) * 10) / 10,
    tracked: entries.size,
    budgetPerMin: BUDGET_PER_MIN,
    burst: BURST,
    lowReserve: LOW_PRIORITY_RESERVE,
  };
}

/**
 * Read and reset the fetch counters. The caller owns the cadence, so the window is
 * always exactly "since you last asked" — reported explicitly as `sinceMs` rather than
 * assumed to be a minute. The poller calls this once per heartbeat.
 */
export function takeCounters(now = Date.now()): { served: number; denied: number; sinceMs: number } {
  const out = { served, denied, sinceMs: now - countersSince };
  served = 0;
  denied = 0;
  countersSince = now;
  return out;
}

/** Tests only — the module is process-global by design. `now` anchors the bucket's
 *  clock, without which a test passing a synthetic `now` in the past would silently
 *  never refill and quietly assert nothing. */
export function __resetScheduler(now = Date.now()): void {
  entries.clear();
  bucket = createBucket({ budgetPerMin: BUDGET_PER_MIN, burst: BURST, lowReserve: LOW_PRIORITY_RESERVE, now });
  served = 0;
  denied = 0;
  countersSince = now;
}
