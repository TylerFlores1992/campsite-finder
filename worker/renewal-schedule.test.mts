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
  noteLiveToken, renewBackoffGapMs,
  RENEW_FLOOR_MS, RENEW_MIN_GAP_MS, RENEW_BACKOFF_GAP_MS, RENEW_BACKOFF_MAX_MS,
  RENEW_BACKOFF_AFTER,
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

test('the backoff LADDER doubles per failure past the threshold', () => {
  /**
   * THE LEVER, AND IT IS ARITHMETIC (2026-09-20). Every Okta navigation is a chance at a
   * ~32 GiB commit burst — established by 2026-08-18's controlled comparison, where three
   * token-less renewals ten minutes apart cost nothing and the one that clicked through Okta
   * cost 2,331 MB. Re-derived off `bot_events` over the 168h to 2026-09-20: 255 renewal trips
   * = 36.4/day, of which 200 of 254 gaps sat in the flat 30-minute backoff band and the
   * MEDIAN gap was 31.5m. The schedule was, in practice, the flat backoff and nothing else.
   *
   * Asserted as a RATIO against the previous rung rather than as four literals, because the
   * rungs are tuneable and the DOUBLING is the property. Four literals would pin 2026-09-20's
   * numbers and fail the next time somebody reasonably retunes the first rung.
   */
  const rung = (failures: number) => renewBackoffGapMs(failures);

  assert.equal(rung(RENEW_BACKOFF_AFTER), RENEW_BACKOFF_GAP_MS,
    'the FIRST rung is unchanged — the flat backoff is what this escalates FROM');
  for (let n = RENEW_BACKOFF_AFTER; rung(n) < RENEW_BACKOFF_MAX_MS; n++) {
    assert.equal(rung(n + 1), Math.min(rung(n) * 2, RENEW_BACKOFF_MAX_MS),
      `failure ${n + 1} must be twice failure ${n}, capped`);
  }
  // And it really does climb — a ladder that is all cap is the flat backoff with extra words.
  assert.ok(rung(RENEW_BACKOFF_AFTER + 1) > rung(RENEW_BACKOFF_AFTER),
    'one more failure must actually be a longer wait');

  // The named ladder from CLAUDE.md, at today's constants: 30 -> 60 -> 120 -> 240.
  assert.deepEqual(
    [0, 1, 2, 3].map((k) => rung(RENEW_BACKOFF_AFTER + k) / 60_000),
    [30, 60, 120, 240],
  );
});

test('the ladder is a CEILING and never a STOP, at any failure count', () => {
  /**
   * THE `.camphawk-ready` RULE, WHICH THIS MODULE'S OWN HEADER STATES: a gate that switches
   * itself off permanently is the bug where one failure twelve days earlier meant the repair
   * never ran again. An escalating backoff is exactly how that bug comes back as arithmetic
   * rather than as a boolean, so the cap is asserted against a failure count no episode could
   * reach — and against one that would overflow `2 ** n` to Infinity if the ladder were
   * written as an exponent, which is why it is not.
   */
  for (const failures of [10, 100, 1_000, 10_000, Number.MAX_SAFE_INTEGER]) {
    const gap = renewBackoffGapMs(failures);
    assert.equal(gap, RENEW_BACKOFF_MAX_MS, `failures=${failures} must sit at the ceiling`);
    assert.ok(Number.isFinite(gap), 'a non-finite gap compares false and is no backoff at all');
  }

  // AND THE SCHEDULE ITSELF MUST STILL SAY YES once the ceiling has been waited out. The
  // ladder bounding the WAIT is worthless if some arm of planRenewal then refuses for ever.
  const forever = {
    lastAt: T0 - (RENEW_BACKOFF_MAX_MS + 1000), lastToken: null, failures: 50_000,
  };
  const r = planRenewal({ token: null, leftS: null, now: T0, state: forever });
  assert.equal(r.go, true, 'fifty thousand failures deep, it must still try');
  // ...and one tick earlier it must still be holding, or the cap is not being applied at all.
  assert.equal(
    planRenewal({ token: null, leftS: null, now: T0, state: { ...forever, lastAt: T0 - (RENEW_BACKOFF_MAX_MS - 60_000) } }).go,
    false,
    'inside the ceiling it waits — otherwise the escalation is inert',
  );
});

test('the ladder TERMINATES on degenerate inputs — a hung bot beats every ramp', () => {
  /**
   * FOUND BY THE MUTATION RUN, IN THE FIRST DRAFT OF THIS VERY FUNCTION. It was written
   * `for (let n = backoffAfter; n < failures && gap < backoffMaxMs; n++) gap *= 2`, which is
   * bounded by the value it is mutating — and doubling ZERO never reaches the cap, so a first
   * rung of 0 spins to MAX_SAFE_INTEGER. Measured at 5,000,001 iterations and still going.
   * That loop sits inside the keep-warm's own `for(;;)`: it is not a slow schedule, it is a
   * hung bot and a dead session, which is strictly worse than the ramps the ladder buys.
   *
   * So the iteration count is bounded by a constant and this test is the reason it stays that
   * way. Every case below would hang, not fail, under the original — which is itself the
   * argument for asserting the property rather than trusting the reading.
   */
  // THE STRUCTURAL HALF RUNS FIRST, AND THE ORDER IS THE POINT. The behavioural half below
  // can only fail by HANGING — under the first draft this test does not go red, it never
  // returns, and node:test then runs nothing after it either. Checked with the mutation
  // applied: killed at 45s, having asserted nothing. So the shape is asserted BEFORE the
  // behaviour, and a reinstated exit condition fails in milliseconds with a message that
  // names the line. A guard whose failure mode is a test run that never finishes is a guard
  // somebody deletes.
  const sched = readFileSync('scripts/auto-cart-bot/renewal-schedule.mjs', 'utf8');
  const ladder = sched.slice(sched.indexOf('export function renewBackoffGapMs'));
  const loop = ladder.slice(ladder.indexOf('for ('), ladder.indexOf(')', ladder.indexOf('for (')) + 1);
  assert.ok(loop.length > 0, 'the ladder must still have a loop to check');
  assert.ok(!/gap\s*<|<\s*gap/.test(loop),
    `the loop must not be bounded by the gap it is doubling — found: ${loop}`);

  const huge = Number.MAX_SAFE_INTEGER;
  assert.equal(renewBackoffGapMs(huge, { backoffGapMs: 0 }), 0,
    'a zero first rung stays zero — degenerate, but it must RETURN');
  assert.ok(Number.isFinite(renewBackoffGapMs(huge, { backoffGapMs: 1 })));
  assert.ok(Number.isFinite(renewBackoffGapMs(huge)));

  // Nonsense failure counts fall to the safe end of the ladder rather than off it.
  assert.equal(renewBackoffGapMs(Number.NaN), RENEW_BACKOFF_GAP_MS, 'NaN → the first rung');
  assert.equal(renewBackoffGapMs(-5), RENEW_BACKOFF_GAP_MS, 'negative → the first rung');
  assert.equal(renewBackoffGapMs(0), RENEW_BACKOFF_GAP_MS);
});

test('the stand-down NAMES the rung, and says whether it is still climbing', () => {
  // The caller collapses on the KEY, and every rung shares the key `backoff`, so this state
  // prints once per episode. The sentence is therefore the only place the rung is legible to
  // a human at 07:45 — and "still doubling" and "this is as slow as it gets, now waiting for
  // a human" are different news, which a bare minute count cannot distinguish.
  const at = (failures: number) => planRenewal({
    token: null, leftS: null, now: T0,
    state: { lastAt: T0 - (RENEW_MIN_GAP_MS + 1000), lastToken: null, failures },
  });

  const first = at(RENEW_BACKOFF_AFTER);
  assert.equal(first.key, 'backoff', 'the key must not change with the rung, or the collapse breaks');
  assert.match(first.reason, /30m apart/);
  assert.match(first.reason, /doubling to 240m/, 'a climbing rung must say it is still climbing');

  const capped = at(RENEW_BACKOFF_AFTER + 9);
  assert.equal(capped.key, 'backoff');
  assert.match(capped.reason, /240m apart/);
  assert.match(capped.reason, /never stops entirely/, 'the ceiling must say it is not a stop');
  assert.ok(!/doubling to/.test(capped.reason), 'and must not claim to still be climbing');
});

test('A LIVE TOKEN RESETS THE FAILURE COUNT — the one real cost of escalating', () => {
  /**
   * THE NAMED HAZARD (CLAUDE.md, "THE REAL LEVER"). `maybeAutoLogin` repairs the session at
   * T−30 of a release and does NOT call `recordRenewal`, so `failures` survives the repair.
   * Under a FLAT backoff that was harmless — the next episode's first attempt came 30 minutes
   * in either way. Under an escalating one it is silent and backwards: the session that was
   * just repaired is the one whose NEXT lapse waits four hours, on a counter belonging to the
   * previous episode. That is worse than the ramps the escalation buys.
   */
  const spent = { lastAt: T0 - 5 * 60_000, lastToken: null, failures: 40 };
  assert.equal(renewBackoffGapMs(spent.failures), RENEW_BACKOFF_MAX_MS, 'pinned at the ceiling');

  const repaired = noteLiveToken(spent, { leftS: 3400 });
  assert.equal(repaired.failures, 0, 'a working session is evidence the failing episode ended');

  // AND THE RESET MUST NOT REACH THE OTHER TWO FIELDS.
  assert.equal(repaired.lastAt, spent.lastAt,
    'the FLOOR is request pacing from an IP-blocked address and is owed regardless');
  assert.equal(repaired.lastToken, spent.lastToken,
    'lastToken is the have-we-tried-this key; a live token is not an attempt');
  assert.equal(spent.failures, 40, 'and it must not mutate the state it was handed');

  // THE POINT OF ALL OF IT: the NEXT lapse starts at minGap, not at the ceiling.
  const lapsed = { ...repaired, lastAt: T0 - (RENEW_MIN_GAP_MS + 1000) };
  assert.equal(planRenewal({ token: null, leftS: null, now: T0, state: lapsed }).go, true,
    'a fresh episode must not inherit the previous one\'s four-hour gap');
  assert.equal(
    planRenewal({ token: null, leftS: null, now: T0, state: { ...spent, lastAt: lapsed.lastAt } }).go,
    false,
    'and without the reset it would have waited — which is the bug this guards',
  );
});

test('a DEAD token is not a live one, however well it decodes', () => {
  // THE THREE-DAY-OLD CORPSE (2026-08-19): four consecutive renewals ended `none -> -267960s`,
  // the same ancient token restored during every navigation. It decodes perfectly. Treating a
  // decodable token as evidence of a working session would reset the counter on exactly the
  // pathology the backoff exists for, and the escalation would never engage at all.
  const spent = { lastAt: T0, lastToken: null, failures: 40 };
  assert.equal(noteLiveToken(spent, { leftS: -267_960 }).failures, 40, 'a 74-hour corpse');
  assert.equal(noteLiveToken(spent, { leftS: 0 }).failures, 40, 'zero is lapsed, not alive');
  assert.equal(noteLiveToken(spent, { leftS: null }).failures, 40, 'no usable token at all');
  assert.equal(noteLiveToken(spent, { leftS: undefined }).failures, 40, 'nor an absent reading');
  // One second of life IS life — the same boundary planRenewal stands down on, deliberately.
  assert.equal(noteLiveToken(spent, { leftS: 1 }).failures, 0);
  // A state with nothing to clear comes back untouched, so the caller\'s assignment is a no-op.
  const clean = { lastAt: T0, lastToken: null, failures: 0 };
  assert.equal(noteLiveToken(clean, { leftS: 3400 }), clean, 'same object when there is no work');
});

test('the FLOOR, the MIN GAP and the ALIVE stand-down are unchanged by the escalation', () => {
  // THE REGRESSION HALF. The escalation touches one branch; these are the three properties
  // that cost this repo ninety dead minutes (2026-08-15) and five ramps (2026-08-18) to get
  // right, and a change to the backoff must not have moved any of them. Asserted at a HIGH
  // failure count, because that is where a mis-scoped ladder would leak into them.
  const deep = 40;

  // ALIVE still wins over everything, including a maxed-out backoff.
  const alive = planRenewal({
    token: 'eyJ.A.s', leftS: 300, now: T0,
    state: { lastAt: T0 - 10 * RENEW_BACKOFF_MAX_MS, lastToken: null, failures: deep },
  });
  assert.equal(alive.key, 'alive', 'a live token is left to lapse whatever the counter says');

  // THE FLOOR still outranks the backoff, in both directions.
  const floored = planRenewal({
    token: null, leftS: null, now: T0,
    state: { lastAt: T0 - 60_000, lastToken: 'eyJ.OLD.s', failures: deep },
  });
  assert.equal(floored.key, 'floor', 'the floor is the tightest bound and answers first');

  // `leftS == null` and `leftS <= 0` both still ACT — refusing them is the ninety minutes.
  const ready = { lastAt: T0 - (RENEW_BACKOFF_MAX_MS + 1000), lastToken: 'eyJ.OLD.s', failures: deep };
  assert.equal(planRenewal({ token: null, leftS: null, now: T0, state: ready }).go, true);
  assert.equal(planRenewal({ token: 'eyJ.A.s', leftS: -240, now: T0, state: ready }).go, true);
  assert.equal(planRenewal({ token: 'eyJ.A.s', leftS: 0, now: T0, state: ready }).go, true);

  // AND A SUB-THRESHOLD FAILURE COUNT STILL GETS THE PLAIN MIN GAP, not a rung.
  for (let n = 0; n < RENEW_BACKOFF_AFTER; n++) {
    const r = planRenewal({
      token: null, leftS: null, now: T0,
      state: { lastAt: T0 - (RENEW_MIN_GAP_MS - 60_000), lastToken: null, failures: n },
    });
    assert.equal(r.key, 'unchanged', `failures=${n} is below the threshold — no backoff`);
    assert.match(r.reason, /nothing has changed/);
  }
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
  // ...and the ceiling is above the first rung, or the ladder has nowhere to climb and the
  // escalation is decoration. It is a CEILING and never a stop — asserted on its own below.
  assert.ok(RENEW_BACKOFF_GAP_MS < RENEW_BACKOFF_MAX_MS,
    'the backoff must have room to escalate, or the doubling is inert');
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

test('the keep-warm APPLIES the live-token reset, and assigns it back', () => {
  /**
   * THE STRUCTURAL HALF OF THE NAMED HAZARD, and it is the shape three of the 2026-08-15
   * mutations had: the pure function can be perfect while nothing calls it. `noteLiveToken`
   * returns a NEW state — a call whose result is thrown away is indistinguishable from no
   * call at all, and the failure it causes (a repaired session waiting four hours for its
   * next lapse) is silent, slow and would be blamed on anything but this line.
   */
  assert.match(kwCode, /renewal = noteLiveToken\(renewal, \{ leftS: left \}\)/,
    'the reset must be applied AND assigned back, or the escalation outlives its episode');

  // AND IT MUST COME BEFORE THE PLAN THAT READS IT. Called after `planRenewal`, the reset
  // lands a whole tick late — harmless today, because the alive branch stands down anyway,
  // and exactly the kind of ordering that stops being harmless when a branch is added.
  const reset = kwCode.indexOf('renewal = noteLiveToken(renewal,');
  const plan = kwCode.indexOf('const plan = planRenewal({');
  assert.ok(reset > 0 && plan > 0, 'both lines must exist');
  assert.ok(reset < plan, 'the observation must be applied before the plan that reads it');

  // ...and from the SAME reading. Re-deriving the token life for the reset would let the two
  // disagree, which is the class of bug that made a renewal get measured against the token it
  // meant to replace.
  assert.match(kwCode, /const left = tokenSecondsLeft\(token\);/,
    'one reading of the token life, shared by the reset and the plan');
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

test('the skip logger collapses on the KEY and can be reset', () => {
  // THE POINT OF A KEY: the sentence may change on every ask (these all carry a minute count)
  // and the line must still print once. Comparing the sentence is what made `autoLoginSkip`
  // and `warmupSkip` flood `rc-keepwarm.log` with a countdown for as long as a release was
  // queued — 86% of the file, measured 2026-09-16.
  const out: string[] = [];
  const skip = makeSkipLogger((r: string) => out.push(r));
  for (let m = 900; m > 880; m--) skip('outside-lead', `the release is ${m}m away`);
  assert.equal(out.length, 1, 'twenty asks, one state, one line');
  assert.equal(out[0], 'the release is 900m away', 'and the FIRST sentence is the one kept');

  // A different state prints again.
  skip('inside-lead', 'the release is 20m away');
  assert.equal(out.length, 2);

  // RESET EXISTS BECAUSE AN ATTEMPT IS A STATE CHANGE THE KEY CANNOT SEE. `rc-keepwarm.mjs`
  // clears both loggers immediately before it spends a sign-in; without it the stand-down that
  // follows an attempt is swallowed whenever it names the state that preceded it.
  assert.equal(typeof skip.reset, 'function', 'makeSkipLogger must expose reset()');
  skip.reset();
  skip('inside-lead', 'the release is 20m away');
  assert.equal(out.length, 3, 'after a reset the same state must print again');
});
