// Which machine runs a nightly catalog sync — exactly one of them.
//
// EXTRACTED FROM poller.ts SO IT CAN BE TESTED, for the same reason claim.ts and
// carted-history.ts are: importing the poller STARTS it.
//
// The bug this exists for (2026-08-03): at `SHARD_COUNT = 2`, BOTH machines ran the
// whole UseDirect catalog sync, 45 seconds apart, through the same states in the same
// order. `ownsCampground` shards the polling; the catalog syncs were never shard-aware,
// and their only guard was an in-process boolean that cannot see the other machine.
// Both check sync_log for "is a sync due?" before either has finished, both see yes.
//
// It hurts because UseDirect syncs route through `/api/rc-proxy` on VERCEL, so both
// workers exit from the SAME Vercel IPs, and those WAFs meter per IP. Every resulting
// error was `RC proxy /search/grid → 502 upstream 403`: Ohio 311, Minnesota 80 and 140,
// Illinois 139 and 42. Minnesota had logged zero errors nightly for the previous
// fortnight. Same mistake `coalesce: false` on the nightly sync already guards against.
//
// A CLAIM, not a shard index. Pinning the sync to shard 0 would be one line, but then a
// machine 0 that is down or restarting means the catalog silently stops refreshing —
// and a stale catalog is invisible until someone searches for a campground that should
// be there. A claim lets whichever machine is alive do the work.

import { mutate } from '../src/lib/db/client';

/** Fly gives every machine a stable id; anything unique works locally. Matches shard.ts. */
const MACHINE_ID = process.env.FLY_MACHINE_ID ?? `local-${process.pid}`;

/**
 * Claim lifetime. Deliberately much SHORTER than a sync run (the thorough UseDirect
 * sync is 50+ minutes) because the holder renews while it works — see renewSyncClaim.
 * A short TTL is what makes a dead holder recoverable quickly; a TTL sized to the
 * longest run would leave the catalog stuck for that long after a crash.
 */
export const SYNC_CLAIM_MS = Number(process.env.SYNC_CLAIM_MS ?? 10 * 60 * 1000);
/** Renew at a third of the TTL, so two consecutive failures still leave slack. */
export const SYNC_CLAIM_RENEW_MS = Math.floor(SYNC_CLAIM_MS / 3);

/**
 * Try to become the machine that runs `job`. Returns true only if we now hold it.
 *
 * One atomic INSERT .. ON CONFLICT .. WHERE, the same shape as the alerting claim and
 * the shard lease: the WHERE runs inside the conflict resolution, so two machines
 * racing cannot both win. We take it if nobody holds it, if the holder's claim has
 * EXPIRED, or if the holder is us (a restart re-taking its own claim rather than
 * waiting out its own TTL).
 *
 * Fails CLOSED on a read error — returns false, so a DB hiccup means "someone else
 * might be syncing", not "sync anyway". A missed nightly sync costs a day of catalog
 * freshness; a doubled one is what caused this.
 *
 * `machineId` exists so a test can stage the ACTUAL race — eight different machines
 * asking at once. Without it a test can only ever impersonate one machine (the
 * module-level MACHINE_ID), and the alternative, re-typing this statement inside the
 * test, would assert against a copy that cannot notice a change made here. Production
 * never passes it.
 */
export async function claimSyncJob(
  job: string,
  ttlMs = SYNC_CLAIM_MS,
  machineId: string = MACHINE_ID
): Promise<boolean> {
  try {
    const rows = await mutate<{ job: string }>(
      `INSERT INTO sync_claims (job, machine_id, claimed_until)
       VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (job) DO UPDATE
         SET machine_id    = EXCLUDED.machine_id,
             claimed_until = EXCLUDED.claimed_until,
             updated_at    = NOW()
         WHERE sync_claims.machine_id = EXCLUDED.machine_id
            OR sync_claims.claimed_until < NOW()
       RETURNING job`,
      [job, machineId, String(ttlMs)]
    );
    return rows.length > 0;
  } catch (err) {
    console.error(`[sync-claim] claim of ${job} failed:`, (err as Error).message);
    return false;
  }
}

/**
 * Extend our claim while the sync is still running. Only succeeds if we still hold it
 * — if another machine took over after an expiry, we do NOT steal it back mid-run.
 * The caller keeps working either way; the renewal is what stops a long sync from
 * having its claim expire underneath it.
 */
export async function renewSyncClaim(job: string, ttlMs = SYNC_CLAIM_MS): Promise<boolean> {
  try {
    const rows = await mutate<{ job: string }>(
      `UPDATE sync_claims
          SET claimed_until = NOW() + ($3 || ' milliseconds')::interval, updated_at = NOW()
        WHERE job = $1 AND machine_id = $2
        RETURNING job`,
      [job, MACHINE_ID, String(ttlMs)]
    );
    return rows.length > 0;
  } catch (err) {
    console.error(`[sync-claim] renew of ${job} failed:`, (err as Error).message);
    return false;
  }
}

/**
 * Give the claim up as soon as the sync finishes, so the next run is not gated on the
 * TTL expiring. Only releases OUR claim. Best-effort: an expiry covers a failed release.
 */
export async function releaseSyncJob(job: string): Promise<void> {
  try {
    await mutate(`DELETE FROM sync_claims WHERE job = $1 AND machine_id = $2`, [job, MACHINE_ID]);
  } catch (err) {
    console.error(`[sync-claim] release of ${job} failed:`, (err as Error).message);
  }
}

/**
 * Run `fn` only if we win the claim, renewing it throughout, and always releasing it.
 * Returns false if another machine holds the job, so the caller can log that it was
 * skipped rather than silently doing nothing.
 */
export async function withSyncClaim(job: string, fn: () => Promise<void>): Promise<boolean> {
  if (!(await claimSyncJob(job))) return false;
  const renew = setInterval(() => { void renewSyncClaim(job); }, SYNC_CLAIM_RENEW_MS);
  // Never hold the event loop open for the renewal timer alone.
  if (typeof renew.unref === 'function') renew.unref();
  try {
    await fn();
  } finally {
    clearInterval(renew);
    await releaseSyncJob(job);
  }
  return true;
}
