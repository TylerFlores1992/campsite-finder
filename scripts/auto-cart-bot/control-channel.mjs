/**
 * Act on the `control` block both bot feeds now serve.
 *
 * ── WHY THIS IS A SHARED MODULE ────────────────────────────────────────────────────────
 * On 2026-08-11 the RC hold runner died at 09:36 PT. It was the only process reading the
 * update flag and the diagnostics queue, so the whole box went dark: no update, no
 * diagnostics, no way to ask it a single question — while `bot.mjs` polled the roster feed
 * every two seconds throughout, healthy and reachable the entire time.
 *
 * Both processes read the channel now. Two copies of this logic would be two chances to fix
 * one and forget the other, and the copy that gets forgotten is by definition the one
 * running when the other is dead — which is the only time this code matters.
 *
 * The feed's `updateRequested` is INFORMATIONAL. A process that means to spawn the updater
 * claims it first with a POST and is told yes or no — reading a feed is not intending to act
 * on it, and only the caller knows which it is doing. An earlier version granted the update
 * on read, which the rec.gov bot's two-second poll consumed and binned on any box too old to
 * understand the control block.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runCommand } from './bot-commands.mjs';

/**
 * Only one hand-off per process life, per this window.
 *
 * `auto-update.ps1` exits 0 when its own guard refuses (too close to a release, outside the
 * quiet window), and the flag stays pending until the update actually lands — so without
 * this the box would re-spawn the updater on every poll, which for the rec.gov bot is every
 * two seconds.
 */
export const UPDATE_RETRY_MS = 15 * 60_000;

/**
 * @param {{ dir: string, actor: string, log: (s: string) => void,
 *           report: (body: object) => Promise<unknown> }} opts
 */
export function makeControlChannel({ dir, actor, log, report }) {
  let updateStartedAt = 0;

  /** @param {{commands?: Array<{id:number,kind:string,arg:string|null}>, updateRequested?: boolean}} control */
  function handleControl(control) {
    const { commands = [], updateRequested = false } = control ?? {};

    // DIAGNOSTICS NEVER BLOCK THE CALLER. Not awaited, on purpose: a question about a log
    // file must not be able to delay a cart at 08:00:00, and on the rec.gov bot it must not
    // delay a poll. `runCommand` never throws and looks the kind up in this box's OWN table
    // — the server can name a kind, it cannot send one.
    for (const c of commands) {
      void (async () => {
        log(`? diagnostic ${c.kind}${c.arg ? ` ${c.arg}` : ''} (#${c.id})`);
        const r = await runCommand(c.kind, c.arg);
        try {
          await report({ commandId: c.id, exitCode: r.ok ? 0 : 1, output: r.output, error: r.error });
        } catch (e) {
          // ALWAYS CLOSE THE ROW. A report that fails leaves `finished_at` NULL for ever,
          // which reads on the admin page as "the box picked it up, no answer yet" - the
          // same silence as a wedged command, and indistinguishable from it. Observed
          // 2026-08-11: `tail-log` was claimed twice and never returned, because the log was
          // BOM-less UTF-16 and decoded to NULs that Postgres cannot store. The answer was
          // unwritable, so nothing was written, so the failure looked like a hang.
          //
          // Retrying WITHOUT the output is the point: the payload is the only part that can
          // be unstorable, and an error line that arrives beats a result that never does.
          log(`  could not return diagnostic #${c.id}: ${e.message}`);
          await report({
            commandId: c.id, exitCode: 1, output: null,
            error: `the answer could not be stored: ${String(e.message).slice(0, 200)}`,
          }).catch((e2) => log(`  and the fallback report failed too: ${e2.message}`));
        }
      })();
    }

    if (!updateRequested || Date.now() - updateStartedAt <= UPDATE_RETRY_MS) return;
    updateStartedAt = Date.now();
    /**
     * WE NO LONGER CLAIM, AND THAT IS HALF THE FIX.
     *
     * This used to claim and then spawn `auto-update.ps1` with `-Claimed`. Both halves of
     * that were wrong once the updater started dying (see `triggerUpdater`): the claim was
     * taken by a process the update itself was about to kill, so it sat held by nobody for
     * its full 20-minute TTL — and the Windows Scheduled Task, the one path that survives a
     * stop-all, spent that whole window refusing itself with
     *
     *     [update-guard] SKIP - another process holds the update claim (or we could not ask)
     *
     * Measured on 2026-08-20 at 09:21, 09:26, 09:31, 09:41, 09:46 and 09:51: six refusals
     * against a dead claim holder, across two attempts. So the claim did not merely fail to
     * help, it BLOCKED the mechanism that would have worked.
     *
     * The task claims for itself (`update-guard.mjs` claims when `requested && !preClaimed`),
     * which is the same protection one layer down, held by the process actually doing the
     * work. Nothing here needs to hold anything: triggering a task twice is a no-op the
     * scheduler collapses, and the guard's own claim closes the two-updaters race that this
     * claim was added for.
     */
    triggerUpdater();
  }

  /**
   * ASK WINDOWS TO RUN THE UPDATER. Do NOT spawn it ourselves.
   *
   * ## What this replaces, and why the old reasoning was wrong
   *
   * This used to `spawn('powershell', [..., '-File', script, '-Claimed'])`, under a comment
   * arguing the child was safe because "killing a parent on Windows does NOT kill its
   * children, and stop-all.ps1 matches on the bot's own scripts, which auto-update.ps1 is
   * not". Both clauses are individually true and the conclusion is false.
   *
   * The second clause still holds: `$CHILDREN` is
   * `supervise\.ps1|bot\.mjs|broker\.mjs|rc-keepwarm\.mjs|rc-hold-runner\.mjs|npm start|npm run broker|cloudflared`
   * and the updater matches none of it. It is not killed BY NAME.
   *
   * The first clause is the one that fails. It is true of a raw Win32 `TerminateProcess`,
   * and NOT true of a child libuv spawned: on Windows `uv_spawn` puts every non-detached
   * child into the parent's Job Object, so killing the parent kills it. Our ancestry is
   * `cmd.exe (npm start) -> node.exe (bot.mjs) -> powershell.exe (auto-update.ps1)`, and
   * stop-all kills both of the first two.
   *
   * MEASURED TWICE ON 2026-08-20, and the logs are identical in shape:
   *
   *     09:16:36 [auto-update] updating b9a1dba -> 940acf7
   *     09:16:37 [stop-all] stopping 26 process(es).
   *     09:16:40 [stop-all]   stopping node.exe pid 10732 (payload)   <- last line ever
   *
   *     09:36:37 [auto-update] updating b9a1dba -> 940acf7
   *     09:36:37 [stop-all] stopping 24 process(es).
   *     09:36:38 [stop-all]   stopping node.exe pid 11924 (payload)   <- last line ever
   *
   * Fourteen of twenty-six stop lines, then sixteen of twenty-four, and in both cases the
   * last thing written is a `node.exe` kill — the updater dying with its parent, midway
   * through the stop it was performing. No git reset, no restart, no rollback, no refusal.
   * The watchdog then found nothing running and restarted everything on the OLD checkout,
   * which is why every health check read green over a box that would not update.
   *
   * ## Why a Scheduled Task rather than `detached: true`
   *
   * `detached` is the textbook answer and it is NOT taken here, because it was tried on
   * 2026-08-11 and produced literally nothing: no output, no error, no auto-update.log,
   * while the same command by hand ran fine. On Windows it means DETACHED_PROCESS — the
   * child gets no console — and whatever went wrong then is unexplained, so reaching for it
   * again would be swapping a measured failure for an unmeasured one.
   *
   * The task is not a new mechanism. It is REGISTERED AND FIRING every five minutes
   * (`install-autoupdate.bat`), it is how every unattended update has ever landed, and
   * `autocart.watchdog` reports it healthy. A process the Task Scheduler service starts is
   * not our descendant and is in no job object of ours, so it survives the stop-all it
   * performs — by construction, rather than by an argument about process trees.
   *
   * ## A failed trigger is not a failed update
   *
   * If `schtasks` cannot run, the task's own five-minute tick still picks the request up:
   * the flag stays pending, and the guard proceeds on the next fire. So the worst case is
   * "Update now" taking five minutes instead of one — which is the behaviour this whole
   * lever was built to improve, not a new outage. There is deliberately NO fallback to the
   * old spawn: that path is the bug.
   */
  const UPDATE_TASK = 'CampHawk auto-update';

  function triggerUpdater() {
    const spawnLog = path.join(dir, 'logs', 'update-spawn.log');
    const note = (line) => {
      log(`  ${line}`);
      try { fs.appendFileSync(spawnLog, `${line}\n`); } catch { /* best effort */ }
    };
    log(`→ update requested — asking Windows to run the "${UPDATE_TASK}" task`);
    try {
      fs.mkdirSync(path.dirname(spawnLog), { recursive: true });
      fs.appendFileSync(spawnLog,
        `\n=== ${new Date().toISOString()} ${actor} triggering task "${UPDATE_TASK}"\n`);
    } catch { /* best effort — never block the hand-off on logging it */ }

    try {
      // stdio TO A FILE, NEVER 'ignore'. `schtasks` reports "the system cannot find the file
      // specified" for an unregistered task and "access is denied" for a permissions
      // problem, and those need different fixes; discarded, they are the same silence.
      const out = fs.openSync(spawnLog, 'a');
      const t = spawn('schtasks', ['/Run', '/TN', UPDATE_TASK],
        { stdio: ['ignore', out, out], windowsHide: true });
      // spawn() reports ENOENT via an 'error' EVENT, not by throwing, and an unhandled one
      // takes the whole process down.
      t.on('error', (e) => {
        note(`✗ could not run schtasks: ${e.message} — the 5-minute task will still pick this up`);
        updateStartedAt = 0;
      });
      // THE EXIT CODE IS THE WHOLE REPORT. This process exits in milliseconds — it only asks
      // the scheduler to start the task — so unlike the old spawn there is no ambiguity
      // between "ran and died" and "never ran". Non-zero means the task did not start.
      t.on('exit', (code) => {
        if (code === 0) note(`the task was started — auto-update.log is where it speaks from here`);
        else {
          note(`✗ schtasks exited ${code} — the task did not start; the 5-minute tick still will`);
          updateStartedAt = 0;
        }
      });
      try { fs.closeSync(out); } catch { /* the child owns it now */ }
    } catch (err) {
      note(`update hand-off failed: ${err.message}`);
      updateStartedAt = 0;
    }
  }

  return handleControl;
}
