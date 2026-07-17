import axios from 'axios';

const BASE_URL = 'https://ridb.recreation.gov/api/v1';

function getApiKey(): string {
  const key = process.env.RIDB_API_KEY;
  if (!key) throw new Error('RIDB_API_KEY is not set');
  return key;
}

const http = axios.create({ baseURL: BASE_URL, timeout: 15000 });

http.interceptors.request.use((config) => {
  config.headers['apikey'] = getApiKey();
  return config;
});

// ---------- RIDB response types ----------

export interface RIDBFacility {
  FacilityID: string;
  FacilityName: string;
  FacilityDescription: string;
  FacilityTypeDescription: string;
  FacilityPhone: string;
  FacilityEmail: string;
  FacilityReservationURL: string;
  FacilityAdaAccess: string; // 'Y', 'N', or ''
  FacilityLatitude: number;
  FacilityLongitude: number;
  Reservable: boolean;
  Enabled: boolean;
  LastUpdatedDate: string;
  Keywords: string;
  StayLimit: string;
  FACILITYADDRESS?: RIDBAddress[];
  ACTIVITY?: RIDBActivity[];
  CAMPSITE?: RIDBCampsite[];
  MEDIA?: RIDBMedia[];
}

export interface RIDBAddress {
  AddressType: string;
  FacilityStreetAddress1: string;
  City: string;
  PostalCode: string;
  AddressStateCode: string;
}

export interface RIDBActivity {
  ActivityID: number;
  ActivityName: string;
}

export interface RIDBMedia {
  MediaType: string;
  URL: string;
  Title: string;
  Description: string;
  IsPrimary: boolean;
  IsPreview: boolean;
}

export interface RIDBCampsite {
  CampsiteID: string;
  FacilityID: string;
  CampsiteName: string;
  CampsiteType: string;
  TypeOfUse: string;
  Loop: string;
  CampsiteAccessible: boolean;
  CampsiteReservable: boolean;
  CampsiteLatitude: number | null;
  CampsiteLongitude: number | null;
  // NB: RIDB's actual field name is ATTRIBUTES (plural)
  ATTRIBUTES?: { AttributeName: string; AttributeValue: string }[];
  PERMITTEDEQUIPMENT?: { EquipmentName: string; MaxLength: number }[];
}

// ---------- API methods ----------

export async function searchFacilities(params: {
  query?: string;
  latitude?: number;
  longitude?: number;
  radius?: number; // miles
  state?: string;
  activity?: string;
  limit?: number;
  offset?: number;
  full?: boolean;
}): Promise<{ RECDATA: RIDBFacility[]; METADATA: { RESULTS: { CURRENT_COUNT: number; TOTAL_COUNT: number } } }> {
  const response = await http.get('/facilities', {
    params: {
      ...params,
      full: params.full !== false, // default true
    },
  });
  return response.data;
}

export async function getFacility(facilityId: string, full = true): Promise<RIDBFacility> {
  const response = await http.get(`/facilities/${facilityId}`, { params: { full } });
  return response.data;
}

export async function getFacilityCampsites(
  facilityId: string,
  limit = 100,
  offset = 0
): Promise<{ RECDATA: RIDBCampsite[]; METADATA: { RESULTS: { CURRENT_COUNT: number; TOTAL_COUNT: number } } }> {
  const response = await http.get(`/facilities/${facilityId}/campsites`, {
    params: { limit, offset, full: true },
  });
  return response.data;
}

export async function getFacilityMedia(facilityId: string): Promise<RIDBMedia[]> {
  const response = await http.get(`/facilities/${facilityId}/media`);
  return response.data?.RECDATA ?? [];
}

/** Fetch all campsites for a facility, handling pagination. */
export async function getAllFacilityCampsites(facilityId: string): Promise<RIDBCampsite[]> {
  const pageSize = 100;
  let offset = 0;
  const all: RIDBCampsite[] = [];

  while (true) {
    const data = await getFacilityCampsites(facilityId, pageSize, offset);
    all.push(...data.RECDATA);
    if (all.length >= data.METADATA.RESULTS.TOTAL_COUNT) break;
    offset += pageSize;
  }

  return all;
}

function isCampground(f: RIDBFacility): boolean {
  if (!f.Enabled) return false;
  if (!f.FacilityLatitude || !f.FacilityLongitude) return false; // no coords
  if (f.FacilityLatitude === 0 && f.FacilityLongitude === 0) return false;
  const type = f.FacilityTypeDescription?.toLowerCase() ?? '';
  const name = f.FacilityName?.toLowerCase() ?? '';
  return (
    type === 'campground' ||
    type === 'camping' ||
    name.includes('camp') ||
    name.includes('campground')
  );
}

/** Fetch all campgrounds for a state, paginating through all results. Activity 9 = Camping. */
export async function searchCampgroundsByState(
  stateCode: string,
  maxResults = 2000
): Promise<RIDBFacility[]> {
  const pageSize = 50;
  let offset = 0;
  const all: RIDBFacility[] = [];

  while (all.length < maxResults) {
    const data = await searchFacilities({
      state: stateCode,
      activity: '9', // Camping
      limit: pageSize,
      offset,
      full: true,
    });

    all.push(...data.RECDATA.filter(isCampground));

    if (offset + pageSize >= data.METADATA.RESULTS.TOTAL_COUNT) break;
    offset += pageSize;
  }

  return all.slice(0, maxResults);
}

/**
 * Fetch every camping facility nationwide (activity 9), paginating through all
 * results. Unlike the per-state search, this doesn't rely on a facility's address
 * state code — so facilities with a missing/blank address (e.g. newer USFS sites
 * like Gull Lake Campground) are still included, as long as they have coordinates.
 */
export async function searchAllCampgrounds(maxResults = 20000): Promise<RIDBFacility[]> {
  const pageSize = 50;
  let offset = 0;
  const all: RIDBFacility[] = [];

  while (all.length < maxResults) {
    const data = await searchFacilities({
      activity: '9', // Camping
      limit: pageSize,
      offset,
      full: true,
    });

    all.push(...data.RECDATA.filter(isCampground));

    if (offset + pageSize >= data.METADATA.RESULTS.TOTAL_COUNT || data.RECDATA.length < pageSize) break;
    offset += pageSize;
  }

  return all.slice(0, maxResults);
}

/** Search all campground-type facilities near a location, handling pagination. */
export async function searchCampgroundsNear(
  lat: number,
  lng: number,
  radiusMiles: number,
  maxResults = 500
): Promise<RIDBFacility[]> {
  const pageSize = 50;
  let offset = 0;
  const all: RIDBFacility[] = [];

  while (all.length < maxResults) {
    const data = await searchFacilities({
      latitude: lat,
      longitude: lng,
      radius: radiusMiles,
      limit: pageSize,
      offset,
      full: true,
    });

    all.push(...data.RECDATA.filter(isCampground));

    if (offset + pageSize >= data.METADATA.RESULTS.TOTAL_COUNT || data.RECDATA.length < pageSize) break;
    offset += pageSize;
  }

  return all.slice(0, maxResults);
}
