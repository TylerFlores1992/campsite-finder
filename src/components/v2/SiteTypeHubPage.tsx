import Link from "next/link";
import { stateName, stateSlug } from "@/lib/coverage";
import { statesForType, type SiteTypeHub } from "@/lib/siteTypeHubs";
import { SITE_NAME, SITE_URL, siteTypeUrl } from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";

/**
 * The hub for one accommodation type — /camping/cabins and its two siblings.
 *
 * ONE COMPONENT, THREE ROUTES. The three types differ only in their config row
 * (`SITE_TYPE_HUBS`), so three copies of this markup would be three places to fix
 * every future change and two of them would get missed. Same rule that put watch
 * gating in one `WatchCta` and site muting in one `SiteMuteList`.
 *
 * A SERVER COMPONENT with no "use client": this is SEO-load-bearing prose and a
 * link graph, and these pages spent their first life shipping a loading skeleton to
 * Google because the detail view fetched in `useEffect`. Nothing here needs state.
 *
 * ITS REAL JOB IS THE LINK GRAPH. A cabin campground in Minnesota is currently one
 * of 320 links on /camping/minnesota, indistinguishable from a tent loop. This page
 * and its state children give the 1,145 cabin campgrounds a parent that is ABOUT
 * cabins, which is how a crawler learns the page is a cabin page — and how whatever
 * authority the domain has reaches them at all.
 */
export interface SiteTypeHubPageProps {
  hub: SiteTypeHub;
}

export default async function SiteTypeHubPage({ hub }: SiteTypeHubPageProps) {
  const states = await statesForType(hub.siteType);
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
      { "@type": "ListItem", position: 3, name: hub.heading, item: siteTypeUrl(hub.slug) },
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
          <Link className="font-bold text-ch-green hover:text-ch-green-deep" href="/camping">
            Camping by state
          </Link>
          <span className="mx-1.5">›</span>
          <span>{hub.heading}</span>
        </nav>

        {/* The h1 IS the query, verbatim from Search Console — see lib/seo.ts. */}
        <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          {hub.heading}
        </h1>

        <div className="mt-3 max-w-[70ch] space-y-3 text-ch-body leading-relaxed text-ch-ink-2">
          <p>{hub.blurb}</p>
          <p>
            {`We track live availability at ${total.toLocaleString()} campgrounds with ${hub.noun} across ${rows.length} states, on Recreation.gov and 13 state park systems. Every one is rechecked every 15 seconds, around the clock, so when a booked site frees up you hear about it in seconds rather than finding out weeks later that it was open for an hour.`}
          </p>
          <p className="text-ch-meta text-ch-muted">
            {"Searching live availability is free and needs no account."}
          </p>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/search"
            className="rounded-ch-chip bg-ch-green px-4 py-2 text-ch-body font-bold text-white hover:bg-ch-green-deep"
          >
            Search by date
          </Link>
        </div>

        {rows.length > 0 && (
          <div className="mt-8">
            <h2 className="font-ch-display text-ch-h font-bold">{`${hub.heading} by state`}</h2>
            <ul className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((r) => (
                <li key={r.slug} className="border-b border-ch-line py-1.5">
                  <Link
                    className="text-ch-body text-ch-ink-2 hover:text-ch-green hover:underline"
                    href={`/camping/${hub.slug}/${r.slug}`}
                  >
                    {r.name}
                  </Link>
                  <span className="ml-2 text-ch-fine text-ch-muted">{r.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-8 text-ch-meta text-ch-muted">
          {"Looking for something else? "}
          <Link href="/camping" className="font-semibold text-ch-green hover:underline">
            Browse every state
          </Link>
          {", or see "}
          <Link href="/camping/hardest-to-book" className="font-semibold text-ch-green hover:underline">
            the campgrounds that are always booked
          </Link>
          {"."}
        </p>
      </div>
    </div>
  );
}
