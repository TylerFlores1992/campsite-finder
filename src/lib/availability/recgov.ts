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

/** True while rec.gov calls are being short-circuited. Exported so the alert-health
 *  canary can say "we are backing off" instead of "the API is down" — they produce
 *  identical empty results and used to be indistinguishable. */
export function recgovBreakerOpen(): boolean {
  return recgovBreakerOpenUntil !== 0;
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
function enterRecgovGate(): { allowed: boolean; release: () => void } {
  const noop = () => {};
  if (recgovBreakerOpenUntil === 0) return { allowed: true, release: noop }; // closed
  if (Date.now() < recgovBreakerOpenUntil) return { allowed: false, release: noop }; // open
  if (recgovProbeInFlight) return { allowed: false, release: noop }; // half-open, taken
  recgovProbeInFlight = true;
  return {
    allowed: true,
    release: () => {
      recgovProbeInFlight = false;
    },
  };
}

function recordRecgovOutcome(throttled: boolean): void {
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
    return { campgroundId, month, campsites: [], availableCount: 0 };
  }

  let rawCampsites: Record<string, RecGovCampsite> = {};

  try {
    // recreation.gov rejects unencoded ':' in query params ("query not encoded"),
    // and axios's default serializer leaves ':' bare — encode the URL ourselves.
    const response = await axios.get(
      `${BASE}/${campgroundId}/month?start_date=${encodeURIComponent(startDate)}`,
      { timeout: RECGOV_TIMEOUT_MS, headers: recgovHeaders(campgroundId) }
    );
    rawCampsites = response.data?.campsites ?? {};
    recordRecgovOutcome(false); // reachable — reset/close the breaker
  } catch (err) {
    console.warn(`[RecGov availability] Failed for ${campgroundId}/${month}:`, (err as Error).message);
    recordRecgovOutcome(isThrottleError(err)); // count 429/timeout toward tripping the breaker
    // Return empty availability rather than crashing
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
  };
}

/** Check if a campground has any available nights in a date range across all its campsites. */
export async function hasAvailabilityInRange(
  campgroundId: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,   // YYYY-MM-DD
  minNights = 1
): Promise<boolean> {
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
  for (const month of months) {
    const avail = await getAvailabilityFromRecGov(campgroundId, month);
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

  return false;
}
