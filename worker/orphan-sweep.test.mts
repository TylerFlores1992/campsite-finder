// KILLING A CHROMIUM ITS OWNER LEFT BEHIND — and only ever that one.
//
// On 2026-08-18 an orphaned renderer reached 25 GB and took the box to 94% COMMIT, the level
// at which Windows stops scheduling tasks. The size guard fired FIVE times and freed nothing:
// `max_pid` was 13004 in every sample across three recycles, and at 20:02:40 — one second
// after a browser opened at 20:02:39 — pid 13004 was already 4,953 MB. A renderer born that
// second cannot be five gigabytes, so it predated the reopen. `ctx.close()` closed a healthy
// browser while `rcFamilyMb()` counted the corpse.
//
// TWO PROPERTIES CARRY ALL THE RISK, and neither is visible by reading the call site:
//
//   1. WHERE IT RUNS. After the profile lock, before the launch. `rc-hold-runner.mjs` drives
//      the SAME directory, so a sweep on plain process start could land at 08:00:00 on the
//      Chromium that is carting a site. The lock is the entire safety argument: once we hold
//      it, the runner does not, so anything still on that profile is owned by nobody.
//   2. WHAT IT MATCHES. `\S*`, never `[^"]*` — Chrome re-quotes the path for its renderer and
//      GPU children, so a class excluding `"` kills the parent and leaves the process holding
//      the gigabytes alive. That exact bug shipped in both stop scripts. (Asserted in
//      `chromium-attribution.test.mts`, alongside every other kill pattern in the repo.)
//
// The parsing is pure and tested here directly, because there is no PowerShell on the machine
// this repo is written from — the same split as `parseSample`, and for the same reason: the
// producer and its parser drifted apart silently once already.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSweep, sweepOrphanChromium, RC_PROFILE_PATTERN } from '../scripts/auto-cart-bot/orphan-sweep.mjs';

const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const code = KEEPWARM.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const SWEEP = readFileSync('scripts/auto-cart-bot/orphan-sweep.mjs', 'utf8');

test('a scan that never completed is not a scan that found nothing', () => {
  // The house failure, and the one this module is most likely to reproduce: a zero recorded
  // for a scan that never ran reads as evidence of health. `DONE` is the only thing that
  // makes a reading real.
  assert.equal(parseSweep('').ran, false, 'empty output must not read as a clean sweep');
  assert.equal(parseSweep('B|0\nN|0').ran, false, 'counts without DONE are an incomplete run');
  assert.equal(parseSweep('B|0 N|0 DONE'.replace(/ /g, '\n')).ran, true);
});

test('a pid that survived is not counted as killed', () => {
  const r = parseSweep(['B|0', 'N|3', 'P|11', 'P|22', 'P|33', 'MB|4096', 'S|22', 'DONE'].join('\n'));
  assert.deepEqual(r.killed, [11, 33], 'a survivor must come out of the killed list');
  assert.deepEqual(r.survived, [22]);
  assert.equal(r.mb, 4096);
  // The 2026-08-12 misreading: `kill-chrome` counted before and after and called a clean kill
  // plus a healthy restart "7 before, 7 after". Pids are what separate the two, so they are
  // what this reports.
});

test('a blind scan under-kills and can never over-kill', () => {
  // An unelevated WMI query reads $null for CommandLine on a process in another security
  // context. That is a third state — "could not see" — and it reported identically to "found
  // none" until 2026-08-15. Here it is SAFE by construction: an unreadable command line
  // cannot match the pattern, so the sweep does less, never more. The count is still surfaced
  // because the reading is short and the operator should know.
  const r = parseSweep(['B|4', 'N|0', 'DONE'].join('\n'));
  assert.equal(r.blind, 4);
  assert.deepEqual(r.killed, []);
  assert.match(SWEEP, /\$blind = @\(\$all \| Where-Object \{ -not \$_\.CommandLine \}\)/,
    'the blind count must be measured, not inferred');
});

test('the kill is scoped to the RC profile and nothing else', () => {
  const re = new RegExp(RC_PROFILE_PATTERN);
  const RC = String.raw`--user-data-dir=C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\.rc-bot-profile`;
  const RECGOV = String.raw`--user-data-dir=C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\profiles\user_42`;
  const PROBE = String.raw`--user-data-dir=C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\.rc-probe-profile`;
  const THEIRS = String.raw`--user-data-dir=C:\Users\Tyler\AppData\Local\Google\Chrome\User Data`;
  assert.ok(re.test(RC), 'the RC profile is the target');
  assert.ok(re.test(`--user-data-dir="${RC.slice('--user-data-dir='.length)}"`),
    "and Chrome's QUOTED child processes, which hold the memory");
  assert.ok(!re.test(RECGOV), 'never the rec.gov profiles — that regression is on the record');
  assert.ok(!re.test(PROBE), 'never rc-probe.mjs, which uses .rc-probe-profile');
  assert.ok(!re.test(THEIRS), "and never the browser of whoever is sitting at the machine");
});

test('the sweep is a no-op off Windows and never throws', async () => {
  // It sits between taking the lock and opening the browser, so a sweep that throws or hangs
  // is a keep-warm that never comes back — a worse outage than the one it prevents.
  assert.equal(await sweepOrphanChromium({ platform: 'linux' }), null);
  const exploded = await sweepOrphanChromium({
    platform: 'win32',
    exec: (_c: string, _a: string[], _o: unknown, cb: Function) => cb(new Error('spawn failed'), '', 'boom'),
  });
  assert.equal(exploded, null, 'a failed spawn returns null rather than throwing');
});

test('a failed sweep says so, and a clean one stays silent', async () => {
  const lines: string[] = [];
  await sweepOrphanChromium({
    platform: 'win32', log: (m: string) => lines.push(m),
    exec: (_c: string, _a: string[], _o: unknown, cb: Function) => cb(new Error('x'), '', 'access denied'),
  });
  assert.ok(lines.some((l) => /did not complete/.test(l) && /access denied/.test(l)),
    'the guard failing must be loud, and stderr is the only line that says why');

  const quiet: string[] = [];
  await sweepOrphanChromium({
    platform: 'win32', log: (m: string) => quiet.push(m),
    exec: (_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, 'B|0\nN|0\nDONE\n', ''),
  });
  // This runs on every reopen, many times an hour. A line each time would bury the events
  // worth reading — the same reason the wedge watchdog is quiet when healthy.
  assert.deepEqual(quiet, [], 'the ordinary path must print nothing');
});

test('killing something is reported, with the pids and the megabytes', async () => {
  const lines: string[] = [];
  await sweepOrphanChromium({
    platform: 'win32', log: (m: string) => lines.push(m),
    exec: (_c: string, _a: string[], _o: unknown, cb: Function) =>
      cb(null, ['B|0', 'N|2', 'P|13004', 'P|7', 'MB|25307', 'DONE'].join('\n'), ''),
  });
  const said = lines.join('\n');
  assert.match(said, /13004/, 'the pid is what makes the next occurrence diagnosable');
  assert.match(said, /25307 MB/, 'and what it reclaimed, so the log says what it ACHIEVED');
});

test('the sweep runs AFTER the lock and BEFORE the launch, on both keep-warm paths', () => {
  // THE PROPERTY THAT CARRIES THE RISK. `rc-hold-runner.mjs` drives the same profile, so a
  // sweep before the lock could kill the Chromium that is carting at 08:00:00. Both call
  // sites are pinned by ORDER, not merely by presence — a call in the right file and the
  // wrong place reads as correct in review.
  const sites: [string, string][] = [
    ['withProfile', 'async function withProfile('],
    ['warmResident', 'async function warmResident('],
  ];
  for (const [name, anchor] of sites) {
    const from = code.indexOf(anchor);
    assert.ok(from > -1, `could not find ${name}`);
    const body = code.slice(from, from + 3000);
    const lock = body.indexOf('waitForProfileLock(PROFILE_DIR');
    const sweep = body.indexOf('sweepOrphanChromium(');
    const launch = body.indexOf('launchPersistentContext(');
    assert.ok(lock > -1 && sweep > -1, `${name} must take the lock and then sweep`);
    assert.ok(lock < sweep,
      `${name}: sweeping before the lock could kill the hold runner's browser mid-cart`);
    if (launch > -1) {
      assert.ok(sweep < launch,
        `${name}: sweeping after the launch would target our own new browser`);
    }
  }
});

test('the hold runner does NOT sweep, and that is a decision', () => {
  // Spawning PowerShell costs a second or two on the one path where latency IS the product —
  // the measured carts are T+1.8s, T+43s and T+49s after a release. The keep-warm reopens on
  // every yield, guard trip and restart, so an orphan is reaped within minutes anyway. If the
  // runner ever needs this, the right shape is a sweep on a FAILED launch, not a spawn before
  // every cart. Pinned so the omission is re-taken deliberately rather than by whoever notices.
  const runner = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');
  assert.ok(!/sweepOrphanChromium/.test(runner),
    'if the runner should sweep, change this test and say why — do not add a PowerShell spawn ' +
    'to the cart path by accident');
});

test('the sweep only sleeps when it actually killed something', () => {
  // It runs on every reopen and the overwhelmingly common case is zero. An unconditional
  // two-second sleep would tax the keep-warm's whole cadence for an event that happens a few
  // times a day.
  const guard = SWEEP.indexOf('if ($ours.Count -gt 0) {');
  const sleep = SWEEP.indexOf('Start-Sleep');
  assert.ok(guard > -1 && sleep > guard, 'the sleep and re-check must sit inside the guard');
});

test('nothing is interpolated into the PowerShell from outside the module', () => {
  // `worker/bot-commands.test.mts` caught the first draft of kill-chrome interpolating its
  // argument into the script. The scope must choose between constants and contribute not one
  // character. Here the only interpolation is the module's own frozen constant.
  const ps = SWEEP.slice(SWEEP.indexOf('const PS = ['), SWEEP.indexOf("].join(' ')"));
  const interpolations = ps.match(/\$\{[^}]+\}/g) ?? [];
  assert.deepEqual(interpolations, ['${RC_PROFILE_PATTERN}'],
    'the only value placed into the script may be the fixed profile pattern');
});
