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
  searchParams: Promise<{ start?: string; end?: string }>;
}) {
  const { id } = await params;
  const { start, end } = await searchParams;

  return <CampgroundDetail campgroundId={id} startDate={start} endDate={end} />;
}
