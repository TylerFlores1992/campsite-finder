/**
 * A SUPERVISED PROCESS THAT NEVER STARTED, AND FOUR SAFEGUARDS THAT ALL READ IT AS HEALTHY.
 *
 * On 2026-08-14 the ReserveCalifornia keep-warm and hold runner spent hours as idle Node
 * REPLs, with two holds queued for the next 08:00 release, and every instrument said the
 * box was fine. One quoting bug did it:
 *
 *   Start-Process -FilePath powershell -ArgumentList @(
 *     "-File", "...\supervise.ps1", "-Name", "rc-keepwarm", "-Command", "node rc-keepwarm.mjs")
 *
 * Start-Process JOINS AN ARRAY WITH SPACES AND QUOTES NOTHING. The child powershell was
 * handed `-Command node rc-keepwarm.mjs`, bound -Command to `node`, and supervise.ps1 ran
 * `cmd /c "node"` - the REPL, which starts, prints a banner and never exits.
 *
 * WHY IT WAS INVISIBLE, and why each of these is a separate test:
 *   1. supervise.ps1 only speaks when a child EXITS. A REPL never does, so restarts.log
 *      went silent - indistinguishable from a healthy night.
 *   2. watchdog.ps1 matched `rc-keepwarm\.mjs` against every command line, and the broken
 *      SUPERVISOR's own command line still contained it in full.
 *   3. `beat_at` is stamped on any authorized GET of the hold feed, and update-guard.mjs
 *      makes one every five minutes, so `autocart.rc_runner` stayed green over a dead
 *      runner. Measured: the heartbeat advanced every 301s, the scheduled task's tick.
 *   4. `list-processes` shows the supervisor, which looks like the payload at a glance.
 *
 * The evidence was in the box's own restarts.log, where the same supervise.ps1 logged
 * `starting: $Command` for two different callers and they disagreed:
 *     21:46:47 [supervise:rc-keepwarm] starting: node rc-keepwarm.mjs   <- start-all.bat
 *     21:48:48 [supervise:rc-keepwarm] starting: node                   <- restart-rc.ps1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'scripts/auto-cart-bot/mini-pc';
const read = (f: string) => readFileSync(`${DIR}/${f}`, 'utf8');
/** Comment lines are documentation, not behaviour - and several of these files document
 *  the very shapes being forbidden. Asserting over them would fail on the explanation. */
const code = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*|REM\b)/i.test(l)).join('\n');

/**
 * THE CORE RULE: whatever the supervisor is told to run must arrive as ONE argument.
 *
 * Expressed as "-Command is followed by whitespace and then a quote", which is what every
 * working launcher already does and what the array form provably does not: in
 * `"-Command", "node rc-keepwarm.mjs"` the character after `-Command` is its own closing
 * quote, with no space, so the broken shape is caught and the correct shape is not.
 */
test('every launcher passes -Command as a single quoted argument', () => {
  const files = readdirSync(DIR).filter((f) => /\.(ps1|bat)$/.test(f));
  let checked = 0;
  for (const f of files) {
    for (const line of code(read(f)).split('\n')) {
      for (const m of line.matchAll(/-Command(.|$)/g)) {
        checked++;
        assert.match(
          m[1]!, /\s/,
          `${f}: -Command must be followed by a space and a quoted argument, got ${JSON.stringify(line.trim())}. ` +
          'An array element like "-Command", "node x.mjs" is joined UNQUOTED by Start-Process, ' +
          'so the supervisor receives -Command node and runs the REPL.',
        );
        const after = line.slice(line.indexOf(m[0]!) + '-Command'.length);
        assert.match(
          after, /^\s+["']/,
          `${f}: the value after -Command must be quoted, got ${JSON.stringify(line.trim())}`,
        );
      }
    }
  }
  assert.ok(checked >= 6, `expected to find the launcher lines, only saw ${checked}`);
});

/**
 * The array form is the specific construct that cannot carry a quoted argument, so it is
 * forbidden by name as well. Belt and braces on purpose: the rule above is about a
 * character, and a future edit could satisfy it while reintroducing the mechanism.
 */
test('no mini-pc script builds a supervisor launch from an argument ARRAY', () => {
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.ps1'))) {
    const body = code(read(f));
    if (!body.includes('supervise.ps1')) continue;
    assert.ok(
      !/-ArgumentList\s*@\(/.test(body),
      `${f}: Start-Process -ArgumentList @(...) joins with spaces and quotes nothing. ` +
      'Build the whole command line as one already-quoted string instead.',
    );
  }
});

test('restart-rc relaunches BOTH RC processes, by name', () => {
  // The pair are relaunched through one helper so the quoting cannot be right in one and
  // wrong in the other - which is exactly how rc-test-login.bat kept an unsupervised
  // relaunch for three days after rc-login.bat was fixed.
  const body = code(read('restart-rc.ps1'));
  assert.match(body, /supervise\.ps1/, 'relaunched under the supervisor');
  for (const name of ['rc-keepwarm', 'rc-hold-runner']) {
    assert.match(
      body, new RegExp(`Start-Supervised\\s+"${name}"\\s+"node ${name}\\.mjs"`),
      `${name} must be relaunched with its script name`,
    );
  }
});

/**
 * THE WATCHDOG MUST NOT COUNT A SUPERVISOR AS ITS PAYLOAD.
 *
 * This is the same failure as the union count the watchdog shipped with and was fixed for
 * hours later: healthy by construction in the outage it exists for. With an unquoted
 * -Command the supervisor's command line still reads
 *     ... -Name rc-keepwarm -Command node rc-keepwarm.mjs
 * so `rc-keepwarm.mjs` is present while nothing is running it.
 */
test('the watchdog ignores supervisor processes when looking for payloads', () => {
  const body = code(read('watchdog.ps1'));
  assert.match(
    body, /CommandLine -notmatch \$SUPERVISOR/,
    'Get-Missing must exclude supervise.ps1 processes, or a supervisor whose payload never ' +
    'started reads as the payload running',
  );
  assert.match(body, /\$SUPERVISOR\s*=\s*'supervise\\\.ps1'/, 'and the exclusion is the supervisor script');
  // The exclusion has to be applied where the processes are gathered, not merely defined -
  // a guard that is present and inert is the version that passes review unchanged.
  const gather = body.slice(body.indexOf('function Get-Missing'));
  assert.ok(gather.indexOf('$SUPERVISOR') > 0, 'and Get-Missing actually uses it');
});
