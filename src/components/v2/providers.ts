import { providerBySource } from "@/lib/sources/reservecalifornia/providers";
import { parseGoingToCampId } from "@/lib/sources/goingtocamp/providers";
import { parseTnscId } from "@/lib/sources/tnsc/providers";

/**
 * The name of the site a user will actually check out on.
 *
 * DERIVED FROM THE REGISTRIES, NOT A HARDCODED MAP. The provider tables already
 * carry display names ("Ohio State Parks", "Washington State Parks"), and adding
 * a state is meant to be a one-line registry entry — a second copy here would go
 * stale the first time that happened, silently, on a badge nobody re-checks.
 *
 * Why (source, id) and not source alone: GoingToCamp files four states under one
 * `goingtocamp` source and TN/SC file two under `tnsc`, with the state encoded in
 * the id (`gtc-WA--2147483647`, `tnsc-SC-aiken`). Labelling those by source would
 * put "GoingToCamp" on a Washington park, which tells the user nothing about
 * where they're about to book.
 *
 * The mockups' "County" badge does not exist — there is no county source. The
 * five real families are Recreation.gov, UseDirect, ReserveAmerica, GoingToCamp
 * and the TN/SC portal.
 */

const RECGOV = "Recreation.gov";

export function providerLabel(source: string, campgroundId?: string): string {
  if (source === "ridb") return RECGOV;

  // UseDirect: one source per state, so the source alone resolves it.
  const useDirect = providerBySource(source);
  if (useDirect) return useDirect.name;

  // GoingToCamp: state lives in the id, and the parser hands back the provider.
  if (source === "goingtocamp") {
    const parsed = campgroundId ? parseGoingToCampId(campgroundId) : null;
    return parsed?.provider.name ?? "GoingToCamp";
  }

  // TN/SC ColdFusion portal: likewise.
  if (source === "tnsc") {
    const parsed = campgroundId ? parseTnscId(campgroundId) : null;
    return parsed?.provider.name ?? "State Parks";
  }

  // ReserveAmerica spans ~18 states under one source and the catalog row doesn't
  // carry the contract, so the honest label is the platform. Resolving the state
  // would mean threading the contract through the search response — worth doing,
  // but it's a data-shape change and this pass is presentation-only.
  if (source === "reserveamerica") return "ReserveAmerica";

  return "Reservation site";
}

/**
 * Auto-cart is Recreation.gov only, and that is a hard product constraint rather
 * than a gap: every other provider's cart is session-bound and won't follow the
 * user to their phone. Gated identically in the poller (isAutocartLane requires
 * campground_source === 'ridb').
 */
export function supportsAutoCart(source: string): boolean {
  return source === "ridb";
}
