import type { Campground } from '@/lib/types';
import { normalizeStateCode } from '@/lib/coverage';

/**
 * Per-campground SEO copy.
 *
 * THE PROBLEM THIS SOLVED FIRST: every one of the 8,013 campground pages shipped
 * the root layout's title and description, so Google saw 8,013 identical pages.
 * Duplicates get folded together and dropped, which is why none of them ranked.
 * That is fixed, and the uniqueness guards in `scripts/seo-check.mts` are what
 * keep it fixed — read them before changing any template here.
 *
 * RETARGETED AT CANCELLATION INTENT, 2026-08-25. The pages are genuinely in
 * Google's index (verified by search: /campground/233269 and /233710 both come
 * back), and in eight weeks not one organic visitor has ever created a watch —
 * every activated user traces to the owner's circle or a beta invite. So the
 * pages are crawled, and they are aimed at a query we cannot win.
 *
 * "kirk creek campground availability" is a query RECREATION.GOV OWNS. It is the
 * booking system: it has the backlinks, the freshness and the canonical answer,
 * and no amount of on-page work takes position one off it. Ranking second for a
 * query whose first result completes the user's task is worth nothing.
 *
 * The query recreation.gov has NOTHING to say about is the one that is literally
 * this product: "kirk creek campground cancellations". Someone typing that has
 * already tried to book, already failed, and is looking for exactly what we
 * sell. Low volume per page — but there are 6,934 pages, and the intent is as
 * high as intent gets.
 *
 * So the qualifier is "Cancellations", not "camping availability". Availability
 * has not been abandoned; it moved to where there is room for it — the body copy
 * in `campgroundOpeningsHeading`/`campgroundOpeningsBody`, which a title tag's
 * ~60-character budget cannot hold alongside the name and the place.
 *
 * HOW TO READ SEARCH CONSOLE — AND THE FIRST VERSION OF THIS RULE WAS WRONG.
 * It said: impressions holding steady while clicks stay at zero means the query
 * was never the problem and the snippet is. That conflates two different faults,
 * and the very first reading proved it. On 2026-08-25 the trailing 28 days were
 * **14.9K impressions, 46 clicks, CTR 0.3%, AVERAGE POSITION 49.9** — and at
 * position ~50 a CTR of 0.2-0.5% is exactly what a snippet is SUPPOSED to earn.
 * Nothing was being passed over. Almost nothing was being seen.
 *
 * So the rule needs POSITION as its first term, and it is three-way:
 *
 *   impressions, poor CTR, position > 20  -> a RANKING problem. The snippet is
 *                                            irrelevant; nobody reaches it. This
 *                                            is where we were on 2026-08-25.
 *   impressions, poor CTR, position < 10  -> a SNIPPET problem. Now the title and
 *                                            description are the lever.
 *   few impressions at any position       -> not matching the query at all: a
 *                                            content or indexing problem.
 *
 * WHICH MEANS THIS CHANGE CANNOT BE JUDGED ON CLICKS, and judging it that way
 * would retire it for the wrong reason. A retarget onto a less contested query
 * buys POSITION first; clicks are downstream of that and arrive later, if at all.
 * The metric for the next 6-10 weeks is **average position on /campground/***,
 * not clicks and not CTR. If position does not move, the query was not the
 * binding constraint — domain authority was — and the answer is links, not copy.
 */

export const SITE_NAME = 'CampHawk';
export const SITE_URL = 'https://camphawk.app';

/** Google truncates around here. Longer isn't penalised, it's just not shown. */
const DESC_MAX = 158;

/** Trim to a whole word, not mid-syllable. */
function clamp(s: string, max = DESC_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : cut.length)}…`;
}

/**
 * "Big Sur, CA".
 *
 * The state is NORMALISED. `address->>'state'` holds a mix — 190 rows say
 * "Virginia", 167 "Florida", plus "OREGON" and a stray " IL" — so raw values
 * would give one page "St. Johns, AZ" and its neighbour "Somewhere, Arizona".
 * Inconsistent place strings across 8,013 titles look automated, which is the
 * impression we least want to give. normalizeStateCode already exists for the
 * coverage copy; it returns null for DC and territories, so the trimmed raw
 * value is the fallback rather than dropping the region entirely.
 */
export function campgroundPlace(c: Campground): string {
  const raw = c.address?.state?.trim();
  const state = raw ? (normalizeStateCode(raw) ?? raw) : null;
  return [c.address?.city, state].filter(Boolean).join(', ');
}

/** The qualifier every campground title carries. See the file header for why
 *  it is this and not "camping availability". One constant, because the body
 *  copy and the state pages have to say the same word or the page reads as two
 *  documents stapled together. */
const CANCEL_QUALIFIER = 'Cancellations';

/**
 * "Kirk Creek Campground Cancellations — Big Sur, CA | CampHawk"
 *
 * Name first, because that's what gets typed and what users scan for in the
 * SERP. Some catalog names are already ALL CAPS ("CROW VALLEY"); left as-is,
 * since that's the campground's real name on the booking site and rewriting it
 * would make our result look like it's about somewhere else.
 *
 * SHORTENS BY DROPPING PARTS, NEVER BY CUTTING THE END. A plain clamp on the
 * long names ("Indian Lake State Park — Horseshoe Channel") ate the place and
 * the brand and left a trailing ellipsis, and — worse — several long names
 * truncated to the SAME string, so 43 pages collided into 17 titles. Google
 * folds duplicate titles together, which is the exact problem this function
 * exists to fix. So the parts come off in order of what we can afford to lose:
 * the place, then the qualifier, and the name and brand survive to the end.
 *
 * THE QUALIFIER IS SHORTER NOW, AND THE SIDE BENEFIT IS MEASURED — BUT IT IS NOT
 * THE ONE YOU WOULD GUESS. "Cancellations" is 13 characters against "camping
 * availability"'s 20, so seven more characters of NAME and PLACE survive the
 * ladder. Across the live catalog (7,612 visible rows, 2026-08-25) that takes
 * the share of pages keeping the full name+qualifier+place form from **37.3% to
 * 58.0%** — 1,577 more pages carrying their most specific title.
 *
 * It does NOT reduce title collisions, which was the first guess and was wrong:
 * duplicates sit at 24 pages across 12 titles either way. They come from
 * campgrounds with genuinely identical names AND identical places, which no
 * amount of qualifier budget separates. Fixing those needs a new distinguishing
 * field, not a shorter word.
 *
 * The target is a soft one. Google truncates the SERP display by pixel width,
 * not characters, and over-length costs nothing but the tail being hidden —
 * whereas a lost brand or a duplicate title costs a click or a whole page.
 */
export function campgroundTitle(c: Campground): string {
  const place = campgroundPlace(c);
  const brand = ` | ${SITE_NAME}`;
  const TARGET = 65;

  // The PLACE outranks the qualifier, because place is what distinguishes two
  // campgrounds that share a name — and there are plenty ("Rock Island State
  // Park" exists in both TN and WI). Dropping the qualifier first costs a
  // keyword; dropping the place first costs a distinct page.
  const candidates = [
    place ? `${c.name} ${CANCEL_QUALIFIER} — ${place}` : null,
    place ? `${c.name} — ${place}` : null,
    `${c.name} ${CANCEL_QUALIFIER}`,
    c.name,
  ].filter((v): v is string => v !== null);

  for (const head of candidates) {
    if (head.length + brand.length <= TARGET) return head + brand;
  }

  // Every form is still long, which means the NAME alone is long. Keep it whole
  // and accept the overflow: a hidden tail beats an ambiguous or duplicate title.
  return c.name + brand;
}

/**
 * The SERP snippet — written for the person whose booking just failed.
 *
 * IT USED TO PREFER THE PROVIDER'S OWN PROSE, and that was the right call while
 * the pages targeted "<name> availability": provider text is real, specific and
 * naturally unique, which is what the duplicate-description guard wants. It is
 * the wrong call now, and the reason is what a meta description is FOR.
 *
 * A description is not a ranking factor; it is the CTR pitch under the blue
 * link. Someone who has just been told "no sites available" and typed "kirk
 * creek campground cancellations" is scanning results for one thing: can this
 * page get me in? "Kirk Creek Campground is located on a bluff above the
 * Pacific…" is a lovely sentence that answers a question they did not ask, and
 * it is roughly what recreation.gov's own snippet already said one line above.
 *
 * So the answer leads, and the place follows it. The provider's prose is not
 * discarded — it is still the bulk of the page body, under the "About" heading,
 * where Google reads it for topical relevance and where a human who is not in a
 * hurry can read it too.
 *
 * UNIQUENESS IS CARRIED BY NAME + PLACE, and `scripts/seo-check.mts` is what
 * proves that holds across the whole catalog (it requires >95% distinct). A
 * template alone would be a duplicate-content generator, which is the exact
 * failure the file header opens with — so if that check ever drops, the fix is
 * a MORE distinguishing clause here, never a lower threshold there.
 */
export function campgroundDescription(c: Campground): string {
  const place = campgroundPlace(c);
  const where = place ? ` in ${place}` : '';
  const types = (c.siteTypes ?? []).filter(Boolean).slice(0, 2).join(' and ');

  return clamp(
    `${c.name}${where} booked solid? CampHawk rechecks it every 15 seconds and ` +
      `alerts you the moment someone cancels. ` +
      (types ? `${types} sites. ` : '') +
      `Live availability is free.`,
  );
}

/**
 * The canonical URL for a campground.
 *
 * /campground/<id> — NOT /campground/<id>. The redesign is dark-launched at
 * /v2 and noindex; when it swaps over the live routes the content lands here,
 * on this URL. Pointing the canonical at the final address now means the swap
 * doesn't move a single indexed page.
 */
export function campgroundUrl(id: string): string {
  return `${SITE_URL}/campground/${encodeURIComponent(id)}`;
}

/**
 * State landing pages.
 *
 * "Campgrounds in Oregon" is the mid-tail between a campground name and
 * "camping", and it's a query we can genuinely answer — we know every bookable
 * campground in the state and whether each one is open tonight. These pages
 * also give the campground pages an internal-linking parent, which is how link
 * equity reaches 7,000 leaf pages that nothing else points at.
 */
export function stateUrl(slug: string): string {
  return `${SITE_URL}/camping/${slug}`;
}

export function stateTitle(name: string, count: number): string {
  return `${name} Campground Cancellations — ${count.toLocaleString()} watched | ${SITE_NAME}`;
}

export function stateDescription(name: string, count: number): string {
  return clamp(
    `Every ${name} campground booked? CampHawk watches ${count.toLocaleString()} of them ` +
      `around the clock and alerts you within seconds of a cancellation. ` +
      `Live availability is free.`
  );
}

/* ------------------------------------------------------------------ body copy
 *
 * The section the retarget actually rests on.
 *
 * A title tag alone does not make a page about something. Google reads the body
 * to decide whether the page ANSWERS the query it matched, and every campground
 * page currently answers "what is this campground like" — provider prose,
 * amenities, a phone number. Nothing on 6,934 pages addresses "it is fully
 * booked, now what", which is the search we are now bidding for. A title that
 * promises cancellations over a body that never mentions them is the kind of
 * mismatch that earns a high bounce and then a lower ranking.
 *
 * These are plain functions rather than JSX so the state pages and the
 * campground pages can share the wording, and so the phrasing is testable
 * without rendering a component.
 *
 * DELIBERATELY NOT FAQPage JSON-LD. The obvious move here is to wrap this in
 * FAQ structured data and chase the "People also ask" box — but Google
 * restricted FAQ rich results to authoritative government and health sites in
 * 2023, so for us the markup buys no rich result and adds one more structured
 * claim for `scripts/seo-check.mts` to police. The prose is the whole value.
 *
 * NO NUMBER IS INVENTED HERE. "Every 15 seconds" is the poller's real interval,
 * and the auto-cart sentence appears only for sources that genuinely have it —
 * see `supportsAutoCart`. This file has a long history of confident figures that
 * turned out wrong; marketing copy is the worst place to start another one.
 */

/** "Is Kirk Creek Campground fully booked?" — the H2 a cold visitor lands on. */
export function campgroundOpeningsHeading(name: string): string {
  return `Is ${name} fully booked?`;
}

/**
 * Two short paragraphs explaining what a cancellation actually is and what we
 * do about it. `hasAutoCart` gates the third sentence rather than the caller
 * hand-writing a variant, because a page promising auto-cart on a portal the
 * bot has no account for is a promise we break — the same rule `supportsRcHold`
 * enforces on the alert side.
 */
export function campgroundOpeningsBody(
  name: string,
  place: string,
  hasAutoCart: boolean,
): readonly string[] {
  const where = place ? ` in ${place}` : '';
  return [
    `A campground showing no availability is almost never full for good. People ` +
      `cancel — plans change, weather turns, someone books three weekends and keeps ` +
      `one — and the site goes straight back into the booking system, usually ` +
      `without warning and often at odd hours. The reason sold-out campgrounds feel ` +
      `impossible is not that sites never free up; it is that nobody is watching at ` +
      `the moment they do.`,
    `CampHawk watches ${name}${where} for you. We recheck it every 15 seconds, around ` +
      `the clock, and the moment a site opens we send a text, an email and a push ` +
      `notification` +
      (hasAutoCart
        ? ` — and on Recreation.gov we can put the site straight into your cart, so ` +
          `it is held while you get to your phone.`
        : `, with a direct link to the exact site on the booking page.`),
    `Searching is free and needs no account — the calendar above is live right now. ` +
      `Watching ${name} for cancellations is the paid part.`,
  ];
}
