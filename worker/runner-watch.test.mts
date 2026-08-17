/**
 * The alarm that should have rung on 2026-08-17.
 *
 * A test hold released at 08:00 PT and was never carted. The hold runner had hard-crashed at
 * 05:36:31, the watchdog never ran, and the only alarm that DID ring was about the RC session
 * — which was healthy, and whose printed remedy would have killed it.
 *
 * Every test here drives the REAL `checkRunner`, with the database, Twilio and the clock
 * injected. The two decisions that have been wrong in production before — how stale is dead,
 * and how close is close — are the arithmetic being pinned.
 *
 * Each regression asserts THE MUTATION APPLIED before asserting the failure, because a
 * mutation that silently fails to apply is a green that proves nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRunner, RUNNER_DEAD_MS, ALARM_LEAD_MIN, RUNNER_WATCH_INTERVAL_MS } from './runner-watch.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 7, 17, 14, 30, 0);

/** A hold shaped like `holdAtRisk`'s return, releasing `minutesAway` from now. */
function hold(minutesAway: number) {
  return {
    hold: {
      id: 'hold-1',
      unit_name: '#L006',
      release_at: '2026-08-17T08:00:53',
    } as never,
    phone: '+15550001111',
    campground: 'Carpinteria SB',
    minutesAway,
  };
}

/** Records what `alarmCall` was asked to do without going near Twilio. */
function spyCall() {
  const calls: { to: string | null | undefined; message: string; key: string }[] = [];
  const fn = async (to: string | null | undefined, message: string, key: string) => {
    calls.push({ to, message, key });
    return { placed: 1 };
  };
  return { calls, fn: fn as never };
}

const beat = (agoMs: number | null) => async () =>
  agoMs === null ? null : new Date(NOW - agoMs).toISOString();

test('rings when the runner is long dead and a hold is inside the lead', async () => {
  const { calls, fn } = spyCall();
  const r = await checkRunner({
    now: NOW,
    beatAt: beat(RUNNER_DEAD_MS + 5 * MIN),
    atRisk: async () => hold(40) as never,
    call: fn,
  });
  assert.equal(r.outcome, 'alarmed', r.detail);
  assert.equal(calls.length, 1);
});

/**
 * THE CRY-WOLF RULE, and the one every alarm in this codebase has had to learn once.
 *
 * The runner is legitimately silent whenever the box is off, being updated, or simply
 * between releases. `autocart.rc_session` failed on ANY hold ahead once and turned the phone
 * into a thirteen-hour alarm over a system behaving exactly as designed.
 */
test('does NOT ring on staleness alone when no hold is near', async () => {
  const { calls, fn } = spyCall();
  const r = await checkRunner({
    now: NOW,
    beatAt: beat(6 * 60 * MIN),
    atRisk: async () => null,
    call: fn,
  });
  assert.equal(r.outcome, 'no-hold');
  assert.equal(calls.length, 0, 'a dead runner with nothing to lose is not an emergency');
});

/**
 * `supervise.ps1` backs off exponentially to a 300s cap, so five minutes of silence is a
 * crash that is ABOUT TO FIX ITSELF. Ringing there would page a human for the supervisor
 * doing its job, which is how an alarm stops being believed.
 */
test('does NOT ring while the silence is still inside the supervisor backoff', async () => {
  const { calls, fn } = spyCall();
  const r = await checkRunner({
    now: NOW,
    beatAt: beat(6 * MIN),
    atRisk: async () => hold(30) as never,
    call: fn,
  });
  assert.equal(r.outcome, 'runner-alive', r.detail);
  assert.equal(calls.length, 0);
});

test('the dead threshold clears the supervisor backoff cap with room to spare', () => {
  // supervise.ps1's MaxBackoffSec is 300. A threshold at or under it would ring on a
  // restart that was always going to succeed.
  assert.ok(
    RUNNER_DEAD_MS >= 3 * 300_000,
    `RUNNER_DEAD_MS (${RUNNER_DEAD_MS}ms) must be several times supervise.ps1's 300s backoff cap`,
  );
  // And it must leave usable warning inside the lead: a threshold wider than the lead means
  // the runner is never declared dead before the release it is about to miss.
  assert.ok(
    RUNNER_DEAD_MS < ALARM_LEAD_MIN * MIN,
    `RUNNER_DEAD_MS (${RUNNER_DEAD_MS}ms) must be inside the ${ALARM_LEAD_MIN}m lead or the alarm can never fire in time`,
  );
});

/**
 * A FAILED READ IS NOT EVIDENCE OF A DEAD RUNNER — same rule as `hasAvailabilityInRange`
 * returning null and `oktaSessionAlive`'s unknown never being reported as dead. Ringing on a
 * database blip is the fastest way to make this alarm ignorable.
 */
test('a heartbeat read failure does not ring', async () => {
  const { calls, fn } = spyCall();
  const r = await checkRunner({
    now: NOW,
    beatAt: async () => { throw new Error('DNS resolution failure'); },
    atRisk: async () => hold(30) as never,
    call: fn,
  });
  assert.equal(r.outcome, 'read-failed');
  assert.equal(calls.length, 0);
});

/**
 * THE MESSAGE IS THE POINT. On the morning this was written for, the phone rang and said
 * "the session is dead, run rc-login.bat" — over a live session, and that remedy force-kills
 * the Chromium the token lives in. A caller woken at 07:30 does what the voice says.
 */
test('names the runner as the fault and does not send anyone to rc-login.bat', async () => {
  const { calls, fn } = spyCall();
  await checkRunner({
    now: NOW,
    beatAt: beat(RUNNER_DEAD_MS + MIN),
    atRisk: async () => hold(20) as never,
    call: fn,
  });
  const msg = calls[0]!.message;
  assert.match(msg, /hold runner has stopped/i, 'must name the runner, not the session');
  assert.doesNotMatch(
    msg, /R C login|rc-login/i,
    'rc-login.bat kills the Chromium the access token lives in — it is the wrong remedy for a dead runner and the right one for nothing here',
  );
  assert.match(msg, /Carpinteria SB/, 'says which campground is at stake');
  assert.match(msg, /08:00/, 'and when it goes');
});

/**
 * Keyed on the HOLD, and prefixed apart from the session alarm.
 *
 * A per-attempt key would give every tick its own budget against `alarmCall`'s rate limit
 * and turn one dead runner into a call every two minutes all night — the exact defect
 * `voice.ts` records against its own limiter. Sharing the session alarm's key would be worse
 * in the other direction: one fault would silence the other.
 */
test('the rate-limit key is per hold and distinct from the session alarm', async () => {
  const { calls, fn } = spyCall();
  await checkRunner({
    now: NOW, beatAt: beat(RUNNER_DEAD_MS + MIN), atRisk: async () => hold(20) as never, call: fn,
  });
  assert.equal(calls[0]!.key, 'rc-runner:hold-1');
  assert.doesNotMatch(calls[0]!.key, /^rc-session:/);
});

/** The tick has to be well inside the lead, or the alarm can be scheduled past the release. */
test('the watch interval fits several times inside the lead', () => {
  assert.ok(
    RUNNER_WATCH_INTERVAL_MS * 4 <= ALARM_LEAD_MIN * MIN,
    `interval ${RUNNER_WATCH_INTERVAL_MS}ms is too coarse for a ${ALARM_LEAD_MIN}m lead`,
  );
});
