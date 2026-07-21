// Availability adapter for GoingToCamp campgrounds. Campground ids are
// `gtc-<state>-<resourceLocationId>` (ids are negative, e.g. gtc-WA--2147483647).
// All call sites stay source-agnostic.

import { parseGoingToCampId } from '@/lib/sources/goingtocamp/providers';
import { gtcStayAvailability } from '@/lib/sources/goingtocamp/client';

export function isGoingToCampCampgroundId(campgroundId: string): boolean {
  return /^gtc-[A-Z]{2}--?\d+$/.test(campgroundId);
}

/**
 * True if one site is bookable for the whole consecutive stay.
 *
 * No per-night intersection here — unlike ReserveAmerica, the Camis API already
 * answers whole-stay, so `minNights` only matters for widening a same-day range
 * into a real one.
 *
 * DELIBERATELY THROWS on a transport failure instead of returning false, unlike
 * the other adapters. This runs in the search path on Vercel, whose IPs the Camis
 * WAF blocks with a 403 (the Fly worker and residential IPs are fine — the
 * reverse of the UseDirect situation). Search wraps these in `allSettled` and
 * renders a rejection as *unknown* availability, whereas `false` would render a
 * confident "Booked — watch it" badge on all 362 GoingToCamp campgrounds even
 * when sites are free. Unknown is honest; false is a lie.
 */
export async function hasGoingToCampAvailabilityInRange(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<boolean> {
  const parsed = parseGoingToCampId(campgroundId);
  if (!parsed) return false;
  const end = widenEnd(startDate, endDate, minNights);
  const r = await gtcStayAvailability(parsed.provider, parsed.resourceLocationId, startDate, end);
  return r.available;
}

/**
 * Like the above, but returns the bookable resource ids (for alert deep-linking).
 * This one DOES swallow errors: it runs on the Fly worker, which can reach Camis,
 * and the poller's contract is best-effort — a transient failure must not take
 * down the whole cycle.
 */
export async function findGoingToCampOpen(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<{ resourceIds: number[] } | null> {
  const parsed = parseGoingToCampId(campgroundId);
  if (!parsed) return null;
  const end = widenEnd(startDate, endDate, minNights);
  try {
    const r = await gtcStayAvailability(parsed.provider, parsed.resourceLocationId, startDate, end);
    return r.available ? { resourceIds: r.resourceIds } : null;
  } catch {
    return null;
  }
}

/** Ensure the range covers at least `minNights` nights. */
function widenEnd(startDate: string, endDate: string, minNights: number): string {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const nights = Math.round((end - start) / 86_400_000);
  if (nights >= Math.max(1, minNights)) return endDate;
  return new Date(start + Math.max(1, minNights) * 86_400_000).toISOString().slice(0, 10);
}
