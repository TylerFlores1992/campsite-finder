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
import { requiredTokenSeconds, sessionAcceptable } from '../scripts/auto-cart-bot/session-coverage.mjs';

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
  assert.equal(requiredTokenSeconds(30, 15, 5), 50 * 60);
  // ...and at T−5 it asks for 25 minutes rather than the same 50. Demanding fifty minutes of
  // token to cover twenty minutes of work is how a good session reads as insufficient and
  // buys a sign-in the ration exists to protect.
  assert.equal(requiredTokenSeconds(5, 15, 5), 25 * 60);
});

test('past the release the requirement never shrinks below cart hold plus margin', () => {
  // dueHolds keeps handing a hold back for 20 minutes after its release. A negative
  // `minsUntilRelease` must not subtract from what the CLAIM still needs — the bot has to be
  // able to run remove/cartentry when the user taps.
  assert.equal(requiredTokenSeconds(-10, 15, 5), 20 * 60);
  assert.equal(requiredTokenSeconds(0, 15, 5), 20 * 60);
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

test('the stand-off is shorter than the window a hold stays retryable', () => {
  // dueHolds hands a hold back for 20 minutes past its release. Standing off longer than that
  // would trade a repairable session for a guaranteed miss.
  const src = read('rc-hold-runner.mjs');
  const m = src.match(/RC_DEAD_SESSION_BACKOFF_MS \|\| ([\d_]+)/);
  assert.ok(m, 'the back-off must be a named constant');
  const ms = Number(m![1].replace(/_/g, ''));
  assert.ok(ms >= 60_000, 'shorter than a keep-warm cycle buys it no uninterrupted time');
  assert.ok(ms <= 5 * 60_000, 'must stay well inside the 20-minute cart grace window');
});
