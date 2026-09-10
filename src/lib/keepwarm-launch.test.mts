/**
 * Guards for the keep-warm's Chromium launch arguments.
 *
 * Under `src/lib/` and not `worker/` DELIBERATELY: `worker/**` is the first entry in
 * `worker-deploy.yml`'s `paths:`, so a guard over two bot-side files would restart all three
 * poller machines for nothing. Checked against that workflow rather than remembered — this
 * repo records getting that claim wrong twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keepwarmLaunchArgs, GPU_OFF_ARGS } from '../../scripts/auto-cart-bot/keepwarm-launch.mjs';

const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const MODULE = readFileSync('scripts/auto-cart-bot/keepwarm-launch.mjs', 'utf8');

/** Comments name every flag in order to explain them, so a source scan that did not strip
 *  them would match its own documentation — the mistake this repo has made repeatedly. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the GPU experiment is ON by default — an unset variable is the experiment, not a revert', () => {
  const args = keepwarmLaunchArgs({});
  for (const flag of GPU_OFF_ARGS) assert.ok(args.includes(flag), `missing ${flag}`);
});

test('--disable-3d-apis is the targeted flag and is present when the gate is on', () => {
  // The belt (--disable-gpu) could be dropped and the experiment would still test the
  // WebGL command buffer; dropping this one would leave it testing nothing in particular.
  assert.ok(keepwarmLaunchArgs({}).includes('--disable-3d-apis'));
});

test('the gate can be turned off from .env without a deploy', () => {
  for (const v of ['0', 'false', 'no', 'FALSE', ' 0 ']) {
    const args = keepwarmLaunchArgs({ RC_KEEPWARM_DISABLE_GPU: v });
    for (const flag of GPU_OFF_ARGS) {
      assert.ok(!args.includes(flag), `${JSON.stringify(v)} should have removed ${flag}`);
    }
  }
});

test('--hide-crash-restore-bubble survives BOTH ways — it is unrelated to the experiment', () => {
  // It covers the top of the window a human is asked to look at during a hand sign-in, so
  // losing it as collateral of a memory experiment is a real regression on the login path.
  assert.ok(keepwarmLaunchArgs({}).includes('--hide-crash-restore-bubble'));
  assert.ok(keepwarmLaunchArgs({ RC_KEEPWARM_DISABLE_GPU: '0' }).includes('--hide-crash-restore-bubble'));
});

test('BOTH launch sites take the shared args, and neither keeps an inline array', () => {
  // THE POINT OF THE MODULE. rc-keepwarm.mjs launches Chromium twice and the RAMP is on the
  // resident one; a flag on one launch and not the other makes the two browsers differ in
  // exactly the variable under test, so the experiment could not be read at all.
  const c = code(KEEPWARM);
  const calls = c.match(/args:\s*keepwarmLaunchArgs\(\)/g) ?? [];
  assert.equal(calls.length, 2, 'both launchPersistentContext calls must use the shared args');
  assert.ok(!/args:\s*\[/.test(c), 'an inline args array has come back at a launch site');
  assert.ok(/^import \{ keepwarmLaunchArgs \}/m.test(c), 'the import is missing');
});

test('the anti-fingerprint posture is not collateral damage of this edit', () => {
  // RC and Okta fingerprint this browser. --enable-automation sets navigator.webdriver and
  // reCAPTCHA reads it; losing that strip while adding GPU flags would change the fingerprint
  // twice over on an address that has already eaten a twelve-hour block.
  const c = code(KEEPWARM);
  const strips = c.match(/ignoreDefaultArgs:\s*\['--enable-automation'\]/g) ?? [];
  assert.equal(strips.length, 2, 'both launches must still strip --enable-automation');
  assert.ok(!/headless:\s*true/.test(c), 'headful is load-bearing — RC fingerprints headless');
});

test('the hazard and the evidence bar are written down where the flags are', () => {
  // The 10% base rate is the whole reason a few quiet restarts prove nothing, and this repo
  // has credited a repair to the wrong mechanism three times. If someone deletes the number,
  // the next reader has no bar to clear.
  assert.ok(/10%/.test(MODULE), 'the 10% replacement-ramp base rate must stay recorded');
  assert.ok(/twenty clean restarts/i.test(MODULE), 'the evidence bar must stay recorded');
  assert.ok(/RC_KEEPWARM_DISABLE_GPU=0/.test(MODULE), 'the revert instruction must stay recorded');
  assert.ok(/fingerprint/i.test(MODULE), 'the anti-bot hazard must stay recorded');
});
