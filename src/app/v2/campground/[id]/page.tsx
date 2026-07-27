import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CampgroundDetail from "@/components/v2/CampgroundDetail";
import { ridbSource } from "@/lib/sources/ridb";
import { normalizeStateCode, stateName, stateSlug } from "@/lib/coverage";
import { qualifyingStateCodes } from "@/lib/stateCampgrounds";
import {
  campgroundDescription,
  campgroundTitle,
  campgroundUrl,
  SITE_NAME,
} from "@/lib/seo";
import {
  campgroundBreadcrumbJsonLd,
  campgroundJsonLd,
  jsonLdScript,
} from "@/lib/jsonld";

/**
 * Campground detail. A drill-in from a search result or a watch — deliberately
 * not a fourth nav destination, since "a campground" means nothing unchosen.
 *
 * SERVER-RENDERED, which it wasn't before. The old version was a client
 * component that fetched in useEffect, so the HTML a crawler received was a
 * loading skeleton — no name, no description, no location. Google executes JS,
 * but that's a deferred second-wave crawl that ranks far worse than real HTML.
 * The row is loaded here and handed down, so the page arrives complete.
 *
 * `params` and `searchParams` are promises in this Next version; awaiting them
 * here is fine because it's a page, not the root layout. (A request-time API in
 * the ROOT layout throws under Cache Components and 500s the whole site.)
 *
 * Note this route reads searchParams, so it renders per-request rather than
 * being prerendered. That costs nothing for SEO — a crawler gets identical,
 * complete HTML either way — and ridbSource.getDetail is cached for an hour, so
 * the DB isn't hit per request.
 */

/** Loaded twice per request (metadata + page); getDetail's own cache absorbs it. */
async function loadCampground(id: string) {
  try {
    return await ridbSource.getDetail(id);
  } catch {
    // A catalog hiccup must not 500 the page. Returning null lets the client
    // component fall back to its own /api/campgrounds/<id> fetch.
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const campground = await loadCampground(id);

  // No row: give the 404 its own title rather than letting it inherit the
  // marketing one, which would put "Get notified the instant a campsite opens
  // up" on a page that shows nothing of the sort.
  if (!campground) {
    return { title: `Campground not found | ${SITE_NAME}` };
  }

  const title = campgroundTitle(campground);
  const description = campgroundDescription(campground);
  const canonical = campgroundUrl(id);
  const photo = campground.photos?.find((p) => p.isPrimary)?.url ?? campground.photos?.[0]?.url;

  return {
    title,
    description,
    // The canonical points at /campground/<id>, the live URL, NOT this /v2 one.
    // See lib/seo.ts — the redesign takes over that route at the swap, and
    // naming the final address now means no indexed page ever has to move.
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "website",
      ...(photo ? { images: [photo] } : {}),
    },
    twitter: {
      card: photo ? "summary_large_image" : "summary",
      title,
      description,
      ...(photo ? { images: [photo] } : {}),
    },
    // robots is inherited from the /v2 layout, which is noindex while the
    // redesign is dark-launched. Everything above goes live when that flips.
  };
}

export default async function V2CampgroundPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ start?: string; end?: string; from?: string; back?: string }>;
}) {
  const { id } = await params;
  const { start, end, from, back } = await searchParams;
  const campground = await loadCampground(id);

  // A real 404 status, not a 200 with "Not found" on it. A soft 404 gets the
  // page indexed as thin content instead of dropped.
  if (!campground) notFound();

  // Where the back link goes. `back` carries the encoded Explore query so the
  // search is restored rather than restarted; `from=watches` means the user
  // drilled in from their watches and expects to land back there.
  //
  // The href is REBUILT here rather than used verbatim: `back` arrives in a URL
  // anyone can edit, and a raw pass-through would turn this link into an open
  // redirect. Only the query survives, always onto /v2.
  const backTo = from === "watches" ? "/v2/watches" : back ? `/v2?${stripLeading(back)}` : "/v2";
  const backLabel = from === "watches" ? "Back to watches" : "Back to search";

  // Does this campground's state have a landing page? Three states don't clear
  // the minimum, and a breadcrumb rung pointing at a 404 is worse than no rung.
  const code = normalizeStateCode(campground.address?.state);
  const qualifying = await qualifyingStateCodes();
  const hasStatePage = Boolean(code && (qualifying?.has(code) ?? false));
  const sName = stateName(code);
  const sSlug = code ? stateSlug(code) : null;

  // Arrived from a search or a watch -> the contextual back link is what they
  // want. Arrived cold from Google -> they have no "back", so give them the
  // hierarchy instead. This also keeps the visible trail honest against the
  // BreadcrumbList markup below, which Google expects to correspond.
  const arrivedCold = !from && !back;
  const breadcrumb =
    arrivedCold && hasStatePage && sName && sSlug
      ? [
          { name: SITE_NAME, href: "/" },
          { name: "Camping by state", href: "/camping" },
          { name: sName, href: `/camping/${sSlug}` },
        ]
      : undefined;

  return (
    <>
      {/* Structured data. Rendered in the page rather than via generateMetadata
          because Metadata has no field for it — see lib/jsonld.ts for why the
          `<` escaping matters and why several obvious properties are absent. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(campgroundJsonLd(campground)) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(campgroundBreadcrumbJsonLd(campground, hasStatePage)),
        }}
      />
      <CampgroundDetail
        campgroundId={id}
        initialCampground={campground}
        startDate={start}
        endDate={end}
        backHref={backTo}
        backLabel={backLabel}
        breadcrumb={breadcrumb}
      />
    </>
  );
}

/** Query only — no scheme, host, or path can ride in on `back`. */
function stripLeading(raw: string): string {
  return raw.replace(/^[?#]/, "").split(/[#\/\\]/)[0];
}
