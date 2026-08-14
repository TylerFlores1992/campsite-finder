/**
 * The unattended-update guard.
 *
 * WHAT IT IS PROTECTING. An update force-kills every node process, which closes the
 * Chromium the RC access token lives in — measured 2026-08-10, a sign-in at 16:15:06Z was
 * reported gone at 16:23:08Z straight after one. So an automatic update is a way to
 * destroy the session, and a SCHEDULED automatic update is a way to destroy it at the
 * same time every day. These tests are the difference between self-healing and
 * self-harming.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeToUpdate, hoursUntilRelease, pacificHour, DEFAULTS } from '../scripts/auto-cart-bot/update-guard.mjs';

/** A Date at a given Pacific wall-clock time. August = PDT = UTC-7. */
const pt = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 12, h + 7, m));

test('updates only inside the quiet window', () => {
  assert.equal(safeToUpdate({ now: pt(3) }).ok, true, '03:00 PT is inside');
  assert.equal(safeToUpdate({ now: pt(1, 59) }).ok, false, 'just before the window');
  assert.equal(safeToUpdate({ now: pt(5) }).ok, false, 'the end hour is exclusive');
  assert.equal(safeToUpdate({ now: pt(7, 30) }).ok, false, 'half an hour before a release is the worst moment');
  assert.equal(safeToUpdate({ now: pt(14) }).ok, false, 'the middle of the afternoon is not a quiet window');
});

test('a due hold beats the quiet window', () => {
  // THE WINDOW ALONE IS NOT ENOUGH. RC releases at 08:00 Pacific, so a hold requested
  // overnight is inside the window and only hours from being carted — and an update takes
  // the session down with it.
  const v = safeToUpdate({ now: pt(3), nextRelease: '2026-08-12T08:00:00' });
  assert.equal(v.ok, false, '5h before a release must refuse');
  assert.match(v.reason, /releases in 5\.0h/);

  assert.equal(
    safeToUpdate({ now: pt(2), nextRelease: '2026-08-13T08:00:00' }).ok, true,
    'a release 30h out is no reason to skip',
  );
});

test('it refuses when it cannot find out', () => {
  // A feed that will not answer means we do not know whether a hold is due. Skipping an
  // update costs a day of staleness; updating blind can cost a campsite, and the loss is
  // invisible until 08:00. Same rule as `hasAvailabilityInRange` returning null.
  const v = safeToUpdate({ now: pt(3), feedReachable: false });
  assert.equal(v.ok, false);
  assert.match(v.reason, /refusing to update blind/);
});

test('a hold already in the past does not block forever', () => {
  // `nextRelease` can lag — a failed hold whose release has passed must not wedge updates
  // off permanently, which would silently freeze the box on an old build.
  assert.equal(safeToUpdate({ now: pt(3), nextRelease: '2026-08-11T08:00:00' }).ok, true);
});

test('release times are read as Pacific, never as the machine clock', () => {
  // `release_at` is a zone-less Pacific wall-clock string. `new Date(releaseAt)` reads it
  // in the machine's own zone, so on any box not set to Pacific this decision would be
  // wrong by the offset — the trap that made an alert say "Sep 3" for a Sep 4 stay.
  const h = hoursUntilRelease('2026-08-12T08:00:00', pt(3));
  assert.ok(Math.abs(h! - 5) < 0.01, `expected ~5h, got ${h}`);
  assert.equal(hoursUntilRelease(null, pt(3)), null);
  assert.equal(hoursUntilRelease('nonsense', pt(3)), null, 'a malformed value must not read as 0h');
});

test('pacificHour ignores the box\'s own timezone', () => {
  assert.equal(pacificHour(pt(3)), 3);
  assert.equal(pacificHour(pt(23)), 23);
});

test('the quiet window clears the release by a real margin', () => {
  // Asserting the RELATIONSHIP rather than the numbers, so retuning either stays possible
  // and breaking the relationship does not. An update at the end of the window must still
  // finish well before 08:00.
  assert.ok(DEFAULTS.windowEnd + DEFAULTS.minHoursToRelease <= 8 + 3,
    'the window must end long enough before an 08:00 release for a rollback to happen');
  assert.ok(DEFAULTS.windowStart >= 1 && DEFAULTS.windowEnd <= 6, 'stay in the small hours');
});

test('--force is the human escape hatch and bypasses everything', () => {
  // update.bat stays the manual path. A person at the keyboard has context this cannot
  // have, and a guard with no override becomes something to work around.
  assert.equal(safeToUpdate({ now: pt(14), feedReachable: false, force: true }).ok, true);
});

test('the supervisor gives up rather than thrashing', async () => {
  // A process that dies instantly and restarts instantly is a busy loop wearing a running
  // service's clothes — it would spend the RC login budget or hammer a provider while
  // every dashboard stayed green. Better visibly stopped than invisibly thrashing.
  const { readFileSync } = await import('node:fs');
  const sup = readFileSync('scripts/auto-cart-bot/mini-pc/supervise.ps1', 'utf8');
  assert.match(sup, /CrashLoopCount/, 'there is a crash-loop ceiling');
  assert.match(sup, /STOPPING -/, 'and it stops loudly rather than silently continuing');
  assert.match(sup, /Math\]::Min\(\$backoff \* 2, \$MaxBackoffSec\)/, 'backoff is exponential and capped');
});

test('every long-running bot process is supervised', async () => {
  // The gap that cost 2026-08-10: bare `powershell -NoExit` windows, so nothing restarted
  // a dead process. cloudflared is the deliberate exception — it has its own reconnect
  // logic, and wrapping it would supervise a thing that supervises itself.
  const { readFileSync } = await import('node:fs');
  const start = readFileSync('scripts/auto-cart-bot/mini-pc/start-all.bat', 'utf8');
  for (const proc of ['npm start', 'npm run broker', 'node rc-keepwarm.mjs', 'node rc-hold-runner.mjs']) {
    const line = start.split('\n').find((l) => l.includes(proc) && l.startsWith('start '));
    assert.ok(line, `${proc} must still be launched`);
    assert.match(line!, /supervise\.ps1/, `${proc} must run under the supervisor`);
  }
});

test('the auto-update verifies the new code works, and rolls back when it does not', async () => {
  // Restarting is not success; CHECKING IN is. Pull a broken commit at 03:00, restart into
  // it, find out at 08:00 — that is the failure this must not have, and it is the same
  // lesson as the worker deploy Action failing unless a fresh heartbeat lands.
  const { readFileSync } = await import('node:fs');
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  assert.match(up, /autocart\.rc_runner/, 'it waits for the runner to check in with the server');
  assert.match(up, /Rolling back/, 'and reverts when it does not');
  assert.match(up, /update-guard\.mjs/, 'the decision is delegated to the tested guard');
  // Killing the supervisors first is load-bearing: otherwise they restart the children we
  // are replacing, and the box ends up running old code under a new commit.
  // Delegated to stop-all.ps1 since 2026-08-11, which is where the ordering now lives.
  const killIdx = up.indexOf('Stop-Everything');
  const resetIdx = up.indexOf('git reset --hard $after');
  assert.ok(killIdx > 0 && killIdx < resetIdx, 'everything is stopped before the checkout moves');
});

test('an explicit request lifts the quiet window but NEVER the release check', () => {
  // THE WHOLE POINT OF THE BUTTON. A schedule can only express an average; some days a fix
  // needs to land now. But an update ends the RC session however it was triggered, so
  // "I asked for it" must not override "a cart is minutes away" — that would lose the site
  // the system exists to catch.
  assert.equal(safeToUpdate({ now: pt(14), requested: true }).ok, true, 'asked for at 2pm: allowed');
  assert.match(safeToUpdate({ now: pt(14), requested: true }).reason, /requested/);

  const blocked = safeToUpdate({ now: pt(14), requested: true, nextRelease: '2026-08-12T16:00:00' });
  assert.equal(blocked.ok, false, 'asked for, but a hold releases in 2h');
  assert.match(blocked.reason, /too close to take the session down/);

  // And an unreachable feed still refuses, request or not — we cannot know whether a hold
  // is due, and unknown is not safe for an action that ends the session.
  assert.equal(safeToUpdate({ now: pt(14), requested: true, feedReachable: false }).ok, false);
});

test('the request is cleared whether the update worked or not', async () => {
  // An update that failed and left the flag pending would be retried on the runner's next
  // 15-second poll — a rollback loop on the machine holding the RC session.
  const { readFileSync } = await import('node:fs');
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  const calls = up.split('Report-Applied').length - 1;
  assert.ok(calls >= 3, `expected a definition plus a call on both paths, saw ${calls}`);
  assert.match(up, /Report-Applied \$before "NEW CODE DID NOT CHECK IN/, 'the rollback path reports too');
});

/**
 * ── STOPPING BEFORE STARTING ───────────────────────────────────────────────────────────
 *
 * Reported 2026-08-11: an update "just adds another 5" windows. Four separate causes, all
 * of the same shape — something that looked like it stopped the old processes and did not:
 *
 *  1. `start-all.bat` launches `powershell -NoExit`, so a dead process leaves its console
 *     sitting there. "Is there a window?" was never evidence that anything was running.
 *  2. `update.bat` killed by WINDOW TITLE, which matches nothing (PowerShell retitles its
 *     own console) — the identical bug fixed in rc-login.bat on 08-08 and left here. It
 *     survived on `taskkill /IM node.exe /F` until supervisors shipped, after which the
 *     supervisors lived through it and RESTARTED the children.
 *  3. `auto-update.ps1` never stopped cloudflared, which start-all relaunches every time.
 *  4. Nothing stopped an orphaned Chromium, which holds the real lock on the profile.
 *
 * These assert the wiring, not the wording, because the wording is what drifted.
 */
const miniPc = (f: string) =>
  import('node:fs').then(({ readFileSync }) =>
    readFileSync(`scripts/auto-cart-bot/mini-pc/${f}`, 'utf8'));

/**
 * Strip comments before asserting that something is ABSENT.
 *
 * Without this, "must not kill by image name" fails on the comments explaining why not to
 * kill by image name — and the fix would be to delete the explanation. Same trap as the
 * test that matched `notification_sent_at` inside its own justifying comment.
 */
/** The whole update hand-off branch, anchored on the branch and not on a string inside it. */
/**
 * THE HAND-OFF MOVED (2026-08-11) out of rc-hold-runner.mjs and into control-channel.mjs,
 * shared with bot.mjs. It had to: the runner was the only process reading the update flag,
 * it died at 09:36 PT, and the box went dark with a healthy rec.gov bot polling throughout.
 * These assertions follow the code — every hard-won Windows detail below is the same one,
 * in its new home.
 */
const HANDOFF = 'scripts/auto-cart-bot/control-channel.mjs';

function handoffBlock(src: string): string {
  const i = src.indexOf('if (!updateRequested');
  assert.ok(i > 0, 'the hand-off branch must exist');
  const block = src.slice(i);
  assert.ok(block.includes('ps.unref()'), 'the slice must span the whole branch');
  return block;
}

const code = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(REM\b|::|#|\/\/|\*|\/\*)/i.test(l)).join('\n');

test('the PowerShell scripts are pure ASCII', async () => {
  /**
   * AN EM DASH TOOK ALL FOUR SUPERVISED PROCESSES DOWN (2026-08-11).
   *
   * `Write-Line "STOPPING — $($recent.Count) exits..."` in supervise.ps1. The mini-PC runs
   * Windows PowerShell 5.1, which reads a .ps1 file WITHOUT A BOM as Windows-1252, not
   * UTF-8. The em dash is E2 80 94; byte 0x94 in cp1252 is U+201D, a curly right double
   * quote — and PowerShell accepts curly quotes as string delimiters. So the string closed
   * mid-line, the parse cascaded, and every `powershell -File supervise.ps1` window died
   * with "The string is missing the terminator".
   *
   * In a COMMENT the same bytes are harmless, which is exactly why this must be checked
   * mechanically: today's comment is tomorrow's message string, and the repo's house style
   * is full of em dashes.
   *
   * ASCII rather than a BOM on purpose. A BOM is invisible, and any editor, `git`
   * normalisation or copy-paste can drop it — reintroducing a failure whose symptom is a
   * syntax error hundreds of characters away from its cause.
   */
  const { readdirSync } = await import('node:fs');
  const dir = 'scripts/auto-cart-bot/mini-pc';
  const files = readdirSync(dir).filter((f) => f.endsWith('.ps1'));
  assert.ok(files.length >= 3, 'expected the mini-PC PowerShell scripts to be found');
  for (const f of files) {
    const s = await miniPc(f);
    const bad = [...s].filter((c) => c.charCodeAt(0) > 127);
    assert.equal(
      bad.length, 0,
      `${f} contains non-ASCII (${[...new Set(bad)].join(' ')}) — PowerShell 5.1 reads this ` +
      'file as Windows-1252 and a curly quote there ends a string early',
    );
  }
});

test('no PowerShell line continuation has trailing whitespace after the backtick', async () => {
  /**
   * THE SAME INJURY AS THE EM DASH, through a different door — and there is no PowerShell
   * on the machine these files are written from, so it cannot be caught by running them.
   *
   * A backtick continues a line ONLY when it is the last character before the newline. One
   * trailing space and it becomes an escape of that space: the statement ends there, the
   * next line is parsed as a new statement, and the error surfaces well below the cause —
   * exactly how the em dash reported "missing the terminator" six lines from the em dash.
   * Trailing whitespace is invisible in every editor and survives review perfectly.
   */
  const { readdirSync } = await import('node:fs');
  const dir = 'scripts/auto-cart-bot/mini-pc';
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ps1'))) {
    const lines = (await miniPc(f)).split('\n');
    lines.forEach((line, i) => {
      assert.ok(
        !/`[ \t]+\r?$/.test(line),
        `${f}:${i + 1} ends with a backtick followed by whitespace — that is not a line ` +
        'continuation, and the parse error will point somewhere else entirely',
      );
    });
  }
});

test('every start path stops everything first, through the one script that verifies', async () => {
  for (const f of ['update.bat', 'start-all.bat']) {
    const s = await miniPc(f);
    assert.match(s, /stop-all\.ps1/, `${f} must delegate stopping`);
    const stopIdx = s.indexOf('stop-all.ps1');
    const startIdx = s.search(/start "CampHawk bot"|start-all\.bat/);
    assert.ok(stopIdx > 0 && stopIdx < startIdx, `${f} stops before it launches`);
    // Launching on top of survivors is the bug. A stop that could not finish must abort
    // the launch, not proceed and hope.
    assert.match(s, /if errorlevel 1 goto :stuck/, `${f} refuses to launch on survivors`);
  }
});

test('nothing kills by window title, or by image name', async () => {
  for (const f of ['update.bat', 'start-all.bat', 'rc-login.bat', 'stop-all.ps1', 'auto-update.ps1']) {
    const s = code(await miniPc(f));
    assert.ok(!/WINDOWTITLE/.test(s), `${f} must not kill by window title — it matches nothing`);
    // `taskkill /IM chrome.exe /F` was in update.bat. A person uses this machine and
    // screen-shares it; that closes THEIR browser.
    assert.ok(!/\/IM\s+(chrome|node)\.exe/.test(s), `${f} must not kill by image name`);
  }
});

test('stop-all covers every process start-all launches, and proves they stopped', async () => {
  // `code()` again: this file's own header explains each of these by name, so matching the
  // raw text would pass with every pattern deleted.
  const s = code(await miniPc('stop-all.ps1'));
  // cloudflared is deliberately unsupervised, but start-all DOES relaunch it — so leaving
  // it out is one duplicate tunnel window per update, accumulating forever.
  for (const p of ['bot\\.mjs', 'broker\\.mjs', 'rc-keepwarm\\.mjs', 'rc-hold-runner\\.mjs', 'cloudflared', 'supervise\\.ps1']) {
    assert.ok(s.includes(p), `stop-all must match ${p}`);
  }
  // Stop-Process does not kill a process TREE on Windows, which is why the payloads are
  // named directly rather than trusting the `npm start` shim to take its child with it.
  assert.match(s, /user-data-dir/, 'orphaned Playwright Chromium holds the profile lock');
  assert.match(s, /\.rc-bot-profile/, 'and the Chromium match is scoped to our own profiles');
  assert.ok(s.indexOf('$SUPERVISORS') < s.indexOf('$CHILDREN'),
    'supervisors are stopped first, or they restart what we just killed');
  assert.match(s, /SURVIVED/, 'it says so when something is still up');
  assert.match(s, /exit 1/, 'and exits non-zero so callers do not launch on top');
});

test('auto-update stops before the checkout moves, on both paths', async () => {
  const up = await miniPc('auto-update.ps1');
  const guard = up.indexOf('if (-not (Stop-Everything))');
  const forward = up.indexOf('git reset --hard $after');
  const rollbackStop = up.indexOf('[void](Stop-Everything)');
  const back = up.indexOf('git reset --hard $before');
  assert.ok(guard > 0 && guard < forward, 'the update stops first');
  assert.ok(rollbackStop > forward && rollbackStop < back, 'and so does the rollback');
  // start-all.bat stops too, but that runs AFTER the reset — relying on it would rewrite
  // the working tree underneath live processes.
  assert.match(up, /REFUSED - processes would not stop/, 'a stop that fails aborts the update');
});

test('Report-Applied is defined before anything calls it', async () => {
  // PowerShell runs top-down: a function is not callable above its definition. The early
  // refusal path would have died on "not recognized" and left the request PENDING — which
  // the runner retries every 15 seconds, the exact rollback loop this reporting prevents.
  const up = await miniPc('auto-update.ps1');
  const def = up.indexOf('function Report-Applied');
  const firstCall = up.indexOf('Report-Applied $before');
  assert.ok(def > 0 && def < firstCall, 'defined above its first call');
});

test('rc-login relaunches the RC pair supervised', async () => {
  // A hand sign-in used to quietly downgrade the two processes it was fixing to bare
  // `powershell -NoExit`. The keep-warm's wedge watchdog EXITS on purpose, expecting
  // something to bring it back — unsupervised, that is the 08-10 ten-hour silence again.
  const s = await miniPc('rc-login.bat');
  for (const proc of ['rc-keepwarm', 'rc-hold-runner']) {
    const line = s.split('\n').find((l) => l.startsWith('start ') && l.includes(proc));
    assert.ok(line, `${proc} must still be relaunched`);
    assert.match(line!, /supervise\.ps1/, `${proc} must be relaunched supervised`);
  }
});

test('the runner hands off once, and survives being killed by it', async () => {
  // Detached because the updater kills this very process on its way through: a child tied
  // to us would die with us and leave the box halfway between two commits. Once, because
  // two updaters racing over one checkout is worse than a slow update.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(HANDOFF, 'utf8');
  assert.match(runner, /updateStarted/, 'guarded to one hand-off per process life');
  // NOT `detached: true` any more. On Windows that meant DETACHED_PROCESS, the child got
  // no console, and the script did not run at all. Survival never depended on it: killing
  // a parent on Windows does not kill its children, and stop-all.ps1 matches the bot's own
  // scripts, which auto-update.ps1 is not. `unref()` is what avoids waiting to be killed.
  assert.match(runner, /ps\.unref\(\)/, 'not awaited — that would be waiting to be killed');
  const stopAll = readFileSync('scripts/auto-cart-bot/mini-pc/stop-all.ps1', 'utf8');
  assert.ok(!/auto-update/.test(stopAll.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')),
    'stop-all must not match the updater, or the update would kill itself');
  assert.ok(!/await .*auto-update/.test(runner), 'never awaited — that would be waiting to be killed');
});

test('the guard loads the .env, or it can only ever refuse', async () => {
  // THE TOKEN LIVES IN scripts/auto-cart-bot/.env, NOT IN THE MACHINE ENVIRONMENT. The
  // scheduled task runs this with no parent to inherit from, so without loadEnv the feed
  // answers 401, `feedReachable` stays false, and every single run skips with "refusing to
  // update blind" — correct behaviour for an unknown, reached for the wrong reason, and
  // indistinguishable in the log from a real outage.
  //
  // load-env.mjs's own header records this exact bug hitting rc-hold-runner.mjs on
  // 2026-08-07. This was the last bot script still missing the call.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = 'scripts/auto-cart-bot';
  const entry = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  for (const f of ['update-guard.mjs', 'rc-hold-runner.mjs', 'rc-keepwarm.mjs', 'bot.mjs', 'broker.mjs']) {
    assert.ok(entry.includes(f), `${f} must exist`);
    assert.match(readFileSync(`${dir}/${f}`, 'utf8'), /loadEnv\(/,
      `${f} reads config from .env and must load it`);
  }
});

test('a hand-off that achieved nothing is retried', async () => {
  // auto-update.ps1 exits 0 when its guard refuses — nothing applied, request still
  // pending. `updateStarted` was a boolean that latched for the life of the process, so
  // the runner never tried again and the request sat pending forever. Observed 2026-08-11.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(HANDOFF, 'utf8');
  assert.ok(!/let updateStarted = false;/.test(runner), 'the latching boolean must be gone');
  assert.match(runner, /UPDATE_RETRY_MS/, 'a refused hand-off is retried after a cooldown');
  const m = runner.match(/const UPDATE_RETRY_MS = (\d+) \* 60_000;/);
  assert.ok(m && Number(m[1]) >= 5,
    'but not so fast that two updaters could race over one checkout');
});

test('a refused update is visible from the server, and stays pending', async () => {
  // A refusal used to live only in a log file on a box nobody can reach, so "the guard
  // said no, and why" looked identical to "nothing ever looked at the request". Same
  // distinction `last_attempt_note` draws for the holds themselves.
  const { readFileSync } = await import('node:fs');
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  const lib = readFileSync('src/lib/bot-update.ts', 'utf8');
  assert.match(up, /Report-Attempt \(\(\$guardOut/, 'the refusal reports the guard verdict');
  assert.ok(up.indexOf('function Report-Attempt') < up.indexOf('Report-Attempt (('),
    'defined before use — PowerShell runs top-down');
  // It must NOT clear the request: the reasons the guard refuses are reasons that clear.
  const fn = lib.slice(lib.indexOf('export async function noteBotUpdateAttempt'));
  assert.ok(!/applied_at/.test(fn.slice(0, 400)), 'noteBotUpdateAttempt must never set applied_at');
});

test('being already current satisfies the request', async () => {
  // Otherwise the flag stays pending after a hand-update, the runner re-hands-off every
  // retry interval forever, and each pass takes the RC session down for nothing. "Get
  // current" is the ask; being current is the ask being met.
  const { readFileSync } = await import('node:fs');
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  const branch = up.slice(up.indexOf('already current at'), up.indexOf('already current at') + 400);
  assert.match(branch, /Report-Applied \$before/, 'the current-already path clears the request');
});

test('auto-update survives node writing to stderr', async () => {
  // WINDOWS POWERSHELL 5.1: `2>&1` on a NATIVE command turns each stderr line into an
  // ErrorRecord, and under `$ErrorActionPreference = "Stop"` the first one is a
  // TERMINATING error. node writes to stderr routinely (experimental warnings,
  // deprecations), so `$guardOut = & node update-guard.mjs 2>&1` killed the script on its
  // first real line — before any report — every single run. Observed 2026-08-11: the
  // runner logged the hand-off at 03:37:27 and the server heard nothing at all.
  //
  // Same family as the em dash: a PowerShell-specific behaviour that makes correct-looking
  // code fail silently, and can only be caught mechanically.
  const { readFileSync } = await import('node:fs');
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  const usesNativeRedirect = /& node .*2>&1/.test(up) || /& git .*2>&1/.test(up);
  if (usesNativeRedirect) {
    assert.match(up, /\$ErrorActionPreference = "Continue"/,
      'a script redirecting native stderr must not run under Stop');
  }
  // Native results are still read explicitly rather than left to PowerShell's error
  // machinery — $LASTEXITCODE for stop-all, and the guard's printed verdict for the guard
  // (an exit code a crash can corrupt is not a contract; see the verdict-line test).
  assert.match(up, /\$LASTEXITCODE -eq 0/, 'stop-all is judged by its exit status');
  assert.match(up, /\[update-guard\\\] PROCEED/, 'the guard is judged by its verdict line');
});

test('the script says it started before anything can kill it', async () => {
  // Diagnosing the above took three rounds because "died on line 1", "the guard refused"
  // and "the runner never handed off" were the same silence server-side. A launch report
  // makes no-report-at-all mean exactly one thing.
  const { readFileSync } = await import('node:fs');
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  const started = up.indexOf('Report-Attempt "started');
  assert.ok(started > 0, 'it reports launch');
  assert.ok(started < up.indexOf('node @guardArgs'), 'before the guard runs');
  assert.ok(up.indexOf('function Report-Attempt') < started, 'and after its own definition');
});

test('the update hand-off resolves its script from THIS file, not the cwd', async () => {
  // 2026-08-11: the runner logged "handing off to auto-update.ps1", the script never ran,
  // and logs\auto-update.log did not exist — because a wrong `-File` path makes PowerShell
  // exit immediately with a message thrown away by `stdio: 'ignore'`. process.cwd() happens
  // to be right when start-all launches the runner and is wrong the moment anything else
  // does, so the correctness of the path depended on who started us.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(HANDOFF, 'utf8');
  // `code()` because the comment right above the fix explains why NOT to use process.cwd()
  // — matching the raw text would fail on the explanation. Third time tonight.
  const block = code(handoffBlock(runner));
  assert.ok(!/process\.cwd\(\)/.test(block), 'the script path must not depend on the working directory');
  // The shared module takes the directory from its caller, so the assertion has to follow
  // it there: BOTH pollers must pass their own module directory, and neither may pass a cwd.
  assert.match(block, /path\.join\(dir, 'mini-pc', 'auto-update\.ps1'\)/);
  for (const [f, expected] of [
    ['scripts/auto-cart-bot/rc-hold-runner.mjs', 'HERE'],
    ['scripts/auto-cart-bot/bot.mjs', '__dirname'],
  ] as const) {
    const src = code(readFileSync(f, 'utf8'));
    const call = src.match(/makeControlChannel\(\{[\s\S]*?\}\)/)?.[0];
    assert.ok(call, `${f} must build the control channel`);
    assert.match(call, new RegExp(`dir:\\s*${expected}\\b`), `${f} must pass its own module directory`);
    assert.ok(!/process\.cwd\(\)/.test(call), `${f} must not pass a cwd`);
  }
});

test('BOTH feeds carry the control channel, and both pollers read it', async () => {
  // THE POINT OF THE WHOLE CHANGE (2026-08-11). The update flag and the diagnostics queue
  // were read only by rc-hold-runner.mjs. It died at 09:36 PT and took every remote lever
  // with it — no update, no diagnostics, no way to ask the box a question — while bot.mjs
  // polled the roster feed every two seconds throughout, healthy the entire time. "The box
  // is unreachable" and "the RC runner is down" must never be the same event again.
  const { readFileSync } = await import('node:fs');
  for (const f of ['scripts/auto-cart-bot/rc-hold-runner.mjs', 'scripts/auto-cart-bot/bot.mjs']) {
    assert.match(readFileSync(f, 'utf8'), /makeControlChannel/, `${f} must read the control channel`);
  }
  for (const r of ['src/app/api/auto-cart/roster/route.ts', 'src/app/api/auto-cart/rc-holds/route.ts']) {
    assert.match(readFileSync(r, 'utf8'), /botControlFor\(/, `${r} must serve the control channel`);
  }
  // ONE implementation. Two copies would be two chances to fix one and forget the other,
  // and the forgotten copy is by definition the one running when the other is dead.
  const channel = readFileSync(HANDOFF, 'utf8');
  assert.equal((channel.match(/spawn\('powershell'/g) ?? []).length, 1);
  for (const f of ['scripts/auto-cart-bot/rc-hold-runner.mjs', 'scripts/auto-cart-bot/bot.mjs']) {
    assert.ok(!/auto-update\.ps1/.test(code(readFileSync(f, 'utf8'))),
      `${f} must hand off through the shared module, not spawn the updater itself`);
  }
});

test('a hand-off that cannot start says so', async () => {
  // Two silent failures, both closed here. A missing script was launched at anyway; and
  // spawn() reports ENOENT via an 'error' EVENT, not by throwing — so the try/catch never
  // saw it, and an 'error' with no listener would take the whole runner down.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(HANDOFF, 'utf8');
  const block = handoffBlock(runner);
  assert.match(block, /fs\.existsSync\(script\)/, 'a missing script is reported, not launched at');
  assert.match(block, /ps\.on\('error'/, "spawn's error event has a listener");
  // Both reset the retry clock — a hand-off that never started must be retried.
  assert.ok((block.match(/updateStartedAt = 0;/g) ?? []).length >= 3,
    'every failure path frees the retry');
});

test('the bot logs are searchable', async () => {
  // findstr on rc-holds.log answered "input file is in Unicode format" while diagnosing a
  // silent update, because PowerShell 5.1's Tee-Object writes UTF-16LE. These files are the
  // post-mortem record, and a record you cannot grep is half a record.
  const { readFileSync } = await import('node:fs');
  const sup = readFileSync('scripts/auto-cart-bot/mini-pc/supervise.ps1', 'utf8');
  assert.ok(!/Tee-Object -FilePath \$LogFile/.test(sup), 'Tee-Object writes UTF-16 — do not use it for the log');
  assert.match(sup, /Add-Content -Path \$LogFile -Value \$_ -Encoding UTF8/);
  assert.match(sup, /Write-Host \$_/, 'and the live console still shows the output');
});

test('the guard exits cleanly, without pulling the loop out from under libuv', async () => {
  // OBSERVED ON WINDOWS 2026-08-11, printed AFTER the verdict:
  //   node.exe : Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
  // `AbortSignal.timeout` leaves a timer handle behind and `process.exit()` tears the loop
  // down underneath it. The crash matters more than it looks: it replaces our exit code
  // with the crash's, so a PROCEED verdict came back non-zero and the update was skipped
  // anyway — the decision was right and the exit status lied about it.
  const { readFileSync } = await import('node:fs');
  const g = code(readFileSync('scripts/auto-cart-bot/update-guard.mjs', 'utf8'));
  assert.ok(!/AbortSignal\.timeout/.test(g), 'use a controller we can clear, not a dangling timer');
  assert.match(g, /clearTimeout\(timer\)/);
  // NOT "never call process.exit" — that was the wrong lesson, drawn on 2026-08-11 from
  // the crash alone, and it hung the box within hours. What made exit() unsafe was the
  // DANGLING TIMER, so clearing it is the invariant; exiting explicitly is then required,
  // because on the success path undici's pooled socket keeps the loop alive for ever.
  assert.match(g, /process\.exitCode = verdict\.ok \? 0 : 1/);
  assert.match(g, /process\.exit\(process\.exitCode\)/, 'and it must actually exit');
  // An unread body keeps a socket alive, which is the other way this fails to exit.
  assert.match(g, /r\.body\?\.cancel/);
});

test('auto-update trusts the verdict LINE, not the exit code', async () => {
  // A crash can corrupt an exit status; it cannot un-print a line. And the fallback
  // direction is fail-safe: anything that is not an explicit PROCEED is a skip, so a guard
  // that dies before deciding stops the update — the right answer when we do not know
  // whether a hold is due.
  const { readFileSync } = await import('node:fs');
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  assert.match(up, /\$verdict -notmatch '\\\[update-guard\\\] PROCEED'/,
    'proceeding requires the guard to have said so in words');
  assert.match(up, /did not reach a verdict/, 'and a crashed guard is called out as such');
});

test('a spawned hand-off cannot fail silently', async () => {
  // `stdio: 'ignore'` made "started and died immediately" identical to "never started".
  // That ambiguity is what made this take all night to find.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(HANDOFF, 'utf8');
  const block = handoffBlock(runner);
  assert.ok(!/stdio: 'ignore'/.test(block), "the child's output must go somewhere readable");
  assert.match(block, /update-spawn\.log/, 'and it goes to a named file');
  // Written BEFORE the spawn, so the file exists even when the launch is what fails —
  // which turns "no file" into a single unambiguous meaning.
  const marker = block.indexOf('appendFileSync');
  assert.ok(marker > 0 && marker < block.indexOf('spawn('), 'the marker precedes the spawn');
});

test('the hand-off does not detach the child on Windows', async () => {
  // `detached: true` means DETACHED_PROCESS on Windows — the child gets no console — and a
  // `powershell -File` started that way produced literally nothing on 2026-08-11: no
  // output, no error, no auto-update.log, while the identical command by hand ran fine. It
  // was the one constant across every failed attempt.
  //
  // It was never needed either: killing a parent on Windows does not kill its children,
  // and stop-all.ps1 matches the bot's own scripts, which auto-update.ps1 is not.
  const { readFileSync } = await import('node:fs');
  const block = code(handoffBlock(readFileSync(HANDOFF, 'utf8')));
  assert.ok(!/detached: true/.test(block), 'a detached child has no console and may not run');
  assert.match(block, /ps\.unref\(\)/, 'unref is what lets the runner exit without waiting');
});

test('the child reports how it ended, to the file and not just the console', async () => {
  // "Ran and died silently" and "never ran" are identical without an exit status, and a
  // failure reported only to a console nobody can copy is how this stayed invisible for
  // several rounds.
  const { readFileSync } = await import('node:fs');
  const block = handoffBlock(readFileSync(HANDOFF, 'utf8'));
  assert.match(block, /ps\.on\('exit'/, 'the exit status is recorded');
  // Match the REPORTER, not merely the string: the pre-spawn marker also calls
  // appendFileSync(spawnLog, ...), so a looser assertion passed with the reporter gutted.
  assert.match(block, /const note = \(line\) => \{[\s\S]*?appendFileSync\(spawnLog/,
    'the failure reporter writes to the file, not only the console');
  assert.match(block, /ps\.on\('error'/, 'as does a failure to start');
});

test('the guard terminates after a successful feed call', async () => {
  // WHAT THIS DOES AND DOES NOT PROVE — read before trusting it.
  //
  // On 2026-08-11 an update sat at "started - checking the guard" for nine minutes with the
  // runner still alive, i.e. it never reached stop-all. The suspected mechanism was
  // `process.exitCode` without `process.exit()`: on the success path undici keeps a socket
  // pooled, so the loop never drains and `& node update-guard.mjs` waits for ever.
  //
  // I COULD NOT REPRODUCE THAT. Against a local HTTP server the guard exits cleanly with
  // the explicit exit removed, so either a pooled TLS socket to Vercel behaves differently
  // or the stall was somewhere else entirely (`git fetch` is the other candidate, and it
  // sits between the last report and stop-all). The explicit exit is therefore a DEFENSIVE
  // fix for a mechanism that is plausible and unconfirmed — said plainly here rather than
  // written up as a diagnosis.
  //
  // So this test catches an outright hang in the guard and nothing subtler. It is not
  // evidence that the 08-11 stall is fixed.
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
    res.end(JSON.stringify({ nextRelease: null, updateRequested: false }));
  });
  // HOLD THE SOCKET OPEN. node's http server closes an idle keep-alive connection after 5s
  // by default, which frees the client's handle and lets a HUNG child exit anyway — the
  // first version of this test passed with the hang restored, i.e. it tested nothing.
  // Vercel holds it far longer, which is why the real failure was open-ended.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  try {
    const child = spawn(process.execPath, ['scripts/auto-cart-bot/update-guard.mjs'], {
      env: { ...process.env, CAMPHAWK_URL: `http://127.0.0.1:${port}`, AUTOCART_TOKEN: 'test' },
      stdio: 'ignore',
    });
    const exited = await new Promise<boolean>((resolve) => {
      // Well under the server's keep-alive above: if the child is still running at 10s it
      // is not slow, it is never leaving.
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 10_000);
      child.on('exit', () => { clearTimeout(t); resolve(true); });
    });
    assert.ok(exited, 'update-guard must terminate — a hang blocks every update for ever');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});


test('auto-update.ps1 loads the .env BEFORE it reports anything', async () => {
  const { readFileSync } = await import('node:fs');
  // WHY (2026-08-11). Every report this script made was answered 401 Unauthorized, in its
  // own log, for hours. The token lives in scripts/auto-cart-bot/.env and a Scheduled Task
  // has no parent environment to inherit from - so `$env:AUTOCART_TOKEN` was empty and the
  // box was faithfully telling us what it had done while being rejected at the door.
  //
  // That is indistinguishable from a task that was never registered, and I read it that way
  // for hours. It is the SAME trap update-guard.mjs was fixed for with loadEnv; the fix went
  // to the thing that reads the answer and not to the thing that reports it.
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  assert.match(up, /function Import-BotEnv/, 'it must read the .env itself');
  assert.match(up, /Join-Path \$botDir "\.env"/, 'and from the bot directory, not the cwd');

  // ORDER IS LOAD-BEARING: PowerShell runs top-down, so a call above its definition dies
  // with "not recognized" - the exact bug that left an update request pending on 2026-08-11.
  const define = up.indexOf('function Import-BotEnv');
  const call = up.indexOf('\nImport-BotEnv');
  const firstReport = up.indexOf('Report-Attempt "started');
  assert.ok(define !== -1 && call !== -1 && firstReport !== -1);
  assert.ok(define < call, 'defined before it is called');
  assert.ok(call < firstReport, 'and called before the first report, or the token is empty');
});

test('auto-update.ps1 writes ONE encoding', async () => {
  const { readFileSync } = await import('node:fs');
  // Its log was half UTF-16 and half UTF-8: Tee-Object writes UTF-16LE in PowerShell 5.1
  // while Add-Content takes the shell codepage. No single decoder can read such a file, and
  // that is how the 401 above stayed hidden inside mojibake for hours.
  const up = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  const body = up.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/Tee-Object/.test(body), 'Tee-Object writes UTF-16LE - use the Tee-Utf8 filter');
  for (const m of body.match(/Add-Content[^\n]*/g) ?? []) {
    assert.match(m, /-Encoding UTF8/, `Add-Content must state its encoding: ${m.trim()}`);
  }
});


test('every writer to the shared restart log survives contention', async () => {
  // ALL of them append to logs/restarts.log, and Windows file locking makes all but one
  // writer fail while the file is held. Contention PEAKS during a stop - four supervisors
  // are writing their own "exited code=" lines at that moment - so this log drops exactly
  // the lines that explain a stop, which is the only time anyone reads it.
  //
  // Observed 2026-08-11: a remote update reported "REFUSED - processes would not stop" and
  // the log held the opening "stopping 18 process(es)" and nothing else. The re-check ran
  // and named every survivor; not one of those lines reached the file. supervise.ps1 was
  // fixed hours earlier and its siblings were not - which is precisely why this asserts
  // across the DIRECTORY rather than against one file.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = 'scripts/auto-cart-bot/mini-pc';
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ps1'))) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    const body = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    if (!/restarts\.log/.test(body)) continue;
    const fn = body.match(/function Write-Line[\s\S]*?\n}/)?.[0] ?? '';
    assert.ok(fn, `${f}: writes restarts.log but has no Write-Line to check`);
    assert.match(fn, /-Encoding UTF8/, `${f}: the shared log must state its encoding`);
    assert.match(fn, /try \{/, `${f}: the shared-log write must be retried, not fire-and-hope`);
    // The console line must come FIRST, so the information survives a failed file write.
    const console_ = fn.search(/Write-(Host|Output)/);
    const file_ = fn.indexOf('Add-Content');
    assert.ok(console_ !== -1 && file_ !== -1 && console_ < file_,
      `${f}: write to the console before the file, or a locked file loses the line entirely`);
  }
});


test('a REQUESTED update is claimed; a quiet-window one is not', async () => {
  // The scheduled task was the last path that spawned the updater without claiming, leaving
  // the one race the claim exists to prevent still open: it fires every five minutes, and
  // `npm ci` outlasts that, so a second updater could move the checkout under the first.
  // Mitigated by hand on 2026-08-11 (set the flag, clear it the instant somebody claimed) -
  // a workaround, not a fix.
  const { readFileSync } = await import('node:fs');
  const guard = readFileSync('scripts/auto-cart-bot/update-guard.mjs', 'utf8');
  assert.match(guard, /updateClaim: 'scheduled-task'/, 'the task must claim before proceeding');

  // ONLY when requested. A quiet-window update has no request to claim - claimBotUpdate
  // requires a pending one - so claiming unconditionally would refuse EVERY scheduled
  // update, which is the exact failure this file exists to avoid.
  // `!preClaimed` joined this condition on 2026-08-12: the pollers claim before spawning
  // auto-update.ps1, so on that path the guard was competing with its own spawner and
  // losing. The property this line has always asserted — claim only a REQUESTED update,
  // never under --force — is unchanged. See the deadlock test below.
  assert.match(guard, /if \(requested && !force && !preClaimed\)/, 'claim only a requested update, and never under --force');

  // A claim it cannot reach is a NO, matching the box side.
  const block = guard.match(/if \(requested && !force && !preClaimed\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(block, 'could not find the claim block');
  assert.match(block, /\.catch\(\(\) => false\)/, 'unreachable claim must not read as granted');
});

test('update.bat records what it landed on', async () => {
  // auto-update.ps1 reports; the MANUAL path did not, so the admin panel showed the last
  // unattended result - "37e1527, REFUSED" - while the box ran d1ab782. It misled me twice
  // in one evening, the second time with a git-status answer on screen contradicting it.
  const { readFileSync } = await import('node:fs');
  const bat = readFileSync('scripts/auto-cart-bot/mini-pc/update.bat', 'utf8');
  assert.match(bat, /report-applied\.mjs/, 'update.bat must report the applied commit');

  const rep = readFileSync('scripts/auto-cart-bot/mini-pc/report-applied.mjs', 'utf8');
  // The token lives in .env, not the machine environment - the trap that made every
  // auto-update.ps1 report 401 for hours.
  assert.match(rep, /loadEnv\(/, 'it must load the .env like every other bot script');
  // The commit is READ FROM GIT, never taken from the caller: a sha passed in by a batch
  // file is a sha nobody checked.
  assert.match(rep, /rev-parse', 'HEAD'/, 'the commit must come from git itself');
  assert.match(rep, /process\.exit\(0\)/, 'a failed report must never fail the update');
});

test('the updater does not compete with the spawner that already claimed', async () => {
  const { readFileSync } = await import('node:fs');
  // THE DEADLOCK, 2026-08-12. `update-guard.mjs` runs on TWO paths: the Windows Scheduled
  // Task runs it directly, and the pollers claim FIRST and then spawn `auto-update.ps1`,
  // which runs it too. When the guard learned to claim (7193c21, to close the task's race),
  // it started claiming on BOTH — so on the poller path it competed with the process that
  // spawned it and lost to a claim taken one second earlier.
  //
  // "Update now" therefore refused itself with "another process holds the update claim",
  // and because a standing request is re-claimed every 20 minutes it could never drain. The
  // only way in became a human running update.bat: a fix deliverable solely by the mechanism
  // it fixes. That is why this is a test and not a comment.
  const guard = readFileSync('scripts/auto-cart-bot/update-guard.mjs', 'utf8');
  const ps1 = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
  const chan = readFileSync('scripts/auto-cart-bot/control-channel.mjs', 'utf8');

  // The guard must honour a spawner that says it already holds the claim...
  assert.match(guard, /--claimed/, 'the guard must accept --claimed');
  assert.match(
    guard,
    /if \(requested && !force && !preClaimed\)/,
    'the claim must be skipped when the spawner already holds it',
  );

  // ...auto-update.ps1 must be able to pass it through...
  assert.match(ps1, /\[switch\]\$Claimed/, 'auto-update.ps1 needs a -Claimed switch');
  assert.match(ps1, /if \(\$Claimed\) \{ \$guardArgs \+= "--claimed" \}/, 'and must forward it');

  // ...and the poller, which claims before spawning, must actually pass it. Without this
  // line the other two are inert and the deadlock is exactly as it was.
  assert.match(chan, /'-File', script, '-Claimed'/, 'the poller must spawn with -Claimed');

  // THE RACE THAT COMMIT CLOSED MUST STAY CLOSED. The scheduled task claims nothing, so the
  // guard is its only gate — if it ever stopped claiming outright, two tasks five minutes
  // apart could move one checkout, which is what 7193c21 existed to prevent.
  assert.match(guard, /updateClaim: 'scheduled-task'/, 'the task path must still claim');
});

test('the watchdog recovers a dark box, and cannot be talked out of it forever', async () => {
  // WHY A WATCHDOG AT ALL. Every remote lever rides a poller ON the box, so when all the
  // pollers die there is nothing left to receive a command — the one situation that most
  // needs a remote fix is the one in which none can arrive. 2026-08-11 (the RC runner died
  // and took the diagnostics with it) and 2026-08-14 (an update stopped everything to move
  // the checkout and never brought it back — 45 minutes dark with three holds queued).
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('scripts/auto-cart-bot/mini-pc/watchdog.ps1', 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  // THE TIMEOUT IS THE POINT. A naive "never touch it during an update" guard would have
  // refused for the rest of 08-14, because the updater was itself what died — still holding
  // every process down. A stand-down with no expiry protects the broken thing.
  assert.match(code, /UPDATE_DEAD_AFTER_MIN\s*=\s*\d+/, 'the update stand-down must have an expiry');
  assert.match(code, /\$age\s*-lt\s*\$UPDATE_DEAD_AFTER_MIN/, 'and it must actually be compared against');

  // It must go through start-all.bat, which stops first — that is what makes a duplicate
  // structurally impossible rather than merely unlikely.
  assert.match(code, /start-all\.bat/, 'recovery must go through start-all.bat');
  assert.ok(
    !/\bnpm start\b|supervise\.ps1/.test(code),
    'never launch the payloads directly — start-all.bat owns the stop-then-start order',
  );

  // NO REBOOT. In every outage so far Windows was fine and only our processes had died, and
  // a reboot ends the RC session because the token lives in the Chromium it closes.
  assert.ok(
    !/Restart-Computer|shutdown(\.exe)?\s+\/r/i.test(code),
    'the watchdog must not reboot the machine',
  );

  // Ours is decided by COMMAND LINE, never image name — `taskkill /IM` style matching is how
  // a script starts touching the browser of whoever is sitting at this machine.
  assert.match(code, /CommandLine/, 'match our processes on the command line');

  // A failed recovery must exit non-zero. Exiting 0 on failure leaves the only record of a
  // box that cannot be restarted in a log nobody reads.
  assert.match(code, /START FAILED[\s\S]{0,200}?exit 1/, 'a failed start must exit non-zero');
});
