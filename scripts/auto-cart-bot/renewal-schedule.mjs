/**
 * WHEN may the keep-warm try to re-mint the RC access token?
 *
 * Pure, with no clock and no fs of its own, because this is the part that can lose a cart
 * and it cannot be tested where it lives — the caller is a `for(;;)` loop that starts on
 * import. Same division as `session-coverage.mjs`, `relogin-retry.mjs` and `rehearsal.mjs`.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * The token lives about an hour and nothing renewed it, so between releases the session
 * simply ran out and stayed out. Measured off the box on 2026-08-15, in one evening:
 *
 *     18:46:50  RC loaded and STAYING OPEN — token source: none
 *     18:47:02  ⚠ RC SESSION IS DEAD ... okta session STILL ALIVE
 *     19:07:03  ⚠ RC SESSION IS DEAD ... okta session STILL ALIVE
 *     19:18:57  ✓ already signed in — RC re-authenticated before any form appeared
 *
 * and again 21:29 → 22:26. **Ninety dead minutes in one evening, with a live Okta session
 * the whole time and nothing trying.** Both repairs came from `maybeAutoLogin`, which only
 * fires within `RC_AUTOLOGIN_LEAD_MIN` of a real release — so the session was healthy at the
 * only moments somebody happened to queue a hold.
 *
 * The mechanism was never missing. The SCHEDULE was.
 *
 * ── WHY IT IS RATIONED, AND WHY THE RATION IS NOT THE LOGIN'S ──────────────────────────
 * A re-mint is not a login: no credential is submitted, no form is filled, and the CAPTCHA
 * that stops `attemptLogin` dead lives on the password form, which this never reaches. So
 * it does NOT spend the one-attempt-per-release budget that exists because repeated logins
 * from this address cost twelve hours of IP block on 2026-08-06.
 *
 * It is still a navigation and an OIDC round trip from that same address, so it is paced —
 * but paced on its own terms rather than borrowed from the login's. Three numbers:
 *
 *   • a FLOOR, honoured no matter what changed, so a flapping token reading cannot turn
 *     this into a busy loop wearing a service's clothes;
 *   • a MIN GAP for repeating an attempt against a state that has not changed;
 *   • a BACKOFF once attempts keep failing — which is what a dead Okta session looks like.
 *
 * **It never stops entirely.** A gate that switches itself off permanently is the
 * `.camphawk-ready` bug (2026-08-11): one failure, twelve days ago, and the automatic
 * repair never ran again.
 *
 * ── AND THE BACKOFF ESCALATES, BECAUSE THE NUMBER OF TRIPS IS THE LEVER (2026-09-20) ───
 * Every Okta navigation is a chance at a ~32 GiB commit burst — the established trigger,
 * from 2026-08-18's controlled comparison: three token-less renewals ten minutes apart,
 * and only the one that clicked through Okta cost anything. So the one thing on our side
 * of that allocation is HOW OFTEN WE GO. Measured off `bot_events` over the 168h to
 * 2026-09-20, and the regime had moved since the 09-11 reading that proposed this:
 *
 *     renewal trips     255 over 168.0h = 36.4/day      (09-11: 33.4/day)
 *     gap bands         backoff(30m) 200 · minGap(10m) 35 · alive(~60m) 4 · other 15
 *     failure-band gaps 236 of 254 = 93%                (09-11: 84%)
 *     median gap        31.5m — i.e. FLAT BACKOFF, essentially all the time
 *
 * The flat backoff was the whole schedule. It is 30 minutes after three failures and it
 * stayed 30 minutes for ever, so a failure this module's own comment calls persistent —
 * *"when that cookie is gone every attempt will fail identically until a human signs in"* —
 * was rediscovered ~29 times a day, indefinitely. Doubling it instead (30 → 60 → 120 → 240)
 * takes the backoff band to ~8/day and the total to ~16/day.
 *
 * **THE CEILING IS NOT A STOP, AND THAT IS THE RULE THE HEADER ABOVE ALREADY STATES.** It
 * doubles to `RENEW_BACKOFF_MAX_MS` and holds there for ever — six discoveries a day at the
 * very worst, never zero. A ladder without a cap is the `.camphawk-ready` bug arriving by
 * arithmetic instead of by a boolean.
 *
 * **AND A LIVE TOKEN RESETS THE COUNTER — see `noteLiveToken`, which is the whole cost of
 * this change.** Escalation is only safe if the counter cannot carry across episodes.
 */

/** Never two attempts closer than this, whatever else changed. */
export const RENEW_FLOOR_MS = 5 * 60_000;
/** Repeating an attempt against an UNCHANGED state waits this long. */
export const RENEW_MIN_GAP_MS = 10 * 60_000;
/** ...and this long once it is plainly not working — the FIRST rung, which then doubles. */
export const RENEW_BACKOFF_GAP_MS = 30 * 60_000;
/**
 * The ceiling the doubling stops at. **A CEILING, NOT A STOP** — at four hours the schedule
 * still discovers a dead Okta session six times a day, which is a service, where zero is the
 * `.camphawk-ready` bug. Chosen against what the cap actually costs: the worst case is an
 * Okta session that heals ITSELF and is noticed up to four hours late instead of thirty
 * minutes late. That is a cost to the BACKGROUND repair only — `maybeAutoLogin` still signs
 * in at T−30 of a real release and is what stands between a queued hold and a missed cart,
 * and this module does not touch it.
 */
export const RENEW_BACKOFF_MAX_MS = 240 * 60_000;
/** How many consecutive failures before the backoff applies. */
export const RENEW_BACKOFF_AFTER = 3;

/** Fresh state for a caller to hold across loop iterations. */
export function newRenewalState() {
  // `lastToken: undefined` is "never attempted", and it is deliberately not `null` —
  // `null` is a real state meaning "the app holds no token", which is the case this
  // schedule most needs to act on. A sentinel that collides with a real value would make
  // the very first signed-out tick look like a repeat.
  return { lastAt: 0, lastToken: undefined, failures: 0 };
}

const mins = (ms) => Math.round(ms / 60_000);

/**
 * How long to wait after `failures` consecutive failures — the ladder, as a pure function so
 * the rung can be asserted directly rather than inferred from a stand-down.
 *
 * `backoffGapMs` is the first rung and it doubles once per failure past `backoffAfter`:
 * 3 → 30m, 4 → 60m, 5 → 120m, 6 → 240m, and 240m for ever after.
 *
 * THE ITERATION COUNT IS BOUNDED BY A CONSTANT — not by `failures`, and NOT BY THE GAP IT IS
 * GROWING. Two things go wrong otherwise, in opposite directions, and the second one is the
 * one that bites:
 *
 *   • `backoffGapMs * 2 ** (failures - backoffAfter)` reaches `Infinity` — `failures` has no
 *     upper bound and a dead Okta cookie over a long weekend gets into the hundreds. `Math.min`
 *     does clamp `Infinity` correctly today, so this is a robustness preference rather than a
 *     live bug; a schedule whose arithmetic passes through `Infinity` to arrive at the right
 *     answer is one refactor from returning `NaN`, and a `NaN` gap compares false against
 *     everything, which is no backoff at all.
 *   • **`for (…; n < failures && gap < backoffMaxMs; …)` DOES NOT TERMINATE IF THE FIRST RUNG
 *     IS EVER 0**, because doubling zero never reaches the cap — it spins towards
 *     `MAX_SAFE_INTEGER` inside the keep-warm's own `for(;;)`, which is a hung bot and a dead
 *     session, i.e. strictly worse than every ramp this change is buying. That was the first
 *     draft of this function, and the MUTATION RUN is what found it: measured at 5,000,001
 *     iterations and still going. **A loop must never be bounded by the value it is mutating.**
 *
 * `MAX_DOUBLINGS` makes termination structural: at most that many iterations whatever the
 * inputs, and 2^52 of any positive first rung is past every ceiling anyone would set.
 */
const MAX_DOUBLINGS = 52;

export function renewBackoffGapMs(failures, {
  backoffGapMs = RENEW_BACKOFF_GAP_MS,
  backoffAfter = RENEW_BACKOFF_AFTER,
  backoffMaxMs = RENEW_BACKOFF_MAX_MS,
} = {}) {
  // `Math.max(0, …)` also absorbs a NaN `failures` into zero steps, which returns the first
  // rung — the safe end of the ladder to fail towards.
  const steps = Math.max(0, Math.min(failures - backoffAfter, MAX_DOUBLINGS));
  let gap = backoffGapMs;
  for (let n = 0; n < steps; n++) gap *= 2;
  return Math.min(gap, backoffMaxMs);
}

/**
 * A LIVE TOKEN CLEARS THE FAILURE COUNT, AND THIS IS THE WHOLE COST OF THE ESCALATION.
 *
 * `recordRenewal` is the only other thing that can zero `failures`, and it is called only
 * when THIS schedule made an attempt. **`maybeAutoLogin` repairs the session without going
 * anywhere near it** — it signs in at T−30 of a release, the app ends up holding a fresh
 * token, and `failures` is left exactly as high as the failing episode left it. The same is
 * true of RC re-minting silently on its own, which is an observation of its behaviour rather
 * than a guarantee, and of a human signing in at the box.
 *
 * With a FLAT backoff that stale counter was harmless: the next episode's first attempt came
 * 30 minutes in either way. With an escalating one it is not, and the failure is silent and
 * backwards — a session that has just been repaired is the one whose NEXT lapse waits four
 * hours, because the counter it is being judged on belongs to the previous episode. That is
 * strictly worse than the ramps this change is buying, and it is why the escalation could not
 * ship without this function.
 *
 * SO: seeing the app hold a token that is ALIVE AT ALL ends the episode. It is the same
 * boundary `planRenewal` stands down on one line below, deliberately — "there is a working
 * session right now" is exactly the evidence that whatever was failing has stopped failing,
 * whoever fixed it.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *   • `lastAt` — the FLOOR is about request pacing from an address that has been IP-blocked,
 *     and it is owed no matter what the token is doing.
 *   • `lastToken` — that is the "have we already tried this?" key, and a live token is not an
 *     attempt. Clearing it would make the next lapse look like a changed state twice over.
 *
 * AND `leftS <= 0` IS NOT A LIVE TOKEN. A three-day-old corpse decodes fine and keeps coming
 * back (2026-08-19); treating it as evidence of a working session would reset the counter on
 * exactly the pathology the backoff exists for, and the escalation would never engage.
 */
export function noteLiveToken(state, { leftS }) {
  if (leftS == null || leftS <= 0) return state;
  if (!state.failures) return state;
  return { ...state, failures: 0 };
}

/**
 * Should we try to re-mint now?
 *
 * `token` is the raw token string or `null` when the app holds none. `leftS` is its life in
 * seconds, or `null` when there is no token OR it will not decode — both of which mean we
 * have nothing usable, which is a reason to act rather than a reason to wait.
 *
 * Returns `{ go, reason, key }`. The reason is logged, so it is written to be read at 07:45
 * by somebody deciding whether to intervene.
 *
 * `key` IS WHAT MAKES THE REASON AFFORDABLE. The caller collapses consecutive identical
 * stand-downs because the loop asks every sixty seconds, and every reason here carries a
 * minute count that changes on every ask — so deduping on the SENTENCE would collapse
 * nothing at all and print 1,440 lines a day, which hides the answer exactly as well as
 * printing none. That is `autoLoginSkip`'s lesson arriving one layer down: its reasons are
 * constant strings and could be compared directly; these cannot. The key is the state, the
 * reason is the state's current numbers, and the first sighting of each state prints both.
 */
export function planRenewal({
  token,
  leftS,
  now,
  state,
  floorMs = RENEW_FLOOR_MS,
  minGapMs = RENEW_MIN_GAP_MS,
  backoffGapMs = RENEW_BACKOFF_GAP_MS,
  backoffMaxMs = RENEW_BACKOFF_MAX_MS,
  backoffAfter = RENEW_BACKOFF_AFTER,
}) {
  /**
   * ── WAIT FOR THE TOKEN TO LAPSE. DO NOT RENEW AT NEAR-EXPIRY. (2026-08-18) ──────────────
   *
   * This used to act as soon as the token fell under `renewBeforeS` (10 min). That cell is
   * where the Chromium leak lives, and it is a cell that has NEVER ONCE WORKED:
   *
   *   • Five ramps on 2026-08-18, five near-expiry renewals — `the token has 10m left
   *     (src=live)` — 23:44, 02:58, 04:03, 05:07, 06:12. Not one completed; the RAM guard
   *     killed the browser every time.
   *   • The failures predate the guard too: `554s → none` and `-115s → none` on 08-16, with
   *     `okta=ALIVE` printed on the adjacent line both times.
   *   • The RAM trail dated the onset to `renew:prime-after-reload` — the reload that follows
   *     `dropStoredToken`. Clearing a LIVE token and reloading is the act that leaks.
   *
   * And the other cell works and does not ramp: from a token-less profile the same code
   * returns `✓ renewed by authorize: none → 3580s`, repeatedly, with `cleared 0 storage
   * key(s)` and no memory event after any of them.
   *
   * So the token is left alone while it is alive AT ALL, and the renewal happens from empty.
   *
   * WHAT THIS COSTS, STATED HONESTLY: the session is dead between expiry and the next
   * attempt — at most `floorMs` (5 min), usually less. **That is not a new cost.** The
   * near-expiry attempt did not renew anything; it failed and took the browser with it, so
   * the session was dead through that window anyway and the box lost several GB doing it.
   *
   * WHAT IT DOES NOT TOUCH: `maybeAutoLogin`, which signs in at T−30 of a real release and
   * is the thing standing between a queued hold and a missed cart. This schedule is the
   * background repair; that one is the release-critical path, and they stay separate.
   *
   * `leftS == null` (no token, or one that will not decode) still falls through to act —
   * "we cannot see a usable token" remains the strongest reason to act there is, and
   * refusing it is the ninety dead minutes in this file's header.
   */
  if (leftS != null && leftS > 0) {
    return {
      go: false,
      key: 'alive',
      reason: `the token has ${mins(leftS * 1000)}m left — waiting for it to lapse, because `
        + 'renewing a live token is what leaks and it has never once worked',
    };
  }

  const since = now - state.lastAt;
  if (state.lastAt > 0 && since < floorMs) {
    return {
      go: false, key: 'floor',
      reason: `only ${mins(since)}m since the last attempt (floor is ${mins(floorMs)}m)`,
    };
  }

  // THE BACKOFF IS ABOUT THE OKTA SESSION, WHICH IS WHAT KEEPS FAILING WHEN THIS FAILS.
  // A re-mint asks Okta to vouch for us from its own cookie; when that cookie is gone every
  // attempt will fail identically until a human signs in, and there is no point discovering
  // that six times an hour — nor, once it has been true for three hours, twice an hour. The
  // gap DOUBLES per failure to `backoffMaxMs` and then holds there; see `renewBackoffGapMs`,
  // and see `noteLiveToken` for why the counter it reads cannot outlive its own episode.
  const backing = state.failures >= backoffAfter;
  const gap = backing
    ? renewBackoffGapMs(state.failures, { backoffGapMs, backoffAfter, backoffMaxMs })
    : minGapMs;
  if (token === state.lastToken && since < gap) {
    // THE SENTENCE NAMES THE RUNG AND WHETHER IT IS STILL CLIMBING, because the caller
    // collapses on the KEY and this state prints once. "30m apart, doubling to 240m" and
    // "240m apart — as slow as it goes, and it never stops" are different news at 07:45:
    // the first says the schedule is still learning, the second says it has learnt and is
    // waiting for a human. A bare minute count cannot tell them apart.
    const why = backing
      ? `${state.failures} attempts in a row have failed, so the next is ${mins(gap)}m apart`
        + (gap < backoffMaxMs
          ? `, doubling to ${mins(backoffMaxMs)}m if it keeps failing`
          : ' — as slow as it goes, and it never stops entirely')
      : `nothing has changed since the attempt ${mins(since)}m ago`;
    return { go: false, key: backing ? 'backoff' : 'unchanged', reason: why };
  }

  return {
    go: true,
    key: 'go',
    reason: leftS == null
      ? 'the app holds no usable token'
      : `the token has ${mins(leftS * 1000)}m left`,
  };
}

/**
 * Collapse consecutive stand-downs that are the SAME STATE, and print the first of each.
 *
 * IT LIVES HERE BECAUSE THE SOURCE SCAN COULD NOT SEE THROUGH IT. This was six lines in
 * `rc-keepwarm.mjs` guarded by a regex on its own shape, and a mutation that reinstated the
 * bug from INSIDE the body — one `key = reason` at the top, restoring the volatile
 * comparison — sailed past the guard while the shape still matched. That is the "fix present
 * but inert" family read backwards: a bug present but invisible. Behaviour that can go wrong
 * belongs where behaviour can be tested, which is the same reason `session-coverage.mjs`
 * exists at all.
 *
 * Returns whether it printed, so a caller can tell "said nothing because nothing changed"
 * from "said nothing because it was never asked".
 */
export function makeSkipLogger(emit) {
  let last = null;
  /**
   * `reset()` EXISTS BECAUSE AN ATTEMPT IS A STATE CHANGE THE KEY CANNOT SEE.
   *
   * The key is built from the gate's own inputs, so it says nothing about whether we went on
   * to DO something. A caller that signs in has changed the world outside those inputs, and
   * the next stand-down after it is news even when it names the same state as the last one
   * printed before it. `rc-keepwarm.mjs` clears both of its loggers immediately before it
   * spends a sign-in, for exactly that reason, and that behaviour predates the key.
   */
  const skip = (key, reason) => {
    if (key === last) return false;
    last = key;
    emit(reason);
    return true;
  };
  skip.reset = () => { last = null; };
  return skip;
}

/**
 * Record the outcome. Returns the next state; the caller keeps it.
 *
 * `lastToken` is the token we attempted AGAINST, not the one we got. "Have we already tried
 * this?" is a question about the starting state, and storing the result would make a
 * successful renewal look like an untried state the moment its own token neared expiry.
 */
export function recordRenewal(state, { token, now, renewed }) {
  return {
    lastAt: now,
    lastToken: token,
    failures: renewed ? 0 : state.failures + 1,
  };
}
