import { mutate } from '@/lib/db/client';
import { RA_CONTRACTS, type RAContract } from './client';
import { fetchParkCatalog, fetchParkLocation, raSession } from './catalog';
import { geocodeAddress, inState } from '../geocode';
import type { SyncResult } from '../types';

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }));
  return results;
}

/** Sync one ReserveAmerica contract's camping parks into the campgrounds table. */
export async function syncReserveAmerica(contract: RAContract): Promise<SyncResult> {
  const startMs = Date.now();
  const errors: string[] = [];
  const [logRow] = await mutate<{ id: number }>(
    `INSERT INTO sync_log (source, started_at) VALUES ($1, NOW()) RETURNING id`,
    [`reserveamerica-${contract.contractCode}`]
  );
  const logId = logRow?.id;

  let facilitiesSynced = 0;
  try {
    const parks = await fetchParkCatalog(contract);
    console.log(`[RA ${contract.contractCode} sync] ${parks.length} camping parks`);
    const cookie = await raSession(contract.host);

    await pMap(
      parks,
      async (p) => {
        // Coordinates, or the park's postal address to fall back on. Until 2026-08-04
        // a park whose page carried no usable coordinates was simply DROPPED — 16 of
        // them across 11 contracts, invisible in search and unwatchable. The portal
        // publishes `0.0, -0.0` rather than nothing for some of these, which is why
        // the coordinate check is `isRealCoord` and not a null test.
        const { coords: direct, address } = await fetchParkLocation(contract, p.detailPath, cookie);
        let coords = direct;
        if (!coords) {
          // ADDRESS, never name. "Clough State Park, New Hampshire" geocodes to the
          // state centroid — a confident, plausible, wrong pin ~40 miles out. See
          // src/lib/sources/geocode.ts.
          const geo = await geocodeAddress({ ...address, state: address.state ?? contract.state });
          if (geo && !inState(contract.state, geo[0], geo[1])) {
            errors.push(`${contract.contractCode} ${p.parkId} (${p.name}): geocode outside ${contract.state} (${geo[1]},${geo[0]})`);
            return;
          }
          coords = geo;
        }
        if (!coords) {
          // Fail LOUD, as the SC portal does: a park with neither coordinates nor a
          // street address needs a human, not a guessed position.
          const why = address.street && address.city ? 'geocode failed' : 'no coords and no street address';
          errors.push(`${contract.contractCode} ${p.parkId} (${p.name}): ${why}`);
          return;
        }
        const id = `ra-${contract.contractCode}-${p.parkId}`;
        const url = `https://${contract.host}/campsiteCalendar.do?page=matrix&contractCode=${contract.contractCode}&parkId=${p.parkId}`;
        try {
          await mutate(
            `INSERT INTO campgrounds (
              id, source, name, description, location,
              address, amenities, activities, environment_tags, site_types,
              reservable, reservations_url, phone, email,
              ada_accessible, pets_allowed, photos, last_synced_at, updated_at
            ) VALUES (
              $1, 'reserveamerica', $2, NULL,
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
              titleCase(p.name),
              coords[0],
              coords[1],
              JSON.stringify({ street: null, city: null, state: contract.state, zip: null }),
              url,
            ]
          );
          facilitiesSynced++;
        } catch (err) {
          errors.push(`${id}: ${(err as Error).message}`);
        }
      },
      5
    );
  } catch (err) {
    errors.push(`Top-level RA ${contract.contractCode} error: ${(err as Error).message}`);
  }

  const durationMs = Date.now() - startMs;
  await mutate(
    `UPDATE sync_log SET finished_at = NOW(), facilities_synced = $1, campsites_synced = 0, error = $2, metadata = $3 WHERE id = $4`,
    [facilitiesSynced, errors.length ? errors.slice(0, 10).join('\n') : null, JSON.stringify({ durationMs, totalErrors: errors.length }), logId]
  );
  console.log(`[RA ${contract.contractCode} sync] Done: ${facilitiesSynced} parks in ${(durationMs / 1000).toFixed(1)}s. Errors: ${errors.length}`);
  return { facilitiesSynced, campsitesSynced: 0, errors, durationMs };
}

/** Sync every configured ReserveAmerica contract. */
export async function syncAllReserveAmerica(): Promise<SyncResult> {
  const agg: SyncResult = { facilitiesSynced: 0, campsitesSynced: 0, errors: [], durationMs: 0 };
  for (const contract of RA_CONTRACTS) {
    const r = await syncReserveAmerica(contract);
    agg.facilitiesSynced += r.facilitiesSynced;
    agg.errors.push(...r.errors);
    agg.durationMs += r.durationMs;
  }
  return agg;
}
