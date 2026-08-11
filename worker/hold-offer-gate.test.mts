/**
 * Never promise a hold when there is no bot to honour it.
 *
 * THE INCIDENT (2026-08-11). The RC hold runner and keep-warm stopped at 09:36 PT. Nothing
 * restarted them and nothing refused on their behalf, so the poller went on offering
 * "Hold it for me" buttons for over two hours — the last one eight minutes before this was
 * written. Tapping one would have answered *"We'll grab site #P177 the moment it opens"*
 * with nothing running to do it.
 *
 * The cost is not the failed cart. It is that a user who believes the site is handled STOPS
 * WATCHING, so a morning they could have won by setting an alarm is lost instead. The same
 * argument is already written on the claim screen about promising an automatic cart before
 * the cart POSTs were proven — this is that rule applied one step earlier.
 *
 * These are source assertions rather than a live DB test on purpose: the thing that broke
 * was the ABSENCE of a call, and absence is what a source assertion can hold. `rcBotUsable`
 * itself is one indexed row and a subtraction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RC_RUNNER_STALE_MS } from '../src/lib/health-thresholds.js';

const poller = readFileSync('worker/poller.ts', 'utf8');
const actions = readFileSync('src/lib/notifications/actions.ts', 'utf8');
const holds = readFileSync('src/lib/rc-holds.ts', 'utf8');
/** Source with comment lines stripped — or "must not X" matches the comment saying why not. */
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the poller will not offer a hold without a live runner', () => {
  const body = code(poller);
  assert.match(body, /const bot = await rcBotUsable\(\)/);
  // The gate has to be ON `mayHold`. Computing the fact and not using it is precisely the
  // shape of the bug — the runner heartbeat existed the whole time and nothing consulted it.
  assert.match(body, /const mayHold\s*=[\s\S]{0,160}bot\.ok/);
});

test('the alert still goes out — only the button is withheld', () => {
  // Suppressing the whole coming-soon alert would be a worse cure than the disease: the
  // heads-up is the part the user can still act on, and it is what makes booking by hand
  // at 08:00 possible at all.
  const body = code(poller);
  // Ordering by index, not a character window — a `{0,N}` window is a magic number that
  // silently stops asserting the moment the code between the two points grows.
  const declared = body.indexOf('let holdUrl: string | null = null;');
  const gate = body.indexOf('const mayHold', declared);
  const dispatch = body.indexOf("kind: 'coming_soon'", gate);
  assert.ok(declared !== -1 && gate !== -1 && dispatch !== -1, 'could not locate the offer block');
  assert.ok(declared < gate && gate < dispatch, 'the gate must sit between holdUrl and the dispatch');
  // `holdUrl` is declared null and only ever assigned inside the gated branch, so a
  // withheld button cannot take the alert with it.
  const between = body.slice(declared, dispatch);
  assert.equal((between.match(/holdUrl = /g) ?? []).length, 1, 'holdUrl must be set in exactly one place');
  assert.match(between, /if \(mayHold[\s\S]*holdUrl = /, 'and that place must be inside the gate');
});

test('the tap tells the truth instead of refusing', () => {
  // A hold tapped the evening before an 08:00 release has all night to come good. Refusing
  // on a runner that is down right now would throw away a hold that would probably have
  // worked — the T-45 alarm mistake, one component over.
  const branch = actions.match(/if \(!bot\.ok\) \{[\s\S]*?\n      \}/)?.[0] ?? '';
  assert.ok(branch, 'the hold action must branch on bot liveness');
  assert.match(branch, /ok: true/, 'an offline bot must not reject the hold');
  assert.match(branch, /offline|yourself/i, 'and must say so plainly');
  // The confident copy must be unreachable when the bot is down.
  const confident = actions.indexOf("We'll grab ${site} the moment it opens");
  const gate = actions.indexOf('if (!bot.ok)');
  assert.ok(gate !== -1 && confident !== -1 && gate < confident);
});

test('failing to read the heartbeat counts as absent, not as healthy', () => {
  // Unknown is not healthy — the rule this codebase keeps arriving at. A hold nobody
  // honours costs a campsite; a missing button costs a convenience. The asymmetry decides
  // the direction.
  const fn = holds.match(/export async function rcBotUsable[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(fn, 'could not find rcBotUsable');
  assert.match(code(fn), /\.catch\(\(\) => \[\]\)/, 'a read failure must not throw into the caller');
  assert.match(code(fn), /if \(!row\?\.beat_at\) return \{ ok: false/);
  // And the caller must not turn a thrown read into a promise either.
  assert.match(actions, /rcBotUsable\(\)\.catch\(\(\) => \(\{ ok: false/);
});

test('one definition of "the runner is absent"', () => {
  // It was a local const in the health route; `rcBotUsable` now decides whether to OFFER a
  // hold by the same number the admin page judges the runner by. Two copies would let the
  // dashboard call the runner dead while the poller cheerfully promised a cart.
  assert.equal(RC_RUNNER_STALE_MS, 3 * 60 * 1000);
  assert.match(holds, /beatAgeMs <= RC_RUNNER_STALE_MS/);
  assert.doesNotMatch(
    code(readFileSync('src/app/api/health/status/route.ts', 'utf8')),
    /const RC_RUNNER_STALE_MS =/,
    'the health route must import it, not redeclare it',
  );
});
