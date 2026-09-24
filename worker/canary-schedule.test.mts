/**
 * THE DELIVERY CANARY WAS STARVED BY ITS OWN SCHEDULER, AND EVERY PART OF IT LOOKED RIGHT.
 *
 * `runDeliveryCanary` throttles against the database: it reads the last REAL send out of
 * `alert_canary` and returns early if that is younger than 0.9 x the interval. That gate is
 * correct and is the only thing standing between a reboot loop and a burst of real texts.
 * The poller then called the canary once at boot AND armed `setInterval(deliveryCanary,
 * CANARY_DELIVERY_INTERVAL_MS)` — a 24-hour timer whose clock restarts with the process.
 *
 * The two together starve it. A worker deploy inside the gate window makes the boot call a
 * no-op, and re-arms the 24h timer from the restart; the next deploy does it again. MEASURED
 * 2026-09-23: six worker deploys in a week, last real delivery canary 2026-09-22 18:50:36Z,
 * next tick not due until 2026-09-24 04:31Z. Nothing was misconfigured — `fly.toml`'s
 * 86400000 matches `DELIVERY_INTERVAL_MS` exactly, and that agreement was checked first and
 * cleared the obvious suspect. The schedule was simply being derived from process uptime,
 * which is not a fact about when the canary last ran.
 *
 * WHY THE WIRING IS GUARDED AND NOT JUST THE ARITHMETIC. `deliveryCanaryCheckMs` can be
 * perfect and unreachable: put `CANARY_DELIVERY_INTERVAL_MS` back into that `setInterval`
 * and every assertion about the clamp still passes while the bug is fully restored. That is
 * this repo's fix-present-and-inert shape, and `worker/poller.ts` cannot be imported to
 * check it behaviourally — importing the poller STARTS it — so the wiring is read off the
 * source, with the anchor asserted found. An `indexOf` that misses returns -1 and a guard
 * built on it passes vacuously for ever.
 *
 * NOT TESTED HERE: that a send actually goes out. `runDeliveryCanary` mails and texts a real
 * address through Resend and Twilio, so the suite must never call it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVERY_GATE_FRACTION,
  deliveryCanaryIntervalMs,
  deliveryCanaryCheckMs,
} from './canary';
import { DELIVERY_INTERVAL_MS, DELIVERY_STALE_MS } from '../src/lib/health-thresholds';

const ROOT = join(import.meta.dirname, '..');
const pollerSrc = readFileSync(join(ROOT, 'worker/poller.ts'), 'utf8');
const canarySrc = readFileSync(join(ROOT, 'worker/canary.ts'), 'utf8');
const flyToml = readFileSync(join(ROOT, 'worker/fly.toml'), 'utf8');

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// THE WIRING — the half that can be present and inert.
// ---------------------------------------------------------------------------

test('the delivery canary is armed on the CHECK period, never on the send interval', () => {
  const m = pollerSrc.match(/setInterval\(\s*deliveryCanary\s*,\s*([A-Za-z0-9_.()]+)\s*\)/);
  assert.ok(
    m,
    'anchor lost: worker/poller.ts no longer arms the delivery canary with ' +
      'setInterval(deliveryCanary, …). Re-anchor this guard rather than deleting it.'
  );
  const arg = m![1];

  assert.notEqual(
    arg,
    'CANARY_DELIVERY_INTERVAL_MS',
    'the delivery canary is armed on the SEND interval again. That clock restarts with the ' +
      'process, so any deploy cadence faster than the DB gate starves the canary silently.'
  );

  const derivedInline = arg.includes('deliveryCanaryCheckMs');
  const derivedViaConst = pollerSrc.includes(`const ${arg} = deliveryCanaryCheckMs(`);
  assert.ok(
    derivedInline || derivedViaConst,
    `the delivery canary's timer period (\`${arg}\`) does not come from deliveryCanaryCheckMs(). ` +
      'That helper is the only thing clamping the period below the gate; an unclamped value ' +
      'reinstates the starvation.'
  );
});

test('the poller imports the clamp it depends on', () => {
  assert.match(
    pollerSrc,
    /import\s*\{[^}]*deliveryCanaryCheckMs[^}]*\}\s*from\s*'\.\/canary'/,
    'worker/poller.ts must import deliveryCanaryCheckMs from ./canary'
  );
});

test('the DB gate and the scheduler share one fraction', () => {
  // Two numbers that must agree, written in two files, is how the original pair drifted.
  assert.match(
    canarySrc,
    /Date\.parse\(last\.last_run_at\)\s*<\s*intervalMs\s*\*\s*DELIVERY_GATE_FRACTION/,
    "runDeliveryCanary's skip must use DELIVERY_GATE_FRACTION — the same constant the check " +
      'period is bounded against. A bare 0.9 here can drift from the bound without failing anything.'
  );
});

// ---------------------------------------------------------------------------
// THE ARITHMETIC — pinned against the REAL thresholds, not restated.
// ---------------------------------------------------------------------------

test('fly.toml still deploys the interval the health page calibrated against', () => {
  const m = flyToml.match(/CANARY_DELIVERY_INTERVAL_MS\s*=\s*"(\d+)"/);
  assert.ok(m, 'anchor lost: CANARY_DELIVERY_INTERVAL_MS is no longer set in worker/fly.toml');
  assert.equal(
    Number(m![1]),
    DELIVERY_INTERVAL_MS,
    'worker/fly.toml and src/lib/health-thresholds.ts disagree about the delivery interval. ' +
      'This was the first hypothesis for the 2026-09-23 starvation and it was wrong — keep it wrong.'
  );
});

test('the worst case a healthy poller can produce is inside DELIVERY_STALE_MS', () => {
  // The canary fires at the first ASK after the gate opens, so the latest a send can land
  // is gate + one check period. If that exceeds the health page's staleness threshold, a
  // perfectly healthy fleet warns on `delivery:*` — the cry-wolf shape this repo has paid
  // for three times.
  const interval = deliveryCanaryIntervalMs({ CANARY_DELIVERY_INTERVAL_MS: String(DELIVERY_INTERVAL_MS) });
  const worst = interval * DELIVERY_GATE_FRACTION + deliveryCanaryCheckMs({});
  assert.ok(
    worst < DELIVERY_STALE_MS,
    `worst-case delivery age ${(worst / HOUR).toFixed(2)}h is not below the ` +
      `${(DELIVERY_STALE_MS / HOUR).toFixed(2)}h staleness threshold`
  );
});

test('the check period is well below the gate, so a long-lived process still asks inside it', () => {
  const check = deliveryCanaryCheckMs({});
  const gate = deliveryCanaryIntervalMs({}) * DELIVERY_GATE_FRACTION;
  assert.ok(check > 0 && check < gate, `check ${check}ms must be inside the gate ${gate}ms`);
});

test('an operator cannot set the check period back to the send interval', () => {
  const day = String(24 * HOUR);
  const check = deliveryCanaryCheckMs({ CANARY_DELIVERY_CHECK_MS: day });
  assert.ok(
    check < Number(day) * DELIVERY_GATE_FRACTION,
    'CANARY_DELIVERY_CHECK_MS must be clamped below the gate — obeying a 24h value literally ' +
      'reinstates the starvation through configuration instead of code'
  );
  const worst = 24 * HOUR * DELIVERY_GATE_FRACTION + check;
  assert.ok(worst < DELIVERY_STALE_MS, 'even a clamped override must stay inside the staleness threshold');
});

test('the check period scales with a shortened interval rather than outrunning it', () => {
  // A one-hour interval with an hourly check would ask once per interval from boot — the
  // original bug, arriving through configuration.
  const env = { CANARY_DELIVERY_INTERVAL_MS: String(HOUR) };
  const check = deliveryCanaryCheckMs(env);
  assert.ok(check < HOUR * DELIVERY_GATE_FRACTION, `check ${check}ms must stay inside a 1h gate`);
});

test('nonsense never becomes a busy loop or a NaN timer', () => {
  for (const bad of ['0', '-5', 'abc', '']) {
    const check = deliveryCanaryCheckMs({ CANARY_DELIVERY_CHECK_MS: bad });
    assert.ok(Number.isFinite(check) && check >= 1000, `CANARY_DELIVERY_CHECK_MS=${JSON.stringify(bad)} -> ${check}`);
    const interval = deliveryCanaryIntervalMs({ CANARY_DELIVERY_INTERVAL_MS: bad });
    assert.ok(Number.isFinite(interval) && interval > 0, `CANARY_DELIVERY_INTERVAL_MS=${JSON.stringify(bad)} -> ${interval}`);
  }
});
