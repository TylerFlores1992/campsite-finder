/**
 * Comparison pages — `/vs/campnab`, `/vs/campflare`.
 *
 * ## WHY THESE EXIST
 *
 * "campnab alternative" and "campflare vs" are the highest-intent queries in this category:
 * somebody typing them has already decided they want a cancellation-alert service and is
 * choosing between them. As of 2026-09-03 CampHawk had no page targeting either, so it could
 * not appear for the queries most likely to convert. This is the same absence `/auto-cart`
 * had — not a ranking problem, a page that did not exist.
 *
 * ## THE RULE THAT GOVERNS EVERY WORD ON THESE PAGES
 *
 * **We make no claim about a competitor that we have not verified, and we quote no
 * competitor's prices or features at all.**
 *
 * That is not caution for its own sake. Both campnab.com and campflare.com are unreachable
 * from the environment these pages were written in (both 000 at the proxy), so every
 * "Campnab charges X" or "Campflare doesn't do Y" would have been written from memory — and
 * a comparison table full of remembered facts about a competitor is how a marketing page
 * becomes a false-advertising problem. Their pricing and features also change without
 * telling us, so even a correct claim rots into an incorrect one on a page nobody revisits.
 *
 * So the pages compare on OUR side only: specific, checkable statements about what CampHawk
 * does, derived from constants rather than typed, next to the questions a buyer should ask
 * whoever they are considering. `src/lib/competitors.test.mts` fails the build if a price,
 * a "they don't" or a "we're cheaper" appears anywhere in the config or the renderer.
 *
 * ## AND THE PAGES SAY WHEN NOT TO BUY FROM US
 *
 * Every one carries a "you may not need us" section, and it is load-bearing rather than
 * decorative. Recreation.gov has shipped its OWN free cancellation alerts since July 2024 —
 * a buyer comparing paid tools who does not know that will find out later and feel sold to.
 * Saying it first is both true and the strongest thing on the page, because it sets up the
 * two things a free federal alert cannot do: the ten state-park systems, and carting.
 */

export interface Competitor {
  /** URL slug: /vs/<slug>. */
  slug: string;
  /** How they spell their own name. */
  name: string;
  /**
   * WHAT WE KNOW, AND NOTHING MORE. One sentence, and it must be true of any campsite
   * cancellation-alert service — i.e. it needs no research to stand behind. Anything
   * sharper than this belongs on their own site, which the page links to.
   */
  known: string;
  /** Their homepage, so a reader can check for themselves rather than take our word. */
  homepage: string;
}

export const COMPETITORS: readonly Competitor[] = [
  {
    slug: 'campnab',
    name: 'Campnab',
    known: 'Campnab watches booked campgrounds and tells you when a site is cancelled.',
    homepage: 'https://campnab.com',
  },
  {
    slug: 'campflare',
    name: 'Campflare',
    known: 'Campflare watches booked campgrounds and tells you when a site is cancelled.',
    homepage: 'https://campflare.com',
  },
];

export function competitorBySlug(slug: string): Competitor | undefined {
  return COMPETITORS.find((c) => c.slug === slug);
}

export function comparisonUrl(slug: string): string {
  return `https://camphawk.app/vs/${slug}`;
}
