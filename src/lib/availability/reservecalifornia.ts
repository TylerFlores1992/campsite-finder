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
): Promise<{ unitId: number; sleepingUnitId: number | null; dates: string[]; name: string | null } | null> {
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
        if (run) return { unitId: unit.UnitId, sleepingUnitId: unit.SleepingUnitIds?.[0] ?? null, dates: run, name: unit.Name ?? null };
      } else if (hasConsecutiveRun(dates, runLength)) {
        return { unitId: unit.UnitId, sleepingUnitId: unit.SleepingUnitIds?.[0] ?? null, dates, name: unit.Name ?? null };
      }
    }
  } catch (err) {
    console.warn(`[UseDirect availability] findRCOpenUnit failed for ${campgroundId}:`, (err as Error).message);
  }
  return null;
}

/**
 * Is this slice's `Lock` a REAL hold, or .NET's zero date?
 *
 * UseDirect serialises "no lock" as `"0001-01-01T00:00:00"` — DateTime.MinValue — not as
 * null or an empty string. So `!!s.Lock` is true for every unlocked slice in the grid.
 * Measured 2026-08-07 across 70 facilities: 5,092 slices carried a `Lock`, and **4,800 of
 * them (94%) were the zero date**. Only 292 were real.
 *
 * Left unfiltered this feeds "cancelled, opens at <time>" alerts off slices that were
 * never held, with a release time rendered from year 1. The `holdIsNewsworthy` lead-time
 * gate in the poller happens to reject them — a date in year 1 is not ≥1h in the future —
 * so this never reached a user, but that is luck, not design.
 */
function hasRealLock(lock: string | null | undefined): boolean {
  if (!lock) return false;
  const year = Number(String(lock).slice(0, 4));
  return Number.isFinite(year) && year > 2000;
}

/**
 * Which held nights of ONE unit do we claim, and when does the stay actually free?
 *
 * Pure, and exported so it can be tested without a live grid — the flex bug below lived
 * entirely in this decision, and it was invisible from the outside because the wrong
 * answer is "no held unit", which is also the correct answer almost every cycle.
 *
 * `held` must already be filtered to real held nights, sorted by date.
 */
export function heldStayRun(
  held: { Date: string; Lock?: string | null }[],
  minNights: number,
  flex?: FlexSpec
): { dates: string[]; availableAt: string } | null {
  const flexible = flex?.nights != null && flex.nights > 0;
  const runLength = flexible ? flex!.nights! : minNights;
  const dates = held.map((s) => s.Date);
  // Flexible reports the MATCHED RUN, not every held night of the window. The run is what
  // the alert names and what the hold offer carts, so reporting the whole window would
  // queue a cart for nights the user never asked for.
  const run = flexible
    ? findQualifyingRun(dates, runLength, flex!.days)
    : hasConsecutiveRun(dates, runLength) ? dates : null;
  if (!run || !run.length) return null;
  const inRun = new Set(run);
  const slices = held.filter((s) => inRun.has(s.Date));
  // The release time is the LATEST lock across the nights we are claiming — the stay is
  // not bookable until the last of them frees, and promising the earliest would send the
  // user (and the bot) at a moment when part of the stay is still locked.
  const availableAt = slices.reduce((max, s) => (s.Lock! > max ? s.Lock! : max), slices[0].Lock!);
  return { dates: run, availableAt };
}

/**
 * Find a unit whose full stay is currently in UseDirect's cancelled-but-held state
 * — booked night was cancelled, and it's locked until a release time. Returns the unit
 * and that release time (`availableAt`, ISO local) so we can tell the user when it goes
 * live. A held night is: not free, not blocked, no active reservation, and a REAL Lock
 * (see hasRealLock — most Locks in the grid are .NET's zero date).
 *
 * **The 8am rule is measured, not folklore** (2026-08-07, 70 facilities): of 292 real
 * locks, **289 released at exactly 08:00** — 99%. The other three sat minutes in the
 * future at 21:06/21:10/21:19, which is the signature of somebody's shopping-cart hold
 * rather than an overnight release. That difference is a usable discriminator: an 08:00
 * lock is a cancellation you can plan around; a lock a few minutes out is a cart that
 * will probably complete.
 *
 * TAKES `flex` FOR THE SAME REASON findRCOpenUnit DOES. Without it the caller can only
 * ask "is the WHOLE window held?", and a flexible watch's window is its whole search
 * range — "any 4 nights between Sep 4 and Sep 13" became "are all nine nights held by one
 * unit?", which never happens. Six of nine live RC watches were flexible on 2026-08-07,
 * so the coming-soon alert — and with it the 8am hold offer — could not fire for two
 * thirds of them. The run search is in-memory over one grid, so honouring flex costs
 * nothing: unlike a whole-stay source, we already have every night.
 */
export type HeldUnit = { unitId: number; sleepingUnitId: number | null; dates: string[]; availableAt: string; name: string | null };

/**
 * How many held units we will surface for one watch.
 *
 * Not unbounded: a big campground on a cancellation-heavy weekend could hold a dozen, and
 * every one we surface is a hold the user can tap — i.e. a real site the bot would take
 * off the market at 08:00. A short list is a choice; a long one is an invitation to hoard.
 */
const MAX_HELD_UNITS = 8;

/** The first held unit, for callers that only want to know whether there is one. */
export async function findRCHeldUnit(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1,
  flex?: FlexSpec
): Promise<HeldUnit | null> {
  return (await findRCHeldUnits(campgroundId, startDate, endDate, minNights, flex))[0] ?? null;
}

/**
 * EVERY unit locked for a scheduled release that covers this stay, not just the first.
 *
 * The single-unit version was what the poller used, so a campground with four sites
 * releasing at 08:00 offered the user exactly one of them — whichever happened to be
 * first in RC's grid — and the other three were invisible. On a contested morning that
 * is the difference between a choice and a lottery ticket.
 *
 * Costs nothing extra upstream: it is the same one grid fetch, read to the end instead of
 * returned from early.
 */
export async function findRCHeldUnits(
  campgroundId: string,
  startDate: string,
  endDate: string,
  minNights = 1,
  flex?: FlexSpec
): Promise<HeldUnit[]> {
  const provider = providerByCampgroundId(campgroundId);
  if (!provider) return [];
  const found: HeldUnit[] = [];
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
            hasRealLock(s.Lock) &&
            s.Date >= startDate &&
            s.Date < endDate
        )
        .sort((a, b) => a.Date.localeCompare(b.Date));
      const run = heldStayRun(held, minNights, flex);
      if (run) {
        found.push({ unitId: unit.UnitId, sleepingUnitId: unit.SleepingUnitIds?.[0] ?? null, ...run, name: unit.Name ?? null });
        if (found.length >= MAX_HELD_UNITS) break;
      }
    }
  } catch (err) {
    console.warn(`[UseDirect availability] findRCHeldUnits failed for ${campgroundId}:`, (err as Error).message);
  }
  // Soonest release first: if two units free at different times, the earlier one is the
  // one a user has least time to decide about.
  return found.sort((a, b) => a.availableAt.localeCompare(b.availableAt));
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
