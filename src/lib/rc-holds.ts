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
 * "Something tried to act on this hold and could not" — recorded WITHOUT moving status.
 *
 * WHY NOT `failed`. A skipped pass must retry: the profile lock frees, keep-warm renews
 * the session, the next pass works. Marking these failed would close a hold that is still
 * perfectly live, and would fire the missed-hold alert for a hold nothing has given up on.
 *
 * WHY RECORD IT AT ALL. Because the absence of this is what made 2026-08-07 undiagnosable.
 * The row sat at `requested` with `updated_at` frozen at the tap, which is *identical* to
 * "no process ever looked at it" — and the runner heartbeat was green, because the runner
 * was polling the feed fine and failing only when it tried to open Chromium. Status
 * answers "what happened to my hold"; this answers "is anything even trying", and neither
 * can be derived from the other.
 *
 * Deliberately does NOT touch `updated_at`: that column means "the hold changed", and a
 * failed attempt is not a change to the hold. Conflating them would make the readout's
 * "unchanged since the tap" tell — the one signal that exposed the outage — useless.
 */
export async function noteAttempt(ids: string[], note: string): Promise<void> {
  if (!ids.length) return;
  await mutate(
    `UPDATE rc_hold_requests SET last_attempt_at = NOW(), last_attempt_note = $2
      WHERE id = ANY($1::text[])`,
    [ids, note.slice(0, 300)],
  ).catch((e) => console.error('[rc-holds] noteAttempt failed:', e.message));
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

export interface RcSessionHealth {
  ok: boolean | null;
  at: string | null;
  detail: string | null;
  source: string | null;
}

/**
 * Record whether ReserveCalifornia still accepts the bot's session.
 *
 * `rc-keepwarm.mjs` has always known this — it asks RC a question only an authenticated
 * session can answer, every 20 minutes — and has always thrown the answer away into a
 * console on a box nobody watches. It is the earliest possible warning we have, and it
 * was not leaving the mini-PC.
 *
 * The value of getting it here is LEAD TIME. RC serves a reCAPTCHA on sign-in now, so
 * there is no unattended re-login: a dead session needs a human. Learning at 21:00 that
 * tomorrow's 08:00 hold has no session behind it is a fixable evening. Learning at
 * 08:00:10 is a post-mortem.
 */
export async function recordSessionHealth(
  ok: boolean, detail: string | null, source: string,
): Promise<void> {
  await mutate(
    // `session_since` moves ONLY on a change of verdict. `session_at` is "when we last
    // looked", which on a 20-minute loop overwrites the death with every reconfirmation
    // of it — a session that died at 05:30 and was probed at 13:40 would read "dead, 0
    // minutes ago". The difference between an ok-since and the dead-since that follows it
    // IS the session lifetime, which is the number that decides whether "sign in once and
    // never let it lapse" is a viable design at all. See migration 047.
    `UPDATE rc_runner_heartbeat
        SET session_ok = $1, session_at = NOW(), session_detail = $2, session_source = $3,
            session_since = CASE WHEN session_ok IS DISTINCT FROM $1 THEN NOW() ELSE session_since END,
            -- Only on a flip to ALIVE, and never cleared: it has to outlive the death it
            -- will be subtracted from, or the lifetime is unmeasurable at the one moment
            -- we want to know it.
            session_live_since = CASE WHEN $1 AND session_ok IS DISTINCT FROM $1
                                      THEN NOW() ELSE session_live_since END
      WHERE id = 1`,
    [ok, detail ? detail.slice(0, 300) : null, source.slice(0, 40)],
  ).catch((e) => console.error('[rc-holds] recordSessionHealth failed:', e.message));
}

export async function markClaimed(id: string): Promise<void> {
  await mutate(
    `UPDATE rc_hold_requests SET status = 'claimed', claimed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id],
  ).catch((e) => console.error('[rc-holds] markClaimed failed:', e.message));
}

/**
 * The bot tried to cart and RC said no. Is that final, or is it just too early?
 *
 * THE BUG THIS EXISTS TO FIX (2026-08-08). The feed hands the bot a hold **90 seconds
 * before** its release, deliberately — "the bot should be mid-request when the site frees,
 * not starting to think about it a second late". The runner carted immediately, RC
 * correctly answered *"The unit is not available for the date(s) specified"* because the
 * site had not been released yet, and `markFailed` wrote that down as final. `failed` is
 * terminal — `dueHolds` only ever returns `requested` — so **the one and only attempt was
 * guaranteed to happen before the release, and there was never a second one.**
 *
 * Measured on the first hold that got this far: attempt at 07:58:35 PT for an 08:00:00
 * release. The lead time did not help the bot arrive first; it guaranteed the shot was
 * fired before the gun. This flow could not have succeeded no matter how healthy the
 * runner and the session were — and yesterday's dead runner hid it.
 *
 * So a failure while the release window is still open is an ATTEMPT, not an outcome: the
 * status stays `requested`, the hold stays in the feed, and the runner retries on its next
 * ~20s pass. Only once the window has closed does it become `failed`.
 *
 * The window matches `dueHolds`'s grace on purpose. Past it the hold stops being served to
 * the bot anyway, so anything else would leave rows `requested` forever with nothing
 * looking at them — and `worker/expire-holds.ts` (45-minute grace) is the backstop that
 * notifies the user either way.
 */
export async function reportCartFailure(
  id: string, error: string, graceMinutes = 20,
): Promise<{ state: 'retry' | 'failed' | 'already-failed'; hold: HoldRequest | null }> {
  const stillOpen = `release_at >= to_char((NOW() - ($3 || ' minutes')::interval) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')`;
  const rows = await mutate<HoldRequest & { status: HoldStatus }>(
    `UPDATE rc_hold_requests
        SET last_attempt_at = NOW(), last_attempt_note = $2,
            status     = CASE WHEN ${stillOpen} THEN status     ELSE 'failed' END,
            error      = CASE WHEN ${stillOpen} THEN error      ELSE $2 END,
            -- updated_at means "the hold changed". A retryable attempt is not a change,
            -- and moving it would destroy the unchanged-since-the-tap tell (migration 046).
            updated_at = CASE WHEN ${stillOpen} THEN updated_at ELSE NOW() END
      -- The status guard makes this report the TRANSITION, so the caller can tell the
      -- user exactly once. Without it, any repeat report would send a second "we couldn't
      -- hold it" — the same lesson as markCarted and migration 039.
      WHERE id = $1 AND status <> 'failed'
      RETURNING *`,
    [id, error.slice(0, 500), String(graceMinutes)],
  ).catch((e) => { console.error('[rc-holds] reportCartFailure failed:', e.message); return []; });
  if (!rows[0]) return { state: 'already-failed', hold: null };
  return { state: rows[0].status === 'failed' ? 'failed' : 'retry', hold: rows[0] };
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
