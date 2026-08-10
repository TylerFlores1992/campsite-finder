/**
 * A stale session verdict is not a healthy one.
 *
 * THE INCIDENT (2026-08-10). `rc-keepwarm.mjs` wedged at 04:48Z holding the Chromium
 * profile. Its last verdict — `ok` — froze in place, so `autocart.rc_session` read
 * "RC accepts the session for 10h23m (checked 37401s ago, STALE)" at level `warn`, the
 * 07:30 pre-flight showed amber, the alarm never rang, and the 08:00 cart failed against
 * a lock nothing could take.
 *
 * Every layer was working on its own terms. The gap was that "unknown is not healthy" —
 * already applied to a null availability read, to `untracked` SMS rows, and to a null
 * session verdict — had never been applied to a verdict's AGE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rcSessionFault, RC_SESSION_STALE_MS } from '../src/lib/health-thresholds';

const MIN = 60_000;

test('a verdict older than the threshold is stale, whatever it said', () => {
  // The exact shape of the incident: ok, and ten hours old.
  assert.equal(rcSessionFault(true, 10 * 60 * MIN), 'stale');
  assert.equal(rcSessionFault(false, 10 * 60 * MIN), 'stale', 'a stale dead verdict is stale too — nothing is maintaining it');
});

test('a fresh verdict is taken at face value', () => {
  assert.equal(rcSessionFault(true, 5 * MIN), null);
  assert.equal(rcSessionFault(false, 5 * MIN), 'dead');
});

test('never reported is its own fault, not healthy and not dead', () => {
  // A brand-new box and a wedged one need different words; collapsing them into "dead"
  // would send someone to sign in over a bot that was never started.
  assert.equal(rcSessionFault(null, null), 'never-reported');
  assert.equal(rcSessionFault(null, 1000), 'never-reported');
  assert.equal(rcSessionFault(true, null), 'never-reported');
});

test('the threshold leaves room for a missed pass but not for a wedge', () => {
  // Asserting the PROPERTY, not the number: rc-keepwarm reports every ~20 minutes, so the
  // window must tolerate one missed pass (a slow probe, a reboot) and still fire well
  // inside the 45-minute alarm lead that gives a human time to act.
  const KEEPWARM_CADENCE_MS = 20 * MIN;
  assert.ok(RC_SESSION_STALE_MS > KEEPWARM_CADENCE_MS * 2,
    'must survive two missed passes, or a slow night becomes a phone call');
  assert.ok(RC_SESSION_STALE_MS <= 45 * MIN,
    'must trip inside the alarm lead, or the wedge is only found after the release');
});

test('a stale session rings immediately instead of waiting for a repair that cannot come', () => {
  // `maybeAutoLogin` lives INSIDE rc-keepwarm.mjs. If the verdict is stale, that process
  // is not reporting — so the repair the ALARM_AFTER_MIN gate politely waits for is
  // provably not going to happen, and waiting spends the lead time that makes the call
  // useful. This is the difference between ringing at 07:15 and never ringing at all.
  const src = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
  assert.match(src, /if \(fault !== 'stale'\) \{/, 'the wait-for-the-repair gate is skipped when stale');
  assert.match(src, /alarmIfSessionUnusable/, 'and something evaluates staleness without being told');
});

test('the dead-man\'s switch runs on the GET, not on a report', () => {
  // THE WHOLE POINT. The old alarm was driven by the keep-warm REPORTING a dead session,
  // so a keep-warm that stops reporting silences the alarm meant to catch it. The runner's
  // feed poll continues every 15s regardless, which is why the check has to hang off that.
  const src = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
  const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
  assert.match(get, /alarmIfSessionUnusable/, 'the pull side must be on the poll the runner always makes');
});
