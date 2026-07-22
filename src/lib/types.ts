export interface Campground {
  id: string;
  source: string;
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  address: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  amenities: string[];
  activities: string[];
  environmentTags: string[];
  siteTypes: string[];
  reservable: boolean;
  reservationsUrl: string | null;
  phone: string | null;
  email: string | null;
  adaAccessible: boolean;
  petsAllowed: boolean;
  photos: { url: string; title?: string; isPrimary?: boolean }[];
  lastSyncedAt: string | null;
  // Appended by search
  distanceMiles?: number;
  availableSiteCount?: number;
  hasAvailability?: boolean; // true=open, false=booked, undefined=unchecked
  // Cancellation-likelihood headline (feature E), attached by search when enough
  // history has accrued for the number to be honest. Absent = no signal to show.
  likelihood?: CampgroundLikelihood;
}

/** A one-line cancellation-likelihood headline for a campground (feature E). */
export interface CampgroundLikelihood {
  rate: number; // opening rate 0..1 of the representative lead window
  label: string; // human label for that window, e.g. "3–6 weeks out"
  samples: number; // observations behind it
}

export interface Campsite {
  id: string;
  campgroundId: string;
  name: string | null;
  type: string | null;
  loop: string | null;
  maxOccupants: number | null;
  maxVehicleLength: number | null;
  adaAccessible: boolean;
  petsAllowed: boolean;
  reservable: boolean;
  attributes: Record<string, string>;
}

export interface AvailabilityDay {
  date: string; // YYYY-MM-DD
  status: 'available' | 'reserved' | 'closed' | 'not_available';
  minStay: number | null;
}

export interface CampsiteAvailability {
  campsiteId: string;
  campsiteName: string | null;
  campsiteType: string | null;
  loop: string | null;
  availability: AvailabilityDay[];
}

export interface CampgroundAvailability {
  campgroundId: string;
  month: string; // YYYY-MM
  campsites: CampsiteAvailability[];
  availableCount: number; // sites with at least one open date
}

export interface SearchParams {
  lat: number;
  lng: number;
  radiusMiles: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
  siteType?: string;
  amenities?: string[];
  rvLength?: number; // minimum vehicle length the campground must accommodate
  minNights?: number;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  campgrounds: Array<Campground & { distanceMiles: number }>;
  total: number;
}

export interface Watch {
  id: string;
  userId: string;
  campgroundId: string;
  campsiteIds: string[] | null;
  startDate: string;
  endDate: string;
  minNights: number;
  siteType: string | null;
  notifyPush: boolean;
  notifySms: boolean;
  notifyEmail: boolean;
  autoCart: boolean;
  active: boolean;
  createdAt: string;
}
