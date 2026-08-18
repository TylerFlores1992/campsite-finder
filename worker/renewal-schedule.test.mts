/**
 * WHEN THE KEEP-WARM MAY RE-MINT THE RC TOKEN.
 *
 * ── THE DEFECT THIS GUARDS ─────────────────────────────────────────────────────────────
 * The old condition was one line in the middle of a `for(;;)`:
 *
 *     if (left != null && left > 0 && left < RENEW_BEFORE_S && token !== lastRenewAttemptFor)
 *
 * Every clause of it was defensible and the whole was wrong: `left != null && left > 0`
 * refuses to act on a session that has ALREADY run out, which is the one state where a
 * re-mint costs nothing (there is no token to clear and none to restore) and is worth most.
 * Measured off the box on 2026-08-15 — ninety dead minutes in one evening, in two runs, with
 * `okta session STILL ALIVE` printed on every line and nothing trying. Both were repaired
 * only when somebody happened to queue a hold, because `maybeAutoLogin` was the only caller.
 *
 * ── AND WHY IT IS A MODULE ─────────────────────────────────────────────────────────────
 * The rules are a floor, a gap, a backoff and a same-state test, and they live inside a loop
 * that starts on import and drives a headful browser. Nothing about them can be exercised
 * where they sit. Same division as `session-coverage.mjs`, whose two functions were both
 * wrong in production for exactly that reason.
 *
 * Every test below was verified by breaking the code and watching it fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planRenewal, recordRenewal, newRenewalState, makeSkipLogger,
  RENEW_FLOOR_MS, RENEW_MIN_GAP_MS, RENEW_BACKOFF_GAP_MS, RENEW_BACKOFF_AFTER,
} from '../scripts/auto-cart-bot/renewal-schedule.mjs';

const RENEW_BEFORE_S = 600;
const T0 = 1_800_000_000_000;
const ask = (o: Record<string, unknown>) =>
  planRenewal({ now: T0, state: newRenewalState(), ...o } as never);

test('a healthy token is left alone', () => {
  const r = ask({ token: 'eyJ.A.s', leftS: 3400 });
  assert.equal(r.go, false);
  assert.match(r.reason, /57m left/, 'and the reason says how much life it saw');
});

test('a token near expiry is LEFT ALONE — renewing a live token is what leaks', () => {
  /**
   * INVERTED 2026-08-18. This used to assert `go === true` at 5 minutes left, and that
   * behaviour is the Chromium leak.
   *
   *   • Five ramps on 08-18, five near-expiry renewals (`the token has 10m left (src=live)`).
   *     Not one completed — the RAM guard killed the browser every time.
   *   • The failures predate the guard: `554s → none`, `-115s → none`, both with okta=ALIVE.
   *   • The RAM trail dated the onset to `renew:prime-after-reload` — the reload that follows
   *     dropStoredToken. Clearing a LIVE token and reloading is the act that allocates.
   *
   * So the cell this test protected has never once produced a fresher token, and it is where
   * ~2,400 MB/min of non-JS memory comes from. Waiting costs at most one floor interval of
   * dead session — which the failed renewal cost anyway, plus several GB.
   */
  const r = ask({ token: 'eyJ.A.s', leftS: 300 });
  assert.equal(r.go, false, 'a live token must be left to lapse');
  assert.match(r.reason, /waiting for it to lapse/);
  assert.equal(r.key, 'alive');
});

test('the boundary is LIVE-vs-DEAD, not a near-expiry threshold', () => {
  // One second of life is still life; zero is not. Pinning the boundary stops the old
  // threshold creeping back in as "well, under a minute is basically expired".
  assert.equal(ask({ token: 'eyJ.A.s', leftS: 1 }).go, false, '1s left is still alive');
  assert.equal(ask({ token: 'eyJ.A.s', leftS: 0 }).go, true, '0s is lapsed — act');
});

test('NO TOKEN AT ALL is a reason to act, not a reason to wait', () => {
  // THE NINETY MINUTES. `leftS: null` is "the app holds no usable token" — signed out, or a
  // token that will not decode — and the old condition's `left != null` refused it outright.
  const r = ask({ token: null, leftS: null });
  assert.equal(r.go, true, 'a signed-out profile is exactly what a free re-mint is for');
  assert.match(r.reason, /no usable token/);
});

test('an ALREADY EXPIRED token is a reason to act too', () => {
  // The other half of the old refusal (`left > 0`). A token four minutes past its expiry is
  // not a session to protect; on 2026-08-15 the loop watched one go to -4m and then sat.
  assert.equal(ask({ token: 'eyJ.A.s', leftS: -240 }).go, true);
});

test('the floor holds even when the state changed', () => {
  // A flapping read — token, none, token — must not become a busy loop wearing a service's
  // clothes. This is the only rule that does not care what changed.
  const state = { lastAt: T0 - 60_000, lastToken: 'eyJ.OLD.s', failures: 0 };
  const r = planRenewal({
    token: null, leftS: null, now: T0, state,
  });
  assert.equal(r.go, false);
  assert.match(r.reason, /floor/);
});

test('past the floor, a CHANGED state is acted on at once', () => {
  // The gap exists to stop re-asking an unchanged question. A token that has vanished since
  // the last attempt is new information, and making it wait out the full gap would leave the
  // session dead for ten minutes it did not need to be.
  const state = { lastAt: T0 - (RENEW_FLOOR_MS + 1000), lastToken: 'eyJ.OLD.s', failures: 0 };
  const r = planRenewal({ token: null, leftS: null, now: T0, state });
  assert.equal(r.go, true, 'token → no token is a state change, not a repeat');
});

test('an UNCHANGED state waits out the gap', () => {
  const state = { lastAt: T0 - (RENEW_FLOOR_MS + 1000), lastToken: null, failures: 0 };
  const r = planRenewal({ token: null, leftS: null, now: T0, state });
  assert.equal(r.go, false);
  assert.match(r.reason, /nothing has changed/);

  const later = { ...state, lastAt: T0 - (RENEW_MIN_GAP_MS + 1000) };
  assert.equal(
    planRenewal({ token: null, leftS: null, now: T0, state: later }).go,
    true,
  );
});

test('"no token" is a real state and not the never-attempted sentinel', () => {
  // `newRenewalState` uses `lastToken: undefined` deliberately. Had it used `null`, the very
  // first signed-out tick would compare equal to "never attempted" and be refused as a
  // repeat — the schedule declining to act on the one case it was written for.
  assert.equal(newRenewalState().lastToken, undefined);
  assert.notEqual(newRenewalState().lastToken, null);
  assert.equal(ask({ token: null, leftS: null }).go, true);
});

test('repeated failures back off, and NEVER stop', () => {
  // A dead Okta session fails every attempt identically until a human signs in, and there is
  // no point discovering that six times an hour. But a gate that switches itself off for good
  // is the `.camphawk-ready` bug: one failure, twelve days ago, and the repair never ran again.
  const failing = { lastAt: T0 - (RENEW_MIN_GAP_MS + 1000), lastToken: null, failures: RENEW_BACKOFF_AFTER };
  const held = planRenewal({ token: null, leftS: null, now: T0, state: failing });
  assert.equal(held.go, false, 'past the min gap but inside the backoff');
  assert.match(held.reason, /in a row have failed/);

  const eventually = { ...failing, lastAt: T0 - (RENEW_BACKOFF_GAP_MS + 1000) };
  assert.equal(
    planRenewal({ token: null, leftS: null, now: T0, state: eventually }).go,
    true,
    'the backoff must be a longer wait, never a permanent stand-down',
  );
});

test('recordRenewal keys on the token we attempted AGAINST, and resets on success', () => {
  // Storing the token we RECEIVED would make a successful renewal look like an untried state
  // the moment its own token neared expiry — the same class of error as measuring a renewal
  // against the token it meant to replace.
  const s0 = newRenewalState();
  const s1 = recordRenewal(s0, { token: 'eyJ.OLD.s', now: T0, renewed: false });
  assert.equal(s1.lastToken, 'eyJ.OLD.s');
  assert.equal(s1.lastAt, T0);
  assert.equal(s1.failures, 1);

  assert.equal(recordRenewal(s1, { token: 'eyJ.OLD.s', now: T0, renewed: false }).failures, 2);
  assert.equal(recordRenewal(s1, { token: 'eyJ.OLD.s', now: T0, renewed: true }).failures, 0,
    'a success clears the backoff, or one bad night poisons the next good one');
});

test('the numbers are ordered floor < gap < backoff', () => {
  // Asserted as an inequality rather than as three literals, because the numbers are
  // tuneable and the ORDERING is the property. A backoff shorter than the gap would make
  // failing attempts more frequent than succeeding ones.
  assert.ok(RENEW_FLOOR_MS < RENEW_MIN_GAP_MS, 'the floor is the tightest bound');
  assert.ok(RENEW_MIN_GAP_MS < RENEW_BACKOFF_GAP_MS, 'failing must slow down, not speed up');
  assert.ok(RENEW_BACKOFF_AFTER >= 2, 'one failure is a blip, not a pattern');
});

/**
 * ── THE STRUCTURAL HALF ────────────────────────────────────────────────────────────────
 * The pure functions can be perfect while nothing calls them. Three of the 2026-08-15
 * mutations were exactly that shape, and it is the version of a fix that passes review.
 */
const keepwarm = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const kwCode = keepwarm.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the keep-warm decides through planRenewal, not through its own condition', () => {
  assert.match(kwCode, /const plan = planRenewal\(\{/, 'the loop must ask the module');
  assert.match(kwCode, /if \(!plan\.go\) \{/, 'and honour the answer');
  assert.ok(!/left != null && left > 0 && left < RENEW_BEFORE_S/.test(kwCode),
    'the old inline condition must be gone, or the signed-out case is still refused');
});

test('the outcome is recorded, so the ration can see the attempt', () => {
  // An attempt made and not recorded is an attempt the floor cannot see, which turns the
  // ration into no ration at all — from an address that has been IP-blocked before.
  assert.match(kwCode, /renewal = recordRenewal\(renewal, \{ token, now: Date\.now\(\), renewed: r\?\.renewed === true \}\)/,
    'and it must be assigned back, or the state never advances');
});

test('the ration state outlives a browser reopen', () => {
  // THE BUG THIS WOULD OTHERWISE BE. `warmResident` closes and reopens its context every
  // time the hold runner wants the Chromium profile — ten times in four hours on 2026-08-15.
  // State declared inside that loop resets on every one, so the floor and the backoff would
  // bound nothing and a dead Okta session would be re-asked every few minutes.
  const decl = kwCode.indexOf('let renewal = newRenewalState()');
  assert.ok(decl > 0, 'the renewal state must exist');
  assert.ok(decl < kwCode.indexOf('async function warmResident'),
    'it must be declared at module scope, ABOVE warmResident, not inside its reopen loop');
});

test('Okta is asked only when there is a token to lose', () => {
  // `/api/v1/sessions/me` REFRESHES Okta's idle timer, so asking on every attempt extends
  // the very window whose length we are trying to learn. The probe exists to guard a
  // DESTRUCTIVE clear; with no token in the app there is nothing to clear, so it guards
  // nothing there and is skipped. The attempt is self-diagnosing either way.
  assert.match(kwCode, /const okta = token \? await oktaSessionAlive\(ctx\)\.catch\(\(\) => null\) : null;/,
    'the probe must be conditional on there being a token at risk');
});

test('the renewal log names the stage and collapses repeats', () => {
  // "renewed" without saying HOW is how one mechanism gets credited for another's work — and
  // `reload` succeeding is the standing signal that this can be simplified back down.
  assert.match(kwCode, /renewed by \$\{r\.stage\}/, 'the success line must name the stage');
  assert.match(kwCode, /got as far as: \$\{r\.stage\}/, 'and so must the failure line');
  // The loop asks every 60 seconds. An un-collapsed stand-down line is 1,440 entries a day,
  // which hides the answer as thoroughly as printing nothing — the fault `autoLoginSkip` was
  // written for, in the function immediately below it.
  assert.match(kwCode, /const renewalSkip = makeSkipLogger\(/,
    'the collapse must go through the tested helper, not a private copy in the loop');
  assert.match(kwCode, /renewalSkip\(plan\.key, plan\.reason\)/,
    'and the caller must hand over both halves — the state to compare and the words to print');
});

test('the collapse compares the state and prints the sentence', () => {
  // THIS WAS A SOURCE SCAN AND THE SCAN COULD NOT SEE THROUGH IT. Six lines in the keep-warm,
  // pinned by a regex on their own shape — and a mutation reinstating the volatile comparison
  // from INSIDE the body (`key = reason` at the top) matched the shape and passed. Behaviour
  // that can go wrong belongs where behaviour can be tested.
  const said: string[] = [];
  const skip = makeSkipLogger((r: string) => said.push(r));

  assert.equal(skip('healthy', 'the token has 57m left'), true);
  // THE CASE THE WHOLE KEY EXISTS FOR: same state, sentence changing every minute as the
  // token ages. Comparing sentences here is 1,440 lines a day.
  assert.equal(skip('healthy', 'the token has 56m left'), false);
  assert.equal(skip('healthy', 'the token has 55m left'), false);
  assert.deepEqual(said, ['the token has 57m left'], 'one line for one state');

  assert.equal(skip('floor', 'only 1m since the last attempt (floor is 5m)'), true,
    'a genuinely different state must still speak');
  assert.equal(said.length, 2);

  // AND IT MUST BE ABLE TO SAY THE SAME THING AGAIN LATER. A logger that remembered every key
  // it had ever seen would go silent for the life of the process — a keep-warm that reports a
  // problem once at 03:00 and never again is a keep-warm nobody can diagnose at 07:45.
  assert.equal(skip('healthy', 'the token has 59m left'), true);
  assert.deepEqual(said.length, 3);
});

test('every stand-down carries a STABLE key beside its changing sentence', () => {
  // THE DEDUPE WOULD OTHERWISE COLLAPSE NOTHING. Each reason embeds a minute count that
  // changes on every 60-second ask — "the token has 57m left", then 56, then 55 — so a
  // comparison on the sentence prints 1,440 lines a day and hides the answer exactly as
  // well as printing none. That is the flood `autoLoginSkip` was written to stop, arriving
  // through the door its own constant strings had closed.
  const seen = new Set<string>();
  const cases = [
    ask({ token: 'eyJ.A.s', leftS: 3400 }),
    ask({ token: 'eyJ.A.s', leftS: 300 }),
    // `go` used to come from the near-expiry case above. That now stands down as `alive`,
    // so the acting state has to be produced by the cell that still acts: no usable token.
    ask({ token: null, leftS: null }),
    planRenewal({ token: null, leftS: null, now: T0,
      state: { lastAt: T0 - 60_000, lastToken: 'eyJ.OLD.s', failures: 0 } }),
    planRenewal({ token: null, leftS: null, now: T0,
      state: { lastAt: T0 - (RENEW_FLOOR_MS + 1000), lastToken: null, failures: 0 } }),
    planRenewal({ token: null, leftS: null, now: T0,
      state: { lastAt: T0 - (RENEW_MIN_GAP_MS + 1000), lastToken: null, failures: RENEW_BACKOFF_AFTER } }),
  ];
  for (const c of cases) {
    assert.ok(c.key, `every outcome needs a key (${c.reason})`);
    seen.add(c.key);
  }
  assert.deepEqual([...seen].sort(), ['alive', 'backoff', 'floor', 'go', 'unchanged'],
    'the five states must be distinguishable, or two of them collapse into one line');

  // AND THE KEY MUST NOT CONTAIN THE NUMBERS. A key built from the reason would be as
  // volatile as the reason and the collapse would be decoration.
  const aging = [3400, 3340, 3280].map((leftS) => ask({ token: 'eyJ.A.s', leftS }));
  assert.equal(new Set(aging.map((c) => c.key)).size, 1,
    'a token merely getting older is the same state and must print once');
  assert.equal(new Set(aging.map((c) => c.reason)).size, 3,
    'while the sentence still reports the current number — which is why they are separate');
});
