// Opt-in holds for ReserveCalifornia's 8am releases — the state machine, in one place.
//
// Three callers touch these rows and they must not disagree about what a status means:
// the poller (offers), the /w/<token> action (requests), and the bot (carts, releases).
// See migration 043 for the lifecycle and why a row is created at ALERT time.
//
// The rule that matters most: **only `requested` authorises a cart.** An `offered` row is
// a question nobody answered, and carting one would be exactly the speculative
// inventory-grabbing this design exists to avoid.

import { query, mutate } from '@/lib/db/client';

export type HoldStatus =
  | 'offered' | 'requested' | 'carted' | 'claiming' | 'released' | 'claimed' | 'expired' | 'failed';

export interface HoldRequest {
  id: string;
  watch_id: string;
  user_id: string;
  campground_id: string;
  unit_id: string;
  unit_name: string | null;
  arrival_date: string;
  nights: number;
  release_at: string;
  status: HoldStatus;
  claim_started_at: string | null;
  cart_key: string | null;
  cart_entry_key: string | null;
}

/**
 * Record that we told someone about an upcoming release.
 *
 * Idempotent per (watch, unit, arrival): a re-alert for the same opening updates the row
 * rather than stacking duplicates. It deliberately does NOT reset a status that has moved
 * on — if the user already tapped, a later alert must not walk them back to `offered` and
 * silently discard their answer.
 */
export async function offerHold(input: {
  watchId: string;
  userId: string;
  campgroundId: string;
  unitId: string;
  unitName: string | null;
  arrivalDate: string;
  nights: number;
  releaseAt: string;
}): Promise<string | null> {
  try {
    const rows = await mutate<{ id: string }>(
      `INSERT INTO rc_hold_requests
         (watch_id, user_id, campground_id, unit_id, unit_name, arrival_date, nights, release_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (watch_id, unit_id, arrival_date) DO UPDATE
         SET release_at = EXCLUDED.release_at,
             unit_name  = COALESCE(EXCLUDED.unit_name, rc_hold_requests.unit_name),
             nights     = EXCLUDED.nights,
             updated_at = NOW()
         WHERE rc_hold_requests.status = 'offered'
       RETURNING id`,
      [
        input.watchId, input.userId, input.campgroundId, input.unitId,
        input.unitName, input.arrivalDate, String(input.nights), input.releaseAt,
      ],
    );
    // No row back means the conflict target existed with a status past `offered` — the
    // user has already answered. That is a success, not a failure.
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('[rc-holds] offerHold failed:', (err as Error).message);
    return null;
  }
}

/**
 * The user tapped "hold it for me".
 *
 * Matches the newest un-answered offer for this (watch, unit) whose release is still in
 * the future — a tap on last week's email must not queue a cart for an opening that has
 * been and gone. Returns the row so the confirmation page can name the site and time.
 */
export async function requestHold(watchId: string, unitId: string): Promise<HoldRequest | null> {
  try {
    const rows = await mutate<HoldRequest>(
      `UPDATE rc_hold_requests
          SET status = 'requested', requested_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT id FROM rc_hold_requests
           WHERE watch_id = $1 AND unit_id = $2
             AND status IN ('offered', 'requested')
             AND release_at > to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
           ORDER BY release_at ASC LIMIT 1
        )
        RETURNING *`,
      [watchId, unitId],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error('[rc-holds] requestHold failed:', (err as Error).message);
    return null;
  }
}

/**
 * What the bot should cart right now.
 *
 * `release_at` is RC's own wall-clock string with no zone, so it is compared against
 * Pacific wall-clock rather than parsed into a Date — the same reasoning as
 * `formatStayDates`: turning "2026-08-08T08:00:00" into a Date and back shifts the hour
 * for anyone not on Pacific, and the bot runs wherever it runs.
 *
 * The window opens slightly BEFORE the release so the bot is already asking when the site
 * frees, rather than starting to think about it a second late.
 */
export async function dueHolds(leadSeconds = 60, graceMinutes = 20): Promise<HoldRequest[]> {
  try {
    return await query<HoldRequest>(
      `SELECT * FROM rc_hold_requests
        WHERE status = 'requested'
          AND release_at <= to_char((NOW() + ($1 || ' seconds')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
          AND release_at >= to_char((NOW() - ($2 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
        ORDER BY release_at ASC
        LIMIT 25`,
      [String(leadSeconds), String(graceMinutes)],
    );
  } catch (err) {
    console.error('[rc-holds] dueHolds failed:', (err as Error).message);
    return [];
  }
}

/**
 * The user pressed claim. Ask the bot to let go of THIS entry.
 *
 * Only a `carted` hold can be claimed — there is nothing to hand over otherwise — and
 * re-pressing while already `claiming` or `released` is a no-op rather than an error,
 * because a double-tap on a phone is normal and must not look like a failure.
 */
export async function startClaim(id: string): Promise<HoldRequest | null> {
  try {
    const rows = await mutate<HoldRequest>(
      `UPDATE rc_hold_requests
          SET status = 'claiming', claim_started_at = COALESCE(claim_started_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND status IN ('carted', 'claiming')
        RETURNING *`,
      [id],
    );
    if (rows[0]) return rows[0];
    // Already released, or never carted. Hand the row back so the caller can tell the
    // user WHICH — "already let go, go book it" and "nothing is held" are different.
    const [existing] = await query<HoldRequest>(`SELECT * FROM rc_hold_requests WHERE id = $1`, [id]);
    return existing ?? null;
  } catch (err) {
    console.error('[rc-holds] startClaim failed:', (err as Error).message);
    return null;
  }
}

/** The bot has let go. The exposure window starts HERE. */
export async function markReleased(id: string): Promise<void> {
  await mutate(
    `UPDATE rc_hold_requests SET status = 'released', released_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('claiming','carted')`,
    [id],
  ).catch((e) => console.error('[rc-holds] markReleased failed:', e.message));
}

/** Claims waiting on the bot. Separate from the stale-release sweep because these are
 *  URGENT — somebody is watching a spinner — while a stale release is merely overdue. */
export async function pendingClaims(): Promise<HoldRequest[]> {
  return query<HoldRequest>(
    `SELECT * FROM rc_hold_requests WHERE status = 'claiming' ORDER BY claim_started_at ASC LIMIT 25`,
  ).catch(() => []);
}

/** One row, for the claim page to poll. */
export async function getHold(id: string): Promise<HoldRequest | null> {
  const [row] = await query<HoldRequest>(`SELECT * FROM rc_hold_requests WHERE id = $1`, [id]).catch(() => []);
  return row ?? null;
}

/** The bot got it. Record HOW TO LET GO as well as that we hold it — without the entry
 *  key we could only empty the whole cart, taking every other user's hold with it.
 *
 *  Returns whether this call is the one that flipped it, so the caller can send the
 *  "it's held, come and get it" alert EXACTLY once. Re-running the runner over a hold it
 *  already carted must not text the user again. */
export async function markCarted(id: string, cartKey: string, cartEntryKey: string | null): Promise<boolean> {
  const rows = await mutate<{ id: string }>(
    `UPDATE rc_hold_requests SET status = 'carted', carted_at = NOW(), cart_key = $2,
            cart_entry_key = $3, updated_at = NOW()
      WHERE id = $1 AND status <> 'carted' RETURNING id`,
    [id, cartKey, cartEntryKey],
  ).catch((e) => { console.error('[rc-holds] markCarted failed:', e.message); return []; });
  return rows.length > 0;
}

export async function markClaimed(id: string): Promise<void> {
  await mutate(
    `UPDATE rc_hold_requests SET status = 'claimed', claimed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  ).catch((e) => console.error('[rc-holds] markClaimed failed:', e.message));
}

export async function markFailed(id: string, error: string): Promise<void> {
  await mutate(
    `UPDATE rc_hold_requests SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
    [id, error.slice(0, 500)],
  ).catch((e) => console.error('[rc-holds] markFailed failed:', e.message));
}

/**
 * Close out rows whose moment has passed.
 *
 * An `offered` row nobody answered is simply expired. A `carted` one that was never
 * claimed is the case that matters: **the bot must let go.** Sitting on a hold the user
 * never came for is the inventory-grabbing this design exists to prevent, and the release
 * itself is the bot's job — this only marks which ones it owes.
 */
export async function expireStaleHolds(holdMinutes = 45): Promise<{ expired: number; toRelease: HoldRequest[] }> {
  const nowPacific = `to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`;
  const expired = await mutate<{ id: string }>(
    `UPDATE rc_hold_requests SET status = 'expired', updated_at = NOW()
      WHERE status = 'offered' AND release_at < ${nowPacific} RETURNING id`,
  ).catch(() => []);
  const toRelease = await query<HoldRequest>(
    `SELECT * FROM rc_hold_requests
      WHERE status = 'carted' AND carted_at < NOW() - ($1 || ' minutes')::interval`,
    [String(holdMinutes)],
  ).catch(() => []);
  return { expired: expired.length, toRelease };
}
