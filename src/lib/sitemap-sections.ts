import type { MetadataRoute } from 'next';
import { query } from '@/lib/db/client';
import { stateSlug } from '@/lib/coverage';
import { statesWithPages } from '@/lib/stateCampgrounds';
import { SITE_TYPE_HUBS, statesForType } from '@/lib/siteTypeHubs';

/**
 * The sitemap, cut into named sections — ONE definition, read by two consumers.
 *
 * ## WHY SECTIONS EXIST, AND IT IS NOT A RANKING CHANGE
 *
 * A sitemap tells Google what exists. It does not persuade Google to rank it, and nothing in
 * this file will move an average position of 49.9 — that is authority, and the pages for the
 * queries we want do not exist yet. What sections buy is a MEASUREMENT nobody currently has:
 * Search Console reports index coverage PER SUBMITTED SITEMAP, so today "7,066 submitted, N
 * indexed" is one undifferentiated number covering 6,934 campground leaves, 46 state hubs,
 * 72 accommodation-type pages and 7 static pages.
 *
 * Submit the sections and that becomes four numbers. Given the standing thesis — that we win
 * where we are the only result specific enough, and lose everywhere with volume — knowing
 * whether the 46 state hubs are indexed while the 6,934 leaves are not is exactly the datum
 * that would confirm or kill it. Right now it is unmeasured, and it has been guessed at.
 *
 * ## `/sitemap.xml` IS NOT TOUCHED, AND THAT WAS DECIDED BY MEASUREMENT
 *
 * The framework-native route is `generateSitemaps` in `app/sitemap.ts`. It was tried and the
 * build output settles it: it emits ONLY `/sitemap/<id>.xml` and produces **no
 * `/sitemap.xml` at all**. Since `robots.ts` points there and Search Console has that exact
 * URL registered, converting the existing file would have 404'd the submitted sitemap and
 * silently de-listed every one of the 7,066 URLs — with nothing red anywhere.
 *
 * So the sections are ADDITIVE. `/sitemap.xml` keeps serving everything, exactly as it does
 * today; `/sitemaps/<section>` serves the same URLs cut up. Google permits a URL to appear in
 * several sitemaps and reports coverage for each, which is the whole point.
 *
 * ## THEREFORE THE SECTIONS AND THE MAIN SITEMAP CANNOT BE ALLOWED TO DRIFT
 *
 * That overlap is only safe while both are built from the same loaders — otherwise the
 * sections quietly describe a different site from the one submitted, and the coverage numbers
 * they buy would be about pages `/sitemap.xml` never listed. Hence one module, four exported
 * loaders, and `app/sitemap.ts` composing exactly those four. `src/lib/sitemap-sections.test.mts`
 * pins that it composes ALL of them, because the failure of a partial composition is a
 * silently shortened sitemap.
 */

export const BASE = 'https://camphawk.app';

/**
 * Campground leaves. `lastModified` is `last_synced_at` — genuinely when the page's content
 * could have changed, which is what stops Google re-crawling 6,934 unchanged pages.
 */
export async function campgroundEntries(): Promise<MetadataRoute.Sitemap> {
  const rows = await query<{ id: string; last_synced_at: string | null }>(
    `SELECT id, last_synced_at::text
       FROM campgrounds
      WHERE reservable = true AND hidden = false
      ORDER BY id`
  );
  return rows.map((r) => ({
    url: `${BASE}/campground/${encodeURIComponent(r.id)}`,
    lastModified: r.last_synced_at ? new Date(r.last_synced_at) : undefined,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));
}

/** State landing pages plus the two curated hubs above them. */
export async function stateEntries(): Promise<MetadataRoute.Sitemap> {
  const states = await statesWithPages();
  return [
    { url: `${BASE}/camping`, changeFrequency: 'weekly' as const, priority: 0.8 },
    // The curated hub. Same priority as a state page rather than higher: it is an editorial
    // page, and inflating priority on the one page we wrote by hand is the kind of signal
    // Google discounts wholesale when it sees it.
    { url: `${BASE}/camping/hardest-to-book`, changeFrequency: 'monthly' as const, priority: 0.8 },
    ...states
      .map(({ code }) => stateSlug(code))
      .filter((slug): slug is string => slug !== null)
      .map((slug) => ({
        url: `${BASE}/camping/${slug}`,
        changeFrequency: 'weekly' as const,
        priority: 0.8,
      })),
  ];
}

/**
 * Accommodation-type hubs and their per-state children.
 *
 * THE STATE CHILDREN ARE ENUMERATED FROM `statesForType`, NOT FROM THE FULL STATE LIST. Only
 * states clearing MIN_CAMPGROUNDS_FOR_STATE_PAGE render; listing the rest would submit ~80
 * URLs that 404, which is the fastest way to teach Google the sitemap is unreliable.
 */
export async function siteTypeEntries(): Promise<MetadataRoute.Sitemap> {
  const out: MetadataRoute.Sitemap = [];
  for (const hub of SITE_TYPE_HUBS) {
    out.push({ url: `${BASE}/camping/${hub.slug}`, changeFrequency: 'weekly' as const, priority: 0.8 });
    for (const { code } of await statesForType(hub.siteType)) {
      const slug = stateSlug(code);
      if (!slug) continue;
      out.push({
        url: `${BASE}/camping/${hub.slug}/${slug}`,
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      });
    }
  }
  return out;
}

/** The hand-written pages. Synchronous in substance; async to match the other three. */
export async function staticEntries(): Promise<MetadataRoute.Sitemap> {
  return [
    { url: BASE, changeFrequency: 'daily', priority: 1 },
    { url: `${BASE}/search`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE}/pricing`, changeFrequency: 'weekly', priority: 0.8 },
    // THE ONE PAGE THAT EXPLAINS THE DIFFERENTIATOR, and it was in no sitemap at all until
    // 2026-09-03. Auto-cart and the ReserveCalifornia 8am hold are what separate this from
    // every alerts-only competitor — and from recreation.gov's own free cancellation alerts,
    // which have existed since July 2024 — so the page describing them being uncrawled was
    // the most expensive omission in this list. Priority with /pricing: it is bottom of
    // funnel, read by somebody deciding whether to pay.
    { url: `${BASE}/auto-cart`, changeFrequency: 'monthly', priority: 0.8 },
    // The problem-intent pages (2026-09-04). They target the query class the owner named —
    // "how to get a campsite that's sold out", "campsite cancellation alert app" — which is
    // NOT the bet falsified on 2026-08-25: that one retargeted 6,934 facility TITLES onto
    // "Cancellations", and its evidence was about which queries those pages surface against.
    // Nothing has tested a dedicated page. Priority with /auto-cart: bottom of funnel.
    { url: `${BASE}/sold-out-campsite`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/campsite-cancellation-alerts`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    // Listed so the source citation is publicly discoverable, not just linked from the store
    // descriptions. See src/lib/data-sources.ts.
    { url: `${BASE}/sources`, changeFrequency: 'monthly', priority: 0.3 },
  ];
}

/**
 * The registry. Adding a section is a line here; `app/sitemap.ts` composes every entry, and
 * the route serves each by slug, so neither can be forgotten independently.
 */
export const SITEMAP_SECTIONS = [
  { slug: 'pages', label: 'Hand-written pages', load: staticEntries },
  { slug: 'states', label: 'State landing pages', load: stateEntries },
  { slug: 'type-hubs', label: 'Accommodation-type hubs', load: siteTypeEntries },
  { slug: 'campgrounds', label: 'Campground detail pages', load: campgroundEntries },
] as const;

export type SitemapSectionSlug = (typeof SITEMAP_SECTIONS)[number]['slug'];

/** XML escaping for text inside an element. Ampersand FIRST, or the others get double-escaped. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Serialise to the sitemaps.org urlset shape.
 *
 * HAND-ROLLED BECAUSE NEXT DOES NOT EXPORT ITS SERIALISER, and the only real hazard is
 * escaping: campground ids reach the URL and `encodeURIComponent` leaves `&` alone in a
 * query-free path but not in every id we have never seen. An unescaped `&` makes the whole
 * document unparseable, so Google discards the sitemap entirely rather than one URL — which
 * is why the escaping is tested rather than eyeballed.
 */
export function toSitemapXml(entries: MetadataRoute.Sitemap): string {
  const urls = entries
    .map((e) => {
      const parts = [`    <loc>${xmlEscape(String(e.url))}</loc>`];
      if (e.lastModified) {
        const d = e.lastModified instanceof Date ? e.lastModified : new Date(e.lastModified);
        // An unparseable date is OMITTED, never emitted as "Invalid Date" — a malformed
        // <lastmod> invalidates the document, and the field is an optimisation rather than
        // information Google needs.
        if (Number.isFinite(d.getTime())) parts.push(`    <lastmod>${d.toISOString()}</lastmod>`);
      }
      if (e.changeFrequency) parts.push(`    <changefreq>${e.changeFrequency}</changefreq>`);
      if (e.priority !== undefined) parts.push(`    <priority>${e.priority}</priority>`);
      return `  <url>\n${parts.join('\n')}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
