import type { Campground } from '@/lib/types';
import { describePlain } from '@/components/v2/richText';

/**
 * Per-campground SEO copy.
 *
 * THE PROBLEM THIS SOLVES: every one of the 8,013 campground pages shipped the
 * root layout's title and description, so Google saw 8,013 identical pages.
 * Duplicates get folded together and dropped, which is why none of them rank.
 *
 * The copy is built from the row, not from a keyword list. A campground page
 * that says "Kirk Creek Campground camping availability — Big Sur, CA" matches
 * the searches people actually type ("kirk creek campground availability") and
 * is the kind of long-tail query where we can be the best result, because we're
 * the only site that knows a booked site opened up 40 seconds ago. Stuffing
 * high-volume terms like "campsite reservations" into 8,013 pages would put us
 * up against Recreation.gov on their own turf, and lose.
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

export function campgroundPlace(c: Campground): string {
  return [c.address?.city, c.address?.state].filter(Boolean).join(', ');
}

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
 * The target is a soft one. Google truncates the SERP display by pixel width,
 * not characters, and over-length costs nothing but the tail being hidden —
 * whereas a lost brand or a duplicate title costs a click or a whole page.
 */
export function campgroundTitle(c: Campground): string {
  const place = campgroundPlace(c);
  const brand = ` | ${SITE_NAME}`;
  const TARGET = 65;

  // The PLACE outranks the "camping availability" qualifier, because place is
  // what distinguishes two campgrounds that share a name — and there are plenty
  // ("Rock Island State Park" exists in both TN and WI). Dropping the qualifier
  // first costs a keyword; dropping the place first costs a distinct page.
  const candidates = [
    place ? `${c.name} camping availability — ${place}` : null,
    place ? `${c.name} — ${place}` : null,
    `${c.name} camping availability`,
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
 * /campground/<id> — NOT /v2/campground/<id>. The redesign is dark-launched at
 * /v2 and noindex; when it swaps over the live routes the content lands here,
 * on this URL. Pointing the canonical at the final address now means the swap
 * doesn't move a single indexed page.
 */
export function campgroundUrl(id: string): string {
  return `${SITE_URL}/campground/${encodeURIComponent(id)}`;
}
