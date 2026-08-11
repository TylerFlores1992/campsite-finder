import { query, mutate } from '@/lib/db/client';

/**
 * On-demand updates for the mini-PC.
 *
 * The box polls `GET /api/auto-cart/rc-holds` every 15 seconds; this rides that. Nothing
 * connects INTO the machine — see migration 051 for why that matters on the host holding
 * the RC session.
 *
 * `pending` means requested and not yet applied. It is derived from the two timestamps
 * rather than stored as a boolean, so a half-finished update cannot leave a flag claiming
 * one state while the timestamps say another.
 */
export interface BotUpdateState {
  pending: boolean;
  requestedAt: string | null;
  requestedBy: string | null;
  appliedAt: string | null;
  appliedSha: string | null;
  appliedNote: string | null;
}

export async function botUpdateState(): Promise<BotUpdateState> {
  const [r] = await query<{
    requested_at: string | null; requested_by: string | null;
    applied_at: string | null; applied_sha: string | null; applied_note: string | null;
  }>(
    `SELECT requested_at::text, requested_by, applied_at::text, applied_sha, applied_note
       FROM bot_update_requests WHERE id = 1`,
  ).catch(() => []);
  const requestedAt = r?.requested_at ?? null;
  const appliedAt = r?.applied_at ?? null;
  return {
    pending: !!requestedAt && (!appliedAt || Date.parse(appliedAt) < Date.parse(requestedAt)),
    requestedAt,
    requestedBy: r?.requested_by ?? null,
    appliedAt,
    appliedSha: r?.applied_sha ?? null,
    appliedNote: r?.applied_note ?? null,
  };
}

/** Ask the box to update on its next check, within ~15s of the poll plus the run itself. */
export async function requestBotUpdate(by: string): Promise<void> {
  await mutate(
    // CLEAR THE CLAIM. A new request must be claimable by whichever process is alive now —
    // leaving a claim from a poller that has since died would make the request permanently
    // unwinnable, which is the failure the TTL below also guards.
    `UPDATE bot_update_requests
        SET requested_at = NOW(), requested_by = $1, claimed_at = NULL, claimed_by = NULL
      WHERE id = 1`,
    [by.slice(0, 80)],
  );
}

/**
 * How long one poller's claim on an update lasts.
 *
 * Long enough that a slow `git fetch` on a bad uplink is not overtaken mid-update; short
 * enough that a process which claimed and then died does not block updates for the rest of
 * the day. The runner's own `UPDATE_RETRY_MS` is 15 minutes for the same reason and this
 * must not be shorter than it, or the two would disagree about when a retry is due.
 */
export const UPDATE_CLAIM_TTL_MS = 20 * 60_000;

/**
 * May THIS process spawn the updater?
 *
 * TWO POLLERS NOW SEE THE SAME FLAG. The control channel moved onto the roster feed so the
 * box stays reachable when the RC runner is dead (2026-08-11) — which means `bot.mjs` and
 * `rc-hold-runner.mjs` can both read `updateRequested` on the same tick, and
 * `auto-update.ps1` moves the git checkout out from under whatever is running. Two updaters
 * racing one checkout is worse than a slow update; that rule predates this change and this
 * is what keeps it true now that there are two readers.
 *
 * One conditional UPDATE decides it — the same shape as the alerting claim and the shard
 * lease, and for the same reason: a read-then-write would let both callers read "unclaimed".
 *
 * NOT A COMPLETE MUTEX, and worth being honest about: the Windows scheduled task launches
 * `auto-update.ps1` through `update-guard.mjs`, which does not pass through here. That path
 * predates this and is unchanged. What this removes is the race THIS change introduces.
 */
export async function claimBotUpdate(actor: string): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE bot_update_requests
        SET claimed_at = NOW(), claimed_by = $1
      WHERE id = 1
        AND requested_at IS NOT NULL
        AND (applied_at IS NULL OR applied_at < requested_at)
        AND (claimed_at IS NULL OR claimed_at < NOW() - ($2 || ' milliseconds')::interval)
      RETURNING id`,
    [actor.slice(0, 40), String(UPDATE_CLAIM_TTL_MS)],
  ).catch(() => []);
  return rows.length > 0;
}

/**
 * The box reporting back.
 *
 * Recorded whether it SUCCEEDED or NOT, and the note says which. An update that fails and
 * silently leaves the request pending would be retried on every poll — a rollback loop,
 * every fifteen seconds, on the machine holding the session. Same reasoning as
 * `maybeAutoLogin` getting one attempt per release.
 */
export async function markBotUpdateApplied(sha: string | null, note: string | null): Promise<void> {
  await mutate(
    `UPDATE bot_update_requests
        SET applied_at = NOW(), applied_sha = $1, applied_note = $2
      WHERE id = 1`,
    [sha ? sha.slice(0, 40) : null, note ? note.slice(0, 300) : null],
  ).catch((e) => console.error('[bot-update] markApplied failed:', e.message));
}

/**
 * What the box's LAST ATTEMPT did, when it did not result in an update.
 *
 * WRITES `applied_note` AND NEVER `applied_at`, so the request stays pending and the box
 * tries again. The distinction is the whole point: `applied_at` means "it landed",
 * `applied_note` means "here is what happened last time somebody tried". Same split as
 * `rc_hold_requests.last_attempt_note`, and for the same reason - on 2026-08-11 an
 * on-demand update sat pending for ten minutes and there was no way to tell "the guard
 * refused, and why" from "nothing has tried at all". Those are different faults with
 * different fixes, and they were the same silence.
 */
export async function noteBotUpdateAttempt(note: string): Promise<void> {
  await mutate(
    `UPDATE bot_update_requests SET applied_note = $1 WHERE id = 1`,
    [note.slice(0, 300)],
  ).catch((e) => console.error('[bot-update] noteAttempt failed:', e.message));
}
