/**
 * The watchdog after 2026-08-17: it reports that it ran, and it can be triggered two ways.
 *
 * That morning the RC hold runner hard-crashed at 05:36:31 and nothing brought it back for
 * two and a half hours. Two defects, and this file guards both:
 *
 *  1. THE WATCHDOG NEVER RAN, and nothing could tell. It is deliberately silent when the box
 *     is healthy, so "ran and found nothing wrong" and "never ran" write the identical thing
 *     to restarts.log — nothing. The only reason the outage was diagnosable is that
 *     `auto-update.log`, a different task, happens to log every run.
 *
 *  2. IT HAD ONLY ONE TRIGGER, and that trigger is what failed. `bot.mjs` is now a second
 *     one — it has stayed up through every RC outage there has been — and the script
 *     rate-limits ITSELF so neither trigger has to know the other exists.
 *
 * A PER-PAYLOAD RELAUNCH WAS BUILT HERE AND BACKED OUT, which is worth recording so it is
 * not re-proposed as new. It would have saved the keep-warm's live session when only the
 * hold runner is dead — but it breaks the invariant `update-guard.test.mts` pins, that only
 * `start-all.bat` and `restart-rc.ps1` launch payloads because they own the stop-then-start
 * order that makes a duplicate structurally impossible. And it was not needed: the existing
 * `restart-rc.ps1` branch WOULD have recovered 2026-08-17 had the watchdog run at all, and
 * the session it costs is one the renewal now re-mints unattended. The defect was the
 * trigger, not the lever.
 *
 * Source scans, because there is no PowerShell on the machine this repo is written from —
 * the same constraint `update-guard.test.mts` and `supervised-launch.test.mts` work under.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BOT = path.join(import.meta.dirname, '..', 'scripts', 'auto-cart-bot');
const read = (p: string) => readFileSync(path.join(BOT, p), 'utf8');

/** Comment lines are stripped before any ABSENCE assertion: the new comments quote the
 *  shapes being forbidden, and a test that failed on its own explanation would be "fixed"
 *  by deleting the explanation. */
const code = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*|REM\b)/i.test(l)).join('\n');

const watchdog = () => read(path.join('mini-pc', 'watchdog.ps1'));

test('the watchdog reports that it fired, on the healthy path too', () => {
  const body = code(watchdog());
  assert.match(body, /function Send-Beat/, 'defines a beat');
  // THE HEALTHY PATH IS THE ONE THAT MATTERS. A watchdog only reporting when it acts is
  // exactly as invisible as one that reports nothing: on 2026-08-17 it would have had
  // nothing to act on until 05:36, and the silence before that is the evidence we needed.
  const healthy = body.slice(body.indexOf('$missing.Count -eq 0'));
  const beatInHealthy = healthy.slice(0, healthy.indexOf('exit 0'));
  assert.match(
    beatInHealthy, /Send-Beat/,
    'the all-healthy branch must still beat, or a silent watchdog stays indistinguishable from a healthy box',
  );
});

test('the beat is defined before it is used', () => {
  // PowerShell runs top-down. `auto-update.ps1` once called Report-Applied above its own
  // definition and would have died with "not recognized" on the path that mattered.
  const body = watchdog();
  assert.ok(
    body.indexOf('function Send-Beat') < body.indexOf('Send-Beat "healthy'),
    'Send-Beat must be defined above its first call',
  );
});

/**
 * TWO TRIGGERS ARE ONLY SAFE IF THE SCRIPT IS. bot.mjs now fires this as well as the
 * Scheduled Task, and two concurrent relaunches of one payload is the failure that matters.
 * The guard lives in the SCRIPT so neither caller has to know the other exists — the
 * forgotten copy is by definition the one running when the other is dead.
 */
test('the watchdog rate-limits itself so a second trigger cannot double up', () => {
  const body = code(watchdog());
  // ASSERT THE ASSIGNMENT, NOT THE TOKEN. The first version of this test matched
  // /\$MIN_GAP_SEC/ anywhere, and a mutation that renamed the ASSIGNMENT left the token
  // behind in the comparison two lines below — so the guard passed against a watchdog with
  // no gate at all. Seventh time a guard here has needed re-doing because it anchored on the
  // wrong thing; the rule is to pin the thing that does the work.
  assert.match(body, /\$MIN_GAP_SEC\s*=\s*\d+/, 'the minimum gap is actually assigned');
  const gate = body.search(/\$MIN_GAP_SEC\s*=\s*\d+/);
  const firstAction = body.indexOf('$missing = Get-Missing');
  assert.ok(gate < firstAction, 'and the gate is above any action, or it gates nothing');
  // The gate must be able to STOP the run, not merely compute an age.
  const gateBlock = body.slice(gate, firstAction);
  assert.match(gateBlock, /Test-Path \$gate/, 'reads the last-run stamp');
  assert.match(gateBlock, /exit 0/, 'and exits early when the run is too soon');
  assert.match(gateBlock, /Set-Content -Path \$gate/, 'and stamps it, or every run looks like the first');
});

/**
 * THE FIX PRESENT BUT INERT is the shape that passes review and changes nothing — `6006428`
 * only touched the copy, and the `--claimed` poller omission shipped the same way. The
 * trigger module can be perfect while nothing calls it.
 */
test('bot.mjs actually schedules the watchdog trigger', () => {
  const body = code(read('bot.mjs'));
  assert.match(body, /makeWatchdogTrigger/, 'imports the trigger');
  assert.match(body, /const triggerWatchdog = makeWatchdogTrigger\(/, 'builds one');
  assert.match(
    body, /setInterval\(triggerWatchdog, WATCHDOG_TRIGGER_MS\)/,
    'and puts it on an interval — a trigger nothing fires is the inert-fix shape',
  );
});

test('the trigger is windows-only and never takes the rec.gov bot down with it', () => {
  const body = code(read('watchdog-trigger.mjs'));
  assert.match(body, /platform !== 'win32'/, 'refuses off Windows rather than ENOENT-ing in CI');
  assert.match(body, /catch \(err\)/, 'and swallows its own failures');
  // bot.mjs's job is carting rec.gov sites. A favour to its siblings that can kill it is
  // not a favour worth having.
  assert.doesNotMatch(body, /throw /, 'the trigger must never throw at its caller');
});

test('the task beat reporter never fails its caller', () => {
  const body = code(read('report-task-beat.mjs'));
  // Every terminal path exits ZERO. A watchdog that does not run because its telemetry threw
  // would be a self-inflicted copy of the outage this reports.
  assert.doesNotMatch(body, /exitWhenDrained\(\s*[1-9]/, 'no non-zero exit path');
  assert.match(body, /loadEnv\(import\.meta\.url\)/,
    'a Scheduled Task has no parent environment — without this it is a 401 that reads as a missing task');
});
