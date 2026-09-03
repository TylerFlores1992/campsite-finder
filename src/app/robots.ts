import type { MetadataRoute } from 'next';
import { BASE, SITEMAP_SECTIONS } from '@/lib/sitemap-sections';

/**
 * ALL FIVE SITEMAPS ARE ADVERTISED, and the overlap is deliberate.
 *
 * `/sitemap.xml` carries every URL and is the one Search Console already has registered;
 * `/sitemaps/<section>` carries the same URLs cut into four, so coverage can be read per
 * segment instead of as one undifferentiated number. Google explicitly permits a URL to
 * appear in several sitemaps, and listing the sections here means they are discovered even
 * before anybody submits them by hand.
 *
 * DERIVED FROM `SITEMAP_SECTIONS`, never typed out. A section added to the registry and
 * forgotten here would be served, unadvertised and unsubmitted — which looks exactly like a
 * section Google chose not to crawl.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Keep private/auth/API surfaces out of the index.
      disallow: ['/api/', '/sign-in', '/sign-up', '/sms-opt-in'],
    },
    sitemap: [
      `${BASE}/sitemap.xml`,
      ...SITEMAP_SECTIONS.map((sec) => `${BASE}/sitemaps/${sec.slug}`),
    ],
    host: 'https://camphawk.app',
  };
}
