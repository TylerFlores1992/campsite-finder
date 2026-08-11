import { botUpdateState } from '@/lib/bot-update';
import { claimBotCommands } from '@/lib/bot-commands';

/**
 * What the mini-PC should do on this poll — served on BOTH bot feeds.
 *
 * ── WHY IT IS ON BOTH (2026-08-11) ─────────────────────────────────────────────────────
 * The update flag and the diagnostics queue were read only by `rc-hold-runner.mjs`. That
 * process died at 09:36 PT and took every remote lever with it: no update, no diagnostics,
 * no way to ask the box a single question — while `bot.mjs` went on polling the roster feed
 * every two seconds the whole time, healthy and reachable.
 *
 * So "the box is unreachable" and "the RC runner is down" were the same event. They are
 * different problems with different fixes, and the second one is the one you most want a
 * remote lever for, because it is the process that carts campsites.
 *
 * The channel now rides whichever feed is being polled. The box stays reachable as long as
 * ANY of its processes is alive, which is the property that was missing.
 *
 * ── THE FLAG IS INFORMATIONAL; THE CLAIM IS A SEPARATE POST ────────────────────────────
 * `updateRequested: true` only means "an update is wanted". A poller that intends to spawn
 * `auto-update.ps1` must first POST `{updateClaim: <actor>}` and be told `granted: true` —
 * exactly one caller ever is.
 *
 * THE FIRST VERSION GRANTED IT ON READ, AND THAT WAS WRONG IN THE ONE CASE IT HAD TO WORK.
 * The roster feed is polled every TWO SECONDS by the rec.gov bot, and a box running code
 * older than this change ignores `control` entirely — so the grant was consumed instantly by
 * the one process that could not act on it, and the Windows scheduled task (the only thing
 * that CAN update a stale box) would read `false` until the claim expired. A lever that
 * silently disarms itself on precisely the boxes that need it.
 *
 * Granting on read cannot be right in general: reading a feed is not the same as intending
 * to act on it, and only the actor knows which it is doing. Claiming at the point of USE is
 * the same rule as the auto-cart entitlement being checked where it would be spent, and as
 * `claimNotification` being called on the cycle that acts.
 *
 * The commands queue needed no such change: it is already claimed at the point of use — the
 * poller that receives a command is the one that runs it, in the same tick.
 *
 * Both sides swallow their failures. These feeds exist to cart campsites; a diagnostics
 * table that cannot be read must never take the roster or the hold feed down with it.
 */
export interface BotControl {
  updateRequested: boolean;
  commands: Array<{ id: number; kind: string; arg: string | null }>;
}

export async function botControlFor(actor: string): Promise<BotControl> {
  const [update, commands] = await Promise.all([
    botUpdateState().catch(() => ({ pending: false })),
    claimBotCommands(actor).catch(() => []),
  ]);
  return { updateRequested: update.pending === true, commands };
}
