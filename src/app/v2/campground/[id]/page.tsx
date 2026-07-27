import type { Metadata } from "next";
import CampgroundDetail from "@/components/v2/CampgroundDetail";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Campground detail. A drill-in from a search result or a watch — deliberately
 * not a fourth nav destination, since "a campground" means nothing unchosen.
 *
 * `params` and `searchParams` are promises in this Next version; awaiting them
 * here is fine because it's a page, not the root layout. (A request-time API in
 * the ROOT layout throws under Cache Components and 500s the whole site.)
 */
export default async function V2CampgroundPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ start?: string; end?: string; from?: string; back?: string }>;
}) {
  const { id } = await params;
  const { start, end, from, back } = await searchParams;

  // Where the back link goes. `back` carries the encoded Explore query so the
  // search is restored rather than restarted; `from=watches` means the user
  // drilled in from their watches and expects to land back there.
  //
  // The href is REBUILT here rather than used verbatim: `back` arrives in a URL
  // anyone can edit, and a raw pass-through would turn this link into an open
  // redirect. Only the query survives, always onto /v2.
  const backTo = from === "watches" ? "/v2/watches" : back ? `/v2?${stripLeading(back)}` : "/v2";
  const backLabel = from === "watches" ? "Back to watches" : "Back to search";

  return (
    <CampgroundDetail
      campgroundId={id}
      startDate={start}
      endDate={end}
      backHref={backTo}
      backLabel={backLabel}
    />
  );
}

/** Query only — no scheme, host, or path can ride in on `back`. */
function stripLeading(raw: string): string {
  return raw.replace(/^[?#]/, "").split(/[#\/\\]/)[0];
}
