import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Keep private/auth/API surfaces out of the index.
      disallow: ['/api/', '/sign-in', '/sign-up', '/sms-opt-in'],
    },
    sitemap: 'https://camphawk.app/sitemap.xml',
    host: 'https://camphawk.app',
  };
}
