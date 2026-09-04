import type { MetadataRoute } from 'next';
import { BASE, SITEMAP_SECTIONS, staticEntries } from '@/lib/sitemap-sections';

/**
 * The whole sitemap, at `/sitemap.xml` — every URL, in one document.
 *
 * It used to list three URLs — home, terms, privacy — while 8,013 campground pages sat
 * undiscovered. Those pages are the entire long-tail case ("kirk creek campground
 * availability" is winnable; "campsite reservations" is not), and Google cannot rank what it
 * has never been told exists.
 *
 * A DB HICCUP MUST NEVER BREAK THIS. That was the original file's stated reason for staying
 * static and it still holds: a sitemap that 500s teaches Google to stop asking. The loaders
 * are wrapped, and a failure degrades to the hand-written pages rather than to an error.
 *
 * ONE FILE IS STILL RIGHT HERE. Google's limit is 50,000 URLs per sitemap and 7,066 is
 * comfortably inside it. The per-section sitemaps at `/sitemaps/<slug>` are NOT a split of
 * this one — they are the same URLs served again, additively, so Search Console can report
 * index coverage per segment. See `lib/sitemap-sections.ts` for why that is a measurement
 * rather than a ranking change, and for the build output showing that converting this file to
 * `generateSitemaps` would have deleted `/sitemap.xml` entirely.
 *
 * THE COMPOSITION IS OVER THE REGISTRY, NOT A HAND-WRITTEN LIST. A section added to
 * `SITEMAP_SECTIONS` and forgotten here would serve at `/sitemaps/<slug>` while being absent
 * from the sitemap actually submitted — two documents disagreeing about what the site is,
 * which is precisely what makes the per-segment numbers meaningless.
 */

export const revalidate = 86400; // once a day; the catalog moves slowly

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const sections = await Promise.all(SITEMAP_SECTIONS.map((s) => s.load()));
    return sections.flat();
  } catch (err) {
    console.error('[sitemap] section query failed, serving static only:', err);
    return staticEntries();
  }
}

// Re-exported so nothing else has to reach past this file for the canonical origin.
export { BASE };
