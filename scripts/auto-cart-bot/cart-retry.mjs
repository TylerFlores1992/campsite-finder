/**
 * THE rec.gov CART LADDER — may we try again, and what may a retry do?
 *
 * ── THE INCIDENT (measured 2026-09-23, job 7c0c524f) ──────────────────────────────────
 *   04:05:39.4  poller queues Silver Lake June Lake site 84671, 26-28 Sep
 *   04:05:50.9  bot reports cart_outcome = 'add-not-confirmed'   (11.4s later)
 *   04:05:51.1  reconciler re-checks the site live — STILL OPEN
 *   04:05:52.4  fallback "book it yourself" alert sent
 * Detection worked, the re-check worked, the site was still there, and NOTHING TRIED
 * AGAIN. `add-not-confirmed` is 12 of ~78 real jobs since 2026-07-18 against 39 carted —
 * a recurring mode on the feature people pay $10/month for, not a one-off.
 *
 * ── WHY THE OLD OUTCOME COULD NOT BE RETRIED SAFELY ───────────────────────────────────
 * `verifyCart()` answers 'ok' | 'empty' | 'signin' | 'unknown', and `cartRecGov` collapsed
 * BOTH 'empty' and 'unknown' into one string. Those are opposite facts:
 *   'empty'   → rec.gov POSITIVELY said the cart is empty. The add did not take, and a
 *               re-add cannot duplicate anything.
 *   'unknown' → fourteen polls gave no definitive signal. We do not know whether the add
 *               worked. A blind re-add here is how one campsite lands in a cart twice.
 * That is this repo's most-repeated failure shape (an absent reading rendered as a
 * negative) sitting directly on the paid feature. The distinction is carried through now,
 * and the two branches of this module are the whole reason for carrying it.
 *
 * ── THE INVARIANT THAT MATTERS MOST ───────────────────────────────────────────────────
 * A RE-ADD ONLY EVER HAPPENS AFTER A POSITIVE 'empty' CART READING (or after a round that
 * never clicked Add to Cart, where there is nothing to have added). Everything else in
 * here is pacing; this one is what stops a double cart.
 *
 * And it is not only about duplicates. rec.gov holds a carted site for ~15 minutes, which
 * marks its own calendar cell unavailable — so if round 1 silently DID cart, round 2's
 * calendar would read 'booked', `cartRecGov` would report `already-booked`, and the
 * reconciler resolves that as `silent`. The user would get NO ALERT for a site sitting in
 * their own cart. Reading the cart before touching the calendar is what makes
 * `already-booked` on a retry mean what it says.
 *
 * ── AND THE ONE THAT CANNOT BE TRADED ─────────────────────────────────────────────────
 * A missed alert is strictly worse than a missed cart. Every give-up path here returns
 * `retry: false` with a reason, never a throw; `runCartLadder` catches everything its
 * injected effects can throw; and the poller's own deadline (RECONCILE_DELAY_SEC, 35s from
 * DETECTION, measured independently of the bot) fires the fallback alert whatever happens
 * in this file. The ladder cannot lose an alert; the worst it can do is be late for one.
 *
 * Pure — no Playwright, no fs, no network, no clock of its own. Every effect is injected,
 * which is why the ladder that can double-cart is exercised by `src/lib/autocart-cart-
 * retry.test.mts` instead of being an `if` buried in a 200-line browser driver.
 */

/**
 * THE LITERAL, EXPORTED SO NOTHING RE-TYPES IT.
 *
 * `reconcileAutocartJobs` matches `cart_outcome != 'carted'`, `alreadyCartedForWatch`
 * matches `(resolution = 'carted' OR cart_outcome = 'carted')`, and `watch-openings.ts`
 * matches the same pair. Suffixing a FAILURE string is free; suffixing this one silently
 * switches off the permanent anti-re-cart gate AND makes the reconciler alert on a site
 * that is already in the user's cart.
 */
export const CARTED = 'carted';

/**
 * THE WALL-CLOCK BUDGET FOR THE WHOLE LADDER, AND WHY IT IS 25 SECONDS.
 *
 * It is not politeness — it is the number that keeps the retry and the fallback alert from
 * running at the same time, which is the one combination that produces an incoherent
 * product. The poller re-checks and alerts at RECONCILE_DELAY_SEC = 35s after DETECTION,
 * on its own timer, whether or not the bot has said anything. If the ladder is still
 * carting at 35s and then wins, the user has already been told "still open, book it" and
 * arrives at rec.gov to find the site taken — BY THEIR OWN CART HOLD. It reads as a false
 * alert. So exactly one of the two must win, and the ladder has to finish first:
 *
 *   job row written        ~0s   (same poller cycle as detection)
 *   bot picks it up        ≤2s   (POLL_MS)
 *   ladder                 ≤25s  (this budget)
 *   report POST            ~1s
 *                         ─────
 *                          ~28s  against a 35s deadline — 7s of margin, and the
 *                                reconciler's own 6s tick usually adds more.
 *
 * The measured first attempt (detection→report) was 11.4s including pickup, so 25s buys a
 * second full round and usually a third. Spending more would buy another round at the cost
 * of the margin, and the margin is what keeps the two paths from colliding.
 *
 * THE COST IS REAL AND IS THE POINT OF THE BUDGET: on a job that retries, the fallback
 * alert lands ~28s after detection instead of ~13s. Fifteen seconds of the user's own head
 * start, spent on a materially better chance the site is simply in their cart. It is spent
 * only on jobs the first attempt already failed.
 */
export const CART_BUDGET_MS = 25_000;

/**
 * Rounds, not retries: round 1 is today's single attempt, so this is "the original plus
 * two". Three and not more because every re-add is a real write against rec.gov's anti-bot
 * gate from the USER'S OWN residential IP — the thing that cost the RC side a 12-hour
 * block on 2026-08-06 — and because two confirmed-empty adds failing makes a third
 * unlikely to differ. In practice the budget binds first on slow rounds; this binds on
 * fast ones, and both have to.
 */
export const MAX_CART_ROUNDS = 3;

/**
 * What a round is assumed to cost when nothing has been measured yet. Only used as a FLOOR
 * under the adaptive reserve below — the real reserve is the longest round this job has
 * actually taken, because a page that loaded slowly once will load slowly again.
 */
export const MIN_ROUND_RESERVE_MS = 6_000;

/** Spacing. Back-to-back hammering is how you lose the account, not how you win a site. */
export const RETRY_GAP_BASE_MS = 1_500;
export const RETRY_GAP_MAX_MS = 4_000;
/**
 * Jitter, and it is not decoration: several enrolled users watching one popular campground
 * see the SAME cancellation in the same poller cycle, so without it their boxes would step
 * in lock-step against rec.gov. Injected as `rand` so the plan stays a pure function.
 */
export const RETRY_GAP_JITTER_MS = 1_000;

/**
 * Outcomes a fresh round can plausibly change, each with the reason it is in this set.
 * Keyed by FAMILY (the part before any parenthetical), because `range-not-formed(sel=3)`
 * carries a number and an exact-string set would silently stop matching the day it says
 * `sel=1`. That is the guard-anchored-on-the-wrong-thing shape; the family is the property.
 */
export const RETRYABLE_CART_OUTCOMES = Object.freeze({
  'add-not-confirmed':
    "rec.gov's answer about the cart. 'empty' means the add did not take and a re-add is " +
    "safe; 'unknown' means we could not tell, and the retry re-READS the cart instead of " +
    're-adding. The distinction is the whole reason this module exists.',
  'calendar-not-loaded':
    'the availability grid never painted. A page that did not load is the textbook ' +
    'transient, and a fresh navigation is a genuinely different draw.',
  'cta-not-ready':
    'the range formed but Add to Cart was missing, disabled or zero-sized — a render race ' +
    'on a page that had otherwise worked. Nothing was clicked, so a retry cannot duplicate.',
  'range-not-formed':
    "react-aria's range calendar refused to hold a selection. It is already retried four " +
    'times WITHIN one page load, so the only thing left to vary is the page itself.',
  error:
    'a navigation failure or an exception. Bounded rather than trusted: a dead browser ' +
    'context throws again immediately and the round cap ends it within a second or two.',
});

/**
 * Outcomes no number of retries can change, each with the reason it must NOT be retried.
 * `dates-not-found` is here because it now means what it says: the calendar painted cells
 * and these dates were not among them. The case where NOTHING painted used to land here
 * too and is reported as `calendar-not-loaded`, which is retryable — see recgov.mjs.
 */
export const TERMINAL_CART_OUTCOMES = Object.freeze({
  carted: 'the site is in the cart. There is nothing left to want.',
  'session-expired':
    "rec.gov bounced the cart page to sign-in. Retrying cannot succeed — there is no " +
    'session to succeed with — and repeated signed-out traffic is exactly what worsens ' +
    "this address's anti-bot standing. It clears the login marker and asks for a reconnect.",
  'already-booked':
    'the calendar shows the arrival night taken. The site is gone; the reconciler resolves ' +
    'the job silent, which is the correct no-false-hope ending.',
  'dates-not-found':
    'the calendar painted and these dates are not in it. A fact about the campground, not ' +
    'a transient — a retry would re-read the same grid and get the same answer.',
  'skipped-not-logged-in':
    'decided before the browser opens; the ladder never runs. Listed so the classification ' +
    'below covers every outcome the bot can report.',
  'skipped-already-carted': 'the same, for a site this person had carted minutes ago.',
});

/**
 * Split `name(arg)` into its parts. `range-not-formed(sel=3)` → `{name:'range-not-formed',
 * arg:'sel=3'}`; `carted` → `{name:'carted', arg:null}`. An unparseable value yields a name
 * that matches nothing, which is the safe direction — see `isRetryableCartOutcome`.
 */
export function cartFamily(outcome) {
  const s = typeof outcome === 'string' ? outcome.trim() : '';
  // THE ` [N rounds, Xs]` SUFFIX IS PART OF THE GRAMMAR, because `cartOutcomeForDb` writes it
  // and the box reads its own reports back. Leaving it out of this regex made
  // `cartFamily('session-expired [2 rounds, 14.2s]').name` the WHOLE string — so bot.mjs's
  // family test for a dead session silently stopped matching the day the ladder shipped, and
  // the ready marker would never have been cleared. Found by a test, on a fix written
  // confidently ten minutes earlier.
  const m = s.match(/^([a-z][a-z-]*)(?:\(([^)]*)\))?(?:\s*\[[^\]]*\])?$/);
  return m ? { name: m[1], arg: m[2] ?? null } : { name: s, arg: null };
}

/**
 * AN OUTCOME NOBODY CLASSIFIED IS NOT RETRIED.
 *
 * The default has to fall this way round. Declining to retry ends the ladder and lets the
 * poller's fallback alert through, which is the failure we can afford; retrying something
 * we do not understand spends rounds against rec.gov and can delay that alert. So an
 * unrecognised string fails CLOSED on the retry and OPEN on the alert.
 */
export function isRetryableCartOutcome(outcome) {
  const { name } = cartFamily(outcome);
  return Object.prototype.hasOwnProperty.call(RETRYABLE_CART_OUTCOMES, name);
}

/** How long to wait before round n+1. Pure: the jitter source is injected. */
export function retryGapMs(round, rand = Math.random) {
  const n = Math.max(1, Number(round) || 1);
  const base = Math.min(RETRY_GAP_BASE_MS * n, RETRY_GAP_MAX_MS);
  const r = Number(rand());
  const jitter = Number.isFinite(r) ? Math.floor(Math.min(Math.max(r, 0), 1) * RETRY_GAP_JITTER_MS) : 0;
  return base + jitter;
}

/**
 * May we go round again, and what is the next round allowed to do?
 *
 * Returns `{retry:false, why}` or `{retry:true, waitMs, verifyCartFirst, why}`.
 *
 * `verifyCartFirst` is true exactly when the last round CLICKED Add to Cart, because that
 * is exactly when the cart's contents are in doubt. A round that never clicked (the page
 * never loaded, the range never formed, the button was not there) cannot have added
 * anything, so re-reading the cart would spend one to three seconds of the budget to learn
 * something already known.
 *
 * @param {object} p
 * @param {string} p.outcome              what the last round ended as
 * @param {boolean} [p.clicked]           did the last round press Add to Cart
 * @param {number} [p.rounds]             rounds completed so far, 1-based
 * @param {number} [p.elapsedMs]          since the ladder started
 * @param {number} [p.longestRoundMs]     the longest round THIS job has taken
 * @param {number} [p.budgetMs]
 * @param {number} [p.maxRounds]
 * @param {() => number} [p.rand]
 * @returns {{retry: boolean, why: string, waitMs?: number, verifyCartFirst?: boolean}}
 */
export function planCartRetry({
  outcome,
  clicked = false,
  rounds = 1,
  elapsedMs = 0,
  longestRoundMs = 0,
  budgetMs = CART_BUDGET_MS,
  maxRounds = MAX_CART_ROUNDS,
  rand = Math.random,
}) {
  if (outcome === CARTED) return { retry: false, why: 'carted' };
  if (!isRetryableCartOutcome(outcome)) {
    const { name } = cartFamily(outcome);
    const known = TERMINAL_CART_OUTCOMES[name];
    return { retry: false, why: known ? `terminal: ${name}` : `unclassified outcome '${name}' — not retrying` };
  }
  if (rounds >= maxRounds) return { retry: false, why: `round cap (${maxRounds})` };

  const waitMs = retryGapMs(rounds, rand);
  // ADAPTIVE, NOT A PREDICTION. Reserving a guessed constant is how a ladder overruns its
  // budget on the one job where the page is slow — which is the job most likely to need a
  // retry. The longest round this job has actually taken is the honest estimate of the
  // next one; the floor covers round 1 being unusually quick.
  const reserveMs = Math.max(Number(longestRoundMs) || 0, MIN_ROUND_RESERVE_MS);
  const needMs = elapsedMs + waitMs + reserveMs;
  if (needMs > budgetMs) {
    return {
      retry: false,
      why: `no time left: ${Math.round(elapsedMs / 100) / 10}s spent + ${waitMs}ms gap + ` +
        `${Math.round(reserveMs / 100) / 10}s reserved > ${Math.round(budgetMs / 1000)}s budget`,
    };
  }
  return {
    retry: true,
    waitMs,
    verifyCartFirst: clicked === true,
    why: `round ${rounds + 1} of ${maxRounds} after ${waitMs}ms` +
      (clicked ? ' (re-reading the cart first)' : ''),
  };
}

/** Never let an injected effect throw into the ladder. See the fail-open rule in the header. */
async function guarded(fn, onError) {
  try {
    return await fn();
  } catch (err) {
    return onError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Run the bounded ladder for ONE job.
 *
 * Effects are injected so the part that can double-cart is testable without a browser:
 *   addOnce()  → `{outcome, clicked, note?}`  one full attempt: load, form the range, click
 *                Add to Cart, verify. `clicked` says whether Add to Cart was pressed.
 *   readCart() → 'ok' | 'empty' | 'signin' | 'unknown'   the cart page, nothing else.
 *   wait(ms), now(), rand(), log(msg)
 *
 * Returns `{outcome, rounds, elapsedMs, trail}`. `outcome` is the string reported to
 * CampHawk and is EXACTLY `'carted'` on success — see the constant's header. `trail` is
 * the per-round record that goes to `bot_events`, because the box log rolls in ~89 minutes
 * and today's question was unanswerable ten hours later.
 *
 * THIS FUNCTION DOES NOT THROW. Every ending is an outcome string.
 *
 * @param {object} io
 * @param {() => Promise<{outcome: string, clicked?: boolean, note?: string|null}>} io.addOnce
 * @param {() => Promise<string>} io.readCart
 * @param {(ms: number) => Promise<void>} io.wait
 * @param {() => number} [io.now]
 * @param {() => number} [io.rand]
 * @param {(msg: string) => void} [io.log]
 * @param {number} [io.budgetMs]
 * @param {number} [io.maxRounds]
 * @returns {Promise<{outcome: string, rounds: number, elapsedMs: number, trail: Record<string, any>[]}>}
 */
export async function runCartLadder({
  addOnce,
  readCart,
  wait,
  now = Date.now,
  rand = Math.random,
  log = () => {},
  budgetMs = CART_BUDGET_MS,
  maxRounds = MAX_CART_ROUNDS,
}) {
  const startedAt = now();
  const trail = [];
  let rounds = 0;
  let longestRoundMs = 0;
  let outcome = 'error';
  let clicked = false;

  for (;;) {
    rounds += 1;
    const roundStart = now();
    const steps = [];
    // A ROUND MAY ONLY ADD ONCE IT KNOWS THE CART IS EMPTY. Round 1 has clicked nothing,
    // so there is nothing to have added and the read is skipped; every later round that
    // follows a click must earn this flag from rec.gov's own answer.
    let mayAdd = true;

    if (rounds > 1 && trail[trail.length - 1]?.verifyCartFirst) {
      const v = await guarded(() => readCart(), (msg) => {
        log(`  · cart re-read failed: ${msg}`);
        return 'unknown';
      });
      steps.push(`cart:${v}`);
      if (v === 'ok') {
        // The add HAD taken and the first verify simply could not see it. This is the
        // case a blind re-add would have turned into two reservations.
        outcome = CARTED;
        trail.push({ round: rounds, steps, ms: now() - roundStart, outcome });
        log(`  ✓ cart re-read found it — the first add had taken after all`);
        break;
      }
      if (v === 'signin') {
        outcome = 'session-expired';
        trail.push({ round: rounds, steps, ms: now() - roundStart, outcome });
        break;
      }
      // 'unknown' — we still do not know. Spend the round learning nothing rather than
      // risking a second reservation, and keep reporting what the ADD said.
      mayAdd = v === 'empty';
    }

    if (mayAdd) {
      const r = await guarded(() => addOnce(), (msg) => {
        log(`  ✗ cart attempt threw: ${msg}`);
        return { outcome: 'error', clicked: false, note: msg.slice(0, 160) };
      });
      outcome = typeof r?.outcome === 'string' && r.outcome ? r.outcome : 'error';
      clicked = r?.clicked === true;
      steps.push(`add:${outcome}`);
      trail.push({ round: rounds, steps, ms: now() - roundStart, outcome, clicked, note: r?.note ?? null });
    } else {
      // Round spent on an unreadable cart. `clicked` stays true, so the next round reads
      // again rather than adding — the doubt does not decay into permission.
      trail.push({ round: rounds, steps, ms: now() - roundStart, outcome, clicked, note: 'cart unreadable — not re-adding' });
    }

    const last = trail[trail.length - 1];
    longestRoundMs = Math.max(longestRoundMs, last.ms);
    if (outcome === CARTED) break;

    const plan = planCartRetry({
      outcome, clicked, rounds,
      elapsedMs: now() - startedAt,
      longestRoundMs, budgetMs, maxRounds, rand,
    });
    last.why = plan.why;
    last.verifyCartFirst = plan.retry ? plan.verifyCartFirst : false;
    if (!plan.retry) break;
    log(`  ↻ rec.gov cart: ${outcome} — ${plan.why}`);
    await guarded(() => wait(plan.waitMs), () => undefined);
  }

  return { outcome, rounds, elapsedMs: now() - startedAt, trail };
}

/**
 * What goes into `autocart_jobs.cart_outcome`.
 *
 * `'carted'` passes through UNTOUCHED — three SQL predicates in two lanes depend on it. A
 * failure gets the round count and the elapsed time appended, so the one column that
 * survives in the database says whether the ladder ran at all. The full per-round trail
 * goes to `bot_events`; this is the part that survives that POST failing.
 */
export function cartOutcomeForDb({ outcome, rounds = 1, elapsedMs = 0 }) {
  if (outcome === CARTED) return CARTED;
  const name = typeof outcome === 'string' && outcome ? outcome : 'error';
  if (!(rounds > 1)) return name;
  return `${name} [${rounds} rounds, ${Math.round(elapsedMs / 100) / 10}s]`;
}

/**
 * WHATEVER `cartRecGov` HANDED BACK, AS `{outcome, detail}`.
 *
 * It returns an object now — the outcome plus the ladder's trail — and used to return a bare
 * string. An `undefined` (a throw something swallowed, a caller that forgets) must never
 * become `undefined.outcome` at the call site: that throws out of `processJob`, so
 * `reportResult` is never called and the user's alert waits out the poller's full 35-second
 * deadline instead of the ~1 second a reported failure costs. Every unreadable shape becomes
 * a reported 'error', which the reconciler picks up within a cycle.
 *
 * IT LIVES HERE AND NOT IN bot.mjs BECAUSE bot.mjs CANNOT BE IMPORTED — the module starts the
 * bot. A source-scanned guard on it survived its own mutation; a behavioural one does not.
 */
export function normaliseCartReport(r) {
  if (typeof r === 'string' && r) return { outcome: r, detail: null };
  if (r && typeof r === 'object' && typeof r.outcome === 'string' && r.outcome) {
    return { outcome: r.outcome, detail: r.detail ?? null };
  }
  return { outcome: 'error', detail: null };
}
