import { query } from '@/lib/db/client';
import { normalizeStateCode } from '@/lib/coverage';
import { MIN_CAMPGROUNDS_FOR_STATE_PAGE, groupByCity, type StateCampground } from '@/lib/stateCampgrounds';

/**
 * Accommodation-type landing pages — /camping/cabins, /camping/group-camping,
 * /camping/yurts, each with per-state children.
 *
 * WHY THESE THREE, FROM THE DATA AND NOT FROM A BRAINSTORM. Search Console,
 * 28 days to 2026-08-25, is unusually clear about what this site can win:
 *
 *   - Five of the top 25 queries by impressions are cabin variants —
 *     "campgrounds with cabins" (35), "camp sites with cabins" (24),
 *     "camping grounds with cabins" (20), "campsites with cabins" (18),
 *     "campground with cabins" (17) — all sitting at position 66-73.
 *   - And the pages that ALREADY rank page one are, disproportionately,
 *     unusual-accommodation listings: Clear Lake SP Cabins at **8.6**, Afton
 *     State Park Wall Tent at **8.9**, a Juneau Forest Service cabin at **7.5**,
 *     Illini SP Pine Glen Youth Group at 15.6, Itasca Elk Lake Group Camp at 19.6.
 *
 * So there is demonstrated demand AND demonstrated ability to rank, which is a
 * pairing nothing else in the dataset has. Everything with real volume — "camping
 * in georgia", "ohiopyle camping" — sits at 44-87 and is not winnable at this
 * domain's authority.
 *
 * THE AXIS IS OBSCURITY, NOT SOURCE, and the Juneau cabin is what proves it. The
 * earlier reading of this was "state portals win, recreation.gov loses"; Alaska has
 * 167 rec.gov cabins and one of them ranks 7.5, because nobody has ever written
 * about a Forest Service cabin outside Juneau. Yosemite has a thousand articles and
 * we rank 70+. What we can be is the only result specific enough to answer the
 * question — Minnesota publishes one page for Afton State Park; we publish one for
 * its wall tent.
 *
 * SITE TYPES ARE SAFE TO BUILD ON, WHICH HAD TO BE CHECKED. `site_types` holds
 * exactly five normalised values (tent 4,304 / rv 3,486 / group 1,413 / cabin 1,186
 * / yurt 50) and cabin, group and yurt each appear across 8-11 of the 14 sources.
 * That matters because `showers` looked equally promising and turned out to be
 * recreation.gov-only (197 rec.gov rows, zero elsewhere), which is why it was pulled
 * from the Explore filters on 2026-08-15. A single-source facet makes a page that
 * silently excludes most of the catalog.
 *
 * TENT AND RV ARE DELIBERATELY NOT HERE. They cover 4,304 and 3,486 campgrounds —
 * so nearly every campground qualifies, the pages would be near-duplicates of the
 * state pages, and "tent camping in Oregon" is a head term owned by every outdoor
 * publisher alive. The whole thesis is specificity; a facet that matches half the
 * catalog is the opposite of it.
 */

export interface SiteTypeHub {
  /** URL segment under /camping. */
  readonly slug: string;
  /** The literal `site_types` value. Must be one of the five that exist. */
  readonly siteType: string;
  /** "Campgrounds with Cabins" — used as the h1 and the title stem. */
  readonly heading: string;
  /** Fits "<State> <label>", e.g. "Minnesota Campgrounds with Cabins". */
  readonly label: string;
  /** Plain noun for prose: "cabins", "group campsites", "yurts". */
  readonly noun: string;
  /** One sentence on what the type is and why it is hard to book. */
  readonly blurb: string;
}

export const SITE_TYPE_HUBS: readonly SiteTypeHub[] = [
  {
    slug: 'cabins',
    siteType: 'cabin',
    heading: 'Campgrounds with Cabins',
    label: 'Campgrounds with Cabins',
    noun: 'cabins',
    blurb:
      'A cabin is the hardest thing to get in most park systems: there are only ever a ' +
      'handful per campground, they book the day the window opens, and they stay booked ' +
      'through the whole season. When one comes back it is usually a cancellation, and it ' +
      'is usually gone within the hour.',
  },
  {
    slug: 'group-camping',
    siteType: 'group',
    heading: 'Group Campsites',
    label: 'Group Campsites',
    noun: 'group campsites',
    blurb:
      'Group sites are booked further ahead than anything else — reunions, scout troops ' +
      'and weddings plan a year out — and there is rarely more than one or two per ' +
      'campground. A cancellation on a group site frees up a whole weekend for a whole ' +
      'party, which is why they do not sit unclaimed for long.',
  },
  {
    slug: 'yurts',
    siteType: 'yurt',
    heading: 'Yurt Camping',
    label: 'Yurt Camping',
    noun: 'yurts',
    blurb:
      'Yurts are genuinely rare — a few dozen across the whole country — so a park that ' +
      'has one usually has exactly one. They are booked solid in season and almost never ' +
      'appear in a normal search, because there are too few of them to show up.',
  },
];

export function hubBySlug(slug: string): SiteTypeHub | null {
  return SITE_TYPE_HUBS.find((h) => h.slug === slug) ?? null;
}

interface Row {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  source: string;
}

/**
 * Every visible, reservable campground carrying this site type.
 *
 * THE PREDICATE MATCHES `stateCampgrounds.reservableRows` EXACTLY — `reservable =
 * true AND hidden = false`. Two definitions of "campgrounds in Oregon" across two
 * surfaces is how a site starts contradicting itself, and here it would be visible:
 * /camping/oregon and /camping/cabins/oregon would print different counts for
 * overlapping sets, on pages that link to each other.
 *
 * The site type IS filtered in SQL because `site_types` is a clean normalised array
 * — unlike `address->>'state'`, which holds "Virginia", "OREGON" and " IL" and is
 * therefore bucketed in JS through normalizeStateCode, exactly as the state pages do.
 */
async function rowsForType(siteType: string): Promise<Row[]> {
  return query<Row>(
    `SELECT id, name, address->>'city' AS city, address->>'state' AS state, source
       FROM campgrounds
      WHERE reservable = true AND hidden = false AND $1 = ANY(site_types)
      ORDER BY name`,
    [siteType],
  );
}

/** States that clear the threshold for this type, biggest first. */
export async function statesForType(
  siteType: string,
): Promise<Array<{ code: string; count: number }>> {
  const per = new Map<string, number>();
  for (const r of await rowsForType(siteType)) {
    const c = normalizeStateCode(r.state);
    if (c) per.set(c, (per.get(c) ?? 0) + 1);
  }
  return [...per.entries()]
    .filter(([, n]) => n >= MIN_CAMPGROUNDS_FOR_STATE_PAGE)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * One state's campgrounds of this type, or null below the threshold.
 *
 * NULL IS A 404, and that is the point of sharing the threshold with the state
 * pages: a page listing three yurts adds nothing over the three campground pages
 * themselves, and a spread of near-empty regional pages is the shape of a
 * doorway-page penalty. Yurts qualify in exactly four states (VA 16, UT 8, OR 5,
 * CA 5) and that is the rule working, not a gap to fill.
 */
export async function campgroundsOfTypeInState(
  siteType: string,
  code: string,
): Promise<StateCampground[] | null> {
  const mine = (await rowsForType(siteType))
    .filter((r) => normalizeStateCode(r.state) === code)
    .map(({ id, name, city, source }) => ({ id, name, city, source }));
  return mine.length >= MIN_CAMPGROUNDS_FOR_STATE_PAGE ? mine : null;
}

/** Total across every state that qualifies — the number the hub prints. */
export async function typeTotals(
  siteType: string,
): Promise<{ states: number; campgrounds: number }> {
  const s = await statesForType(siteType);
  return { states: s.length, campgrounds: s.reduce((a, r) => a + r.count, 0) };
}

export { groupByCity };

/**
 * Which accommodation types this state has enough of to have a page.
 *
 * Used by the plain state page to link down to its own type pages — which is the
 * link that actually matters. /camping/california carries 725 impressions in 28
 * days, the most of any page on the site; /camping/cabins/california carries none
 * because it did not exist until today. A hub linked only from /camping is one hop
 * from nothing, whereas the state pages are where the crawler already goes.
 *
 * Returns [] on a read failure rather than throwing: a catalog hiccup must degrade
 * the state page to "no type links" and never 500 it. Same posture as
 * qualifyingStateCodes.
 */
export async function typesAvailableInState(code: string): Promise<SiteTypeHub[]> {
  const out: SiteTypeHub[] = [];
  for (const hub of SITE_TYPE_HUBS) {
    try {
      if (await campgroundsOfTypeInState(hub.siteType, code)) out.push(hub);
    } catch {
      return out;
    }
  }
  return out;
}
