#!/usr/bin/env tsx
/**
 * Fast cancellation-detection worker.
 *
 * Polls recreation.gov directly every POLL_INTERVAL_MS for all active watches,
 * so detection latency is bounded by our own interval instead of Campflare's
 * opaque schedule. Campflare webhooks remain live as a redundant backup path;
 * the atomic claim on notification_sent_at prevents double-notifying.
 *
 * Run: npx tsx worker/poller.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local when running locally; on Fly.io, secrets come from the environment.
try {
  const envPath = resolve(process.cwd(), '.env.local');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim();
    }
  }
} catch {
  // no .env.local — rely on environment
}

import { query, mutate, sqlit } from '../src/lib/db/client';
import { getAvailabilityFromRecGov, hasAvailabilityInRange, recgovBreakerOpen } from '../src/lib/availability/recgov';
import * as recgovScheduler from './recgov-scheduler';
import { SHARD_COUNT, LEASE_RENEW_MS, claimOrRenewShard, heldShard, ownsCampground } from './shard';
import { leadDaysUntil } from './lead-time';
import { heldCheckDue, clampHeldInterval, RC_HELD_CHECK_DEFAULT_MS } from './held-cadence';
import { DueTracker, intervalForLead } from './poll-cadence';
import { startRateProfile } from './rate-profile';
import { findRCOpenUnit, findRCHeldUnits } from '../src/lib/availability/reservecalifornia';
import { findReserveAmericaOpen } from '../src/lib/availability/reserveamerica';
import { findGoingToCampOpen } from '../src/lib/availability/goingtocamp';
import { isGoingToCampSource, GOINGTOCAMP_PROVIDERS } from '../src/lib/sources/goingtocamp/providers';
import { findTnscOpen } from '../src/lib/availability/tnsc';
import { isTnscSource } from '../src/lib/sources/tnsc/providers';
import { fetchLocations } from '../src/lib/sources/goingtocamp/client';
import { syncAllGoingToCamp } from '../src/lib/sources/goingtocamp/sync';
import { startHttpServer } from './http-server';
import { syncAllUseDirect } from '../src/lib/sources/reservecalifornia/sync';
import { fetchUnitTypes } from '../src/lib/sources/reservecalifornia/client';
import { isUseDirectSource, USEDIRECT_PROVIDERS } from '../src/lib/sources/reservecalifornia/providers';
import { dispatchNotifications, type NotificationPayload } from '../src/lib/notifications';
import { bookingLink } from '../src/lib/booking-url';
import { runDetectionCanary, runDeliveryCanary } from './canary';
import { claimNotification } from './claim';
import { offerHold, rcBotUsable, holdWindowLoad } from '../src/lib/rc-holds';
import { RC_HOLD_CAPACITY } from '../src/lib/limits';
import { hasAutocartEntitlement } from '../src/lib/auth';
import { actionUrlFor } from '../src/lib/notifications/actions';
import { alreadyCartedForWatch } from './carted-history';
import { withSyncClaim } from './sync-claim';
import { expireFinishedWatches, EXPIRE_INTERVAL_MS } from './expire-watches';
import { sweepMissedHolds, EXPIRE_HOLDS_INTERVAL_MS } from './expire-holds';
import { findQualifyingRun, flexCandidateStays, isFlexible, type FlexDays, type FlexSpec } from '../src/lib/availability/flex';
import { markAlive, msSinceAlive, msSinceExternalFetchOk, externalFetchWedged } from './liveness';

/** The flexible-date spec carried by a watch row (fixed whole-stay when nights null). */
function flexOf(w: { flex_nights: number | null; flex_days: string | null }): FlexSpec {
  return { nights: w.flex_nights, days: (w.flex_days as FlexDays) ?? null };
}

/**
 * Run a whole-stay availability probe for a watch, handling flexible dates. Fixed
 * watches probe their one [start,end] stay. Flexible watches probe each candidate
 * run within the window (capped) and stop at the first opening — reporting the
 * matched range so the alert deep-links to those exact nights, not the whole window.
 */
async function probeFlexStay<T>(
  w: { start_date: string; end_date: string; min_nights: number; flex_nights: number | null; flex_days: string | null },
  probe: (start: string, end: string, required: number) => Promise<T | null>
): Promise<{ start: string; end: string; dates: string[]; result: T } | null> {
  const spec = flexOf(w);
  if (isFlexible(spec)) {
    for (const c of flexCandidateStays(w.start_date, w.end_date, spec.nights!, spec.days)) {
      const nights = nightsOfRange(c.start, c.end);
      const r = await probe(c.start, c.end, nights.length);
      if (r) return { start: c.start, end: c.end, dates: nights, result: r };
    }
    return null;
  }
  const nights = nightsOfRange(w.start_date, w.end_date);
  const required = Math.max(w.min_nights, nights.length);
  const r = await probe(w.start_date, w.end_date, required);
  return r ? { start: w.start_date, end: w.end_date, dates: nights, result: r } : null;
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
// Auto-cart rec.gov watches run on their own tighter loop so a cancellation gets
// into the cart before someone else grabs it. Detection latency for these is
// bounded by this interval instead of the slower main cycle.
// Reconciler cadence. This was the auto-cart DETECTION interval until 2026-07-31 and
// was the single largest rec.gov consumer in the worker — 10 req/min per campground-
// month against the main cycle's 4. Detection moved into the main cycle; what is left
// here touches the network only for jobs the bot failed to cart.
const AUTOCART_POLL_INTERVAL_MS = Number(process.env.AUTOCART_POLL_INTERVAL_MS ?? 6_000);
// How long after detection we let the bot attempt the cart before the reconciler
// re-verifies availability and decides the fallback alert (see 014_autocart_jobs).
const RECONCILE_DELAY_SEC = Number(process.env.AUTOCART_RECONCILE_DELAY_SEC ?? 35);
const RECGOV_CONCURRENCY = 4;
// How much of a cycle the rec.gov fetches are spread across, so they trickle instead of
// bursting. Kept to half the interval: pacedForEach spreads DISPATCH over this window
// regardless of how many pairs there are, and the cycle's `running` guard skips a tick
// if one overruns — so this must stay comfortably inside POLL_INTERVAL_MS.
const RECGOV_SPREAD_MS = Number(process.env.RECGOV_SPREAD_MS ?? POLL_INTERVAL_MS * 0.5);
// Lead-time tiering (2026-08-01). A campground-month whose first wanted night is more
// than HOT_LEAD_DAYS out rides the scheduler cache for COLD_MAX_AGE_MS instead of
// demanding a fresh read every cycle — so a far-out watch costs ~1 req/min instead
// of 4, and the freed budget is what keeps near-term watches at a true 15s as the
// watch count grows. Justified by the frozen Feature E dataset: 89% of openings
// detected ≥7 days before the stay were still open an hour later, so a 60-second-old
// reading for a next-month trip forfeits nearly nothing. Openings for stays within
// days are the ones snapped up in minutes — those stay hot. A pair touched by an
// auto-cart-lane watch is ALWAYS hot regardless of lead time: carting speed is the
// paid promise, and it is cheap here because auto-cart watches are few by
// construction (the plan gate).
const RECGOV_HOT_LEAD_DAYS = Number(process.env.RECGOV_HOT_LEAD_DAYS ?? 14);
const RECGOV_COLD_MAX_AGE_MS = Number(process.env.RECGOV_COLD_MAX_AGE_MS ?? 60_000);

/**
 * How often to look for UseDirect sites that are LOCKED until a scheduled release.
 *
 * SPEED ONLY BUYS SOMETHING WHEN THE EVENT IS UNPREDICTABLE. A site that just became
 * bookable is gone in minutes and the only defence is polling hard — that is
 * `findRCOpenUnit`, and it stays on the 15s cycle. A site locked until 8am tomorrow is
 * the opposite: the release time is PUBLISHED, we write it to `rc_hold_requests`, and the
 * cart fires off that schedule. Learning about it at 14:00 or 14:05 changes nothing.
 *
 * So this is not lead-time tiering copied over from rec.gov. Tiering by lead-days would
 * have slowed the OPEN check too, which is the one that must stay fast; the useful split
 * here is by *what kind of event* is being watched, not by how far out the stay is.
 *
 * `findRCHeldUnit` does its own `fetchGrid` — there is no grid cache, and the two passes
 * are far enough apart that the client's 40ms coalescing window never merges them — so
 * this pass is roughly HALF of all UseDirect upstream traffic. At 5 minutes that is a 20x
 * cut on it.
 *
 * The floor that keeps 5 minutes safe: `holdIsNewsworthy` already refuses anything with
 * under an hour of lead, so a discovery delay only costs us something if it eats into
 * that hour. Against a release typically ~18 hours out, five minutes is not close.
 */
const RC_HELD_CHECK_MS = clampHeldInterval(Number(process.env.RC_HELD_CHECK_MS ?? RC_HELD_CHECK_DEFAULT_MS));
let rcHeldCheckedAt = 0;
const rcHeldDue = () => heldCheckDue(rcHeldCheckedAt, Date.now(), RC_HELD_CHECK_MS);

/**
 * Lead-time tiering for the providers with no scheduler in front of them.
 *
 * rec.gov gets this from `recgov-scheduler.ts`'s cache; UseDirect, ReserveAmerica,
 * GoingToCamp and TN/SC had nothing, and re-fetched every 15s whether the stay was this
 * weekend or next April. One tracker per partition so a slow provider cannot shift
 * another's schedule. See poll-cadence.ts for the measured survival rates this rests on,
 * and for why Virginia is exempt.
 */
const rcDue = new DueTracker();
const raDue = new DueTracker();
const gtcDue = new DueTracker();
const tnscDue = new DueTracker();

/** Days until a watch's first night, in the shape DueTracker wants. */
function withLead<T extends { id: string; campground_source: string; start_date: string }>(ws: readonly T[]) {
  return ws.map((w) => ({
    ...w,
    source: w.campground_source,
    leadDays: leadDaysUntil(w.start_date, w.start_date.slice(0, 7)),
  }));
}
// Alert-health canary cadences. Detection is cheap (one fetch per source) so it
// runs often; delivery actually SENDS (Resend/Twilio), so it's slow by default to
// avoid spamming the canary sink — /api/health/status staleness thresholds track
// these (see the route). Both overridable via env.
const CANARY_DETECT_INTERVAL_MS = Number(process.env.CANARY_DETECT_INTERVAL_MS ?? 120_000);
// 24h to match worker/fly.toml, which is the only cadence this has ever run at.
// This and worker/canary.ts must agree: canary.ts throttles at 0.9x the interval,
// so a smaller default there would let a restart re-send a real email + SMS.
const CANARY_DELIVERY_INTERVAL_MS = Number(process.env.CANARY_DELIVERY_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
// Self-heal watchdog: if no heartbeat has landed in the DB for this long, the
// machine's networking has wedged (2026-07-22 incident — process up, all egress
// timing out, alerting silently dead). Exit so Fly reboots the microVM and
// re-establishes networking, no human needed. Set WELL above the worst legitimate
// slow cycle (~2 min under a heavy catalog-sync burst) so only a true wedge trips
// it, and below /api/health/status's 5-min WORKER_STALE page so we self-heal
// before a human is paged. Checked on WATCHDOG_CHECK_INTERVAL_MS.
const WATCHDOG_STALE_MS = Number(process.env.WATCHDOG_STALE_MS ?? 4 * 60 * 1000);
const WATCHDOG_CHECK_INTERVAL_MS = Number(process.env.WATCHDOG_CHECK_INTERVAL_MS ?? 30_000);
// Second watchdog trip — the "timeout cascade" (issue #14). The heartbeat watchdog
// above is BLIND to it: rec.gov slow-timeouts starve the socket pool so every provider
// fetch fails, but the Supabase heartbeat write still lands, keeping msSinceAlive()
// fresh. So we also reboot when NO external provider fetch has succeeded for this long
// (fed by the detection canary across all sources — see worker/liveness.ts). Set above
// the 2-min detect-canary interval × a few rounds so a transient blip or a rec.gov-only
// throttle (other sources keep it fresh) never trips it — only an all-sources-down
// stretch does.
const WATCHDOG_EXTERNAL_STALE_MS = Number(process.env.WATCHDOG_EXTERNAL_STALE_MS ?? 6 * 60 * 1000);
// Failure-rate trip for the FLAPPING wedge (observed 2026-07-24): egress mostly dead,
// but the odd source succeeding keeps the staleness timer above from ever going stale,
// so the machine never self-heals. Reboot when, over WATCHDOG_EXTERNAL_WINDOW_MS, there
// were >= MIN_ATTEMPTS detect probes and at least MAX_FAIL_RATIO of them failed. Bar set
// high (default 80% of >=6 attempts over 5 min) so a couple of genuinely-down providers
// (rec.gov throttle + one flaky source) never trips it — only a worker-wide wedge does.
const WATCHDOG_EXTERNAL_WINDOW_MS = Number(process.env.WATCHDOG_EXTERNAL_WINDOW_MS ?? 5 * 60 * 1000);
const WATCHDOG_EXTERNAL_MIN_ATTEMPTS = Number(process.env.WATCHDOG_EXTERNAL_MIN_ATTEMPTS ?? 6);
const WATCHDOG_EXTERNAL_MAX_FAIL_RATIO = Number(process.env.WATCHDOG_EXTERNAL_MAX_FAIL_RATIO ?? 0.8);
// How fresh the mini-PC bot's heartbeat must be for us to treat it as online. The
// bot polls the roster every ~2s, so anything older than this means it's down (box
// off, process crashed, network cut). When it's stale we do NOT route rec.gov
// openings into the silent auto-cart lane — they fall back to normal immediate
// alerts, because a dead bot must never silently swallow a cancellation.
const AUTOCART_BOT_STALE_SEC = Number(process.env.AUTOCART_BOT_STALE_SEC ?? 60);
// The alerting claim (and RENOTIFY_WINDOW) now lives in worker/claim.ts so it can
// be tested — importing poller.ts starts the poller, so nothing here was testable.

// --- Cancellation-likelihood recorder (feature E) --------------------------
// Every cycle the poller already knows whether each watched campground has a
// qualifying whole-stay opening; this persists that observation as a time series
// (availability_observations, migration 020) so the likelihood signal — "opens up
// on ~X% of recent checks" — can be computed later from real history. This is only
// the RECORDER; aggregation + UI ship once enough data has accrued for the number
// to be honest.
//
// It records at most one row per (campground, arrival, nights) window per
// OBSERVATION_INTERVAL_MS: 15s detection granularity is far finer than a
// cancellation-frequency signal needs, and unthrottled it would write millions of
// near-duplicate rows a day. Recording is strictly best-effort — every failure is
// swallowed so it can never affect alerting (and so it degrades to a no-op on a prod
// database that hasn't had migration 020 applied yet).
const OBSERVATION_INTERVAL_MS = Number(process.env.OBSERVATION_INTERVAL_MS ?? 60 * 60 * 1000);
const OBSERVATION_RETENTION_DAYS = Number(process.env.OBSERVATION_RETENTION_DAYS ?? 90);
const OBSERVATION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// In-memory throttle (key -> last recorded epoch ms). Process-lifetime only; a
// restart just permits one extra row per window, which is harmless.
const lastObservationAt = new Map<string, number>();
let lastObservationPruneAt = 0;

function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000);
}

type ObsRow = {
  campgroundId: string;
  source: string;
  arrivalDate: string;
  nights: number;
  leadDays: number;
  hadOpening: boolean;
};

/** Batch-insert observation rows. Best-effort: never throws (a not-yet-applied
 *  migration 020 or a transient DB error must never touch alerting). */
async function insertObservationRows(rows: ObsRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map(
    (r) => `(${sqlit(r.campgroundId)}, ${sqlit(r.source)}, ${sqlit(r.arrivalDate)}, ${r.nights}, ${r.leadDays}, ${r.hadOpening})`
  );
  await mutate(
    `INSERT INTO availability_observations
       (campground_id, source, arrival_date, nights, lead_days, had_opening)
     VALUES ${values.join(', ')}`
  ).catch((err) => console.error('[poller] observation record failed (non-fatal):', err.message));
}

/**
 * Persist this cycle's open/booked observation for each watched window, throttled
 * to one row per window per OBSERVATION_INTERVAL_MS. Best-effort: never throws.
 */
async function recordObservations(rows: Array<{ w: WatchRow; hadOpening: boolean }>): Promise<void> {
  const now = Date.now();
  const todayISO = new Date().toISOString().slice(0, 10);
  const out: ObsRow[] = [];
  for (const { w, hadOpening } of rows) {
    const nights = w.flex_nights ?? nightsOfRange(w.start_date, w.end_date).length;
    const key = `${w.campground_id}|${w.start_date}|${nights}`;
    if (now - (lastObservationAt.get(key) ?? 0) < OBSERVATION_INTERVAL_MS) continue;
    lastObservationAt.set(key, now);
    out.push({
      campgroundId: w.campground_id,
      source: w.campground_source,
      arrivalDate: w.start_date,
      nights,
      leadDays: daysBetween(todayISO, w.start_date),
      hadOpening,
    });
  }
  await insertObservationRows(out);
}

// --- Probe roster (feature E) ----------------------------------------------
// Sample a curated set of high-demand campgrounds (probe_targets, migration 021)
// on a fixed hourly cadence, so the likelihood signal covers popular sites nobody
// happens to be watching. Each target is probed at a few standard lead-times off
// "today" (not fixed calendar dates, which would drift toward lead 0 and expire),
// keeping lead_days buckets stable across weeks. Reuses the exact adapters the
// watch path uses, so it inherits every source's proxy/WAF handling for free.
const PROBE_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS ?? 60 * 60 * 1000);
const PROBE_LEAD_DAYS = (process.env.PROBE_LEAD_DAYS ?? '14,45')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const PROBE_NIGHTS = Number(process.env.PROBE_NIGHTS ?? 2); // a weekend-length stay
const PROBE_CONCURRENCY = 3;
// Spread the roster's probes evenly across a fraction of the interval instead of
// bursting them all at once — a single hourly burst of ~300 rec.gov availability calls
// from one datacenter IP was tripping rec.gov's per-IP rate limit (429 storm → timeout
// cascade). Paced dispatch keeps the average rate low (~a few/min per source) while
// still finishing well within the interval. Capped so a short interval can't push the
// run past the next tick (the probeRunning guard also prevents overlap).
const PROBE_SPREAD_FRACTION = Number(process.env.PROBE_SPREAD_FRACTION ?? 0.6);
const PROBE_SPREAD_MAX_MS = Number(process.env.PROBE_SPREAD_MAX_MS ?? 45 * 60 * 1000);
// OFF as of 2026-07-30, and off by default. The roster was 502 targets × 2 lead
// windows = ~24,000 probes a day, of which the 327 UseDirect ones each cost a Vercel
// function invocation through /api/rc-proxy — roughly 15,700 a day, on par with the
// entire watch poller, to feed a signal that is not shown to anyone
// (SHOW_LIKELIHOOD is false in src/components/v2/likelihood.ts).
//
// Two switches, deliberately: `probe_targets.active` was set false for all 502 rows
// so accrual stopped immediately without a deploy, and this flag so re-running
// scripts/seed-probe-targets.ts — which sets active = true — cannot silently restart
// it. Set PROBE_ENABLED=true in worker/fly.toml AND reactivate the rows to resume.
// The 137k observations already collected are untouched.
const PROBE_ENABLED = process.env.PROBE_ENABLED === 'true';
let probeRunning = false;

/** The [start, checkout) of a PROBE_NIGHTS stay arriving the next Saturday on or
 *  after today+leadDays — weekend demand is where cancellations bite. */
function probeArrival(leadDays: number): { start: string; end: string } {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + leadDays);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1); // 6 = Saturday
  const start = d.toISOString().slice(0, 10);
  const e = new Date(d);
  e.setUTCDate(e.getUTCDate() + PROBE_NIGHTS);
  return { start, end: e.toISOString().slice(0, 10) };
}

/** Whole-stay availability for any source, dispatching to the same adapters the
 *  poll cycle uses. True = a bookable stay exists across [start, end). */
/** `null` = we never found out (throttled / breaker open), which must NOT be recorded
 *  as "no opening" — that is the same lie the search page was telling. */
async function probeWholeStayOpen(source: string, campgroundId: string, start: string, end: string, nights: number): Promise<boolean | null> {
  if (isUseDirectSource(source)) return !!(await findRCOpenUnit(campgroundId, start, end, nights));
  if (isGoingToCampSource(source)) return !!(await findGoingToCampOpen(campgroundId, start, end, nights));
  if (isTnscSource(source)) return !!(await findTnscOpen(campgroundId, start, end, nights));
  if (source === 'reserveamerica') return !!(await findReserveAmericaOpen(campgroundId, start, end, nights));
  return hasAvailabilityInRange(campgroundId, start, end, nights); // rec.gov
}

/** Probe every active roster target once across the standard lead windows and
 *  record the results. Non-overlapping and best-effort. */
async function probeRosterIfDue(): Promise<void> {
  if (!PROBE_ENABLED || probeRunning) return;
  probeRunning = true;
  try {
    const targets = await query<{ campground_id: string; source: string }>(
      `SELECT campground_id, source FROM probe_targets WHERE active`
    ).catch(() => [] as { campground_id: string; source: string }[]);
    if (targets.length === 0) return;
    const todayISO = new Date().toISOString().slice(0, 10);
    const windows = PROBE_LEAD_DAYS.map((lead) => probeArrival(lead));

    // Flatten to independent (target, window) probes and shuffle, so one source's
    // targets (e.g. rec.gov's 150) don't fire back-to-back — the paced runner then
    // spreads them across the interval, keeping every source under its rate limit.
    type ProbeTask = { t: { campground_id: string; source: string }; w: { start: string; end: string } };
    const tasks: ProbeTask[] = [];
    for (const t of targets) for (const w of windows) tasks.push({ t, w });
    for (let i = tasks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
    }

    const rows: ObsRow[] = [];
    const spreadMs = Math.min(PROBE_INTERVAL_MS * PROBE_SPREAD_FRACTION, PROBE_SPREAD_MAX_MS);
    await pacedForEach(tasks, spreadMs, PROBE_CONCURRENCY, async ({ t, w }) => {
      try {
        const open = await probeWholeStayOpen(t.source, t.campground_id, w.start, w.end, PROBE_NIGHTS);
        // Unknown is not a data point. Recording it as `false` would quietly poison the
        // likelihood buckets with throttle noise, which is worse than a smaller sample.
        if (open === null) return;
        rows.push({
          campgroundId: t.campground_id,
          source: t.source,
          arrivalDate: w.start,
          nights: PROBE_NIGHTS,
          leadDays: daysBetween(todayISO, w.start),
          hadOpening: open,
        });
      } catch {
        // transport/WAF error for this window → no row, rather than a false 'booked'
      }
    });
    await insertObservationRows(rows);
    console.log(
      `[poller] probe roster — ${targets.length} targets × ${windows.length} windows over ${(spreadMs / 60000).toFixed(0)}m → ${rows.length} observations`
    );
  } catch (err) {
    console.error('[poller] probe roster failed (non-fatal):', (err as Error).message);
  } finally {
    probeRunning = false;
  }
}

/** Drop observations past the retention window. Best-effort, at most every 6h. */
async function pruneObservationsIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastObservationPruneAt < OBSERVATION_PRUNE_INTERVAL_MS) return;
  lastObservationPruneAt = now;
  await mutate(
    `DELETE FROM availability_observations
     WHERE observed_at < NOW() - INTERVAL '${OBSERVATION_RETENTION_DAYS} days'`
  ).catch((err) => console.error('[poller] observation prune failed (non-fatal):', err.message));
}

interface WatchRow {
  id: string;
  user_id: string;
  campground_id: string;
  start_date: string; // YYYY-MM-DD (check-in)
  end_date: string;   // YYYY-MM-DD (check-out)
  min_nights: number;
  campground_name: string;
  campground_source: string;
  reservations_url: string | null;
  rc_hold_notified_for: string | null;
  muted_site_ids: string[];
  flex_nights: number | null;
  flex_days: string | null;
  autocart_enabled: boolean;
  autocart_connected: boolean;
  autocart_verified_at: string | null;
  autocart_entitled: boolean;
  /** Per-watch opt-out. See isAutocartLane. */
  auto_cart: boolean;
}

// How recently the bot must have confirmed a user's rec.gov session (via a keepalive
// or sign-in stamping autocart_verified_at) for the auto-cart lane to be used. The bot
// keepalive runs ~every 30m; this allows one missed keepalive before we fail open to
// normal alerts, so a session that silently dies mid-interval can't keep swallowing
// openings into a lane the bot can't service. Override with AUTOCART_SESSION_STALE_MS.
const AUTOCART_SESSION_STALE_MS = Number(process.env.AUTOCART_SESSION_STALE_MS ?? 45 * 60 * 1000);

/** Has the bot confirmed this user's rec.gov session recently enough to trust it? */
function autocartSessionFresh(w: WatchRow): boolean {
  if (!w.autocart_verified_at) return false; // never verified → fail open to normal alert
  return Date.now() - Date.parse(w.autocart_verified_at) < AUTOCART_SESSION_STALE_MS;
}

/**
 * A watch handled by the tighter auto-cart lane: a recreation.gov site whose owner
 * is enrolled in auto-cart AND has a live rec.gov session. For these we don't alert
 * on detection — we create a pending job, let the bot try to cart it, and decide the
 * alert on the outcome (see reconcileAutocartJobs + 014_autocart_jobs.sql).
 */
function isAutocartLane(w: WatchRow, botOnline: boolean): boolean {
  return (
    botOnline &&
    w.campground_source === 'ridb' &&
    // Plan gate (2026-08-01): auto-cart is the paid Auto-Cart tier (or a
    // grandfathered pre-tier subscription, or beta). A user whose entitlement
    // lapsed keeps autocart_enabled = true in their settings, so the flag alone
    // would keep swallowing their openings into a lane the bot no longer serves —
    // failing open to a normal alert is the only acceptable downgrade.
    w.autocart_entitled === true &&
    // PER-WATCH opt-out (2026-08-01). `watches.auto_cart` existed since migration 001
    // but was never written and never read here, so the New watch screen's auto-cart
    // toggle did nothing at all — switch it off and the site was still carted. The
    // account-level switches below remain necessary; this one lets a user say "not
    // for THIS watch", which is the difference between a trip they want held
    // automatically and one they'd rather decide on. Migration 035 backfilled it true
    // for every watch that was already carting, so this changed no live behaviour.
    w.auto_cart === true &&
    w.autocart_enabled === true &&
    w.autocart_connected === true &&
    autocartSessionFresh(w)
  );
}

/**
 * Is the mini-PC bot actually online? Reads the heartbeat it stamps on every
 * roster poll (015_autocart_bot_heartbeat). Fail-OPEN: a missing row or a read
 * error returns false, so auto-cart watches fall back to normal immediate alerts
 * rather than being silently swallowed by a lane no live bot is servicing.
 */
async function isBotOnline(): Promise<boolean> {
  try {
    const rows = await query<{ fresh: boolean }>(
      `SELECT beat_at > NOW() - INTERVAL '${AUTOCART_BOT_STALE_SEC} seconds' AS fresh
       FROM autocart_bot_heartbeat WHERE id = 1`
    );
    return rows[0]?.fresh === true;
  } catch (err) {
    console.error('[poller] bot heartbeat read failed — treating bot as offline:', (err as Error).message);
    return false;
  }
}

/** Months (YYYY-MM) that the nights of [start, end) span. */
function monthsForRange(startDate: string, endDate: string): string[] {
  const months = new Set<string>();
  const cur = new Date(`${startDate}T00:00:00Z`);
  const lastNight = new Date(`${endDate}T00:00:00Z`);
  lastNight.setUTCDate(lastNight.getUTCDate() - 1); // end_date is checkout
  while (cur <= lastNight) {
    months.add(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1, 1);
  }
  return [...months];
}

/** All nights of [start, end) as YYYY-MM-DD strings. */
/** Checkout date (YYYY-MM-DD) = the day after the last night of a run. */
function checkoutAfter(nights: string[], fallback: string): string {
  if (nights.length === 0) return fallback;
  const d = new Date(`${nights[nights.length - 1]}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function nightsOfRange(startDate: string, endDate: string): string[] {
  const nights: string[] = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur < end) {
    nights.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return nights;
}

async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function workerLoop() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, workerLoop));
  return results;
}

/** Run `fn` over `tasks` at a steady, jittered rate so the whole set is spread across
 *  ~`spreadMs` rather than bursting — with never more than `limit` in flight. This is
 *  what keeps the probe roster under rec.gov's per-IP rate limit. Best-effort: a task
 *  that throws is swallowed (the caller already try/catches per probe). Resolves once
 *  every task has settled. Uses timers/Math.random — fine in the Node worker runtime. */
function pacedForEach<T>(tasks: T[], spreadMs: number, limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    if (tasks.length === 0) return resolve();
    const gap = Math.max(1, spreadMs / tasks.length); // average ms between dispatches
    let idx = 0;
    let active = 0;
    let done = 0;
    const settle = () => {
      active--;
      done++;
      if (done === tasks.length) resolve();
    };
    const dispatch = () => {
      const t = tasks[idx++];
      active++;
      Promise.resolve(fn(t)).catch(() => {}).finally(settle);
    };
    const scheduleNext = () => {
      if (idx >= tasks.length) return; // all dispatched; in-flight ones resolve via settle
      const jittered = gap * (0.5 + Math.random()); // ±50% so ticks don't align
      setTimeout(() => {
        if (active < limit) dispatch(); // else: idx unchanged, retry on the next tick
        scheduleNext();
      }, jittered);
    };
    dispatch(); // first goes immediately
    scheduleNext();
  });
}

async function loadWatches(): Promise<WatchRow[]> {
  return query<WatchRow>(
    `SELECT w.id, w.user_id, w.campground_id,
            w.start_date::text, w.end_date::text, w.min_nights,
            w.rc_hold_notified_for, w.muted_site_ids, w.flex_nights, w.flex_days,
            COALESCE(w.auto_cart, false) AS auto_cart,
            c.name AS campground_name, c.source AS campground_source,
            c.reservations_url,
            COALESCE(u.autocart_enabled, false) AS autocart_enabled,
            COALESCE(u.autocart_connected, false) AS autocart_connected,
            u.autocart_verified_at::text AS autocart_verified_at,
            (u.is_beta OR EXISTS (
               SELECT 1 FROM subscriptions s
                WHERE s.user_id = u.id
                  AND s.status IN ('active', 'trialing')
                  AND (s.tier = 'autocart' OR s.grandfathered)
            )) AS autocart_entitled
     FROM watches w
     JOIN campgrounds c ON c.id = w.campground_id
     JOIN users u ON u.id = w.user_id
     WHERE w.active = true
       AND w.end_date > CURRENT_DATE
       `
  );
  // NOTE: this deliberately no longer filters on notification_sent_at. The cooldown
  // is per (watch, site) now — see claimNotification — and a watch that is never
  // CHECKED can never reveal that a different site opened. Excluding it here was
  // what made a new site invisible for up to an hour.
  //
  // Load is unchanged in the steady state: the candidate set is now "every active
  // watch", which is exactly what it already was whenever nothing had alerted
  // recently, and fetches are deduplicated per campground+month regardless.
}

/**
 * Claim the right to send the ReserveCalifornia "coming soon" heads-up for this
 * held release. Deduped by the release timestamp (a held site sits in this state
 * for hours, so we must alert once, not every cycle). Does NOT touch
 * notification_sent_at, so the real "now available" alert still fires at release.
 */
/**
 * A hold is only NEWS if it releases far enough out to be worth waiting for.
 *
 * The "coming soon" alert assumes RC's `Lock` is the overnight release — a cancelled
 * site held until ~8am the next day. Observed 2026-08-06, that assumption broke: the
 * owner got two texts a minute apart reading "opens Aug 6, 8:15 AM PT" and "opens Aug 6,
 * 8:16 AM PT", i.e. a lock roughly ONE MINUTE ahead that kept moving. A stable overnight
 * release cannot do that; a short lock being held and extended can — which is exactly
 * what a shopping cart is (our own bot does it via `extendShoppingCartTimer`).
 *
 * I could not observe a locked slice live to confirm the mechanism, so this does not
 * claim to know what `Lock` means in general. It only declines to describe a lock
 * expiring in minutes as "was just cancelled, opens at X".
 *
 * Suppressing these costs nothing: when the lock lapses the site becomes free, and the
 * ordinary availability alert fires within one poll cycle. The heads-up exists for the
 * case where that is HOURS away and the user needs to set an alarm.
 */
const HOLD_MIN_LEAD_MS = 60 * 60_000;

export function holdIsNewsworthy(availableAt: string, now = new Date()): boolean {
  // RC sends ISO local (no zone). Treat it as wall-clock in the server's zone, which is
  // what the formatter downstream already assumes — consistent beats subtly-different.
  const at = new Date(availableAt).getTime();
  if (!Number.isFinite(at)) return false;
  return at - now.getTime() >= HOLD_MIN_LEAD_MS;
}

/**
 * Claim the right to send ONE "coming soon" for this watch's current hold.
 *
 * Keyed on the release time rounded to the HOUR, not the exact instant. The exact
 * timestamp was the dedupe key, so a lock that crept forward by a minute read as a
 * brand-new event and sent another text — two identical alerts, one minute apart. The
 * user cannot act on minute-level precision in a release that is at least an hour away,
 * so the hour is the honest granularity.
 */
async function claimHoldNotification(watchId: string, releaseAt: string): Promise<boolean> {
  const bucket = new Date(releaseAt);
  const key = Number.isFinite(bucket.getTime())
    ? `${bucket.getFullYear()}-${bucket.getMonth() + 1}-${bucket.getDate()}T${bucket.getHours()}`
    : releaseAt;
  const rows = await mutate<{ id: string }>(
    `UPDATE watches SET rc_hold_notified_for = $2
     WHERE id = $1 AND active = true AND rc_hold_notified_for IS DISTINCT FROM $2
     RETURNING id`,
    [watchId, key]
  );
  return rows.length > 0;
}

/**
 * The site number a ReserveCalifornia camper would recognise.
 *
 * RC's grid gives every unit a human name — "Hook Up (E ) Campsite #L006" — and we were
 * discarding it in favour of `Unit ${UnitId}`, RC's internal primary key. An alert
 * reading "Site Unit 42573" names a number that appears NOWHERE on ReserveCalifornia's
 * own pages, so it cannot be matched against the map or the listing.
 *
 * The `#L006` token is the part people actually use, so prefer it; fall back to the
 * whole name, and only to the id if RC gave us nothing.
 */
export function rcSiteLabel(name: string | null | undefined, unitId: number): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return `Unit ${unitId}`;
  const hash = /#\s*([A-Za-z0-9][A-Za-z0-9-]*)/.exec(trimmed);
  return hash ? `#${hash[1]}` : trimmed;
}

interface WatchResult {
  dates: string[];
  campsiteId: string | null;
  campsiteName: string | null;
}

/**
 * Dates a single campsite can host the required consecutive stay within the
 * watch window. Nights open at different sites don't combine into a bookable
 * stay, so we check per site and return the first qualifying run's dates —
 * along with that site's id/name, so the alert can link straight to it.
 */
function availableDatesForWatch(
  watch: WatchRow,
  monthData: Map<string, Awaited<ReturnType<typeof getAvailabilityFromRecGov>>>
): WatchResult {
  const nights = nightsOfRange(watch.start_date, watch.end_date);
  const nightSet = new Set(nights);
  const required = Math.max(watch.min_nights, nights.length);

  const bySite = new Map<string, { open: Set<string>; name: string | null }>();
  for (const month of monthsForRange(watch.start_date, watch.end_date)) {
    const avail = monthData.get(`${watch.campground_id}|${month}`);
    if (!avail) continue;
    for (const cs of avail.campsites) {
      const entry = bySite.get(cs.campsiteId) ?? { open: new Set<string>(), name: cs.campsiteName };
      for (const day of cs.availability) {
        if (day.status === 'available' && nightSet.has(day.date)) entry.open.add(day.date);
      }
      bySite.set(cs.campsiteId, entry);
    }
  }

  const muted = new Set(watch.muted_site_ids ?? []);
  const spec = flexOf(watch);
  for (const [campsiteId, entry] of bySite) {
    if (muted.has(campsiteId)) continue; // site-specific mute — keep looking for another
    const dates = [...entry.open].sort();
    // Flexible: match any flex_nights run (optionally weekend) within the window, and
    // report just that run. Fixed: the legacy whole-[start,end] stay.
    const run = isFlexible(spec)
      ? findQualifyingRun(dates, spec.nights!, spec.days)
      : hasConsecutiveRun(dates, required)
        ? dates
        : null;
    if (run) return { dates: run, campsiteId, campsiteName: entry.name };
  }
  return { dates: [], campsiteId: null, campsiteName: null };
}

/** True if `dates` contains a run of at least minNights consecutive days. */
function hasConsecutiveRun(dates: string[], minNights: number): boolean {
  if (dates.length === 0) return false;
  if (minNights <= 1) return true;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`).getTime();
    const cur = new Date(`${dates[i]}T00:00:00Z`).getTime();
    run = cur - prev === 86_400_000 ? run + 1 : 1;
    if (run >= minNights) return true;
  }
  return false;
}

async function beat(watchesChecked: number): Promise<void> {
  try {
    await mutate(
      `UPDATE worker_heartbeat SET beat_at = NOW(), watches_checked = $1 WHERE id = 1`,
      [watchesChecked]
    );
    // Only mark liveness on a SUCCESSFUL write — proof the poller reached the DB
    // this cycle. A network wedge makes this throw, so liveness goes stale and
    // the watchdog (main) reboots the machine. See worker/liveness.ts.
    markAlive();
  } catch (err) {
    console.error('[poller] heartbeat write failed:', err);
  }
}

async function cycle(): Promise<void> {
  const watches = await loadWatches();
  if (watches.length === 0) {
    await beat(0);
    console.log(`[poller] heartbeat — no active watches`);
    return;
  }

  // ONE detection pass for every watch, auto-cart included (2026-07-31). Auto-cart
  // used to have its own 6-SECOND loop doing identical detection with a different
  // ending — queue a job instead of send an alert — which cost 10 rec.gov req/min per
  // campground-month against the main cycle's 4, i.e. 2.5x for the same information.
  // With a shared rate budget that multiplier was consuming two thirds of the worker's
  // entire rec.gov allowance for a single campground, starving every other watch down
  // to a ~53s refresh. Detection is the same work; only the terminal action differs, so
  // it belongs in one loop.
  //
  // `isAutocartLane` only ever matches `ridb` watches, so dropping the filter here
  // leaves the RA/RC/GTC/TNSC partitions below completely unchanged.
  const botOnline = await isBotOnline();
  // Shard filter. At SHARD_COUNT=1 ownsCampground is unconditionally true, so this is
  // a no-op — see worker/shard.ts for why that short-circuit exists rather than
  // depending on a lease the single poller doesn't need.
  const mainWatches = SHARD_COUNT === 1 ? watches : watches.filter((w) => ownsCampground(w.campground_id));
  const raWatches = mainWatches.filter((w) => w.campground_source === 'reserveamerica');
  const rcWatches = mainWatches.filter((w) => isUseDirectSource(w.campground_source));
  const gtcWatches = mainWatches.filter((w) => isGoingToCampSource(w.campground_source));
  const tnscWatches = mainWatches.filter((w) => isTnscSource(w.campground_source));
  const ridbWatches = mainWatches.filter(
    (w) =>
      !isUseDirectSource(w.campground_source) &&
      !isGoingToCampSource(w.campground_source) &&
      !isTnscSource(w.campground_source) &&
      w.campground_source !== 'reserveamerica'
  );

  // recreation.gov: one fetch per unique campground+month, shared across watches.
  // Each pair carries the smallest lead-days of any watch wanting it (0 for the
  // auto-cart lane), which decides hot vs cold freshness at dispatch below.
  const pairLead = new Map<string, number>();
  for (const w of ridbWatches) {
    const laneHot = isAutocartLane(w, botOnline);
    for (const month of monthsForRange(w.start_date, w.end_date)) {
      const key = `${w.campground_id}|${month}`;
      const lead = laneHot ? 0 : leadDaysUntil(w.start_date, month);
      const prev = pairLead.get(key);
      if (prev === undefined || lead < prev) pairLead.set(key, lead);
    }
  }
  const pairs = new Set(pairLead.keys());
  const hotPairs = [...pairLead.values()].filter((l) => l <= RECGOV_HOT_LEAD_DAYS).length;

  const monthData = new Map<string, Awaited<ReturnType<typeof getAvailabilityFromRecGov>>>();
  const rcResults = new Map<string, { dates: string[]; unitId: number; sleepingUnitId: number | null; name: string | null }>();
  const rcHeld = new Map<string, { dates: string[]; availableAt: string; unitId: number | null; name: string | null }[]>();
  const raResults = new Map<string, { dates: string[]; siteIds: number[]; start: string; end: string }>();
  const gtcResults = new Map<string, { dates: string[]; resourceIds: number[]; start: string; end: string }>();
  const tnscResults = new Map<string, { dates: string[]; start: string; end: string }>();
  if (tnscWatches.length > 0) console.log(`[poller] checking ${tnscWatches.length} TN/SC watch(es)`);

  // WHAT WE ACTUALLY FETCHED THIS CYCLE, not what we could have. The heartbeat used to
  // print `${rcWatches.length} RC fetches`, which was true only while every watch was
  // checked every cycle; with tiering it would keep printing the old number forever while
  // the real rate fell, and a metric that cannot go down cannot report a problem. Same
  // lesson as the rec.gov counters — nothing reporting our own request rate was the root
  // cause of every wrong diagnosis in that episode.
  const now = Date.now();
  const rcOpenDue = rcDue.due(withLead(rcWatches), now);
  const raDueNow = raDue.due(withLead(raWatches), now);
  const gtcDueNow = gtcDue.due(withLead(gtcWatches), now);
  const tnscDueNow = tnscDue.due(withLead(tnscWatches), now);
  let rcHeldChecked = 0;

  // The per-source fetch phases run CONCURRENTLY. They're independent (each writes
  // its own result map from a disjoint set of watches), so running them in parallel
  // means a slow/throttled source (e.g. rec.gov under a 429 storm eating 10s
  // timeouts) can no longer head-of-line-block every other source and stretch the
  // whole cycle — the reason one bad provider used to degrade alert latency for all.
  // Per-provider concurrency is UNCHANGED: each phase still bounds its own fanout
  // with pMap(RECGOV_CONCURRENCY), so no single provider is hit any harder.
  await Promise.all([
    // recreation.gov. getAvailabilityFromRecGov swallows fetch errors and returns
    // empty campsites, so a transient failure never looks like "nothing available →
    // skip" incorrectly; it also self-throttles via a breaker under a 429 storm.
    //
    // PACED, not bursted. pMap(4) fired all four campground-months simultaneously and
    // then sat idle for the rest of the 15s cycle — the same average rate presented as
    // a burst, which is exactly what a token-bucket limiter rejects. The identical
    // mistake once tripped rec.gov with the feature-E probe roster (see PROBE_SPREAD_*)
    // and was fixed there the same way. Same requests, same cadence, spread out.
    //
    // Cost: the last campground dispatched is checked up to RECGOV_SPREAD_MS later
    // within its cycle, so average detection latency rises by a couple of seconds. That
    // is worth far less than the ~40% of the time rec.gov watches were going unchecked
    // behind an open breaker on 2026-07-30.
    pacedForEach(
      [...pairs],
      RECGOV_SPREAD_MS,
      RECGOV_CONCURRENCY,
      async (pair) => {
        const [campgroundId, month] = pair.split('|');
        // LOW priority: this lane runs every 15s and can ride on anything the auto-cart
        // lane fetched moments ago. Under a squeeze it yields to carting.
        //
        // HOT pairs (a wanted night within RECGOV_HOT_LEAD_DAYS, or any auto-cart-lane
        // watch) insist on this cycle's freshness; COLD pairs accept a reading up to
        // RECGOV_COLD_MAX_AGE_MS old, which the scheduler serves from cache for free —
        // that skipped token is the budget headroom that keeps hot pairs at 15s.
        const hot = (pairLead.get(pair) ?? 0) <= RECGOV_HOT_LEAD_DAYS;
        const r = await recgovScheduler.getAvailability(campgroundId, month, {
          maxAgeMs: hot ? POLL_INTERVAL_MS * 0.8 : RECGOV_COLD_MAX_AGE_MS,
          priority: 'low',
        });
        monthData.set(pair, r.value);
      }
    ),

    // ReserveCalifornia: available units first, THEN the held/coming-soon check for
    // watches not already bookable — ordered, so this pair stays a single task.
    (async () => {
      // Find the specific open unit hosting the full stay.
      await pMap(
        rcOpenDue,
        async (w) => {
          const nights = nightsOfRange(w.start_date, w.end_date);
          const required = Math.max(w.min_nights, nights.length);
          const open = await findRCOpenUnit(w.campground_id, w.start_date, w.end_date, required, w.muted_site_ids, flexOf(w));
          // Flexible watches report just the matched run; fixed report the whole stay.
          if (open) rcResults.set(w.id, { dates: open.dates.length ? open.dates : nights, unitId: open.unitId, sleepingUnitId: open.sleepingUnitId, name: open.name });
        },
        RECGOV_CONCURRENCY
      );
      // Held state: cancelled sites RC locks until a release time (~8am next day).
      // Only check watches that aren't already bookable now.
      //
      // FLEX GOES THROUGH, exactly as it does for the open check above. Without it the
      // required run is the whole window — for "any 4 nights between Sep 4 and Sep 13"
      // that asked whether one unit held all NINE, which never happens. Six of the nine
      // live RC watches were flexible on 2026-08-07, so two thirds of them could never
      // receive a coming-soon alert or an 8am hold offer. Unlike probeFlexStay this
      // costs no extra upstream calls: RC's grid is a full grid, so the run search is
      // in-memory over the one fetch.
      //
      // ON ITS OWN SLOW CADENCE — see RC_HELD_CHECK_MS. A skipped cycle leaves `rcHeld`
      // empty, which reads downstream as "nothing coming soon", and that is correct
      // rather than merely tolerable: the alert is idempotent (`offerHold` upserts per
      // watch+unit+arrival and will not walk a status backwards) and the cart runs off
      // `release_at`, not off having seen the lock recently.
      if (rcHeldDue()) {
        rcHeldCheckedAt = Date.now();
        // EVERY WATCH, not just the ones with nothing bookable. This used to skip any
        // watch that already had an open unit, on the reading that a user with a site
        // available now does not need to hear about one releasing tomorrow. They are
        // different offers and only one of them expires: "book this now" is a site that
        // may suit or may not, and "we can hold #38 at 08:00" is the specific site the
        // watch was set up for. Suppressing the second because of the first silently
        // narrowed the product to whichever site happened to be free first.
        //
        // Cheap now in a way it was not before: the held pass runs every 5 minutes
        // (RC_HELD_CHECK_MS), so covering every watch instead of a subset costs one grid
        // fetch per watch per five minutes.
        const heldTargets = rcWatches;
        rcHeldChecked = heldTargets.length;
        await pMap(
          heldTargets,
          async (w) => {
            const required = Math.max(w.min_nights, nightsOfRange(w.start_date, w.end_date).length);
            // ALL of them — see findRCHeldUnits. One grid fetch either way.
            const held = await findRCHeldUnits(
              w.campground_id, w.start_date, w.end_date, required, flexOf(w), w.muted_site_ids);
            if (held.length) rcHeld.set(w.id, held.map((h) => ({ dates: h.dates, availableAt: h.availableAt, unitId: h.unitId, name: h.name })));
          },
          RECGOV_CONCURRENCY
        );
      }
    })(),

    // ReserveAmerica: HTML-scrape check for a site bookable across the full stay.
    pMap(
      raDueNow,
      async (w) => {
        const m = await probeFlexStay(w, (s, e, required) => findReserveAmericaOpen(w.campground_id, s, e, required));
        if (m) raResults.set(w.id, { dates: m.dates, siteIds: m.result.siteIds, start: m.start, end: m.end });
      },
      RECGOV_CONCURRENCY
    ),

    // GoingToCamp: the Camis API answers whole-stay directly, so one call per watch.
    pMap(
      gtcDueNow,
      async (w) => {
        const m = await probeFlexStay(w, (s, e, required) => findGoingToCampOpen(w.campground_id, s, e, required));
        if (m) gtcResults.set(w.id, { dates: m.dates, resourceIds: m.result.resourceIds, start: m.start, end: m.end });
      },
      RECGOV_CONCURRENCY
    ),

    // TN/SC ColdFusion portal: batched whole-stay availability, keyed by parkId. The
    // client caches the per-range batch, so N watches on one date range share a single
    // POST. No per-site ids — alerts are park+date. (findTnscOpen swallows errors, so
    // an unreachable portal simply never alerts rather than crashing the cycle. See
    // docs/CONTEXT.md.)
    pMap(
      tnscDueNow,
      async (w) => {
        const m = await probeFlexStay(w, async (s, e, required) => {
          const open = await findTnscOpen(w.campground_id, s, e, required);
          console.log(`[poller] TN/SC ${w.campground_id} (${s}..${e}): ${open ? `OPEN ${open.availableSites} sites` : 'no opening'}`);
          return open;
        });
        if (m) tnscResults.set(w.id, { dates: m.dates, start: m.start, end: m.end });
      },
      RECGOV_CONCURRENCY
    ),
  ]);

  let notified = 0;
  // Feature E: this cycle's open/booked observation per watched window, recorded
  // (throttled) after the notify loop. Covers EVERY watch now that auto-cart shares
  // this loop, so the sampling no longer has a hole where the popular sites are.
  const observed: Array<{ w: WatchRow; hadOpening: boolean }> = [];
  for (const watch of mainWatches) {
    const rc = rcResults.get(watch.id);
    const result: WatchResult =
      watch.campground_source === 'reserveamerica'
        ? { dates: raResults.get(watch.id)?.dates ?? [], campsiteId: null, campsiteName: null }
        : isGoingToCampSource(watch.campground_source)
          ? { dates: gtcResults.get(watch.id)?.dates ?? [], campsiteId: null, campsiteName: null }
        : isTnscSource(watch.campground_source)
          ? { dates: tnscResults.get(watch.id)?.dates ?? [], campsiteId: null, campsiteName: null }
        : isUseDirectSource(watch.campground_source)
          // Surface the RC unit as the mutable "site" (id + friendly label).
          // RC's own label for the unit ("Hook Up (E ) Campsite #L006"), not its
          // internal UnitId. An alert reading "Site Unit 42573" names a number the
          // user cannot find anywhere on ReserveCalifornia's own site.
          ? { dates: rc?.dates ?? [], campsiteId: rc ? String(rc.unitId) : null, campsiteName: rc ? rcSiteLabel(rc.name, rc.unitId) : null }
          : availableDatesForWatch(watch, monthData);
    observed.push({ w: watch, hadOpening: result.dates.length > 0 });
    if (result.dates.length === 0) continue;

    // Matched stay range: for flexible watches this is the run inside the window;
    // for fixed watches it equals the watch's own [start,end]. Deep links and the
    // alert's dates use this so the user lands on the exact nights that opened.
    const matchStart = result.dates[0] ?? watch.start_date;
    const matchEnd = checkoutAfter(result.dates, watch.end_date);

    // Also the "still open" observation — see claimNotification. A quiet answer here
    // usually means the site has been open continuously since we alerted, which is not
    // news; it is the same opening we already reported.
    const claim = await claimNotification(watch.id, result.campsiteId);
    if (!claim.won) {
      console.log(
        `[poller] watch ${watch.id}: ${result.campsiteId ?? 'campground'} still open, already alerted — staying quiet`
      );
      continue;
    }
    if (claim.reason === 'nudge') {
      console.log(
        `[poller] watch ${watch.id}: ${result.campsiteId ?? 'campground'} STILL open 6h on — sending the one follow-up`
      );
    }

    // Auto-cart lane: hand the opening to the bot instead of alerting. Same claim,
    // same detection, different ending. If there is no specific site id there is
    // nothing to cart, so it falls through to a normal alert. A site this watch has
    // already had carted once is also excluded — see alreadyCartedForWatch.
    const cartSiteId = isAutocartLane(watch, botOnline) ? result.campsiteId : null;
    const alreadyCarted = cartSiteId !== null && (await alreadyCartedForWatch(watch.id, cartSiteId));
    if (alreadyCarted) {
      console.log(
        `[poller] watch ${watch.id}: site ${cartSiteId} was already carted for this watch — alerting instead of re-carting`
      );
    }
    if (cartSiteId !== null && !alreadyCarted) {
      try {
        await mutate(
          `INSERT INTO autocart_jobs (watch_id, user_id, campground_id, campsite_id, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [watch.id, watch.user_id, watch.campground_id, cartSiteId, JSON.stringify(autocartPayload(watch, result))]
        );
        console.log(
          `[poller] AUTOCART OPENING: ${watch.campground_name} site ${cartSiteId} (${result.dates.join(', ')}) — job queued, waiting on the bot (watch ${watch.id})`
        );
      } catch (err) {
        console.error(`[poller] autocart enqueue failed for watch ${watch.id}:`, err);
      }
      continue;
    }

    console.log(
      `[poller] AVAILABILITY: ${watch.campground_name} (${watch.campground_id}) — ${result.dates.join(', ')} — notifying watch ${watch.id}`
    );
    try {
      await dispatchNotifications({
        userId: watch.user_id,
        watchId: watch.id,
        campgroundId: watch.campground_id,
        campgroundName: watch.campground_name,
        availableDates: result.dates,
        bookingUrl:
          watch.campground_source === 'reserveamerica'
            // Land on the arrival date's site grid, not the undated park page.
            // Same calarvdate form the detail-page calendar already uses.
            ? (bookingLink({
                source: 'reserveamerica',
                reservationsUrl: watch.reservations_url,
                date: matchStart,
              }) ?? 'https://www.reserveamerica.com/')
            : isGoingToCampSource(watch.campground_source)
            // Park + dates deep link (create-booking/results base stored as
            // reservations_url by the sync). Falls back to the tenant root pre-sync.
            ? (bookingLink({
                source: 'goingtocamp',
                reservationsUrl: watch.reservations_url,
                date: matchStart,
                endDate: matchEnd,
              }) ?? 'https://goingtocamp.com/')
            : isTnscSource(watch.campground_source)
            // TN/SC portal reports counts, not site ids → no deep link; the park's
            // booking page (reservations_url) is the CTA.
            ? (watch.reservations_url ?? 'https://reserve.tnstateparks.com/')
            : isUseDirectSource(watch.campground_source)
            // Deep-link to the specific facility (loop) — bookingLink turns RC's
            // /park/<placeId> into /park/<placeId>/<facilityId>. The #camphawk-rc
            // fragment (unitId_arrival_nights_sleepingUnitId) still rides along so the
            // extension can autofill the cart; it never hits RC's server.
            ? `${bookingLink({
                source: watch.campground_source,
                reservationsUrl: watch.reservations_url,
                campgroundId: watch.campground_id,
              }) ?? watch.reservations_url ?? 'https://www.reservecalifornia.com/'}${
                rc ? `#camphawk-rc=${rc.unitId}_${matchStart}_${result.dates.length}_${rc.sleepingUnitId ?? ''}` : ''
              }`
            : result.campsiteId
              // #camphawk fragment carries the dates for the browser extension's
              // optional autofill. Fragments are never sent to rec.gov's server.
              ? `https://www.recreation.gov/camping/campsites/${result.campsiteId}#camphawk=${matchStart}_${matchEnd}`
              : `https://www.recreation.gov/camping/campgrounds/${watch.campground_id}`,
        campsiteId: result.campsiteId,
        campsiteName: result.campsiteName,
        startDate: matchStart,
        endDate: matchEnd,
        // The six-hour follow-up must not read like a fresh opening — worded the same,
        // it is indistinguishable from the hourly-repeat bug it replaces.
        kind: claim.reason === 'nudge' ? 'still_open' : 'available',
      });
      notified++;
      // A held site that just went live: clear the held marker so a future
      // cancellation of the same site alerts again.
      if (isUseDirectSource(watch.campground_source) && watch.rc_hold_notified_for) {
        await mutate(`UPDATE watches SET rc_hold_notified_for = NULL WHERE id = $1`, [watch.id]).catch(() => {});
      }
    } catch (err) {
      console.error(`[poller] notification failed for watch ${watch.id}:`, err);
    }
  }

  // ReserveCalifornia "coming soon" heads-up: a watched site is cancelled-but-held
  // and will release at a known time. Deduped per release time (separate from the
  // available claim, so the "now bookable" alert still fires when it opens).
  for (const w of rcWatches) {
    // NOT skipped when something is already available — see the held pass above. The
    // dedup that matters is `claimHoldNotification`, which is keyed on the RELEASE TIME,
    // so a coming-soon heads-up still goes out at most once per release however many
    // ordinary availability alerts the same watch sends.
    const heldUnits = rcHeld.get(w.id);
    if (!heldUnits?.length) continue;
    // RECORD AN OFFER FOR EVERY held unit, so the watch page can list them all and each
    // has its own one-tap hold link — but ALERT about only the soonest. A text per site
    // on a four-cancellation morning is the notification flood migration 039 exists to
    // prevent, and the extra offers are one tap away in the app either way.
    for (const extra of heldUnits.slice(1)) {
      if (extra.unitId == null || !holdIsNewsworthy(extra.availableAt)) continue;
      if (!(await hasAutocartEntitlement(w.user_id).catch(() => false))) break;
      await offerHold({
        watchId: w.id,
        userId: w.user_id,
        campgroundId: w.campground_id,
        unitId: String(extra.unitId),
        unitName: rcSiteLabel(extra.name, extra.unitId),
        arrivalDate: extra.dates[0] ?? w.start_date,
        nights: extra.dates.length || 1,
        releaseAt: extra.availableAt,
      }).catch(() => null);
    }
    const held = heldUnits[0];
    // A lock expiring in minutes is not a cancellation heads-up — see holdIsNewsworthy.
    // The site becoming free will alert on its own within a cycle.
    if (!holdIsNewsworthy(held.availableAt)) {
      console.log(
        `[poller] watch ${w.id}: hold on ${w.campground_name} releases ${held.availableAt} — too soon to be news, staying quiet`
      );
      continue;
    }
    if (!(await claimHoldNotification(w.id, held.availableAt))) continue;

    console.log(
      `[poller] COMING SOON: ${w.campground_name} (${w.campground_id}) — releases ${held.availableAt} — notifying watch ${w.id}`
    );
    try {
      // THE OPT-IN. RC releases 99% of held sites at exactly 08:00, so we know the
      // night before what opens and when — see findRCHeldUnit. Record the offer and
      // hand the alert a "hold it for me" link; only a tap authorises the bot to cart,
      // so we never take a site off the market that nobody asked for.
      let holdUrl: string | null = null;
      // Gated on the Auto-Cart plan, the SAME definition every other enforcer uses
      // (lib/auth.hasAutocartEntitlement — active/trialing autocart or grandfathered,
      // or is_beta). Holding a site consumes the one bot account's capacity, so it is
      // plan work; and offering a button that then refuses on tap is worse than not
      // offering it. Checked here AND in the action, because a link outlives the alert.
      //
      // AND THE BOT HAS TO BE THERE. On 2026-08-11 the RC runner and keep-warm stopped at
      // 09:36 PT and the poller went on offering hold buttons for hours — one of them eight
      // minutes before this was written. A tap would have answered "we'll grab it the moment
      // it opens" with nothing running to do it, and the user would have stopped watching.
      // The alert still goes out with no button, which is the honest version of the same
      // message: here is what opens tomorrow, book it yourself at 08:00.
      //
      // FAILS CLOSED. `rcBotUsable` returns ok:false when it cannot read the heartbeat at
      // all, and that is the right way round: a hold nobody honours costs a campsite, a
      // missing button costs a convenience. Same direction as the entitlement catch above.
      const bot = await rcBotUsable();
      if (!bot.ok && held.unitId != null) {
        console.log(
          `[poller] watch ${w.id}: NOT offering a hold — the RC runner is absent ` +
          `(${bot.beatAgeMs == null ? 'never beat' : `last beat ${Math.round(bot.beatAgeMs / 1000)}s ago`}). ` +
          'Sending the coming-soon alert without a hold link.'
        );
      }
      // AND THERE HAS TO BE ROOM. RC caps a cart at two sites and every hold we make goes
      // into one cart, so a third offer for the same release is a promise we cannot keep.
      // On 2026-08-13 three holds were queued for one 08:00 and the third was refused by RC
      // in its own words. Withholding the button sends the ordinary coming-soon alert
      // instead, which is what that user would have had anyway — and unlike a dead hold, it
      // leaves them expecting to book it themselves.
      const arrivalDate = held.dates[0] ?? w.start_date;
      const load = held.unitId == null ? 0 : await holdWindowLoad(held.availableAt, {
        watchId: w.id, unitId: String(held.unitId), arrivalDate,
      });
      const roomToHold = load < RC_HOLD_CAPACITY;
      if (!roomToHold && held.unitId != null) {
        console.log(
          `[poller] watch ${w.id}: NOT offering a hold — ${load} site(s) already spoken for at ` +
          `${held.availableAt} and we can hold ${RC_HOLD_CAPACITY}. Sending the coming-soon alert ` +
          'without a hold link.'
        );
      }
      const mayHold =
        held.unitId != null && bot.ok && roomToHold &&
        (await hasAutocartEntitlement(w.user_id).catch(() => false));
      if (mayHold && held.unitId != null) {
        const offered = await offerHold({
          watchId: w.id,
          userId: w.user_id,
          campgroundId: w.campground_id,
          unitId: String(held.unitId),
          unitName: rcSiteLabel(held.name, held.unitId),
          arrivalDate,
          nights: held.dates.length || 1,
          releaseAt: held.availableAt,
        }).catch(() => null);
        // A missing hold link must never block the alert — the heads-up is useful on
        // its own, and the user can still book manually at 8am.
        if (offered) holdUrl = await actionUrlFor(w.id, 'hold', String(held.unitId)).catch(() => null);
      }

      await dispatchNotifications({
        userId: w.user_id,
        watchId: w.id,
        campgroundId: w.campground_id,
        campgroundName: w.campground_name,
        availableDates: held.dates,
        holdUrl,
        campsiteName: held.unitId != null ? rcSiteLabel(held.name, held.unitId) : null,
        campsiteId: held.unitId != null ? String(held.unitId) : null,
        bookingUrl: w.reservations_url ?? 'https://www.reservecalifornia.com/',
        startDate: w.start_date,
        endDate: w.end_date,
        kind: 'coming_soon',
        availableAt: held.availableAt,
      });
      notified++;
    } catch (err) {
      console.error(`[poller] coming-soon notification failed for watch ${w.id}:`, err);
    }
  }

  await mutate(
    `UPDATE watches SET last_checked_at = NOW() WHERE id::text = ANY($1)`,
    [watches.map((w) => w.id)]
  ).catch((err) => console.error('[poller] last_checked_at update failed:', err));

  // Feature E: persist this cycle's observations (throttled) and prune old history.
  await recordObservations(observed);
  await pruneObservationsIfDue();

  await beat(watches.length);

  console.log(
    `[poller] heartbeat — ${mainWatches.length}${SHARD_COUNT > 1 ? `/${watches.length}` : ''} watches` +
      `${SHARD_COUNT > 1 ? ` (shard ${heldShard() ?? '-'}/${SHARD_COUNT})` : ''}` +
      ` (${rcWatches.length} RC), ${pairs.size} recgov (${hotPairs} hot/${pairs.size - hotPairs} cold)` +
      ` + UD ${rcOpenDue.length}/${rcWatches.length} open, ${rcHeldChecked} held` +
      (raWatches.length || gtcWatches.length || tnscWatches.length
        ? ` + RA ${raDueNow.length}/${raWatches.length}, GTC ${gtcDueNow.length}/${gtcWatches.length}, TN/SC ${tnscDueNow.length}/${tnscWatches.length}`
        : '') +
      `, ${notified} notified` +
      // Surface the rec.gov rate every cycle. Nothing reporting our own request rate is
      // the root cause of every wrong diagnosis this session — including a budget that
      // was blamed twice while the real constraint was the bucket's burst size. The
      // window is stated explicitly rather than assumed: `Nf/Mc per Xs` = N fetched,
      // M served from cache, since the previous heartbeat.
      (() => {
        const c = recgovScheduler.takeCounters();
        const st = recgovScheduler.schedulerStats();
        // Breaker state belongs here too: with the breaker open every call short-
        // circuits before the counters, so the line reads `0f/0c` — identical to idle.
        // That is exactly how a 13-minute rec.gov outage looked like a quiet night.
        const brk = recgovBreakerOpen() ? ' BREAKER-OPEN' : '';
        return ` [recgov ${c.served}f/${c.denied}c per ${(c.sinceMs / 1000).toFixed(0)}s, budget ${st.tokens}/${st.budgetPerMin}${brk}]`;
      })()
  );
}

// --- Auto-cart lane -------------------------------------------------------
// A tighter loop for recreation.gov watches whose owner is enrolled in auto-cart
// AND signed in. On a hit we DON'T alert immediately — that's how you get false
// hope when a site is gone before we grab it. Instead we record a pending
// autocart_job; the bot carts it and reports the outcome; the alert is decided
// later: carted → "it's in your cart" (sent by /api/auto-cart/result);
// still-open-after-a-beat → normal alert; gone → silence (reconciler below).

/** Build the NotificationPayload for a rec.gov auto-cart opening. */
function autocartPayload(watch: WatchRow, result: WatchResult): NotificationPayload {
  return {
    userId: watch.user_id,
    watchId: watch.id,
    campgroundId: watch.campground_id,
    campgroundName: watch.campground_name,
    availableDates: result.dates,
    bookingUrl: result.campsiteId
      ? `https://www.recreation.gov/camping/campsites/${result.campsiteId}#camphawk=${watch.start_date}_${watch.end_date}`
      : `https://www.recreation.gov/camping/campgrounds/${watch.campground_id}`,
    campsiteName: result.campsiteName,
    // THE SITE ID, which this dropped for as long as the auto-cart lane has existed.
    //
    // Every alert the lane produces is replayed from this payload - the `carted` one from
    // /api/auto-cart/result, and the fallback below when the bot did not cart. Without it:
    //   - the booking link degrades to the whole CAMPGROUND instead of the site, so three
    //     alerts for three different sites read as three identical texts;
    //   - `campsiteId` is the MUTE TARGET (lib/notifications: `payload.campsiteId ?
    //     actionUrlFor(... 'mute_site' ...) : null`), so the one control that would stop a
    //     noisy site is silently absent from exactly the alerts you would want it on;
    //   - and the stored notification row cannot be attributed to a site afterwards, which
    //     is why "am I getting duplicates?" could not be answered from the data.
    //
    // Observed 2026-08-11: Silver Lake site 044 sent at 08:08, 13:08 and 15:13, all three
    // with id=undefined and no mute link. The job row has carried `campsite_id` in its own
    // column the whole time - only the payload lost it.
    campsiteId: result.campsiteId,
    startDate: watch.start_date,
    endDate: watch.end_date,
  };
}

/**
 * Auto-cart's own detection loop is GONE (2026-07-31) — the main cycle now detects for
 * every watch and queues the job itself. What remains is reconciliation, which makes no
 * bulk rec.gov requests: it re-verifies only the specific sites the bot failed to cart,
 * at HIGH priority through the shared lane, and that is rare.
 *
 * Kept on its own timer because RECONCILE_DELAY_SEC is a deadline measured from when a
 * job was queued, not something tied to the detection cadence.
 */
async function autocartCycle(): Promise<void> {
  await reconcileAutocartJobs();
}

interface AutocartJobRow {
  id: string;
  campground_id: string;
  campsite_id: string;
  payload: NotificationPayload;
  cart_outcome: string | null;
}

/**
 * Decide pending auto-cart jobs the bot didn't resolve as carted. After
 * RECONCILE_DELAY_SEC the cart attempt has had its chance, so we re-verify the
 * exact site live and either send the normal "book it" alert (still open) or stay
 * silent (gone). The carted ones are resolved by /api/auto-cart/result.
 */
async function reconcileAutocartJobs(): Promise<void> {
  // Two ways a job becomes reconcilable: the deadline passes with no word from the
  // bot, OR the bot has already reported a terminal non-carted outcome — in which
  // case the cart attempt is over and waiting out the rest of the delay buys nothing
  // but latency on the fallback alert. ('carted' jobs are resolved by the result
  // endpoint and never reach this query.) The bot's 'skipped-already-carted' — a site
  // it carted for this user minutes ago re-opening — lands here within seconds now
  // instead of after the full delay.
  const jobs = await query<AutocartJobRow>(
    `SELECT id, campground_id, campsite_id, payload, cart_outcome
     FROM autocart_jobs
     WHERE resolution IS NULL
       AND (detected_at < NOW() - INTERVAL '${RECONCILE_DELAY_SEC} seconds'
            OR (cart_outcome IS NOT NULL AND cart_outcome != 'carted'))
     ORDER BY detected_at ASC LIMIT 50`
  );
  for (const job of jobs) {
    const p = job.payload;
    const stillOpen = await recheckCampsite(job.campground_id, job.campsite_id, p.startDate, p.endDate);
    const resolution = stillOpen ? 'alerted' : 'silent';
    // Atomic claim: only one resolver wins (guards against the result endpoint racing).
    const claimed = await mutate<{ id: string }>(
      `UPDATE autocart_jobs SET resolution = $2, resolved_at = NOW()
       WHERE id = $1 AND resolution IS NULL RETURNING id`,
      [job.id, resolution]
    );
    if (claimed.length === 0) continue;
    if (stillOpen) {
      console.log(`[poller] autocart fallback: ${p.campgroundName} still open (cart_outcome=${job.cart_outcome ?? 'none'}) — sending normal alert (job ${job.id})`);
      // `kind` EXPLICITLY. Dispatching the bare payload left it undefined, and every
      // wording branch in lib/notifications keys off it - so the one alert that arrives
      // LATE, because the bot could not cart, was the one that got the least specific text.
      // It is an availability alert, arriving by a slower road; say so.
      await dispatchNotifications({ ...p, kind: 'available' }).catch((e) => console.error(`[poller] autocart fallback dispatch failed for ${job.id}:`, e));
    } else {
      console.log(`[poller] autocart fallback: ${p.campgroundName} gone (cart_outcome=${job.cart_outcome ?? 'none'}) — staying silent (job ${job.id})`);
    }
  }
}

/** Re-verify a specific rec.gov campsite can still host the full [start, end) stay. */
async function recheckCampsite(campgroundId: string, campsiteId: string, startDate: string, endDate: string): Promise<boolean> {
  const nights = nightsOfRange(startDate, endDate);
  const nightSet = new Set(nights);
  const open = new Set<string>();
  for (const month of monthsForRange(startDate, endDate)) {
    // HIGH and near-zero staleness: this decides whether to send a fallback alert for
    // a site the bot failed to cart, so a cached "still open" would alert on a site
    // that is already gone. Rare enough that it never meaningfully spends the budget.
    const { value: avail } = await recgovScheduler.getAvailability(campgroundId, month, {
      maxAgeMs: 2_000,
      priority: 'high',
    });
    for (const cs of avail.campsites) {
      if (String(cs.campsiteId) !== String(campsiteId)) continue;
      for (const day of cs.availability) if (day.status === 'available' && nightSet.has(day.date)) open.add(day.date);
    }
  }
  return hasConsecutiveRun([...open].sort(), nights.length);
}

// ReserveCalifornia's WAF blocks GitHub Actions runner IPs (403), so the
// nightly RC refresh runs here on Fly instead. Runs when the last successful
// RC sync is older than ~22h; checked hourly.
const RC_SYNC_MAX_AGE_HOURS = 22;
let rcSyncRunning = false;

async function rcSyncIfDue(): Promise<void> {
  if (rcSyncRunning) return;
  rcSyncRunning = true;
  try {
    // "Due" when the OLDEST provider's last successful sync is stale (or a
    // provider has never synced) — so a newly added state syncs on the next tick.
    const sources = USEDIRECT_PROVIDERS.map((p) => p.source);
    const row = await query<{ age_hours: number | null; synced_sources: number }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(last_ok))) / 3600 AS age_hours,
              COUNT(*) AS synced_sources
       FROM (
         SELECT source, MAX(finished_at) AS last_ok
         FROM sync_log WHERE source = ANY($1) AND facilities_synced > 0
         GROUP BY source
       ) t`,
      [sources]
    );
    const age = row[0]?.age_hours;
    const allSynced = Number(row[0]?.synced_sources ?? 0) >= sources.length;
    if (allSynced && age != null && age < RC_SYNC_MAX_AGE_HOURS) return;
    // ONE MACHINE ONLY. `rcSyncRunning` above is in-process and cannot see the other
    // shard machine, so at SHARD_COUNT=2 both ran this whole sync 45s apart on
    // 2026-08-03 and the UseDirect WAF 403'd us — both exit through the SAME Vercel
    // IPs via /api/rc-proxy, and these WAFs meter per IP. See worker/sync-claim.ts.
    const ran = await withSyncClaim('usedirect', async () => {
      console.log(`[poller] UseDirect sync due (oldest ${age?.toFixed(1) ?? 'never'}h ago) — starting`);
      const result = await syncAllUseDirect();
      console.log(`[poller] UseDirect sync finished: ${result.facilitiesSynced} campgrounds, ${result.campsitesSynced} units, ${result.errors.length} errors`);
    });
    if (!ran) console.log('[poller] UseDirect sync due but another machine holds the claim — skipping');
  } catch (err) {
    console.error('[poller] RC sync failed:', err);
  } finally {
    rcSyncRunning = false;
  }
}

// GoingToCamp catalog refresh. Lives here rather than in the nightly GitHub
// Action because these tenants sit behind an Azure WAF that challenges bursty
// traffic; the worker syncs one tenant at a time on a slow cadence, and the
// client backs off on a challenge. Same due-check shape as rcSyncIfDue.
const GTC_SYNC_MAX_AGE_HOURS = 22;
let gtcSyncRunning = false;

async function gtcSyncIfDue(): Promise<void> {
  if (gtcSyncRunning) return;
  gtcSyncRunning = true;
  try {
    const sources = GOINGTOCAMP_PROVIDERS.map((p) => `goingtocamp-${p.state}`);
    const row = await query<{ age_hours: number | null; synced_sources: number }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(last_ok))) / 3600 AS age_hours,
              COUNT(*) AS synced_sources
       FROM (
         SELECT source, MAX(finished_at) AS last_ok
         FROM sync_log WHERE source = ANY($1) AND facilities_synced > 0
         GROUP BY source
       ) t`,
      [sources]
    );
    const age = row[0]?.age_hours;
    const allSynced = Number(row[0]?.synced_sources ?? 0) >= sources.length;
    if (allSynced && age != null && age < GTC_SYNC_MAX_AGE_HOURS) return;
    // ONE MACHINE ONLY — same reason as the UseDirect sync above. GoingToCamp calls
    // leave from Fly directly rather than through Vercel, so a doubled run spends two
    // egress IPs rather than one, but doubling a catalog sweep against a WAF that
    // already challenges us buys nothing either way.
    const ran = await withSyncClaim('goingtocamp', async () => {
      console.log(`[poller] GoingToCamp sync due (oldest ${age?.toFixed(1) ?? 'never'}h ago) — starting`);
      const result = await syncAllGoingToCamp();
      console.log(
        `[poller] GoingToCamp sync finished: ${result.facilitiesSynced} campgrounds, ${result.errors.length} errors`
      );
    });
    if (!ran) console.log('[poller] GoingToCamp sync due but another machine holds the claim — skipping');
  } catch (err) {
    console.error('[poller] GoingToCamp sync failed:', err);
  } finally {
    gtcSyncRunning = false;
  }
}

async function main() {
  console.log(`[poller] starting — interval ${POLL_INTERVAL_MS / 1000}s, recgov concurrency ${RECGOV_CONCURRENCY}`);

  // Full-day 429 profile: count every rec.gov fetch outcome (and our own budget
  // denials / breaker skips) into recgov_rate_profile. This is the measurement the
  // sub-15s hot lane is waiting on — see worker/rate-profile.ts.
  startRateProfile();

  // Startup probe: verify the RC API is reachable via the configured path
  // (direct, or through the Vercel proxy when RC_PROXY_URL is set).
  try {
    const types = await fetchUnitTypes(USEDIRECT_PROVIDERS[0]);
    console.log(`[poller] UseDirect connectivity probe OK — ${types.length} unit types (via ${process.env.RC_PROXY_URL ? 'proxy' : 'direct'})`);
  } catch (err) {
    console.error('[poller] RC connectivity probe FAILED — RC watches will not alert:', (err as Error).message);
  }

  // Startup probe: these hosts are WAF'd, and datacenter reachability was never
  // verified from Fly — so say so loudly rather than letting GTC watches quietly
  // never alert.
  try {
    const locs = await fetchLocations(GOINGTOCAMP_PROVIDERS[0]);
    console.log(
      `[poller] GoingToCamp connectivity probe OK — ${locs.length} ${GOINGTOCAMP_PROVIDERS[0].state} locations`
    );
  } catch (err) {
    console.error(
      '[poller] GoingToCamp connectivity probe FAILED — GTC watches will not alert:',
      (err as Error).message
    );
  }

  // Serves GoingToCamp availability to the website's search page, which runs on
  // Vercel and is WAF-blocked from Camis. Started before the poll loop but never
  // awaited into it — an HTTP failure must not affect alerting.
  startHttpServer();

  rcSyncIfDue();
  setInterval(rcSyncIfDue, 60 * 60 * 1000);
  gtcSyncIfDue();
  setInterval(gtcSyncIfDue, 60 * 60 * 1000);

  // Close watches whose trip has already happened — see worker/expire-watches.ts for
  // why the predicate must stay exactly the complement of the poller's own filter.
  // Under a claim so only one machine writes, though the UPDATE is idempotent.
  const expireSweep = async () => {
    try {
      await withSyncClaim('expire-watches', async () => {
        const closed = await expireFinishedWatches();
        if (closed.length > 0)
          console.log(
            `[poller] closed ${closed.length} watch${closed.length === 1 ? '' : 'es'} whose dates have passed`
          );
      });
    } catch (err) {
      console.error('[poller] expire sweep failed:', (err as Error).message);
    }
  };
  expireSweep();
  setInterval(expireSweep, EXPIRE_INTERVAL_MS);

  // Tell a user when we promised to hold a site and did not. This CANNOT live in the
  // hold feed, which is where the rest of the hold housekeeping runs: that feed only
  // executes when the mini-PC runner polls it, so a runner that is down never triggers
  // the sweep that would notice the runner is down. It belongs here, on a machine with
  // no dependency on that box. See worker/expire-holds.ts.
  const holdSweep = async () => {
    try {
      await withSyncClaim('expire-holds', async () => {
        const missed = await sweepMissedHolds();
        if (missed > 0) console.error(`[poller] ${missed} RC hold(s) missed their release — users notified`);
      });
    } catch (err) {
      console.error('[poller] hold sweep failed:', (err as Error).message);
    }
  };
  holdSweep();
  setInterval(holdSweep, EXPIRE_HOLDS_INTERVAL_MS);

  // Feature E probe roster: sample high-demand campgrounds hourly so the
  // cancellation-likelihood signal covers popular sites nobody is watching.
  // Log the state either way — a silently-absent background job is how you end up
  // wondering months later whether it was ever running.
  if (PROBE_ENABLED) {
    console.log(`[poller] probe roster — every ${(PROBE_INTERVAL_MS / 3_600_000).toFixed(1)}h, leads [${PROBE_LEAD_DAYS.join(', ')}]d × ${PROBE_NIGHTS}n`);
    probeRosterIfDue();
    setInterval(probeRosterIfDue, PROBE_INTERVAL_MS);
  } else {
    console.log('[poller] probe roster OFF (PROBE_ENABLED != true) — feature E accrual stopped');
  }

  // Alert-health canary — non-overlapping, best-effort (never throws into the loop).
  console.log(
    `[poller] canary — detection every ${CANARY_DETECT_INTERVAL_MS / 1000}s, delivery every ${(CANARY_DELIVERY_INTERVAL_MS / 3_600_000).toFixed(1)}h`
  );
  let detectRunning = false;
  const detectCanary = async () => {
    if (detectRunning) return;
    detectRunning = true;
    try { await runDetectionCanary(); } catch (err) { console.error('[canary] detection cycle failed:', err); }
    finally { detectRunning = false; }
  };
  let deliveryRunning = false;
  const deliveryCanary = async () => {
    if (deliveryRunning) return;
    deliveryRunning = true;
    try { await runDeliveryCanary(); } catch (err) { console.error('[canary] delivery cycle failed:', err); }
    finally { deliveryRunning = false; }
  };
  detectCanary();
  setInterval(detectCanary, CANARY_DETECT_INTERVAL_MS);
  deliveryCanary();
  setInterval(deliveryCanary, CANARY_DELIVERY_INTERVAL_MS);

  // Self-heal watchdog — reboot the machine if the poller stops landing heartbeats
  // (a wedged-but-"started" machine; see WATCHDOG_STALE_MS + worker/liveness.ts).
  // markAlive() starts the clock at boot, so the first cycle has WATCHDOG_STALE_MS
  // of grace before this can fire.
  console.log(
    `[poller] watchdog — reboot if no heartbeat lands for ${(WATCHDOG_STALE_MS / 1000).toFixed(0)}s ` +
      `or no external fetch succeeds for ${(WATCHDOG_EXTERNAL_STALE_MS / 1000).toFixed(0)}s`
  );
  setInterval(() => {
    const stale = msSinceAlive();
    if (stale > WATCHDOG_STALE_MS) {
      console.error(
        `[poller] WATCHDOG: no successful heartbeat in ${(stale / 1000).toFixed(0)}s — ` +
          `machine egress is wedged; exiting so Fly reboots the VM to restore networking.`
      );
      process.exit(1);
    }
    // Cascade (hard): heartbeat fresh (Supabase reachable) but NO external fetch has
    // succeeded for a long stretch.
    const extStale = msSinceExternalFetchOk();
    if (extStale > WATCHDOG_EXTERNAL_STALE_MS) {
      console.error(
        `[poller] WATCHDOG: no successful external fetch in ${(extStale / 1000).toFixed(0)}s ` +
          `(heartbeat still fresh) — provider egress cascade; exiting so Fly reboots the VM.`
      );
      process.exit(1);
    }
    // Cascade (flapping): egress mostly dead over the window, even though the odd
    // success keeps the staleness timer above fresh. This is what a human had to catch
    // manually on 2026-07-24.
    if (
      externalFetchWedged(
        WATCHDOG_EXTERNAL_WINDOW_MS,
        WATCHDOG_EXTERNAL_MIN_ATTEMPTS,
        WATCHDOG_EXTERNAL_MAX_FAIL_RATIO
      )
    ) {
      console.error(
        `[poller] WATCHDOG: external fetch failure ratio >= ${WATCHDOG_EXTERNAL_MAX_FAIL_RATIO} over ` +
          `${(WATCHDOG_EXTERNAL_WINDOW_MS / 1000).toFixed(0)}s (heartbeat still fresh) — flapping ` +
          `egress wedge; exiting so Fly reboots the VM.`
      );
      process.exit(1);
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
  // Run cycles back-to-back on a fixed cadence; skip a tick if the previous cycle is still running.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await cycle();
    } catch (err) {
      console.error('[poller] cycle failed:', err);
    } finally {
      running = false;
    }
  };
  // Claim a shard before the first cycle, and hold it on a timer. At SHARD_COUNT=1 the
  // lease is still taken — it costs one tiny upsert every 15s and gives
  // /api/health/status something real to assert — but ownsCampground does not depend
  // on it, so a DB hiccup can never stop the only poller from polling.
  await claimOrRenewShard();
  console.log(`[poller] shard ${heldShard() ?? '-'} of ${SHARD_COUNT}` +
    (SHARD_COUNT === 1 ? ' (single shard — owns every campground)' : ''));
  setInterval(() => {
    claimOrRenewShard().catch((err) => console.error('[poller] shard renew failed:', err));
  }, LEASE_RENEW_MS);

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);

  // Reconciliation only — detection for auto-cart watches happens in the main cycle
  // now. Still its own timer because RECONCILE_DELAY_SEC is a deadline measured from
  // when a job was queued. Cheap: DB reads, plus a re-verify per job that missed.
  console.log(`[poller] auto-cart reconciler — every ${AUTOCART_POLL_INTERVAL_MS / 1000}s, reconcile after ${RECONCILE_DELAY_SEC}s`);
  let acRunning = false;
  const acTick = async () => {
    if (acRunning) return;
    acRunning = true;
    try {
      await autocartCycle();
    } catch (err) {
      console.error('[poller] autocart cycle failed:', err);
    } finally {
      acRunning = false;
    }
  };
  await acTick();
  setInterval(acTick, AUTOCART_POLL_INTERVAL_MS);
}

main();
