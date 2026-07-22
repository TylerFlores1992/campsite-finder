import { mutate } from '@/lib/db/client';
import {
  GOINGTOCAMP_PROVIDERS,
  GOINGTOCAMP_SOURCE,
  goingToCampId,
  type GoingToCampProvider,
} from './providers';
import { fetchLocations, parseGpsCoordinates, goingToCampBookingBase, type GtcLocation } from './client';
import type { SyncResult } from '../types';

/**
 * Rows that aren't campgrounds. The location list mixes in trails, harbors and
 * junk entries (Wisconsin literally lists one called "Internet"). Availability
 * would just come back empty for these, but they'd still clutter search results.
 */
const NON_CAMPGROUND = /\b(trail|internet|day\s*use|golf|museum|office|headquarters)\b/i;

/**
 * Coordinates: only Washington ships them reliably (136/167). MI has 15, WI and
 * MS have none — so most rows are geocoded from their FULL street address.
 * That's deliberate: ReserveAmerica's name-only geocoding put Allegany in NYC,
 * whereas "4235 State Park Rd, Sardis, Mississippi 38666" is unambiguous. Rows
 * with neither coords nor a street address are skipped rather than guessed at.
 */
async function geocode(loc: GtcLocation, provider: GoingToCampProvider): Promise<[number, number] | null> {
  const direct = parseGpsCoordinates(loc.gpsCoordinates);
  if (direct) return direct;

  const v = loc.localizedValues?.[0] ?? {};
  const street = (v.streetAddress ?? '').trim();
  const city = (v.city ?? '').trim();
  if (!street || !city) return null;

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;

  const zip = (loc.regionCode ?? '').trim();
  const query = [street, city, loc.region ?? provider.state, zip].filter(Boolean).join(', ');
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?access_token=${token}&country=us&limit=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { features?: { center?: [number, number] }[] };
    const center = json.features?.[0]?.center;
    return center && center.length === 2 ? [center[0], center[1]] : null;
  } catch {
    return null;
  }
}

/** Rough per-state bounding box, so a bad geocode can't land a park in another state. */
const BBOX: Record<string, [number, number, number, number]> = {
  // [minLat, maxLat, minLng, maxLng]
  WA: [45.5, 49.1, -124.9, -116.9],
  MI: [41.6, 48.3, -90.5, -82.1],
  WI: [42.4, 47.1, -92.9, -86.8],
  MS: [30.1, 35.1, -91.7, -88.0],
};

function inState(state: string, lng: number, lat: number): boolean {
  const b = BBOX[state];
  if (!b) return true;
  return lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3];
}

async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    })
  );
  return results;
}

/** Sync one GoingToCamp tenant's campgrounds. */
export async function syncGoingToCamp(provider: GoingToCampProvider): Promise<SyncResult> {
  const startMs = Date.now();
  const errors: string[] = [];
  const [logRow] = await mutate<{ id: number }>(
    `INSERT INTO sync_log (source, started_at) VALUES ($1, NOW()) RETURNING id`,
    [`goingtocamp-${provider.state}`]
  );
  const logId = logRow?.id;

  let facilitiesSynced = 0;
  try {
    const all = await fetchLocations(provider);
    const locations = all.filter((l) => {
      const name = l.localizedValues?.[0]?.fullName ?? '';
      return name.trim().length > 0 && !NON_CAMPGROUND.test(name);
    });
    console.log(
      `[GTC ${provider.state} sync] ${all.length} locations, ${locations.length} after filtering non-campgrounds`
    );

    // Concurrency stays low: the tenants' Azure WAF challenges bursty traffic.
    await pMap(
      locations,
      async (loc) => {
        const v = loc.localizedValues?.[0] ?? {};
        const name = (v.fullName ?? '').trim();
        const coords = await geocode(loc, provider);
        if (!coords) {
          errors.push(`${provider.state} ${loc.resourceLocationId} (${name}): no coords or address`);
          return;
        }
        if (!inState(provider.state, coords[0], coords[1])) {
          errors.push(
            `${provider.state} ${loc.resourceLocationId} (${name}): geocode outside state (${coords[1]},${coords[0]})`
          );
          return;
        }

        const id = goingToCampId(provider, loc.resourceLocationId);
        try {
          await mutate(
            `INSERT INTO campgrounds (
              id, source, name, description, location,
              address, amenities, activities, environment_tags, site_types,
              reservable, reservations_url, phone, email,
              ada_accessible, pets_allowed, photos, last_synced_at, updated_at
            ) VALUES (
              $1, '${GOINGTOCAMP_SOURCE}', $2, $3,
              ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
              $6, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
              true, $7, $8, $9,
              false, true, '[]'::jsonb, NOW(), NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name, description = EXCLUDED.description,
              location = EXCLUDED.location, address = EXCLUDED.address,
              reservations_url = EXCLUDED.reservations_url,
              phone = EXCLUDED.phone, email = EXCLUDED.email,
              last_synced_at = NOW(), updated_at = NOW()`,
            [
              id,
              name,
              (v.description ?? '').trim() || null,
              coords[0],
              coords[1],
              JSON.stringify({
                street: (v.streetAddress ?? '').trim() || null,
                city: (v.city ?? '').trim() || null,
                state: provider.state,
                zip: (loc.regionCode ?? '').trim() || null,
              }),
              // Store the create-booking deep-link base (dates appended by
              // booking-url.ts); fall back to the tenant root for day-use parks that
              // can't be deep-linked (no rootMapId).
              goingToCampBookingBase(provider.bookingUrl, loc) ?? provider.bookingUrl,
              (loc.phoneNumber ?? '').trim() || null,
              (loc.email ?? '').trim() || null,
            ]
          );
          facilitiesSynced++;
        } catch (err) {
          errors.push(`${id}: ${(err as Error).message}`);
        }
      },
      3
    );
  } catch (err) {
    errors.push(`Top-level GTC ${provider.state} error: ${(err as Error).message}`);
  }

  const durationMs = Date.now() - startMs;
  await mutate(
    `UPDATE sync_log SET finished_at = NOW(), facilities_synced = $1, campsites_synced = 0, error = $2, metadata = $3 WHERE id = $4`,
    [
      facilitiesSynced,
      errors.length ? errors.slice(0, 10).join('\n') : null,
      JSON.stringify({ durationMs, totalErrors: errors.length }),
      logId,
    ]
  );
  console.log(
    `[GTC ${provider.state} sync] Done: ${facilitiesSynced} campgrounds in ${(durationMs / 1000).toFixed(1)}s. Errors: ${errors.length}`
  );
  return { facilitiesSynced, campsitesSynced: 0, errors, durationMs };
}

/** Sync every configured GoingToCamp tenant. */
export async function syncAllGoingToCamp(): Promise<SyncResult> {
  const agg: SyncResult = { facilitiesSynced: 0, campsitesSynced: 0, errors: [], durationMs: 0 };
  for (const provider of GOINGTOCAMP_PROVIDERS) {
    const r = await syncGoingToCamp(provider);
    agg.facilitiesSynced += r.facilitiesSynced;
    agg.errors.push(...r.errors);
    agg.durationMs += r.durationMs;
  }
  return agg;
}
