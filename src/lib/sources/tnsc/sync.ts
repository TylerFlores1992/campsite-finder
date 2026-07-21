import { mutate } from '@/lib/db/client';
import {
  TNSC_PROVIDERS,
  TNSC_SOURCE,
  TNSC_BBOX,
  tnscId,
  type TnscProvider,
} from './providers';
import { fetchParkCatalog, type TnscPark } from './client';
import type { SyncResult } from '../types';

/**
 * A park must actually offer camping to be a campground row. The portal's
 * `data-product` lists what each park sells (camping, cabins, shelters, programs,
 * golf). If the attribute is missing entirely we keep the park rather than drop it
 * — better a searchable park with an empty availability answer than a silent gap.
 */
function offersCamping(park: TnscPark): boolean {
  if (park.products.length === 0) return true;
  return park.products.some((p) => /camp/i.test(p));
}

function inState(state: string, lng: number, lat: number): boolean {
  const b = TNSC_BBOX[state];
  if (!b) return true;
  return lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3];
}

/** Sync one provider's camping parks into the campgrounds table. */
export async function syncTnsc(provider: TnscProvider): Promise<SyncResult> {
  const startMs = Date.now();
  const errors: string[] = [];

  if (!provider.verified) {
    // SC (and any future unverified state) is intentionally not synced — its
    // catalog parse is unproven. Fail loudly rather than write half a catalog.
    return {
      facilitiesSynced: 0,
      campsitesSynced: 0,
      errors: [`TNSC ${provider.state}: provider not verified — recon required before sync`],
      durationMs: Date.now() - startMs,
    };
  }

  const [logRow] = await mutate<{ id: number }>(
    `INSERT INTO sync_log (source, started_at) VALUES ($1, NOW()) RETURNING id`,
    [`${TNSC_SOURCE}-${provider.state}`]
  );
  const logId = logRow?.id;

  let facilitiesSynced = 0;
  try {
    const all = await fetchParkCatalog(provider);
    const parks = all.filter(offersCamping);
    console.log(
      `[TNSC ${provider.state} sync] ${all.length} parks, ${parks.length} offering camping`
    );

    for (const park of parks) {
      if (!Number.isFinite(park.lat) || !Number.isFinite(park.lng)) {
        errors.push(`${provider.state} ${park.parkId} (${park.name}): no coords`);
        continue;
      }
      if (!inState(provider.state, park.lng, park.lat)) {
        errors.push(
          `${provider.state} ${park.parkId} (${park.name}): coords outside state (${park.lat},${park.lng})`
        );
        continue;
      }

      const id = tnscId(provider, park.parkId);
      try {
        await mutate(
          `INSERT INTO campgrounds (
            id, source, name, description, location,
            address, amenities, activities, environment_tags, site_types,
            reservable, reservations_url, phone, email,
            ada_accessible, pets_allowed, photos, last_synced_at, updated_at
          ) VALUES (
            $1, '${TNSC_SOURCE}', $2, NULL,
            ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
            $5, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
            true, $6, NULL, NULL,
            false, true, '[]'::jsonb, NOW(), NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, location = EXCLUDED.location,
            address = EXCLUDED.address, reservations_url = EXCLUDED.reservations_url,
            last_synced_at = NOW(), updated_at = NOW()`,
          [
            id,
            park.name,
            park.lng,
            park.lat,
            JSON.stringify({ street: null, city: park.city, state: provider.state, zip: null }),
            // Deep-link to the park's own portal page where possible; the slug is
            // site-relative on the marketing host, so fall back to the booking root.
            provider.bookingUrl,
          ]
        );
        facilitiesSynced++;
      } catch (err) {
        errors.push(`${id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`Top-level TNSC ${provider.state} error: ${(err as Error).message}`);
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
    `[TNSC ${provider.state} sync] Done: ${facilitiesSynced} parks in ${(durationMs / 1000).toFixed(1)}s. Errors: ${errors.length}`
  );
  return { facilitiesSynced, campsitesSynced: 0, errors, durationMs };
}

/** Sync every VERIFIED provider (skips unverified states like SC). */
export async function syncAllTnsc(): Promise<SyncResult> {
  const agg: SyncResult = { facilitiesSynced: 0, campsitesSynced: 0, errors: [], durationMs: 0 };
  for (const provider of TNSC_PROVIDERS) {
    if (!provider.verified) continue;
    const r = await syncTnsc(provider);
    agg.facilitiesSynced += r.facilitiesSynced;
    agg.errors.push(...r.errors);
    agg.durationMs += r.durationMs;
  }
  return agg;
}
