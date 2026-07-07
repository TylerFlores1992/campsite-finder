// Availability checks for ReserveCalifornia campgrounds via the RDR grid API.

import { fetchGrid, rcFacilityIdFromCampgroundId } from '@/lib/sources/reservecalifornia/client';
import type { CampgroundAvailability, CampsiteAvailability, AvailabilityDay } from '@/lib/types';

/**
 * Dates within [startDate, endDate) where at least one unit is free.
 * Returns a sorted list of YYYY-MM-DD strings. Errors return [] (best-effort,
 * matching the recgov module's behavior).
 */
export async function getRCAvailableDates(
  campgroundId: string,
  startDate: string,
  endDate: string
): Promise<string[]> {
  const facilityId = rcFacilityIdFromCampgroundId(campgroundId);
  if (!Number.isFinite(facilityId)) return [];

  try {
    const grid = await fetchGrid(facilityId, startDate, endDate);
    const open = new Set<string>();
    for (const unit of Object.values(grid.Facility?.Units ?? {})) {
      if (!unit.AllowWebBooking) continue;
      for (const slice of Object.values(unit.Slices ?? {})) {
        if (slice.IsFree && !slice.IsBlocked && slice.Date >= startDate && slice.Date < endDate) {
          open.add(slice.Date);
        }
      }
    }
    return [...open].sort();
  } catch (err) {
    console.warn(`[RC availability] Failed for ${campgroundId}:`, (err as Error).message);
    return [];
  }
}

/** True if `dates` (sorted YYYY-MM-DD) contains >= minNights consecutive days. */
export function hasConsecutiveRun(dates: string[], minNights: number): boolean {
  if (dates.length === 0) return false;
  if (minNights <= 1) return true;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`).getTime();
    const cur = new Date(`${dates[i]}T00:00:00Z`).getTime();
    run = cur - prev === 86_400_000 ? run + 1 : 1;
    if (run >= minNights) return true;
  }
  return false;
}

/**
 * True if a SINGLE unit can host `minNights` consecutive nights within
 * [startDate, endDate). Nights open at different units don't combine into
 * a bookable stay.
 */
export async function hasRCAvailabilityInRange(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<boolean> {
  const facilityId = rcFacilityIdFromCampgroundId(campgroundId);
  if (!Number.isFinite(facilityId)) return false;

  try {
    const grid = await fetchGrid(facilityId, startDate, endDate);
    for (const unit of Object.values(grid.Facility?.Units ?? {})) {
      if (!unit.AllowWebBooking) continue;
      const dates = Object.values(unit.Slices ?? {})
        .filter((s) => s.IsFree && !s.IsBlocked && s.Date >= startDate && s.Date < endDate)
        .map((s) => s.Date)
        .sort();
      if (hasConsecutiveRun(dates, minNights)) return true;
    }
  } catch (err) {
    console.warn(`[RC availability] Range check failed for ${campgroundId}:`, (err as Error).message);
  }
  return false;
}

/** Month calendar in the same shape the recgov module returns. */
export async function getRCAvailabilityForMonth(
  campgroundId: string,
  month: string // YYYY-MM
): Promise<CampgroundAvailability> {
  const facilityId = rcFacilityIdFromCampgroundId(campgroundId);
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // first of next month

  const campsites: CampsiteAvailability[] = [];
  try {
    const grid = await fetchGrid(facilityId, start, end);
    for (const unit of Object.values(grid.Facility?.Units ?? {})) {
      const days: AvailabilityDay[] = Object.values(unit.Slices ?? {})
        .map((slice) => ({
          date: slice.Date,
          status: slice.IsFree && !slice.IsBlocked ? ('available' as const) : ('reserved' as const),
          minStay: slice.MinStay ?? null,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      campsites.push({
        campsiteId: String(unit.UnitId),
        campsiteName: unit.Name || null,
        campsiteType: null,
        loop: null,
        availability: days,
      });
    }
  } catch (err) {
    console.warn(`[RC availability] Month grid failed for ${campgroundId}/${month}:`, (err as Error).message);
  }

  const availableCount = campsites.filter((cs) =>
    cs.availability.some((d) => d.status === 'available')
  ).length;

  return { campgroundId, month, campsites, availableCount };
}
