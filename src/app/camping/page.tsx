import type { Metadata } from "next";
import Link from "next/link";
import { stateName, stateSlug } from "@/lib/coverage";
import { statesWithPages } from "@/lib/stateCampgrounds";
import { SITE_TYPE_HUBS } from "@/lib/siteTypeHubs";
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
        {/* Accommodation-type hubs. Above the state grid for the same reason as the
            block below: these are the pages the Search Console data says we can
            actually rank for — five of the top 25 queries are cabin variants, and the
            pages already sitting on page one are cabins, wall tents and group camps.
            See lib/siteTypeHubs.ts. */}
        <ul className="mt-4 flex flex-wrap gap-2">
          {SITE_TYPE_HUBS.map((h) => (
            <li key={h.slug}>
              <Link
                href={`/camping/${h.slug}`}
                className="inline-block rounded-ch-chip border border-ch-line bg-ch-card px-4 py-2 text-ch-body font-semibold text-ch-ink-2 hover:border-ch-green hover:text-ch-green"
              >
                {h.heading}
              </Link>
            </li>
          ))}
        </ul>

        {/* The curated hub, linked from the state index because a page nothing
            points at is a sitemap entry rather than a destination — the same
            reason this index exists for the 47 state pages. It goes ABOVE the
            state grid: it is the highest-intent page on the site, and below a
            47-row list is where links go to be ignored. */}
        <p className="mt-4 max-w-[70ch] rounded-ch-card border border-ch-line bg-ch-card p-4 text-ch-body leading-relaxed text-ch-ink-2 shadow-ch-card">
          {"Chasing somewhere that is never available? "}
          <Link
            href="/camping/hardest-to-book"
            className="font-semibold text-ch-green hover:underline"
          >
            The campgrounds that are always booked
          </Link>
          {" covers Yosemite, Zion, Acadia and 15 more parks whose sites go in minutes — and how a cancellation is the realistic way in."}
        </p>

        {/* The two problem-intent pages, linked here for the same reason as the hub above:
            a page nothing points at is a sitemap entry rather than a destination. They
            answer the query somebody types BEFORE they know a tool like this exists,
            which is a different visitor from the one browsing states. */}
        <p className="mt-3 max-w-[70ch] rounded-ch-card border border-ch-line bg-ch-card p-4 text-ch-body leading-relaxed text-ch-ink-2 shadow-ch-card">
          {"Already found it booked out? "}
          <Link href="/sold-out-campsite" className="font-semibold text-ch-green hover:underline">
            What actually works when a campground is sold out
          </Link>
          {", and "}
          <Link
            href="/campsite-cancellation-alerts"
            className="font-semibold text-ch-green hover:underline"
          >
            how campsite cancellation alerts work
          </Link>
          {" — including the free options worth checking first."}
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
