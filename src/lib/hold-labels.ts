import { formatStayDates } from '@/lib/notifications/dates';

/**
 * How a hold is described to its owner — shared by the claim screen and the Watches tab.
 *
 * These moved out of `ClaimFlow` when holds gained a second surface. Two copies of a date
 * formatter is how one of them silently starts naming a different night, and the dates on
 * this object are the two most misread values in the codebase: a bare ISO date parsed as a
 * timestamp, and RC's zone-less Pacific wall-clock parsed as anything at all.
 */

/**
 * "Sep 4-6 · 3 nights", not "2026-09-04".
 *
 * Same rule as the alert copy (lib/notifications/dates.ts): a bare ISO date is read as a
 * timestamp rather than a stay, and it was mis-read exactly that way in a real alert on
 * 2026-08-06. Days are stepped in UTC and re-serialised, never via `new Date(iso)` plus
 * local arithmetic — a bare date parses as midnight UTC and renders a day early for
 * everyone west of Greenwich, which on these screens would name the wrong night.
 */
export function stayLabel(arrival?: string, nights?: number): string {
  if (!arrival) return '';
  const n = Math.max(1, nights ?? 1);
  const start = Date.parse(`${arrival}T00:00:00Z`);
  if (Number.isNaN(start)) return arrival;
  const dates = Array.from({ length: n }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  return `${formatStayDates(dates)} · ${n} night${n === 1 ? '' : 's'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Fri 14 Aug, 8:00 AM PT" from RC's `release_at`.
 *
 * **`release_at` IS A ZONE-LESS PACIFIC WALL-CLOCK STRING** (`2026-08-14T08:00:00`) and the
 * standing rule in this codebase is that one is never handed to `new Date()`. Do it and the
 * browser reads it as the *viewer's* local time, so a user in Denver is told their 8am
 * California release happens at 8am Denver — an hour after it has already gone.
 *
 * So the fields are read out of the string and the zone is stated rather than converted.
 * "PT" is the honest rendering: it is the time RC opens the gate, and every alert about
 * this hold already says the same. The weekday is derived by parsing the DATE half as UTC,
 * which is exact for a calendar day and involves no offset at all.
 */
export function releaseLabel(releaseAt?: string): string {
  if (!releaseAt || releaseAt.length < 16) return '';
  const [date, time] = releaseAt.split('T');
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return releaseAt;
  const dow = new Date(Date.UTC(y, m - 1, d)).toUTCString().slice(0, 3);
  const [hhRaw, mm] = time.slice(0, 5).split(':');
  const hh = Number(hhRaw);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${dow} ${d} ${MONTHS[m - 1]}, ${h12}:${mm} ${ampm} PT`;
}
