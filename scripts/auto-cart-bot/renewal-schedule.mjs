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
 */

/** Never two attempts closer than this, whatever else changed. */
export const RENEW_FLOOR_MS = 5 * 60_000;
/** Repeating an attempt against an UNCHANGED state waits this long. */
export const RENEW_MIN_GAP_MS = 10 * 60_000;
/** ...and this long once it is plainly not working. */
export const RENEW_BACKOFF_GAP_MS = 30 * 60_000;
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
  // that six times an hour.
  const gap = state.failures >= backoffAfter ? backoffGapMs : minGapMs;
  if (token === state.lastToken && since < gap) {
    const why = state.failures >= backoffAfter
      ? `${state.failures} attempts in a row have failed, so the next is ${mins(gap)}m apart`
      : `nothing has changed since the attempt ${mins(since)}m ago`;
    return { go: false, key: state.failures >= backoffAfter ? 'backoff' : 'unchanged', reason: why };
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
  return (key, reason) => {
    if (key === last) return false;
    last = key;
    emit(reason);
    return true;
  };
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
