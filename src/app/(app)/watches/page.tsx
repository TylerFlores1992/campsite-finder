import type { Metadata } from "next";
import WatchesList from "@/components/v2/WatchesList";
import PricingLink from "@/components/v2/PricingLink";

export const metadata: Metadata = {
  title: "Your watches — CampHawk",
  // Private to the account — nothing here is meaningful to a search engine.
  robots: { index: false, follow: false },
};

export default function V2WatchesPage() {
  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
      <h1 className="mb-4 font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
        Your watches
      </h1>
      <WatchesList />
      {/* Self-hiding: renders only for signed-out / non-subscribed web visitors. */}
      <PricingLink className="mt-6" />
    </div>
  );
}
