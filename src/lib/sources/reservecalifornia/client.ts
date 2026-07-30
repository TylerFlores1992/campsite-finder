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

// --- UseDirect throttle breaker (process-local, PER PROVIDER) -----------------
// rec.gov has had one of these for a while; RC had nothing, which is how every RC
// fetch could fail on every 15s cycle indefinitely on 2026-07-30 with no detection,
// no backoff and no recovery — 10 of 15 active watches, silently, while the same
// request answered 200 from another IP.
//
// Keyed by provider.source, NOT global: California, Arizona, Minnesota and the rest
// are different hosts behind different WAFs, so a CA throttle must not blind AZ.
//
// IT THROWS RATHER THAN RETURNING EMPTY, which is where it deliberately differs
// from the rec.gov breaker. An empty RC grid is indistinguishable from "campground
// is fully booked", and this client also backs the user-facing search page — so
// short-circuiting to empty would render a live campground as unavailable and could
// suppress a real opening. A throw is what every caller already turns into
// "couldn't determine"; see the `null` = unknown rule in the availability adapters.
const UD_BREAKER_TRIP = Number(process.env.UD_BREAKER_TRIP ?? 4);
const UD_BREAKER_COOLDOWN_MS = Number(process.env.UD_BREAKER_COOLDOWN_MS ?? 60_000);
// Bounds a hung socket. rec.gov's notes record a "timeout cascade" where enough
// stalled sockets starved the pool and made every OTHER source time out too; RC had
// no timeout at all, so it was a candidate to cause exactly that for everyone else.
const UD_TIMEOUT_MS = Number(process.env.UD_TIMEOUT_MS ?? 15_000);

const _breaker = new Map<string, { consecutive: number; openUntil: number }>();
const breakerFor = (source: string) => {
  let s = _breaker.get(source);
  if (!s) _breaker.set(source, (s = { consecutive: 0, openUntil: 0 }));
  return s;
};

/**
 * Failures that mean "back off", as opposed to a genuine bad request.
 *
 * Any 5xx counts. This started as `>= 502` on the theory that a 500 might be our
 * own malformed request — wrong, and the live logs said so within one poll cycle:
 * ReserveCalifornia answers Vercel's proxied /search/grid with a bare **500**
 * (empty body) for the exact same facility that returns 200 from another IP. That
 * is the sustained-failure case this breaker exists for, and a `>= 502` test would
 * have sat through it doing nothing.
 *
 * 429 is the explicit rate limit. 403 is how these WAFs refuse a datacenter IP —
 * seen the same minute from the Virginia host, as an nginx "403 Forbidden" page.
 * Everything else in the 4xx range is our own request being wrong; retrying cannot
 * fix it and it must never open the breaker.
 */
function isUseDirectThrottle(status: number | null, err?: unknown): boolean {
  if (status !== null) return status === 429 || status === 403 || status >= 500;
  const e = err as { name?: string; message?: string } | undefined;
  return e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|aborted/i.test(e?.message ?? '');
}

function recordUseDirectOutcome(source: string, throttled: boolean): void {
  const s = breakerFor(source);
  if (!throttled) {
    if (s.openUntil !== 0) console.log(`[UseDirect ${source}] throttle breaker CLOSED — reachable again`);
    s.consecutive = 0;
    s.openUntil = 0;
    return;
  }
  s.consecutive++;
  if (s.consecutive >= UD_BREAKER_TRIP && Date.now() >= s.openUntil) {
    s.openUntil = Date.now() + UD_BREAKER_COOLDOWN_MS;
    console.warn(
      `[UseDirect ${source}] throttle breaker OPEN after ${s.consecutive} throttled requests — ` +
        `short-circuiting for ${UD_BREAKER_COOLDOWN_MS / 1000}s`
    );
  }
}

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
  // Breaker open: fail immediately without touching the network. This is the same
  // outcome the caller was already getting from the failing request, minus the wait
  // and minus another request feeding whatever is refusing us.
  const brk = breakerFor(provider.source);
  if (Date.now() < brk.openUntil) {
    throw new Error(
      `UseDirect ${provider.source} breaker open for ${Math.ceil((brk.openUntil - Date.now()) / 1000)}s — skipping ${path}`
    );
  }

  const base = await rdrBase(provider);
  const proxyUrl = process.env.RC_PROXY_URL;
  const proxySecret = process.env.RC_PROXY_SECRET ?? process.env.SYNC_SECRET;

  if (proxyUrl && proxySecret) {
    let res: Response;
    try {
      res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': proxySecret },
        body: JSON.stringify({ base, path, method: opts.method ?? 'GET', body: opts.body }),
        signal: AbortSignal.timeout(UD_TIMEOUT_MS),
      });
    } catch (err) {
      recordUseDirectOutcome(provider.source, isUseDirectThrottle(null, err));
      throw err;
    }
    if (!res.ok) {
      // The proxy collapses EVERY non-ok upstream into a flat 502 and puts the real
      // status in its body ({error: "upstream 403"}). Logging only the proxy's own
      // 502 threw that away, which is why an outage on 2026-07-30 — 10 of 15 watches
      // failing every cycle — could not be told apart from RC being down. It was not:
      // the same call returned 200 in under a second from a datacenter IP at the time.
      // Whatever the cause, the next occurrence should name itself.
      const detail = await res.text().then(
        (t) => t.slice(0, 200),
        () => '<unreadable>'
      );
      // Judge the breaker on the UPSTREAM status the proxy reports, not the proxy's
      // own flat 502 — otherwise a plain "path not allowed" 400 from our own code
      // would look identical to being rate-limited.
      const upstream = /upstream (\d{3})/.exec(detail)?.[1];
      recordUseDirectOutcome(
        provider.source,
        isUseDirectThrottle(upstream ? Number(upstream) : res.status)
      );
      throw new Error(`RC proxy ${path} → ${res.status} ${detail}`);
    }
    recordUseDirectOutcome(provider.source, false);
    return res.json() as Promise<T>;
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: { ...HEADERS, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(UD_TIMEOUT_MS),
    });
  } catch (err) {
    recordUseDirectOutcome(provider.source, isUseDirectThrottle(null, err));
    throw err;
  }
  if (!res.ok) {
    recordUseDirectOutcome(provider.source, isUseDirectThrottle(res.status));
    throw new Error(`RC RDR ${opts.method ?? 'GET'} ${path} → ${res.status}`);
  }
  recordUseDirectOutcome(provider.source, false);
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
