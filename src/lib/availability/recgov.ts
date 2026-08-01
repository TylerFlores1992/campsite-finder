import axios from 'axios';
import type { CampgroundAvailability, CampsiteAvailability, AvailabilityDay } from '@/lib/types';

// Recreation.gov's unofficial availability API — same one their own site uses.
// Returns availability by campsite for a given month.
// Treat as best-effort: structure can change without notice.
const BASE = 'https://www.recreation.gov/api/camps/availability/campground';

type RecGovStatus =
  | 'Available'
  | 'Reserved'
  | 'Not Available'
  | 'Open'
  | 'Closed'
  | string;

interface RecGovCampsite {
  availabilities: Record<string, RecGovStatus>; // ISO date string → status
  campsite_id: string;
  campsite_reserve_type: string;
  campsite_type: string;
  loop: string;
  max_num_people: number;
  min_num_people: number;
  site: string;
  type_of_use: string;
}

function normalizeStatus(raw: RecGovStatus): AvailabilityDay['status'] {
  switch (raw) {
    case 'Available':
    case 'Open':
      return 'available';
    case 'Reserved':
      return 'reserved';
    case 'Closed':
      return 'closed';
    default:
      return 'not_available';
  }
}

function isoToDate(iso: string): string {
  // RecGov returns "2024-07-01T00:00:00Z" — we want "2024-07-01"
  return iso.slice(0, 10);
}

/**
 * Present as the browser this endpoint actually serves.
 *
 * The old value was `Mozilla/5.0 (compatible; CampsiteFinder/1.0)` under a comment
 * saying "mimic the browser" — it did the opposite: a self-identifying bot string, and
 * the single cheapest thing for a rate limiter to key on. The UseDirect client was
 * given real Chrome headers for the same reason (`rdrRequestHeaders`); this one was
 * left behind. Verified against the live endpoint: both header sets return 200 with
 * the same 235 campsites, so nothing downstream changes shape.
 *
 * Not a proven fix for the 429s on its own — rec.gov also rate-limits datacenter IPs,
 * and the Fly worker's address may be flagged regardless — but announcing ourselves as
 * a scraper is indefensible either way.
 */
function recgovHeaders(campgroundId: string): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/139.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="139", "Not(A:Brand";v="24", "Google Chrome";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    // The page a real visitor would be on when their browser makes this call.
    Referer: `https://www.recreation.gov/camping/campgrounds/${campgroundId}/availability`,
  };
}

// --- rec.gov throttle breaker (process-local) ---------------------------------
// rec.gov aggressively rate-limits datacenter IPs (429s), and a request that's
// being throttled either 429s or eats the full 10s timeout. Without a breaker the
// poller re-hits rec.gov every cycle during a storm, which (a) stretches the
// single-threaded poll cycle by 10s per stall and (b) keeps feeding the ban. When
// consecutive throttle failures pile up we OPEN the breaker: calls short-circuit to
// empty (instant, no network) until a cooldown elapses, then one call probes
// (half-open) and a success closes it. Returning empty during cooldown is the same
// result the 429 storm already produced, so detection loses nothing — but the cycle
// stays fast and we stop sustaining the throttle. State is per-process, so it only
// trips in whichever deployment (the Fly worker) is actually being throttled, never
// affecting Vercel search on its own IP.
const RECGOV_BREAKER_TRIP = Number(process.env.RECGOV_BREAKER_TRIP ?? 3);
const RECGOV_BREAKER_COOLDOWN_MS = Number(process.env.RECGOV_BREAKER_COOLDOWN_MS ?? 60_000);
/**
 * Ceiling on the ESCALATED cooldown.
 *
 * The cooldown used to be a flat 60s with no escalation, which is why the breaker
 * flapped: 2026-07-30 saw six OPEN/CLOSED cycles in thirteen minutes, so rec.gov
 * watches went unchecked something like 40% of the time while we walked back into the
 * same rate limit every minute. Each failed recovery now waits twice as long, so a
 * sustained throttle costs a few long pauses instead of a permanent sawtooth. Capped,
 * because rec.gov IS the product for these watches — we never stop trying for long.
 */
const RECGOV_BREAKER_MAX_COOLDOWN_MS = Number(process.env.RECGOV_BREAKER_MAX_COOLDOWN_MS ?? 8 * 60_000);
// Per-request timeout. Shortened from the original 10s (issue #14): during a throttle
// storm a hung rec.gov socket holds a connection for the whole timeout, and enough of
// them starve the worker's socket pool / event loop so EVERY other source (RA, RC,
// GTC, TN/SC) starts timing out too — the "timeout cascade". A tighter bound caps how
// long each stall lives, so the breaker (which trips after RECGOV_BREAKER_TRIP
// throttles, counting timeouts) opens far sooner and the pool never starves. Env-
// tunable so it can be relaxed on the Fly worker without a code change if legitimate
// responses ever need longer.
const RECGOV_TIMEOUT_MS = Number(process.env.RECGOV_TIMEOUT_MS ?? 5000);
let recgovConsecutiveThrottles = 0;
let recgovBreakerOpenUntil = 0;
/** Current cooldown, doubled on each failed recovery and reset by a success. */
let recgovCooldownMs = RECGOV_BREAKER_COOLDOWN_MS;
/** Half-open: true while the single recovery probe is in flight. */
let recgovProbeInFlight = false;

function isThrottleError(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string; message?: string };
  if (e?.response?.status === 429) return true;
  // axios aborts a timed-out request with ECONNABORTED / a "timeout" message.
  return e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '');
}

// --- fetch-outcome observer (worker only) -------------------------------------
// The worker's rate-profile recorder registers here to count every real rec.gov
// fetch outcome, split finer than the breaker needs: a 429 (rec.gov said slow down)
// and a timeout (a hung socket, often the same throttle wearing a different hat)
// escalate the breaker identically but mean different things when profiling how much
// budget an hour of the day can carry. Null by default, so the Vercel deployment —
// which shares this module via /api/search — records nothing.
export type RecgovFetchOutcome = 'ok' | '429' | 'timeout' | 'error';
let fetchObserver: ((outcome: RecgovFetchOutcome) => void) | null = null;
export function setRecgovFetchObserver(cb: ((outcome: RecgovFetchOutcome) => void) | null): void {
  fetchObserver = cb;
}
function classifyOutcome(err: unknown): RecgovFetchOutcome {
  const e = err as { response?: { status?: number }; code?: string; message?: string };
  if (e?.response?.status === 429) return '429';
  if (e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '')) return 'timeout';
  return 'error';
}

/** True from the moment the breaker trips until a success closes it — INCLUDING the
 *  half-open phase, when one prober is allowed through. For "are we backing off",
 *  which is what the canary reports. NOT a safe gate for skipping a call: see
 *  recgovBreakerCoolingDown. */
export function recgovBreakerOpen(): boolean {
  return recgovBreakerOpenUntil !== 0;
}

/**
 * True only during the HARD cooldown, when a call is guaranteed to short-circuit
 * without touching the network.
 *
 * This distinction is load-bearing and its absence took rec.gov detection down in
 * production on 2026-07-31. The scheduler skipped fetches whenever
 * `recgovBreakerOpen()` was true — but that stays true until a SUCCESS closes the
 * breaker, and a success can only come from the half-open probe, which lives inside
 * getAvailabilityFromRecGov and therefore never ran. The breaker opened at 15:37:45
 * and was still open thirteen minutes later with zero fetches attempted: a deadlock
 * that could only be cleared by restarting the worker.
 *
 * Once the cooldown elapses a caller MUST be allowed through so `enterRecgovGate` can
 * admit its single prober. Skipping is only free while the answer is predetermined.
 */
export function recgovBreakerCoolingDown(): boolean {
  return Date.now() < recgovBreakerOpenUntil;
}

/** Breaker internals, for tests only. The half-open and escalation rules are the kind
 *  of state machine that reads correct and behaves wrong — worker/recgov-breaker.test.mts
 *  drives it for real rather than trusting the comments. */
export function __recgovBreakerState(): {
  open: boolean;
  cooldownMs: number;
  consecutive: number;
  probeInFlight: boolean;
} {
  return {
    open: recgovBreakerOpen(),
    cooldownMs: recgovCooldownMs,
    consecutive: recgovConsecutiveThrottles,
    probeInFlight: recgovProbeInFlight,
  };
}

/** Reset to CLOSED. Tests only — each scenario needs a known starting state, and a
 *  test that silently begins with the breaker already open is a test of nothing. */
export function __recgovBreakerReset(): void {
  recgovConsecutiveThrottles = 0;
  recgovBreakerOpenUntil = 0;
  recgovCooldownMs = RECGOV_BREAKER_COOLDOWN_MS;
  recgovProbeInFlight = false;
}

/**
 * Decide whether this call may touch the network, and HALF-OPEN properly.
 *
 * The old code claimed in a comment that after the cooldown "one call probes
 * (half-open) and a success closes it". It didn't: once the deadline passed the gate
 * simply reopened for everyone, so all four of the poller's concurrent fetches hit a
 * still-throttled rec.gov at once, three of them 429'd, and the breaker slammed shut
 * again. That is the flapping, and the comment described the fix rather than the code.
 *
 * Now exactly ONE caller crosses as a probe; the rest keep short-circuiting until it
 * resolves. One request cannot re-trip a limit that needs three.
 */
function enterRecgovGate(): { allowed: boolean; isProbe: boolean; release: () => void } {
  const noop = () => {};
  const denied = { allowed: false, isProbe: false, release: noop };
  if (recgovBreakerOpenUntil === 0) return { allowed: true, isProbe: false, release: noop }; // closed
  if (Date.now() < recgovBreakerOpenUntil) return denied; // open
  if (recgovProbeInFlight) return denied; // half-open, probe already taken
  recgovProbeInFlight = true;
  return {
    allowed: true,
    isProbe: true,
    release: () => {
      recgovProbeInFlight = false;
    },
  };
}

function recordRecgovOutcome(throttled: boolean, isProbe: boolean): void {
  if (!throttled) {
    if (recgovBreakerOpenUntil !== 0) {
      console.log('[RecGov availability] throttle breaker CLOSED — rec.gov reachable again');
    }
    recgovConsecutiveThrottles = 0;
    recgovBreakerOpenUntil = 0;
    recgovCooldownMs = RECGOV_BREAKER_COOLDOWN_MS; // recovered — forget the escalation
    return;
  }

  recgovConsecutiveThrottles++;
  const wasOpen = recgovBreakerOpenUntil !== 0;

  // A failure that arrives while the breaker is open, from a caller that was NOT the
  // recovery probe, is a request that had already crossed a closed gate and was still
  // in flight when the breaker tripped. It is stale news about a decision already made.
  // Count it, but it must not escalate the cooldown or push the deadline out.
  //
  // Observed in production within minutes of shipping the escalation (2026-07-30
  // 23:12:55): the poller's fourth paced fetch landed in the same second the first
  // three opened the breaker, was read as a failed probe, and doubled 60s to 120s
  // instantly. The unit test missed it because its failures were sequential; a real
  // cycle's are concurrent.
  if (wasOpen && !isProbe) return;

  // Closed and not yet at the trip count: just count it.
  if (!wasOpen && recgovConsecutiveThrottles < RECGOV_BREAKER_TRIP) return;
  // A failed half-open probe means the throttle is still on, so wait longer than last
  // time rather than walking back into it every 60 seconds.
  if (wasOpen) recgovCooldownMs = Math.min(recgovCooldownMs * 2, RECGOV_BREAKER_MAX_COOLDOWN_MS);
  recgovBreakerOpenUntil = Date.now() + recgovCooldownMs;
  console.warn(
    `[RecGov availability] throttle breaker ${wasOpen ? 'STILL OPEN — recovery probe throttled' : `OPEN after ${recgovConsecutiveThrottles} throttled requests`}` +
      ` — short-circuiting rec.gov fetches for ${recgovCooldownMs / 1000}s`
  );
}

export async function getAvailabilityFromRecGov(
  campgroundId: string,
  month: string // YYYY-MM
): Promise<CampgroundAvailability> {
  const startDate = `${month}-01T00:00:00.000Z`;

  // Breaker open (or half-open and the probe is already taken): skip the network
  // entirely (empty = "unknown", same as a storm).
  const gate = enterRecgovGate();
  if (!gate.allowed) {
    return { campgroundId, month, campsites: [], availableCount: 0, unknown: true };
  }

  let rawCampsites: Record<string, RecGovCampsite> = {};
  let unknown = false;

  try {
    // recreation.gov rejects unencoded ':' in query params ("query not encoded"),
    // and axios's default serializer leaves ':' bare — encode the URL ourselves.
    const response = await axios.get(
      `${BASE}/${campgroundId}/month?start_date=${encodeURIComponent(startDate)}`,
      { timeout: RECGOV_TIMEOUT_MS, headers: recgovHeaders(campgroundId) }
    );
    rawCampsites = response.data?.campsites ?? {};
    recordRecgovOutcome(false, gate.isProbe); // reachable — reset/close the breaker
    fetchObserver?.('ok');
  } catch (err) {
    console.warn(`[RecGov availability] Failed for ${campgroundId}/${month}:`, (err as Error).message);
    recordRecgovOutcome(isThrottleError(err), gate.isProbe); // count 429/timeout toward tripping the breaker
    fetchObserver?.(classifyOutcome(err));
    // Return empty availability rather than crashing — but FLAGGED, because empty and
    // "we never found out" are the same shape and mean opposite things to a user.
    unknown = true;
  } finally {
    gate.release();
  }

  const campsites: CampsiteAvailability[] = Object.values(rawCampsites).map((cs) => {
    const days: AvailabilityDay[] = Object.entries(cs.availabilities).map(([iso, status]) => ({
      date: isoToDate(iso),
      status: normalizeStatus(status),
      minStay: null,
    }));

    days.sort((a, b) => a.date.localeCompare(b.date));

    return {
      campsiteId: cs.campsite_id,
      campsiteName: cs.site || null,
      campsiteType: cs.campsite_type || null,
      loop: cs.loop || null,
      availability: days,
    };
  });

  const availableCount = campsites.filter((cs) =>
    cs.availability.some((d) => d.status === 'available')
  ).length;

  return {
    campgroundId,
    month,
    campsites,
    availableCount,
    ...(unknown ? { unknown: true } : {}),
  };
}

/**
 * Any available nights in this range? `null` means WE DON'T KNOW.
 *
 * This used to return a flat boolean, and that made the search page lie. A throttled
 * or short-circuited fetch yields empty campsites, which is the exact shape of "every
 * site is booked" — so during a rate limit `/api/search` rendered live, bookable
 * campgrounds as fully booked, confidently. Demonstrated on production 2026-07-31:
 * 15 Moab campgrounds all showed booked while rec.gov, asked directly, reported 5 of 6
 * sites free at the first one.
 *
 * The ReserveCalifornia client already refuses to do this — it throws rather than
 * returning empty, and its comment names the rec.gov breaker as the counter-example
 * that gets it wrong. This closes that gap. `/api/search` already maps a nullish check
 * to "unknown", so the search page needs no change: it renders unknown, not booked.
 */
export async function hasAvailabilityInRange(
  campgroundId: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,   // YYYY-MM-DD
  minNights = 1
): Promise<boolean | null> {
  // Determine which months to check
  const months = new Set<string>();
  const start = new Date(startDate);
  const end = new Date(endDate);
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    months.add(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }

  // Collect per-campsite availability across months so a stay spanning a month
  // boundary still counts as consecutive at the same site.
  const bySite = new Map<string, Map<string, boolean>>();
  let anyUnknown = false;
  for (const month of months) {
    const avail = await getAvailabilityFromRecGov(campgroundId, month);
    if (avail.unknown) anyUnknown = true;
    for (const cs of avail.campsites) {
      const days = bySite.get(cs.campsiteId) ?? new Map<string, boolean>();
      for (const day of cs.availability) {
        // Nights of the stay are [startDate, endDate) — checkout day isn't a night.
        if (day.date < startDate || day.date >= endDate) continue;
        days.set(day.date, day.status === 'available');
      }
      bySite.set(cs.campsiteId, days);
    }
  }

  for (const days of bySite.values()) {
    let consecutive = 0;
    for (const date of [...days.keys()].sort()) {
      if (days.get(date)) {
        consecutive++;
        if (consecutive >= minNights) return true;
      } else {
        consecutive = 0;
      }
    }
  }

  // Finding availability is positive proof and stands even if another month failed.
  // NOT finding it only means something when we actually looked at every month.
  return anyUnknown ? null : false;
}
