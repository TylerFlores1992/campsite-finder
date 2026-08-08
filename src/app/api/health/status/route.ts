import { NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db/client';
import {
  DELIVERY_STALE_MS as SHARED_DELIVERY_STALE_MS,
  DETECT_STALE_MS as SHARED_DETECT_STALE_MS,
  RECGOV_MONTHS_PER_MACHINE,
} from '@/lib/health-thresholds';

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
  /**
   * Whether a `fail` here means ALERTING is broken, and so should turn this endpoint
   * 503 and wake the owner at 3am. Defaults to true; only the auto-cart family opts out.
   *
   * WHY THIS EXISTS (2026-08-08). `autocart.rc_session` was added as a plain `fail`, so a
   * dead ReserveCalifornia session made the whole endpoint report `down` — and the pager
   * (.github/workflows/health-canary.yml, every 5 min, 30-min re-page throttle) emailed
   * "CampHawk DOWN — alerting is broken" roughly every half hour for eight hours
   * overnight. **Not one alert was affected.** The poller detects and notifies from Fly;
   * a dead RC session disables one optional convenience for one subscriber.
   *
   * That is the wolf-crying this file's header already forbids — it says 503 means
   * "alerting is (or is about to be) broken", and an auto-cart fault is not that. The
   * cost is not the noise, it is that the NEXT page gets skimmed.
   *
   * These checks are still `fail`, still red in the admin banner, and still read by the
   * 07:30 PT pre-flight Routine, which is the right pager for them: it fires once, 30
   * minutes before the release, when a human can still act. Severity and paging are
   * different questions and this is where they part.
   */
  pages?: boolean;
}

const WORKER_STALE_MS = 5 * 60 * 1000; // poller beats every ~15s
const DETECT_STALE_MS = SHARED_DETECT_STALE_MS;
// Shared with the admin banner — see lib/health-thresholds for why these stopped
// being local constants.
const DELIVERY_STALE_MS = SHARED_DELIVERY_STALE_MS;
const SYNC_STALE_MS = 48 * 60 * 60 * 1000; // catalog syncs are ~nightly/hourly
const BOT_STALE_MS = 5 * 60 * 1000; // roster poll ~2s; matches poller's isBotOnline intent
// The RC hold runner polls every ~20s (RC_HOLD_POLL_MS). Three minutes is nine missed
// polls — comfortably past a transient network blip, and still well inside the ~21-minute
// window a hold is reachable in, so a stale beat is actionable BEFORE the release is lost
// rather than a post-mortem.
const RC_RUNNER_STALE_MS = 3 * 60 * 1000;
// The session verdict comes from rc-keepwarm.mjs's 20-minute pass. 45 minutes is two
// missed passes, which allows for one inconclusive result (a busy profile, a 403 from
// RC's edge) without crying wolf — those report NOTHING rather than `false` on purpose,
// so staleness is how "we could not tell for a while" surfaces at all.
const RC_SESSION_STALE_MS = 45 * 60 * 1000;

const ageMs = (ts: string | null | undefined) => (ts ? Date.now() - new Date(ts).getTime() : Infinity);
const secs = (ms: number) => (Number.isFinite(ms) ? Math.round(ms / 1000) : undefined);
/** "7h20m" — durations here run to hours, and 26400s is not a number anyone reads. */
const hms = (ms: number) => {
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

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

  // 1b. Shard coverage. An unheld shard means its campgrounds are watched by NOBODY —
  //     and every other check stays green while it happens, which is the worst failure
  //     this product has. A rec.gov deadlock on 2026-07-31 went unnoticed for twenty
  //     minutes precisely because nothing asserted "work is actually being covered".
  //     `machines` feeds the capacity check below; 1 when no lease rows exist, since
  //     exactly one machine is doing the work whether or not it has leased yet.
  let machines = 1;
  try {
    const shards = await query<{ shard_index: number; shard_count: number; machine_id: string }>(
      `SELECT shard_index, shard_count, machine_id FROM poller_shards WHERE leased_until > NOW()`
    );
    const expected = shards.reduce((m, r) => Math.max(m, r.shard_count), 0);
    const live = shards.map((r) => r.shard_index);
    const missing: number[] = [];
    for (let i = 0; i < expected; i++) if (!live.includes(i)) missing.push(i);
    checks.push({
      name: 'poller.shards',
      // No rows at all is a warn, not a fail: a worker predating the shard lease is a
      // deploy-ordering artefact, not an outage.
      level: expected === 0 ? 'warn' : missing.length > 0 ? 'fail' : 'ok',
      detail:
        expected === 0
          ? 'no shard lease yet (worker may predate shard support)'
          : missing.length > 0
            ? `shard(s) ${missing.join(', ')} of ${expected} UNHELD — those campgrounds are not being polled`
            : `${live.length}/${expected} shard(s) held`,
    });
    machines = Math.max(1, new Set(shards.map((r) => r.machine_id)).size);
  } catch (err) {
    checks.push({ name: 'poller.shards', level: 'warn', detail: `read failed: ${(err as Error).message}` });
  }

  // 1c. Capacity vs demand — the "never trail demand" gauge. rec.gov capacity is per
  //     egress IP, so it grows only by adding machines; this check counts what the
  //     active watches actually require (distinct campground-months, because the
  //     scheduler dedups every watch on the same campground-month into one fetch
  //     stream) and compares it with machines × RECGOV_MONTHS_PER_MACHINE.
  //     AT capacity = warn: the next watch created will push refresh past 15s — clone
  //     a machine now. OVER capacity = fail: the 15s promise is already broken, and
  //     nothing else goes red for it (the poller keeps beating, canaries keep
  //     passing — everything merely gets slower). Ops-only: the user-facing outage
  //     banner reads detect:* checks alone.
  try {
    const demand = await queryOne<{ n: number }>(
      `SELECT COUNT(DISTINCT (w.campground_id, to_char(m, 'YYYY-MM')))::int AS n
         FROM watches w
         JOIN campgrounds c ON c.id = w.campground_id
         CROSS JOIN LATERAL generate_series(
           date_trunc('month', GREATEST(w.start_date, CURRENT_DATE)::timestamp),
           date_trunc('month', w.end_date::timestamp),
           interval '1 month') AS m
        WHERE w.active = true AND w.end_date > CURRENT_DATE AND c.source = 'ridb'`
    );
    const n = demand?.n ?? 0;
    const capacity = machines * RECGOV_MONTHS_PER_MACHINE;
    checks.push({
      name: 'poller.capacity',
      level: n > capacity ? 'fail' : n === capacity ? 'warn' : 'ok',
      detail:
        `${n}/${capacity} rec.gov campground-months across ${machines} machine(s)` +
        (n > capacity
          ? ' — OVER capacity, refresh has fallen below 15s; raise SHARD_COUNT and clone a machine'
          : n === capacity
            ? ' — at capacity; the next watch degrades everyone. Clone a machine'
            : ''),
    });
  } catch (err) {
    checks.push({ name: 'poller.capacity', level: 'warn', detail: `read failed: ${(err as Error).message}` });
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
    for (const key of ['delivery:email', 'delivery:sms', 'delivery:push']) {
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
      // Auto-cart, not alerting — see the `pages` field on Check. A bot offline fails
      // OPEN to normal alerts, so nothing a subscriber depends on is lost.
      pages: false,
      level: !bot || age > BOT_STALE_MS ? 'warn' : 'ok',
      detail: !bot ? 'no bot heartbeat row' : `last beat ${secs(age)}s ago`,
      ageSeconds: secs(age),
    });
  } catch (err) {
    checks.push({ name: 'autocart.bot', level: 'warn', pages: false, detail: `read failed: ${(err as Error).message}` });
  }

  // 4b. RC hold runner — a SEPARATE process from the rec.gov bot above, and they fail
  //     independently: on 2026-08-07 the rec.gov bot carted sites all afternoon while
  //     this one was dead, so `autocart.bot` sat green and actively reassured.
  //
  //     Judged against PENDING WORK, not staleness alone. The runner only matters when a
  //     hold is due — a quiet box overnight is normal and must not page anyone, while a
  //     dead runner with a `requested` hold at its release time is a user losing a site
  //     they were promised. Same principle as `poller.shards`: the alarming state is
  //     silent blindness, not idleness.
  try {
    const [beat, due, upcoming] = await Promise.all([
      queryOne<{
        beat_at: string | null; session_ok: boolean | null;
        session_at: string | null; session_detail: string | null; session_source: string | null;
        session_since: string | null;
      }>(
        `SELECT beat_at::text, session_ok, session_at::text, session_detail, session_source,
                session_since::text
           FROM rc_runner_heartbeat WHERE id = 1`,
      ),
      queryOne<{ n: string }>(
        `SELECT count(*) AS n FROM rc_hold_requests
          WHERE status = 'requested'
            AND release_at <= to_char((NOW() + interval '10 minutes') AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`
      ),
      // Anything still ahead of us. A dead session matters for a hold due TOMORROW too —
      // in fact that is the only case a human can still save, which is the entire reason
      // for reporting session health rather than waiting for the runner to fail.
      queryOne<{ n: string }>(
        `SELECT count(*) AS n FROM rc_hold_requests
          WHERE status IN ('requested','carted','claiming')
            AND release_at >= to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`
      ),
    ]);
    const age = ageMs(beat?.beat_at);
    const pending = Number(due?.n ?? 0);
    const stale = !beat || age > RC_RUNNER_STALE_MS;
    checks.push({
      name: 'autocart.rc_runner',
      // Auto-cart, not alerting — see the `pages` field on Check.
      pages: false,
      // FAIL only when both are true — that combination is a hold about to be missed.
      level: stale && pending > 0 ? 'fail' : stale ? 'warn' : 'ok',
      detail: !beat
        ? 'no runner heartbeat row'
        : `last poll ${secs(age)}s ago` +
          (pending > 0 ? `, ${pending} hold(s) due — these will be MISSED if it stays down` : ', no holds due'),
      ageSeconds: secs(age),
    });

    // 4c. THE RC SESSION ITSELF — one level deeper than 4b, and the level that failed.
    //     The runner heartbeat proves the process can reach camphawk.app. It cannot
    //     distinguish a runner that is carting sites from one that opens Chromium, finds
    //     a dead session and skips every pass in silence. On 2026-08-07 that distinction
    //     was the whole incident, and 4b would have been green for it.
    //
    //     Reported by `rc-keepwarm.mjs` every ~20 minutes and by the runner whenever it
    //     opens the profile for real work. NULL means never reported — shown as unknown,
    //     never as healthy, the same rule as `untracked` SMS rows and a null availability
    //     read: the absence of an answer is not a good answer.
    const sessionAge = ageMs(beat?.session_at);
    const sessionStale = !beat?.session_at || sessionAge > RC_SESSION_STALE_MS;
    const ahead = Number(upcoming?.n ?? 0);
    const dead = beat?.session_ok === false;
    checks.push({
      name: 'autocart.rc_session',
      // Auto-cart, not alerting — see the `pages` field on Check. The 07:30 PT pre-flight
      // Routine is what pages for this, once, when it can still be acted on.
      pages: false,
      // A dead session with a hold still ahead of it is a promise we cannot keep and
      // only a human can fix — that is the one that should shout. Dead with nothing
      // queued still warns: the fix needs lead time, so "nobody is affected yet" is
      // exactly when it is cheapest to act.
      level: dead && ahead > 0 ? 'fail' : dead || sessionStale || beat?.session_ok == null ? 'warn' : 'ok',
      detail:
        beat?.session_ok == null
          ? 'never reported — is rc-keepwarm.mjs running with AUTOCART_TOKEN set?'
          : (dead ? 'RC REJECTED the session — a human must run `node rc-keepwarm.mjs --login`' : 'RC accepts the session') +
            // "for 7h20m" is the number the design turns on: an RC session has died
            // ~8-9h after sign-in twice, with keep-warm running throughout, so how long
            // this one has survived is the live measurement — not a footnote. See 047.
            ` for ${hms(ageMs(beat.session_since))}` +
            ` (${beat.session_source ?? 'unknown'}, checked ${secs(sessionAge)}s ago` +
            (sessionStale ? ', STALE' : '') + ')' +
            (dead && ahead > 0 ? ` — ${ahead} hold(s) still ahead will fail` : '') +
            (beat.session_detail ? `: ${beat.session_detail}` : ''),
      ageSeconds: secs(sessionAge),
    });
  } catch (err) {
    checks.push({ name: 'autocart.rc_runner', level: 'warn', pages: false, detail: `read failed: ${(err as Error).message}` });
  }

  // `down`/503 means ALERTING is broken — the contract stated at the top of this file,
  // and what the 5-minute pager wakes the owner for. A failing check that does not page
  // (the auto-cart family; see `Check.pages`) still drags the overall status to
  // `degraded`, so nothing is hidden — it just stops claiming the product is down when
  // the poller is happily alerting. On 2026-08-08 the difference was eight hours of
  // half-hourly "CampHawk DOWN — alerting is broken" emails for a dead ReserveCalifornia
  // session that cost precisely zero alerts.
  const anyPagingFail = checks.some((c) => c.level === 'fail' && c.pages !== false);
  const anyFail = checks.some((c) => c.level === 'fail');
  const anyWarn = checks.some((c) => c.level === 'warn');
  const status = anyPagingFail ? 'down' : anyFail || anyWarn ? 'degraded' : 'ok';

  return NextResponse.json(
    { status, checkedAt: new Date().toISOString(), checks },
    { status: anyPagingFail ? 503 : 200 }
  );
}
