import 'server-only';
import { query, queryOne } from '@/lib/db/client';
import { RECGOV_MONTHS_PER_MACHINE, RECGOV_CAPACITY_RESERVE } from '@/lib/health-thresholds';

/**
 * "Are we going to run out of poller?" — computed ONCE, read in two places.
 *
 * This lived inline in `/api/health/status` and existed nowhere else, which meant the
 * admin dashboard — the page whose whole job is "is anything broken?" — did not show the
 * one number that predicts the NEXT breakage. You had to curl the JSON to find it.
 *
 * Extracted rather than copy-pasted for the reason `lib/admin.ts` spells out: two copies
 * of a rule is one chance for them to disagree, and a capacity gauge that disagrees with
 * the pager is worse than no gauge.
 */

export interface PollerCapacity {
  /** Distinct rec.gov campground-months across active watches — the real fetch streams. */
  demand: number;
  /** machines × RECGOV_MONTHS_PER_MACHINE. */
  capacity: number;
  /** Machines actually HOLDING a shard lease, not what fly.toml claims. */
  machines: number;
  /** Free slots. Negative means over. */
  free: number;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** Shard coverage — an unheld shard means those campgrounds are polled by NOBODY. */
export interface ShardCoverage {
  held: number;
  expected: number;
  missing: number[];
  machines: number;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

export async function getShardCoverage(): Promise<ShardCoverage> {
  const shards = await query<{ shard_index: number; shard_count: number; machine_id: string }>(
    `SELECT shard_index, shard_count, machine_id FROM poller_shards WHERE leased_until > NOW()`
  );
  const expected = shards.reduce((m, r) => Math.max(m, r.shard_count), 0);
  const live = shards.map((r) => r.shard_index);
  const missing: number[] = [];
  for (let i = 0; i < expected; i++) if (!live.includes(i)) missing.push(i);
  // `machines` is 1 when there are no lease rows: exactly one machine is doing the work
  // whether or not it has leased yet.
  const machines = Math.max(1, new Set(shards.map((r) => r.machine_id)).size);
  return {
    held: live.length,
    expected,
    missing,
    machines,
    // No rows at all is a warn, not a fail: a worker predating the shard lease is a
    // deploy-ordering artefact, not an outage.
    level: expected === 0 ? 'warn' : missing.length > 0 ? 'fail' : 'ok',
    detail:
      expected === 0
        ? 'no shard lease yet (worker may predate shard support)'
        : missing.length > 0
          ? `shard(s) ${missing.join(', ')} of ${expected} UNHELD — those campgrounds are not being polled`
          : `${live.length}/${expected} shard(s) held`,
  };
}

/**
 * Demand vs capacity. rec.gov capacity is per EGRESS IP, so it grows only by adding
 * machines — which is why this is measured in machines and not in CPU.
 *
 * Counted in campground-MONTHS, not watches: the scheduler dedups every watch on the same
 * campground-month into one fetch stream, so ten watches on one campground cost what one
 * costs. Counting watches would badly overstate demand.
 */
export async function getPollerCapacity(machines: number): Promise<PollerCapacity> {
  const demandRow = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT (c.id, to_char(m, 'YYYY-MM')))::int AS n
       FROM watches w
       -- Every campground the watch covers, not just its representative. A park watch
       -- (migration 070) counts ONCE against WATCH_LIMIT but polls each division, so
       -- counting only campground_id here would under-report the real fetch streams --
       -- which is the one number this gauge exists to get right.
       CROSS JOIN LATERAL (
         SELECT COALESCE(
           (SELECT array_agg(wc.campground_id) FROM watch_campgrounds wc WHERE wc.watch_id = w.id),
           ARRAY[w.campground_id]) AS ids
       ) e
       CROSS JOIN LATERAL unnest(e.ids) AS pair(campground_id)
       JOIN campgrounds c ON c.id = pair.campground_id
       CROSS JOIN LATERAL generate_series(
         date_trunc('month', GREATEST(w.start_date, CURRENT_DATE)::timestamp),
         date_trunc('month', w.end_date::timestamp),
         interval '1 month') AS m
      WHERE w.active = true AND w.end_date > CURRENT_DATE AND c.source = 'ridb'`
  );
  const demand = demandRow?.n ?? 0;
  const capacity = machines * RECGOV_MONTHS_PER_MACHINE;
  const free = capacity - demand;

  // OVER = fail, and it pages: the 15s promise is already broken. Nothing else goes red
  // for it — the poller keeps beating and the canaries keep passing, everything is just
  // slower — which is exactly why this check has to exist.
  //
  // The WARN is an absolute free-slot reserve, not a percentage. See
  // RECGOV_CAPACITY_RESERVE for why a percentage is the wrong shape as the fleet grows.
  const level = free < 0 ? 'fail' : free < RECGOV_CAPACITY_RESERVE ? 'warn' : 'ok';
  return {
    demand,
    capacity,
    machines,
    free,
    level,
    detail:
      `${demand}/${capacity} rec.gov campground-months across ${machines} machine(s)` +
      (level === 'fail'
        ? ` — OVER capacity by ${-free}, refresh has fallen below 15s; clone a machine, then raise SHARD_COUNT`
        : level === 'warn'
          ? ` — only ${free} slot(s) free, under the ${RECGOV_CAPACITY_RESERVE} reserve. Clone a machine`
          : ` — ${free} slot(s) free`),
  };
}
