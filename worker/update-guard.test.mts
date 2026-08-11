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
const code = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(REM\b|::|#)/i.test(l)).join('\n');

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

test('the runner hands off once, detached', async () => {
  // Detached because the updater kills this very process on its way through: a child tied
  // to us would die with us and leave the box halfway between two commits. Once, because
  // two updaters racing over one checkout is worse than a slow update.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');
  assert.match(runner, /updateStarted/, 'guarded to one hand-off per process life');
  assert.match(runner, /detached: true/, 'survives being killed by the thing it started');
  assert.ok(!/await .*auto-update/.test(runner), 'never awaited — that would be waiting to be killed');
});
