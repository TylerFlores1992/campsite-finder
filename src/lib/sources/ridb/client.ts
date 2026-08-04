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

/**
 * How many times a throttled or transient request is retried. UseDirect got this on
 * 2026-07-30 under the rule that "a 403 from these WAFs means slow down, not never";
 * RIDB never did, so a single 429 was a PERMANENT loss of that facility's campsites.
 *
 * Measured cost of having none (sync_log, `ridb`): runs on 07-24..27 fetched all
 * 116,475 campsites with ZERO errors. From 07-28 — the day the media fix started
 * calling a second endpoint for every facility, doubling the request count — runs
 * went bimodal: either ~105k campsites and ~1,000 errors, or ~43k campsites and
 * ~6,200 errors. The bad runs are also the FAST ones (6 minutes against 18), which is
 * the tell: the sync was not doing less work slowly, it was giving up early.
 */
const ATTEMPTS = Math.max(1, Number(process.env.RIDB_ATTEMPTS ?? 4));
/** First backoff step; doubles per attempt. A 429 wants seconds, not milliseconds. */
const BACKOFF_MS = Number(process.env.RIDB_BACKOFF_MS ?? 2000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry 429s, 5xx and network errors. Never retry a 4xx we caused (401, 404). */
function retryable(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string };
  const status = e?.response?.status;
  if (status === undefined) return true;            // network error / timeout
  if (status === 429) return true;                  // throttled — the whole point
  return status >= 500;                             // upstream fault
}

/**
 * Honour `Retry-After` when RIDB sends it (seconds, or an HTTP date), else exponential
 * backoff with jitter. The jitter matters: without it every one of the N concurrent
 * workers that got a 429 in the same instant retries in the same instant, which is the
 * burst that caused the throttle rebuilt exactly.
 */
function backoffFor(err: unknown, attempt: number): number {
  const header = (err as { response?: { headers?: Record<string, string> } })?.response?.headers?.['retry-after'];
  if (header) {
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds)) return asSeconds * 1000;
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  }
  const base = BACKOFF_MS * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * base * 0.3);
}

http.interceptors.response.use(undefined, async (err) => {
  const cfg = (err.config ?? {}) as { __ridbAttempt?: number };
  const attempt = (cfg.__ridbAttempt ?? 0) + 1;
  if (attempt >= ATTEMPTS || !retryable(err) || !err.config) throw err;
  cfg.__ridbAttempt = attempt;
  const wait = backoffFor(err, attempt);
  const status = err.response?.status ?? err.code ?? 'network';
  console.warn(`[RIDB] ${status} on ${err.config.url} — retry ${attempt}/${ATTEMPTS - 1} in ${Math.round(wait)}ms`);
  await sleep(wait);
  return http.request(err.config);
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
