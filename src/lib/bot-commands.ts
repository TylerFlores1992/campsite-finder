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
    argHint: 'rc-holds | rc-keepwarm | bot | broker | auto-update | update-spawn | restarts (optionally :lines)',
  },
  'list-processes': { label: 'Which of our processes are running', argPattern: null, argHint: '' },
  'git-status': { label: 'What commit is the box on', argPattern: null, argHint: '' },
  'disk-free': { label: 'Free disk space', argPattern: null, argHint: '' },
} as const;

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
  const [{ n }] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bot_commands
      WHERE finished_at IS NULL AND requested_at > NOW() - ($1 || ' milliseconds')::interval`,
    [String(COMMAND_TTL_MS)],
  );
  if (n >= MAX_PENDING) return { error: `${n} commands already queued — wait for them to run` };
  const [row] = await query<{ id: number }>(
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
export async function claimBotCommands(): Promise<Array<{ id: number; kind: string; arg: string | null }>> {
  return await query<{ id: number; kind: string; arg: string | null }>(
    `UPDATE bot_commands SET started_at = NOW()
      WHERE id IN (
        SELECT id FROM bot_commands
         WHERE finished_at IS NULL AND started_at IS NULL
           AND requested_at > NOW() - ($1 || ' milliseconds')::interval
         ORDER BY requested_at LIMIT $2
      )
      RETURNING id, kind, arg`,
    [String(COMMAND_TTL_MS), String(MAX_PENDING)],
  ).catch(() => []);
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
            exit_code, output, error
       FROM bot_commands ORDER BY id DESC LIMIT $1`,
    [String(Math.min(50, limit))],
  ).catch(() => []);
}
