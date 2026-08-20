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
import { readFileSync } from 'node:fs';
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
  // The sentinel moved with the mechanism. It was `ps.unref()`, from when the poller spawned
  // PowerShell itself; the launch is now a `schtasks /Run` and there is no `ps`. A slice
  // sentinel that no longer occurs fails LOUDLY here rather than silently returning a short
  // block that every assertion below then passes against.
  assert.ok(block.includes("spawn('schtasks'"), 'the slice must span the whole branch');
  return block;
}

/**
 * From `at`, return the source up to and including the brace that closes the first `{`.
 *
 * Exact rather than textual, because every text sentinel tried here was defeated by
 * reformatting the thing being measured — which is precisely what a mutation does.
 */
function braced(src: string, at: number): string {
  const open = src.indexOf('{', at);
  assert.ok(open > -1, 'no opening brace after the anchor');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail('unbalanced braces from the anchor — the slice would run to end of file');
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

/**
 * THE "NOTHING RUNNING" PATH SKIPPED BOTH CHECKS THAT COULD SAY IT WAS BLIND (2026-08-15).
 *
 * stop-all's filters are all `$_.CommandLine -and ...`, and an unelevated WMI query reads
 * $null for a process in another security context — so a whole generation started elevated
 * counts as ZERO. The early return `if ($before -eq 0) { "nothing running."; exit 0 }` then
 * fired before the blind note and the broker-port check, i.e. exactly where "I found
 * nothing" is least trustworthy the script printed its most reassuring sentence.
 *
 * Measured at 05:12 UTC that day: two bare `nothing running.` lines thirteen seconds apart
 * with the elevated broker holding 8787 throughout, start-all treating the exit 0 as
 * permission, a second generation launched on top, and the pre-update elevated generation
 * surviving — so the box ran `e6a7ebf` for four hours with its checkout on `c1bd875`.
 *
 * The port check is what would have stopped it: proof by construction, exit 1, start-all's
 * :stuck branch. So these assert REACHABILITY and ORDER, which is what was wrong — every
 * check existed and passed its own test, one path just never ran them.
 */
test('the "nothing to stop" path runs the blindness checks before it reassures', async () => {
  const raw = await miniPc('stop-all.ps1');
  const s = code(raw);

  // ONE DEFINITION EACH. Two copies is how rc-login.bat's kill was fixed in one file and
  // left broken in the second — and the forgotten copy is by definition the one running.
  for (const fn of ['Write-BlindNote', 'Test-BrokerStillBound']) {
    const defs = s.split(new RegExp(`function\\s+${fn}\\b`)).length - 1;
    assert.equal(defs, 1, `${fn} must be defined exactly once`);
  }

  // PowerShell runs top-down: a function is not callable above its definition. The quiet
  // path would die on "not recognized" — same lesson as Report-Applied below.
  const quiet = s.indexOf('$before -eq 0');
  assert.ok(quiet > 0, 'the quiet path must exist');
  for (const fn of ['Write-BlindNote', 'Test-BrokerStillBound']) {
    assert.ok(s.indexOf(`function ${fn}`) < quiet, `${fn} must be defined above the quiet path`);
  }

  // THE REACHABILITY PROPERTY. The block from the early-return test to its `exit 0` must
  // call both — that is the whole defect, and it is invisible from either check's own body.
  const block = s.slice(quiet, s.indexOf('Write-Line "stopping $before'));
  assert.ok(block.length > 0, 'the quiet block must be bounded by the normal stop path');
  assert.match(block, /Write-BlindNote/, 'the quiet path must report what it could not see');
  assert.match(block, /Test-BrokerStillBound/, 'and must check the port, which is proof');

  // ORDER: the port check outranks the reassurance. Reversed, it still prints "nothing
  // running." and exits 0 first, and start-all launches on top of the orphan anyway.
  assert.ok(block.indexOf('Test-BrokerStillBound') < block.indexOf('"nothing running."'),
    'the port check must run BEFORE the all-clear sentence');

  // SEVERITY, unchanged and deliberately different. The port is proof and fails; an
  // unreadable node.exe may be the owner's own and only warns, or this script would refuse
  // every launch for the rest of the box's life.
  assert.match(block, /Test-BrokerStillBound\)\s*\{\s*exit 1/, 'a bound port is a FAILURE');
  assert.match(block, /nothing VISIBLE/,
    'a blind scan must not be reported with the same words as a scan that saw nothing');

  // And the normal path keeps both checks too, from the same definitions.
  const tail = s.slice(s.indexOf('Write-Line "stopping $before'));
  assert.match(tail, /Write-BlindNote/, 'the stop path reports blindness as well');
  assert.match(tail, /Test-BrokerStillBound/, 'and re-checks the port after the kill');
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

test('the RC sign-in scripts relaunch the pair supervised', async () => {
  // A hand sign-in used to quietly downgrade the two processes it was fixing to bare
  // `powershell -NoExit`. The keep-warm's wedge watchdog EXITS on purpose, expecting
  // something to bring it back — unsupervised, that is the 08-10 ten-hour silence again.
  //
  // BOTH FILES, because that is how it survived: it was fixed in rc-login.bat on 2026-08-11
  // and left standing in rc-test-login.bat, which relaunches the identical pair.
  for (const f of ['rc-login.bat', 'rc-test-login.bat']) {
    const s = await miniPc(f);
    for (const proc of ['rc-keepwarm', 'rc-hold-runner']) {
      const line = s.split('\n').find((l) => l.startsWith('start ') && l.includes(proc));
      assert.ok(line, `${f}: ${proc} must still be relaunched`);
      assert.match(line!, /supervise\.ps1/, `${f}: ${proc} must be relaunched supervised`);
    }
  }
});

test('no batch file escapes a quote PowerShell-style inside -Command', async () => {
  /**
   * THE BUG THIS EXISTS FOR (2026-08-14). rc-login.bat carried its process kill as inline
   * PowerShell, and the regex contained `[^\"]`:
   *
   *   powershell -NoProfile -Command ^
   *     "... -match '--user-data-dir=[^\"]*\.rc-bot-profile' ... | ForEach-Object { ... }"
   *
   * `\"` is PowerShell's escape. CMD HAS NO BACKSLASH ESCAPE — so that quote CLOSED the
   * string, everything after it was unquoted, and the very next `|` became a cmd PIPE. cmd
   * then tried to run `ForEach-Object` as a program:
   *
   *   'ForEach-Object' is not recognized as an internal or external command
   *
   * So the kill had never run once, on any invocation, since the file was written. It
   * printed "Closing anything holding the RC profile", closed nothing, and went on to open
   * a second Chromium on a profile the first still held.
   *
   * Note the near miss: rc-test-login.bat had a line that LOOKS identical and was fine,
   * because only rc-login.bat carried the Chromium arm with the `\"` in it. Same-looking
   * code, opposite behaviour — which is the argument for having none of it in a .bat.
   *
   * Scoped to `-Command` on purpose: install-autoupdate.bat and install-watchdog.bat pass
   * `\"` to `schtasks /TR`, where it is the documented way to nest quotes and where there
   * is no `|` for a broken quote to expose. Those tasks demonstrably fire.
   */
  const { readdirSync } = await import('node:fs');
  const dir = 'scripts/auto-cart-bot/mini-pc';
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.bat'))) {
    (await miniPc(f)).split('\n').forEach((line, i) => {
      if (/^\s*(REM\b|::)/i.test(line)) return;
      if (!/powershell/i.test(line) || !/-Command/i.test(line)) return;
      assert.ok(
        !line.includes('\\"'),
        `${f}:${i + 1} escapes a quote as \\" inside a powershell -Command string. cmd has ` +
        'no backslash escape, so that ends the string and the next | becomes a cmd pipe. ' +
        'Put the code in a .ps1 and call it with -File.',
      );
    });
  }
});

test('every caller that frees the RC profile goes through stop-rc.ps1', async () => {
  /**
   * ONE STOP, not three. Each of these had its own copy, two of them inline in a .bat, and
   * one of those had been failing silently since the day it was written. Two copies are two
   * chances to fix one and forget the other — and the forgotten copy is by definition the
   * one running when the other is dead. Same rule that put the control channel in a shared
   * module, and the same rule that the unsupervised relaunch above broke.
   */
  for (const f of ['rc-login.bat', 'rc-test-login.bat']) {
    const s = await miniPc(f);
    assert.match(s, /stop-rc\.ps1/, `${f} must delegate freeing the profile`);
    // -File, not -Command: the whole point is that no code crosses cmd.
    assert.match(s, /-File "%~dp0stop-rc\.ps1"/, `${f} must call it with -File`);
    // A stop that could not finish must abort, not sign in on top of the survivors. Two
    // Chromium on one user-data-dir corrupt the session these scripts exist to restore.
    const stopIdx = s.indexOf('stop-rc.ps1');
    assert.match(s.slice(stopIdx, stopIdx + 200), /if errorlevel 1 goto :busy/,
      `${f} must refuse to continue when the profile is still held`);
    assert.match(s, /^:busy$/m, `${f} must define the :busy label it jumps to`);
  }

  const restart = code(await miniPc('restart-rc.ps1'));
  assert.match(restart, /stop-rc\.ps1/, 'restart-rc must delegate too');
  assert.ok(!/Stop-Process/.test(restart), 'restart-rc must not grow its own kill back');
  assert.match(restart, /LASTEXITCODE -ne 0/, 'and must abort when the stop failed');
});

test('stop-rc frees the whole profile and proves it did', async () => {
  // `code()` because the header explains each of these by name — matching the raw text
  // would pass with every pattern deleted.
  const s = code(await miniPc('stop-rc.ps1'));
  for (const p of ['rc-keepwarm\\.mjs', 'rc-hold-runner\\.mjs', 'supervise\\.ps1']) {
    assert.ok(s.includes(p), `stop-rc must match ${p}`);
  }
  // Playwright's Chromium outlives a force-killed parent and holds the REAL Chrome lock on
  // the user-data-dir, which deleting our own lock file does not touch.
  assert.match(s, /user-data-dir/, 'orphaned Chromium holds the profile lock');
  assert.match(s, /\.rc-bot-profile/, 'and the match is scoped to our own profile');
  assert.match(s, /camphawk-profile-lock/, 'a force kill never releases our lock file');
  // Never by image name: /IM node.exe takes the rec.gov bot down, /IM chrome.exe closes the
  // browser of whoever is sitting at this machine.
  assert.ok(!/\/IM\s+(chrome|node)\.exe/.test(s), 'stop-rc must not kill by image name');
  assert.ok(!/\bbot\\?\.mjs|broker\\?\.mjs|cloudflared/.test(s),
    'stop-rc must leave the rec.gov bot, the broker and the tunnel alone');
  // RE-CHECK, then say so. Trusting the kill is how a second browser lands on a held profile.
  assert.match(s, /STILL RUNNING/, 'it names the survivors');
  assert.match(s, /exit 1/, 'and exits non-zero so callers do not launch on top');
});

test('the runner hands off once, and the updater survives being killed by it', async () => {
  /**
   * ~~Survival never depended on detaching: killing a parent on Windows does not kill its
   * children, and stop-all.ps1 matches the bot's own scripts, which auto-update.ps1 is
   * not.~~ **THE FIRST CLAUSE IS FALSE AND THIS TEST ASSERTED IT.** Struck rather than
   * deleted, because a guard that pinned the bug is the thing worth remembering.
   *
   * It is true of a raw Win32 TerminateProcess and false of a libuv-spawned child: on
   * Windows `uv_spawn` puts every non-detached child in the parent's Job Object. Ancestry
   * was `cmd.exe (npm start) -> node.exe (bot.mjs) -> powershell.exe (auto-update.ps1)`,
   * and stop-all kills the first two. Measured twice on 2026-08-20 — both runs end on a
   * `node.exe` kill partway through the stop list and write nothing further.
   *
   * The SECOND clause still holds and is still pinned below: stop-all does not match the
   * updater by name, so nobody "fixes" this by adding it to the kill list.
   *
   * Survival now comes from ownership rather than from an argument about process trees —
   * the Task Scheduler starts it, so it is not our descendant. worker/update-trigger.test.mts
   * owns that mechanism; what stays here is the part this file has always been about.
   */
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(HANDOFF, 'utf8');
  // THE COMPARISON, not the identifier. `updateStartedAt` also appears in the two failure
  // handlers that reset it, so a bare /updateStarted/ passed against a poller whose retry
  // window had been deleted outright — two updaters per process life, racing one checkout.
  assert.match(runner, /Date\.now\(\) - updateStartedAt <= UPDATE_RETRY_MS/,
    'guarded to one hand-off per retry window');
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

test('the hand-off names a TASK, so a wrong script path is no longer expressible', () => {
  /**
   * WHAT THIS USED TO GUARD, and why the class is now closed rather than the guard dropped.
   *
   * 2026-08-11: the runner logged "handing off to auto-update.ps1", the script never ran,
   * and logs\auto-update.log did not exist — a wrong `-File` path makes PowerShell exit
   * immediately with a message thrown away by `stdio: 'ignore'`. `process.cwd()` happens to
   * be right when start-all launches the poller and wrong the moment anything else does, so
   * the correctness of the path depended on who started us.
   *
   * The hand-off passes a TASK NAME now, not a path, so there is no cwd-dependent `-File`
   * left to get wrong. The failure mode it replaces is a wrong task NAME, which
   * worker/update-trigger.test.mts pins against the installer.
   *
   * The lesson still bites elsewhere and is NOT retired: `auto-update.ps1`'s own `$log` was
   * relative until 2026-08-14 and silently wrote nothing on the on-demand path. That
   * assertion lives below and stays.
   */
  const block = code(handoffBlock(readFileSync(HANDOFF, 'utf8')));
  assert.ok(!/process\.cwd\(\)/.test(block), 'nothing here may depend on the working directory');
  assert.ok(!/'-File'/.test(block),
    'a -File path is the cwd-dependent shape this replaced; the launch takes a task name');
  assert.match(block, /'\/Run', '\/TN', UPDATE_TASK/, 'the task is named, not a script located');
});

test('a hand-off that cannot start says so', async () => {
  // Two silent failures, both closed here. A missing script was launched at anyway; and
  // spawn() reports ENOENT via an 'error' EVENT, not by throwing — so the try/catch never
  // saw it, and an 'error' with no listener would take the whole runner down.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(HANDOFF, 'utf8');
  const block = handoffBlock(runner);
  // ~~`fs.existsSync(script)`~~ — there is no script path to check any more. That guard
  // covered "launched at a file that is not there", which a task NAME cannot express; a
  // missing task surfaces as a non-zero `schtasks` exit instead, asserted below.
  assert.match(block, /t\.on\('error'/, "spawn's error event has a listener");
  assert.match(block, /t\.on\('exit'/, 'and a non-zero exit is what a missing task looks like');
  // Every failure path resets the retry clock — a hand-off that never started must be
  // retried, or the poller stands down for UPDATE_RETRY_MS over nothing.
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

test('a hand-off that cannot start still cannot fail silently', () => {
  // `stdio: 'ignore'` made "started and died immediately" identical to "never started", and
  // that ambiguity is what made 2026-08-11 take all night. It applies unchanged to
  // `schtasks`, which reports "the system cannot find the file specified" for an
  // unregistered task and "access is denied" for a permissions problem — different fixes,
  // the same silence if discarded.
  const block = handoffBlock(readFileSync(HANDOFF, 'utf8'));
  assert.ok(!/stdio: 'ignore'/.test(block), "the child's output must go somewhere readable");
  assert.match(block, /update-spawn\.log/, 'and it goes to a named file');
  // Written BEFORE the spawn, so the file exists even when the launch is what fails —
  // which turns "no file" into a single unambiguous meaning.
  //
  // ON COMMENT-STRIPPED SOURCE. The first version searched the raw block and matched
  // `spawn('powershell'` inside the COMMENT explaining what was removed — 1568 against the
  // real call at 5099, so the ordering read backwards and it failed against correct code.
  // This file's own helper exists for exactly that, and the same mistake has now been made
  // in three separate guards this session.
  const stripped = code(block);
  const marker = stripped.indexOf('appendFileSync');
  assert.ok(marker > 0 && marker < stripped.indexOf('spawn('), 'the marker precedes the spawn');
});

test('the launch is not a detached child — it is not our child at all', () => {
  /**
   * `detached: true` means DETACHED_PROCESS on Windows — the child gets no console — and a
   * `powershell -File` started that way produced literally nothing on 2026-08-11: no output,
   * no error, no auto-update.log, while the identical command by hand ran fine.
   *
   * That is still the reason NOT to reach for `detached` as the fix for the job-object
   * problem: it is the textbook answer, it was tried here, and it failed in a way nobody
   * ever explained. Handing the launch to the Task Scheduler sidesteps the question — the
   * process is not ours to detach.
   */
  const block = code(handoffBlock(readFileSync(HANDOFF, 'utf8')));
  assert.ok(!/detached: true/.test(block),
    'a detached child has no console and was measured not to run; and the launch should not ' +
    'be a child of ours in the first place');
  assert.ok(!/spawn\(\s*'powershell'/.test(block),
    'spawning PowerShell ourselves is the job-object bug of 2026-08-20');
});

test('the launch reports how it ended, to the file and not just the console', () => {
  // "Ran and died silently" and "never ran" are identical without an exit status, and a
  // failure reported only to a console nobody can copy is how this stayed invisible for
  // several rounds. `schtasks` makes the status sharper, not less necessary: it exits in
  // milliseconds having only ASKED the scheduler to start the task, so a non-zero code means
  // the task did not start at all.
  const block = handoffBlock(readFileSync(HANDOFF, 'utf8'));
  assert.match(block, /t\.on\('exit'/, 'the exit status is recorded');
  // Match the REPORTER, not merely the string: the pre-spawn marker also calls
  // appendFileSync(spawnLog, ...), so a looser assertion passes with the reporter gutted.
  //
  // AND `[\s\S]*?` IS NOT A BOUND. Lazy is not the same as scoped: with the arrow's body
  // emptied the match simply ran ON, past the closing brace, and found the marker's own
  // appendFileSync — so the mutation "note only logs to the console" survived. Slice the
  // function and assert inside it.
  const noteAt = block.indexOf('const note = (line) => {');
  assert.ok(noteAt > -1, 'the reporter must exist');
  // MATCHED BRACES, not a text sentinel. The previous bound was `'\n    };'`, which the
  // gutted one-liner `const note = (line) => { log(...); };` simply does not contain — so
  // indexOf found the NEXT one further down the file and the assertion ran past the function
  // AGAIN, into the marker's own appendFileSync. Second time the same mutation survived the
  // same way; a bound that depends on how the code is FORMATTED is not a bound.
  const noteBody = braced(block, noteAt);
  assert.match(noteBody, /appendFileSync\(spawnLog/,
    'the failure reporter writes to the file, not only the console');
  assert.match(block, /t\.on\('error'/, 'as does a failure to start');
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

  // It must go through the two scripts that own the stop-then-start order, never launch a
  // payload itself: start-all.bat for a dark box, restart-rc.ps1 for the RC pair alone.
  assert.match(code, /start-all\.bat/, 'a dark box must be recovered through start-all.bat');
  assert.match(code, /restart-rc\.ps1/, 'the RC pair alone must go through restart-rc.ps1');
  assert.ok(
    !/\bnpm start\b|supervise\.ps1/.test(code),
    'never launch the payloads directly — those two scripts own the stop-then-start order',
  );

  /**
   * EACH PAYLOAD SEPARATELY. This asked "is ANYTHING running?" for the first hours of its
   * life, which is the exact failure it was written to end: the rec.gov bot and the RC pair
   * are different processes, and `autocart.bot` stayed green through the RC runner's death
   * on both 08-07 and 08-11 for precisely that reason. A union count would have read the
   * outage this script exists for — bot.mjs up, keep-warm and hold runner dead, three holds
   * queued for 08:00 — as healthy, and exited silently every five minutes all night.
   */
  for (const p of ['bot\\.mjs', 'broker\\.mjs', 'rc-keepwarm\\.mjs', 'rc-hold-runner\\.mjs']) {
    assert.ok(code.includes(p), `the watchdog must look for ${p} by name`);
  }
  assert.match(code, /foreach\s*\(\$name in \$PAYLOADS\.Keys\)/i,
    'each payload must be checked on its own, not counted into a union');
  assert.match(code, /\$missing\.Count -eq 0[\s\S]{0,400}?exit 0/,
    'and the silent-healthy exit must require NOTHING missing');

  // START-ALL IS NOT THE ANSWER TO EVERY GAP. It stops everything first, which closes the
  // Chromium the RC token lives in — so it is for a dark box, and the targeted lever is for
  // the RC pair. Spending a live session to restart a dead broker is a bad trade at 03:00
  // and a terrible one at 07:50.
  const dark = code.indexOf('$missing.Count -eq $PAYLOADS.Count');
  assert.ok(dark > 0, 'the blunt lever must be gated on the box being genuinely dark');
  assert.ok(dark < code.indexOf('start-all.bat', dark - 1) + 400,
    'and start-all must sit inside that branch');

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

test('auto-update.ps1 writes its log to an ABSOLUTE path, not one relative to the cwd', async () => {
  /**
   * THE ON-DEMAND UPDATE WROTE NO LOG AT ALL (2026-08-14).
   *
   * `$log` was "logs\auto-update.log" — relative to whatever directory the process happened
   * to be in. The Windows Scheduled Task starts in the bot directory, so the timer-driven
   * path wrote correctly and this looked healthy for weeks. `bot.mjs` spawns the updater with
   * NO `cwd` option, so the ON-DEMAND path inherited the poller's directory and every
   * Add-Content failed with
   *
   *   Could not find a part of the path 'C:\Users\Tyler\campsite-finder\logs\auto-update.log'
   *
   * Observed live: an update requested from the admin page stopped every process on the box,
   * left the checkout untouched, and recorded not one word about why — in the log CLAUDE.md
   * names as the thing to read before trusting the update path.
   *
   * It compounds, which is why this matters more than one missing file: the updater's stdout
   * goes to logs\update-spawn.log, written by `bot.mjs` — a process `stop-all` KILLS on its
   * way through — so that log necessarily ends at the stop. Between the two, the on-demand
   * update had no durable record anywhere, and it has twice had to be diagnosed by inference.
   *
   * The two paths are the two-halves trap again: the one that works is not the one that
   * carries the diagnostics.
   */
  const up = await miniPc('auto-update.ps1');

  // The log must be anchored to the script's own location, which cannot move under it.
  assert.match(up, /\$logDir\s*=\s*Join-Path\s+\$botDir\s+"logs"/,
    'the log directory must be derived from $botDir, which comes from $PSScriptRoot');
  assert.match(up, /\$log\s*=\s*Join-Path\s+\$logDir\s+"auto-update\.log"/,
    '$log must be an absolute path built from that directory');

  // And no assignment may go back to a bare relative path. Comments are stripped first: the
  // one above quotes the broken form to explain it, and a test that failed on its own
  // explanation would be "fixed" by deleting the explanation.
  const code = up.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/\$log\s*=\s*"logs\\/.test(code),
    '$log must never be relative to the working directory again');
  assert.ok(!/New-Item[^\n]*-Path\s+"logs"/.test(code),
    'the logs directory must be created by absolute path too');
});

test('stop-all reports processes it cannot SEE, and fails on a bound broker port', async () => {
  /**
   * A PROCESS WE CANNOT SEE IS NOT A PROCESS THAT IS NOT THERE (2026-08-14).
   *
   * Every filter in stop-all.ps1 is `$_.CommandLine -and $_.CommandLine -match ...`. An
   * unelevated WMI query cannot read `CommandLine` for a process in another security
   * context — it returns `$null` — so that leading `-and` silently DROPS it. A `broker.mjs`
   * started from an elevated prompt was therefore INVISIBLE: excluded from the count,
   * from every kill, and from the re-check, so the script truthfully logged "all stopped."
   *
   * The cost then landed in a DIFFERENT process. The orphan held port 8787, every
   * relaunched broker died in a second with EADDRINUSE, and supervise.ps1 gave up after
   * five tries — so the symptom appeared where the cause was not, and it read as "the
   * broker is broken". Same family as the Chromium children the kill pattern could not
   * match, and as `kill-chrome`'s "SURVIVED" line: a failure that prints like a success.
   */
  const s = await miniPc('stop-all.ps1');
  const body = code(s);

  // BOTH CHECKS MOVED INTO FUNCTIONS ON 2026-08-15 so the "nothing to stop" path could
  // reach them too — see the reachability test above. These assertions follow the behaviour
  // into its new home rather than asserting the old inline shape, which is the mistake
  // control-channel.test.mts records: guards left watching an empty room pass on a file
  // that no longer does the thing.
  //
  // The port is PROOF and must therefore fail. Nothing else on that box binds it, so a
  // listener after the stop is ours by construction — no command line required, and no
  // guessing from an image name, which this file forbids elsewhere for good reason.
  assert.match(body, /Get-NetTCPConnection[^\n]*LocalPort/, 'it must check the broker port');
  assert.match(body, /\$BROKER_PORT\s*=\s*8787/, 'and know which port that is');
  // `$false` on a free port and `$true` once it has named the survivor, so every caller
  // branches on the same verdict instead of re-deriving it.
  const portIdx = body.indexOf('function Test-BrokerStillBound');
  assert.ok(portIdx > 0, 'the port check must exist');
  const portFn = body.slice(portIdx, portIdx + 900);
  assert.match(portFn, /stillBound\.Count -eq 0[^\n]*return \$false/,
    'a free port is the only way out without a verdict');
  assert.match(portFn, /taskkill \/PID/, 'and a bound one must name the fix');
  // EVERY caller of it must exit non-zero, or the proof is gathered and thrown away.
  const portCalls = body.split('if (Test-BrokerStillBound)').length - 1;
  assert.ok(portCalls >= 2, 'both the quiet path and the stop path must consult it');
  for (const part of body.split('if (Test-BrokerStillBound)').slice(1)) {
    assert.match(part.slice(0, 40), /\{\s*exit 1/,
      'a bound broker port must FAIL, or callers relaunch into EADDRINUSE');
  }

  // The unreadable processes only WARN. Failing on them would refuse every launch for the
  // life of the box, because a node.exe we cannot inspect may belong to the person using it.
  assert.match(body, /-not \$_\.CommandLine/, 'it must look for processes with no readable command line');
  const blindIdx = body.indexOf('function Write-BlindNote');
  assert.ok(blindIdx > 0, 'and report them');
  const blindBlock = body.slice(blindIdx, blindIdx + 900);
  assert.ok(!/exit 1/.test(blindBlock),
    'an unreadable command line must NOT fail the stop — that is somebody else\'s process too');
  assert.match(blindBlock, /elevated/i, 'and it must say why it cannot see them');

  // Still never by image name: the scan is scoped to naming them, never to killing them.
  const killByImage = /Stop-Process[^\n]*\$blind|taskkill[^\n]*\/IM/i;
  assert.ok(!killByImage.test(body), 'it must not kill anything matched only by image name');
});
