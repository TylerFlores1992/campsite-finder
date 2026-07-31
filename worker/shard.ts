// Which slice of the campgrounds does THIS machine poll?
//
// rec.gov's rate limit is per egress IP — measured 2026-07-31 with three Fly machines,
// two of them sharing a /24, all clean at ~16 req/min each. One machine sustains about
// four campground-months at a 15s cadence, so capacity grows by adding machines, each
// polling a disjoint slice.
//
// SHIPPED AT SHARD_COUNT = 1, where it is a deliberate no-op: one index, every
// campground owned, behaviour identical to before. The point of shipping it dark is
// that scaling later is a config change and a `flyctl machine clone`, not a project
// started under pressure when detection is already falling behind.
//
// Separate from poller.ts for the same reason claim.ts is: importing the poller STARTS
// it, which would make this untestable.

import { query, mutate } from '../src/lib/db/client';

/** How many slices the campground space is divided into. Same value on every machine. */
export const SHARD_COUNT = Math.max(1, Number(process.env.SHARD_COUNT ?? 1));
/** Lease lifetime. A holder renews at a third of this, so two consecutive renew
 *  failures still leave time before anyone else can take the index. */
const LEASE_MS = Number(process.env.SHARD_LEASE_MS ?? 45_000);
export const LEASE_RENEW_MS = Math.floor(LEASE_MS / 3);

/** Fly gives every machine a stable id; anything unique works locally. */
const MACHINE_ID = process.env.FLY_MACHINE_ID ?? `local-${process.pid}`;

let heldIndex: number | null = null;

/**
 * FNV-1a. Any stable hash would do, but it must be STABLE — computed identically on
 * every machine and across restarts, or two machines disagree about who owns a
 * campground and it gets either polled twice or not at all. Deliberately not
 * `Math.random`, not `hashCode`-by-insertion-order, and not Postgres' `hashtext`
 * (which the poller would have to round-trip to the DB for on every watch).
 */
export function shardOf(campgroundId: string, shardCount = SHARD_COUNT): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < campgroundId.length; i++) {
    h ^= campgroundId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shardCount;
}

/**
 * Does this machine poll this campground?
 *
 * SHARD_COUNT === 1 short-circuits to true WITHOUT consulting the lease. That is the
 * safety valve that makes shipping this dark genuinely zero-risk: at one shard there is
 * no one to collide with, so a DB hiccup during lease renewal must never be able to
 * stop the only poller from polling. Introducing a new way to go blind, while building
 * machinery whose entire purpose is to prevent going blind, would be a poor trade.
 *
 * At SHARD_COUNT > 1 a held lease IS required — owning a slice you have not claimed is
 * how the same campground gets polled by two machines at once.
 */
export function ownsCampground(campgroundId: string): boolean {
  if (SHARD_COUNT === 1) return true;
  if (heldIndex === null) return false;
  return shardOf(campgroundId) === heldIndex;
}

export function heldShard(): number | null {
  return heldIndex;
}

/**
 * Claim `index` for this machine, or renew it if we already hold it.
 *
 * One atomic statement, the same shape as the alerting claim: the WHERE on the
 * conflict path means a row is only taken when it is ours already or its lease has
 * genuinely expired. Two machines racing for a free index cannot both win.
 */
async function tryClaim(index: number): Promise<boolean> {
  const rows = await mutate<{ shard_index: number }>(
    `INSERT INTO poller_shards (shard_index, machine_id, leased_until, shard_count)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4)
     ON CONFLICT (shard_index) DO UPDATE
       SET machine_id   = EXCLUDED.machine_id,
           leased_until = EXCLUDED.leased_until,
           shard_count  = EXCLUDED.shard_count,
           updated_at   = NOW()
       WHERE poller_shards.machine_id = EXCLUDED.machine_id
          OR poller_shards.leased_until < NOW()
     RETURNING shard_index`,
    [index, MACHINE_ID, String(LEASE_MS), SHARD_COUNT]
  ).catch((err) => {
    console.error('[shard] claim failed:', (err as Error).message);
    return [] as { shard_index: number }[];
  });
  return rows.length > 0;
}

/**
 * Hold on to our index, or take a free one. Safe to call on a timer.
 *
 * Renewing first matters: a machine that already holds an index must not wander to a
 * different one just because index 0 happens to be free this second — that would
 * reshuffle ownership continuously and leave campgrounds unpolled between shuffles.
 */
export async function claimOrRenewShard(): Promise<number | null> {
  if (heldIndex !== null && (await tryClaim(heldIndex))) return heldIndex;

  // Lost it (or never had one). Start from a machine-dependent offset so N machines
  // starting together don't all contend for index 0 in the same instant.
  const start = shardOf(MACHINE_ID);
  for (let i = 0; i < SHARD_COUNT; i++) {
    const candidate = (start + i) % SHARD_COUNT;
    if (await tryClaim(candidate)) {
      if (heldIndex !== candidate) {
        console.log(`[shard] holding shard ${candidate} of ${SHARD_COUNT} (machine ${MACHINE_ID})`);
      }
      heldIndex = candidate;
      return candidate;
    }
  }
  if (heldIndex !== null) {
    console.warn(`[shard] LOST shard ${heldIndex} and no free index available — polling nothing until one frees up`);
  }
  heldIndex = null;
  return null;
}

export interface ShardHealth {
  expected: number;
  live: number[];
  missing: number[];
}

/** Which shards are currently held. `missing` is the silent-blindness case: those
 *  campgrounds are not being polled by anyone and nothing else would say so. */
export async function shardHealth(): Promise<ShardHealth> {
  const rows = await query<{ shard_index: number; shard_count: number }>(
    `SELECT shard_index, shard_count FROM poller_shards WHERE leased_until > NOW()`
  ).catch(() => [] as { shard_index: number; shard_count: number }[]);
  const expected = rows.reduce((m, r) => Math.max(m, r.shard_count), 0);
  const live = rows.map((r) => r.shard_index).sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = 0; i < expected; i++) if (!live.includes(i)) missing.push(i);
  return { expected, live, missing };
}

/** Tests only. */
export function __setHeldShard(index: number | null): void {
  heldIndex = index;
}
