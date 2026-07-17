import type { Campground, Campsite, CampgroundAvailability, SearchParams } from '@/lib/types';

export interface CampgroundSource {
  readonly id: string; // e.g. 'ridb', 'reservecalifornia'

  /** Search campgrounds by location radius. Returns campgrounds with distanceMiles set. */
  searchByRadius(params: SearchParams): Promise<Campground[]>;

  /** Get a single campground with full detail. */
  getDetail(campgroundId: string): Promise<Campground | null>;

  /** Get campsites for a campground. */
  getCampsites(campgroundId: string): Promise<Campsite[]>;

  /** Get availability for a campground for the given month (YYYY-MM). */
  getAvailability(campgroundId: string, month: string): Promise<CampgroundAvailability>;

  /** Pull latest facility + campsite data into the local DB. Called nightly. */
  sync(options?: SyncOptions): Promise<SyncResult>;
}

export interface SyncOptions {
  stateCode?: string;    // limit sync to a specific state
  national?: boolean;    // fetch ALL camping facilities nationwide (address-independent)
  radiusMiles?: number;  // limit sync to campgrounds within radius of a point
  lat?: number;
  lng?: number;
  maxFacilities?: number;
}

export interface SyncResult {
  facilitiesSynced: number;
  campsitesSynced: number;
  errors: string[];
  durationMs: number;
}
