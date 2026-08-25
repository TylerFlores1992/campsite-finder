import type { Campground } from '@/lib/types';
import { describePlain } from '@/components/v2/richText';
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
 * THE CANCELLATION RETARGET WAS TRIED AND FALSIFIED, 2026-08-25. Recorded in full
 * because the reasoning was sound, the bet was reasonable, and the evidence killed
 * it inside a day — and the next person to have this idea should find the answer
 * here rather than re-running it across 6,934 pages.
 *
 * THE BET: "<name> availability" is a query recreation.gov owns — it is the booking
 * system, it has the backlinks and the canonical answer — whereas "<name>
 * cancellations" is a query it has nothing to say about, and is literally this
 * product. So the qualifier was changed from "camping availability" to
 * "Cancellations" everywhere.
 *
 * WHAT KILLED IT — two readings from the same Search Console session:
 *
 *   1. Filtering all 1,000 query rows over 28 days for queries containing "cancel"
 *      returns **NO DATA**. Not few impressions — none. That is weaker than "nobody
 *      searches this" (we never ranked for it, and GSC drops very rare queries) and
 *      much stronger than "we simply do not rank yet": 6,934 pages already carried
 *      the word "cancelled" in their descriptions, and across 28 days that surfaced
 *      against exactly zero cancellation-shaped searches.
 *
 *   2. **23 of the top 25 queries by impressions contain "camping", "campground" or
 *      "campsite"** — "ohiopyle camping", "watkins glen state park camping", "camping
 *      in georgia", "campgrounds with cabins". Every impression this site gets is a
 *      DISCOVERY query. Nobody arrives having already failed to book; they arrive
 *      looking for a campground.
 *
 * So the retarget removed the single highest-frequency token in the real demand from
 * every title on the site, to chase a phrasing with no measurable demand at all. The
 * qualifier is "camping availability" again.
 *
 * WHAT WAS KEPT, AND WHY IT IS NOT A HALF-REVERT. The cancellation ANGLE is right —
 * it is what the product does and what makes it worth paying for. What was wrong was
 * spending the TITLE on it, which is the one place that has to match the query. So it
 * lives where there is room and where it costs no matching: the meta description
 * (not a ranking factor, and it is the CTR pitch once position improves) and
 * `campgroundOpeningsHeading`/`campgroundOpeningsBody`, which also happen to add ~200
 * words of real content to pages that are frequently near-empty — the highest-
 * impression page on the site, /campground/tnsc-TN-71, has ZERO photos and a ZERO
 * character description.
 *
 * DO NOT REINSTATE "Cancellations" IN THE TITLE without new evidence, and the
 * evidence that would justify it is specific: cancellation-shaped queries showing
 * real impressions in Search Console. `worker`-side there is nothing to check; this
 * is a Search Console question.
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

/** The qualifier every campground title carries — and the token that carries it is
 *  "camping", which appears in 23 of the top 25 queries by impressions. See the file
 *  header: this was briefly "Cancellations" and the change was falsified the same day.
 *  One constant, so a future edit moves every surface at once instead of one. */
const AVAILABILITY_QUALIFIER = 'camping availability';

/**
 * "Kirk Creek Campground camping availability — Big Sur, CA | CampHawk"
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
 * A SHORTER QUALIFIER WOULD FIT MORE PAGES, AND THAT IS NOT A REASON TO PICK ONE.
 * Measured on 2026-08-25: swapping in a 13-character qualifier took the share of
 * pages keeping the full name+qualifier+place form from 37.3% to 58.0%. It did NOT
 * reduce title collisions (24 pages across 12 titles either way — those are genuinely
 * duplicate name+place, which no qualifier budget separates). Worth knowing if the
 * wording ever changes again for a reason that actually holds; it was not enough to
 * justify dropping the word people search for.
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
    place ? `${c.name} ${AVAILABILITY_QUALIFIER} — ${place}` : null,
    place ? `${c.name} — ${place}` : null,
    `${c.name} ${AVAILABILITY_QUALIFIER}`,
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
 * Prefers the provider's own description, which is real prose about the place.
 * Falls back to a sentence built from the row so a campground with no
 * description still gets something specific rather than nothing — an empty meta
 * description makes Google invent one from the page, usually badly.
 *
 * IT LEADS WITH AVAILABILITY, NOT WITH "BOOKED SOLID?", AND THAT IS FROM THE DATA.
 * It briefly led with the failed-booking framing as part of the cancellation
 * retarget (see the file header for how that ended). Every query this site actually
 * receives is a DISCOVERY query — "ohiopyle camping", "camping in georgia" — from
 * somebody who has not tried to book anything yet. Opening a snippet by asking a
 * browsing user whether they are already blocked answers a question they did not ask.
 * The cancellation promise still closes the sentence, which is where it belongs.
 */
export function campgroundDescription(c: Campground): string {
  const place = campgroundPlace(c);
  const where = place ? ` in ${place}` : '';

  const provider = describePlain(c.description);
  if (provider && provider.length > 60) {
    return clamp(provider);
  }

  const types = (c.siteTypes ?? []).filter(Boolean).slice(0, 3).join(', ');
  return clamp(
    `Live campsite availability for ${c.name}${where}. ` +
      (types ? `${types} sites. ` : '') +
      `See what's open tonight, and get alerted the second a booked site is cancelled.`,
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

/** Inventory-first, because the state pages' own queries are "camping in georgia",
 *  "campgrounds in wisconsin", "south carolina camping info" — discovery, every one.
 *  /camping/california is the highest-impression page on the whole site (725 in 28
 *  days), so it is also the riskiest place to spend the title on a phrasing nobody
 *  searches. This briefly read "Campground Cancellations"; see the file header. */
export function stateTitle(name: string, count: number): string {
  return `${name} Campgrounds — ${count.toLocaleString()} with live availability | ${SITE_NAME}`;
}

export function stateDescription(name: string, count: number): string {
  return clamp(
    `Live campsite availability for ${count.toLocaleString()} campgrounds across ${name}. ` +
      `See what's open tonight, and get alerted the second a booked site is cancelled.`
  );
}

/* ------------------------------------------------- accommodation-type hubs
 *
 * /camping/cabins, /camping/group-camping, /camping/yurts and their per-state
 * children. See `lib/siteTypeHubs.ts` for why these three types and no others.
 *
 * THE HEADING IS THE EXACT QUERY, which is the whole reason these pages exist.
 * "Campgrounds with Cabins" is not a phrasing anyone chose for elegance — it is
 * verbatim the highest-impression cabin query in Search Console, with "camp sites
 * with cabins", "campsites with cabins" and "campground with cabins" as near
 * neighbours. The state variant puts the state first because that is how the state
 * queries read ("camping in georgia", "campgrounds in wisconsin").
 *
 * COUNTS GO IN THE TITLE for the same reason they do on the state pages: they make
 * every title distinct, which is what `scripts/seo-check.mts` enforces, and they are
 * true and re-derived on every build rather than written down once.
 */

export function siteTypeUrl(slug: string): string {
  return `${SITE_URL}/camping/${slug}`;
}

export function siteTypeStateUrl(slug: string, stateSlugValue: string): string {
  return `${SITE_URL}/camping/${slug}/${stateSlugValue}`;
}

export function siteTypeTitle(heading: string, campgrounds: number, states: number): string {
  return `${heading} — ${campgrounds.toLocaleString()} in ${states} states | ${SITE_NAME}`;
}

export function siteTypeDescription(noun: string, campgrounds: number, states: number): string {
  return clamp(
    `Live availability for ${campgrounds.toLocaleString()} campgrounds with ${noun} across ` +
      `${states} states. See what's open tonight, and get alerted the second a booked ` +
      `site is cancelled.`,
  );
}

export function siteTypeStateTitle(state: string, label: string, count: number): string {
  return `${state} ${label} — ${count.toLocaleString()} with live availability | ${SITE_NAME}`;
}

export function siteTypeStateDescription(state: string, noun: string, count: number): string {
  return clamp(
    `Live availability for ${count.toLocaleString()} campgrounds with ${noun} in ${state}. ` +
      `See what's open tonight, and get alerted the second a booked site is cancelled.`,
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
