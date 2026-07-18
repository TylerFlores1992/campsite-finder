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

import { query, mutate } from '../src/lib/db/client';
import { getAvailabilityFromRecGov } from '../src/lib/availability/recgov';
import { findRCOpenUnit, findRCHeldUnit } from '../src/lib/availability/reservecalifornia';
import { findReserveAmericaOpen } from '../src/lib/availability/reserveamerica';
import { syncAllUseDirect } from '../src/lib/sources/reservecalifornia/sync';
import { fetchUnitTypes } from '../src/lib/sources/reservecalifornia/client';
import { isUseDirectSource, USEDIRECT_PROVIDERS } from '../src/lib/sources/reservecalifornia/providers';
import { dispatchNotifications, type NotificationPayload } from '../src/lib/notifications';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
// Auto-cart rec.gov watches run on their own tighter loop so a cancellation gets
// into the cart before someone else grabs it. Detection latency for these is
// bounded by this interval instead of the slower main cycle.
const AUTOCART_POLL_INTERVAL_MS = Number(process.env.AUTOCART_POLL_INTERVAL_MS ?? 6_000);
// How long after detection we let the bot attempt the cart before the reconciler
// re-verifies availability and decides the fallback alert (see 014_autocart_jobs).
const RECONCILE_DELAY_SEC = Number(process.env.AUTOCART_RECONCILE_DELAY_SEC ?? 35);
const RECGOV_CONCURRENCY = 4;
// Matches the Campflare webhook handler: re-notify only if the last alert is >1h old.
const RENOTIFY_WINDOW = "interval '1 hour'";

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
  autocart_enabled: boolean;
  autocart_connected: boolean;
}

/**
 * A watch handled by the tighter auto-cart lane: a recreation.gov site whose owner
 * is enrolled in auto-cart AND has a live rec.gov session. For these we don't alert
 * on detection — we create a pending job, let the bot try to cart it, and decide the
 * alert on the outcome (see reconcileAutocartJobs + 014_autocart_jobs.sql).
 */
function isAutocartLane(w: WatchRow): boolean {
  return (
    w.campground_source === 'ridb' &&
    w.autocart_enabled === true &&
    w.autocart_connected === true
  );
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
            w.rc_hold_notified_for,
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

  for (const [campsiteId, entry] of bySite) {
    const dates = [...entry.open].sort();
    if (hasConsecutiveRun(dates, required)) return { dates, campsiteId, campsiteName: entry.name };
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
  await mutate(
    `UPDATE worker_heartbeat SET beat_at = NOW(), watches_checked = $1 WHERE id = 1`,
    [watchesChecked]
  ).catch((err) => console.error('[poller] heartbeat write failed:', err));
}

async function cycle(): Promise<void> {
  const watches = await loadWatches();
  if (watches.length === 0) {
    await beat(0);
    console.log(`[poller] heartbeat — no active watches`);
    return;
  }

  // Auto-cart rec.gov watches are handled by the tighter autocartCycle() below;
  // everything else runs here on the main cadence.
  const mainWatches = watches.filter((w) => !isAutocartLane(w));
  const raWatches = mainWatches.filter((w) => w.campground_source === 'reserveamerica');
  const rcWatches = mainWatches.filter((w) => isUseDirectSource(w.campground_source));
  const ridbWatches = mainWatches.filter(
    (w) => !isUseDirectSource(w.campground_source) && w.campground_source !== 'reserveamerica'
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
      const open = await findRCOpenUnit(w.campground_id, w.start_date, w.end_date, required);
      if (open) rcResults.set(w.id, { dates: nights, unitId: open.unitId, sleepingUnitId: open.sleepingUnitId });
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
  const raResults = new Map<string, { dates: string[]; siteIds: number[] }>();
  await pMap(
    raWatches,
    async (w) => {
      const nights = nightsOfRange(w.start_date, w.end_date);
      const required = Math.max(w.min_nights, nights.length);
      const open = await findReserveAmericaOpen(w.campground_id, w.start_date, w.end_date, required);
      if (open) raResults.set(w.id, { dates: nights, siteIds: open.siteIds });
    },
    RECGOV_CONCURRENCY
  );

  let notified = 0;
  for (const watch of mainWatches) {
    const rc = rcResults.get(watch.id);
    const result: WatchResult =
      watch.campground_source === 'reserveamerica'
        ? { dates: raResults.get(watch.id)?.dates ?? [], campsiteId: null, campsiteName: null }
        : isUseDirectSource(watch.campground_source)
          ? { dates: rc?.dates ?? [], campsiteId: null, campsiteName: null }
          : availableDatesForWatch(watch, monthData);
    if (result.dates.length === 0) continue;

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
            ? (watch.reservations_url ?? 'https://www.reserveamerica.com/')
            : isUseDirectSource(watch.campground_source)
            // #camphawk-rc fragment (unitId_arrival_nights_sleepingUnitId) lets the
            // extension add the exact unit to the RC cart. Fragment never hits RC's server.
            ? `${watch.reservations_url ?? 'https://www.reservecalifornia.com/'}${
                rc ? `#camphawk-rc=${rc.unitId}_${watch.start_date}_${result.dates.length}_${rc.sleepingUnitId ?? ''}` : ''
              }`
            : result.campsiteId
              // #camphawk fragment carries the dates for the browser extension's
              // optional autofill. Fragments are never sent to rec.gov's server.
              ? `https://www.recreation.gov/camping/campsites/${result.campsiteId}#camphawk=${watch.start_date}_${watch.end_date}`
              : `https://www.recreation.gov/camping/campgrounds/${watch.campground_id}`,
        campsiteName: result.campsiteName,
        startDate: watch.start_date,
        endDate: watch.end_date,
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
  const watches = (await loadWatches()).filter(isAutocartLane);
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

  rcSyncIfDue();
  setInterval(rcSyncIfDue, 60 * 60 * 1000);
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
