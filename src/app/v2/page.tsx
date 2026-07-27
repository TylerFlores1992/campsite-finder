import type { Metadata } from "next";
import AvailableNow from "@/components/v2/AvailableNow";
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
      <section className="border-b border-ch-line bg-[#24382A]">
        <div className="mx-auto max-w-[var(--ch-max)] px-5 py-12">
          <h1 className="max-w-[18ch] font-ch-display text-[clamp(26px,5vw,var(--text-ch-hero))] font-extrabold leading-[1.08] tracking-[-.035em] text-white">
            Find a campsite that&apos;s open tonight
          </h1>
          <p className="mt-3 max-w-[52ch] text-[14.5px] text-white/90">
            Live availability across {campgroundsRounded()} campgrounds — every Recreation.gov
            site in all {COVERAGE.states} states, plus state parks in {COVERAGE.stateParkStates}.
            Free, no account needed.
          </p>
        </div>
      </section>

      <AvailableNow />
    </>
  );
}
