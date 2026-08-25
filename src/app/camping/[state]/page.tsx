import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { slugToStateCode, stateName, stateSlug } from "@/lib/coverage";
import { campgroundsInState, groupByCity, statesWithPages } from "@/lib/stateCampgrounds";
import { SITE_NAME, SITE_URL, stateDescription, stateTitle, stateUrl } from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";
import { providerLabel } from "@/components/v2/providers";
import { typesAvailableInState } from "@/lib/siteTypeHubs";

/**
 * State landing page — /camping/oregon.
 *
 * WHY THIS LIVES OUTSIDE THE (app) ROUTE GROUP. It was built during the dark
 * launch, when the rest of the redesign sat behind /v2 and noindex — everything
 * there REPLACED a live page, and shipping both would have shown users two
 * designs. A state page replaces nothing, so it had no such conflict, and
 * hiding the one thing whose entire purpose is search traffic behind noindex
 * would have been self-defeating. The /v2 prefix is long gone; the page kept its
 * own breadcrumb chrome rather than the app nav, which is why it still sits
 * outside the group.
 *
 * NOT A DOORWAY PAGE, and the distinction matters because that's a penalty.
 * A doorway is a thin page whose only content is a keyword and a link onward.
 * This one lists every bookable campground in the state, grouped by town, each
 * a real destination with its own content — the page is genuinely the answer to
 * "what can I camp at in Oregon". The MIN_CAMPGROUNDS threshold is there so we
 * never generate the thin version.
 *
 * Statically generated: the state list only changes on a catalog sync, and a
 * prerendered page is the fastest thing a crawler can be handed.
 */

export const revalidate = 86400;
export const dynamicParams = false; // an unknown slug is a 404, not a build

export async function generateStaticParams() {
  const states = await statesWithPages();
  return states
    .map(({ code }) => stateSlug(code))
    .filter((slug): slug is string => slug !== null)
    .map((state) => ({ state }));
}

async function load(slug: string) {
  const code = slugToStateCode(slug);
  if (!code) return null;
  const name = stateName(code);
  if (!name) return null;
  const campgrounds = await campgroundsInState(code);
  if (!campgrounds) return null;
  return { code, name, campgrounds };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ state: string }>;
}): Promise<Metadata> {
  const { state } = await params;
  const data = await load(state);
  if (!data) return { title: `Not found | ${SITE_NAME}` };

  const title = stateTitle(data.name, data.campgrounds.length);
  const description = stateDescription(data.name, data.campgrounds.length);
  return {
    title,
    description,
    alternates: { canonical: stateUrl(state) },
    openGraph: { title, description, url: stateUrl(state), type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function StateCampingPage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state } = await params;
  const data = await load(state);
  if (!data) notFound();

  const { name, campgrounds } = data;
  const groups = groupByCity(campgrounds);
  const towns = groups.filter((g) => g.city).length;
  const providers = [...new Set(campgrounds.map((c) => c.source))];
  const types = await typesAvailableInState(data.code);

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
      { "@type": "ListItem", position: 2, name: `${name} Campgrounds`, item: stateUrl(state) },
    ],
  };

  // CollectionPage, not ItemList of 875 entries. The list is already in the
  // markup as links; repeating it as structured data would double the page
  // weight to tell Google something it can already see.
  const collection = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${name} Campgrounds`,
    url: stateUrl(state),
    description: stateDescription(name, campgrounds.length),
    isPartOf: { "@id": `${SITE_URL}#organization` },
  };

  return (
    <div className="font-ch-body text-ch-ink">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(collection) }}
      />
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
          <span>{name}</span>
        </nav>

        {/* Inventory-first. This briefly read "Campground cancellations in
            {name}" as part of the 2026-08-25 retarget, which Search Console
            falsified the same day: this page's own queries are "camping in
            georgia", "campgrounds in wisconsin", "south carolina camping info" —
            discovery, every one — and a filter for queries containing "cancel"
            returns no data at all. See the header of lib/seo.ts. The cancellation
            promise moved to the paragraph below, where it costs no matching. */}
        <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          Campgrounds in {name}
        </h1>
        <p className="mt-2 max-w-[70ch] text-ch-body leading-relaxed text-ch-ink-2">
          {/* Interpolations are joined INSIDE the strings. JSX strips whitespace
              between an expression and the next line, which rendered this as
              "across Oregon , in 93 towns ." */}
          {`We track live availability at ${campgrounds.length.toLocaleString()} bookable campgrounds across ${name}`}
          {towns > 0 ? `, in ${towns.toLocaleString()} towns` : ""}
          {". Every one is rechecked every 15 seconds, around the clock. Booked out is rarely final — people cancel constantly, and the site drops back into the booking system with no warning, often overnight — so when one frees up you hear about it in seconds rather than finding out weeks later that it was open for an hour."}
        </p>
        <p className="mt-2 max-w-[70ch] text-ch-meta text-ch-muted">
          {`Booking goes through ${providers
            .map((p) => providerLabel(p, ""))
            .join(providers.length === 2 ? " and " : ", ")}. Searching is free.`}
        </p>

        {types.length > 0 && (
          /* Down-links to this state's accommodation-type pages. These are the
             pages the Search Console data says we can rank for, and this is the
             link that gets them crawled: /camping/california carries 725
             impressions in 28 days and the type pages carry none, because they
             did not exist until today. */
          <p className="mt-2 max-w-[70ch] text-ch-meta text-ch-muted">
            {"Looking for something specific? "}
            {types.map((h, i) => (
              <span key={h.slug}>
                {i > 0 ? (i === types.length - 1 ? " or " : ", ") : ""}
                <Link
                  href={`/camping/${h.slug}/${state}`}
                  className="font-semibold text-ch-green hover:underline"
                >
                  {`${name} ${h.label.toLowerCase()}`}
                </Link>
              </span>
            ))}
            {"."}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {/* Straight to the search screen, not the marketing home — someone on
              a state page has already decided they want to look. */}
          <Link
            href="/search"
            className="rounded-ch-chip bg-ch-green px-4 py-2 text-ch-body font-bold text-white hover:bg-ch-green-deep"
          >
            Search {name} by date
          </Link>
        </div>

        <div className="mt-8 space-y-7">
          {groups.map((g) => (
            <section key={g.city ?? "__none"}>
              <h2 className="font-ch-display text-ch-h font-bold">
                {g.city ? `${g.city}, ${data.code}` : `Elsewhere in ${name}`}
              </h2>
              <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                {g.campgrounds.map((c) => (
                  <li key={c.id} className="border-b border-ch-line py-1.5">
                    <Link
                      className="text-ch-body text-ch-ink-2 hover:text-ch-green hover:underline"
                      href={`/campground/${encodeURIComponent(c.id)}`}
                    >
                      {c.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
