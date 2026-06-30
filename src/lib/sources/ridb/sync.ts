import { mutate } from '@/lib/db/client';
import { searchCampgroundsNear, searchCampgroundsByState, getAllFacilityCampsites } from './client';
import type { RIDBFacility } from './client';
import { transformFacility, transformCampsite } from './transform';
import type { SyncOptions, SyncResult } from '../types';
import type { Campground, Campsite } from '@/lib/types';

async function upsertCampground(cg: Campground): Promise<void> {
  await mutate(
    `INSERT INTO campgrounds (
      id, source, name, description, location,
      address, amenities, activities, environment_tags, site_types,
      reservable, reservations_url, phone, email,
      ada_accessible, pets_allowed, photos, last_synced_at, updated_at
    ) VALUES (
      $1, $2, $3, $4,
      ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15,
      $16, $17, $18, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      location = EXCLUDED.location,
      address = EXCLUDED.address,
      amenities = EXCLUDED.amenities,
      activities = EXCLUDED.activities,
      environment_tags = EXCLUDED.environment_tags,
      site_types = EXCLUDED.site_types,
      reservable = EXCLUDED.reservable,
      reservations_url = EXCLUDED.reservations_url,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      ada_accessible = EXCLUDED.ada_accessible,
      pets_allowed = EXCLUDED.pets_allowed,
      photos = EXCLUDED.photos,
      last_synced_at = NOW(),
      updated_at = NOW()`,
    [
      cg.id, cg.source, cg.name, cg.description,
      cg.longitude, cg.latitude,
      JSON.stringify(cg.address), cg.amenities, cg.activities,
      cg.environmentTags, cg.siteTypes, cg.reservable,
      cg.reservationsUrl, cg.phone, cg.email,
      cg.adaAccessible, cg.petsAllowed, JSON.stringify(cg.photos),
    ]
  );
}

async function upsertCampsite(cs: Campsite): Promise<void> {
  await mutate(
    `INSERT INTO campsites (
      id, campground_id, name, type, loop,
      max_occupants, max_vehicle_length,
      ada_accessible, pets_allowed, reservable, attributes, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, type = EXCLUDED.type, loop = EXCLUDED.loop,
      max_occupants = EXCLUDED.max_occupants,
      max_vehicle_length = EXCLUDED.max_vehicle_length,
      ada_accessible = EXCLUDED.ada_accessible,
      pets_allowed = EXCLUDED.pets_allowed,
      reservable = EXCLUDED.reservable,
      attributes = EXCLUDED.attributes,
      updated_at = NOW()`,
    [
      cs.id, cs.campgroundId, cs.name, cs.type, cs.loop,
      cs.maxOccupants, cs.maxVehicleLength,
      cs.adaAccessible, cs.petsAllowed, cs.reservable,
      JSON.stringify(cs.attributes),
    ]
  );
}

/** Run fn over items with at most `limit` concurrent executions. */
async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit = 10
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function syncFacility(
  facility: RIDBFacility,
  errors: string[]
): Promise<{ campgrounds: number; campsites: number }> {
  let campgrounds = 0;
  let campsites = 0;

  try {
    const campground = transformFacility(facility);
    await upsertCampground(campground);
    campgrounds++;

    // Use campsite data already embedded in the full=true response.
    // Only do a separate fetch if the facility returned no campsites.
    let rawCampsites = facility.CAMPSITE ?? [];
    if (rawCampsites.length === 0) {
      rawCampsites = await getAllFacilityCampsites(facility.FacilityID);
    }

    for (const cs of rawCampsites) {
      try {
        await upsertCampsite(transformCampsite(cs));
        campsites++;
      } catch (err) {
        errors.push(`Campsite ${cs.CampsiteID}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`Facility ${facility.FacilityID}: ${(err as Error).message}`);
  }

  return { campgrounds, campsites };
}

export async function syncRIDB(options: SyncOptions = {}): Promise<SyncResult> {
  const startMs = Date.now();
  const errors: string[] = [];

  const {
    lat = 39.5,
    lng = -98.35,
    radiusMiles = 300,
    maxFacilities = 2000,
    stateCode,
  } = options;

  const [logRow] = await mutate<{ id: number }>(
    `INSERT INTO sync_log (source, started_at) VALUES ('ridb', NOW()) RETURNING id`
  );
  const logId = logRow?.id;

  let facilitiesSynced = 0;
  let campsitesSynced = 0;

  try {
    let facilities: RIDBFacility[];
    if (stateCode) {
      console.log(`[RIDB sync] Fetching campgrounds in state: ${stateCode}...`);
      facilities = await searchCampgroundsByState(stateCode, maxFacilities);
    } else {
      console.log(`[RIDB sync] Searching ${radiusMiles}mi radius around ${lat},${lng}...`);
      facilities = await searchCampgroundsNear(lat, lng, radiusMiles, maxFacilities);
    }
    console.log(`[RIDB sync] Found ${facilities.length} campgrounds â€” syncing with concurrency 15...`);

    // Process 15 facilities at a time â€” fast but respectful to RIDB's API
    const results = await pMap(facilities, (f) => syncFacility(f, errors), 15);

    for (const r of results) {
      facilitiesSynced += r.campgrounds;
      campsitesSynced += r.campsites;
    }
  } catch (err) {
    errors.push(`Top-level sync error: ${(err as Error).message}`);
  }

  const durationMs = Date.now() - startMs;

  await mutate(
    `UPDATE sync_log SET
      finished_at = NOW(), facilities_synced = $1, campsites_synced = $2,
      error = $3, metadata = $4
    WHERE id = $5`,
    [
      facilitiesSynced, campsitesSynced,
      errors.length > 0 ? errors.slice(0, 10).join('\n') : null,
      JSON.stringify({ durationMs, totalErrors: errors.length }),
      logId,
    ]
  );

  console.log(
    `[RIDB sync] Done: ${facilitiesSynced} facilities, ${campsitesSynced} campsites in ${(durationMs/1000).toFixed(1)}s. Errors: ${errors.length}`
  );

  return { facilitiesSynced, campsitesSynced, errors, durationMs };
}


