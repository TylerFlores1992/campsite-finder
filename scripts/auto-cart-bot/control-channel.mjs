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
        await report({ commandId: c.id, exitCode: r.ok ? 0 : 1, output: r.output, error: r.error })
          .catch((e) => log(`  could not return diagnostic #${c.id}: ${e.message}`));
      })();
    }

    if (!updateRequested || Date.now() - updateStartedAt <= UPDATE_RETRY_MS) return;
    updateStartedAt = Date.now();
    // CLAIM BEFORE SPAWNING. Both feeds carry the flag, so two of our processes can see it
    // on the same tick and `auto-update.ps1` moves one git checkout. The server grants it to
    // exactly one caller. A claim that cannot be reached is a NO: an update is not urgent
    // enough to risk two of them, and the flag stays pending for the next poll.
    void (async () => {
      const granted = await report({ updateClaim: actor })
        .then((r) => r?.granted === true)
        .catch(() => false);
      if (!granted) {
        log('→ update requested, but another process has the claim (or we could not ask) — standing down');
        updateStartedAt = 0;
        return;
      }
      spawnUpdater();
    })();
  }

  function spawnUpdater() {
    // AN UPDATE ASKED FOR FROM THE ADMIN PAGE. The box has no inbound path, so the request
    // rides this poll — see migration 051. All this does is hand off to auto-update.ps1,
    // which re-checks the release guard itself: "now" means "as soon as it is safe", because
    // an update ends the RC session and doing that minutes before a cart loses the site.
    //
    // `dir` and never process.cwd(): the two agree when start-all launches us and diverge
    // the moment anything else does, and a wrong -File path makes PowerShell exit
    // immediately with a message we throw away — total silence, no auto-update.log, and this
    // line still claiming the hand-off happened.
    const script = path.join(dir, 'mini-pc', 'auto-update.ps1');
    log(`→ update requested — handing off to ${script}`);
    // SAY IT IS MISSING rather than launching at nothing. Otherwise the failure is
    // indistinguishable from the script running and doing nothing.
    if (!fs.existsSync(script)) {
      log(`  ✗ ${script} does not exist — cannot update`);
      updateStartedAt = 0;
      return;
    }
    try {
      // stdio TO A FILE, NEVER 'ignore'. With output discarded, a PowerShell that starts and
      // dies immediately — a bad -File path, a policy refusal, a parse error — is
      // indistinguishable from one that never started, and that ambiguity is what made
      // 2026-08-11 take all night. The marker is written BEFORE the spawn, so the file
      // exists even if the launch itself is what fails: "no file" can then only mean this
      // code never got here.
      const spawnLog = path.join(dir, 'logs', 'update-spawn.log');
      try {
        fs.mkdirSync(path.dirname(spawnLog), { recursive: true });
        fs.appendFileSync(spawnLog, `\n=== ${new Date().toISOString()} ${actor} launching ${script}\n`);
      } catch { /* best effort — never block the hand-off on logging it */ }
      const out = fs.openSync(spawnLog, 'a');
      const ps = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      // NOT `detached`. On Windows that means DETACHED_PROCESS — the child gets NO console —
      // and a `powershell -File` started that way produced literally nothing on 2026-08-11:
      // no output, no error, no auto-update.log, while the same command by hand ran fine. It
      // was the one constant across every failed attempt.
      //
      // It was never needed. Killing a parent on Windows does NOT kill its children, and
      // stop-all.ps1 matches on the bot's own scripts, which auto-update.ps1 is not — so the
      // updater survives being killed by the update it is performing. `unref()` alone is
      // what lets us exit without waiting for it.
      ], { stdio: ['ignore', out, out], windowsHide: true });
      const note = (line) => {
        log(`  ${line}`);
        try { fs.appendFileSync(spawnLog, `${line}\n`); } catch { /* best effort */ }
      };
      // spawn() reports ENOENT via an 'error' EVENT, not by throwing — so a try/catch never
      // sees it, and an 'error' with no listener takes the whole process down. Two failure
      // modes, both invisible, both fixed by listening.
      ps.on('error', (e) => { note(`✗ could not start powershell: ${e.message}`); updateStartedAt = 0; });
      // The exit STATUS is the missing fact: a child that runs and dies silently and a child
      // that never ran look identical without it.
      ps.on('exit', (code, signal) => {
        note(`auto-update.ps1 exited code=${code} signal=${signal}`);
        if (code !== 0) updateStartedAt = 0;
      });
      ps.unref();
      // The parent's copy is closed straight away; the child keeps its own handles, which is
      // what lets this survive the updater killing us.
      try { fs.closeSync(out); } catch { /* the child owns it now */ }
    } catch (err) {
      log(`  update hand-off failed: ${err.message}`);
      updateStartedAt = 0;
    }
  }

  return handleControl;
}
