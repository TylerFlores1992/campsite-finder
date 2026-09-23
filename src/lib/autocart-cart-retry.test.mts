/**
 * THE rec.gov CART LADDER — the guards on the part that can double-cart or lose an alert.
 *
 * On 2026-09-23 job 7c0c524f reported `add-not-confirmed` 11.4 seconds after detection, the
 * poller re-checked the site 200 ms later and found it STILL OPEN, and the paid feature sent a
 * "book it yourself" alert having tried exactly once. `scripts/auto-cart-bot/cart-retry.mjs`
 * is the retry; this file is every way it could quietly come back, plus the two failures it
 * must never introduce.
 *
 * WHY THE LADDER AND NOT JUST THE POLICY IS EXERCISED HERE. `runCartLadder` takes its effects
 * as arguments precisely so the decision "may we add again?" can be driven by a fake rather
 * than a headed browser. A pure `shouldRetry()` with the sequencing left in `recgov.mjs` would
 * be the fix-present-and-inert shape: every test green while the one `if` that stops a second
 * reservation sits in a 200-line Playwright driver nothing can call.
 *
 * It lives under `src/lib/` and NOT under `worker/` deliberately: `worker/**` is the first
 * entry in `worker-deploy.yml`'s `paths:`, so a test file there restarts all three pollers on
 * merge. Nothing in this change goes near the poller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CARTED, CART_BUDGET_MS, MAX_CART_ROUNDS, MIN_ROUND_RESERVE_MS,
  RETRY_GAP_BASE_MS, RETRY_GAP_MAX_MS, RETRY_GAP_JITTER_MS,
  RETRYABLE_CART_OUTCOMES, TERMINAL_CART_OUTCOMES,
  cartFamily, isRetryableCartOutcome, retryGapMs, planCartRetry, runCartLadder, cartOutcomeForDb,
  normaliseCartReport,
} from '../../scripts/auto-cart-bot/cart-retry.mjs';
import { BOT_EVENT_KINDS, recgovCartReading } from './bot-events';

const recgov = readFileSync('scripts/auto-cart-bot/recgov.mjs', 'utf8');
const bot = readFileSync('scripts/auto-cart-bot/bot.mjs', 'utf8');
const poller = readFileSync('worker/poller.ts', 'utf8');
const cartedHistory = readFileSync('worker/carted-history.ts', 'utf8');
const resultRoute = readFileSync('src/app/api/auto-cart/result/route.ts', 'utf8');

/** An `indexOf` that misses returns -1 and `slice(-1)` then passes for ever. Assert the anchor. */
const at = (hay: string, needle: string, what: string): number => {
  const i = hay.indexOf(needle);
  assert.ok(i > -1, `anchor moved — this guard is measuring nothing: ${what}`);
  return i;
};

// ── a controllable ladder rig ─────────────────────────────────────────────────────────────
type AddResult = { outcome: string; clicked?: boolean; note?: string };

/**
 * Drives `runCartLadder` with scripted answers and a FAKE CLOCK that advances by whatever each
 * step is told to cost. A real clock would make every budget assertion a race, and a clock that
 * never moves would make the budget unreachable — which is the mutation-survives-silently case.
 */
function rig(opts: {
  adds: (AddResult | (() => never))[];
  reads?: (string | (() => never))[];
  addMs?: number;
  readMs?: number;
  budgetMs?: number;
  maxRounds?: number;
  waitThrows?: boolean;
}) {
  let clock = 1_000_000;
  const addCalls: number[] = [];
  const readCalls: number[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  let a = 0;
  let r = 0;
  return {
    get addCount() { return addCalls.length; },
    get readCount() { return readCalls.length; },
    waits, logs,
    run: () => runCartLadder({
      addOnce: async () => {
        addCalls.push(clock);
        clock += opts.addMs ?? 3_000;
        const next = opts.adds[Math.min(a, opts.adds.length - 1)];
        a += 1;
        if (typeof next === 'function') return next();
        return next;
      },
      readCart: async () => {
        readCalls.push(clock);
        clock += opts.readMs ?? 1_000;
        const next = (opts.reads ?? ['unknown'])[Math.min(r, (opts.reads ?? ['unknown']).length - 1)];
        r += 1;
        if (typeof next === 'function') return next();
        return next;
      },
      wait: async (ms: number) => { waits.push(ms); clock += ms; if (opts.waitThrows) throw new Error('wait blew up'); },
      now: () => clock,
      rand: () => 0,
      log: (m: string) => logs.push(m),
      budgetMs: opts.budgetMs ?? CART_BUDGET_MS,
      maxRounds: opts.maxRounds ?? MAX_CART_ROUNDS,
    }),
  };
}

// ── 1. the literal ────────────────────────────────────────────────────────────────────────

test("'carted' is the exact literal three SQL predicates match on", () => {
  assert.equal(CARTED, 'carted');
  // The predicates themselves, read from the code that runs them. Suffixing the success string
  // would switch off the permanent anti-re-cart gate AND make the reconciler send a
  // "book it yourself" alert for a site already sitting in the user's cart.
  assert.match(cartedHistory, /resolution = 'carted' OR cart_outcome = 'carted'/);
  assert.match(poller, /cart_outcome IS NOT NULL AND cart_outcome != 'carted'/);
});

test('cartOutcomeForDb never decorates a success and always dates a multi-round failure', () => {
  assert.equal(cartOutcomeForDb({ outcome: CARTED, rounds: 1, elapsedMs: 4_000 }), 'carted');
  // THE ONE THAT MATTERS: a success that took three rounds is still the bare literal.
  assert.equal(cartOutcomeForDb({ outcome: CARTED, rounds: 3, elapsedMs: 24_100 }), 'carted');
  assert.equal(cartOutcomeForDb({ outcome: 'add-not-confirmed(empty)', rounds: 1, elapsedMs: 9_000 }),
    'add-not-confirmed(empty)');
  assert.equal(cartOutcomeForDb({ outcome: 'add-not-confirmed(empty)', rounds: 3, elapsedMs: 24_100 }),
    'add-not-confirmed(empty) [3 rounds, 24.1s]');
  // An unreadable outcome still yields a non-empty non-'carted' string, so the reconciler's
  // `!= 'carted'` still fires and the fallback alert still goes.
  assert.equal(cartOutcomeForDb({ outcome: undefined as unknown as string }), 'error');
  assert.notEqual(cartOutcomeForDb({ outcome: '' }), CARTED);
});

// ── 2. classification ─────────────────────────────────────────────────────────────────────

test('cartFamily keeps the name and the argument apart', () => {
  assert.deepEqual(cartFamily('range-not-formed(sel=3)'), { name: 'range-not-formed', arg: 'sel=3' });
  assert.deepEqual(cartFamily('add-not-confirmed(empty)'), { name: 'add-not-confirmed', arg: 'empty' });
  assert.deepEqual(cartFamily('add-not-confirmed(unknown)'), { name: 'add-not-confirmed', arg: 'unknown' });
  assert.deepEqual(cartFamily('carted'), { name: 'carted', arg: null });
  // The ` [N rounds, Xs]` suffix `cartOutcomeForDb` writes is part of the grammar this
  // function has to read — the box reads its own reports back.
  assert.deepEqual(cartFamily('session-expired [2 rounds, 14.2s]'), { name: 'session-expired', arg: null });
  assert.deepEqual(cartFamily('add-not-confirmed(empty) [3 rounds, 24.1s]'),
    { name: 'add-not-confirmed', arg: 'empty' });
  assert.equal(isRetryableCartOutcome('range-not-formed(sel=2) [2 rounds, 9.0s]'), true);
  assert.equal(isRetryableCartOutcome('already-booked [2 rounds, 9.0s]'), false);
  // `sel=1` and `sel=3` must not be two different outcomes as far as the policy is concerned —
  // an exact-string set would stop matching the day the number changed.
  assert.equal(isRetryableCartOutcome('range-not-formed(sel=1)'), true);
  assert.equal(isRetryableCartOutcome('range-not-formed(sel=7)'), true);
});

test('the three promised-terminal outcomes are terminal, individually', () => {
  // Named one by one rather than looped, because a loop over the TERMINAL map would pass even
  // if someone moved one of these into the retryable map and the map into the loop.
  assert.equal(isRetryableCartOutcome('session-expired'), false);
  assert.equal(isRetryableCartOutcome('already-booked'), false);
  assert.equal(isRetryableCartOutcome('dates-not-found'), false);
  assert.equal(isRetryableCartOutcome(CARTED), false);
});

test('an unclassified outcome is NOT retried — fail closed on the retry, open on the alert', () => {
  assert.equal(isRetryableCartOutcome('something-new-rec-gov-started-saying'), false);
  assert.equal(isRetryableCartOutcome(''), false);
  assert.equal(isRetryableCartOutcome(null as unknown as string), false);
  assert.equal(isRetryableCartOutcome(undefined as unknown as string), false);
  const p = planCartRetry({ outcome: 'something-new', rounds: 1, elapsedMs: 0 });
  assert.equal(p.retry, false);
  // And it SAYS it was unclassified. 'the ladder declined because this is terminal' and
  // 'the ladder declined because nobody taught it this string' need opposite work.
  assert.match(p.why, /unclassified/);
});

test('no outcome is both retryable and terminal', () => {
  const both = Object.keys(RETRYABLE_CART_OUTCOMES).filter((k) => k in TERMINAL_CART_OUTCOMES);
  assert.deepEqual(both, []);
});

test('EVERY outcome recgov.mjs can return is classified — a new one fails this suite', () => {
  // The scan is the guard: a future outcome string added to the browser driver and not
  // classified would otherwise be silently un-retried, which is the quiet half of the bug this
  // whole change exists for.
  const found = new Set<string>();
  for (const m of recgov.matchAll(/done\(\s*(?:'([^']+)'|`([^`]+)`|(CARTED))/g)) {
    const raw = m[3] ? CARTED : (m[1] ?? m[2]);
    found.add(cartFamily(raw).name);
  }
  // NON-VACUITY. An `indexOf`-style miss here would be a regex that matches nothing and a test
  // that passes for ever over an empty set.
  assert.ok(found.size >= 8, `the outcome scan found only ${found.size} families — the regex has drifted`);
  for (const name of found) {
    const known = name in RETRYABLE_CART_OUTCOMES || name in TERMINAL_CART_OUTCOMES;
    assert.ok(known, `recgov.mjs can return '${name}' and cart-retry.mjs does not classify it`);
  }
  // And the two that carry the whole design are actually produced by the driver.
  assert.ok(found.has('add-not-confirmed'));
  assert.ok(found.has('calendar-not-loaded'));
});

// ── 3. the plan ───────────────────────────────────────────────────────────────────────────

test('the round cap binds, on both sides of it', () => {
  const base = { outcome: 'add-not-confirmed(empty)', clicked: true, elapsedMs: 0, longestRoundMs: 1_000, rand: () => 0 };
  assert.equal(planCartRetry({ ...base, rounds: MAX_CART_ROUNDS - 1 }).retry, true);
  assert.equal(planCartRetry({ ...base, rounds: MAX_CART_ROUNDS }).retry, false);
  assert.match(planCartRetry({ ...base, rounds: MAX_CART_ROUNDS }).why, /round cap/);
});

test('the budget binds, on both sides of it, and the reserve is what makes it honest', () => {
  const rand = () => 0;
  const gap = retryGapMs(1, rand);
  const reserve = 8_000;
  const base = { outcome: 'add-not-confirmed(empty)', clicked: true, rounds: 1, longestRoundMs: reserve, budgetMs: 25_000, rand };
  // elapsed + gap + reserve exactly AT the budget is allowed; one millisecond past is not.
  const exact = 25_000 - gap - reserve;
  assert.equal(planCartRetry({ ...base, elapsedMs: exact }).retry, true);
  assert.equal(planCartRetry({ ...base, elapsedMs: exact + 1 }).retry, false);
  assert.match(planCartRetry({ ...base, elapsedMs: exact + 1 }).why, /no time left/);
});

test('the reserve is the LONGEST round so far, not a guessed constant', () => {
  const rand = () => 0;
  // 14.0s spent + a 1.5s gap leaves 9.5s: enough to reserve a 6s round, not an 11s one.
  const base = { outcome: 'add-not-confirmed(empty)', clicked: true, rounds: 1, elapsedMs: 14_000, budgetMs: 25_000, rand };
  // Same elapsed time, same budget: a job whose first round was quick may go again; a job whose
  // first round took eleven seconds may not, because the next one will probably take that too.
  assert.equal(planCartRetry({ ...base, longestRoundMs: 6_000 }).retry, true);
  assert.equal(planCartRetry({ ...base, longestRoundMs: 11_000 }).retry, false);
});

test('the reserve has a floor, so an unmeasured round cannot reserve nothing', () => {
  const rand = () => 0;
  const gap = retryGapMs(1, rand);
  // With longestRoundMs 0, a reserve of 0 would allow a retry with barely any budget left.
  const elapsed = CART_BUDGET_MS - gap - MIN_ROUND_RESERVE_MS + 1;
  assert.equal(planCartRetry({
    outcome: 'add-not-confirmed(empty)', clicked: true, rounds: 1, elapsedMs: elapsed, longestRoundMs: 0, rand,
  }).retry, false);
});

test('verifyCartFirst is true exactly when the last round clicked Add to Cart', () => {
  const base = { rounds: 1, elapsedMs: 0, longestRoundMs: 1_000, rand: () => 0 };
  assert.equal(planCartRetry({ ...base, outcome: 'add-not-confirmed(empty)', clicked: true }).verifyCartFirst, true);
  // Nothing was clicked, so the cart cannot have changed — spending 1-3s reading it would buy
  // nothing but a smaller budget.
  assert.equal(planCartRetry({ ...base, outcome: 'calendar-not-loaded', clicked: false }).verifyCartFirst, false);
  assert.equal(planCartRetry({ ...base, outcome: 'cta-not-ready', clicked: false }).verifyCartFirst, false);
});

test('the gap grows, is capped, and its jitter is bounded at both ends', () => {
  assert.equal(retryGapMs(1, () => 0), RETRY_GAP_BASE_MS);
  assert.ok(retryGapMs(2, () => 0) > retryGapMs(1, () => 0), 'the gap must widen between rounds');
  assert.equal(retryGapMs(99, () => 0), RETRY_GAP_MAX_MS);
  // Jitter exists so several enrolled users watching one campground do not step in lock-step
  // against rec.gov. Bounded so it can never be the thing that blows the budget.
  assert.equal(retryGapMs(1, () => 0.999), RETRY_GAP_BASE_MS + RETRY_GAP_JITTER_MS - 1);
  assert.equal(retryGapMs(1, () => NaN), RETRY_GAP_BASE_MS);
});

// ── 4. the ladder: the two failures it must never introduce ───────────────────────────────

test('a first-round cart reports the bare literal and adds exactly once', async () => {
  const r = rig({ adds: [{ outcome: CARTED, clicked: true }] });
  const out = await r.run();
  assert.equal(out.outcome, CARTED);
  assert.equal(out.rounds, 1);
  assert.equal(r.addCount, 1);
  assert.equal(r.readCount, 0, 'round 1 has clicked nothing yet — there is no cart to re-read');
  assert.deepEqual(r.waits, [], 'a success must not pace itself');
});

test("a confirmed-empty cart is re-added, and that is the incident this ladder exists for", async () => {
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(empty)', clicked: true }, { outcome: CARTED, clicked: true }],
    reads: ['empty'],
  });
  const out = await r.run();
  assert.equal(out.outcome, CARTED);
  assert.equal(out.rounds, 2);
  assert.equal(r.addCount, 2);
  assert.equal(r.readCount, 1, 'even a positively-empty retry re-reads the cart before adding');
  assert.equal(r.waits.length, 1, 'and it paces itself between attempts');
});

test('AN UNKNOWN CART IS NEVER RE-ADDED TO — the double-cart guard', async () => {
  // 'unknown' means fourteen polls gave no signal. The add may have worked. A blind re-add here
  // is how one campsite lands in one person's cart twice, which is the thing
  // `alreadyCartedForWatch` was written for after Silver Lake 84611 was carted five times.
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(unknown)', clicked: true }, { outcome: CARTED, clicked: true }],
    reads: ['unknown', 'unknown', 'unknown'],
    addMs: 2_000, readMs: 500,
  });
  const out = await r.run();
  assert.equal(r.addCount, 1, 'the ladder re-added against an UNKNOWN cart — this is a double reservation');
  assert.ok(r.readCount >= 1, 'and it must at least have tried to find out');
  assert.equal(out.outcome, 'add-not-confirmed(unknown)', 'it keeps reporting what the ADD said');
});

test('an unknown that resolves to ok reports carted WITHOUT a second add', async () => {
  // The first verify simply could not see an add that had worked. Re-reading is what turns
  // that into the campsite the user paid for instead of two reservations.
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(unknown)', clicked: true }, { outcome: CARTED, clicked: true }],
    reads: ['ok'],
  });
  const out = await r.run();
  assert.equal(out.outcome, CARTED);
  assert.equal(r.addCount, 1, 'it added again for a site it already had');
  assert.equal(r.readCount, 1);
});

test('an unknown that resolves to empty MAY re-add — the doubt is what blocks it, not the label', async () => {
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(unknown)', clicked: true }, { outcome: CARTED, clicked: true }],
    reads: ['empty'],
  });
  const out = await r.run();
  assert.equal(out.outcome, CARTED);
  assert.equal(r.addCount, 2);
});

test('a cart re-read that bounces to sign-in ends the ladder as session-expired', async () => {
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(empty)', clicked: true }, { outcome: CARTED, clicked: true }],
    reads: ['signin'],
  });
  const out = await r.run();
  assert.equal(out.outcome, 'session-expired');
  assert.equal(r.addCount, 1, 'retrying a dead session cannot succeed and worsens the anti-bot standing');
});

test('a round that never clicked skips the cart read and goes straight back to the page', async () => {
  const r = rig({
    adds: [{ outcome: 'calendar-not-loaded', clicked: false }, { outcome: CARTED, clicked: true }],
  });
  const out = await r.run();
  assert.equal(out.outcome, CARTED);
  assert.equal(r.addCount, 2);
  assert.equal(r.readCount, 0, 'nothing was added, so reading the cart only spends budget');
});

test('a terminal outcome stops immediately, with no wait and no second attempt', async () => {
  for (const outcome of ['already-booked', 'dates-not-found', 'session-expired']) {
    const r = rig({ adds: [{ outcome, clicked: false }, { outcome: CARTED, clicked: true }] });
    const out = await r.run();
    assert.equal(out.outcome, outcome);
    assert.equal(r.addCount, 1, `${outcome} was retried`);
    assert.deepEqual(r.waits, [], `${outcome} paced before giving up — that is pure latency on the alert`);
  }
});

test('the round cap is honoured by the ladder itself, not only by the plan', async () => {
  const r = rig({ adds: [{ outcome: 'add-not-confirmed(empty)', clicked: true }], reads: ['empty'], addMs: 500, readMs: 200 });
  const out = await r.run();
  assert.equal(out.rounds, MAX_CART_ROUNDS);
  assert.equal(r.addCount, MAX_CART_ROUNDS);
});

test('the budget ends a ladder that is still retryable — a slow page cannot outrun the alert', async () => {
  // Rounds cost 11s each against a 25s budget: round 1, then one more, then no time to reserve
  // an 11-second round. The round cap is not what stops this one.
  const r = rig({ adds: [{ outcome: 'add-not-confirmed(empty)', clicked: true }], reads: ['empty'], addMs: 11_000, readMs: 500 });
  const out = await r.run();
  assert.ok(out.rounds < MAX_CART_ROUNDS, `the budget did not bind: ${out.rounds} rounds in ${out.elapsedMs}ms`);
  assert.ok(out.elapsedMs <= CART_BUDGET_MS + 11_500,
    `the ladder ran ${out.elapsedMs}ms — past the budget by more than one in-flight round`);
  const why = out.trail[out.trail.length - 1].why as string;
  assert.match(why, /no time left/);
});

// ── 5. fail open, always ──────────────────────────────────────────────────────────────────

test('a throwing addOnce becomes an outcome, never an exception', async () => {
  // A throw out of here skips `reportResult` entirely, and the user's alert then waits out the
  // poller's full 35-second deadline instead of the ~1 second a reported failure costs.
  const boom = () => { throw new Error('page.goto: net::ERR_ABORTED'); };
  const r = rig({ adds: [boom as unknown as AddResult] });
  const out = await r.run();
  assert.equal(out.outcome, 'error');
  assert.equal(typeof out.rounds, 'number');
});

test('a throwing readCart reads as unknown, which means NOT re-adding', async () => {
  const boom = () => { throw new Error('Target page closed'); };
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(empty)', clicked: true }, { outcome: CARTED, clicked: true }],
    reads: [boom as unknown as string],
  });
  const out = await r.run();
  // A cart we could not read is a cart we do not know about. It must not fall through to a
  // re-add just because the previous round's answer had been 'empty'.
  assert.equal(r.addCount, 1);
  assert.equal(out.outcome, 'add-not-confirmed(empty)');
});

test('a throwing wait does not end the ladder in an exception', async () => {
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(empty)', clicked: true }, { outcome: CARTED, clicked: true }],
    reads: ['empty'], waitThrows: true,
  });
  const out = await r.run();
  assert.equal(out.outcome, CARTED);
});

test('every classified outcome produces a string outcome and never throws', async () => {
  // A property sweep rather than a list: the point is that no classification can put the ladder
  // in a state where it has nothing to report.
  const all = [...Object.keys(RETRYABLE_CART_OUTCOMES), ...Object.keys(TERMINAL_CART_OUTCOMES)];
  assert.ok(all.length >= 9, 'the classification maps have shrunk — this sweep is measuring less than it claims');
  for (const name of all) {
    const outcome = name === 'add-not-confirmed' ? 'add-not-confirmed(empty)' : name;
    const r = rig({ adds: [{ outcome, clicked: true }], reads: ['empty'], addMs: 500, readMs: 200 });
    const out = await r.run();
    assert.equal(typeof out.outcome, 'string');
    assert.ok(out.outcome.length > 0, `${name} produced an empty outcome`);
    assert.ok(out.rounds >= 1);
  }
});

test('the trail records one entry per round, with a duration and what the round did', async () => {
  const r = rig({
    adds: [{ outcome: 'add-not-confirmed(empty)', clicked: true, note: '← 200 POST /api/.../cart | {"ok":false}' },
           { outcome: CARTED, clicked: true }],
    reads: ['empty'],
  });
  const out = await r.run();
  assert.equal(out.trail.length, out.rounds);
  assert.ok(out.trail.every((t: Record<string, unknown>) => typeof t.ms === 'number'));
  assert.deepEqual(out.trail[0].steps, ['add:add-not-confirmed(empty)']);
  assert.deepEqual(out.trail[1].steps, ['cart:empty', 'add:carted']);
  // rec.gov's own answer survives out of the browser — the thing that existed only in a box
  // log that rolls in ~89 minutes.
  assert.match(String(out.trail[0].note), /ok":false/);
});

// ── 6. the latency budget, anchored on the poller's own number ────────────────────────────

test('the ladder finishes before the poller would alert — read from both files, not assumed', () => {
  // The two must never run at once. If the fallback alert goes at 35s and the ladder then wins
  // at 40s, the user has been told "still open, book it" and arrives to find the site taken BY
  // THEIR OWN CART HOLD. Exactly one of the two may win, and the ladder has to finish first.
  const delay = poller.match(/RECONCILE_DELAY_SEC = Number\(process\.env\.AUTOCART_RECONCILE_DELAY_SEC \?\? (\d+)\)/);
  assert.ok(delay, 'RECONCILE_DELAY_SEC moved — this budget guard is measuring nothing');
  const pollMs = bot.match(/POLL_MS = Number\(process\.env\.POLL_MS \|\| (\d+)\)/);
  assert.ok(pollMs, 'the bot POLL_MS moved — this budget guard is measuring nothing');
  const deadlineMs = Number(delay[1]) * 1_000;
  const pickupMs = Number(pollMs[1]);
  const reportMs = 1_000; // one POST to camphawk.app
  assert.ok(pickupMs + CART_BUDGET_MS + reportMs < deadlineMs,
    `the ladder can still be carting when the poller alerts: ${pickupMs}ms pickup + ${CART_BUDGET_MS}ms budget`
    + ` + ${reportMs}ms report >= ${deadlineMs}ms deadline`);
  // And there is real margin, not a one-millisecond pass.
  assert.ok(deadlineMs - (pickupMs + CART_BUDGET_MS + reportMs) >= 5_000,
    'less than 5s of margin between the ladder and the fallback alert');
});

// ── 7. wiring: a perfect ladder nothing calls is the repo's second-most-repeated bug ──────

test('recgov.mjs actually runs the ladder, at a reachable call site', () => {
  // A substring match is satisfied by `void 0 && runCartLadder(...)`. Anchored at the start of
  // a statement, with the two injected effects that make it the real thing.
  assert.match(recgov, /\n\s*const r = await runCartLadder\(\{/, 'the ladder is imported but not awaited');
  // NOT A CHARACTER WINDOW. The first version of this guard sliced 400 characters after the
  // call and broke the moment a comment was added inside the object literal — the
  // window-measured-in-characters shape this repo has paid for four times, written here by
  // the session guarding against it. Each of these appears exactly once in the file, so
  // matching them whole is both stronger and immune to layout.
  assert.equal(recgov.split('addOnce:').length - 1, 1, 'addOnce is no longer unique — this guard is ambiguous');
  assert.equal(recgov.split('readCart:').length - 1, 1, 'readCart is no longer unique — this guard is ambiguous');
  assert.match(recgov, /\n\s*addOnce: \(\) => attemptCart\(context, job, log\),/,
    'the ladder is not driving the real attempt');
  assert.match(recgov, /\n\s*readCart: \(\) => verifyCart\(context, log, \{ gotoTimeoutMs: 6_000, polls: 8 \}\),/,
    'the retry cart re-read is unbounded — one hung cart page pushes the ladder past the poller deadline');
});

test('the bounded re-read is the RETRY one only, and a timeout answers unknown', () => {
  // The read at the end of an attempt keeps the generous default: the ladder has already
  // decided nothing more will start, so a slow answer there costs nothing. The one BETWEEN
  // rounds sits inside the 25s budget and must not be able to spend it.
  assert.match(recgov, /async function verifyCart\(context, log, \{ gotoTimeoutMs = 30000, polls = 14 \} = \{\}\)/);
  assert.match(recgov, /const v = await verifyCart\(context, log\);/,
    'the in-attempt verify lost its generous default');
  // And the unbounded direction is the safe one: a failed read returns 'unknown', which the
  // ladder is forbidden from re-adding against.
  assert.match(recgov, /log\(`  cart verify error: \$\{e\.message\}`\);\n\s*return 'unknown';/);
});

test('verifyCart\'s answer reaches the outcome instead of being printed and dropped', () => {
  // The whole defect: 'empty' and 'unknown' were collapsed into one string, so the retry had no
  // way to know whether re-adding was safe.
  assert.match(recgov, /add-not-confirmed\(\$\{v\}\)/,
    "the cart verdict is not interpolated into the outcome — 'empty' and 'unknown' are merged again");
  assert.ok(!/return\s+'add-not-confirmed'/.test(recgov), 'the old collapsed outcome string is back');
});

test('clicked is set BEFORE the CTA click, because a click that throws is the doubtful case', () => {
  const set = at(recgov, 'clicked = true;', 'the clicked flag');
  const click = at(recgov.slice(set), 'await page.mouse.click(cta.x, cta.y);', 'the CTA click');
  assert.ok(click > 0, 'clicked is set after the CTA click — an exception mid-add would then read as "nothing was added"');
});

test('a fresh page load is reported as calendar-not-loaded, not as dates-not-found', () => {
  // `clickDate` returned 'not-found' on the FIRST pass when nothing had painted (min/max stay
  // ±Infinity, so neither arrow branch fires) — a calendar mid-render reported as a campground
  // that does not offer these nights. One is retryable and the other is terminal.
  assert.match(recgov, /if \(!Number\.isFinite\(min\) && !Number\.isFinite\(max\)\) return 'unpainted';/);
  assert.match(recgov, /if \(ci === 'unpainted'\) return done\('calendar-not-loaded'\);/);
  assert.equal(isRetryableCartOutcome('calendar-not-loaded'), true);
  assert.equal(isRetryableCartOutcome('dates-not-found'), false);
});

test('bot.mjs reports the outcome AND the trail, and still compares against the bare literal', () => {
  assert.match(bot, /\n\s*await reportResult\(job\.id, outcome, report\.detail\);/,
    'the trail is not being sent — the decisive fact stays in a log that rolls in ~89 minutes');
  assert.match(bot, /\n\s*if \(outcome === 'carted'\) \{/,
    'the 20-minute re-cart mute no longer recognises a success');
});

test('a decorated session-expired still clears the login — the exactness rule cuts both ways', () => {
  // THE BUG THIS PINS WAS LIVE IN THIS BRANCH AND WAS FOUND BY RE-READING THE DIFF.
  // `cartOutcomeForDb` decorates a multi-round failure, and `session-expired` reaches
  // bot.mjs decorated whenever round 1 ended `add-not-confirmed(empty)` and round 2's cart
  // re-read bounced to sign-in. An `outcome === 'session-expired'` test misses that, so the
  // ready marker is never unlinked and `reportConnected(false)` never fires: the app keeps
  // saying "connected" over a dead session, and every later opening is routed into the silent
  // auto-cart lane and NEVER ALERTS. That is the worst failure this repo has — worse than the
  // missed cart the ladder exists to fix.
  assert.equal(cartOutcomeForDb({ outcome: 'session-expired', rounds: 2, elapsedMs: 14_200 }),
    'session-expired [2 rounds, 14.2s]');
  assert.equal(cartFamily('session-expired [2 rounds, 14.2s]').name, 'session-expired');
  assert.match(bot, /\n\s*\} else if \(cartFamily\(outcome\)\.name === 'session-expired'\) \{/,
    'a decorated session-expired no longer clears the saved login');
  // And 'carted' stays EXACT, deliberately: widening it to the family would hide the day
  // something starts decorating a success, which is the one string three SQL predicates read.
  assert.match(bot, /\n\s*if \(outcome === 'carted'\) \{/);
});

test('an unreadable cart report becomes a reported error, never an exception', () => {
  // A THROW HERE COSTS THE USER 34 SECONDS. `processJob` would unwind past `reportResult`,
  // the job would carry no `cart_outcome`, and the reconciler's only remaining trigger is the
  // 35-second deadline — instead of the ~1 second `cart_outcome IS NOT NULL` costs.
  //
  // TESTED BY CALLING IT, NOT BY READING bot.mjs. The first version of this guard asserted
  // that `function normaliseCartReport` appeared in the source, and a mutation that deleted
  // the whole try/catch around `withBrowser` left that string sitting there untouched and
  // SURVIVED. That is the guard-anchored-on-the-wrong-thing shape, in the suite written to
  // catch it.
  assert.deepEqual(normaliseCartReport(undefined), { outcome: 'error', detail: null });
  assert.deepEqual(normaliseCartReport(null), { outcome: 'error', detail: null });
  assert.deepEqual(normaliseCartReport({}), { outcome: 'error', detail: null });
  assert.deepEqual(normaliseCartReport({ outcome: '' }), { outcome: 'error', detail: null });
  // A bare string is what this function used to receive, and an older box could still send one.
  assert.deepEqual(normaliseCartReport('carted'), { outcome: 'carted', detail: null });
  assert.deepEqual(normaliseCartReport({ outcome: 'carted', detail: { rounds: 2 } }),
    { outcome: 'carted', detail: { rounds: 2 } });
  // And the fallback is never 'carted' — an unreadable report must not silence the alert.
  for (const bad of [undefined, null, {}, 0, [], '', 'carted'.slice(0, 0)]) {
    assert.notEqual(normaliseCartReport(bad as never).outcome, CARTED);
  }
});

test('the browser launch is wrapped, so a busy profile is reported rather than thrown', () => {
  // `withBrowser` throws 'profile busy (broker)' when the remote sign-in holds the profile.
  // Anchored on the CALL SITE, not on a helper's name: the window between the call and the
  // success comparison must contain both halves of the catch.
  const i = at(bot, 'await withBrowser(user.userId, (ctx) => cartRecGov(ctx, job, log)', 'the cart browser launch');
  const before = bot.slice(Math.max(0, i - 400), i);
  const after = bot.slice(i, i + 500);
  assert.match(before, /\n\s*try \{/, 'the browser launch is not inside a try');
  assert.match(after, /\n\s*\} catch \(e\) \{/, 'nothing catches a browser that will not open');
  assert.match(after, /report = \{ outcome: 'error'/, 'a browser that will not open reports nothing');
});

test('the trail is stored, under an allow-listed kind, after the alert has gone', () => {
  assert.ok((BOT_EVENT_KINDS as readonly string[]).includes('recgov-cart'),
    "the kind is not allow-listed — recordBotEvent would store it with a NULL kind and the readout would never find it");
  const rec = at(resultRoute, "recordBotEvent({ kind: 'recgov-cart'", 'the event write');
  const dispatch = at(resultRoute, 'dispatchNotifications({ ...rows[0].payload', 'the carted dispatch');
  assert.ok(rec > dispatch,
    'the diagnostic is written before the text message — a diagnostic that can delay the thing it observes is not worth having');
  assert.match(resultRoute.slice(rec - 200, rec), /\n\s*if \(body\.detail && typeof body\.detail === 'object'\) \{/);
});

// ── 8. the readout says which of the three things happened ────────────────────────────────

test('a retry that won is called out as a retry that won — and a first-round cart is NOT', () => {
  const r = recgovCartReading({ outcome: 'carted', rounds: 2, elapsedMs: 14_000, trail: [{}, {}] });
  assert.equal(r.kind, 'carted-on-retry');
  assert.match(r.text, /ROUND 2/);
  // BOTH SIDES OF THE BOUNDARY. Pinning only the retry side let `rounds > 1` become
  // `rounds > 0` and SURVIVE — every ordinary first-round cart would then have been counted
  // as proof the retry was paying for itself, which is the one number this readout exists to
  // report honestly.
  const first = recgovCartReading({ outcome: 'carted', rounds: 1, elapsedMs: 9_000, trail: [{}] });
  assert.equal(first.kind, 'carted');
  assert.doesNotMatch(first.text, /ROUND/);
});

test('"the ladder declined" and "the ladder is broken" do not render the same', () => {
  // A single-round `already-booked` is the ladder working perfectly. A single-round failure
  // whose reason was never recorded is the one to chase, and it has to say so.
  const good = recgovCartReading({ outcome: 'already-booked', rounds: 1, elapsedMs: 4_000, trail: [{ why: 'terminal: already-booked' }] });
  assert.equal(good.kind, 'not-retried');
  assert.match(good.text, /terminal: already-booked/);
  const bad = recgovCartReading({ outcome: 'already-booked', rounds: 1, elapsedMs: 4_000, trail: [{}] });
  assert.match(bad.text, /NO REASON WAS RECORDED/);
});

test('a row with no trail reports itself rather than counting as a first-round anything', () => {
  const r = recgovCartReading({ outcome: 'carted' });
  assert.equal(r.kind, 'unreadable');
  assert.match(r.text, /Do not count it in either column/);
  assert.equal(recgovCartReading(null).kind, 'unreadable');
  assert.equal(recgovCartReading({ outcome: 'carted', rounds: 0 }).kind, 'unreadable');
});

test('a ladder that ran and lost is distinguished from one that never went again', () => {
  const ran = recgovCartReading({
    outcome: 'add-not-confirmed(empty)', rounds: 3, elapsedMs: 24_100,
    trail: [{}, {}, { why: 'no time left: 21.0s spent + 1500ms gap + 9.0s reserved > 25s budget', note: '← 403 POST /api/cart' }],
  });
  assert.equal(ran.kind, 'gave-up');
  assert.match(ran.text, /3 rounds/);
  assert.match(ran.text, /403/);
});
