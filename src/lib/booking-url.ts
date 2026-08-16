/**
 * The single place that turns "campground + maybe a site + maybe a date" into the
 * most specific booking URL a provider will actually honor.
 *
 * Shared by the alert emails/SMS (src/lib/notifications) and the availability
 * calendar on the campground detail page, so a link never gets more specific in
 * one place than the other.
 *
 * ## What each provider actually supports (measured 2026-07-19, not assumed)
 *
 * The rule here: only add a parameter we have SEEN take effect. A link that looks
 * dated but silently lands on a generic page is worse than an honest generic link
 * — the alert says "your dates are open", the user clicks, and has to re-enter
 * everything anyway.
 *
 * - **Recreation.gov — site yes, date NO.**
 *   `/camping/campsites/<campsiteId>` is a real per-site page (rec.gov links to it
 *   itself from the campground's site list) and is the most specific link we can
 *   build. Dates are NOT deep-linkable, verified three ways against a live page:
 *     - `/availability` and `?date=YYYY-MM-DD` are both STRIPPED — the SPA
 *       canonicalizes straight back to `/camping/campgrounds/<id>`.
 *     - `?checkin=&checkout=` survive in the URL but do nothing here: the
 *       calendar's hidden inputs (`campground-calendar-hidden-start/-end`) stay
 *       empty after hydration. Those are the *search* route's params — the bundle
 *       maps them from `search.checkin_time`, not from the campground page.
 *     - The site page has no date inputs at all.
 *   So: link the site, let them pick dates. Don't fake it.
 *
 * - **ReserveAmerica — date yes.** The matrix takes an arrival date as
 *   `calarvdate=M/D/YYYY` (plus `sitepage=true` to land on the site grid). This
 *   one was already proven in the detail-page calendar; it now applies to alerts
 *   too, which previously sent the bare park URL.
 *
 * - **GoingToCamp — park + dates YES (verified 2026-07-22, residential browser).**
 *   The booking flow's results page is a real deep link:
 *     `…/create-booking/results?transactionLocationId=<tl>&resourceLocationId=<rl>
 *        &mapId=<rootMapId>&bookingCategoryId=0&startDate=<Y-M-D>&endDate=<Y-M-D>
 *        &nights=<n>&equipmentId=-32768&subEquipmentId=-32768&…`
 *   All three ids come from the `/api/resourcelocation` response we already sync
 *   (`resourceLocationId`, `transactionLocationId`, `rootMapId`), so the GTC sync
 *   stores that whole base (minus dates) as the campground's `reservations_url`, and
 *   this helper appends the stay. Confirmed by rebuilding a park we never captured
 *   (Alta Lake) from scratch: it landed on that park's site list with the dates
 *   pre-filled. Equipment/party default to "any / 1 person" (`-32768`) — the widest
 *   match; the user narrows on the page. A bare tenant-root URL (pre-sync, or a
 *   day-use park with `rootMapId=null`) falls through unchanged.
 *
 * - **ReserveCalifornia — facility YES, date NO (verified 2026-07-22).**
 *   `reservecalifornia.com/park/<placeId>/<facilityId>` deep-links to the specific
 *   loop that opened (confirmed landing on the exact loop for a facility we rebuilt
 *   from our id). `<placeId>` is already in `reservations_url` (`/park/<placeId>`),
 *   `<facilityId>` is the trailing number of our campground id (`rc-708` → `708`).
 *   Dates are NOT URL-linkable here — that's exactly why the poller emits the
 *   `#camphawk-rc` extension fragment to autofill them — so no date param. Gated on
 *   the reservecalifornia.com host: other UseDirect states use generic reserve
 *   landings that don't take a facility path, and stay unverified → no param.
 *
 * ## This helper does NOT own the alert links' `#camphawk` fragments
 *
 * The poller builds richer URLs for the two sources where a browser extension can
 * autofill: `…/campsites/<id>#camphawk=<start>_<end>` (rec.gov) and
 * `…#camphawk-rc=<unitId>_<arrival>_<nights>_<sleepingUnitId>` (UseDirect). Those
 * fragments never reach the provider's server and only do anything if the user has
 * the extension, so they're additive — but they're the poller's, not this file's.
 * Don't route those two branches through here without carrying the fragment, or
 * you'll silently strip the autofill.
 */

export interface BookingLinkOpts {
  /** Campground `source` column: 'ridb' | 'reserveamerica' | 'reservecalifornia' | 'goingtocamp' | 'tnsc' | …
   *  ('tnsc' has no verified date/site deep-link params, so it falls through to the plain reservationsUrl). */
  source?: string | null;
  /** The campground's stored reservations_url — the fallback, the base for RA, and
   *  (for GoingToCamp, post-sync) the create-booking deep-link base. */
  reservationsUrl?: string | null;
  /** Provider's site id, when we know which specific site opened. Recreation.gov only. */
  campsiteId?: string | null;
  /** Our campground id — used to pull the ReserveCalifornia facility id (trailing number). */
  campgroundId?: string | null;
  /** Arrival date, YYYY-MM-DD. ReserveAmerica + GoingToCamp use it. */
  date?: string | null;
  /** Departure date, YYYY-MM-DD. GoingToCamp uses it for `nights` (defaults to 1). */
  endDate?: string | null;
}

/** Whole nights between two ISO dates, floored at 1. */
function nightsBetween(start: string, end?: string | null): number {
  if (!end) return 1;
  const n = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** ISO date one day after `iso`. */
function nextDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function bookingLink({ source, reservationsUrl, campsiteId, campgroundId, date, endDate }: BookingLinkOpts): string | undefined {
  // Recreation.gov: the site page is the most specific thing that exists. It stands
  // alone (not derived from reservationsUrl), so it works even when a campground's
  // stored URL is a facility-specific one.
  if (source === 'ridb' && campsiteId) {
    return `https://www.recreation.gov/camping/campsites/${encodeURIComponent(campsiteId)}`;
  }

  if (!reservationsUrl) return undefined;

  if (source === 'reserveamerica' && date) {
    const [y, m, d] = date.split('-').map(Number);
    if (!y || !m || !d) return reservationsUrl; // malformed date — don't build a broken param
    const sep = reservationsUrl.includes('?') ? '&' : '?';
    return `${reservationsUrl}${sep}calarvdate=${m}/${d}/${y}&sitepage=true`;
  }

  // GoingToCamp: append the stay to the park deep-link base. Only fires once the
  // sync has stored that base (contains `create-booking/results`); a bare tenant
  // root falls through so nothing breaks pre-sync or for day-use parks. See header.
  if (source === 'goingtocamp' && date && reservationsUrl.includes('create-booking/results')) {
    const sep = reservationsUrl.includes('?') ? '&' : '?';
    return `${reservationsUrl}${sep}startDate=${date}&endDate=${endDate ?? nextDay(date)}&nights=${nightsBetween(date, endDate)}`;
  }

  // ReserveCalifornia: deep-link to the specific facility (loop). Host-gated so only
  // reservecalifornia.com/park/<placeId> URLs qualify; other UseDirect states' generic
  // reserve pages stay unverified. No date param (not URL-linkable — see header).
  if (campgroundId && /reservecalifornia\.com\/park\/\d+$/.test(reservationsUrl)) {
    const facilityId = campgroundId.match(/(\d+)$/)?.[1];
    if (facilityId) return `${reservationsUrl}/${facilityId}`;
  }

  return reservationsUrl;
}
