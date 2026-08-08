// Close out RC holds whose moment came and went without a cart — and TELL THE USER.
//
// WHY THIS EXISTS (2026-08-07, the first real run of the day-before flow). A hold was
// offered at 05:26, tapped at 06:00, and the site released at 08:00 exactly as predicted.
// The mini-PC runner never picked it up. Six hours later the row still read `requested`
// with `updated_at` unchanged since the tap: no cart, no `failed`, no error, and — the
// part that matters — **no word to the user**, who had been told "you'll get a text when
// it's in the cart". A promise made and silently dropped is worse than never offering.
//
// THE CLEANUP CANNOT LIVE IN THE FEED. `expireStaleHolds` runs inside
// `GET /api/auto-cart/rc-holds`, which only executes when the runner polls — so when the
// runner is down, the sweep that would notice the runner is down does not run either. It
// is a watchdog wired to the thing it watches. This runs on the Fly worker instead,
// which is always up and has nothing to do with the mini-PC.
//
// THE GRACE MUST BE WIDER THAN THE FEED'S. `dueHolds` stops offering a hold
// `graceMinutes` (20) after its release, so anything past that is unreachable by the
// runner no matter what — it can never be carted later. Sweeping EARLIER than the feed
// gives up would mark a hold failed while the runner could still legitimately take it,
// and the user would get "we couldn't" followed by "we did". Wider is safe; narrower is
// a lie.

import { query, mutate } from '../src/lib/db/client';
import { notifyHoldMissed } from '../src/lib/rc-holds-notify';

/** Hourly. Nothing here is urgent — the moment is already lost — and the value is
 *  telling the user, which is worth doing reliably rather than instantly. */
export const EXPIRE_HOLDS_INTERVAL_MS = Number(process.env.EXPIRE_HOLDS_INTERVAL_MS ?? 60 * 60 * 1000);

/** Minutes past the release after which a `requested` hold is unreachable. Must exceed
 *  the feed's `dueHolds` grace (20) — see the header. */
export const HOLD_MISS_GRACE_MIN = Number(process.env.HOLD_MISS_GRACE_MIN ?? 45);

interface MissedHold {
  id: string;
  watch_id: string;
  user_id: string;
  campground_id: string;
  unit_id: string;
  unit_name: string | null;
  arrival_date: string;
  release_at: string;
}

/**
 * Mark every hold the runner missed as `failed`, and return them so the caller can
 * notify. Returns the rows it closed — normally none, which is the point.
 *
 * `onlyIds` narrows the blast radius for tests, the same device as
 * `expireFinishedWatches(onlyIds)`: drive the REAL predicate without failing every live
 * user's holds as a side effect of `npm test`. Production passes nothing.
 */
export async function failMissedHolds(onlyIds?: string[]): Promise<MissedHold[]> {
  // `release_at` is RC's zone-less Pacific wall-clock string, so it is compared against
  // Pacific wall-clock rather than parsed — the same rule as `dueHolds`. Parsing it into
  // a Date here would shift the cutoff by the worker's UTC offset, i.e. seven hours, and
  // silently fail holds that are still perfectly live.
  return mutate<MissedHold>(
    `UPDATE rc_hold_requests
        SET status = 'failed',
            error = 'no cart at release time — the hold runner did not pick it up',
            updated_at = NOW()
      WHERE status = 'requested'
        AND release_at < to_char((NOW() - ($1 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
        AND ($2 IS NULL OR id = ANY($2))
      RETURNING id, watch_id, user_id, campground_id, unit_id, unit_name,
                arrival_date::text AS arrival_date, release_at`,
    [String(HOLD_MISS_GRACE_MIN), onlyIds ?? null],
  ).catch((err) => {
    console.error('[expire-holds] sweep failed:', (err as Error).message);
    return [];
  });
}

export async function sweepMissedHolds(): Promise<number> {
  const missed = await failMissedHolds();
  for (const h of missed) {
    console.error(
      `[expire-holds] MISSED: hold ${h.id} (${h.unit_name ?? h.unit_id}) released ${h.release_at} ` +
        `and was never carted — the mini-PC runner was not reachable.`,
    );
    await notifyHoldMissed(h).catch((e) => console.error('[expire-holds] notify failed:', e));
  }
  return missed.length;
}
