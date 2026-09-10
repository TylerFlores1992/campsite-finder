/**
 * Guards for the keep-warm's Chromium launch arguments.
 *
 * Under `src/lib/` and not `worker/` DELIBERATELY: `worker/**` is the first entry in
 * `worker-deploy.yml`'s `paths:`, so a guard over two bot-side files would restart all three
 * poller machines for nothing. Checked against that workflow rather than remembered — this
 * repo records getting that claim wrong twice.
 *
 * THREE OF THESE WERE INVERTED ON 2026-09-10, NOT RELAXED. They pinned the GPU flags ON, which
 * was correct while the experiment was running and became a test REQUIRING a change that had
 * been measured not to work. That is the `held-offer-scope` shape — a guard that requires the
 * defect — and the remedy is the same one: flip the assertion and write the reason beside it,
 * so re-enabling by default fails here rather than passing as a tidy-up.
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

test('the GPU flags are OFF by default — the experiment ran and its answer was negative', () => {
  // INVERTED 2026-09-10. This asserted the flags were ON, which is what the trial needed and
  // what the refutation removed the justification for: a browser launched under both flags
  // produced the identical 32 GiB / 16,385-region signature two minutes later. What is left
  // is the fingerprint hazard with nothing on the other side of it, so an unset variable must
  // now be the SAFE configuration. Re-enabling by default is a decision, not a default.
  const args = keepwarmLaunchArgs({});
  for (const flag of GPU_OFF_ARGS) {
    assert.ok(!args.includes(flag), `${flag} must not be on by default — the candidate is refuted`);
  }
});

test('the experiment can be re-run from .env without a deploy', () => {
  // The gate is what makes the refutation cheap to revisit, and it is the half worth keeping.
  for (const v of ['1', 'true', 'yes', 'TRUE', ' 1 ']) {
    const args = keepwarmLaunchArgs({ RC_KEEPWARM_DISABLE_GPU: v });
    for (const flag of GPU_OFF_ARGS) {
      assert.ok(args.includes(flag), `${JSON.stringify(v)} should have added ${flag}`);
    }
  }
});

test('--disable-3d-apis is still the targeted flag when the gate is asked for', () => {
  // The belt (--disable-gpu) could be dropped and a re-run would still test the WebGL command
  // buffer; dropping this one would leave it testing nothing in particular.
  assert.ok(keepwarmLaunchArgs({ RC_KEEPWARM_DISABLE_GPU: '1' }).includes('--disable-3d-apis'));
});

test('an unrecognised value does NOT enable the flags', () => {
  // The failure direction has to be the safe one: a typo, an empty string or a stale value
  // from some other convention must leave the login path in the configuration that has been
  // signing in for weeks, not in the one carrying an unquantified bot signal.
  for (const v of ['', 'on', 'enabled', 'y', '2', 'off', 'nonsense']) {
    const args = keepwarmLaunchArgs({ RC_KEEPWARM_DISABLE_GPU: v });
    for (const flag of GPU_OFF_ARGS) {
      assert.ok(!args.includes(flag), `${JSON.stringify(v)} must not enable ${flag}`);
    }
  }
});

test('--hide-crash-restore-bubble survives BOTH ways — it is unrelated to the experiment', () => {
  // It covers the top of the window a human is asked to look at during a hand sign-in, so
  // losing it as collateral of a memory experiment is a real regression on the login path.
  assert.ok(keepwarmLaunchArgs({}).includes('--hide-crash-restore-bubble'));
  assert.ok(keepwarmLaunchArgs({ RC_KEEPWARM_DISABLE_GPU: '1' }).includes('--hide-crash-restore-bubble'));
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
  // reCAPTCHA reads it; losing that strip while changing GPU flags would change the fingerprint
  // twice over on an address that has already eaten a twelve-hour block.
  const c = code(KEEPWARM);
  const strips = c.match(/ignoreDefaultArgs:\s*\['--enable-automation'\]/g) ?? [];
  assert.equal(strips.length, 2, 'both launches must still strip --enable-automation');
  assert.ok(!/headless:\s*true/.test(c), 'headful is load-bearing — RC fingerprints headless');
});

test('the REFUTATION is written down where the flags are, with its numbers', () => {
  // The module is kept for the evidence rather than the behaviour, so the evidence is the part
  // that must not be deleted. Without it the next reader meets a plausible untried hypothesis
  // and re-runs a trial that has already been answered — which is the fold-in failure this
  // repo has paid for with the Feature E correction, found independently three times.
  assert.ok(/REFUTED/.test(MODULE), 'the refutation must stay recorded');
  assert.ok(/16,385 regions/.test(MODULE), 'the walk that refuted it must stay recorded');
  assert.ok(/2,097,152/.test(MODULE), 'the chunk size that made it a candidate must stay recorded');
  assert.ok(/RC_KEEPWARM_DISABLE_GPU=1/.test(MODULE), 're-running it must stay documented');
  assert.ok(/fingerprint/i.test(MODULE), 'the anti-bot hazard must stay recorded');
  // The over-claim guard: --disable-gpu leaves a GPU process running, so "no command buffer
  // anywhere" is not what was shown. A later edit that sharpens this into a bigger claim than
  // the evidence supports is the failure mode of a good finding.
  assert.ok(/PRECISELY|not excluded/i.test(MODULE), 'the limit of the refutation must stay stated');
});
