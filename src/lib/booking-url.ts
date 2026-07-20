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
 * - **ReserveCalifornia / UseDirect and GoingToCamp — UNVERIFIED, so no params.**
 *   Both are alert-only sources and neither has had its deep-link format measured
 *   the way the two above have. They fall through to the plain reservations URL on
 *   purpose. If you verify one, add a branch here and note the evidence — do not
 *   add a guess.
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
  /** The campground's stored reservations_url — the fallback, and the base for RA. */
  reservationsUrl?: string | null;
  /** Provider's site id, when we know which specific site opened. Recreation.gov only. */
  campsiteId?: string | null;
  /** Arrival date, YYYY-MM-DD. Only ReserveAmerica does anything with it. */
  date?: string | null;
}

export function bookingLink({ source, reservationsUrl, campsiteId, date }: BookingLinkOpts): string | undefined {
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

  return reservationsUrl;
}
