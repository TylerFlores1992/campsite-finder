// GoingToCamp (Camis) API client.
//
// Clean JSON API, no auth. Two things to know before changing anything here:
//
// 1. AVAILABILITY IS WHOLE-STAY, NOT PER-NIGHT. The per-resource array stays
//    length 1 no matter how many nights the range spans — the API evaluates all of
//    [startDate, endDate) and returns one verdict per site. That matches CampHawk's
//    "one site, all consecutive nights" rule natively, so unlike ReserveAmerica we
//    do NOT intersect per-night sets.
//
// 2. `availability === 0` MEANS AVAILABLE. It's a plain enum, not a bitmask, and
//    it reads backwards from what you'd guess. Recovered from the app's own source,
//    where the bookable test is literally
//    `resourceAvailabilities[id].every(s => s.availability === Available)`.

import type { GoingToCampProvider } from './providers';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Camis resource availability enum. 0 is Available — do not invert this. */
export enum GtcAvailability {
  Available = 0,
  Unavailable = 1,
  NotOperating = 2,
  NonReservable = 3,
  Closed = 4,
  Invalid = 5,
  InvalidBookingCategory = 6,
  /** Only part of the requested range is free → NOT bookable for the whole stay. */
  PartiallyAvailable = 7,
  /** Cancelled but not yet released (cf. ReserveCalifornia's `Lock`). */
  Held = 8,
}

export interface GtcLocalizedValues {
  cultureName?: string;
  fullName?: string;
  shortName?: string;
  description?: string;
  streetAddress?: string;
  city?: string;
  website?: string;
}

export interface GtcLocation {
  resourceLocationId: number;
  gpsCoordinates?: string; // "lat, lng" STRING — not numeric fields
  region?: string;
  regionCode?: string; // zip
  country?: string;
  phoneNumber?: string;
  email?: string;
  localizedValues?: GtcLocalizedValues[];
}

interface GtcResourceSlice {
  availability: number;
  remainingQuota: number | null;
}

interface GtcMapAvailability {
  mapId: number;
  mapAvailabilities?: number[];
  resourceAvailabilities?: Record<string, GtcResourceSlice[]>;
}

/**
 * Fetch from a tenant's API.
 *
 * Three things about the Azure WAF in front of these hosts, all measured:
 *
 * 1. **`UA` below is load-bearing — do not shorten it.** The WAF rejects requests
 *    without a realistic full browser User-Agent with a `403` + HTML challenge
 *    page. `Mozilla/5.0`, `curl/8.5.0` and a bare `fetch()` with no UA all 403
 *    even from a residential IP; the full string returns 200.
 * 2. **Vercel's IPs are blocked, the Fly worker's are not** — the reverse of the
 *    UseDirect situation, so there is deliberately no proxy here. Verified: the
 *    worker's startup probe reads 167 WA locations directly, while the same
 *    request from a Vercel route 403s. That's why the search-path adapter throws
 *    rather than reporting "not available" (see availability/goingtocamp.ts).
 * 3. **Bursty traffic gets challenged even from an allowed IP**, and clears once
 *    traffic is spaced out. That's a rate limit, so back off and retry rather
 *    than failing the sync — and keep concurrency low at call sites.
 */
async function gtcFetch<T>(
  provider: GoingToCampProvider,
  path: string,
  query: Record<string, string | number> = {},
  attempt = 0
): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)])
  ).toString();
  const res = await fetch(`https://${provider.host}${path}${qs ? `?${qs}` : ''}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `https://${provider.host}/` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();

  const challenged = body.includes('Azure WAF') || body.includes('.azwaf');
  if ((challenged || res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return gtcFetch<T>(provider, path, query, attempt + 1);
  }
  if (challenged) throw new Error(`GTC ${provider.state}: WAF challenge on ${path} after retries`);
  if (!res.ok) throw new Error(`GTC ${provider.state}: ${res.status} on ${path}`);

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`GTC ${provider.state}: non-JSON response on ${path}`);
  }
}

/** Every bookable location for a tenant (parks, harbors, trails — filter later). */
export async function fetchLocations(provider: GoingToCampProvider): Promise<GtcLocation[]> {
  const rows = await gtcFetch<GtcLocation[]>(provider, '/api/resourcelocation');
  return Array.isArray(rows) ? rows : [];
}

/** Parse the `"lat, lng"` string into [lng, lat] (PostGIS order), or null. */
export function parseGpsCoordinates(gps: string | undefined): [number, number] | null {
  const m = String(gps ?? '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

export interface GtcStayResult {
  /** At least one site is bookable for the entire stay. */
  available: boolean;
  /** Resource ids bookable for the entire stay. */
  resourceIds: number[];
  /** Resource ids cancelled-but-held — bookable soon, not yet. */
  heldResourceIds: number[];
}

/**
 * Booking categories, from the app's own enum. We query `Nightly` — overnight
 * stays. This matters: these tenants also sell day-use and rentals through the
 * same API (Mississippi lists Museum Entry, Golf Cart, Kayak, Birthday Party and
 * Fireworks Show as bookable resources), and querying across all categories would
 * let a kayak rental trigger a campground alert.
 *
 * Note `Nightly` spans campsites AND lodging (cabins, cottages, motel rooms) —
 * so a cabin opening can satisfy a watch on a park that has both. That's
 * deliberate; filter by resource category here if that ever needs narrowing.
 */
export enum GtcBookingCategory {
  Nightly = 0,
  DayUse = 1,
  FixedLength = 2,
  PartialSeasonal = 3,
  Rental = 4,
  BackCountry = 5,
}

/**
 * Which sites at a location are bookable for the WHOLE stay [startDate, endDate).
 * A site qualifies only if every slice it returns is `Available`, mirroring the
 * app's own `.every(...)` test.
 */
export async function gtcStayAvailability(
  provider: GoingToCampProvider,
  resourceLocationId: number,
  startDate: string,
  endDate: string
): Promise<GtcStayResult> {
  const maps = await gtcFetch<GtcMapAvailability[]>(provider, '/api/availability/resourcelocation', {
    resourceLocationId,
    bookingCategoryId: GtcBookingCategory.Nightly,
    startDate,
    endDate,
  });

  const resourceIds: number[] = [];
  const heldResourceIds: number[] = [];
  for (const map of Array.isArray(maps) ? maps : []) {
    for (const [id, slices] of Object.entries(map.resourceAvailabilities ?? {})) {
      if (!Array.isArray(slices) || slices.length === 0) continue;
      if (slices.every((s) => s.availability === GtcAvailability.Available)) {
        resourceIds.push(Number(id));
      } else if (slices.some((s) => s.availability === GtcAvailability.Held)) {
        heldResourceIds.push(Number(id));
      }
    }
  }
  return { available: resourceIds.length > 0, resourceIds, heldResourceIds };
}
