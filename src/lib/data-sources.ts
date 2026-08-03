/**
 * Where CampHawk's campground and availability data comes from — one list, used by
 * the public /sources page and quoted in the store listings.
 *
 * WHY THIS EXISTS: Google Play REJECTED the Android listing on 2026-08-03 under the
 * Misleading Claims policy — "Missing Source Link for Government Information". An app
 * that surfaces government information must name a clear, official, functional source
 * for it and carry an obvious disclaimer that it does not represent the government.
 * The disclaimer was already in the description but buried in the last paragraph, and
 * there were no source URLs anywhere. This file is the source list; `/sources` is the
 * accessible page; the store description links to it.
 *
 * RULES FOR EDITING:
 *  - Every `url` must be the OFFICIAL reservation portal or agency site for that data,
 *    reachable and not a redirect chain. A dead link here is the exact violation.
 *  - This must stay in step with `src/lib/sources/` — one entry per `campgrounds.source`
 *    value. If a sync adapter is added, add it here in the same change, or the app is
 *    shipping government data with no cited source again.
 *  - Do NOT claim any of these agencies endorse or are affiliated with CampHawk.
 */

export interface DataSource {
  /** Matches `campgrounds.source` so the two lists can be diffed. */
  key: string;
  /** The agency or system that publishes the data. */
  name: string;
  /** The official portal. This is the link the policy requires. */
  url: string;
  /** Which states this source covers, for the reader. */
  coverage: string;
}

/**
 * Ordered by how much of the catalog each one supplies, so the federal source —
 * which is most of it, and the one a reviewer is looking for — reads first.
 * Verified against production 2026-08-03: 14 sources, 8,013 campgrounds.
 */
export const DATA_SOURCES: DataSource[] = [
  {
    key: 'ridb',
    name: 'Recreation.gov (U.S. federal recreation agencies)',
    url: 'https://www.recreation.gov',
    coverage: 'All 50 states — National Park Service, U.S. Forest Service, Bureau of Land Management, U.S. Army Corps of Engineers and other federal agencies',
  },
  {
    key: 'reserveamerica',
    name: 'ReserveAmerica state park reservations',
    url: 'https://www.reserveamerica.com',
    coverage: 'AK, CT, DE, GA, IA, IN, KY, MT, NC, NE, NH, NM, NY, OR, PA, RI, TX, UT',
  },
  {
    key: 'ohiostateparks',
    name: 'Ohio State Parks (ReserveOhio)',
    url: 'https://reserveohio.com',
    coverage: 'Ohio',
  },
  {
    key: 'reservecalifornia',
    name: 'California State Parks (ReserveCalifornia)',
    url: 'https://www.reservecalifornia.com',
    coverage: 'California',
  },
  {
    key: 'goingtocamp',
    name: 'Michigan DNR, Mississippi MDWFP, Washington and Wisconsin State Parks',
    url: 'https://midnrreservations.com',
    coverage: 'MI, MS, WA, WI',
  },
  {
    key: 'minnesotastateparks',
    name: 'Minnesota State Parks (Reserve MN)',
    url: 'https://reservemn.usedirect.com',
    coverage: 'Minnesota',
  },
  {
    key: 'illinoisstateparks',
    name: 'Illinois State Parks (Explore More Illinois)',
    url: 'https://recreation.exploremoreil.com',
    coverage: 'Illinois',
  },
  {
    key: 'virginiastateparks',
    name: 'Virginia State Parks (Reserve VA Parks)',
    url: 'https://www.reservevaparks.com',
    coverage: 'Virginia',
  },
  {
    key: 'floridastateparks',
    name: 'Florida State Parks',
    url: 'https://reserve.floridastateparks.org',
    coverage: 'Florida',
  },
  {
    key: 'missouristateparks',
    name: 'Missouri State Parks (Camp MO)',
    url: 'https://icampmo1.usedirect.com',
    coverage: 'Missouri',
  },
  {
    key: 'wyomingstateparks',
    name: 'Wyoming State Parks',
    url: 'https://reserve.wyoming.gov',
    coverage: 'Wyoming',
  },
  {
    key: 'nevadastateparks',
    name: 'Nevada State Parks (Reserve Nevada)',
    url: 'https://www.reservenevada.com',
    coverage: 'Nevada',
  },
  {
    key: 'tnsc',
    name: 'Tennessee State Parks and South Carolina State Parks',
    url: 'https://reserve.tnstateparks.com',
    coverage: 'TN, SC',
  },
  {
    key: 'arizonastateparks',
    name: 'Arizona State Parks & Trails',
    url: 'https://azstateparks.com/reserve/',
    coverage: 'Arizona',
  },
];

/** Second portal for the two sources that serve more than one state from one adapter. */
export const ADDITIONAL_PORTALS: Array<{ name: string; url: string }> = [
  { name: 'South Carolina State Parks', url: 'https://reserve.southcarolinaparks.com' },
  { name: 'Mississippi MDWFP', url: 'https://reserve.mdwfp.com' },
  { name: 'Washington State Parks', url: 'https://washington.goingtocamp.com' },
  { name: 'Wisconsin State Parks', url: 'https://wisconsin.goingtocamp.com' },
  { name: 'Recreation Information Database (RIDB), the federal open-data API', url: 'https://ridb.recreation.gov' },
];

/**
 * The non-affiliation disclaimer, in ONE place so the page, the Play listing and the
 * App Store listing cannot drift into saying different things. Google requires it to
 * be easy to see — in the listing it belongs at the TOP, not the last paragraph.
 */
export const AFFILIATION_DISCLAIMER =
  'CampHawk is an independent app and does not represent any government entity. ' +
  'It is not affiliated with, endorsed by, or authorized by Recreation.gov, the ' +
  'National Park Service, the U.S. Forest Service, the Bureau of Land Management, ' +
  'the U.S. Army Corps of Engineers, or any state park agency. All campground ' +
  'information and availability shown in CampHawk comes from the official sources ' +
  'listed below, and every booking is completed on the official reservation site.';
