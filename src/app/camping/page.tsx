import type { Metadata } from "next";
import Link from "next/link";
import { stateName, stateSlug } from "@/lib/coverage";
import { statesWithPages } from "@/lib/stateCampgrounds";
import { SITE_NAME, SITE_URL } from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";

/**
 * /camping — the index of state pages.
 *
 * Its job is internal linking. Without a hub, the 47 state pages are only
 * reachable from the sitemap, and a sitemap tells a crawler a page EXISTS while
 * a link tells it the page MATTERS. This is also the middle rung the campground
 * breadcrumbs point through, so it has to be real and permanent.
 */

export const revalidate = 86400;

const title = `Camping by state — live campsite availability | ${SITE_NAME}`;
const description =
  "Find campgrounds with live availability in every state. See what's open tonight, and get alerted the second a booked site is cancelled.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: `${SITE_URL}/camping` },
  openGraph: { title, description, url: `${SITE_URL}/camping`, type: "website" },
};

export default async function CampingIndexPage() {
  const states = await statesWithPages();
  const rows = states
    .map(({ code, count }) => {
      const name = stateName(code);
      const slug = stateSlug(code);
      return name && slug ? { name, slug, count } : null;
    })
    .filter((r): r is { name: string; slug: string; count: number } => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const total = rows.reduce((a, r) => a + r.count, 0);

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Camping by state", item: `${SITE_URL}/camping` },
    ],
  };

  return (
    <div className="font-ch-body text-ch-ink">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumb) }}
      />
      <div className="mx-auto max-w-[var(--ch-max)] px-5 py-8">
        <nav aria-label="Breadcrumb" className="mb-4 text-ch-fine text-ch-muted">
          <Link className="font-bold text-ch-green hover:text-ch-green-deep" href="/">
            {SITE_NAME}
          </Link>
          <span className="mx-1.5">›</span>
          <span>Camping by state</span>
        </nav>

        <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          Camping by state
        </h1>
        <p className="mt-2 max-w-[70ch] text-ch-body leading-relaxed text-ch-ink-2">
          {`We track live availability at ${total.toLocaleString()} bookable campgrounds across ${rows.length} states — national forests, state parks and everything in between. Pick a state to see what we cover there.`}
        </p>

        <ul className="mt-7 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <li key={r.slug} className="flex justify-between gap-3 border-b border-ch-line py-2">
              <Link
                className="text-ch-body font-bold text-ch-ink-2 hover:text-ch-green hover:underline"
                href={`/camping/${r.slug}`}
              >
                {r.name}
              </Link>
              <span className="shrink-0 text-ch-fine text-ch-muted">
                {r.count.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
