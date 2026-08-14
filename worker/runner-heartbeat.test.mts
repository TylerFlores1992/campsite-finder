/**
 * THE HEARTBEAT THAT COULD NOT GO STALE.
 *
 * `rc_runner_heartbeat.beat_at` is the whole evidence base for `rcBotUsable()` and for the
 * `autocart.rc_runner` health check, and it claims to mean "the process that carts sites is
 * alive". It was stamped on every authorized GET of the hold feed - and the hold runner is
 * only one of three processes that GET it. The Windows scheduled task alone makes one every
 * five minutes, so on a box with a working updater the field was pinned green permanently.
 *
 * MEASURED 2026-08-14: the hold runner had been dead for hours (restart-rc.ps1 relaunched it
 * as a bare `node` REPL) and `beat_at` advanced every 301 seconds - the updater's tick, to
 * the second. `autocart.rc_runner` read OK, and the poller kept offering holds nothing would
 * honour. That is exactly the failure `rcBotUsable` exists to prevent, arriving through the
 * instrument rather than around it, and it is the same family as `status = 'sent'` meaning
 * only "Twilio returned 2xx".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beatIsFromRunner, HEARTBEAT_ROLE } from '../src/lib/rc-holds';

test('only the hold runner stamps the runner heartbeat', () => {
  assert.equal(beatIsFromRunner(HEARTBEAT_ROLE), true, 'the runner itself counts');
  assert.equal(beatIsFromRunner('update-guard'), false, 'the 5-minute scheduled task does not');
  assert.equal(beatIsFromRunner('rc-keepwarm'), false, 'nor the keep-warm, a separate process');
});

test('an UNIDENTIFIED caller still stamps, and that asymmetry is deliberate', () => {
  // The server half of this deploys to Vercel on push; the bot half waits for update.bat or
  // a quiet window. A rule of "only an identified runner counts" would therefore read every
  // healthy box as a dead runner for the whole of that gap - turning `autocart.rc_runner`
  // red and making the poller withhold holds, over nothing. That is the two-halves-deploy
  // trap that opened the T-30/T-25 alarm hole on 2026-08-11.
  //
  // So the question asked is "did you say you were something else?", never "did you prove
  // you were the runner". The failure direction is the previous behaviour.
  assert.equal(beatIsFromRunner(null), true, 'an older runner sending no header must keep working');
  assert.equal(beatIsFromRunner(undefined), true);
  assert.equal(beatIsFromRunner(''), true, 'an empty header is not a claim to be something else');
});

test('the route stamps beat_at conditionally, and does not gate the commit columns on it', () => {
  const route = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
  assert.match(route, /beatIsFromRunner\(req\.headers\.get\('x-bot-role'\)\)/,
    'the route must use the tested rule rather than reimplementing it');
  assert.match(route, /beat_at\s*=\s*CASE WHEN \$3 THEN NOW\(\) ELSE beat_at END/,
    'a non-runner leaves beat_at exactly as it was - never NULL, which would destroy the record');
  // bot_commit is a different question ("what code is this box running?") and the keep-warm
  // and updater are just as entitled to answer it. Gating those on the role would throw away
  // information for no reason - and COALESCE already stops a caller erasing a known value.
  assert.match(route, /bot_commit\s*=\s*COALESCE\(\$1, bot_commit\)/,
    'the commit columns stay unconditional');
});

test('both non-runner callers of the hold feed declare themselves', () => {
  // This is the half that has to reach the mini-PC. Until it does, those two GETs keep
  // stamping and the heartbeat stays as optimistic as it is today - no worse, and no better.
  for (const [file, role] of [
    ['scripts/auto-cart-bot/update-guard.mjs', 'update-guard'],
    ['scripts/auto-cart-bot/rc-keepwarm.mjs', 'rc-keepwarm'],
  ] as const) {
    const src = readFileSync(file, 'utf8');
    // Bounded to the fetch call itself rather than a character count: the header must be on
    // THIS request, and a fixed window silently drifts out of range the next time somebody
    // adds a comment above it - which is how this test failed on its first run.
    const start = src.indexOf('/api/auto-cart/rc-holds');
    assert.ok(start > 0, `${file} no longer GETs the hold feed`);
    const get = src.slice(start, src.indexOf('});', start));
    assert.match(get, new RegExp(`'x-bot-role':\\s*'${role}'`),
      `${file} GETs the hold feed and must say it is not the runner`);
  }
  // And the runner says so positively, so the intent is legible at the one call site the
  // field is actually about.
  const runner = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');
  assert.match(runner, new RegExp(`'x-bot-role':\\s*'${HEARTBEAT_ROLE}'`));
});
