// Close watches whose trip is over.
//
// A watch row stays `active = true` forever. The poller and the watch cap both filter
// it out (`end_date > CURRENT_DATE`) and the watches list hides it, so an expired watch
// is not polled and does not consume a slot — but it is still, in the database and in
// every count that forgets that filter, an "active" watch. That divergence is the bug
// worth fixing: `active` should mean what it says, so a query that reasonably reads
// `WHERE active` gets the right answer instead of the right answer plus a tail of dead
// trips. On 2026-08-05 there were 5 of them against 13 live ones — 28% noise.
//
// THE PREDICATE MUST NEVER BE WIDER THAN THE POLLER'S FILTER.
// The poller runs `end_date > CURRENT_DATE`; this sweep closes exactly the complement,
// `end_date <= CURRENT_DATE`. Get that backwards by a day — `< CURRENT_DATE + 1`, say,
// or a "grace period" that reaches into the future — and this quietly switches off
// watches the poller is still running, which is a silent alerting outage with no error
// anywhere. Narrower is harmless (a few rows linger one more hour); wider is an outage.
// If you ever change the poller's filter, change this one in the same commit.
//
// Old rows carry a `campflare_sub_id` from the third-party alert service we no longer
// use (no CAMPFLARE_* credentials exist anywhere). Nothing to cancel, so this does not
// call out to it — a sweep that makes a network call to a dead vendor is a new failure
// mode bolted onto a one-line UPDATE.

import { mutate } from '../src/lib/db/client';

/** How often the sweep runs. Hourly: nothing here is urgent — the row is already
 *  ignored by everything that matters, and the only cost of lateness is that a count
 *  is stale for under an hour. */
export const EXPIRE_INTERVAL_MS = Number(process.env.EXPIRE_INTERVAL_MS ?? 60 * 60 * 1000);

/**
 * Mark every finished watch inactive. Returns the ids it closed — normally none, which
 * is the point: after the first sweep the backlog is gone and it only ever catches the
 * handful that ended today.
 *
 * Idempotent by construction (`AND active = true` in the WHERE), so running it on both
 * shard machines would be harmless. It still runs under a claim in the poller, because
 * "harmless if doubled" and "worth doubling" are different things.
 *
 * `onlyIds` exists so a test can drive THIS predicate — the whole point of the test —
 * without the side effect of closing every real user's finished watches as a byproduct
 * of running `npm test`. Same device as `claimSyncJob(job, ttl, machineId)`: narrow the
 * blast radius, never re-type the rule inside the test, because a copy of a predicate
 * cannot notice a change made to the original. Production passes nothing.
 */
export async function expireFinishedWatches(onlyIds?: string[]): Promise<string[]> {
  const rows = await mutate<{ id: string }>(
    `UPDATE watches
        SET active = false
      WHERE active = true
        AND end_date <= CURRENT_DATE
        AND ($1 IS NULL OR id::text = ANY($1))
      RETURNING id`,
    [onlyIds ?? null]
  );
  return rows.map((r) => r.id);
}
