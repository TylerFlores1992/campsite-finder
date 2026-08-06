// How a stay is written in an alert.
//
// WHY THIS EXISTS (2026-08-06). An alert went out reading
//   "Site Unit 42573 open 2026-09-04, 2026-09-05, 2026-09-06"
// and the owner — who knows exactly how this product works — read it as "the site
// opens on September 4th". That is the wrong end of the message entirely: those are
// the NIGHTS you can stay, not a release time. And in the same thread sat a
// "coming soon" text saying "opens Aug 6, 8:15 AM PT", where the word genuinely did
// mean a release time.
//
// Two ISO dates in a row are also just hard to read on a phone. "Sep 4-6" is the way a
// human writes it, costs a third of the characters (which an SMS budget notices), and
// cannot be mistaken for a timestamp.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse `YYYY-MM-DD` as literal calendar parts. Deliberately NOT `new Date(s)`, which
 *  reads a bare date as UTC and then renders it in the server's zone — that is how a
 *  stay starting the 4th gets shown as the 3rd to anyone west of Greenwich. */
function parts(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const dayNumber = (p: { y: number; m: number; d: number }) => Date.UTC(p.y, p.m - 1, p.d) / 86_400_000;

/**
 * Format a set of stay nights the way a person would say them.
 *
 *   ['2026-09-04','2026-09-05','2026-09-06'] → "Sep 4-6"
 *   ['2026-09-04']                           → "Sep 4"
 *   ['2026-09-04','2026-09-06']              → "Sep 4, 6"
 *   ['2026-08-30','2026-08-31','2026-09-01'] → "Aug 30-Sep 1"
 *
 * Consecutive nights collapse into a range; gaps stay visible, because "Sep 4-6" when
 * the 5th is not actually available would send someone to book a stay that isn't there.
 * Anything unparseable is passed through untouched rather than guessed at.
 */
export function formatStayDates(dates: string[], maxGroups = 3): string {
  const parsed = dates.map(parts);
  if (!parsed.length || parsed.some((p) => p === null)) return dates.join(', ');

  const sorted = (parsed as { y: number; m: number; d: number }[])
    .slice()
    .sort((a, b) => dayNumber(a) - dayNumber(b));

  // Group consecutive days into runs.
  const runs: Array<[typeof sorted[0], typeof sorted[0]]> = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && dayNumber(p) === dayNumber(last[1]) + 1) last[1] = p;
    else if (!last || dayNumber(p) !== dayNumber(last[1])) runs.push([p, p]);
  }

  const shown = runs.slice(0, maxGroups).map(([a, b]) => {
    if (dayNumber(a) === dayNumber(b)) return `${MONTHS[a.m - 1]} ${a.d}`;
    // Only repeat the month when the run crosses one.
    return a.m === b.m
      ? `${MONTHS[a.m - 1]} ${a.d}-${b.d}`
      : `${MONTHS[a.m - 1]} ${a.d}-${MONTHS[b.m - 1]} ${b.d}`;
  });
  const more = runs.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` +${more} more` : '');
}
