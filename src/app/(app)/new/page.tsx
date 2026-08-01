import type { Metadata } from "next";
import NewWatch from "@/components/v2/NewWatch";
import PricingLink from "@/components/v2/PricingLink";

export const metadata: Metadata = {
  title: "New watch — CampHawk",
  // A form, behind a subscription. Nothing to index.
  robots: { index: false, follow: false },
};

export default async function V2NewWatchPage({
  searchParams,
}: {
  searchParams: Promise<{ campground?: string; start?: string; end?: string }>;
}) {
  const { campground, start, end } = await searchParams;

  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
      {/* No subtitle. The "What we'll do" panel below already explains the
          15-second checking in full, and saying it twice on one screen made the
          heading area noisy for no gain. */}
      <h1 className="mb-4 font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
        New watch
      </h1>
      <NewWatch initialCampgroundId={campground} initialStart={start} initialEnd={end} />
      {/* Self-hiding: renders only for signed-out / non-subscribed web visitors. */}
      <PricingLink className="mt-6" />
    </div>
  );
}
