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

/**
 * TN and SC share the ColdFusion backend but NOT the front-end, so catalog +
 * availability are handled two different ways (recon 2026-07-22):
 *
 * - `embedded-json` (TN): the landing embeds a JS park array (parkId, coords) and
 *   availability is a batched JSON POST to `landingPageAvailability.html` keyed by
 *   `accountKey === parkId`. Rich: per-park site counts, embedded coordinates.
 * - `html-grid` (SC): the landing renders `.parkGridItem` cards keyed by a **slug**
 *   (`data-action`), with NO parkId, NO coordinates, NO address. Availability is a
 *   POST to `getStateWide.html` that returns the re-rendered grid filtered to the
 *   parks with a bookable camping site for the whole stay — so it's a park-level
 *   **boolean by slug** (no per-site count), and coordinates must be geocoded.
 */
export type TnscVariant = 'embedded-json' | 'html-grid';

export interface TnscProvider {
  /** Two-letter state; also the first id segment (`tnsc-TN-25`, `tnsc-SC-aiken`). */
  state: string;
  /** Portal host, e.g. `reserve.tnstateparks.com`. */
  host: string;
  /** Display name for alert copy. */
  name: string;
  /** Public booking entry point (reservations_url + alert CTA). */
  bookingUrl: string;
  /** Which front-end shape this state's portal renders — selects the catalog +
   *  availability path in client.ts. See {@link TnscVariant}. */
  variant: TnscVariant;
  /**
   * Whether this state's catalog/availability path is verified working. TN was
   * fingerprinted 2026-07-20; SC was reconned 2026-07-22 — it turned out to be the
   * `html-grid` variant (slug-keyed grid, geocoded coords), not a drop-in of TN's
   * JSON path. Do not enable in search/worker until `verified: true`.
   */
  verified: boolean;
}

export const TNSC_PROVIDERS: TnscProvider[] = [
  {
    state: 'TN',
    host: 'reserve.tnstateparks.com',
    name: 'Tennessee State Parks',
    bookingUrl: 'https://reserve.tnstateparks.com/',
    variant: 'embedded-json',
    verified: true,
  },
  {
    // SC shares TN's ColdFusion stack + WAF direction (Fly blocked, Vercel fine, so
    // it reuses the /api/tnsc-availability proxy), but its front-end is the
    // `html-grid` variant: slug-keyed `.parkGridItem` cards with no parkId/coords,
    // and availability via getStateWide.html (presence == bookable). Reconned and
    // verified 2026-07-22.
    state: 'SC',
    host: 'reserve.southcarolinaparks.com',
    name: 'South Carolina State Parks',
    bookingUrl: 'https://reserve.southcarolinaparks.com/',
    variant: 'html-grid',
    verified: true,
  },
];

/**
 * The `productKey` the SC `getStateWide.html` filter uses for camping (decoded from
 * the landing's product buttons 2026-07-22: camping=4, lodging=5, day-use=6).
 * Camping-only, deliberately: unlike TN's cabins (a single `Cabins` template), SC's
 * "Lodging" product bundles lodge ROOMS and villas with camper cabins, which are
 * hotel-like, not a campsite — so we don't let them fire a campground alert. Query
 * `'4,5'` if a watch should also hit SC lodging.
 */
export const SC_CAMPING_PRODUCT_KEY = '4';

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

/**
 * Build a campground id. The key is per-variant: TN uses its numeric `parkId`
 * (`tnsc-TN-25`), SC uses its slug (`tnsc-SC-aiken`). Both are opaque strings from
 * everywhere but this module — availability keys the batch by this same string.
 */
export function tnscId(provider: TnscProvider, key: string | number): string {
  return `tnsc-${provider.state}-${key}`;
}

/**
 * Parse a campground id → provider + park key. The key is everything after the
 * state segment, kept as a string so it covers both TN's numeric parkId and SC's
 * slug (which itself contains hyphens, e.g. `tnsc-SC-andrew-jackson`).
 */
export function parseTnscId(
  campgroundId: string
): { provider: TnscProvider; key: string } | null {
  const m = campgroundId.match(/^tnsc-([A-Z]{2})-(.+)$/);
  if (!m) return null;
  const provider = tnscProviderByState(m[1]);
  return provider ? { provider, key: m[2] } : null;
}

export function isTnscSource(source: string): boolean {
  return source === TNSC_SOURCE;
}
