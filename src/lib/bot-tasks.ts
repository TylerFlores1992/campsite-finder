import { query, mutate } from '@/lib/db/client';

/**
 * Liveness for the mini-PC's Windows Scheduled Tasks. See migration 060.
 *
 * The watchdog is the supervisor of last resort — it is what brings the box back when every
 * poller on it is dead. On 2026-08-17 it stopped firing and there was no way to know: a
 * watchdog that never runs and a box that never needs it write the same thing to
 * `restarts.log`, which is nothing at all.
 */

/**
 * The tasks we expect to hear from.
 *
 * AN UNKNOWN NAME IS REFUSED rather than stored. The endpoint is authorised by
 * `AUTOCART_TOKEN`, which the box holds in a git-ignored `.env` on a machine that is
 * routinely screen-shared, so this is a cheap bound on what a stray caller can write into a
 * table the admin page reads. It also means a typo in a `.ps1` fails loudly at the server
 * instead of quietly creating a second row that nothing ever checks — which is precisely how
 * a health check ends up green over a task that has not run since the day it was renamed.
 */
export const BOT_TASKS = ['watchdog', 'auto-update'] as const;
export type BotTask = (typeof BOT_TASKS)[number];

export function isBotTask(name: string): name is BotTask {
  return (BOT_TASKS as readonly string[]).includes(name);
}

/**
 * Record that a task fired. Called as the task's FIRST act, before any work that can throw.
 *
 * The note is truncated rather than rejected: this must never be the reason a beat is lost.
 * A beat is the whole point and the note is a nicety.
 */
export async function recordTaskBeat(task: BotTask, note: string | null): Promise<void> {
  await mutate(
    `INSERT INTO bot_task_heartbeat (task, beat_at, note)
          VALUES ($1, NOW(), $2)
     ON CONFLICT (task) DO UPDATE SET beat_at = NOW(), note = EXCLUDED.note`,
    [task, note ? note.slice(0, 500) : null],
  );
}

export interface TaskBeat {
  task: string;
  beat_at: string;
  note: string | null;
  age_ms: number;
}

/**
 * Every task's last firing, oldest first, so a reader meets the worst one first.
 *
 * A task that has NEVER reported is absent from this list rather than present with a null
 * age, and the caller has to decide what that means. That is deliberate: on a box that has
 * not been updated yet, "never reported" means the `.ps1` change has not landed — which is
 * a different fact from "the task has stopped", and reporting the second when it is the
 * first is the cry-wolf failure this file's neighbours have already paid for three times.
 */
export async function taskBeats(): Promise<TaskBeat[]> {
  const rows = await query<{ task: string; beat_at: string; note: string | null }>(
    `SELECT task, beat_at::text AS beat_at, note FROM bot_task_heartbeat`,
  ).catch(() => []);
  const now = Date.now();
  return rows
    .map((r) => ({ ...r, age_ms: now - new Date(r.beat_at).getTime() }))
    .sort((a, b) => b.age_ms - a.age_ms);
}
