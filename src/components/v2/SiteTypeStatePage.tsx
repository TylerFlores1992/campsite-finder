import Link from "next/link";
import { notFound } from "next/navigation";
import { stateName, stateSlug, slugToStateCode } from "@/lib/coverage";
import { campgroundsOfTypeInState, groupByCity, type SiteTypeHub } from "@/lib/siteTypeHubs";
import { providerLabel } from "./providers";
import {
  SITE_NAME,
  SITE_URL,
  siteTypeUrl,
  siteTypeStateUrl,
  siteTypeStateDescription,
} from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";

/**
 * One state's campgrounds of one accommodation type — /camping/cabins/minnesota.
 *
 * THIS is the page the whole build is actually for. The hub targets a head-ish term
 * ("Campgrounds with Cabins", currently position 71 for us) that is contested; the
 * state variant is the specific, low-competition shape this domain demonstrably
 * ranks for — the same shape as the Juneau Forest Service cabin sitting at position
 * 7.5 and the Afton wall tent at 8.9. Expect the hub to be a long shot and these to
 * be the ones that land.
 *
 * A 404 BELOW THE THRESHOLD, VIA notFound(), not a thin page with an apology on it.
 * `campgroundsOfTypeInState` returns null under MIN_CAMPGROUNDS_FOR_STATE_PAGE — the
 * same constant the plain state pages use, deliberately shared so the two surfaces
 * cannot disagree about what "enough to be worth landing on" means. A soft 404 (a
 * 200 carrying "nothing here") gets indexed as thin content rather than dropped,
 * which is worse than not existing.
 *
 * IT LINKS BACK TO THE PLAIN STATE PAGE. Somebody who wanted a cabin in Minnesota
 * and finds none free wants the other 273 Minnesota campgrounds, not a dead end —
 * and a leaf with no exits wastes the crawl it just earned.
 */
export interface SiteTypeStatePageProps {
  hub: SiteTypeHub;
  /** The `[state]` route param — a slug, not a code. */
  slug: string;
}

export default async function SiteTypeStatePage({ hub, slug }: SiteTypeStatePageProps) {
  const code = slugToStateCode(slug);
  if (!code) notFound();

  const campgrounds = await campgroundsOfTypeInState(hub.siteType, code);
  if (!campgrounds) notFound();

  const name = stateName(code);
  if (!name) notFound();

  const groups = groupByCity(campgrounds);
  const towns = groups.filter((g) => g.city).length;
  const providers = [...new Set(campgrounds.map((c) => c.source))];
  const plainStateSlug = stateSlug(code);

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Camping by state", item: `${SITE_URL}/camping` },
      { "@type": "ListItem", position: 3, name: hub.heading, item: siteTypeUrl(hub.slug) },
      { "@type": "ListItem", position: 4, name, item: siteTypeStateUrl(hub.slug, slug) },
    ],
  };

  const collection = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${name} ${hub.label}`,
    url: siteTypeStateUrl(hub.slug, slug),
    description: siteTypeStateDescription(name, hub.noun, campgrounds.length),
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
          <Link
            className="font-bold text-ch-green hover:text-ch-green-deep"
            href={`/camping/${hub.slug}`}
          >
            {hub.heading}
          </Link>
          <span className="mx-1.5">›</span>
          <span>{name}</span>
        </nav>

        <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          {`${name} ${hub.label}`}
        </h1>
        <p className="mt-2 max-w-[70ch] text-ch-body leading-relaxed text-ch-ink-2">
          {/* Interpolations joined INSIDE the strings — JSX strips whitespace between
              an expression and the next line, which rendered a sibling page as
              "across Oregon , in 93 towns ." */}
          {`We track live availability at ${campgrounds.length.toLocaleString()} campgrounds with ${hub.noun} in ${name}`}
          {towns > 0 ? `, across ${towns.toLocaleString()} towns` : ""}
          {`. ${hub.blurb}`}
        </p>
        <p className="mt-2 max-w-[70ch] text-ch-meta text-ch-muted">
          {`Booking goes through ${providers
            .map((p) => providerLabel(p, ""))
            .join(providers.length === 2 ? " and " : ", ")}. Searching is free.`}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/search"
            className="rounded-ch-chip bg-ch-green px-4 py-2 text-ch-body font-bold text-white hover:bg-ch-green-deep"
          >
            {`Search ${name} by date`}
          </Link>
        </div>

        <div className="mt-8 space-y-7">
          {groups.map((g) => (
            <section key={g.city ?? "__none"}>
              <h2 className="font-ch-display text-ch-h font-bold">
                {g.city ? `${g.city}, ${code}` : `Elsewhere in ${name}`}
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

        <p className="mt-8 text-ch-meta text-ch-muted">
          {plainStateSlug && (
            <>
              {`Nothing free? See `}
              <Link
                href={`/camping/${plainStateSlug}`}
                className="font-semibold text-ch-green hover:underline"
              >
                {`every campground we watch in ${name}`}
              </Link>
              {", or "}
            </>
          )}
          <Link
            href={`/camping/${hub.slug}`}
            className="font-semibold text-ch-green hover:underline"
          >
            {`${hub.heading} in other states`}
          </Link>
          {"."}
        </p>
      </div>
    </div>
  );
}
