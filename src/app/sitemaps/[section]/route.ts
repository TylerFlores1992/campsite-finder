import { SITEMAP_SECTIONS, toSitemapXml } from '@/lib/sitemap-sections';

/**
 * One sitemap per section — `/sitemaps/pages`, `/sitemaps/states`, `/sitemaps/type-hubs`,
 * `/sitemaps/campgrounds`.
 *
 * SUBMIT THESE IN SEARCH CONSOLE ALONGSIDE `/sitemap.xml`, NOT INSTEAD OF IT. Coverage is
 * reported per submitted sitemap, so four submissions turn one undifferentiated
 * "7,066 submitted, N indexed" into four numbers — which is the only way to find out whether
 * the 46 state hubs are indexed while the 6,934 leaves are not. Overlapping sitemaps are
 * explicitly permitted; a URL may appear in as many as you like.
 *
 * A ROUTE HANDLER RATHER THAN `generateSitemaps`, and the reason was measured rather than
 * assumed: `generateSitemaps` on `app/sitemap.ts` emits only `/sitemap/<id>.xml` and produces
 * **no `/sitemap.xml`**, which would have 404'd the URL `robots.ts` advertises and Search
 * Console has registered. See `lib/sitemap-sections.ts`.
 *
 * `/sitemaps/<section>` CARRIES NO FILE EXTENSION, so `middleware.ts`'s matcher does not skip
 * it — and Clerk's `auth.protect()` answers a 404, not a 401. It is therefore listed in
 * `isPublicRoute`, or this would return 404 to Googlebot while looking perfectly correct in
 * the source. Guarded in `src/lib/sitemap-sections.test.mts`, because that failure is
 * invisible until somebody checks Search Console weeks later.
 */

export const revalidate = 86400;

/** Pre-render all four rather than serving them on demand. */
export function generateStaticParams() {
  return SITEMAP_SECTIONS.map((s) => ({ section: s.slug }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ section: string }> }) {
  const { section } = await ctx.params;
  const found = SITEMAP_SECTIONS.find((s) => s.slug === section);

  // An unknown slug is a 404 and NOT an empty urlset. A valid-but-empty sitemap tells Google
  // the section genuinely has no pages, which is a claim about the site; a 404 says we do not
  // serve that name, which is the truth.
  if (!found) return new Response('Not found', { status: 404 });

  try {
    return new Response(toSitemapXml(await found.load()), {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=0, s-maxage=86400',
      },
    });
  } catch (err) {
    // A 500 is better than an empty urlset here, for the same reason: Google retries a 500
    // and BELIEVES an empty document. Silently serving zero URLs for the campgrounds section
    // is how 6,934 pages would get dropped from coverage on a DB blip.
    console.error(`[sitemaps/${section}] failed:`, err);
    return new Response('Sitemap temporarily unavailable', { status: 500 });
  }
}
