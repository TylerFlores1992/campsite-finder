// Flexible-date matching (feature C). A watch/search can ask for "any N consecutive
// nights within a window" instead of one fixed range, optionally weekends-only.
//
// Two shapes, one for each kind of availability source:
//  - full-grid sources (rec.gov, ReserveCalifornia) already give us every open night,
//    so findQualifyingRun scans that set directly — near-free, exact.
//  - whole-stay sources (GoingToCamp, ReserveAmerica, TN/SC) answer one range at a
//    time, so flexCandidateStays enumerates the candidate ranges to probe (capped).

export type FlexDays = 'weekend' | null;

/** A watch's date criteria: fixed whole-stay, or flexible (nights within the window). */
export interface FlexSpec {
  /** Run length for a flexible watch; null = fixed whole-[start,end] stay (legacy). */
  nights: number | null;
  /** Day constraint. 'weekend' = the stay must include a Saturday night. */
  days: FlexDays;
}

/** UTC day of week, 0=Sun … 6=Sat. Dates are wall-clock YYYY-MM-DD, so UTC is stable. */
function dow(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

const DAY_MS = 86_400_000;

/** weekend = the run of nights includes a Saturday night (covers Fri–Sat and Sat–Sun). */
function satisfiesDays(runNights: string[], days: FlexDays): boolean {
  if (days === 'weekend') return runNights.some((d) => dow(d) === 6);
  return true;
}

function isConsecutive(run: string[]): boolean {
  for (let j = 1; j < run.length; j++) {
    if (Date.parse(`${run[j]}T00:00:00Z`) - Date.parse(`${run[j - 1]}T00:00:00Z`) !== DAY_MS) return false;
  }
  return true;
}

/**
 * Find the first run of `nights` consecutive available nights (from a set of open
 * night-dates) that satisfies the day constraint. Returns the run's night dates, or
 * null. Used by full-grid sources where we already know every open night.
 */
export function findQualifyingRun(available: Iterable<string>, nights: number, days: FlexDays): string[] | null {
  const sorted = [...new Set(available)].sort();
  for (let i = 0; i + nights <= sorted.length; i++) {
    const run = sorted.slice(i, i + nights);
    if (isConsecutive(run) && satisfiesDays(run, days)) return run;
  }
  return null;
}

/**
 * Enumerate candidate stays (arrival → checkout) to probe for a flexible watch on a
 * whole-stay source. Each is `nights` long, its arrival within [windowStart,
 * windowEnd), satisfying the day constraint. Capped so a wide window can't explode
 * into hundreds of upstream calls — a truncated list just means we check the first
 * `cap` candidates this cycle (fine: the poller runs every ~15s).
 */
export function flexCandidateStays(
  windowStart: string,
  windowEnd: string,
  nights: number,
  days: FlexDays,
  cap = 40
): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  const windowEndMs = Date.parse(`${windowEnd}T00:00:00Z`); // exclusive checkout bound
  let arrMs = Date.parse(`${windowStart}T00:00:00Z`);
  while (out.length < cap) {
    const depMs = arrMs + nights * DAY_MS;
    if (depMs > windowEndMs) break;
    const runNights: string[] = [];
    for (let k = 0; k < nights; k++) runNights.push(new Date(arrMs + k * DAY_MS).toISOString().slice(0, 10));
    if (satisfiesDays(runNights, days)) {
      out.push({ start: runNights[0], end: new Date(depMs).toISOString().slice(0, 10) });
    }
    arrMs += DAY_MS;
  }
  return out;
}

/** True if this watch is flexible (has a run length shorter than its window). */
export function isFlexible(spec: FlexSpec): boolean {
  return spec.nights != null && spec.nights > 0;
}
