/**
 * THE RUNNER'S OWN SMOKE TEST ASSERTED THE ONE THING IT NEVER CHECKED (found 2026-08-12).
 *
 * `node rc-hold-runner.mjs --once` with nothing queued printed:
 *
 *     nothing to hand over, cart, or release. Feed reachable, token accepted.
 *
 * "Feed reachable" was true. "token accepted" was not tested. The line sat above the early
 * return, so on the quiet path — nearly every path, since holds are due for about ninety
 * seconds a day — `withRC` was never reached: no profile opened, no browser launched, no
 * token read, nothing sent to RC.
 *
 * `mini-pc\rc-check.bat` runs this as step 1, so the message a person sees when they are
 * WORRIED was the message least entitled to reassure them. Same family as
 * `notifications.status = 'sent'` meaning only "Twilio returned 2xx", and as `IsSuccess:
 * true` on a cart that held nothing.
 *
 * ── WHY A SOURCE TEST ──────────────────────────────────────────────────────────────────
 * Importing the runner STARTS it, the same reason `claim.ts` was split out of the poller,
 * and the behaviour needs a live Chromium and a real RC session besides. The defect was a
 * claim in a string sitting on the wrong side of a `return`, which is exactly the shape a
 * source assertion catches and a reader does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');
/** Comments stripped — the note explaining each rule quotes the string it forbids. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function smokeBody(): string {
  const i = src.indexOf('async function smokeTest');
  assert.ok(i > 0, 'smokeTest must exist');
  const end = src.indexOf('\nasync function runPass', i);
  assert.ok(end > i);
  return code(src.slice(i, end));
}

test('the quiet pass never claims a token it did not ask for', () => {
  // THE BUG, as a string. It is gone from the code; it may still appear in the comment
  // explaining why, which is why this reads stripped source.
  assert.ok(!/token accepted/.test(code(src)),
    'the quiet path must not assert the token was accepted — it never asked for one');
});

test('the quiet branch hands off to the smoke test rather than just logging', () => {
  const quiet = code(src).slice(
    code(src).indexOf('if (!claim.length && !cart.length && !release.length)'),
  ).slice(0, 400);
  assert.match(quiet, /if \(ONCE\) await smokeTest\(\)/,
    'ONCE must run the smoke test, and must AWAIT it or the process exits mid-probe');
});

test('the smoke test actually opens the profile and reads a token', () => {
  // The entire point: withRC takes the profile, launches Chromium, primes the real in-page
  // token and decodes its expiry. Without this call the function is the old log line again.
  const body = smokeBody();
  assert.match(body, /await withRC\(/, 'the smoke test must go through withRC');
  assert.match(body, /tokenSecondsLeft\(token\)/, 'and must read the token it obtained');
});

test('a profile it could not take is NOT reported as a session verdict', () => {
  // The 2026-08-10 shape: the keep-warm held the profile for ten hours and every check that
  // met it read as "fine". "We could not test" is a third outcome and has to survive as one.
  const body = smokeBody();
  assert.match(body, /out\?\.skipped/, 'the skipped path must be handled distinctly');
  assert.match(body, /was not tested|not a verdict/i,
    'an unopened profile must say the session was not tested, not pass or fail it');
});

test('an expired or undecodable token is never rounded up to a pass', () => {
  // `primeToken` returns the stale localStorage copy when okta-auth-js has not cleared it
  // yet — that is the false green caught on 2026-08-09, where presence read as liveness.
  const body = smokeBody();
  assert.match(body, /left <= 0/, 'an expired token must fail explicitly');
  assert.match(body, /left == null/, 'an undecodable token must prove nothing');
  const passIdx = body.indexOf('RC session works');
  assert.ok(passIdx > body.indexOf('left <= 0'),
    'the success line must come after both rejections, so neither can fall through to it');
});

test('the pass states what it did NOT prove', () => {
  // The cart POSTs cannot be rehearsed: they need a genuine held unit, and an invented unit
  // id can collide with a real site and lock it. A green line that does not say so invites
  // exactly the confidence that 2026-08-08 punished.
  assert.match(smokeBody(), /NOT tested/,
    'the success line must name the cart POSTs as unproven');
});
