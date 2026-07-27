import type { Metadata } from "next";
import AvailableNow from "@/components/v2/AvailableNow";
import BrandHeader from "@/components/v2/BrandHeader";
import { COVERAGE, campgroundsRounded } from "@/lib/coverage";

export const metadata: Metadata = {
  title: "Available now — CampHawk",
  robots: { index: false, follow: false },
};

/**
 * Available now — the free funnel, and the signed-out home of the redesign.
 *
 * Server component so the hero copy renders without waiting on JS; the search
 * itself is client-side because it's driven by user input and hits /api/search.
 *
 * NOTE: no request-time APIs here or in the layout. Under this build's Cache
 * Components model, headers()/cookies() in a layout without a Suspense boundary
 * throws at request time and 500s every page — it caused a full outage in July.
 */
export default function V2AvailableNowPage() {
  return (
    <>
      <BrandHeader
        title="Find a campsite that's open tonight"
        subtitle={`Live availability across ${campgroundsRounded()} campgrounds — every Recreation.gov site in all ${COVERAGE.states} states, plus state parks in ${COVERAGE.stateParkStates}. Free, no account needed.`}
      />

      <AvailableNow />
    </>
  );
}
