/**
 * THE POST-DEPLOY RESTART STEP MUST NOT READ "GONE" AS "STOPPED" — issue #243.
 *
 * `worker-deploy.yml` records which machines were running BEFORE the deploy and restarts
 * exactly those afterwards, by id. Fly REPLACES rather than updates any machine that is
 * unreachable at deploy time:
 *
 *     Skipped lease for unreachable machine 84ed237b2d1e48
 *     Replacing 84ed237b2d1e48 [app] by new machine
 *     Waiting for machine 891e737f632d58 to reach a good state
 *
 * so the recorded id no longer exists, `select(.id == $id)` matches nothing, `$state` is the
 * EMPTY STRING, `"" != "started"` is true, and the step tries to start a machine that is not
 * there: `failed to obtain lease: machine not found`. The deploy itself was completely fine
 * every time this fired — both machines rebuilt, health checks passed, shards held.
 *
 * ## Why this is worth a test rather than a shrug
 *
 * It is the INVERSE of the trap that workflow exists for. The workflow is built to fail when
 * *alerting is dead behind a green deploy*; this failed when *alerting was fine*. That is the
 * cry-wolf failure this repo has fixed three times elsewhere, and its cost is not the noise —
 * it is that the next genuinely red worker deploy gets skimmed.
 *
 * ## And why the skip needs the COUNT check beside it
 *
 * Skipping a replaced id is only safe if something still verifies the fleet came back up.
 * Without that, this fix converts a false alarm into a SILENT one, which is strictly worse
 * and is the shape the workflow exists to prevent. Both halves are asserted here; neither
 * alone is the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const YML = readFileSync('.github/workflows/worker-deploy.yml', 'utf8');

/**
 * The restart step's shell body, bounded by the two step headings around it, so an
 * assertion cannot wander into the deploy step above or the heartbeat check below.
 * Comments stripped — this file's header quotes several shapes it forbids.
 */
function restartBody(): string {
  const from = YML.indexOf('- name: Restart exactly the machines that were running before');
  assert.ok(from > -1, 'the restart step must still exist — anchor not found');
  const to = YML.indexOf('- name: Verify the poller is actually alive', from);
  assert.ok(to > from, 'the heartbeat step must still follow it — anchor not found');
  return YML.slice(from, to)
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

test('an empty state is handled as GONE, before anything tries to start it', () => {
  const body = restartBody();
  const guard = body.indexOf('[ -z "$state" ]');
  assert.ok(guard > -1, 'an empty state must have its own branch — that is the whole bug');
  const start = body.indexOf('flyctl machine start');
  assert.ok(start > -1, 'the step must still be able to start a machine');
  assert.ok(guard < start,
    'and the empty-state branch must come FIRST — a guard after the thing it guards '
    + 'against is this repo\'s most repeated defect');
  assert.match(body.slice(guard, start), /continue/,
    'a replaced machine must be skipped, not started');
});

test('the fleet size is still verified, so the skip cannot hide a real failure', () => {
  const body = restartBody();
  assert.match(body, /steps\.pre\.outputs\.count/,
    'the pre-deploy COUNT must be read — ids do not survive a replacement, the count does');
  assert.match(body, /select\(\.state == "started"\)\] \| length/,
    'and compared against the machines actually started now');
  assert.match(body, /exit 1/,
    'a fleet that came back smaller must still fail the deploy');
});

test('the pre step publishes that count in the first place', () => {
  // A guard reading an output nothing writes passes vacuously for ever: `$before` would be
  // the empty string, the comparison is skipped by its own `-n` test, and the check above
  // would assert nothing at all while looking exactly as it does now.
  const pre = YML.slice(
    YML.indexOf('- name: Record which machines are running before the deploy'),
    YML.indexOf('- name: Deploy'),
  );
  assert.ok(pre.length > 100, 'the pre step must still exist — anchor not found');
  assert.match(pre, /count=.*>> "\$GITHUB_OUTPUT"/,
    'the count must be written to GITHUB_OUTPUT, or the comparison reads an empty string');
});
