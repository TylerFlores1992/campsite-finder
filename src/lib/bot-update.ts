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
    `UPDATE bot_update_requests SET requested_at = NOW(), requested_by = $1 WHERE id = 1`,
    [by.slice(0, 80)],
  );
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
