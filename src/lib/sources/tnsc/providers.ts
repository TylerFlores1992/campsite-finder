// Tennessee / South Carolina State Parks reservation registry.
//
// Both states run the SAME vendor stack: an Apache + ColdFusion portal at
// `reserve.<state>parks.com` (cookies `cfid`/`cftoken` + a per-state
// `CF_CLIENT_<XXX>_LV`, differing only by the 3-letter prefix), each behind an
// AWS ALB. Despite the shared backend they are NOT a single drop-in adapter —
// their landing pages render differently (TN embeds a parks JS array; SC does
// not), so catalog handling is per-state even though the availability plumbing is
// shared. See docs/CONTEXT.md ("TN + SC") for the full fingerprint.
//
// IMPORTANT — this is NOT the same product as the golf links on the page.
// The `foreupsoftware.com` "Book Tee Times" buttons are a golf-only engine; camping
// books through the ColdFusion portal itself. Fingerprint by the availability API
// (POST /library/ajax/landingPageAvailability.html → JSON), not by page links.

export interface TnscProvider {
  /** Two-letter state; also the id segment (`tnsc-TN-25`). */
  state: string;
  /** Portal host, e.g. `reserve.tnstateparks.com`. */
  host: string;
  /** Display name for alert copy. */
  name: string;
  /** Public booking entry point (reservations_url + alert CTA). */
  bookingUrl: string;
  /**
   * Whether this state's catalog/availability path is verified working. TN was
   * fingerprinted 2026-07-20; SC's portal front-end differs and is UNVERIFIED —
   * it likely shares the same `/library/ajax/` endpoint, but that is unproven, so
   * it stays flagged off until its own recon confirms the catalog + availability
   * shape. Do not enable in search/worker until `verified: true`.
   */
  verified: boolean;
}

export const TNSC_PROVIDERS: TnscProvider[] = [
  {
    state: 'TN',
    host: 'reserve.tnstateparks.com',
    name: 'Tennessee State Parks',
    bookingUrl: 'https://reserve.tnstateparks.com/',
    verified: true,
  },
  {
    // UNVERIFIED — SC portal renders its park list differently from TN (no embedded
    // JS array, no foreUP link). Same ColdFusion stack, so the availability POST is
    // probably identical, but the catalog path needs its own recon before enabling.
    state: 'SC',
    host: 'reserve.southcarolinaparks.com',
    name: 'South Carolina State Parks',
    bookingUrl: 'https://reserve.southcarolinaparks.com/',
    verified: false,
  },
];

/** Our single source value in the campgrounds table. */
export const TNSC_SOURCE = 'tnsc';

/**
 * Which `templateKey`s in the availability response count as a bookable overnight
 * stay. Decoded from the app's own `templateMap` (2026-07-20):
 *   1 = Camping ('Limited Camping' / 'Camping Sold Out'; the large-inventory type)
 *   2 = Cabins  ('Limited Cabins'  / 'Cabins Sold Out')
 *   4 = present in availability data but NOT in the app's badge map — unlabeled,
 *       tiny counts, often 100%. Deliberately EXCLUDED until identified (likely a
 *       day-use / add-on / group product); including it risks firing a campground
 *       alert on something that isn't an overnight site.
 *
 * We include BOTH camping and cabins, mirroring GoingToCamp's deliberate choice
 * that `Nightly` spans campsites AND lodging — a cabin opening at a watched park is
 * a valid hit. Narrow to `new Set([1])` if TN watches should be campsites-only.
 * `null` would mean "count every template" — do not use it now that the legend is
 * known, or templateKey 4 would leak back in.
 */
export const CAMPING_TEMPLATE_KEYS: Set<number> | null = new Set([1, 2]);

/** Per-state bbox, so a bad coordinate can't land a park in the wrong state. */
export const TNSC_BBOX: Record<string, [number, number, number, number]> = {
  // [minLat, maxLat, minLng, maxLng]
  TN: [34.9, 36.7, -90.4, -81.6],
  SC: [32.0, 35.3, -83.4, -78.5],
};

export function tnscProviderByState(state: string): TnscProvider | undefined {
  return TNSC_PROVIDERS.find((p) => p.state === state.toUpperCase());
}

export function tnscId(provider: TnscProvider, parkId: number): string {
  return `tnsc-${provider.state}-${parkId}`;
}

/** Parse `tnsc-TN-25` → provider + parkId. */
export function parseTnscId(
  campgroundId: string
): { provider: TnscProvider; parkId: number } | null {
  const m = campgroundId.match(/^tnsc-([A-Z]{2})-(\d+)$/);
  if (!m) return null;
  const provider = tnscProviderByState(m[1]);
  return provider ? { provider, parkId: Number(m[2]) } : null;
}

export function isTnscSource(source: string): boolean {
  return source === TNSC_SOURCE;
}
