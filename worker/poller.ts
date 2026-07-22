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
import { getAvailabilityFromRecGov, hasAvailabilityInRange } from '../src/lib/availability/recgov';
import { findRCOpenUnit, findRCHeldUnit } from '../src/lib/availability/reservecalifornia';
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
import { findQualifyingRun, flexCandidateStays, isFlexible, type FlexDays, type FlexSpec } from '../src/lib/availability/flex';
import { markAlive, msSinceAlive } from './liveness';

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
const AUTOCART_POLL_INTERVAL_MS = Number(process.env.AUTOCART_POLL_INTERVAL_MS ?? 6_000);
// How long after detection we let the bot attempt the cart before the reconciler
// re-verifies availability and decides the fallback alert (see 014_autocart_jobs).
const RECONCILE_DELAY_SEC = Number(process.env.AUTOCART_RECONCILE_DELAY_SEC ?? 35);
const RECGOV_CONCURRENCY = 4;
// Alert-health canary cadences. Detection is cheap (one fetch per source) so it
// runs often; delivery actually SENDS (Resend/Twilio), so it's slow by default to
// avoid spamming the canary sink — /api/health/status staleness thresholds track
// these (see the route). Both overridable via env.
const CANARY_DETECT_INTERVAL_MS = Number(process.env.CANARY_DETECT_INTERVAL_MS ?? 120_000);
const CANARY_DELIVERY_INTERVAL_MS = Number(process.env.CANARY_DELIVERY_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
// Self-heal watchdog: if no heartbeat has landed in the DB for this long, the
// machine's networking has wedged (2026-07-22 incident — process up, all egress
// timing out, alerting silently dead). Exit so Fly reboots the microVM and
// re-establishes networking, no human needed. Set WELL above the worst legitimate
// slow cycle (~2 min under a heavy catalog-sync burst) so only a true wedge trips
// it, and below /api/health/status's 5-min WORKER_STALE page so we self-heal
// before a human is paged. Checked on WATCHDOG_CHECK_INTERVAL_MS.
const WATCHDOG_STALE_MS = Number(process.env.WATCHDOG_STALE_MS ?? 4 * 60 * 1000);
const WATCHDOG_CHECK_INTERVAL_MS = Number(process.env.WATCHDOG_CHECK_INTERVAL_MS ?? 30_000);
// How fresh the mini-PC bot's heartbeat must be for us to treat it as online. The
// bot polls the roster every ~2s, so anything older than this means it's down (box
// off, process crashed, network cut). When it's stale we do NOT route rec.gov
// openings into the silent auto-cart lane — they fall back to normal immediate
// alerts, because a dead bot must never silently swallow a cancellation.
const AUTOCART_BOT_STALE_SEC = Number(process.env.AUTOCART_BOT_STALE_SEC ?? 60);
// Matches the Campflare webhook handler: re-notify only if the last alert is >1h old.
const RENOTIFY_WINDOW = "interval '1 hour'";

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
async function probeWholeStayOpen(source: string, campgroundId: string, start: string, end: string, nights: number): Promise<boolean> {
  if (isUseDirectSource(source)) return !!(await findRCOpenUnit(campgroundId, start, end, nights));
  if (isGoingToCampSource(source)) return !!(await findGoingToCampOpen(campgroundId, start, end, nights));
  if (isTnscSource(source)) return !!(await findTnscOpen(campgroundId, start, end, nights));
  if (source === 'reserveamerica') return !!(await findReserveAmericaOpen(campgroundId, start, end, nights));
  return hasAvailabilityInRange(campgroundId, start, end, nights); // rec.gov
}

/** Probe every active roster target once across the standard lead windows and
 *  record the results. Non-overlapping and best-effort. */
async function probeRosterIfDue(): Promise<void> {
  if (probeRunning) return;
  probeRunning = true;
  try {
    const targets = await query<{ campground_id: string; source: string }>(
      `SELECT campground_id, source FROM probe_targets WHERE active`
    ).catch(() => [] as { campground_id: string; source: string }[]);
    if (targets.length === 0) return;
    const todayISO = new Date().toISOString().slice(0, 10);
    const windows = PROBE_LEAD_DAYS.map((lead) => probeArrival(lead));
    const rows: ObsRow[] = [];
    await pMap(
      targets,
      async (t) => {
        for (const w of windows) {
          try {
            const open = await probeWholeStayOpen(t.source, t.campground_id, w.start, w.end, PROBE_NIGHTS);
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
        }
      },
      PROBE_CONCURRENCY
    );
    await insertObservationRows(rows);
    console.log(`[poller] probe roster — ${targets.length} targets × ${windows.length} windows → ${rows.length} observations`);
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
    w.autocart_enabled === true &&
    w.autocart_connected === true
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

async function loadWatches(): Promise<WatchRow[]> {
  return query<WatchRow>(
    `SELECT w.id, w.user_id, w.campground_id,
            w.start_date::text, w.end_date::text, w.min_nights,
            w.rc_hold_notified_for, w.muted_site_ids, w.flex_nights, w.flex_days,
            c.name AS campground_name, c.source AS campground_source,
            c.reservations_url,
            COALESCE(u.autocart_enabled, false) AS autocart_enabled,
            COALESCE(u.autocart_connected, false) AS autocart_connected
     FROM watches w
     JOIN campgrounds c ON c.id = w.campground_id
     JOIN users u ON u.id = w.user_id
     WHERE w.active = true
       AND w.end_date > CURRENT_DATE
       AND (w.notification_sent_at IS NULL OR w.notification_sent_at < NOW() - ${RENOTIFY_WINDOW})`
  );
}

/**
 * Atomically claim the right to notify for this watch. Returns true if we won
 * the claim; false if the Campflare webhook (or a concurrent cycle) got there first.
 */
async function claimNotification(watchId: string): Promise<boolean> {
  const rows = await mutate<{ id: string }>(
    `UPDATE watches SET notification_sent_at = NOW()
     WHERE id = $1 AND active = true
       AND (notification_sent_at IS NULL OR notification_sent_at < NOW() - ${RENOTIFY_WINDOW})
     RETURNING id`,
    [watchId]
  );
  return rows.length > 0;
}

/**
 * Claim the right to send the ReserveCalifornia "coming soon" heads-up for this
 * held release. Deduped by the release timestamp (a held site sits in this state
 * for hours, so we must alert once, not every cycle). Does NOT touch
 * notification_sent_at, so the real "now available" alert still fires at release.
 */
async function claimHoldNotification(watchId: string, releaseAt: string): Promise<boolean> {
  const rows = await mutate<{ id: string }>(
    `UPDATE watches SET rc_hold_notified_for = $2
     WHERE id = $1 AND active = true AND rc_hold_notified_for IS DISTINCT FROM $2
     RETURNING id`,
    [watchId, releaseAt]
  );
  return rows.length > 0;
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

  // Auto-cart rec.gov watches are handled by the tighter autocartCycle() below;
  // everything else runs here on the main cadence. When the bot is offline the
  // auto-cart lane is empty, so those watches drop through to here and alert
  // immediately like any normal watch.
  const botOnline = await isBotOnline();
  const mainWatches = watches.filter((w) => !isAutocartLane(w, botOnline));
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
  const pairs = new Set<string>();
  for (const w of ridbWatches) {
    for (const month of monthsForRange(w.start_date, w.end_date)) {
      pairs.add(`${w.campground_id}|${month}`);
    }
  }

  const monthData = new Map<string, Awaited<ReturnType<typeof getAvailabilityFromRecGov>>>();
  await pMap(
    [...pairs],
    async (pair) => {
      const [campgroundId, month] = pair.split('|');
      // getAvailabilityFromRecGov swallows fetch errors and returns empty campsites,
      // so a transient failure never looks like "nothing available → skip" incorrectly.
      monthData.set(pair, await getAvailabilityFromRecGov(campgroundId, month));
    },
    RECGOV_CONCURRENCY
  );

  // ReserveCalifornia: find the specific open unit hosting the full stay.
  const rcResults = new Map<string, { dates: string[]; unitId: number; sleepingUnitId: number | null }>();
  await pMap(
    rcWatches,
    async (w) => {
      const nights = nightsOfRange(w.start_date, w.end_date);
      const required = Math.max(w.min_nights, nights.length);
      const open = await findRCOpenUnit(w.campground_id, w.start_date, w.end_date, required, w.muted_site_ids, flexOf(w));
      // Flexible watches report just the matched run; fixed report the whole stay.
      if (open) rcResults.set(w.id, { dates: open.dates.length ? open.dates : nights, unitId: open.unitId, sleepingUnitId: open.sleepingUnitId });
    },
    RECGOV_CONCURRENCY
  );

  // ReserveCalifornia held state: cancelled sites RC locks until a release time
  // (~8am next day). Only check watches that aren't already bookable now.
  const rcHeld = new Map<string, { dates: string[]; availableAt: string }>();
  await pMap(
    rcWatches.filter((w) => !rcResults.has(w.id)),
    async (w) => {
      const required = Math.max(w.min_nights, nightsOfRange(w.start_date, w.end_date).length);
      const held = await findRCHeldUnit(w.campground_id, w.start_date, w.end_date, required);
      if (held) rcHeld.set(w.id, { dates: held.dates, availableAt: held.availableAt });
    },
    RECGOV_CONCURRENCY
  );

  // ReserveAmerica: HTML-scrape check for a site bookable across the full stay.
  const raResults = new Map<string, { dates: string[]; siteIds: number[]; start: string; end: string }>();
  await pMap(
    raWatches,
    async (w) => {
      const m = await probeFlexStay(w, (s, e, required) => findReserveAmericaOpen(w.campground_id, s, e, required));
      if (m) raResults.set(w.id, { dates: m.dates, siteIds: m.result.siteIds, start: m.start, end: m.end });
    },
    RECGOV_CONCURRENCY
  );

  // GoingToCamp: the Camis API answers whole-stay directly, so one call per watch.
  const gtcResults = new Map<string, { dates: string[]; resourceIds: number[]; start: string; end: string }>();
  await pMap(
    gtcWatches,
    async (w) => {
      const m = await probeFlexStay(w, (s, e, required) => findGoingToCampOpen(w.campground_id, s, e, required));
      if (m) gtcResults.set(w.id, { dates: m.dates, resourceIds: m.result.resourceIds, start: m.start, end: m.end });
    },
    RECGOV_CONCURRENCY
  );

  // TN/SC ColdFusion portal: batched whole-stay availability, keyed by parkId. The
  // client caches the per-range batch, so N watches on one date range share a single
  // POST. No per-site ids — alerts are park+date. (Whether the worker's IP can reach
  // the portal is unverified; findTnscOpen swallows errors, so an unreachable portal
  // simply never alerts rather than crashing the cycle — and would need the same
  // fix-then-verify as GoingToCamp did. See docs/CONTEXT.md.)
  const tnscResults = new Map<string, { dates: string[]; start: string; end: string }>();
  if (tnscWatches.length > 0) console.log(`[poller] checking ${tnscWatches.length} TN/SC watch(es)`);
  await pMap(
    tnscWatches,
    async (w) => {
      const m = await probeFlexStay(w, async (s, e, required) => {
        const open = await findTnscOpen(w.campground_id, s, e, required);
        console.log(`[poller] TN/SC ${w.campground_id} (${s}..${e}): ${open ? `OPEN ${open.availableSites} sites` : 'no opening'}`);
        return open;
      });
      if (m) tnscResults.set(w.id, { dates: m.dates, start: m.start, end: m.end });
    },
    RECGOV_CONCURRENCY
  );

  let notified = 0;
  // Feature E: this cycle's open/booked observation per watched window, recorded
  // (throttled) after the notify loop. Covers every main-lane watch; auto-cart-lane
  // rec.gov watches are handled in autocartCycle and fall into this lane whenever the
  // bot is offline, so popular sites are still sampled.
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
          ? { dates: rc?.dates ?? [], campsiteId: rc ? String(rc.unitId) : null, campsiteName: rc ? `Unit ${rc.unitId}` : null }
          : availableDatesForWatch(watch, monthData);
    observed.push({ w: watch, hadOpening: result.dates.length > 0 });
    if (result.dates.length === 0) continue;

    // Matched stay range: for flexible watches this is the run inside the window;
    // for fixed watches it equals the watch's own [start,end]. Deep links and the
    // alert's dates use this so the user lands on the exact nights that opened.
    const matchStart = result.dates[0] ?? watch.start_date;
    const matchEnd = checkoutAfter(result.dates, watch.end_date);

    if (!(await claimNotification(watch.id))) {
      console.log(`[poller] watch ${watch.id}: availability found but already notified — skipping`);
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
    if (rcResults.has(w.id)) continue; // already alerted as available above
    const held = rcHeld.get(w.id);
    if (!held) continue;
    if (!(await claimHoldNotification(w.id, held.availableAt))) continue;

    console.log(
      `[poller] COMING SOON: ${w.campground_name} (${w.campground_id}) — releases ${held.availableAt} — notifying watch ${w.id}`
    );
    try {
      await dispatchNotifications({
        userId: w.user_id,
        watchId: w.id,
        campgroundId: w.campground_id,
        campgroundName: w.campground_name,
        availableDates: held.dates,
        bookingUrl: w.reservations_url ?? 'https://www.reservecalifornia.com/',
        campsiteName: null,
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
    `[poller] heartbeat — ${watches.length} watches (${rcWatches.length} RC), ${pairs.size} recgov + ${rcWatches.length} RC fetches, ${notified} notified`
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
    startDate: watch.start_date,
    endDate: watch.end_date,
  };
}

async function autocartCycle(): Promise<void> {
  // If the bot is offline the lane is empty (the main cycle alerts these watches
  // immediately instead); we still fall through to reconcile any jobs queued
  // before it dropped.
  const botOnline = await isBotOnline();
  const watches = (await loadWatches()).filter((w) => isAutocartLane(w, botOnline));
  if (watches.length > 0) {
    // One recgov fetch per unique campground+month, shared across these watches.
    const pairs = new Set<string>();
    for (const w of watches) for (const m of monthsForRange(w.start_date, w.end_date)) pairs.add(`${w.campground_id}|${m}`);
    const monthData = new Map<string, Awaited<ReturnType<typeof getAvailabilityFromRecGov>>>();
    await pMap([...pairs], async (pair) => {
      const [campgroundId, month] = pair.split('|');
      monthData.set(pair, await getAvailabilityFromRecGov(campgroundId, month));
    }, RECGOV_CONCURRENCY);

    for (const watch of watches) {
      const result = availableDatesForWatch(watch, monthData);
      if (result.dates.length === 0) continue;
      if (!(await claimNotification(watch.id))) continue; // main cycle / prior tick won the claim
      const payload = autocartPayload(watch, result);
      if (!result.campsiteId) {
        // No specific site to cart → behave like a normal alert.
        await dispatchNotifications(payload).catch((e) => console.error('[poller] autocart normal dispatch failed:', e));
        continue;
      }
      await mutate(
        `INSERT INTO autocart_jobs (watch_id, user_id, campground_id, campsite_id, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [watch.id, watch.user_id, watch.campground_id, result.campsiteId, JSON.stringify(payload)]
      );
      console.log(`[poller] AUTOCART OPENING: ${watch.campground_name} site ${result.campsiteId} (${result.dates.join(', ')}) — job queued, waiting on the bot (watch ${watch.id})`);
    }
    await mutate(`UPDATE watches SET last_checked_at = NOW() WHERE id::text = ANY($1)`, [watches.map((w) => w.id)]).catch(() => {});
  }
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
  const jobs = await query<AutocartJobRow>(
    `SELECT id, campground_id, campsite_id, payload, cart_outcome
     FROM autocart_jobs
     WHERE resolution IS NULL AND detected_at < NOW() - INTERVAL '${RECONCILE_DELAY_SEC} seconds'
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
      await dispatchNotifications(p).catch((e) => console.error(`[poller] autocart fallback dispatch failed for ${job.id}:`, e));
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
    const avail = await getAvailabilityFromRecGov(campgroundId, month);
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
    console.log(`[poller] UseDirect sync due (oldest ${age?.toFixed(1) ?? 'never'}h ago) — starting`);
    const result = await syncAllUseDirect();
    console.log(`[poller] UseDirect sync finished: ${result.facilitiesSynced} campgrounds, ${result.campsitesSynced} units, ${result.errors.length} errors`);
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
    console.log(`[poller] GoingToCamp sync due (oldest ${age?.toFixed(1) ?? 'never'}h ago) — starting`);
    const result = await syncAllGoingToCamp();
    console.log(
      `[poller] GoingToCamp sync finished: ${result.facilitiesSynced} campgrounds, ${result.errors.length} errors`
    );
  } catch (err) {
    console.error('[poller] GoingToCamp sync failed:', err);
  } finally {
    gtcSyncRunning = false;
  }
}

async function main() {
  console.log(`[poller] starting — interval ${POLL_INTERVAL_MS / 1000}s, recgov concurrency ${RECGOV_CONCURRENCY}`);

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

  // Feature E probe roster: sample high-demand campgrounds hourly so the
  // cancellation-likelihood signal covers popular sites nobody is watching.
  console.log(`[poller] probe roster — every ${(PROBE_INTERVAL_MS / 3_600_000).toFixed(1)}h, leads [${PROBE_LEAD_DAYS.join(', ')}]d × ${PROBE_NIGHTS}n`);
  probeRosterIfDue();
  setInterval(probeRosterIfDue, PROBE_INTERVAL_MS);

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
  console.log(`[poller] watchdog — reboot if no heartbeat lands for ${(WATCHDOG_STALE_MS / 1000).toFixed(0)}s`);
  setInterval(() => {
    const stale = msSinceAlive();
    if (stale > WATCHDOG_STALE_MS) {
      console.error(
        `[poller] WATCHDOG: no successful heartbeat in ${(stale / 1000).toFixed(0)}s — ` +
          `machine egress is wedged; exiting so Fly reboots the VM to restore networking.`
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
  await tick();
  setInterval(tick, POLL_INTERVAL_MS);

  // Tighter, independent loop for auto-cart rec.gov watches + job reconciliation.
  console.log(`[poller] auto-cart lane — interval ${AUTOCART_POLL_INTERVAL_MS / 1000}s, reconcile after ${RECONCILE_DELAY_SEC}s`);
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
