/**
 * WHEN DOES RESERVECALIFORNIA LET GO — a week of readings, side by side.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-release-readout.mts [--days 14]
 *
 * Reads `rc_release_readings` (migration 076), written by `scripts/rc-release-window.mts
 * --record`. One line per (release, facility), then the rules the week is read by:
 *
 *   • QUOTE A NEGATIVE BRACKET, NEVER THE MEDIAN. A facility whose bracket is entirely before
 *     T is direct evidence of early release; a median across facilities averages a proven-early
 *     bracket with undecided ones and reads as "on time".
 *   • A bracket that straddles T says nothing either way.
 *   • Facilities have flipped ATOMICALLY so far (every night in one bracket). A split is a
 *     finding and is printed as one.
 *   • Re-takes are NOT clean evidence of contention — our own cart looks the same from the
 *     grid's side.
 *   • A missing day is "not measured", never "RC released nothing". The script records no row
 *     for a run that never reached the question.
 */
import { recentReleaseReadings, type ReleaseReadingRow } from '@/lib/rc-release-readings';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const days = Math.max(1, Number(arg('days', '14')) || 14);

const num = (v: number | string | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sgn = (n: number | null) => (n == null ? '   ?   ' : `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(1)}s`);

const rows = await recentReleaseReadings(days);
console.log(`RC RELEASE READINGS — last ${days} day(s), ${rows.length} facility row(s)\n`);
if (rows.length === 0) {
  console.log('No readings recorded. Either no --record run has happened yet, or every run in the');
  console.log('window never reached the question (nothing locked, or every poll unreadable) — the');
  console.log('script records nothing for those on purpose. Check the Routine transcripts.');
  process.exit(0);
}

const byRelease = new Map<string, ReleaseReadingRow[]>();
for (const r of rows) {
  const list = byRelease.get(r.release_at) ?? [];
  list.push(r);
  byRelease.set(r.release_at, list);
}

let earlyFacilities = 0;
let splitFacilities = 0;
for (const [release, list] of byRelease) {
  console.log(`${release} PT`);
  for (const r of list) {
    const lo = num(r.bracket_lo_s);
    const hi = num(r.bracket_hi_s);
    const verdict = hi == null ? 'never freed in the window'
      : hi < 0 ? 'ENTIRELY BEFORE T'
      : lo != null && lo >= 0 ? 'entirely after T'
      : 'straddles T (undecided)';
    if (hi != null && hi < 0) earlyFacilities++;
    if (r.split_brackets > 1) splitFacilities++;
    const retake = r.nights_retaken
      ? ` · ${r.nights_retaken} re-taken, quickest ${num(r.quickest_retake_s)?.toFixed(1) ?? '?'}s (not contention evidence)`
      : '';
    const unread = r.unreadable ? ` · ${r.unreadable}/${r.polls} polls unreadable` : '';
    const split = r.split_brackets > 1 ? `  ⚠ SPLIT: ${r.split_brackets} distinct first-free instants — not atomic` : '';
    console.log(`  ${r.facility.padEnd(8)} locked ${sgn(lo)} -> free ${sgn(hi)}  (${r.nights_freed}/${r.nights_tracked} nights)  ${verdict}${retake}${unread}${split}`);
    if (r.split_brackets > 1 && Array.isArray(r.detail)) {
      for (const n of r.detail) {
        console.log(`           ${String(n.name).padEnd(10)} @${n.date}: locked ${sgn(n.lockedS)} -> free ${sgn(n.freeS)}`);
      }
    }
  }
  console.log('');
}

console.log(`${byRelease.size} release(s) measured; ${earlyFacilities} facility reading(s) with a bracket entirely before T; ${splitFacilities} non-atomic.`);
console.log('Quote a negative bracket, never a median. A straddling bracket says nothing either way.');
