import type { MentionSource, SourceContext, SourceResult, ChecklistItem } from '../types';

/**
 * Facebook Groups — a MANUAL source, and the honesty about why is the feature.
 *
 * ## THIS IS THE BEST VENUE ON THE LIST AND THE ONE THAT CANNOT BE READ BY A PROGRAM
 *
 * Park-specific groups are where the question gets asked most often and least
 * defensively — "does anyone know how to get a spot at Big Sur, everything is booked" —
 * and unlike Reddit these communities are broadly happy to be told about a tool that works.
 * So leaving them out would mean automating the harder venue and ignoring the better one.
 *
 * ## WHY IT IS NOT AUTOMATED, STATED PLAINLY SO NOBODY "FINISHES" IT LATER
 *
 *   1. **There is no API for this.** Meta removed group-content reads from the Graph API in
 *      2024. There is no endpoint to call, with or without a token, and no amount of app
 *      review produces one.
 *   2. **The only remaining route is a logged-in scraper, which is worse than nothing.** It
 *      violates the terms; it needs the owner's own session, because group content requires
 *      membership; and the penalty falls on the ACCOUNT that holds every group membership
 *      this channel depends on. Losing that account costs more than the channel is worth,
 *      and it is not recoverable by shipping a fix.
 *   3. **The hard part was never the reading.** What makes this venue expensive is
 *      remembering to look and knowing which twelve groups and which search terms. A
 *      checklist regenerated on every run, printed beside the automatic hits, is most of the
 *      value at none of the risk.
 *
 * If a later session is tempted: the answer is still no, and `monitor.test.mts` pins that
 * this source performs no network call at all — so "just add a quick fetch here" fails the
 * build rather than quietly shipping.
 *
 * ## THE GROUP LIST IS A SEED, NOT A FINDING
 *
 * These are search URLs, not verified group ids. Facebook's group directory changes and
 * membership is per-account, so a hardcoded id would rot invisibly. A search link always
 * lands somewhere useful; a dead group id lands on an error page and looks like the monitor
 * being broken.
 */

/** Terms worth running inside a group, or across groups you have joined. */
export const FACEBOOK_SEARCH_TERMS: readonly string[] = [
  'cancellation',
  'campsite cancellation',
  'fully booked',
  'sold out',
  'how do I get a spot',
  'campnab',
];

/**
 * Where to look. Chosen for where the question gets asked, weighted to California because
 * the ReserveCalifornia hold is the thing no competitor has.
 */
export const FACEBOOK_GROUP_SEEDS: readonly { name: string; why: string }[] = [
  { name: 'California State Parks Camping', why: 'the exact audience for the RC 8am hold' },
  { name: 'ReserveCalifornia Camping Tips', why: 'people already fighting the booking window' },
  { name: 'Yosemite Camping', why: 'the hardest booking in the country, asked about daily' },
  { name: 'Big Sur Camping', why: 'small inventory, constant cancellations' },
  { name: 'California Camping', why: 'broad, high volume' },
  { name: 'RV Camping California', why: 'rig-length filters are a real differentiator here' },
  { name: 'National Park Camping Tips', why: 'the rec.gov auto-cart lane' },
  { name: 'Camping and Hiking USA', why: 'general, worth a monthly skim rather than weekly' },
];

/**
 * A Facebook search URL for a term. `/search/posts/?q=` is the surface that searches content
 * rather than group names, which is what a monitor wants — and it only returns groups the
 * signed-in person has actually joined, so the link is honest about needing a human.
 */
export function facebookPostSearchUrl(term: string): string {
  return `https://www.facebook.com/search/posts/?q=${encodeURIComponent(term)}`;
}

export function facebookGroupSearchUrl(name: string): string {
  return `https://www.facebook.com/search/groups/?q=${encodeURIComponent(name)}`;
}

export const facebookGroupsSource: MentionSource = {
  id: 'facebook-groups',
  label: 'Facebook Groups (check by hand)',
  kind: 'manual',

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetch(_ctx: SourceContext): Promise<SourceResult> {
    const checklist: ChecklistItem[] = [
      ...FACEBOOK_SEARCH_TERMS.map((t) => ({
        label: `Search your groups: "${t}"`,
        url: facebookPostSearchUrl(t),
        note: 'searches posts in groups you have joined',
      })),
      ...FACEBOOK_GROUP_SEEDS.map((g) => ({
        label: `Join / open: ${g.name}`,
        url: facebookGroupSearchUrl(g.name),
        note: g.why,
      })),
    ];

    // NEVER `candidates` — a checklist is a list of places to look, and counting it as a
    // finding would make every run report a dozen hits and mean nothing by the word.
    return { candidates: [], checklist };
  },
};
