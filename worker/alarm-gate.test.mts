/**
 * The alarm must not ring before the thing that fixes the problem has had its turn.
 *
 * IT DID, ON ITS FIRST REAL MORNING (2026-08-09). `ALARM_LEAD_MIN` is 45 and
 * `RC_AUTOLOGIN_LEAD_MIN` is 15, so a dead session inside the alarm window ALWAYS predates
 * the unattended login that repairs it — structurally, on every hold, not as an edge case.
 * The owner got two calls telling them to sign in by hand, and the session was healthy: the
 * bot carted the site two seconds after release using the session the alarm called dead.
 *
 * Pure arithmetic, no DB: the defect was a comparison between two constants, and it was
 * visible in the constants alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
const keepwarm = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const voice = readFileSync('src/lib/notifications/voice.ts', 'utf8');

function num(src: string, name: string): number {
  const m = src.match(new RegExp(String.raw`const ${name} = Number\(process\.env\.\w+ (?:\|\||\?\?) ([0-9_]+)\)`));
  assert.ok(m, `could not read ${name}`);
  return Number(m[1].replace(/_/g, ''));
}

/** The gate, mirrored from alarmSessionDead. */
function shouldAlarm(minutesAway: number, why: string, afterMin: number): boolean {
  const loginFailed = /auto sign-in failed/i.test(why);
  return loginFailed || minutesAway <= afterMin;
}

test('a dead session does NOT ring while the auto-login is still pending', () => {
  const afterMin = num(route, 'ALARM_AFTER_MIN');
  const leadMin = num(route, 'ALARM_LEAD_MIN');
  const autoLoginLead = num(keepwarm, 'AUTOLOGIN_LEAD_MIN');

  // The exact scenario from 2026-08-09: dead session, hold 40 and then 20 minutes out.
  // Both rang. Neither should.
  assert.equal(shouldAlarm(40, 'RC rejected the session', afterMin), false, '40m out must be silent');
  assert.equal(shouldAlarm(20, 'RC rejected the session', afterMin), false, '20m out must be silent');

  // The gate has to sit INSIDE the auto-login's lead, or the login never gets its turn.
  assert.ok(
    afterMin < autoLoginLead,
    `alarm-after (${afterMin}) must be inside the auto-login lead (${autoLoginLead})`,
  );
  // And inside the outer window, or the outer window is doing nothing.
  assert.ok(afterMin < leadMin);
});

test('it DOES ring the moment the auto-login reports failure, at any distance', () => {
  const afterMin = num(route, 'ALARM_AFTER_MIN');
  // This is the definitive case: the repair was attempted and RC said no. Waiting for a
  // clock after that is just losing the site more slowly.
  const why = 'auto sign-in failed: ReserveCalifornia is showing a CAPTCHA';
  assert.equal(shouldAlarm(40, why, afterMin), true);
  assert.equal(shouldAlarm(5, why, afterMin), true);
});

test('it rings when the login window has closed with the session still dead', () => {
  const afterMin = num(route, 'ALARM_AFTER_MIN');
  assert.equal(shouldAlarm(afterMin, 'RC rejected the session', afterMin), true);
  assert.equal(shouldAlarm(1, 'RC rejected the session', afterMin), true);
});

test('the rate limit is wider than the reporter that feeds it', () => {
  // It was 15 minutes against a keep-warm that reports every 20, so every report cleared
  // the window and the limit suppressed exactly nothing. A safeguard that cannot fire is
  // worse than none — it gets counted on in review.
  const gapMin = Number(voice.match(/const MIN_GAP_MS = (\d+) \* 60_000;/)![1]);
  const cadenceMs = Number(
    keepwarm.match(/const KEEPALIVE_MS = Number\(process\.env\.\w+ \|\| (\d+) \* 60 \* 1000\)/)![1],
  );
  assert.ok(
    gapMin > cadenceMs,
    `rate limit ${gapMin}m must exceed the ${cadenceMs}m reporting cadence or it suppresses nothing`,
  );
});
