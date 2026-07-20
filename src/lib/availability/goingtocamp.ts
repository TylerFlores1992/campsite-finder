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
  try {
    const r = await gtcStayAvailability(parsed.provider, parsed.resourceLocationId, startDate, end);
    return r.available;
  } catch {
    return false; // best-effort, matching the other adapters
  }
}

/** Like the above, but returns the bookable resource ids (for alert deep-linking). */
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
