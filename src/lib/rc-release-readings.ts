/**
 * RC RELEASE-WINDOW READINGS (migration 076) — the persisted half of
 * `scripts/rc-release-window.mts`, so a week of daily runs can be read side by side.
 *
 * The pure part, `facilityReading`, turns one run's per-night flips into one row's worth of
 * facts. It is here rather than in the script so a test can drive it without polling RC, and
 * so the rules the script prints by are the rules the table stores by:
 *
 *   • A flip is a BRACKET. `bracket_lo_s` is the LATEST observation still locked across the
 *     facility's nights, `bracket_hi_s` the EARLIEST observation free — the tightest interval
 *     the cadence supports. Never a midpoint.
 *   • NULL is an absence. A facility that never freed has no `bracket_hi_s`; a night never
 *     seen locked inside the window contributes no `bracket_lo_s`.
 *   • A facility that did not flip atomically is reported as such (`split_brackets` > 1) and
 *     the per-night detail is what a reader turns to. So far every facility has flipped as one.
 */
import { mutate, query } from '@/lib/db/client';

export interface NightFlip {
  name: string;
  date: string;
  /** Last poll still locked, relative to T in seconds; null if never seen locked in the window. */
  lockedS: number | null;
  /** First poll free, relative to T in seconds; null if it never freed. */
  freeS: number | null;
  /** First poll booked again after being free, relative to T; null if not re-taken. */
  retakenS: number | null;
}

export interface FacilityReading {
  facility: string;
  nightsTracked: number;
  nightsFreed: number;
  nightsRetaken: number;
  bracketLoS: number | null;
  bracketHiS: number | null;
  earliestFreeS: number | null;
  latestFreeS: number | null;
  quickestRetakeS: number | null;
  splitBrackets: number;
  polls: number;
  unreadable: number;
  detail: NightFlip[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function facilityReading(
  facility: string, nights: NightFlip[], polls: number, unreadable: number,
): FacilityReading {
  const freed = nights.filter((n) => n.freeS != null);
  const lockedSeen = nights.map((n) => n.lockedS).filter((v): v is number => v != null);
  const freeS = freed.map((n) => n.freeS as number);
  const retakes = freed
    .filter((n) => n.retakenS != null)
    .map((n) => (n.retakenS as number) - (n.freeS as number));
  // Distinct first-free instants, at the cadence's own resolution (a tenth of a second).
  const distinctFree = new Set(freeS.map(r1));
  return {
    facility,
    nightsTracked: nights.length,
    nightsFreed: freed.length,
    nightsRetaken: retakes.length,
    bracketLoS: lockedSeen.length ? r1(Math.max(...lockedSeen)) : null,
    bracketHiS: freeS.length ? r1(Math.min(...freeS)) : null,
    earliestFreeS: freeS.length ? r1(Math.min(...freeS)) : null,
    latestFreeS: freeS.length ? r1(Math.max(...freeS)) : null,
    quickestRetakeS: retakes.length ? r1(Math.min(...retakes)) : null,
    splitBrackets: Math.max(1, distinctFree.size),
    polls,
    unreadable,
    detail: nights.map((n) => ({
      name: n.name, date: n.date,
      lockedS: n.lockedS == null ? null : r1(n.lockedS),
      freeS: n.freeS == null ? null : r1(n.freeS),
      retakenS: n.retakenS == null ? null : r1(n.retakenS),
    })),
  };
}

export async function recordFacilityReading(releaseAt: string, r: FacilityReading): Promise<void> {
  await mutate(
    `INSERT INTO rc_release_readings
       (release_at, facility, nights_tracked, nights_freed, nights_retaken,
        bracket_lo_s, bracket_hi_s, earliest_free_s, latest_free_s, quickest_retake_s,
        split_brackets, polls, unreadable, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      releaseAt.slice(0, 19), r.facility.slice(0, 40),
      r.nightsTracked, r.nightsFreed, r.nightsRetaken,
      r.bracketLoS, r.bracketHiS, r.earliestFreeS, r.latestFreeS, r.quickestRetakeS,
      r.splitBrackets, r.polls, r.unreadable,
      // STRINGIFIED HERE — `sqlit` interpolates, and a plain object becomes '[object Object]'.
      JSON.stringify(r.detail),
    ],
  );
}

export interface ReleaseReadingRow {
  id: number;
  run_at: string;
  release_at: string;
  facility: string;
  nights_tracked: number;
  nights_freed: number;
  nights_retaken: number;
  bracket_lo_s: number | string | null;
  bracket_hi_s: number | string | null;
  earliest_free_s: number | string | null;
  latest_free_s: number | string | null;
  quickest_retake_s: number | string | null;
  split_brackets: number;
  polls: number;
  unreadable: number;
  detail: NightFlip[] | null;
}

export async function recentReleaseReadings(days: number, limit = 500): Promise<ReleaseReadingRow[]> {
  return await query<ReleaseReadingRow>(
    `SELECT id, run_at::text, release_at, facility, nights_tracked, nights_freed, nights_retaken,
            bracket_lo_s, bracket_hi_s, earliest_free_s, latest_free_s, quickest_retake_s,
            split_brackets, polls, unreadable, detail
       FROM rc_release_readings
      WHERE run_at > NOW() - ($1 || ' days')::interval
      ORDER BY release_at ASC, facility ASC, run_at ASC
      LIMIT $2`,
    [String(Math.max(1, Math.floor(days))), limit],
  );
}
