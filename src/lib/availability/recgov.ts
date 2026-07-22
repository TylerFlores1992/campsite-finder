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
let recgovConsecutiveThrottles = 0;
let recgovBreakerOpenUntil = 0;

function isThrottleError(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string; message?: string };
  if (e?.response?.status === 429) return true;
  // axios aborts a timed-out request with ECONNABORTED / a "timeout" message.
  return e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '');
}

/** True while the breaker is open (skip the network call and return empty). */
function recgovBreakerOpen(): boolean {
  return Date.now() < recgovBreakerOpenUntil;
}

function recordRecgovOutcome(throttled: boolean): void {
  if (throttled) {
    recgovConsecutiveThrottles++;
    if (recgovConsecutiveThrottles >= RECGOV_BREAKER_TRIP && !recgovBreakerOpen()) {
      recgovBreakerOpenUntil = Date.now() + RECGOV_BREAKER_COOLDOWN_MS;
      console.warn(
        `[RecGov availability] throttle breaker OPEN after ${recgovConsecutiveThrottles} throttled requests — ` +
          `short-circuiting rec.gov fetches for ${RECGOV_BREAKER_COOLDOWN_MS / 1000}s`
      );
    }
  } else {
    if (recgovBreakerOpenUntil !== 0) console.log('[RecGov availability] throttle breaker CLOSED — rec.gov reachable again');
    recgovConsecutiveThrottles = 0;
    recgovBreakerOpenUntil = 0;
  }
}

export async function getAvailabilityFromRecGov(
  campgroundId: string,
  month: string // YYYY-MM
): Promise<CampgroundAvailability> {
  const startDate = `${month}-01T00:00:00.000Z`;

  // Breaker open: skip the network entirely (empty = "unknown", same as a storm).
  if (recgovBreakerOpen()) {
    return { campgroundId, month, campsites: [], availableCount: 0 };
  }

  let rawCampsites: Record<string, RecGovCampsite> = {};

  try {
    // recreation.gov rejects unencoded ':' in query params ("query not encoded"),
    // and axios's default serializer leaves ':' bare — encode the URL ourselves.
    const response = await axios.get(
      `${BASE}/${campgroundId}/month?start_date=${encodeURIComponent(startDate)}`,
      {
        timeout: 10000,
        headers: {
          // mimic the browser — this is an unofficial API
          'User-Agent': 'Mozilla/5.0 (compatible; CampsiteFinder/1.0)',
          Accept: 'application/json',
        },
      }
    );
    rawCampsites = response.data?.campsites ?? {};
    recordRecgovOutcome(false); // reachable — reset/close the breaker
  } catch (err) {
    console.warn(`[RecGov availability] Failed for ${campgroundId}/${month}:`, (err as Error).message);
    recordRecgovOutcome(isThrottleError(err)); // count 429/timeout toward tripping the breaker
    // Return empty availability rather than crashing
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
