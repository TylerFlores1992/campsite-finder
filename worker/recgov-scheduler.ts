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
import { getAvailabilityFromRecGov, recgovBreakerOpen } from '../src/lib/availability/recgov';

/**
 * Requests per minute this worker may make to rec.gov, across every lane.
 *
 * 15 is measured, not guessed: a probe running 16 req/min strictly sequentially from a
 * clean Fly IP took 160 requests with zero 429s, while production — doing ~26-36/min
 * across two uncoordinated lanes — was throttled continuously in the same region.
 */
const BUDGET_PER_MIN = Number(process.env.RECGOV_BUDGET_PER_MIN ?? 15);
/**
 * Burst capacity. Deliberately tiny. A token bucket with a large burst is just a
 * slower version of the bursting that provoked the limit in the first place — the
 * poller's `pMap(4)` firing four at once and then idling is exactly the shape a token
 * bucket is supposed to smooth out.
 */
const BURST = Number(process.env.RECGOV_BUDGET_BURST ?? 2);
/**
 * LOW-priority callers may only spend down to this many tokens, leaving the rest as
 * headroom for HIGH. Without a reserve the main cycle's larger volume would crowd out
 * the auto-cart lane precisely when a site opens, which is the one moment carting has
 * to be fast.
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

const entries = new Map<string, Entry>();
let tokens = BURST;
let lastRefillAt = Date.now();
let deniedSinceLog = 0;
let lastDenyLogAt = 0;

function refill(now: number): void {
  const elapsed = now - lastRefillAt;
  if (elapsed <= 0) return;
  lastRefillAt = now;
  tokens = Math.min(BURST, tokens + (elapsed / 60_000) * BUDGET_PER_MIN);
}

/** Spend a token if this caller's priority is allowed to. Never blocks. */
function trySpend(priority: Priority, now: number): boolean {
  refill(now);
  const floor = priority === 'high' ? 0 : LOW_PRIORITY_RESERVE;
  if (tokens - 1 < floor) return false;
  tokens -= 1;
  return true;
}

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

  // The rec.gov breaker short-circuits without touching the network, so a call made
  // while it is open costs a token and buys nothing — and worse, its `unknown` result
  // would overwrite a perfectly good cached reading from seconds earlier. Serve what we
  // have instead, and keep the budget for when the network is actually reachable.
  if ((opts.breakerOpen ?? recgovBreakerOpen)()) {
    if (e.value) return { value: e.value, ageMs: age, stale: true };
    return {
      value: { campgroundId, month, campsites: [], availableCount: 0, unknown: true },
      ageMs: Infinity,
      stale: true,
    };
  }

  if (!trySpend(priority, now)) {
    deniedSinceLog++;
    // Log at most once a minute: under a sustained squeeze this fires constantly, and
    // a log line per denial would itself become the problem.
    if (now - lastDenyLogAt > 60_000) {
      console.warn(
        `[recgov-scheduler] budget exhausted — ${deniedSinceLog} low-priority fetch(es) served from cache ` +
          `in the last minute (budget ${BUDGET_PER_MIN}/min). Detection is slower, not blind.`
      );
      lastDenyLogAt = now;
      deniedSinceLog = 0;
    }
    if (e.value) return { value: e.value, ageMs: age, stale: true };
    // Never fetched this one and can't afford to. `unknown` is the honest answer —
    // an empty result here would read as "fully booked" downstream.
    return {
      value: { campgroundId, month, campsites: [], availableCount: 0, unknown: true },
      ageMs: Infinity,
      stale: true,
    };
  }

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
export function schedulerStats(now = Date.now()): { tokens: number; tracked: number; budgetPerMin: number } {
  refill(now);
  return { tokens: Math.round(tokens * 10) / 10, tracked: entries.size, budgetPerMin: BUDGET_PER_MIN };
}

/** Tests only — the module is process-global by design. `now` anchors the bucket's
 *  clock, without which a test passing a synthetic `now` in the past would silently
 *  never refill and quietly assert nothing. */
export function __resetScheduler(now = Date.now()): void {
  entries.clear();
  tokens = BURST;
  lastRefillAt = now;
  deniedSinceLog = 0;
  lastDenyLogAt = 0;
}
