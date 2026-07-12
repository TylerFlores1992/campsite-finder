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
import { findRCOpenUnit } from '../src/lib/availability/reservecalifornia';
import { syncReserveCalifornia } from '../src/lib/sources/reservecalifornia/sync';
import { fetchUnitTypes } from '../src/lib/sources/reservecalifornia/client';
import { dispatchNotifications } from '../src/lib/notifications';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
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
            c.name AS campground_name, c.source AS campground_source,
            c.reservations_url
     FROM watches w
     JOIN campgrounds c ON c.id = w.campground_id
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

  const ridbWatches = watches.filter((w) => w.campground_source !== 'reservecalifornia');
  const rcWatches = watches.filter((w) => w.campground_source === 'reservecalifornia');

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

  let notified = 0;
  for (const watch of watches) {
    const rc = rcResults.get(watch.id);
    const result: WatchResult =
      watch.campground_source === 'reservecalifornia'
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
          watch.campground_source === 'reservecalifornia'
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
    } catch (err) {
      console.error(`[poller] notification failed for watch ${watch.id}:`, err);
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

// ReserveCalifornia's WAF blocks GitHub Actions runner IPs (403), so the
// nightly RC refresh runs here on Fly instead. Runs when the last successful
// RC sync is older than ~22h; checked hourly.
const RC_SYNC_MAX_AGE_HOURS = 22;
let rcSyncRunning = false;

async function rcSyncIfDue(): Promise<void> {
  if (rcSyncRunning) return;
  rcSyncRunning = true;
  try {
    const row = await query<{ age_hours: number }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(finished_at))) / 3600 AS age_hours
       FROM sync_log WHERE source = 'reservecalifornia' AND facilities_synced > 0`
    );
    const age = row[0]?.age_hours;
    if (age != null && age < RC_SYNC_MAX_AGE_HOURS) return;
    console.log(`[poller] RC sync due (last success ${age?.toFixed(1) ?? 'never'}h ago) — starting`);
    const result = await syncReserveCalifornia();
    console.log(`[poller] RC sync finished: ${result.facilitiesSynced} campgrounds, ${result.campsitesSynced} units, ${result.errors.length} errors`);
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
    const types = await fetchUnitTypes();
    console.log(`[poller] RC connectivity probe OK — ${types.length} unit types (via ${process.env.RC_PROXY_URL ? 'proxy' : 'direct'})`);
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
}

main();
