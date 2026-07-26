/**
 * Date helpers for the redesign controls.
 *
 * THE RANGE IS TWO ISO DATE STRINGS. The handoff mockup modelled a range as
 * `{ y, m, a, b }` — one month plus two day numbers — which made a stay like
 * Aug 29 → Sep 1 literally unrepresentable, at any calendar view size. Every
 * long weekend that crosses a month boundary hit that. Two 'YYYY-MM-DD' strings
 * remove the whole class of bug and match what the API and DB already speak
 * (watches.start_date / end_date, ?startDate=&endDate=).
 *
 * EVERYTHING HERE IS LOCAL-TIME. `new Date('2026-08-30')` is parsed as UTC
 * midnight by spec, so in any negative-offset zone — including every US zone,
 * i.e. essentially all our users — it renders as the 29th. Dates are parsed
 * field-by-field into a local Date instead. Never hand an ISO date string
 * straight to the Date constructor in this codebase.
 */

/** A calendar day with no time component, as 'YYYY-MM-DD'. */
export type ISODate = string;

const pad = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD' -> local midnight Date. */
export function parseISO(iso: ISODate): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Local Date -> 'YYYY-MM-DD' (uses local fields, never toISOString). */
export function toISO(date: Date): ISODate {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(iso: ISODate, days: number): ISODate {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function addMonths(iso: ISODate, months: number): ISODate {
  const d = parseISO(iso);
  // Snap to the 1st first so adding a month to the 31st can't skip a month.
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return toISO(d);
}

export function todayISO(): ISODate {
  return toISO(new Date());
}

export function startOfMonth(iso: ISODate): ISODate {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function daysInMonth(iso: ISODate): number {
  const d = parseISO(iso);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** Weekday index (0 = Sunday) of the 1st of this month. */
export function firstDayOfWeek(iso: ISODate): number {
  const d = parseISO(iso);
  return new Date(d.getFullYear(), d.getMonth(), 1).getDay();
}

export function sameMonth(a: ISODate, b: ISODate): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** Whole days from a to b (b - a). Both local midnight, so DST can't skew it. */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86_400_000);
}

/** Nights in a check-in -> check-out stay. */
export function nightsBetween(start: ISODate, end: ISODate): number {
  return Math.max(0, daysBetween(start, end));
}

export function isBefore(a: ISODate, b: ISODate): boolean {
  return a < b; // ISO dates sort lexicographically
}

export function isWithin(day: ISODate, start: ISODate, end: ISODate): boolean {
  return day > start && day < end;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MO3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function monthLabel(iso: ISODate): string {
  const d = parseISO(iso);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Sat Aug 29" */
export function shortDate(iso: ISODate): string {
  const d = parseISO(iso);
  return `${DOW3[d.getDay()]} ${MO3[d.getMonth()]} ${d.getDate()}`;
}

/** Full label for screen readers: "Saturday, August 29, 2026" */
export function longDate(iso: ISODate): string {
  const d = parseISO(iso);
  const dow = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
  return `${dow}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Sat Aug 29 – Tue Sep 1", or "Sat Aug 29 – …" mid-selection. */
export function formatRange(start: ISODate | null, end: ISODate | null): string | null {
  if (!start) return null;
  if (!end) return `${shortDate(start)} – …`;
  return `${shortDate(start)} – ${shortDate(end)}`;
}
