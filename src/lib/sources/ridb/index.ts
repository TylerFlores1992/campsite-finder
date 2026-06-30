import { query, queryOne } from '@/lib/db/client';
import { getCached, setCached } from '@/lib/cache/redis';
import type { Campground, Campsite, CampgroundAvailability, SearchParams } from '@/lib/types';
import type { CampgroundSource, SyncOptions, SyncResult } from '../types';
import { syncRIDB } from './sync';
import { getAvailabilityFromRecGov } from '@/lib/availability/recgov';

// Map DB row (snake_case) to Campground type (camelCase)
function rowToCampground(row: Record<string, unknown>): Campground {
  return {
    id: row.id as string,
    source: row.source as string,
    name: row.name as string,
    description: row.description as string | null,
    latitude: parseFloat(row.latitude as string),
    longitude: parseFloat(row.longitude as string),
    address: (row.address ?? {}) as Campground['address'],
    amenities: (row.amenities ?? []) as string[],
    activities: (row.activities ?? []) as string[],
    environmentTags: (row.environment_tags ?? []) as string[],
    siteTypes: (row.site_types ?? []) as string[],
    reservable: row.reservable as boolean,
    reservationsUrl: row.reservations_url as string | null,
    phone: row.phone as string | null,
    email: row.email as string | null,
    adaAccessible: row.ada_accessible as boolean,
    petsAllowed: row.pets_allowed as boolean,
    photos: (row.photos ?? []) as Campground['photos'],
    lastSyncedAt: row.last_synced_at as string | null,
    distanceMiles: row.distance_miles ? parseFloat(row.distance_miles as string) : undefined,
  };
}

function rowToCampsite(row: Record<string, unknown>): Campsite {
  return {
    id: row.id as string,
    campgroundId: row.campground_id as string,
    name: row.name as string | null,
    type: row.type as string | null,
    loop: row.loop as string | null,
    maxOccupants: row.max_occupants as number | null,
    maxVehicleLength: row.max_vehicle_length as number | null,
    adaAccessible: row.ada_accessible as boolean,
    petsAllowed: row.pets_allowed as boolean,
    reservable: row.reservable as boolean,
    attributes: (row.attributes ?? {}) as Record<string, string>,
  };
}

export class RIDBSource implements CampgroundSource {
  readonly id = 'ridb';

  async searchByRadius(params: SearchParams): Promise<Campground[]> {
    const {
      lat,
      lng,
      radiusMiles,
      siteType,
      amenities,
      limit = 50,
      offset = 0,
    } = params;

    const radiusMeters = radiusMiles * 1609.344;

    const rows = await query<Record<string, unknown>>(
      `SELECT
        c.*,
        ST_X(c.location::geometry) AS longitude,
        ST_Y(c.location::geometry) AS latitude,
        ST_Distance(
          c.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) / 1609.344 AS distance_miles
      FROM campgrounds c
      WHERE
        ST_DWithin(
          c.location::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
        AND ($4::text IS NULL OR $4 = ANY(c.site_types))
        AND ($5::text[] IS NULL OR c.amenities @> $5::text[])
      ORDER BY distance_miles ASC
      LIMIT $6 OFFSET $7`,
      [lng, lat, radiusMeters, siteType ?? null, amenities ?? null, limit, offset]
    );

    return rows.map(rowToCampground);
  }

  async getDetail(campgroundId: string): Promise<Campground | null> {
    const cacheKey = `cg:${campgroundId}`;
    const cached = await getCached<Campground>(cacheKey);
    if (cached) return cached;

    const row = await queryOne<Record<string, unknown>>(
      `SELECT
        c.*,
        ST_X(c.location::geometry) AS longitude,
        ST_Y(c.location::geometry) AS latitude
      FROM campgrounds c WHERE c.id = $1`,
      [campgroundId]
    );

    if (!row) return null;
    const campground = rowToCampground(row);
    await setCached(cacheKey, campground, 3600); // 1 hour TTL for facility metadata
    return campground;
  }

  async getCampsites(campgroundId: string): Promise<Campsite[]> {
    const cacheKey = `campsites:${campgroundId}`;
    const cached = await getCached<Campsite[]>(cacheKey);
    if (cached) return cached;

    const rows = await query<Record<string, unknown>>(
      'SELECT * FROM campsites WHERE campground_id = $1 ORDER BY loop, name',
      [campgroundId]
    );

    const campsites = rows.map(rowToCampsite);
    await setCached(cacheKey, campsites, 3600);
    return campsites;
  }

  async getAvailability(campgroundId: string, month: string): Promise<CampgroundAvailability> {
    const cacheKey = `avail:${campgroundId}:${month}`;
    const cached = await getCached<CampgroundAvailability>(cacheKey);
    if (cached) return cached;

    const availability = await getAvailabilityFromRecGov(campgroundId, month);
    // Cache for 15 minutes — availability is the perishable part
    await setCached(cacheKey, availability, 900);
    return availability;
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    return syncRIDB(options);
  }
}

export const ridbSource = new RIDBSource();
