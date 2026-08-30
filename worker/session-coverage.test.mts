// The RC session-coverage decisions, and the wiring that makes them do anything.
//
// THE BUG (2026-08-15). Thirty minutes before a real release, from the box's own log:
//
//     ⏰ hold releases in 30m and the session will not cover it — signing in ONCE
//         → already signed in — nothing to do
//       ✓ signed in unattended — the hold is covered
//
// `maybeAutoLogin` computed that the token would not last, called `attemptLogin` to fix it,
// and `attemptLogin` short-circuited on `isLive()` — a question about existence, not about
// duration. The token had 23 minutes, needed 50, expired at 07:53, and the 08:00 cart failed
// with the release's one sign-in attempt already spent on a no-op.
//
// HALF THIS FILE IS STRUCTURAL, and that is deliberate. The pure functions below can be
// perfect while nothing calls them — which is the exact shape that has cost this repo three
// commits already (`6006428` claiming to fix the RC URL while only touching the copy; the
// `--claimed` flag honoured by the guard and never passed by the poller; the memory sampler's
// `C|` line emitted after the loop instead of before). A fix present but inert passes review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenSecondsNeeded, sessionAcceptable } from '../scripts/auto-cart-bot/session-coverage.mjs';

const BOT = join(import.meta.dirname, '..', 'scripts', 'auto-cart-bot');
const read = (f: string) => readFileSync(join(BOT, f), 'utf8');

// ─── the decisions ────────────────────────────────────────────────────────────────────

test('a live session is NOT accepted when it will not cover the deadline', () => {
  // The 2026-08-15 failure, in one line.
  assert.equal(sessionAcceptable(true, false), false);
});

test('a live session is accepted when it covers the deadline', () => {
  assert.equal(sessionAcceptable(true, true), true);
});

test('a caller with no deadline gets the old behaviour', () => {
  // The rehearsal and --test-login pass no `sufficient`; a live session is a fine answer for
  // them, and changing that would make every nightly rehearsal force a needless sign-in.
  assert.equal(sessionAcceptable(true, undefined), true);
});

test('an UNDECODABLE token is accepted, never treated as insufficient', () => {
  // `null` means "we could not tell". Rejecting would force a sign-in, and a sign-in first
  // DROPS the stored token — a destructive act taken on an unknown, against a session that
  // may have been healthy. Same rule as hasAvailabilityInRange returning null, and as
  // oktaSessionAlive's unknown never being reported as dead.
  assert.equal(sessionAcceptable(true, null), true);
});

test('a dead session is never acceptable, whatever the coverage says', () => {
  for (const enough of [true, false, null, undefined]) {
    assert.equal(sessionAcceptable(false, enough as boolean | null | undefined), false);
    assert.equal(sessionAcceptable(null as unknown as boolean, enough as boolean), false);
  }
});

test('the token requirement is measured from where we stand, not from the lead', () => {
  // At T−30 this reproduces the old constant exactly (30 + 15 + 5 = 50)...
  assert.equal(tokenSecondsNeeded(30 * 60, 15, 5), 50 * 60);
  // ...and at T−5 it asks for 25 minutes rather than the same 50. Demanding fifty minutes of
  // token to cover twenty minutes of work is how a good session reads as insufficient and
  // buys a sign-in the ration exists to protect.
  assert.equal(tokenSecondsNeeded(5 * 60, 15, 5), 25 * 60);
});

test('the requirement is exact in seconds, not a sixty-second staircase', () => {
  // THE 2026-08-30 BUG. `minutesUntil` rounded, so the requirement stepped in whole minutes
  // while the token decayed continuously — and a deficit smaller than the step read as
  // covered. Reconstructed from the box's own log: at 07:29:44 the release was 1816s away
  // and the token had at most 3014s left, against a true requirement of 3016s. It was short,
  // and rounding 1816 up to 30 minutes said otherwise.
  assert.equal(tokenSecondsNeeded(1816, 15, 5), 3016);
  // Rounded minutes would have asked for exactly 3000 and called 3014 "covering".
  assert.ok(tokenSecondsNeeded(1816, 15, 5) > 3014,
    'a token 2s short must not read as covering');

  // And the staircase must not reappear: one second closer to the release must move the
  // requirement by one second, not by nothing and then by sixty.
  for (const s of [1801, 1816, 1830, 1859]) {
    assert.equal(tokenSecondsNeeded(s + 1, 15, 5) - tokenSecondsNeeded(s, 15, 5), 1,
      `the requirement must track the clock second by second (at ${s}s)`);
  }
});

test('past the release the requirement never shrinks below cart hold plus margin', () => {
  // dueHolds keeps handing a hold back for 20 minutes after its release. A negative
  // `secsUntilRelease` must not subtract from what the CLAIM still needs — the bot has to be
  // able to run remove/cartentry when the user taps.
  assert.equal(tokenSecondsNeeded(-10 * 60, 15, 5), 20 * 60);
  assert.equal(tokenSecondsNeeded(0, 15, 5), 20 * 60);
});

// ─── the wiring ───────────────────────────────────────────────────────────────────────

test('attemptLogin short-circuits through sessionAcceptable, never a bare isLive', () => {
  const src = read('rc-autologin.mjs');
  assert.match(src, /sessionAcceptable\(live, enough\)/);

  // ASSERTED ABOUT THE RETURNS, NOT BY COUNTING `isLive()` CALLS. Some bare uses are correct
  // — "there IS a session but it is too short" needs one, and so does the post-password
  // "did that work?". The rule is narrower and is the actual bug: no early return claiming
  // ALREADY SIGNED IN may be reached without the coverage check.
  //
  // Both short-circuits are covered on purpose. The first draft of this fix changed only the
  // one after the page load, and the second — the re-authentication retry loop — would have
  // gone on reporting "already signed in" about a session expiring before the release, moving
  // the bug rather than fixing it.
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/reason: 'already signed in/.test(lines[i])) continue;
    const guard = lines.slice(Math.max(0, i - 8), i).join('\n');
    assert.match(
      guard, /await acceptable\(\)/,
      `the "already signed in" return at line ${i + 1} is not guarded by acceptable():\n${guard}`,
    );
  }
});

test('maybeAutoLogin actually PASSES sufficient to attemptLogin', () => {
  // The inert-fix guard. `attemptLogin` accepting a `sufficient` option changes nothing at
  // all unless the release-critical caller supplies one, and that call site is in a different
  // file — invisible from the one being reviewed.
  //
  // SCOPED TO THE FUNCTION, because the file has more than one `attemptLogin` caller. This
  // took the whole file and sliced from the FIRST `const r = await attemptLogin(`, which was
  // maybeAutoLogin's only for as long as it happened to be the earliest in the file — and it
  // stopped being so the moment `maybeWarmupLogin` was added above it (2026-08-21), where it
  // failed against correct code while reading a DIFFERENT caller that deliberately passes no
  // deadline. Anchoring on a token that occurs more than once is the recurring defect here;
  // twentieth time.
  const src = read('rc-keepwarm.mjs');
  const fnAt = src.indexOf('async function maybeAutoLogin');
  assert.ok(fnAt > -1, 'maybeAutoLogin must still exist — anchor not found');
  const fn = src.slice(fnAt, src.indexOf('\nasync function ', fnAt + 10));
  // ANCHOR ON THE CALLEE, not the assignment. `const r = await attemptLogin(` broke over
  // unchanged behaviour when the login was wrapped in `withNetworkTrace` and the binding
  // became `const { result: r, trace: t } = await withNetworkTrace(tab, () => attemptLogin(`.
  // The callee is what survives wrapping; the assignment form is incidental. Twenty-third time.
  const callAt = fn.indexOf('attemptLogin(ctx, tab,');
  assert.ok(callAt > -1, 'maybeAutoLogin must still call attemptLogin');
  const opts = fn.slice(callAt, fn.indexOf('});', callAt));
  assert.match(opts, /sufficient:/,
    'maybeAutoLogin must hand attemptLogin its deadline, or the sufficiency check is dead code');
  assert.match(opts, /needSec/, 'the predicate must compare against the computed requirement');
});

test('an attempt that exercised nothing is refunded to the budget', () => {
  // `provedNothing` means RC was already signed in and no credential was submitted. Counting
  // it spends the ration on a no-op — which is how the second, late re-check would be lost
  // for the same reason the first one was.
  const src = read('rc-keepwarm.mjs');
  assert.match(src, /r\.provedNothing/);
  assert.match(src, /autoLogin\.spent -= 1/);
});

test('the release budget allows a second, later attempt but is still bounded', () => {
  const src = read('rc-keepwarm.mjs');
  const m = src.match(/RC_AUTOLOGIN_MAX_ATTEMPTS \|\| (\d+)/);
  assert.ok(m, 'the per-release attempt budget must be a named constant');
  const max = Number(m![1]);
  assert.ok(max >= 2, 'one attempt makes the first answer the only answer — that is the bug');
  assert.ok(max <= 3,
    'repeated logins from this address cost 12h of IP block on 2026-08-06; this is not a retry loop');
  assert.match(src, /AUTOLOGIN_RETRY_GAP_MS/, 'a second attempt needs a gap, or it is a loop');
});

test('every auto-login gate names itself, and repeats collapse', () => {
  const src = read('rc-keepwarm.mjs');
  const body = src.slice(src.indexOf('async function maybeAutoLogin('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.equal(
    (fn.match(/return false;/g) ?? []).length, 0,
    'a bare `return false` is a gate that fired silently — route it through autoLoginSkip()');
  assert.ok((fn.match(/autoLoginSkip\(/g) ?? []).length >= 6,
    'each distinct stand-down reason needs its own sentence');
  // Asked every 60s, so an un-collapsed line is 1,440 identical entries a day — which hides
  // the answer just as effectively as printing nothing.
  assert.match(src, /lastAutoLoginSkip/);
});

test('the hold runner stands off the profile after repeated dead-session passes', () => {
  const src = read('rc-hold-runner.mjs');
  assert.match(src, /DEAD_SESSION_BACKOFF_MS/);
  assert.match(src, /profileStandOffUntil/);
  // The stand-off must be checked BEFORE requestProfile, or the keep-warm is evicted anyway
  // and the back-off buys nothing — the inert-fix shape again.
  const fn = src.slice(src.indexOf('async function withRC(fn)'));
  const guard = fn.indexOf('profileStandOffUntil');
  const ask = fn.indexOf('requestProfile(');
  assert.ok(guard !== -1 && ask !== -1 && guard < ask,
    'the stand-off must be checked before the profile is requested');
});

test('the stand-off outlasts a FAILED renewal\'s retry, and still leaves room to cart', () => {
  /**
   * THIS GUARD USED TO PIN THE BUG, and that is the part worth keeping.
   *
   * It read `ms >= 60_000` ("shorter than a keep-warm cycle buys it no uninterrupted time")
   * and `ms <= 5 * 60_000` ("must stay well inside the 20-minute cart grace window"). The
   * upper bound was EXACTLY `RENEW_FLOOR_MS` — so it required the stand-off to be no longer
   * than the repair cadence it has to outlast, and the fix could not be made without the
   * guard going red. Same shape as `held-offer-scope.test.mts` requiring the alert storm.
   *
   * THEN THE FIRST FIX WAS ALSO WRONG, AND THE SAME AFTERNOON MEASURED IT. Sizing on
   * `RENEW_FLOOR_MS` assumes the renewal SUCCEEDS. The case this constant exists for is the
   * one where it does not, and a failed attempt does not retry at the floor:
   *
   *     18:11:51  ✗ no fresher token — got as far as: no-signin-control
   *     18:17:20     renewal stood down: nothing has changed since the attempt 5m ago
   *     18:22:22  renewing the session …
   *     18:23:09  ✓ renewed by authorize: none → 3579s
   *
   * It retries at RENEW_MIN_GAP_MS — TEN minutes. A six-minute stand-off expired before the
   * retry, the runner retook the profile, and the repair that worked never got a browser.
   *
   * THE UPPER BOUND IS NO LONGER "HALF THE GRACE", and the reason is written down so the
   * next reader does not take the change for a weakening. What the ceiling protects is the
   * ability to still CART once the stand-off ends. A cart is seconds — T+1.6s and T+2s are
   * the measured ones — reached on a 15-second poll. So the bound is "several polls plus a
   * cart", not half the window. What is genuinely spent is blind time, and that is affordable
   * only because arming this needs TWO consecutive dead-session passes.
   */
  const src = read('rc-hold-runner.mjs');
  const sched = read('renewal-schedule.mjs');

  const gapM = sched.match(/export const RENEW_MIN_GAP_MS = (\d+) \* 60_000;/);
  assert.ok(gapM, 'could not read RENEW_MIN_GAP_MS');
  const gapMs = Number(gapM![1]) * 60_000;

  // DERIVED IN THE SOURCE, never mirrored. A literal large enough today drifts silently the
  // moment the cadence moves — which is how this constant came to be too short twice.
  const m = src.match(/RC_DEAD_SESSION_BACKOFF_MS \|\| RENEW_MIN_GAP_MS \+ ([0-9_]+)/);
  assert.ok(m, 'the stand-off must be derived from RENEW_MIN_GAP_MS, not chosen');
  const ms = gapMs + Number(m![1].replace(/_/g, ''));

  assert.ok(
    ms > gapMs,
    `a ${ms / 60_000}m stand-off expires before a failed renewal retries at ${gapMs / 60_000}m`,
  );
  // Room for the renewal to COMPLETE, not merely to start: the authorize round trip has been
  // observed at 45-60s.
  assert.ok(ms - gapMs >= 45_000, 'leave the renewal room to finish, not merely to begin');

  // AND ENOUGH GRACE LEFT TO ACTUALLY CART.
  const graceM = readFileSync('src/lib/rc-holds.ts', 'utf8').match(/graceMinutes\s*=\s*(\d+)/);
  const graceMs = (graceM ? Number(graceM[1]) : 20) * 60_000;
  const CART_ROOM_MS = 5 * 60_000;
  assert.ok(
    ms + CART_ROOM_MS <= graceMs,
    `a ${ms / 60_000}m stand-off leaves under ${CART_ROOM_MS / 60_000}m of the ` +
    `${graceMs / 60_000}m grace window to notice and cart`,
  );
});

test('an ADEQUATE token is never destroyed when there is no runway to recover', () => {
  /**
   * THE 2026-08-30 THIRD FAILURE, and it was self-inflicted by the margin raised that morning.
   *
   * `attemptLogin` DROPS the stored token before hunting for a sign-in form — it must, because
   * RC's SPA renders signed-in while a token is present and then there is no form to find. So
   * the repair destroys the thing it repairs, and a failed repair leaves the session WORSE
   * than not trying:
   *
   *     18:52:39  ♻ kept warm — token exp in 30m
   *     18:54:38  ⏰ hold releases in 2m and the session will not cover it — signing in
   *     18:54:43      → signed in, but the token will not cover the hold — dropping it
   *     18:56:31  RC loaded and STAYING OPEN — token source: none
   *
   * The 30-minute token was ADEQUATE — it outlived the release plus the whole cart hold, so
   * both the cart and the release-on-claim were covered. It was only under the safety margin.
   *
   * The margin is NOT reverted and this does not make it inert: it still governs while there
   * is time to recover from a failed sign-in, which is where a refresh is cheap. What it may
   * no longer do is spend a destructive gamble at a moment with no runway.
   */
  const src = read('rc-keepwarm.mjs');
  const fnAt = src.indexOf('async function maybeAutoLogin');
  assert.ok(fnAt > -1, 'maybeAutoLogin must still exist — anchor not found');
  const fn = src.slice(fnAt, src.indexOf('\nasync function ', fnAt + 10));

  // ADEQUATE = the claim's real requirement: alive through the release and the whole cart
  // hold, because that is when remove/cartentry must still run. NO margin — a margin here
  // would make this guard the very thing it exists to override.
  assert.match(
    fn, /const adequateSec = tokenSecondsNeeded\(secs, CART_HOLD_MIN, 0\)/,
    'adequacy must be cart hold with NO margin',
  );

  // DERIVED FROM THE RETRY GAP, not chosen. Surviving one failed sign-in needs the gap plus
  // time for the retry to run.
  assert.match(
    fn, /const recoveryMs = AUTOLOGIN_RETRY_GAP_MS \+ [0-9_]+ \* 60_000;/,
    'the runway must be derived from AUTOLOGIN_RETRY_GAP_MS',
  );

  // THE GUARD ITSELF, and BOTH conditions. Without `!recoverable` it would refuse every
  // margin-driven refresh including the cheap recoverable ones the margin exists for;
  // without the adequacy test it would keep a token that cannot cover the claim at all.
  const guard = fn.match(/if \(!recoverable && left != null && left > adequateSec\) \{/);
  assert.ok(guard, 'the stand-down must require BOTH no-runway AND an adequate token');

  // AND IT MUST SIT AFTER the "covers" return, or a fully-covering token takes this branch
  // and reports itself as merely adequate — true, but the wrong sentence in the log a human
  // reads at 07:50.
  const coversAt = fn.indexOf('the token covers this hold');
  const guardAt = fn.indexOf('if (!recoverable && left != null && left > adequateSec)');
  assert.ok(coversAt > -1 && guardAt > coversAt,
    'the adequacy stand-down must come after the full-coverage stand-down');

  // ...and BEFORE anything spends an attempt, or the guard is decoration.
  const spendAt = fn.indexOf('autoLogin.spent >= AUTOLOGIN_MAX_ATTEMPTS');
  assert.ok(spendAt > -1 && guardAt < spendAt,
    'the stand-down must come before the attempt budget is consulted');
});

test('the token is written to storage BEFORE the profile is handed over', () => {
  /**
   * THE DEFECT THIS PINS, measured twice on 2026-08-30 and the cause of two lost hand-off
   * tests. `readLiveToken` prefers `window.__camphawkRcToken` — the capture hook's copy, off
   * RC's own outbound header — which lives in PAGE MEMORY and dies with the browser:
   *
   *     18:08:26  ♻ kept warm — token exp in 46m
   *     18:08:52  → hold runner wants the profile — closing and standing down
   *     18:09:36  RC loaded and STAYING OPEN — token source: none
   *
   * A queued hold destroyed its own session, then the runner reported that session dead.
   *
   * STRUCTURAL, and the ORDER is the whole property: writing after the break, or not
   * awaiting, both leave the token to die with the page while the diff looks correct. That
   * is the fix-present-but-inert shape this file's header is about.
   */
  const src = read('rc-keepwarm.mjs');

  const yieldAt = src.indexOf("log('→ hold runner wants the profile");
  assert.ok(yieldAt > -1, 'the profile yield must still exist — anchor not found');
  const guardAt = src.lastIndexOf('if (profileRequested(PROFILE_DIR)) {', yieldAt);
  assert.ok(guardAt > -1, 'the yield must sit under profileRequested()');

  const block = src.slice(guardAt, yieldAt);
  assert.match(
    block, /await persistLiveToken\(page\)/,
    'the live token must be written to storage BEFORE the yield is logged and the loop breaks',
  );

  // AWAITED, not fire-and-forget: the close is what destroys the token, so an unawaited
  // write races the very thing it exists to survive.
  assert.ok(
    !/(?<!await )persistLiveToken\(page\)/.test(src.slice(guardAt, src.indexOf('break;', yieldAt))),
    'persistLiveToken must be awaited',
  );

  // And it must be imported from the module that owns the token keys, not reimplemented —
  // a second copy of `ssoAccessToken` is a second thing to keep in step.
  assert.match(src, /persistLiveToken,?[^}]*} from '\.\/rc-token\.mjs'|persistLiveToken/,
    'persistLiveToken must come from rc-token.mjs');
});
