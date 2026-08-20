// THE UPDATER MUST NOT BE OUR CHILD.
//
// "Update now" set the flag, a poller claimed it, spawned `auto-update.ps1`, and the updater
// died partway through the stop-all it was performing — twice on 2026-08-20, with logs
// identical in shape:
//
//     09:16:36 [auto-update] updating b9a1dba -> 940acf7
//     09:16:37 [stop-all] stopping 26 process(es).
//     09:16:40 [stop-all]   stopping node.exe pid 10732 (payload)   <- last line ever
//
//     09:36:37 [auto-update] updating b9a1dba -> 940acf7
//     09:36:37 [stop-all] stopping 24 process(es).
//     09:36:38 [stop-all]   stopping node.exe pid 11924 (payload)   <- last line ever
//
// Both end on a `node.exe` kill, midway through the list. No git reset, no restart, no
// rollback, no refusal. The watchdog then restarted everything on the OLD checkout, so every
// health check read green over a box that would not update.
//
// THE OLD CODE'S REASONING WAS THE DEFECT, and it is worth stating precisely because half of
// it is still true. It argued the child was safe because (a) "killing a parent on Windows
// does NOT kill its children" and (b) stop-all matches the bot's own scripts, which
// `auto-update.ps1` is not. (b) holds — the test below pins it, so nobody "fixes" this by
// adding the updater to the kill list. (a) is true of a raw Win32 TerminateProcess and false
// of a libuv-spawned child: on Windows `uv_spawn` puts every non-detached child in the
// parent's Job Object. Ancestry is `cmd.exe (npm start) -> node.exe (bot.mjs) ->
// powershell.exe (auto-update.ps1)`, and stop-all kills the first two.
//
// So the launch is handed to the Task Scheduler, whose processes are not our descendants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/auto-cart-bot/control-channel.mjs', 'utf8');
/** Comment lines stripped: the new comments quote the very shapes these tests forbid. */
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const STOP_ALL = readFileSync('scripts/auto-cart-bot/mini-pc/stop-all.ps1', 'utf8');
const GUARD = readFileSync('scripts/auto-cart-bot/update-guard.mjs', 'utf8');

test('the updater is started by Windows, not spawned as our child', () => {
  assert.match(code, /spawn\('schtasks', \['\/Run', '\/TN', UPDATE_TASK\]/,
    'the launch must go through the Task Scheduler');
  assert.ok(!/spawn\(\s*'powershell'/.test(code),
    'nothing here may spawn powershell — a non-detached child dies inside our job object ' +
    'when stop-all kills npm start and bot.mjs, which is the 2026-08-20 failure');
});

test('the task name matches the one actually registered', () => {
  // Two files, one string, and a mismatch fails as "the system cannot find the file
  // specified" from a process nobody is watching — which reads exactly like the task not
  // existing at all.
  const install = readFileSync('scripts/auto-cart-bot/mini-pc/install-autoupdate.bat', 'utf8');
  const registered = /set TASK=(.+)/.exec(install)?.[1]?.trim();
  assert.ok(registered, 'install-autoupdate.bat must still name the task');
  const used = /const UPDATE_TASK = '([^']+)'/.exec(code)?.[1];
  assert.equal(used, registered,
    `the trigger asks for "${used}" and the installer registers "${registered}"`);
});

test('the poller no longer claims — the claim it took blocked the path that works', () => {
  /**
   * The claim was taken by a process the update was about to kill, so it sat held by nobody
   * for its full 20-minute TTL — and the Scheduled Task, the one launcher that survives a
   * stop-all, spent that window refusing ITSELF:
   *
   *     [update-guard] SKIP - another process holds the update claim (or we could not ask)
   *
   * at 09:21, 09:26, 09:31, 09:41, 09:46 and 09:51 on 2026-08-20. So the claim did not
   * merely fail to help; it blocked the recovery. The task claims for itself one layer down,
   * held by the process actually doing the work.
   */
  assert.ok(!/updateClaim: actor/.test(code),
    'the poller must not claim before triggering — a claim held by a process the update ' +
    'kills blocks the Scheduled Task for the full TTL');
  // And the guard must still claim, or nothing does and two updaters can race one checkout.
  assert.match(GUARD, /requested && !force && !preClaimed/,
    'update-guard.mjs must still take the claim itself');
});

test('nothing passes -Claimed any more, so claim-then-spawn cannot come back quietly', () => {
  // `-Claimed` stays supported in auto-update.ps1 as an escape hatch, but it has no caller.
  // Its presence at a call site would mean somebody had reintroduced claim-then-spawn — the
  // pattern that deadlocked on-demand updates on 2026-08-12 AND blocked the task on 08-20.
  assert.ok(!/'-Claimed'/.test(code),
    'a caller passing -Claimed means the claim-then-spawn pattern is back');
});

test('stop-all still does NOT match the updater by name', () => {
  // The half of the old reasoning that was correct, pinned so the next reader does not
  // "fix" this by adding auto-update.ps1 to the kill list — which would make the updater
  // kill itself deliberately rather than by accident.
  const children = /\$CHILDREN = '([^']+)'/.exec(STOP_ALL)?.[1];
  assert.ok(children, 'stop-all must still define $CHILDREN');
  assert.ok(!/auto-update/.test(children),
    'the updater must never be in the stop list — it is the thing performing the stop');
});

test('a failed trigger is reported and is NOT fatal to the update', () => {
  // schtasks exits in milliseconds because it only asks the scheduler to start the task, so
  // unlike the old spawn there is no ambiguity between "ran and died" and "never ran". And
  // the flag stays pending, so the task's own five-minute tick still picks it up: the worst
  // case is "Update now" taking five minutes, which is the status quo this lever improves on.
  const at = code.indexOf('function triggerUpdater()');
  assert.ok(at > -1, 'triggerUpdater must exist');
  const body = code.slice(at);
  assert.match(body, /t\.on\('error'/, "spawn reports ENOENT via an event, not a throw");
  assert.match(body, /t\.on\('exit'/, 'the exit status is the whole report');
  // SCOPED TO EACH HANDLER, not to the function. The first version asserted
  // `/updateStartedAt = 0/` against the whole body and SURVIVED a mutation that deleted it
  // from the exit path — because the error handler and the catch still carry one. A guard
  // that matches a token appearing three times cannot tell you which of the three is gone.
  for (const [name, anchor] of [
    ['non-zero exit', /t\.on\('exit'[\s\S]*?\n      \}\);/],
    ['spawn error', /t\.on\('error'[\s\S]*?\n      \}\);/],
  ] as const) {
    const handler = anchor.exec(body)?.[0];
    assert.ok(handler, `could not isolate the ${name} handler`);
    assert.match(handler, /updateStartedAt = 0/,
      `the ${name} path must clear the retry stamp, or the next poll stands down for ` +
      'UPDATE_RETRY_MS over an update that never started');
  }
  assert.ok(!/spawn\('powershell'|-File.*auto-update\.ps1/.test(body),
    'there must be NO fallback to the old spawn — that path is the bug');
});

test('the trigger writes to a log the update itself does not destroy', () => {
  // update-spawn.log is written by THIS process, which stop-all kills — so it necessarily
  // ends at the stop, by construction. That is survivable here only because schtasks
  // finishes before the task does any stopping. The durable record is auto-update.log,
  // written by the task, and the log line says so rather than leaving a reader to wonder
  // why update-spawn.log stops mid-update.
  const at = code.indexOf('function triggerUpdater()');
  const body = code.slice(at, at + 2000);
  assert.match(body, /update-spawn\.log/, 'the trigger must leave a local trace');
  assert.match(body, /auto-update\.log/,
    'and must point the reader at the log the task writes, which outlives the stop');
});
