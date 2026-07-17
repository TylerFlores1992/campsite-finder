// UseDirect / RDR API client (ReserveCalifornia, Arizona State Parks, …).
//
// All these systems are backed by Tyler Technologies' RDR API (formerly
// UseDirect): same /fd/* + /search/grid endpoints and grid shape. Each state is a
// UseDirectProvider (see providers.ts); pass one to every call. Hosts can move, so
// providers with a configUrl discover the current base at runtime.

import {
  type UseDirectProvider,
  providerByCampgroundId,
  USEDIRECT_PROVIDERS,
} from './providers';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CampsiteFinder/1.0)',
  Accept: 'application/json',
};

const _baseCache = new Map<string, string>(); // provider.source -> resolved RDR base

async function rdrBase(provider: UseDirectProvider): Promise<string> {
  const cached = _baseCache.get(provider.source);
  if (cached) return cached;
  let base = provider.rdrBase ?? provider.fallbackBase;
  if (provider.configUrl) {
    try {
      const res = await fetch(provider.configUrl, { headers: HEADERS });
      if (res.ok) {
        const config = (await res.json()) as { rdrApiUrl?: string };
        if (config.rdrApiUrl) base = config.rdrApiUrl;
      }
    } catch {
      // fall through to static/fallback base
    }
  }
  base = base.replace(/\/+$/, '');
  _baseCache.set(provider.source, base);
  return base;
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
  /** Active reservation on this night (>0 = booked). */
  ReservationId?: number;
  /** Set when the night is cancelled-but-held: an ISO local timestamp
   *  ("2026-07-18T08:00:00") for when it releases (usually 8am next day). */
  Lock?: string | null;
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
  SleepingUnitIds?: number[];
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

/**
 * Fetch from a provider's RDR API — directly when this host's IPs pass the WAF
 * (Vercel, residential), or via our Vercel proxy when RC_PROXY_URL is set (Fly.io
 * and GitHub runners get 403'd directly). The proxy is passed the resolved base so
 * it forwards to the right state.
 */
async function rdrFetch<T>(
  provider: UseDirectProvider,
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  const base = await rdrBase(provider);
  const proxyUrl = process.env.RC_PROXY_URL;
  const proxySecret = process.env.RC_PROXY_SECRET ?? process.env.SYNC_SECRET;

  if (proxyUrl && proxySecret) {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': proxySecret },
      body: JSON.stringify({ base, path, method: opts.method ?? 'GET', body: opts.body }),
    });
    if (!res.ok) throw new Error(`RC proxy ${path} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...HEADERS, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) throw new Error(`RC RDR ${opts.method ?? 'GET'} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchPlaces(provider: UseDirectProvider): Promise<RCPlace[]> {
  return rdrFetch<RCPlace[]>(provider, '/fd/places');
}

export function fetchFacilities(provider: UseDirectProvider): Promise<RCFacility[]> {
  return rdrFetch<RCFacility[]>(provider, '/fd/facilities');
}

/** Catalog of unit types (id → name like "Tent Only - Walk-In", "Hook Up (E)"). */
export function fetchUnitTypes(provider: UseDirectProvider): Promise<RCUnitType[]> {
  return rdrFetch<RCUnitType[]>(provider, '/fd/unittypes');
}

/** Per-unit availability grid for a facility over an arbitrary date range. */
export function fetchGrid(
  provider: UseDirectProvider,
  facilityId: number,
  startDate: string, // YYYY-MM-DD
  endDate: string
): Promise<RCGrid> {
  return rdrFetch<RCGrid>(provider, '/search/grid', {
    method: 'POST',
    body: {
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
    },
  });
}

/** Our campground id convention: `${idPrefix}-${facilityId}`. */
export function campgroundIdFor(provider: UseDirectProvider, facilityId: number): string {
  return `${provider.idPrefix}-${facilityId}`;
}

/** Extract the numeric facility id from any UseDirect campground id (rc-123, az-45). */
export function facilityIdFromCampgroundId(campgroundId: string): number {
  return Number(campgroundId.replace(/^[a-z]+-/, ''));
}

/** True if this campground id belongs to any UseDirect provider. */
export function isUseDirectCampgroundId(campgroundId: string): boolean {
  return !!providerByCampgroundId(campgroundId);
}

export { USEDIRECT_PROVIDERS };
