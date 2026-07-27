import { query } from '@/lib/db/client';
import { normalizeStateCode } from '@/lib/coverage';

/**
 * The data behind the state landing pages.
 *
 * Kept out of the page component so the sitemap, the state index and the state
 * page all count the same way — three different definitions of "campgrounds in
 * Oregon" across three surfaces is how a site starts contradicting itself.
 *
 * NORMALISATION HAPPENS IN SQL-ADJACENT CODE, NOT IN SQL. `address->>'state'`
 * holds "Virginia", "OREGON" and " IL" alongside proper codes, so no WHERE
 * clause on that column is trustworthy. The rows are read and bucketed in JS
 * through the same normalizeStateCode the rest of the app uses. The catalog is
 * 8,013 rows — small enough that this is cheaper than it sounds, and the result
 * is cached by the page's revalidate window anyway.
 */

export interface StateCampground {
  id: string;
  name: string;
  city: string | null;
  source: string;
}

/**
 * A state page needs enough campgrounds to be worth landing on. Below this it
 * adds nothing over the campground page itself, and a wall of near-empty
 * regional pages is the shape of a doorway-page penalty. Three states are under
 * it today (HI 2, LA 1, NJ 1); their campgrounds are still in the sitemap
 * individually, so nothing becomes unreachable.
 */
export const MIN_CAMPGROUNDS_FOR_STATE_PAGE = 5;

interface Row {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  source: string;
}

async function reservableRows(): Promise<Row[]> {
  return query<Row>(
    `SELECT id, name, address->>'city' AS city, address->>'state' AS state, source
       FROM campgrounds
      WHERE reservable = true
      ORDER BY name`
  );
}

/** Campgrounds in one state, or null if the state doesn't clear the threshold. */
export async function campgroundsInState(code: string): Promise<StateCampground[] | null> {
  const rows = await reservableRows();
  const mine = rows
    .filter((r) => normalizeStateCode(r.state) === code)
    .map(({ id, name, city, source }) => ({ id, name, city, source }));
  return mine.length >= MIN_CAMPGROUNDS_FOR_STATE_PAGE ? mine : null;
}

/** Every state that qualifies for a page, with its count. */
export async function statesWithPages(): Promise<Array<{ code: string; count: number }>> {
  const rows = await reservableRows();
  const per = new Map<string, number>();
  for (const r of rows) {
    const c = normalizeStateCode(r.state);
    if (c) per.set(c, (per.get(c) ?? 0) + 1);
  }
  return [...per.entries()]
    .filter(([, n]) => n >= MIN_CAMPGROUNDS_FOR_STATE_PAGE)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Group a state's campgrounds by town.
 *
 * Grouping is what stops the page being a flat list of 875 links with no
 * structure (California). It also matches how people search — "campgrounds near
 * Bend" rather than "campgrounds in Oregon". Rows with no city fall into a
 * final bucket rather than being dropped, because dropping them would make the
 * page's own count disagree with the heading.
 */
export function groupByCity(
  list: StateCampground[]
): Array<{ city: string | null; campgrounds: StateCampground[] }> {
  const per = new Map<string, StateCampground[]>();
  const noCity: StateCampground[] = [];
  for (const c of list) {
    if (!c.city?.trim()) {
      noCity.push(c);
      continue;
    }
    const key = c.city.trim();
    per.set(key, [...(per.get(key) ?? []), c]);
  }
  const groups = [...per.entries()]
    .map(([city, campgrounds]) => ({ city: city as string | null, campgrounds }))
    .sort((a, b) => (a.city ?? '').localeCompare(b.city ?? ''));
  if (noCity.length) groups.push({ city: null, campgrounds: noCity });
  return groups;
}

/**
 * The set of states that have a landing page, memoised.
 *
 * The campground page needs this to decide whether its breadcrumb can include a
 * state rung, and that page renders per request — a full catalog scan per hit
 * would be absurd for a yes/no answer about 50 values. The answer only changes
 * on a catalog sync, so an hour-old copy is fine, and a failure returns null so
 * callers degrade to the shorter breadcrumb instead of erroring.
 */
let cachedCodes: { at: number; codes: ReadonlySet<string> } | null = null;
const CODE_TTL_MS = 60 * 60 * 1000;

export async function qualifyingStateCodes(): Promise<ReadonlySet<string> | null> {
  if (cachedCodes && Date.now() - cachedCodes.at < CODE_TTL_MS) return cachedCodes.codes;
  try {
    const codes = new Set((await statesWithPages()).map((s) => s.code));
    cachedCodes = { at: Date.now(), codes };
    return codes;
  } catch {
    return cachedCodes?.codes ?? null;
  }
}
