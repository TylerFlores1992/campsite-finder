import { query, queryOne, getSupabaseAdmin } from '@/lib/db/client';
import { getCached, setCached } from '@/lib/cache/redis';
import type { Campground, Campsite, CampgroundAvailability, SearchParams } from '@/lib/types';
import type { CampgroundSource, SyncOptions, SyncResult } from '../types';
import { syncRIDB } from './sync';
import { getAvailabilityFromRecGov } from '@/lib/availability/recgov';

function rowToCampground(row: Record<string, unknown>): Campground {
  return {
    id: row.id as string,
    source: row.source as string,
    name: row.name as string,
    description: row.description as string | null,
    latitude: typeof row.latitude === 'number' ? row.latitude : parseFloat(row.latitude as string),
    longitude: typeof row.longitude === 'number' ? row.longitude : parseFloat(row.longitude as string),
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
    distanceMiles: row.distance_miles != null ? parseFloat(row.distance_miles as string) : undefined,
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
    const { lat, lng, radiusMiles, siteType, amenities, limit = 50 } = params;
    const radiusMeters = radiusMiles * 1609.344;

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc('search_campgrounds_nearby', {
      p_lat: lat,
      p_lng: lng,
      p_radius_meters: radiusMeters,
      p_limit: limit * 3, // fetch 3× so availability filtering has room
      p_site_type: siteType ?? null,
      p_amenities: amenities && amenities.length > 0 ? amenities : null,
    });

    if (error) throw new Error(`Radius search failed: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map(rowToCampground);
  }

  async getDetail(campgroundId: string): Promise<Campground | null> {
    const cacheKey = `cg:${campgroundId}`;
    const cached = await getCached<Campground>(cacheKey);
    if (cached) return cached;

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('campgrounds')
      .select('*, lat:location->lat, lng:location->lng')
      .eq('id', campgroundId)
      .single();

    if (error || !data) return null;

    // Get lat/lng via a separate RPC since we need ST_X/ST_Y
    const rows = await query<Record<string, unknown>>(
      `SELECT *, ST_X(location::geometry) AS longitude, ST_Y(location::geometry) AS latitude
       FROM campgrounds WHERE id = '${campgroundId.replace(/'/g, "''")}'`
    );
    if (!rows[0]) return null;

    const campground = rowToCampground(rows[0]);
    await setCached(cacheKey, campground, 3600);
    return campground;
  }

  async getCampsites(campgroundId: string): Promise<Campsite[]> {
    const cacheKey = `campsites:${campgroundId}`;
    const cached = await getCached<Campsite[]>(cacheKey);
    if (cached) return cached;

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('campsites')
      .select('*')
      .eq('campground_id', campgroundId)
      .order('loop')
      .order('name');

    if (error) throw new Error(`getCampsites failed: ${error.message}`);
    const campsites = ((data ?? []) as Record<string, unknown>[]).map(rowToCampsite);
    await setCached(cacheKey, campsites, 3600);
    return campsites;
  }

  async getAvailability(campgroundId: string, month: string): Promise<CampgroundAvailability> {
    const cacheKey = `avail:${campgroundId}:${month}`;
    const cached = await getCached<CampgroundAvailability>(cacheKey);
    if (cached) return cached;

    const availability = await getAvailabilityFromRecGov(campgroundId, month);
    await setCached(cacheKey, availability, 900);
    return availability;
  }

  async sync(options?: SyncOptions): Promise<SyncResult> {
    return syncRIDB(options);
  }
}

export const ridbSource = new RIDBSource();
