// Availability checks for UseDirect campgrounds (ReserveCalifornia, Arizona State
// Parks, …) via the RDR grid API. The provider is derived from the campground id
// prefix (rc-, az-), so all call sites stay source-agnostic.

import { fetchGrid, facilityIdFromCampgroundId } from '@/lib/sources/reservecalifornia/client';
import { providerByCampgroundId } from '@/lib/sources/reservecalifornia/providers';
import type { CampgroundAvailability, CampsiteAvailability, AvailabilityDay } from '@/lib/types';
import { findQualifyingRun, type FlexSpec } from '@/lib/availability/flex';

/**
 * Dates within [startDate, endDate) where at least one unit is free.
 * Returns a sorted list of YYYY-MM-DD strings. Errors return [] (best-effort).
 */
export async function getRCAvailableDates(
  campgroundId: string,
  startDate: string,
  endDate: string
): Promise<string[]> {
  const provider = providerByCampgroundId(campgroundId);
  if (!provider) return [];

  try {
    const grid = await fetchGrid(provider, facilityIdFromCampgroundId(campgroundId), startDate, endDate);
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
    console.warn(`[UseDirect availability] Failed for ${campgroundId}:`, (err as Error).message);
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
 * [startDate, endDate). Nights open at different units don't combine.
 */
export async function hasRCAvailabilityInRange(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<boolean> {
  const provider = providerByCampgroundId(campgroundId);
  if (!provider) return false;

  try {
    const grid = await fetchGrid(provider, facilityIdFromCampgroundId(campgroundId), startDate, endDate);
    for (const unit of Object.values(grid.Facility?.Units ?? {})) {
      if (!unit.AllowWebBooking) continue;
      const dates = Object.values(unit.Slices ?? {})
        .filter((s) => s.IsFree && !s.IsBlocked && s.Date >= startDate && s.Date < endDate)
        .map((s) => s.Date)
        .sort();
      if (hasConsecutiveRun(dates, minNights)) return true;
    }
  } catch (err) {
    console.warn(`[UseDirect availability] Range check failed for ${campgroundId}:`, (err as Error).message);
  }
  return false;
}

/**
 * Like hasRCAvailabilityInRange, but returns the specific open unit so an alert
 * can deep-link straight to booking it. null if nothing qualifies.
 */
export async function findRCOpenUnit(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1,
  excludeUnitIds?: string[],
  flex?: FlexSpec
): Promise<{ unitId: number; sleepingUnitId: number | null; dates: string[] } | null> {
  const provider = providerByCampgroundId(campgroundId);
  if (!provider) return null;
  const muted = new Set(excludeUnitIds ?? []);
  // Flexible: find any run of `flex.nights` (optionally weekend) within [start,end).
  // Fixed: the whole [start,end) stay (report every open night of the window).
  const flexible = flex?.nights != null && flex.nights > 0;
  const runLength = flexible ? flex!.nights! : minNights;
  try {
    const grid = await fetchGrid(provider, facilityIdFromCampgroundId(campgroundId), startDate, endDate);
    for (const unit of Object.values(grid.Facility?.Units ?? {})) {
      if (!unit.AllowWebBooking) continue;
      if (muted.has(String(unit.UnitId))) continue; // site-specific mute — skip this unit

      const dates = Object.values(unit.Slices ?? {})
        .filter((s) => s.IsFree && !s.IsBlocked && s.Date >= startDate && s.Date < endDate)
        .map((s) => s.Date)
        .sort();
      if (flexible) {
        const run = findQualifyingRun(dates, runLength, flex!.days);
        if (run) return { unitId: unit.UnitId, sleepingUnitId: unit.SleepingUnitIds?.[0] ?? null, dates: run };
      } else if (hasConsecutiveRun(dates, runLength)) {
        return { unitId: unit.UnitId, sleepingUnitId: unit.SleepingUnitIds?.[0] ?? null, dates };
      }
    }
  } catch (err) {
    console.warn(`[UseDirect availability] findRCOpenUnit failed for ${campgroundId}:`, (err as Error).message);
  }
  return null;
}

/**
 * Find a unit whose full stay is currently in UseDirect's cancelled-but-held state
 * — booked night was cancelled, and it's locked until a release time (usually 8am
 * next day). Returns the unit and that release time (`availableAt`, ISO local) so
 * we can tell the user when it goes live. A held night is: not free, not blocked,
 * no active reservation, and a Lock timestamp set.
 */
export async function findRCHeldUnit(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1
): Promise<{ unitId: number; sleepingUnitId: number | null; dates: string[]; availableAt: string } | null> {
  const provider = providerByCampgroundId(campgroundId);
  if (!provider) return null;
  try {
    const grid = await fetchGrid(provider, facilityIdFromCampgroundId(campgroundId), startDate, endDate);
    for (const unit of Object.values(grid.Facility?.Units ?? {})) {
      if (!unit.AllowWebBooking) continue;
      const held = Object.values(unit.Slices ?? {})
        .filter(
          (s) =>
            !s.IsFree &&
            !s.IsBlocked &&
            !(s.ReservationId && s.ReservationId > 0) &&
            !!s.Lock &&
            s.Date >= startDate &&
            s.Date < endDate
        )
        .sort((a, b) => a.Date.localeCompare(b.Date));
      const dates = held.map((s) => s.Date);
      if (hasConsecutiveRun(dates, minNights)) {
        const availableAt = held.reduce((max, s) => (s.Lock! > max ? s.Lock! : max), held[0].Lock!);
        return { unitId: unit.UnitId, sleepingUnitId: unit.SleepingUnitIds?.[0] ?? null, dates, availableAt };
      }
    }
  } catch (err) {
    console.warn(`[UseDirect availability] findRCHeldUnit failed for ${campgroundId}:`, (err as Error).message);
  }
  return null;
}

/** Month calendar in the same shape the recgov module returns. */
export async function getRCAvailabilityForMonth(
  campgroundId: string,
  month: string // YYYY-MM
): Promise<CampgroundAvailability> {
  const provider = providerByCampgroundId(campgroundId);
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // first of next month

  const campsites: CampsiteAvailability[] = [];
  try {
    if (!provider) throw new Error(`no UseDirect provider for ${campgroundId}`);
    const grid = await fetchGrid(provider, facilityIdFromCampgroundId(campgroundId), start, end);
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
    console.warn(`[UseDirect availability] Month grid failed for ${campgroundId}/${month}:`, (err as Error).message);
  }

  const availableCount = campsites.filter((cs) =>
    cs.availability.some((d) => d.status === 'available')
  ).length;

  return { campgroundId, month, campsites, availableCount };
}
