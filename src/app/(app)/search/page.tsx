import type { Metadata } from "next";
import Explore from "@/components/v2/Explore";
import PricingLink from "@/components/v2/PricingLink";
import BrandHeader from "@/components/v2/BrandHeader";
import { COVERAGE, campgroundsRounded } from "@/lib/coverage";

export const metadata: Metadata = {
  title: "Search campgrounds by date — live availability | CampHawk",
  description:
    "Search real-time campsite availability near any city or park. See what's open tonight, this weekend, or any nights that suit you. Free, no account needed.",
  alternates: { canonical: "https://camphawk.app/search" },
};

/**
 * Explore — the free funnel, and the signed-out home of the redesign.
 *
 * Server component so the hero copy renders without waiting on JS; the search
 * itself is client-side because it's driven by user input and hits /api/search.
 *
 * NOTE: no request-time APIs here or in the layout. Under this build's Cache
 * Components model, headers()/cookies() in a layout without a Suspense boundary
 * throws at request time and 500s every page — it caused a full outage in July.
 */
export default function V2ExplorePage() {
  return (
    <>
      <BrandHeader
        title="Find a campsite that's open tonight"
        subtitle={`Live availability across ${campgroundsRounded()} campgrounds — every Recreation.gov site in all ${COVERAGE.states} states, plus state parks in ${COVERAGE.stateParkStates}. Free, no account needed.`}
      />

      <Explore />
      {/* Self-hiding marketing link back to /#pricing — renders only for
          signed-out / non-subscribed web visitors, nothing in the native app. */}
      <div className="mx-auto max-w-[var(--ch-max)] px-5 pb-8">
        <PricingLink />
      </div>
    </>
  );
}
