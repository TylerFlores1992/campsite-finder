import { mutate, query } from '@/lib/db/client';
import { searchCampgroundsNear, searchCampgroundsByState, searchAllCampgrounds, getAllFacilityCampsites, getFacilityMedia } from './client';
import type { RIDBFacility, RIDBMedia } from './client';
import { transformFacility, transformCampsite, deriveCampgroundRollups } from './transform';
import type { SyncOptions, SyncResult } from '../types';
import type { Campground, Campsite } from '@/lib/types';

/**
 * How many facilities are synced at once. Was a hard-coded 15, which was fine until
 * the media fix doubled the per-facility request count on 07-27 and rec.gov began
 * 429ing. Lowered to 8 alongside the media skip and the client's retry; raise only
 * with a clean run's error count to show for it.
 */
const CONCURRENCY = Math.max(1, Number(process.env.RIDB_CONCURRENCY ?? 8));

/**
 * `keepExistingPhotos` makes the UPDATE branch hold the stored photos instead of
 * overwriting them. Needed because the media call is now skipped for rows that already
 * have photos: with no MEDIA the transform yields `photos: []`, and an unconditional
 * `photos = EXCLUDED.photos` would erase the very rows the skip exists to protect —
 * 3,775 of them, silently, on the first run.
 *
 * A FLAG, not a NULL photos param with COALESCE, which is what this tried first:
 * `campgrounds.photos` is NOT NULL, so the proposed INSERT tuple is rejected before
 * the ON CONFLICT branch ever runs. That would have failed every facility that has
 * photos — worse than the bug being fixed. Caught by worker/ridb-photos.test.mts.
 */
async function upsertCampground(cg: Campground, keepExistingPhotos = false): Promise<void> {
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
      photos = CASE WHEN $19 THEN campgrounds.photos ELSE EXCLUDED.photos END,
      last_synced_at = NOW(),
      updated_at = NOW()`,
    [
      cg.id, cg.source, cg.name, cg.description,
      cg.longitude, cg.latitude,
      JSON.stringify(cg.address), cg.amenities, cg.activities,
      cg.environmentTags, cg.siteTypes, cg.reservable,
      cg.reservationsUrl, cg.phone, cg.email,
      cg.adaAccessible, cg.petsAllowed, JSON.stringify(cg.photos), keepExistingPhotos,
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

export async function syncFacility(
  facility: RIDBFacility,
  errors: string[],
  /**
   * Ids that ALREADY have photos stored, so their media call can be skipped. See the
   * media block below. Omitted (e.g. by a test or a one-off) means "fetch media for
   * everything", which is the pre-2026-08-04 behaviour.
   */
  alreadyHavePhotos?: ReadonlySet<string>
): Promise<{ campgrounds: number; campsites: number }> {
  let campgrounds = 0;
  let campsites = 0;

  try {
    // PHOTOS COME FROM A SEPARATE ENDPOINT. `transformFacility` reads
    // `facility.MEDIA`, but the /facilities search never populates it — not even
    // with full=true — so that array was always undefined and every one of the
    // 4,469 RIDB rows stored `photos: []`. Nothing errored; the photo strip, the
    // og:image and the JSON-LD `image` were simply empty sitewide.
    //
    // Merged into the facility rather than passed as a second argument, so the
    // transform stays a pure function of a facility and keeps working unchanged
    // if RIDB ever does start embedding MEDIA.
    //
    // NEVER FATAL. Photos are decorative; campsites are the product. A media
    // failure is recorded and the facility syncs without them, rather than
    // costing us the campground over a picture.
    // SKIP THE MEDIA CALL FOR ROWS THAT ALREADY HAVE PHOTOS (2026-08-04). Fetching
    // media for every facility doubled this sync's request count the day it shipped
    // (07-27), and that is exactly when rec.gov started 429ing us: runs on 07-24..27
    // returned all 116,475 campsites with zero errors, and from 07-28 they went
    // bimodal — ~105k campsites and ~1,000 errors on a good night, ~43k and ~6,200 on
    // a bad one. Campsites are the product; photos are decoration. Spending half our
    // rate budget re-fetching pictures we already have, and losing campsites for it,
    // is the wrong trade.
    //
    // 3,775 of 4,469 rows have photos, so this drops media calls to ~700 a night.
    // The rows WITHOUT photos are still asked every time — about 40% of facilities
    // genuinely have no media in RIDB, so that set is self-limiting and a facility
    // that gains a photo later still picks it up.
    const media = alreadyHavePhotos?.has(facility.FacilityID)
      ? ([] as RIDBMedia[])
      : await getFacilityMedia(facility.FacilityID).catch((err: Error) => {
          errors.push(`Facility ${facility.FacilityID} media: ${err.message}`);
          return [] as RIDBMedia[];
        });

    const campground = transformFacility(
      media.length > 0 ? { ...facility, MEDIA: media } : facility
    );
    // Skipping the media call must not ERASE the photos we skipped it for.
    await upsertCampground(campground, alreadyHavePhotos?.has(facility.FacilityID) ?? false);
    campgrounds++;

    // Always fetch campsites from the per-facility endpoint — the CAMPSITE
    // array embedded in facility search responses omits ATTRIBUTES and
    // PERMITTEDEQUIPMENT (vehicle lengths, pets, hookups).
    const rawCampsites = await getAllFacilityCampsites(facility.FacilityID);

    for (const cs of rawCampsites) {
      try {
        await upsertCampsite(transformCampsite(cs));
        campsites++;
      } catch (err) {
        errors.push(`Campsite ${cs.CampsiteID}: ${(err as Error).message}`);
      }
    }

    // Roll campsite-level facts up to the campground row (site types, pets,
    // electric hookups) — the facility payload alone can't provide these.
    if (rawCampsites.length > 0) {
      const rollups = deriveCampgroundRollups(rawCampsites);
      const extraAmenities = rollups.hasElectric ? ['electric hookup'] : [];
      await mutate(
        `UPDATE campgrounds SET
           site_types = $1,
           pets_allowed = $2,
           amenities = COALESCE((SELECT array_agg(DISTINCT a) FROM unnest(amenities || $3::text[]) a), ARRAY[]::text[]),
           updated_at = NOW()
         WHERE id = $4`,
        [rollups.siteTypes, rollups.petsAllowed, extraAmenities, facility.FacilityID]
      );
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
    national = false,
  } = options;

  const [logRow] = await mutate<{ id: number }>(
    `INSERT INTO sync_log (source, started_at) VALUES ('ridb', NOW()) RETURNING id`
  );
  const logId = logRow?.id;

  let facilitiesSynced = 0;
  let campsitesSynced = 0;

  try {
    let facilities: RIDBFacility[];
    if (national) {
      console.log(`[RIDB sync] Fetching ALL camping facilities nationwide (address-independent)...`);
      facilities = await searchAllCampgrounds(maxFacilities);
    } else if (stateCode) {
      console.log(`[RIDB sync] Fetching campgrounds in state: ${stateCode}...`);
      facilities = await searchCampgroundsByState(stateCode, maxFacilities);
    } else {
      console.log(`[RIDB sync] Searching ${radiusMiles}mi radius around ${lat},${lng}...`);
      facilities = await searchCampgroundsNear(lat, lng, radiusMiles, maxFacilities);
    }
    // One query instead of 4,469 — which facilities already have photos, so their
    // media call can be skipped. Read ONCE here rather than per facility.
    const withPhotos = await query<{ id: string }>(
      `SELECT id FROM campgrounds WHERE source = 'ridb' AND jsonb_array_length(COALESCE(photos,'[]'::jsonb)) > 0`
    ).catch((err: Error) => {
      // Fail OPEN: an empty set just means every facility fetches media, which is the
      // old behaviour. Losing the optimisation is not worth losing the sync.
      console.warn(`[RIDB sync] photo-set read failed (${err.message}) — fetching media for all`);
      return [] as { id: string }[];
    });
    const alreadyHavePhotos = new Set(withPhotos.map((r) => r.id.replace(/^ridb-/, '')));

    console.log(
      `[RIDB sync] Found ${facilities.length} campgrounds — concurrency ${CONCURRENCY}, ` +
      `skipping media for ${alreadyHavePhotos.size} that already have photos`
    );

    const results = await pMap(facilities, (f) => syncFacility(f, errors, alreadyHavePhotos), CONCURRENCY);

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


