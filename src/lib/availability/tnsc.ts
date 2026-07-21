// Availability adapter for Tennessee / South Carolina State Parks campgrounds.
// Campground ids are `tnsc-<ST>-<parkId>` (e.g. tnsc-TN-25). All call sites stay
// source-agnostic.
//
// The underlying portal call is BATCHED — one POST answers every park for a date
// range (see sources/tnsc/client.ts). The per-campground helpers below ride that
// shared, cached batch, so many watches on the same range collapse to one request.

import { parseTnscId } from '@/lib/sources/tnsc/providers';
import { tnscStayAvailability } from '@/lib/sources/tnsc/client';

export function isTnscCampgroundId(campgroundId: string): boolean {
  return /^tnsc-[A-Z]{2}-\d+$/.test(campgroundId);
}

/** Ensure the range covers at least `minNights` nights. */
function widenEnd(startDate: string, endDate: string, minNights: number): string {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const nights = Math.round((end - start) / 86_400_000);
  if (nights >= Math.max(1, minNights)) return endDate;
  return new Date(start + Math.max(1, minNights) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * True if a campsite is bookable for the whole consecutive stay.
 *
 * DELIBERATELY THROWS on a transport failure rather than returning false — this
 * runs in the search path, where `Promise.allSettled` renders a rejection as
 * *unknown* availability. A `false` here would stamp a confident "Booked — watch
 * it" badge on every TN/SC campground even when sites are free. Same contract as
 * the GoingToCamp search adapter.
 *
 * NOTE: whether this env can reach the portal at all is UNVERIFIED from a
 * datacenter IP (see client.ts) — this is why the search path may need to route
 * through the Fly worker like GoingToCamp does. Wire that only after the
 * reachability test.
 */
export async function hasTnscAvailabilityInRange(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<boolean> {
  const parsed = parseTnscId(campgroundId);
  if (!parsed) return false;
  const end = widenEnd(startDate, endDate, minNights);
  const r = await tnscStayAvailability(parsed.provider, parsed.parkId, startDate, end);
  return r.available;
}

/**
 * Like the above, but for the poller: returns the open-site count when there's an
 * opening, else null. Swallows errors — the poller is best-effort and one park's
 * transient failure must not take down the cycle.
 *
 * There are no per-site ids to return (the portal reports counts, not siteIds), so
 * alerts for this source are park+date, not deep-linked to a specific site.
 */
export async function findTnscOpen(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<{ availableSites: number } | null> {
  const parsed = parseTnscId(campgroundId);
  if (!parsed) return null;
  const end = widenEnd(startDate, endDate, minNights);
  try {
    const r = await tnscStayAvailability(parsed.provider, parsed.parkId, startDate, end);
    return r.available ? { availableSites: r.availableSites } : null;
  } catch (err) {
    // Log (don't rethrow) — the poller is best-effort. Matches the ReserveAmerica
    // adapter's pattern so a worker-side reachability/CSRF failure is visible in
    // flyctl logs instead of silently never alerting.
    console.warn(`[TNSC] availability failed for ${campgroundId}:`, (err as Error).message);
    return null;
  }
}
