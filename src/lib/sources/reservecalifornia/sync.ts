import { mutate } from '@/lib/db/client';
import { fetchPlaces, fetchFacilities, rcCampgroundId } from './client';
import type { RCPlace, RCFacility } from './client';
import type { SyncResult } from '../types';

/**
 * Booking deep link. The current SPA routes by place; facility-level deep
 * links are not stable, so land users on the park page.
 */
function bookingUrl(placeId: number): string {
  return `https://www.reservecalifornia.com/Web/Default.aspx#!park/${placeId}`;
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

/** Sync all bookable ReserveCalifornia campgrounds into the campgrounds table. */
export async function syncReserveCalifornia(): Promise<SyncResult> {
  const startMs = Date.now();
  const errors: string[] = [];

  const [logRow] = await mutate<{ id: number }>(
    `INSERT INTO sync_log (source, started_at) VALUES ('reservecalifornia', NOW()) RETURNING id`
  );
  const logId = logRow?.id;

  let facilitiesSynced = 0;

  try {
    const [places, facilities] = await Promise.all([fetchPlaces(), fetchFacilities()]);
    const placeById = new Map(places.map((p) => [p.PlaceId, p]));

    const bookable = facilities.filter((f) => {
      if (!f.AllowWebBooking || f.IsTrail) return false;
      const place = placeById.get(f.PlaceId);
      // Facilities carry no coordinates — a campground we can't place on the map is unusable.
      return !!place && !!place.Latitude && !!place.Longitude;
    });

    console.log(
      `[RC sync] ${places.length} places, ${facilities.length} facilities, ${bookable.length} bookable campgrounds`
    );

    for (const facility of bookable) {
      try {
        await upsertFacility(facility, placeById.get(facility.PlaceId)!);
        facilitiesSynced++;
      } catch (err) {
        errors.push(`Facility ${facility.FacilityId}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`Top-level RC sync error: ${(err as Error).message}`);
  }

  const durationMs = Date.now() - startMs;

  await mutate(
    `UPDATE sync_log SET
      finished_at = NOW(), facilities_synced = $1, campsites_synced = 0,
      error = $2, metadata = $3
    WHERE id = $4`,
    [
      facilitiesSynced,
      errors.length > 0 ? errors.slice(0, 10).join('\n') : null,
      JSON.stringify({ durationMs, totalErrors: errors.length }),
      logId,
    ]
  );

  console.log(
    `[RC sync] Done: ${facilitiesSynced} campgrounds in ${(durationMs / 1000).toFixed(1)}s. Errors: ${errors.length}`
  );

  return { facilitiesSynced, campsitesSynced: 0, errors, durationMs };
}
