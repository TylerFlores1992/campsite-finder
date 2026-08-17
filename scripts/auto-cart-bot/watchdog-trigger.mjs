/**
 * Run `mini-pc\watchdog.ps1` from inside `bot.mjs`, as a SECOND trigger.
 *
 * ── WHY (2026-08-17) ───────────────────────────────────────────────────────────────────
 * The RC hold runner hard-crashed at 05:36:31 PT and nothing brought it back for two and a
 * half hours; an 08:00 hold was never carted. The watchdog fires every five minutes for
 * exactly that, and it never spoke — because it was never invoked. `auto-update.log`, a
 * separate Scheduled Task on the same cadence, stops dead at 05:31:03 in the same way, and
 * two independent tasks going silent together is the layer underneath them rather than
 * either task.
 *
 * Meanwhile `bot.mjs` beat every two seconds throughout, answered `list-processes`,
 * `tail-log` and `git-status`, and its supervisors restarted `rc-keepwarm` four times. The
 * box was completely healthy in every way that is driven by a RUNNING PROCESS, and
 * completely dead in every way that is driven by Task Scheduler.
 *
 * ── WHY bot.mjs IS THE RIGHT SECOND TRIGGER ────────────────────────────────────────────
 * It is the most durable process on this box, by observation rather than by argument: it
 * has stayed up through every RC outage there has been — 08-07, 08-11, the 08-14 REPL
 * morning and this one — which is the same evidence that made it the home of the control
 * channel on 2026-08-11.
 *
 * IT IS NOT A REPLACEMENT FOR THE SCHEDULED TASK, and must not become one. Windows runs the
 * task, not our code, so it is the only thing that can recover a box where every poller is
 * dead — the structural argument in `watchdog.ps1`'s own header, which still stands. This
 * covers the opposite failure: the tasks stop while the processes live. Neither trigger
 * covers both, and that is precisely why there are two.
 *
 * ── WHAT KEEPS TWO TRIGGERS FROM DOUBLING UP ───────────────────────────────────────────
 * Nothing here. `watchdog.ps1` rate-limits ITSELF with a timestamp file, so it is safe under
 * any number of triggers and neither trigger has to know the other exists. Putting the guard
 * in the caller would mean two copies of it, and the forgotten copy is by definition the one
 * running when the other is dead — the lesson `control-channel.mjs` was extracted for.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Same cadence as the Scheduled Task. The script's own gate collapses the two down to about
 * one real run per gap, so this is a cheap belt to the task's braces rather than a doubling
 * of the work.
 */
export const WATCHDOG_TRIGGER_MS = Number(process.env.WATCHDOG_TRIGGER_MS ?? 5 * 60 * 1000);

/**
 * Fire the watchdog. Resolves to what happened, and NEVER throws or rejects.
 *
 * `bot.mjs`'s job is carting rec.gov sites; this is a favour it does for its siblings, and a
 * favour that can take down the rec.gov bot is not worth having. Every failure is a logged
 * line and nothing more.
 *
 * WINDOWS ONLY, and it says so rather than failing obscurely. The repo is developed on Linux
 * and `npm test` runs there, so a bare spawn of `powershell` would be an ENOENT on every
 * machine that is not the mini-PC.
 */
export function makeWatchdogTrigger({ dir, log, platform = process.platform, run = execFile }) {
  // `dir` is scripts/auto-cart-bot; the script lives in its mini-pc subdirectory.
  const script = path.join(dir, 'mini-pc', 'watchdog.ps1');
  let inFlight = false;

  return async function triggerWatchdog() {
    if (platform !== 'win32') return { ran: false, why: 'not windows' };
    // A single in-process guard, because a run that outlives the interval would otherwise
    // stack. The script's own gate is the real protection; this just avoids spawning a
    // PowerShell that is only going to exit immediately.
    if (inFlight) return { ran: false, why: 'still running' };
    inFlight = true;
    try {
      const out = await new Promise((resolve) => {
        run(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
          { timeout: 120_000, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`.trim() || (err ? String(err.message) : '')),
        );
      });
      // ONLY SPEAK WHEN THE WATCHDOG DID. It is silent on the healthy path and on a
      // rate-limited skip, which is most of the time; echoing an empty string every five
      // minutes would bury the bot log under nothing.
      if (out) log(`[watchdog] ${out.split('\n').slice(-6).join(' | ')}`);
      return { ran: true, out };
    } catch (err) {
      log(`[watchdog] could not run: ${err.message}`);
      return { ran: false, why: err.message };
    } finally {
      inFlight = false;
    }
  };
}
