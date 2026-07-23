import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db/client';

// Machine-readable alert-health aggregate. Turns the "silent death" traps in
// docs/CONTEXT.md into something an external cron/uptime-monitor pages on:
//   200 {status:"ok"}        — everything healthy
//   200 {status:"degraded"}  — non-critical warnings (a stale catalog sync, the
//                              auto-cart bot offline, delivery canary unconfigured)
//   503 {status:"down"}      — alerting is (or is about to be) broken: the poller
//                              is silent, a source's detection canary is failing, or
//                              alert delivery is failing.
// No PII — safe to expose to a monitor. Each check carries a human-readable detail.
export const dynamic = 'force-dynamic';

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  level: Level;
  detail: string;
  ageSeconds?: number;
}

const WORKER_STALE_MS = 5 * 60 * 1000; // poller beats every ~15s
const DETECT_STALE_MS = 10 * 60 * 1000; // detection canary runs every ~2m
const DELIVERY_STALE_MS = 7 * 60 * 60 * 1000; // delivery canary runs every ~6h
const SYNC_STALE_MS = 48 * 60 * 60 * 1000; // catalog syncs are ~nightly/hourly
const BOT_STALE_MS = 5 * 60 * 1000; // roster poll ~2s; matches poller's isBotOnline intent

const ageMs = (ts: string | null | undefined) => (ts ? Date.now() - new Date(ts).getTime() : Infinity);
const secs = (ms: number) => (Number.isFinite(ms) ? Math.round(ms / 1000) : undefined);

export async function GET() {
  const checks: Check[] = [];

  // 1. Poller heartbeat — the fast "is alerting even running" signal.
  try {
    const hb = await queryOne<{ beat_at: string; watches_checked: number }>(
      `SELECT beat_at::text, watches_checked FROM worker_heartbeat WHERE id = 1`
    );
    const age = ageMs(hb?.beat_at);
    checks.push({
      name: 'worker.heartbeat',
      level: !hb ? 'fail' : age > WORKER_STALE_MS ? 'fail' : 'ok',
      detail: !hb ? 'no heartbeat row' : `last beat ${secs(age)}s ago, ${hb.watches_checked} watches`,
      ageSeconds: secs(age),
    });
  } catch (err) {
    checks.push({ name: 'worker.heartbeat', level: 'fail', detail: `read failed: ${(err as Error).message}` });
  }

  // 2. Alert-health canary rows (detection per source + delivery). Written by the
  //    poller (worker/canary.ts). Missing rows mean the canary has never run.
  try {
    const rows = await query<{
      key: string;
      ok: boolean;
      last_run_at: string | null;
      last_success_at: string | null;
      consecutive_failures: number;
      detail: string | null;
    }>(
      `SELECT key, ok, last_run_at::text, last_success_at::text, consecutive_failures, detail FROM alert_canary`
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // Detection canaries — one per source that should exist. A failing or stale one
    // means that source silently stopped detecting openings (the stale-worker trap).
    for (const source of ['ridb', 'reserveamerica', 'reservecalifornia', 'goingtocamp', 'tnsc']) {
      const key = `detect:${source}`;
      const r = byKey.get(key);
      if (!r) {
        checks.push({ name: key, level: 'warn', detail: 'no canary run yet' });
        continue;
      }
      const age = ageMs(r.last_run_at);
      // Stale run OR two+ consecutive failures = fail; a single transient miss = warn.
      const level: Level =
        age > DETECT_STALE_MS ? 'fail' : !r.ok && r.consecutive_failures >= 2 ? 'fail' : !r.ok ? 'warn' : 'ok';
      checks.push({ name: key, level, detail: r.detail ?? '(no detail)', ageSeconds: secs(age) });
    }

    // Delivery canaries — 'skipped' (unconfigured) is a warn, not a page.
    for (const key of ['delivery:email', 'delivery:sms']) {
      const r = byKey.get(key);
      if (!r) {
        checks.push({ name: key, level: 'warn', detail: 'no canary run yet' });
        continue;
      }
      const skipped = (r.detail ?? '').startsWith('skipped');
      const age = ageMs(r.last_run_at);
      const level: Level = skipped
        ? 'warn'
        : !r.ok && r.consecutive_failures >= 2
          ? 'fail'
          : !r.ok
            ? 'warn'
            : age > DELIVERY_STALE_MS
              ? 'warn'
              : 'ok';
      checks.push({ name: key, level, detail: r.detail ?? '(no detail)', ageSeconds: secs(age) });
    }
  } catch (err) {
    checks.push({ name: 'canary', level: 'fail', detail: `read failed: ${(err as Error).message}` });
  }

  // 3. Per-source catalog freshness — the honest signal is facilities_synced > 0
  //    (docs: a non-null error is NOT failure), so a source that never synced or
  //    synced zero shows here. Warn-level: catalog staleness degrades search, not
  //    the alert path the canaries cover.
  //
  //    Only consider FINISHED syncs (finished_at IS NOT NULL). An in-flight or
  //    interrupted sync leaves a row with finished_at=null and facilities_synced=null
  //    — that's "no completion record", NOT a completed-but-empty run, and reading it
  //    as "synced 0 facilities" produced recurring false warns whenever an orphaned
  //    row happened to be a source's newest (e.g. a catalog sync killed mid-run by a
  //    worker restart). Basing freshness on the last COMPLETED sync also still catches
  //    a source whose syncs stop finishing: its latest finished row simply ages past
  //    SYNC_STALE_MS and trips the stale branch below.
  try {
    const syncs = await query<{ source: string; finished_at: string | null; facilities_synced: number | null }>(
      `SELECT DISTINCT ON (source) source, finished_at::text, facilities_synced
         FROM sync_log WHERE finished_at IS NOT NULL
         ORDER BY source, finished_at DESC`
    );
    let staleSources = 0;
    let zeroSources = 0;
    for (const s of syncs) {
      const synced = s.facilities_synced ?? 0;
      const age = ageMs(s.finished_at);
      if (synced === 0) zeroSources++;
      else if (age > SYNC_STALE_MS) staleSources++;
    }
    checks.push({
      name: 'catalog.syncs',
      level: zeroSources > 0 ? 'warn' : staleSources > 0 ? 'warn' : 'ok',
      detail: `${syncs.length} sources; ${zeroSources} synced 0 facilities, ${staleSources} stale (>48h)`,
    });
  } catch (err) {
    checks.push({ name: 'catalog.syncs', level: 'warn', detail: `read failed: ${(err as Error).message}` });
  }

  // 4. Auto-cart bot heartbeat — offline is degraded (watches fall back to normal
  //    alerts, fail-open), not down.
  try {
    const bot = await queryOne<{ beat_at: string | null }>(
      `SELECT beat_at::text FROM autocart_bot_heartbeat WHERE id = 1`
    );
    const age = ageMs(bot?.beat_at);
    checks.push({
      name: 'autocart.bot',
      level: !bot || age > BOT_STALE_MS ? 'warn' : 'ok',
      detail: !bot ? 'no bot heartbeat row' : `last beat ${secs(age)}s ago`,
      ageSeconds: secs(age),
    });
  } catch (err) {
    checks.push({ name: 'autocart.bot', level: 'warn', detail: `read failed: ${(err as Error).message}` });
  }

  const anyFail = checks.some((c) => c.level === 'fail');
  const anyWarn = checks.some((c) => c.level === 'warn');
  const status = anyFail ? 'down' : anyWarn ? 'degraded' : 'ok';

  return NextResponse.json(
    { status, checkedAt: new Date().toISOString(), checks },
    { status: anyFail ? 503 : 200 }
  );
}
