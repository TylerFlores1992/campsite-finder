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
  assert.match(sup, /STOPPING —/, 'and it stops loudly rather than silently continuing');
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
  const killIdx = up.indexOf("supervise\\.ps1");
  const resetIdx = up.indexOf('git reset --hard $after');
  assert.ok(killIdx > 0 && killIdx < resetIdx, 'supervisors are stopped before the checkout moves');
});
