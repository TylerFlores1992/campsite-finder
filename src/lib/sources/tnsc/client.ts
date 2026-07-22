// Tennessee / South Carolina State Parks portal client (Apache + ColdFusion).
//
// Two things make this a GoingToCamp-shaped adapter, NOT a ReserveAmerica one:
//
// 1. AVAILABILITY IS A CLEAN BATCHED JSON API. One POST returns availability for
//    EVERY park at once for a date range — no per-park fan-out, no HTML scrape.
//    The range is evaluated whole (fromDate → toDate), so it maps to CampHawk's
//    "one site, all consecutive nights" rule natively, like Camis — no per-night
//    intersection like RA.
//
// 2. THE RESPONSE KEYS BY parkId. The app stores availability by `accountKey` and
//    then reads it back by `parkID` (`window.availabilityData[parkID]`), which only
//    works because `accountKey === parkId`. So the availability row's `accountKey`
//    IS the catalog `parkId` — no join table.
//
// The POST needs a CSRF token + session cookie, both obtained from one GET of the
// portal landing page (`#csrfToken` + `cfid`/`cftoken` cookies).
//
// UNVERIFIED: reachability from Fly/Vercel. Recon ran from a residential IP; the
// portal sits behind an AWS ALB whose datacenter-IP behaviour is untested. Confirm
// with the full UA from a Fly box before deciding worker-direct vs a proxy (cf. the
// GoingToCamp / UseDirect reachability split in docs/CONTEXT.md).

import type { TnscProvider } from './providers';
import { CAMPING_TEMPLATE_KEYS, SC_CAMPING_PRODUCT_KEY, SC_PARK_COORDS } from './providers';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ── Catalog ────────────────────────────────────────────────────────────────

export interface TnscPark {
  /**
   * Stable per-park key that forms the id segment and keys availability. TN: its
   * numeric `parkId` as a string (`'25'`); SC: its slug (`'aiken'`). Opaque to
   * callers — always compared as a string against the availability batch.
   */
  key: string;
  /** TN's numeric accountKey/parkId; `null` for SC (the grid has no parkId). */
  parkId: number | null;
  name: string;
  city: string | null;
  /** Park slug (`big-ridge` / `aiken`) — SC's is also its key. */
  slug: string;
  /** Embedded for TN; for SC, filled from the curated SC_PARK_COORDS table (`null` if absent). */
  lat: number | null;
  lng: number | null;
  /** Product categories the park offers (e.g. camping, cabins/lodging, day-use). */
  products: string[];
}

/** A ColdFusion session: the cookie jar + the CSRF token scraped from the landing. */
interface PortalSession {
  cookie: string;
  csrfToken: string;
}

function joinSetCookies(res: Response): string {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

/**
 * GET the portal landing once and pull out both the session cookie and the CSRF
 * token the availability POST requires. Returns the raw HTML too, so the TN
 * catalog parse can reuse the same fetch.
 */
async function openPortal(provider: TnscProvider): Promise<{ session: PortalSession; html: string }> {
  const res = await fetch(`https://${provider.host}/`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TNSC ${provider.state}: ${res.status} on landing`);
  const html = await res.text();
  const cookie = joinSetCookies(res);
  const csrfToken =
    (html.match(/id=["']csrfToken["'][^>]*value=["']([^"']+)["']/i) ||
      html.match(/value=["']([^"']+)["'][^>]*id=["']csrfToken["']/i) ||
      [])[1] ?? '';
  if (!csrfToken) throw new Error(`TNSC ${provider.state}: no csrfToken on landing page`);
  return { session: { cookie, csrfToken }, html };
}

/**
 * Every park for a provider, keyed and shaped per variant:
 *  - `embedded-json` (TN): the landing's embedded JS array + per-card `data-product`.
 *  - `html-grid` (SC): the landing's `.parkGridItem` cards (slug + name + data-*).
 */
export async function fetchParkCatalog(provider: TnscProvider): Promise<TnscPark[]> {
  const { html } = await openPortal(provider);
  return provider.variant === 'html-grid'
    ? parseGridCatalog(html)
    : parseEmbeddedCatalog(html);
}

/**
 * SC (`html-grid`): parse the landing's `.parkGridItem` cards. Each card is a
 * `<div class="parkLink" data-action="<slug>">` wrapping a `<div class="parkGridItem"
 * data-camping data-lodging data-day-use data-maxrv …>` and an `<h4>Name</h4>`.
 * There is NO parkId and NO coordinates — the slug is the key, and coordinates come
 * from the curated `SC_PARK_COORDS` table (the portal ships none and name-geocoding
 * is unreliable; see providers.ts). `data-action` can be `slug/camping`; the app
 * itself keys on `data-action.split('/')[0]`, so we do too.
 */
function parseGridCatalog(html: string): TnscPark[] {
  const parks: TnscPark[] = [];
  const seen = new Set<string>();
  // Split on each park card so a per-card regex can't leak across cards.
  for (const card of html.split(/<div class="parkLink"/).slice(1)) {
    const slug = (card.match(/^\s*data-action="([^"]+)"/) || [])[1];
    if (!slug) continue;
    const key = slug.split('/')[0].trim();
    if (!key || seen.has(key)) continue;
    const name = (card.match(/<h4[^>]*>([^<]+)<\/h4>/) || [])[1]?.trim();
    if (!name) continue;
    seen.add(key);
    const has = (attr: string) => new RegExp(`data-${attr}="true"`, 'i').test(card);
    const products: string[] = [];
    if (has('camping')) products.push('camping');
    if (has('lodging')) products.push('lodging');
    if (has('day-use')) products.push('day-use');
    const coords = SC_PARK_COORDS[key];
    parks.push({
      key, parkId: null, name, city: null, slug: key,
      lng: coords?.[0] ?? null, lat: coords?.[1] ?? null, products,
    });
  }
  return parks;
}

/**
 * TN (`embedded-json`): parse the landing page's embedded JS array
 * (`{ name, city, url:'/slug', parkId, lat, lng }`) enriched with the per-card
 * `data-product` list. Coordinates come embedded — no geocoding needed.
 */
function parseEmbeddedCatalog(html: string): TnscPark[] {
  // 1. The embedded park objects. Each looks like:
  //    { name: 'Big Ridge State Park', city: 'Maynardville', url: '/big-ridge',
  //      parkId: '25', lat: 36.26, lng: -83.91 }
  const parks = new Map<number, TnscPark>();
  const objRe =
    /name:\s*'([^']+)'\s*,\s*city:\s*'([^']*)'\s*,\s*url:\s*'([^']*)'\s*,\s*parkId:\s*'?(\d+)'?\s*,\s*lat:\s*(-?\d+(?:\.\d+)?)\s*,\s*lng:\s*(-?\d+(?:\.\d+)?)/g;
  for (const m of html.matchAll(objRe)) {
    const parkId = Number(m[4]);
    const slug = m[3].trim().replace(/^\//, '');
    parks.set(parkId, {
      key: String(parkId),
      parkId,
      name: m[1].trim(),
      city: m[2].trim() || null,
      slug,
      lat: Number(m[5]),
      lng: Number(m[6]),
      products: [],
    });
  }

  // 2. Enrich with `data-product` from each park card (also our camping filter).
  //    Card: <div class="... parkItem" data-parkid="25" data-product="camping,cabins,...">
  const cardRe =
    /data-parkid=["'](\d+)["'][^>]*data-product=["']([^"']*)["']/gi;
  for (const m of html.matchAll(cardRe)) {
    const park = parks.get(Number(m[1]));
    if (park) park.products = m[2].split(',').map((p) => p.trim()).filter(Boolean);
  }

  return [...parks.values()];
}

// ── Availability ─────────────────────────────────────────────────────────────

interface TnscTemplate {
  templateKey: number;
  available: number;
  total: number;
  availPercentage: string;
}

interface TnscAvailabilityRow {
  accountKey: number; // === parkId
  templates: TnscTemplate[];
}

/** Availability for one park: bookable-site counts by template (site type). */
export interface TnscParkAvailability {
  /** Total campsite openings across camping templates for the whole stay. */
  availableSites: number;
  /** Raw per-template counts, in case a caller wants to filter by site type. */
  templates: TnscTemplate[];
}

/** MM/DD/YYYY, which the portal's `fromDate`/`toDate` expect (US format). */
function usDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

/** Zero-padded MM/DD/YYYY, matching SC's `checkin`/`checkout` inputs. */
function usDatePadded(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/**
 * Short-lived cache of the whole-portal availability batch, keyed by
 * host+range. One POST answers every park, so N watches on the same date range
 * collapse to a single request. TTL keeps us off the portal's rate limit when a
 * user pans the map, mirroring the GoingToCamp 90s cache.
 */
const BATCH_TTL_MS = 90_000;
const batchCache = new Map<string, { at: number; rows: Map<string, TnscParkAvailability> }>();

/**
 * Fetch availability for ALL of a provider's parks over [fromIso, toIso). Returns
 * a map park-key → counts (TN: parkId string; SC: slug). Does the CSRF handshake,
 * then the single POST.
 *
 * Whole-stay: CONFIRMED for both — the portal evaluates the fromDate→toDate range as
 * one booking query, so a hit reflects sites open for the ENTIRE span, NOT per-night
 * (TN: a 1/3/5-night sweep returned shrinking totals 2140→1742→1686, 2026-07-20; SC:
 * the getStateWide filter set shrinks with the range, 2026-07-22). Never intersect
 * per-night.
 */
export async function fetchAvailabilityBatch(
  provider: TnscProvider,
  fromIso: string,
  toIso: string
): Promise<Map<string, TnscParkAvailability>> {
  const key = `${provider.host}|${fromIso}|${toIso}`;
  const hit = batchCache.get(key);
  if (hit && Date.now() - hit.at < BATCH_TTL_MS) return hit.rows;

  // The portal's WAF blocks datacenter IPs — measured: the Fly worker gets `403 on
  // landing`, while Vercel and residential are fine (the reverse of GoingToCamp).
  // So when TNSC_AVAILABILITY_URL is set (on the Fly worker only), route the whole
  // handshake+POST through that Vercel endpoint; otherwise call the portal directly
  // (Vercel routes, residential, the sync). Same env-gated shape as GTC's remote.
  const rows = process.env.TNSC_AVAILABILITY_URL
    ? await fetchAvailabilityViaProxy(provider, fromIso, toIso)
    : await fetchAvailabilityDirect(provider, fromIso, toIso);

  batchCache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Direct portal call: GET landing for CSRF+cookie, then the batched POST. */
async function fetchAvailabilityDirect(
  provider: TnscProvider,
  fromIso: string,
  toIso: string
): Promise<Map<string, TnscParkAvailability>> {
  return provider.variant === 'html-grid'
    ? fetchAvailabilityDirectGrid(provider, fromIso, toIso)
    : fetchAvailabilityDirectJson(provider, fromIso, toIso);
}

/** TN (`embedded-json`): batched JSON POST keyed by `accountKey === parkId`. */
async function fetchAvailabilityDirectJson(
  provider: TnscProvider,
  fromIso: string,
  toIso: string
): Promise<Map<string, TnscParkAvailability>> {
  const { session } = await openPortal(provider);
  const body = new URLSearchParams({
    fromDate: usDate(fromIso),
    toDate: usDate(toIso),
    csrfToken: session.csrfToken,
  }).toString();

  const res = await fetch(`https://${provider.host}/library/ajax/landingPageAvailability.html`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookie,
      Referer: `https://${provider.host}/`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TNSC ${provider.state}: ${res.status} on availability`);
  const text = await res.text();

  let rows: TnscAvailabilityRow[];
  try {
    rows = JSON.parse(text) as TnscAvailabilityRow[];
  } catch {
    // A CSRF/session miss makes ColdFusion serve the HTML landing instead of JSON.
    throw new Error(`TNSC ${provider.state}: non-JSON availability (CSRF/session?)`);
  }

  const out = new Map<string, TnscParkAvailability>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const templates = Array.isArray(row.templates) ? row.templates : [];
    const camping = templates.filter(
      (t) => CAMPING_TEMPLATE_KEYS === null || CAMPING_TEMPLATE_KEYS.has(t.templateKey)
    );
    const availableSites = camping.reduce((n, t) => n + (Number(t.available) || 0), 0);
    out.set(String(row.accountKey), { availableSites, templates });
  }
  return out;
}

/**
 * SC (`html-grid`): POST the search form to `getStateWide.html` with the stay dates
 * and the camping product filter. The portal replies with the re-rendered park grid
 * containing ONLY parks that have a bookable camping site for the whole stay, so a
 * park's presence == an opening. There is no per-site count (the grid carries no
 * badge), so `availableSites` is a sentinel `1` meaning "≥1 bookable" — enough for
 * an alert-only source. Requires the `CSRFToken`, cookie, and `stage=2`; without the
 * token the endpoint returns an empty grid (measured 2026-07-22).
 */
async function fetchAvailabilityDirectGrid(
  provider: TnscProvider,
  fromIso: string,
  toIso: string
): Promise<Map<string, TnscParkAvailability>> {
  const { session } = await openPortal(provider);
  const body = new URLSearchParams({
    CSRFToken: session.csrfToken,
    view: 'map',
    checkin: usDatePadded(fromIso),
    checkout: usDatePadded(toIso),
    productKey: SC_CAMPING_PRODUCT_KEY,
    stage: '2',
  }).toString();

  const res = await fetch(`https://${provider.host}/library/ajax/getStateWide.html`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookie,
      Referer: `https://${provider.host}/`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TNSC ${provider.state}: ${res.status} on availability`);
  const html = await res.text();

  // Each returned card is `<div class="parkLink" data-action="<slug>">`; the slug
  // (before any `/camping` suffix) is the park key, mirroring parseGridCatalog.
  const out = new Map<string, TnscParkAvailability>();
  for (const card of html.split(/<div class="parkLink"/).slice(1)) {
    const slug = (card.match(/^\s*data-action="([^"]+)"/) || [])[1];
    if (!slug) continue;
    const key = slug.split('/')[0].trim();
    if (key) out.set(key, { availableSites: 1, templates: [] });
  }
  return out;
}

/** Wire form of one park's availability, for the proxy hop. */
export interface TnscProxyRow {
  /** Park key (TN parkId string / SC slug) — matches the availability batch key. */
  key: string;
  availableSites: number;
  templates: TnscTemplate[];
}

/**
 * Ask the Vercel proxy (TNSC_AVAILABILITY_URL) for the batch — used by the Fly
 * worker, whose IP the portal's WAF blocks. Vercel does the CSRF handshake and
 * POST from an allowed IP and returns the already-parsed rows. Authenticated with
 * SYNC_SECRET, which the worker app carries.
 */
async function fetchAvailabilityViaProxy(
  provider: TnscProvider,
  fromIso: string,
  toIso: string
): Promise<Map<string, TnscParkAvailability>> {
  const res = await fetch(process.env.TNSC_AVAILABILITY_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sync-secret': process.env.SYNC_SECRET ?? '',
    },
    body: JSON.stringify({ state: provider.state, fromDate: fromIso, toDate: toIso }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TNSC ${provider.state}: proxy ${res.status}`);
  const rows = (await res.json()) as TnscProxyRow[];
  const out = new Map<string, TnscParkAvailability>();
  for (const r of Array.isArray(rows) ? rows : []) {
    out.set(r.key, { availableSites: r.availableSites, templates: r.templates ?? [] });
  }
  return out;
}

/** Run the direct batch and serialize it for the proxy response (Vercel side). */
export async function fetchAvailabilityBatchAsProxyRows(
  provider: TnscProvider,
  fromIso: string,
  toIso: string
): Promise<TnscProxyRow[]> {
  const batch = await fetchAvailabilityDirect(provider, fromIso, toIso);
  return [...batch.entries()].map(([key, v]) => ({
    key,
    availableSites: v.availableSites,
    templates: v.templates,
  }));
}

/** Whether one park has a campsite bookable for the whole stay [fromIso, toIso). */
export async function tnscStayAvailability(
  provider: TnscProvider,
  key: string,
  fromIso: string,
  toIso: string
): Promise<{ available: boolean; availableSites: number }> {
  const batch = await fetchAvailabilityBatch(provider, fromIso, toIso);
  const row = batch.get(key);
  const availableSites = row?.availableSites ?? 0;
  return { available: availableSites > 0, availableSites };
}
