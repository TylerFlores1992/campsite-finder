import { query } from '@/lib/db/client';

/**
 * The curated "always booked" set — 26 campgrounds across 18 national parks.
 *
 * WHY THIS EXISTS, AND IT IS NOT REALLY ABOUT THIS ONE PAGE. Upper Pines is one
 * of 869 links on /camping/california. It is also, plausibly, the single
 * highest-intent leaf in the whole catalog: a person who wants a site in
 * Yosemite Valley in July and cannot get one is exactly who this product is
 * for. Right now the internal link graph treats it identically to a Forest
 * Service loop nobody has ever searched for, so whatever authority reaches the
 * state page gets divided 869 ways.
 *
 * A hub that links only to the 26 pages worth ranking concentrates that equity
 * instead of spreading it. The page also targets queries the leaves cannot —
 * "hardest campgrounds to book", "how to get a Yosemite campsite" — which are
 * mid-tail, have real volume, and are answered by editorial content rather than
 * by a booking portal.
 *
 * CURATED, NOT MEASURED, AND THE DISTINCTION IS LOAD-BEARING. We have
 * `availability_observations`, but Feature E's accrual has been stopped since
 * 2026-07-30, its buckets never covered the 4-7 day window, and 137k frozen
 * rows across 511 campgrounds cannot support a claim about which sites are
 * hardest to book nationally. Watch counts are worse — 74 rows, most of them
 * the owner's. So this list is editorial judgement about famously oversubscribed
 * national-park campgrounds, and the page says so in those words. This repo has
 * a long run of confident figures that turned out wrong; a marketing page
 * asserting a ranking we never computed would be the next one.
 *
 * IDS ARE VERIFIED AGAINST THE CATALOG, NEVER TRUSTED. Every id below was
 * resolved before being written down, and `loadHardToBook` drops any that stops
 * resolving rather than rendering a link to a 404 — catalog ids do change when
 * a provider reorganises, and a hub page full of dead links is worse than no hub
 * page. `src/lib/hardToBook.test.mts` fails if any entry goes missing, so the
 * breakage surfaces in CI instead of in Search Console three months later.
 */

export interface HardToBookEntry {
  /** Catalog id — must exist in `campgrounds` and not be hidden. */
  readonly id: string;
  /** The park, for grouping. Not in the catalog as a field, hence hardcoded. */
  readonly park: string;
  readonly state: string;
}

export const HARD_TO_BOOK: readonly HardToBookEntry[] = [
  { id: '232447', park: 'Yosemite National Park', state: 'CA' },
  { id: '232450', park: 'Yosemite National Park', state: 'CA' },
  { id: '232449', park: 'Yosemite National Park', state: 'CA' },
  { id: '232451', park: 'Yosemite National Park', state: 'CA' },
  { id: '232452', park: 'Yosemite National Park', state: 'CA' },
  { id: '232453', park: 'Yosemite National Park', state: 'CA' },
  { id: '232445', park: 'Zion National Park', state: 'UT' },
  { id: '234059', park: 'Arches National Park', state: 'UT' },
  { id: '272300', park: 'Joshua Tree National Park', state: 'CA' },
  { id: '232496', park: 'Death Valley National Park', state: 'CA' },
  { id: '232461', park: 'Sequoia & Kings Canyon National Parks', state: 'CA' },
  { id: '232460', park: 'Sequoia & Kings Canyon National Parks', state: 'CA' },
  { id: '232464', park: 'Olympic National Park', state: 'WA' },
  { id: '247592', park: 'Olympic National Park', state: 'WA' },
  { id: '232466', park: 'Mount Rainier National Park', state: 'WA' },
  { id: '258830', park: 'Grand Teton National Park', state: 'WY' },
  { id: '247571', park: 'Yellowstone National Park', state: 'WY' },
  { id: '10171274', park: 'Glacier National Park', state: 'MT' },
  { id: '232463', park: 'Rocky Mountain National Park', state: 'CO' },
  { id: '232462', park: 'Rocky Mountain National Park', state: 'CO' },
  { id: '234052', park: 'Black Canyon of the Gunnison National Park', state: 'CO' },
  { id: '232490', park: 'Grand Canyon National Park', state: 'AZ' },
  { id: '232489', park: 'Grand Canyon National Park', state: 'AZ' },
  { id: '232508', park: 'Acadia National Park', state: 'ME' },
  { id: '232507', park: 'Assateague Island National Seashore', state: 'MD' },
  { id: '232459', park: 'Shenandoah National Park', state: 'VA' },
  { id: '232487', park: 'Great Smoky Mountains National Park', state: 'TN' },
  { id: '232486', park: 'Great Smoky Mountains National Park', state: 'NC' },
];

export interface HardToBookGroup {
  readonly park: string;
  readonly campgrounds: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Resolves the list against the live catalog, grouped by park.
 *
 * A MISSING ROW IS DROPPED SILENTLY AND THAT IS THE RIGHT FAILURE DIRECTION for
 * a request path — one reorganised provider id must not 500 the page or leave a
 * dead link on it. The loud version of this lives in the test, which is where a
 * human can act on it. Same split as `qualifyingStateCodes` feeding the
 * breadcrumb: render what is real, and let CI complain about what is not.
 *
 * A whole-list failure returns `[]`, and the page treats an empty result as
 * "render nothing" rather than as "there are no hard-to-book campgrounds".
 */
export async function loadHardToBook(): Promise<HardToBookGroup[]> {
  let rows: Array<{ id: string; name: string }> = [];
  try {
    rows = await query<{ id: string; name: string }>(
      `SELECT id, name FROM campgrounds
        WHERE id = ANY($1) AND hidden IS NOT TRUE`,
      [HARD_TO_BOOK.map((e) => e.id)],
    );
  } catch {
    return [];
  }

  const byId = new Map(rows.map((r) => [r.id, r.name]));
  const groups: HardToBookGroup[] = [];

  // Park order follows the curated array, not the alphabet — Yosemite first is
  // deliberate. It is the query this page most wants to answer, and the first
  // group is what a reader sees before deciding whether to stay.
  for (const entry of HARD_TO_BOOK) {
    const name = byId.get(entry.id);
    if (!name) continue;
    const group = groups.find((g) => g.park === entry.park);
    if (group) (group.campgrounds as Array<{ id: string; name: string }>).push({ id: entry.id, name });
    else groups.push({ park: entry.park, campgrounds: [{ id: entry.id, name }] });
  }
  return groups;
}
