/**
 * THE HOLD RUNNER HAD NO WEDGE WATCHDOG, AND ON 2026-09-02 IT SAT ALIVE POLLING NOTHING.
 *
 *     12:41:52   RC token acquired (live)
 *     12:41:52   ready for 1 hold(s) — holding 77.0s until 2026-09-02T05:43:09 PT
 *                [nothing, ever]
 *
 * `list-processes` showed the node process ALIVE, so it wedged rather than crashed.
 * `supervise.ps1` restarts on EXIT only, so nothing recovered it; the Fly `runner-watch`
 * alarm needs a hold due inside 45 minutes and the sweep had just failed the only hold there
 * was. It would have sat there indefinitely.
 *
 * #255 bounded the ONE call the evidence pointed at (`precartInPage`, 60s). This is the
 * general guard the keep-warm got on 2026-08-17 and the runner never did — and it is the
 * more valuable half for a reason that has nothing to do with carting: `withRCLocked` renews
 * the profile lock from its own `setInterval`, so a stalled pass renews it FOREVER, the
 * keep-warm can never take the profile back cooperatively, and the RC session dies with
 * nothing able to repair it. That is the 2026-08-10 keep-warm wedge mirrored.
 *
 * HALF OF THIS FILE IS STRUCTURAL, DELIBERATELY. `sleepTicking` can be perfect while nothing
 * calls it — and the pre-release hold is precisely the await that must keep the clock
 * running, because three minutes per release group is legitimate work. A fix present but
 * inert passes review; this repo has paid for that shape at least five times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

const RUNNER = code('scripts/auto-cart-bot/rc-hold-runner.mjs');
const KEEPWARM = code('scripts/auto-cart-bot/rc-keepwarm.mjs');

function envDefault(src: string, name: string): number {
  const m = new RegExp(`${name} \\|\\| ([\\d_ *]+?)\\s*\\)`).exec(src);
  assert.ok(m, `no default found for ${name}`);
  return m![1].split('*').map((x) => Number(x.trim().replace(/_/g, '')))
    .reduce((a, b) => a * b, 1);
}

test('the watchdog lives in a timer, which is the only code a stall leaves running', () => {
  // The keep-warm's own comment is the rule: "the renew timer is the only code proven to
  // still be executing, which makes it the only place a watchdog can live". A check inside
  // the loop it guards cannot fire, which is the shape this repo has recorded four times —
  // the size guard, `expireStaleHolds`, `reclaimLapsedHolds`, the health route's counts.
  const at = RUNNER.indexOf('const stalledMs = Date.now() - lastTick;');
  assert.ok(at > -1, 'the stall check must exist');
  const before = RUNNER.slice(0, at);
  assert.match(before.slice(before.lastIndexOf('setInterval')), /setInterval\(\(\) => \{/,
    'the stall check must sit directly inside a setInterval, not in the pass loop');
});

test('the watchdog is UNREF\'d, or a --once run can never exit', () => {
  /**
   * `exitWhenDrained` deliberately sets the exit code and lets the loop FINISH rather than
   * calling `process.exit` — the file's own comment records why. A live interval holds the
   * event loop open, so a `--once` smoke test would hang for ever with a passing result and
   * no way to tell it from the wedge this guard exists to catch.
   */
  const at = RUNNER.indexOf('const stalledMs = Date.now() - lastTick;');
  assert.match(RUNNER.slice(at, at + 1200), /\}, [\d_]+\)\.unref\(\);/,
    'the watchdog interval must be unref\'d');
});

test('a wedge RELEASES THE PROFILE LOCK before exiting', () => {
  /**
   * THE HALF THAT MATTERS EVEN WHEN NOTHING WAS DUE. `withRCLocked` renews the lock from a
   * `setInterval`, so a stalled pass goes on holding the profile against a keep-warm whose
   * preemption is cooperative — it drops `.camphawk-profile-wanted` and waits for a loop that
   * is not advancing. Exiting without releasing would leave the session unrepairable for
   * `STALE_MS`; exiting WITH the release is what unblocks it immediately.
   */
  const at = RUNNER.indexOf('const stalledMs = Date.now() - lastTick;');
  const body = RUNNER.slice(at, RUNNER.indexOf('.unref();', at));
  const release = body.indexOf('releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER)');
  const exit = body.indexOf('process.exit(1)');
  assert.ok(release > -1, 'the wedge must release the profile lock');
  assert.ok(exit > release, 'and release it BEFORE exiting, or the release never runs');
});

test('a wedge names the step it stalled in', () => {
  // Four keep-warm wedges were recorded before the breadcrumb existed and not one could say
  // which of six awaits never returned. The 09-02 runner wedge is in exactly that state.
  const at = RUNNER.indexOf('const stalledMs = Date.now() - lastTick;');
  assert.match(RUNNER.slice(at, RUNNER.indexOf('.unref();', at)), /Stalled in: \$\{step\}/);
  for (const s of ['asking the feed for work', 'taking the Chromium profile', 'working in the browser']) {
    assert.ok(RUNNER.includes(`mark('${s}')`), `no breadcrumb for: ${s}`);
  }
  assert.match(RUNNER, /mark\(`holding until \$\{releaseAt\} PT`\)/, 'no breadcrumb for the pre-release hold');
});

test('marking a step does NOT stop the clock from being the clock', () => {
  /**
   * `mark` ticks — a step BEGINNING is progress, and the loop really did advance to reach it.
   * That is the opposite of the keep-warm's rule and is correct here for a different reason:
   * there, `mark` fires inside a single long-lived resident loop where a step beginning would
   * postpone the very watchdog that catches a step never FINISHING. Here every `mark` is a
   * distinct stage of a pass that runs to completion in seconds, so the danger is the reverse
   * — a stage boundary that did not tick would make normal progress look like a stall.
   *
   * What must NOT happen is `mark` failing to record WHERE, which is what makes the breadcrumb
   * worth having at all.
   */
  assert.match(RUNNER, /const mark = \(s\) => \{ step = s; stepSince = Date\.now\(\); tick\(\); \};/);
  assert.match(RUNNER, /const tick = \(\) => \{ lastTick = Date\.now\(\); \};/);
});

test('the pre-release hold TICKS — three minutes of waiting is not a stall', () => {
  /**
   * THE INERT-FIX GUARD, and the one that decides whether the threshold can be small enough
   * to be useful. `MAX_RELEASE_WAIT_MS` is three minutes PER RELEASE GROUP and a pass can
   * hold several. A flat threshold clearing all of them would have to be so large it could
   * not free the profile before 08:00 — which is the only thing this watchdog is for.
   */
  /**
   * AND IT MUST ACTUALLY TICK. The first version of this file asserted only that
   * `sleepTicking` was CALLED — so gutting its body to a plain sleep passed every test, which
   * is the whole failure wearing the fix's name. Found by mutation, not by reading.
   *
   * Structural rather than behavioural because importing `rc-hold-runner.mjs` STARTS the
   * runner, the same reason `claim.ts` and `hold-line.ts` had to be extracted. What can be
   * pinned from here is that the wait is CHUNKED and that each chunk ticks.
   */
  const fn = RUNNER.slice(RUNNER.indexOf('async function sleepTicking(ms)'));
  assert.ok(fn.startsWith('async function sleepTicking(ms)'), 'the ticking sleep must exist');
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /await sleep\(Math\.min\(left, ([\d_]+)\)\);\n\s*tick\(\);/,
    'every chunk of the wait must tick, or this is a plain sleep with a longer name');
  const chunk = Number(/Math\.min\(left, ([\d_]+)\)/.exec(body)![1].replace(/_/g, ''));
  assert.ok(chunk > 0 && chunk * 4 < envDefault(RUNNER, 'RC_RUNNER_HUNG_MS'),
    `a ${chunk}ms chunk must sit well inside the stall threshold, or the wait itself trips it`);
  // Bounded by the two lines around it rather than by a brace — `${holds.length}` contains a
  // `}`, so the obvious `indexOf('}')` stops inside the template literal and slices nothing.
  const at = RUNNER.indexOf('const wait = Math.min(msUntilRelease');
  assert.ok(at > -1, 'the pre-release hold must still exist — anchor not found');
  const end = RUNNER.indexOf('mark(`carting', at);
  assert.ok(end > at, 'the hold must still be followed by the carting breadcrumb');
  const block = RUNNER.slice(at, end);
  assert.ok(block.split('\n').length < 20, `the hold slice ran on (${block.split('\n').length} lines)`);
  // RE-ANCHORED 2026-09-03, NOT RELAXED. This pinned `sleepTicking(wait)` by its ARGUMENT,
  // and the fast lane now sleeps to T minus a lead — `sleepTicking(early)` — so it broke
  // over behaviour that had not changed at all. The property is the ticking SLEEP, never
  // which variable it is handed.
  assert.match(block, /await sleepTicking\(\w+\)/,
    'the pre-release hold must use the ticking sleep, or the watchdog fires on a working morning');
  // STRONGER THAN IT WAS, too: the old negative named one variable, so renaming it hid the
  // regression. `sleepTicking(` does not contain `sleep(`, so this catches the plain sleep
  // whatever it is passed.
  assert.ok(!/await sleep\(/.test(block), 'the plain sleep is the regression');
});

test('the fan-out and both sequential loops tick', () => {
  /**
   * Twenty holds at CART_CONCURRENCY 4 is five rounds, each bounded at 60s — 300s of entirely
   * legitimate work against a 240s threshold. Ticking per settled task is what keeps a full
   * release window from tripping a guard on a morning that worked.
   */
  const pmap = RUNNER.slice(RUNNER.indexOf('async function pMap'));
  assert.match(pmap.slice(0, pmap.indexOf('\n}')), /catch \{[^}]*\}\n\s*tick\(\);/,
    'pMap must tick as each task settles');
  for (const loop of ['claim', 'release']) {
    const at = RUNNER.indexOf(`for (const h of ${loop}) {`);
    assert.ok(at > -1, `the ${loop} loop must still exist`);
    assert.match(RUNNER.slice(at, at + 120), /tick\(\);/, `the ${loop} loop must tick per item`);
  }
});

test('the idle poll ticks too, or an idle runner reads as wedged', () => {
  // `nextPollMs` is 15s normally and the feed can widen it. A plain sleep here would make a
  // perfectly healthy idle runner trip the guard the moment the server asked it to back off.
  const tail = RUNNER.slice(RUNNER.indexOf('} else for (;;) {'));
  assert.match(tail, /await sleepTicking\(nextPollMs\)/);
});

test('the threshold is bounded from BOTH sides, by the numbers around it', () => {
  const hung = envDefault(RUNNER, 'RC_RUNNER_HUNG_MS');

  /**
   * ABOVE the longest bounded step, with room. `precartInPage` is 60s (#255), the profile
   * lock wait is 60s and `page.goto` is 45s; the observed worst legitimate gap between two
   * ticks is the lock wait plus the launch plus the goto plus the token prime, ~135s. A
   * threshold at or below that fires on a slow but working morning, which is the cry-wolf
   * failure this repo has fixed three times and paid most for at 07:33 on 2026-08-16.
   */
  const cart = envDefault(code('scripts/auto-cart-bot/rc-cart.mjs'), 'RC_CART_EVAL_TIMEOUT_MS');
  assert.ok(hung > cart * 3, `${hung}ms must clear three bounded cart calls (${cart}ms each)`);

  /**
   * BELOW the keep-warm's own wedge threshold and below the Fly alarm's. The runner is the
   * process that has to be back before 08:00; recovering slower than the watcher that pages a
   * human about it would make this guard decorative.
   */
  const keepwarmHung = envDefault(KEEPWARM, 'RC_KEEPWARM_HUNG_MS');
  assert.ok(hung < keepwarmHung,
    `${hung}ms must be tighter than the keep-warm's ${keepwarmHung}ms — the runner is the one on a deadline`);
  assert.ok(hung <= 5 * 60_000, 'a wedge must be caught well inside the 20-minute cart grace window');
});
