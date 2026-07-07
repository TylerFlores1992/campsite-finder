// ReserveCalifornia (CA State Parks) client.
//
// The site is backed by Tyler Technologies' RDR API (formerly UseDirect).
// The API host has moved before (calirdr.usedirect.com is dead), so we
// discover the current base URL from the site's runtime config.json and
// fall back to the last known host.

const CONFIG_URL = 'https://www.reservecalifornia.com/config.json';
const FALLBACK_RDR_BASE =
  'https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CampsiteFinder/1.0)',
  Accept: 'application/json',
};

let _base: string | null = null;

async function rdrBase(): Promise<string> {
  if (_base) return _base;
  try {
    const res = await fetch(CONFIG_URL, { headers: HEADERS });
    if (res.ok) {
      const config = (await res.json()) as { rdrApiUrl?: string };
      if (config.rdrApiUrl) {
        _base = config.rdrApiUrl.replace(/\/+$/, '');
        return _base;
      }
    }
  } catch {
    // fall through to hardcoded host
  }
  _base = FALLBACK_RDR_BASE;
  return _base;
}

export interface RCPlace {
  PlaceId: number;
  Name: string;
  Description: string | null;
  Address1: string | null;
  City: string | null;
  State: string | null;
  Zip: string | null;
  VoicePhone: string | null;
  Latitude: number;
  Longitude: number;
  AllowWebBooking: boolean;
  IsWebViewable: boolean;
}

export interface RCFacility {
  FacilityId: number;
  PlaceId: number;
  Name: string;
  Description: string | null;
  FacilityType: number;
  AllowWebBooking: boolean;
  IsTrail: boolean;
}

export interface RCGridSlice {
  Date: string; // YYYY-MM-DD
  IsFree: boolean;
  IsBlocked: boolean;
  IsWalkin: boolean;
  MinStay: number;
}

export interface RCGridUnit {
  UnitId: number;
  Name: string;
  IsAda: boolean;
  AllowWebBooking: boolean;
  IsWebViewable: boolean;
  UnitCategoryId: number;
  UnitTypeId: number;
  VehicleLength: number;
  Slices: Record<string, RCGridSlice>;
}

export interface RCUnitType {
  UnitTypeId: number;
  UnitCategoryId: number;
  Name: string;
}

export interface RCGrid {
  Facility: {
    FacilityId: number;
    Name: string;
    Units: Record<string, RCGridUnit> | null;
  };
}

async function rdrGet<T>(path: string): Promise<T> {
  const base = await rdrBase();
  const res = await fetch(`${base}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`RC RDR GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchPlaces(): Promise<RCPlace[]> {
  return rdrGet<RCPlace[]>('/fd/places');
}

export async function fetchFacilities(): Promise<RCFacility[]> {
  return rdrGet<RCFacility[]>('/fd/facilities');
}

/** Catalog of unit types (id → name like "Tent Only - Walk-In", "Hook Up (E)"). */
export async function fetchUnitTypes(): Promise<RCUnitType[]> {
  return rdrGet<RCUnitType[]>('/fd/unittypes');
}

/** Per-unit availability grid for a facility over an arbitrary date range. */
export async function fetchGrid(
  facilityId: number,
  startDate: string, // YYYY-MM-DD
  endDate: string
): Promise<RCGrid> {
  const base = await rdrBase();
  const res = await fetch(`${base}/search/grid`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      FacilityId: facilityId,
      StartDate: startDate,
      EndDate: endDate,
      MinDate: startDate,
      MaxDate: endDate,
      SleepingUnitId: 0,
      UnitTypeId: 0,
      UnitCategoryId: 0,
      UnitTypesGroupIds: [],
      MinVehicleLength: 0,
      IsADA: false,
      UnitSort: 'orderby',
      InSeasonOnly: true,
      WebOnly: true,
    }),
  });
  if (!res.ok) throw new Error(`RC RDR grid ${facilityId} → ${res.status}`);
  return res.json() as Promise<RCGrid>;
}

/** Our campground id convention for ReserveCalifornia facilities. */
export function rcCampgroundId(facilityId: number): string {
  return `rc-${facilityId}`;
}

export function rcFacilityIdFromCampgroundId(campgroundId: string): number {
  return Number(campgroundId.replace(/^rc-/, ''));
}

export function isRcCampgroundId(campgroundId: string): boolean {
  return campgroundId.startsWith('rc-');
}
