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
import { CAMPING_TEMPLATE_KEYS } from './providers';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ── Catalog ────────────────────────────────────────────────────────────────

export interface TnscPark {
  parkId: number;
  name: string;
  city: string | null;
  /** Site-relative slug from the embedded array, e.g. `/big-ridge`. */
  slug: string;
  lat: number;
  lng: number;
  /** Product categories the park offers, from `data-product` (e.g. camping,cabins). */
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
 * Every park for a provider, parsed from the landing page's embedded JS array
 * (`{ name, city, url:'/slug', parkId, lat, lng }`) enriched with the per-card
 * `data-product` list. Coordinates come embedded — no geocoding needed.
 *
 * TN-ONLY for now: SC's landing does not embed this array (see providers.ts). When
 * SC is verified, branch here on `provider.state`.
 */
export async function fetchParkCatalog(provider: TnscProvider): Promise<TnscPark[]> {
  const { html } = await openPortal(provider);

  // 1. The embedded park objects. Each looks like:
  //    { name: 'Big Ridge State Park', city: 'Maynardville', url: '/big-ridge',
  //      parkId: '25', lat: 36.26, lng: -83.91 }
  const parks = new Map<number, TnscPark>();
  const objRe =
    /name:\s*'([^']+)'\s*,\s*city:\s*'([^']*)'\s*,\s*url:\s*'([^']*)'\s*,\s*parkId:\s*'?(\d+)'?\s*,\s*lat:\s*(-?\d+(?:\.\d+)?)\s*,\s*lng:\s*(-?\d+(?:\.\d+)?)/g;
  for (const m of html.matchAll(objRe)) {
    const parkId = Number(m[4]);
    parks.set(parkId, {
      parkId,
      name: m[1].trim(),
      city: m[2].trim() || null,
      slug: m[3].trim(),
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

/**
 * Short-lived cache of the whole-portal availability batch, keyed by
 * host+range. One POST answers every park, so N watches on the same date range
 * collapse to a single request. TTL keeps us off the portal's rate limit when a
 * user pans the map, mirroring the GoingToCamp 90s cache.
 */
const BATCH_TTL_MS = 90_000;
const batchCache = new Map<string, { at: number; rows: Map<number, TnscParkAvailability> }>();

/**
 * Fetch availability for ALL of a provider's parks over [fromIso, toIso). Returns
 * a map parkId → counts. Does the CSRF handshake, then the single POST.
 *
 * Whole-stay: CONFIRMED (residential, 2026-07-20) — the portal evaluates the
 * fromDate→toDate range as one booking query, so a nonzero `available` reflects
 * sites open for the ENTIRE span, NOT per-night. A 1/3/5-night sweep from one start
 * returned shrinking totals (2140→1742→1686), so we do not intersect per-night.
 */
export async function fetchAvailabilityBatch(
  provider: TnscProvider,
  fromIso: string,
  toIso: string
): Promise<Map<number, TnscParkAvailability>> {
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
): Promise<Map<number, TnscParkAvailability>> {
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

  const out = new Map<number, TnscParkAvailability>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const templates = Array.isArray(row.templates) ? row.templates : [];
    const camping = templates.filter(
      (t) => CAMPING_TEMPLATE_KEYS === null || CAMPING_TEMPLATE_KEYS.has(t.templateKey)
    );
    const availableSites = camping.reduce((n, t) => n + (Number(t.available) || 0), 0);
    out.set(row.accountKey, { availableSites, templates });
  }
  return out;
}

/** Wire form of one park's availability, for the proxy hop. */
export interface TnscProxyRow {
  parkId: number;
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
): Promise<Map<number, TnscParkAvailability>> {
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
  const out = new Map<number, TnscParkAvailability>();
  for (const r of Array.isArray(rows) ? rows : []) {
    out.set(r.parkId, { availableSites: r.availableSites, templates: r.templates ?? [] });
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
  return [...batch.entries()].map(([parkId, v]) => ({
    parkId,
    availableSites: v.availableSites,
    templates: v.templates,
  }));
}

/** Whether one park has a campsite bookable for the whole stay [fromIso, toIso). */
export async function tnscStayAvailability(
  provider: TnscProvider,
  parkId: number,
  fromIso: string,
  toIso: string
): Promise<{ available: boolean; availableSites: number }> {
  const batch = await fetchAvailabilityBatch(provider, fromIso, toIso);
  const row = batch.get(parkId);
  const availableSites = row?.availableSites ?? 0;
  return { available: availableSites > 0, availableSites };
}
