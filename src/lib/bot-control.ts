import { claimBotUpdate } from '@/lib/bot-update';
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
 * ── THE FLAG IS THE CLAIM ──────────────────────────────────────────────────────────────
 * `updateRequested: true` is not a question, it is a grant, and exactly one caller gets it.
 * Two processes spawning `auto-update.ps1` would move one git checkout out from under each
 * other — worse than a slow update, which is the rule that already governed this before
 * there were two readers. The commands queue needed no such change: its claim was already
 * one atomic `UPDATE .. WHERE started_at IS NULL .. RETURNING`.
 *
 * Both sides swallow their failures. These feeds exist to cart campsites; a diagnostics
 * table that cannot be read must never take the roster or the hold feed down with it.
 */
export interface BotControl {
  updateRequested: boolean;
  commands: Array<{ id: number; kind: string; arg: string | null }>;
}

export async function botControlFor(actor: string): Promise<BotControl> {
  const [updateRequested, commands] = await Promise.all([
    claimBotUpdate(actor).catch(() => false),
    claimBotCommands(actor).catch(() => []),
  ]);
  return { updateRequested, commands };
}
