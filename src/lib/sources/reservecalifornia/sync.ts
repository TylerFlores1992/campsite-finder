import { mutate } from '@/lib/db/client';
import { fetchPlaces, fetchFacilities, fetchUnitTypes, fetchGrid, rcCampgroundId } from './client';
import type { RCPlace, RCFacility, RCGridUnit } from './client';
import type { SyncResult } from '../types';

/** Booking deep link — the current SPA serves park pages at /park/{PlaceId}. */
function bookingUrl(placeId: number): string {
  return `https://www.reservecalifornia.com/park/${placeId}`;
}

async function upsertFacility(facility: RCFacility, place: RCPlace): Promise<void> {
  const address = {
    street: place.Address1 ?? null,
    city: place.City ?? null,
    state: place.State ?? 'CA',
    zip: place.Zip ?? null,
  };

  await mutate(
    `INSERT INTO campgrounds (
      id, source, name, description, location,
      address, amenities, activities, environment_tags, site_types,
      reservable, reservations_url, phone, email,
      ada_accessible, pets_allowed, photos, last_synced_at, updated_at
    ) VALUES (
      $1, 'reservecalifornia', $2, $3,
      ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
      $6, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
      true, $7, $8, NULL,
      false, true, '[]'::jsonb, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      location = EXCLUDED.location,
      address = EXCLUDED.address,
      reservations_url = EXCLUDED.reservations_url,
      phone = EXCLUDED.phone,
      last_synced_at = NOW(),
      updated_at = NOW()`,
    [
      rcCampgroundId(facility.FacilityId),
      // Prefix with the park name when the facility name doesn't already include it.
      facility.Name.toLowerCase().includes(place.Name.slice(0, 8).toLowerCase())
        ? facility.Name
        : `${place.Name} — ${facility.Name}`,
      facility.Description !== facility.Name ? facility.Description : place.Description,
      place.Longitude,
      place.Latitude,
      JSON.stringify(address),
      bookingUrl(place.PlaceId),
      place.VoicePhone,
    ]
  );
}

function rcSiteType(unitName: string, typeName: string): string {
  const t = `${unitName} ${typeName}`.toLowerCase();
  if (/cabin|cottage|lodge/.test(t)) return 'cabin';
  if (/yurt/.test(t)) return 'yurt';
  if (/group/.test(t)) return 'group';
  if (/\brv\b|hook ?up|trailer|premium/.test(t)) return 'rv';
  return 'tent';
}

function rcIsElectric(unitName: string, typeName: string): boolean {
  const t = `${unitName} ${typeName}`.toLowerCase();
  return /hook ?up|\(e\s*\)|\(ew\s*\)|\(ews\s*\)|electric/.test(t);
}

async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Fetch a facility's units (1-night grid, off-season included) and sync them as campsites. */
async function syncFacilityUnits(
  facilityId: number,
  typeNames: Map<number, string>,
  errors: string[]
): Promise<number> {
  const campgroundId = rcCampgroundId(facilityId);
  const startDate = new Date().toISOString().slice(0, 10);
  const end = new Date();
  end.setDate(end.getDate() + 1);
  const endDate = end.toISOString().slice(0, 10);

  let units: RCGridUnit[] = [];
  try {
    const grid = await fetchGrid(facilityId, startDate, endDate);
    units = Object.values(grid.Facility?.Units ?? {});
  } catch (err) {
    errors.push(`RC grid ${facilityId}: ${(err as Error).message}`);
    return 0;
  }
  if (units.length === 0) return 0;

  const siteTypes = new Set<string>();
  let hasElectric = false;
  let synced = 0;

  for (const unit of units) {
    const typeName = typeNames.get(unit.UnitTypeId) ?? '';
    const type = rcSiteType(unit.Name, typeName);
    siteTypes.add(type);
    // A vehicle length on a non-RV-named unit still means an RV can park there.
    if (unit.VehicleLength > 0) siteTypes.add('rv');
    if (rcIsElectric(unit.Name, typeName)) hasElectric = true;

    try {
      await mutate(
        `INSERT INTO campsites (
          id, campground_id, name, type, loop,
          max_occupants, max_vehicle_length,
          ada_accessible, pets_allowed, reservable, attributes, updated_at
        ) VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,true,$7,$8,NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, type = EXCLUDED.type,
          max_vehicle_length = EXCLUDED.max_vehicle_length,
          ada_accessible = EXCLUDED.ada_accessible,
          reservable = EXCLUDED.reservable,
          attributes = EXCLUDED.attributes,
          updated_at = NOW()`,
        [
          `rc-unit-${unit.UnitId}`,
          campgroundId,
          unit.Name,
          type,
          unit.VehicleLength > 0 ? unit.VehicleLength : null,
          unit.IsAda,
          unit.AllowWebBooking,
          JSON.stringify({ unitType: typeName }),
        ]
      );
      synced++;
    } catch (err) {
      errors.push(`RC unit ${unit.UnitId}: ${(err as Error).message}`);
    }
  }

  const extraAmenities = hasElectric ? ['electric hookup'] : [];
  await mutate(
    `UPDATE campgrounds SET
       site_types = $1,
       amenities = COALESCE((SELECT array_agg(DISTINCT a) FROM unnest(amenities || $2::text[]) a), ARRAY[]::text[]),
       updated_at = NOW()
     WHERE id = $3`,
    [[...siteTypes], extraAmenities, campgroundId]
  ).catch((err) => errors.push(`RC rollup ${facilityId}: ${(err as Error).message}`));

  return synced;
}

/** Sync all bookable ReserveCalifornia campgrounds into the campgrounds table. */
export async function syncReserveCalifornia(): Promise<SyncResult> {
  const startMs = Date.now();
  const errors: string[] = [];

  const [logRow] = await mutate<{ id: number }>(
    `INSERT INTO sync_log (source, started_at) VALUES ('reservecalifornia', NOW()) RETURNING id`
  );
  const logId = logRow?.id;

  let facilitiesSynced = 0;
  let campsitesSynced = 0;

  try {
    const [places, facilities, unitTypes] = await Promise.all([
      fetchPlaces(),
      fetchFacilities(),
      fetchUnitTypes().catch(() => []),
    ]);
    const placeById = new Map(places.map((p) => [p.PlaceId, p]));
    const typeNames = new Map(unitTypes.map((t) => [t.UnitTypeId, t.Name]));

    const bookable = facilities.filter((f) => {
      if (!f.AllowWebBooking || f.IsTrail) return false;
      const place = placeById.get(f.PlaceId);
      // Facilities carry no coordinates — a campground we can't place on the map is unusable.
      return !!place && !!place.Latitude && !!place.Longitude;
    });

    console.log(
      `[RC sync] ${places.length} places, ${facilities.length} facilities, ${bookable.length} bookable campgrounds, ${unitTypes.length} unit types`
    );

    for (const facility of bookable) {
      try {
        await upsertFacility(facility, placeById.get(facility.PlaceId)!);
        facilitiesSynced++;
      } catch (err) {
        errors.push(`Facility ${facility.FacilityId}: ${(err as Error).message}`);
      }
    }

    // Sync each facility's units as campsites (hookups, vehicle lengths, ADA).
    const unitCounts = await pMap(
      bookable,
      (f) => syncFacilityUnits(f.FacilityId, typeNames, errors),
      5
    );
    campsitesSynced = unitCounts.reduce((a, b) => a + b, 0);
  } catch (err) {
    errors.push(`Top-level RC sync error: ${(err as Error).message}`);
  }

  const durationMs = Date.now() - startMs;

  await mutate(
    `UPDATE sync_log SET
      finished_at = NOW(), facilities_synced = $1, campsites_synced = $2,
      error = $3, metadata = $4
    WHERE id = $5`,
    [
      facilitiesSynced,
      campsitesSynced,
      errors.length > 0 ? errors.slice(0, 10).join('\n') : null,
      JSON.stringify({ durationMs, totalErrors: errors.length }),
      logId,
    ]
  );

  console.log(
    `[RC sync] Done: ${facilitiesSynced} campgrounds, ${campsitesSynced} units in ${(durationMs / 1000).toFixed(1)}s. Errors: ${errors.length}`
  );

  return { facilitiesSynced, campsitesSynced, errors, durationMs };
}
