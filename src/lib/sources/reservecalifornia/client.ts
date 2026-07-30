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
  rdrRequestHeaders,
} from './providers';

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
// RETRY, which is the actual fix for what was happening on 2026-07-30. Measured
// directly against ReserveCalifornia: 20 IDENTICAL requests, seconds apart, same
// body and headers → nineteen 200s and one 500. Their RDR API is simply flaky. It
// is not our IP (the same request 500s and 200s from the same machine), not the
// date range (both long and short ranges do it), and not our headers.
//
// With no retry at all, every one of those blips was a watch silently not checked
// that cycle. Three attempts turns a ~5% per-request failure into ~0.01%.
const UD_ATTEMPTS = Number(process.env.UD_ATTEMPTS ?? 3);
const UD_RETRY_BASE_MS = Number(process.env.UD_RETRY_BASE_MS ?? 250);

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
 * 429 is the explicit rate limit. 403 is how these WAFs say "too fast" — it looks
 * like a flat refusal (an nginx "403 Forbidden" page from the Virginia host) but is
 * not one: that same sync got 403 on 83 grid calls and 200 on 193 others, in one run
 * from one address. It is retried, with a much longer backoff than a 5xx.
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
      const res = await fetch(provider.configUrl, { headers: rdrRequestHeaders() });
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

// --- Proxy request coalescing -------------------------------------------------
// Only the proxied path (the Fly worker) batches; a direct fetch has nothing to
// coalesce. `/api/rc-proxy` forwarded one request per invocation, and it sits on the
// hot path of a 15-second poller: 11 RC fetches a cycle was ~63,000 Vercel function
// invocations a day for 16 watches — the largest single line in the usage bill.
//
// Requests that land within UD_BATCH_WINDOW_MS of each other, for the same RDR base,
// go up as one POST. Batch size is bounded by the CALLER's fanout, not by the window:
// the poller runs RC watches through pMap(4), so four are in flight at a time and a
// batch is normally four. That is the whole win — 11 invocations become 3.
//
// UPSTREAM LOAD IS UNCHANGED. The same N requests still leave Vercel; the proxy runs
// them at its own small fanout. The WAFs meter request rate from an IP, Vercel bills
// per invocation, and only the second number moves.
const UD_BATCH_WINDOW_MS = Number(process.env.UD_BATCH_WINDOW_MS ?? 40);
/** Must not exceed MAX_BATCH in src/app/api/rc-proxy/route.ts. */
const UD_BATCH_MAX = 40;

/** What a single proxied request resolves to, upstream status included. */
type ProxyOutcome =
  | { ok: true; data: unknown }
  | { ok: false; status: number | null; message: string; err?: unknown };

/** The proxy's per-item result shape — see src/app/api/rc-proxy/route.ts. */
interface ProxyItemResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  upstreamStatus?: number;
  detail?: string;
}

interface QueuedRequest {
  key: string;
  path: string;
  method: string;
  body?: unknown;
  settle: (outcome: ProxyOutcome) => void;
}

const _batchQueues = new Map<string, QueuedRequest[]>(); // RDR base -> pending
const _batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Latched when the deployed proxy predates batching; see sendProxyBatch. */
let _batchUnsupported = false;

function enqueueProxyRequest(
  proxyUrl: string,
  proxySecret: string,
  base: string,
  req: { path: string; method: string; body?: unknown }
): Promise<ProxyOutcome> {
  return new Promise((settle) => {
    const queue = _batchQueues.get(base) ?? [];
    // Identical requests share one upstream call. Two subscribers watching the same
    // campground for the same dates produce byte-identical grid POSTs on every cycle.
    const key = `${req.method} ${req.path} ${req.body ? JSON.stringify(req.body) : ''}`;
    queue.push({ key, ...req, settle });
    _batchQueues.set(base, queue);

    if (queue.length >= UD_BATCH_MAX) {
      void flushBatch(proxyUrl, proxySecret, base);
    } else if (!_batchTimers.has(base)) {
      _batchTimers.set(
        base,
        setTimeout(() => void flushBatch(proxyUrl, proxySecret, base), UD_BATCH_WINDOW_MS)
      );
    }
  });
}

async function flushBatch(proxyUrl: string, proxySecret: string, base: string): Promise<void> {
  const timer = _batchTimers.get(base);
  if (timer) {
    clearTimeout(timer);
    _batchTimers.delete(base);
  }
  const queued = _batchQueues.get(base);
  if (!queued?.length) return;
  _batchQueues.delete(base);

  const batch = queued.slice(0, UD_BATCH_MAX);
  const overflow = queued.slice(UD_BATCH_MAX);
  if (overflow.length) {
    _batchQueues.set(base, overflow);
    _batchTimers.set(base, setTimeout(() => void flushBatch(proxyUrl, proxySecret, base), 0));
  }

  const groups = new Map<string, QueuedRequest[]>();
  for (const item of batch) {
    const existing = groups.get(item.key);
    if (existing) existing.push(item);
    else groups.set(item.key, [item]);
  }
  await sendProxyBatch(proxyUrl, proxySecret, base, [...groups.values()]);
}

/** Never throws — every queued request is settled exactly once, success or not. */
async function sendProxyBatch(
  proxyUrl: string,
  proxySecret: string,
  base: string,
  groups: QueuedRequest[][]
): Promise<void> {
  const settleEach = (outcomes: ProxyOutcome[]) =>
    groups.forEach((group, i) => group.forEach((item) => item.settle(outcomes[i])));
  const sendSingly = async () =>
    settleEach(
      await Promise.all(groups.map((group) => sendProxySingle(proxyUrl, proxySecret, base, group[0])))
    );

  // One request is not a batch: the single shape costs the same invocation and is the
  // shape every deployed proxy understands.
  if (groups.length === 1 || _batchUnsupported) return sendSingly();

  let res: Response;
  try {
    res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': proxySecret },
      body: JSON.stringify({
        base,
        requests: groups.map(([{ path, method, body }]) => ({ path, method, body })),
      }),
      // The proxy paces the batch through a small fanout, so the wall clock is a
      // multiple of one request's — the per-request timeout would guarantee a miss.
      signal: AbortSignal.timeout(UD_TIMEOUT_MS * 2),
    });
  } catch (err) {
    const message = `RC proxy batch(${groups.length}) → ${(err as Error).message}`;
    return settleEach(groups.map(() => ({ ok: false, status: null, message, err })));
  }

  if (!res.ok) {
    const detail = await res.text().then((t) => t.slice(0, 200), () => '<unreadable>');
    // A proxy deployed before batching rejects this with 400: it reads a top-level
    // `path`, which a batch doesn't have, and answers "path not allowed". That is the
    // one failure retrying can never fix, so stop batching for the life of the process
    // — it keeps alerting alive in the minutes between the Vercel and Fly deploys.
    // Everything else is an ordinary failure that rdrFetch's retry loop owns.
    if (res.status === 400) {
      _batchUnsupported = true;
      console.warn(`[UseDirect] rc-proxy rejected the batch shape (400 ${detail}) — sending one request per call`);
      return sendSingly();
    }
    const message = `RC proxy batch(${groups.length}) → ${res.status} ${detail}`;
    return settleEach(groups.map(() => ({ ok: false, status: res.status, message })));
  }

  const payload = (await res.json().catch(() => null)) as { results?: ProxyItemResult[] } | null;
  if (!Array.isArray(payload?.results) || payload.results.length !== groups.length) {
    const message = `RC proxy batch(${groups.length}) → malformed response`;
    return settleEach(groups.map(() => ({ ok: false, status: 502, message })));
  }
  const results = payload.results;
  settleEach(groups.map((group, i) => outcomeFromItem(group[0].path, results[i])));
}

function outcomeFromItem(path: string, item: ProxyItemResult): ProxyOutcome {
  if (item.ok) return { ok: true, data: item.data };
  return {
    ok: false,
    // Retry and breaker decisions must key off the UPSTREAM status, not the proxy's
    // own 502 — otherwise a "path not allowed" 400 from our own code is
    // indistinguishable from a flaky upstream.
    status: item.upstreamStatus ?? item.status,
    message: `RC proxy ${path} → ${item.status} ${item.error ?? ''}${item.detail ? ` ${item.detail}` : ''}`.trim(),
  };
}

async function sendProxySingle(
  proxyUrl: string,
  proxySecret: string,
  base: string,
  req: { path: string; method: string; body?: unknown }
): Promise<ProxyOutcome> {
  let res: Response;
  try {
    res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': proxySecret },
      body: JSON.stringify({ base, path: req.path, method: req.method, body: req.body }),
      signal: AbortSignal.timeout(UD_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: null, message: `RC proxy ${req.path} → ${(err as Error).message}`, err };
  }
  if (!res.ok) {
    // The proxy collapses every non-ok upstream into a flat 502 and puts the real
    // status in its body ({error, upstreamStatus, detail}). Retry and breaker
    // decisions must key off THAT, not the proxy's 502 — otherwise a "path not
    // allowed" 400 from our own code is indistinguishable from a flaky upstream.
    const detail = await res.text().then((t) => t.slice(0, 200), () => '<unreadable>');
    const upstream = /upstream (\d{3})/.exec(detail)?.[1];
    return {
      ok: false,
      status: upstream ? Number(upstream) : res.status,
      message: `RC proxy ${req.path} → ${res.status} ${detail}`,
    };
  }
  return { ok: true, data: await res.json() };
}

/**
 * Fetch from a provider's RDR API — directly when this host's IPs pass the WAF
 * (Vercel, residential), or via our Vercel proxy when RC_PROXY_URL is set (Fly.io
 * and GitHub runners get 403'd directly). The proxy is passed the resolved base so
 * it forwards to the right state.
 */
/** One attempt. Reports the effective upstream status so the caller can decide. */
async function rdrAttempt<T>(
  provider: UseDirectProvider,
  base: string,
  path: string,
  opts: { method?: string; body?: unknown }
): Promise<{ ok: true; data: T } | { ok: false; status: number | null; message: string; err?: unknown }> {
  const proxyUrl = process.env.RC_PROXY_URL;
  const proxySecret = process.env.RC_PROXY_SECRET ?? process.env.SYNC_SECRET;

  if (proxyUrl && proxySecret) {
    // Coalesced. A retry re-enters here and simply joins the next batch, so the retry
    // loop and the breaker below see exactly what they saw before batching existed.
    const outcome = await enqueueProxyRequest(proxyUrl, proxySecret, base, {
      path,
      method: opts.method ?? 'GET',
      body: opts.body,
    });
    return outcome.ok ? { ok: true, data: outcome.data as T } : outcome;
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: rdrRequestHeaders(base, Boolean(opts.body)),
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(UD_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: null, message: `RC RDR ${path} → ${(err as Error).message}`, err };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `RC RDR ${opts.method ?? 'GET'} ${path} → ${res.status}`,
    };
  }
  return { ok: true, data: (await res.json()) as T };
}

async function rdrFetch<T>(
  provider: UseDirectProvider,
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  // Breaker open: fail immediately without touching the network. Same outcome the
  // caller was already getting, minus the wait and minus another request feeding
  // whatever is refusing us.
  const brk = breakerFor(provider.source);
  if (Date.now() < brk.openUntil) {
    throw new Error(
      `UseDirect ${provider.source} breaker open for ${Math.ceil((brk.openUntil - Date.now()) / 1000)}s — skipping ${path}`
    );
  }

  const base = await rdrBase(provider);
  let last: { status: number | null; message: string; err?: unknown } | null = null;

  for (let attempt = 1; attempt <= UD_ATTEMPTS; attempt++) {
    const r = await rdrAttempt<T>(provider, base, path, opts);
    if (r.ok) {
      if (attempt > 1) console.log(`[UseDirect ${provider.source}] ${path} OK on attempt ${attempt}`);
      recordUseDirectOutcome(provider.source, false);
      return r.data;
    }
    last = { status: r.status, message: r.message, err: r.err };

    // 403 IS RETRYABLE, which reverses an earlier call here. It was excluded on the
    // theory that a 403 is a settled refusal of the IP — true of a real block, and
    // wrong for these WAFs. Virginia's 2026-07-30 catalog sync got 403 on 83 of 276
    // grid calls and 200 on the other 193, in one run, from one address: a hard block
    // would have failed all of them. It means "slow down", and the previous behaviour
    // turned a pause into 83 campgrounds permanently missing from search, because
    // syncFacilityUnits returns 0 for a facility whose grid call failed.
    //
    // A genuine block is still handled: 403 counts toward the breaker, so four in a
    // row short-circuits the provider instead of grinding through retries.
    const retryable = isUseDirectThrottle(r.status, r.err);
    if (!retryable || attempt === UD_ATTEMPTS) break;
    // A rate limit needs real time, where a flaky 500 just needs another go — so back
    // off much harder on 403 than on a transient error.
    const backoffMs = r.status === 403 ? UD_RETRY_BASE_MS * 8 : UD_RETRY_BASE_MS;
    // Jittered so N parallel calls don't retry in lockstep and re-trip the limit.
    await new Promise((res) => setTimeout(res, backoffMs * attempt + Math.random() * 250));
  }

  recordUseDirectOutcome(provider.source, isUseDirectThrottle(last!.status, last!.err));
  throw new Error(last!.message);
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
