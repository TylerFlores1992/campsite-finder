import type { MetadataRoute } from 'next';

/**
 * Static, always-safe sitemap. Campground detail pages are indexable too, but
 * a dynamic per-campground sitemap (querying the DB) is a follow-up so a DB
 * hiccup can never break sitemap generation.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://camphawk.app';
  return [
    { url: base, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
