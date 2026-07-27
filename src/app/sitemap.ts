import type { MetadataRoute } from 'next';
import { query } from '@/lib/db/client';
import { stateSlug } from '@/lib/coverage';
import { statesWithPages } from '@/lib/stateCampgrounds';

/**
 * Sitemap, now including every campground.
 *
 * It used to list three URLs — home, terms, privacy — while 8,013 campground
 * pages sat undiscovered. Those pages are the entire long-tail SEO case ("kirk
 * creek campground availability" is winnable; "campsite reservations" is not),
 * and Google cannot rank what it has never been told exists.
 *
 * A DB HICCUP MUST NEVER BREAK THIS. That was the original file's stated reason
 * for staying static, and it still holds: a sitemap that 500s teaches Google to
 * stop asking. The query is wrapped, and a failure degrades to exactly the old
 * three-URL sitemap rather than to an error.
 *
 * One file is enough — Google's limit is 50,000 URLs per sitemap and 8,013 is
 * comfortably inside it. If the catalog ever passes ~45k, split it with
 * generateSitemaps rather than truncating.
 *
 * `lastModified` comes from last_synced_at, which is when we last refreshed the
 * row from the provider. It's honest — genuinely when the page's content could
 * have changed — and it's what stops Google re-crawling 8,013 unchanged pages.
 */

export const revalidate = 86400; // once a day; the catalog moves slowly

const BASE = 'https://camphawk.app';

/**
 * Campground URLs point at /campground/<id>, which is now the redesigned,
 * server-rendered page. They were written this way before the swap precisely so
 * nothing would need resubmitting when it happened. See lib/seo.ts, which
 * builds the same canonical.
 */
async function campgroundEntries(): Promise<MetadataRoute.Sitemap> {
  const rows = await query<{ id: string; last_synced_at: string | null }>(
    `SELECT id, last_synced_at::text
       FROM campgrounds
      WHERE reservable = true
      ORDER BY id`
  );

  return rows.map((r) => ({
    url: `${BASE}/campground/${encodeURIComponent(r.id)}`,
    lastModified: r.last_synced_at ? new Date(r.last_synced_at) : undefined,
    changeFrequency: 'weekly' as const,
    // Below the homepage, above boilerplate — these are what we want crawled
    // after the front door.
    priority: 0.7,
  }));
}

/** State landing pages. Higher priority than a single campground: they're the
 *  hubs, and they're what carries crawl depth down to the 7,000 leaves. */
async function stateEntries(): Promise<MetadataRoute.Sitemap> {
  const states = await statesWithPages();
  return [
    { url: `${BASE}/camping`, changeFrequency: 'weekly' as const, priority: 0.8 },
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

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: 'daily', priority: 1 },
    { url: `${BASE}/search`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
  ];

  try {
    return [...staticPages, ...(await stateEntries()), ...(await campgroundEntries())];
  } catch (err) {
    console.error('[sitemap] campground query failed, serving static only:', err);
    return staticPages;
  }
}
