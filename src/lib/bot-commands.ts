import { query, mutate } from '@/lib/db/client';

/**
 * Server side of the mini-PC diagnostics channel. See migration 053.
 *
 * THE ALLOWLIST HERE IS THE SECOND ONE, NOT THE ONLY ONE. The authoritative copy lives in
 * `scripts/auto-cart-bot/bot-commands.mjs` on the box, which implements each kind itself
 * and refuses anything it does not recognise. This copy exists so a typo is rejected at
 * the point of asking rather than 15 seconds later, and so the admin UI can list what is
 * possible. `worker/bot-commands.test.mts` pins the two together.
 */
export const BOT_COMMAND_KINDS = {
  'tail-log': {
    label: 'Read a log',
    /** `<name>` or `<name>:<lines>`. Names only — a path parameter is a traversal. */
    argPattern: /^(rc-holds|rc-keepwarm|bot|broker|auto-update|update-spawn|restarts)(:\d{1,3})?$/,
    // DATA, not prose. The first version had the UI parse the option list back out of a
    // human-readable hint, which reads fine and breaks silently the first time somebody
    // rewords the sentence. `worker/bot-commands.test.mts` pins these against the box's own
    // LOGS table, so a log added there and forgotten here fails the build.
    argOptions: ['rc-holds', 'rc-keepwarm', 'bot', 'broker', 'auto-update', 'update-spawn', 'restarts'] as const,
    argHint: 'a log name, optionally :lines',
  },
  'list-processes': { label: 'Which of our processes are running', argPattern: null, argOptions: null, argHint: '' },
  /**
   * RAM, COMMIT and the browsers `list-processes` cannot see. Added 2026-08-12 after
   * supervise.ps1 failed to start a shell at all with "the paging file is too small" — a
   * supervisor that cannot launch cannot restart anything, and `disk-free` answered 404 GB
   * the same night, which made it look like anything but a memory problem.
   */
  'memory': { label: 'Memory, commit and the browsers we are running', argPattern: null, argOptions: null, argHint: '' },
  'git-status': { label: 'What commit is the box on', argPattern: null, argOptions: null, argHint: '' },
  'disk-free': { label: 'Free disk space', argPattern: null, argOptions: null, argHint: '' },
  /**
   * THE FIRST COMMAND THAT IS NOT READ-ONLY, and it is here because of 2026-08-11: the RC
   * hold runner died at 09:36 PT, the keep-warm came back by itself and the runner did not,
   * and there was no way to restart it without a person at the keyboard. Everything else in
   * this table could tell you that; none of it could fix it.
   *
   * It restarts ONLY the two RC processes — never the rec.gov bot, which is usually the
   * process running this command, and never the whole box.
   *
   * THE BLAST RADIUS IF THE TOKEN LEAKS is a denial of service: repeated restarts drop the
   * RC access token, and enough of them near a release could cost a hold. Two guards, split
   * so neither depends on the other being honest — the server refuses to QUEUE one near a
   * release (it is the side that knows when holds are due), and the box refuses to RUN one
   * more often than RESTART_MIN_GAP_MS (it is the side that must hold even if the server is
   * lying). The box's guard is the load-bearing one, exactly as this file's header says.
   */
  'restart-rc': {
    label: 'Restart the RC keep-warm + hold runner',
    argPattern: null, argOptions: null, argHint: '',
  },
} as const;

/**
 * Never restart the RC processes within this many minutes of a release.
 *
 * A restart drops the access token — the token IS the session — and `maybeAutoLogin` needs
 * `RC_AUTOLOGIN_LEAD_MIN` (30) plus room to fail and wake a human. Ninety minutes leaves
 * the repair a full lead time and still a margin. Same reasoning as the update guard's
 * release check, and equally not liftable: the point of restarting the runner is to save a
 * hold, so doing it in a way that loses one is self-defeating.
 */
export const RESTART_RC_BLACKOUT_MIN = 90;

export type BotCommandKind = keyof typeof BOT_COMMAND_KINDS;

/**
 * How long a queued command stays worth running.
 *
 * A diagnostic answers a question somebody is asking NOW. One that surfaces an hour later —
 * after a restart, say — answers a question about a machine that no longer exists, and
 * would run at a moment nobody chose. Ten minutes is well past the 15-second poll.
 */
export const COMMAND_TTL_MS = 10 * 60_000;

/** Never queue an unbounded backlog; a burst of diagnostics is itself a hazard. */
export const MAX_PENDING = 5;

export interface BotCommand {
  id: number;
  kind: string;
  arg: string | null;
  requested_at: string;
  requested_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  /** Which mini-PC process ran it. See migration 055 — this is a diagnosis, not bookkeeping. */
  claimed_by: string | null;
}

/**
 * Minutes until a zone-less Pacific wall-clock release string, or null.
 *
 * NEVER `new Date(releaseAt)` on one of these: with no zone it is read as the server's
 * local time, and this decision would then be wrong by the offset. Both sides are put into
 * Pacific and compared as UTC so the offset cancels — the same discipline as the hold
 * runner's `msUntilRelease` and the update guard's `hoursUntilRelease`.
 */
function minutesUntilPacific(releaseAt: string | null): number | null {
  if (!releaseAt) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {} as Record<string, string>);
  const hh = p.hour === '24' ? '00' : p.hour;
  const now = Date.parse(`${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}Z`);
  const rel = Date.parse(`${releaseAt.slice(0, 19)}Z`);
  if (!Number.isFinite(now) || !Number.isFinite(rel)) return null;
  return (rel - now) / 60_000;
}

/** Validate a request against the allowlist. Returns null when it is acceptable. */
export function rejectReason(kind: string, arg: string | null): string | null {
  const spec = (BOT_COMMAND_KINDS as Record<string, { argPattern: RegExp | null; argHint: string }>)[kind];
  if (!spec) return `unknown kind '${kind}'`;
  if (!spec.argPattern) return arg ? `${kind} takes no argument` : null;
  if (!arg) return `${kind} needs an argument: ${spec.argHint}`;
  return spec.argPattern.test(arg) ? null : `invalid argument for ${kind}: ${spec.argHint}`;
}

export async function requestBotCommand(
  kind: string, arg: string | null, by: string,
): Promise<{ id: number } | { error: string }> {
  const bad = rejectReason(kind, arg);
  if (bad) return { error: bad };
  // THE RELEASE GUARD, on the side that has the data. The box cannot see the hold table, so
  // "is a cart imminent?" has to be answered here; the box answers the question it CAN
  // answer on its own (how recently it last restarted). Splitting them means neither guard
  // depends on the other side being honest.
  if (kind === 'restart-rc') {
    const { nextHoldRelease } = await import('@/lib/rc-holds');
    const next = await nextHoldRelease().catch(() => null);
    const mins = minutesUntilPacific(next);
    if (mins != null && mins >= 0 && mins < RESTART_RC_BLACKOUT_MIN) {
      return {
        error:
          `a hold releases in ${Math.round(mins)} min — restarting now would drop the RC session ` +
          `with no time to sign back in. Wait until after the release.`,
      };
    }
  }
  const [{ n }] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bot_commands
      WHERE finished_at IS NULL AND requested_at > NOW() - ($1 || ' milliseconds')::interval`,
    [String(COMMAND_TTL_MS)],
  );
  if (n >= MAX_PENDING) return { error: `${n} commands already queued — wait for them to run` };
  // `mutate`, not `query` — see claimBotCommands below. This one had no catch at all, so
  // the admin panel's "Ask" button would have 500'd rather than failing quietly. Neither is
  // acceptable, but only one of them tells you.
  const [row] = await mutate<{ id: number }>(
    `INSERT INTO bot_commands (kind, arg, requested_by) VALUES ($1, $2, $3) RETURNING id`,
    [kind, arg, by.slice(0, 80)],
  );
  return { id: row.id };
}

/**
 * What the box should run on this poll.
 *
 * Stamps `started_at` as it hands them out, so "nobody picked this up" and "it ran and
 * returned nothing" stay distinguishable — the distinction that cost six round-trips on
 * 2026-08-11 and the reason this table exists at all.
 */
export async function claimBotCommands(
  actor = 'unknown',
): Promise<Array<{ id: number; kind: string; arg: string | null }>> {
  // `mutate`, NEVER `query`. THIS IS WHY THE DIAGNOSTICS CHANNEL NEVER WORKED (found
  // 2026-08-11, the first time a box was actually able to answer). `query` routes to the
  // exec_select RPC, which cannot run an UPDATE — so every claim threw, `.catch(() => [])`
  // returned an empty list, and the feed looked exactly as it does when nobody has asked a
  // question. The box was blamed for two hours; the box was never sent anything.
  return await mutate<{ id: number; kind: string; arg: string | null }>(
    // TWO POLLERS NOW, so the claim carries who won. It was already atomic — one
    // `UPDATE .. WHERE started_at IS NULL .. RETURNING` — which is why the rec.gov bot
    // reading the same queue needs no locking: whichever process is alive answers, and
    // exactly one of them does.
    //
    // `claimed_by` is not bookkeeping. A `list-processes` reply that came back from
    // `bot.mjs` proves the RC runner is not answering, in the same breath as the answer.
    `UPDATE bot_commands SET started_at = NOW(), claimed_by = $3
      WHERE id IN (
        SELECT id FROM bot_commands
         WHERE finished_at IS NULL AND started_at IS NULL
           AND requested_at > NOW() - ($1 || ' milliseconds')::interval
         ORDER BY requested_at LIMIT $2
      )
      RETURNING id, kind, arg`,
    [String(COMMAND_TTL_MS), String(MAX_PENDING), actor.slice(0, 40)],
  ).catch((e) => {
    // An empty queue and a broken claim must not look the same on the way out.
    console.error('[bot-commands] claimBotCommands failed:', (e as Error).message);
    return [];
  });
}

/** The box reporting an answer. Output is already scrubbed and capped on its side. */
export async function recordBotCommandResult(
  id: number, exitCode: number, output: string | null, error: string | null,
): Promise<void> {
  await mutate(
    `UPDATE bot_commands
        SET finished_at = NOW(), exit_code = $2, output = $3, error = $4
      WHERE id = $1 AND finished_at IS NULL`,
    [String(id), String(exitCode), output ? output.slice(0, 20_000) : null, error ? error.slice(0, 500) : null],
  ).catch((e) => console.error('[bot-commands] record failed:', e.message));
}

export async function recentBotCommands(limit = 10): Promise<BotCommand[]> {
  return await query<BotCommand>(
    `SELECT id, kind, arg, requested_at::text, requested_by, started_at::text, finished_at::text,
            exit_code, output, error, claimed_by
       FROM bot_commands ORDER BY id DESC LIMIT $1`,
    [String(Math.min(50, limit))],
  ).catch(() => []);
}
