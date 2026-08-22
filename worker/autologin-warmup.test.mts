// THE EXPENSIVE OKTA SIGN-IN MUST NOT BE PINNED TO THE RELEASE-CRITICAL WINDOW.
//
// An RC sign-in comes in two sizes and the difference is three orders of magnitude:
//
//     okta=ALIVE   answered from the idx cookie   11 seconds,     +24 MB
//     okta=GONE    full password form             12 minutes,  +9,434 MB
//
// `maybeAutoLogin` acts ONLY inside `AUTOLOGIN_LEAD_MIN` (30m), so the second one could
// previously happen at no time except the half hour before a cart. That is dangerous for a
// specific, measured reason: a RAM-guard kill leaves the Chromium profile lock reading HELD
// for STALE_MS (10 min) with nothing alive to renew or release it, so a kill at 07:53 holds
// the lock past 08:00 and the hold runner cannot take the profile to cart. On 2026-08-20 the
// cart survived only because a supervisor restart happened to land in time.
//
// The warm-up moves that trip to T−3h, where every one of those failure modes is free.
//
// TWO PROPERTIES CARRY THE SAFETY ARGUMENT, and they are the ones to break first:
//
//   1. IT NEVER ACTS ON AN UNKNOWN. Acting would submit a password on a guess, from the
//      address that ate a 12-hour block on 2026-08-06, to fix a problem that may not exist.
//   2. IT NEVER ACTS INSIDE THE CRITICAL LEAD. Two sign-in drivers on one Chromium profile
//      is worse than either, and a warm-up navigating to Okta at T−20 is the twelve-minute
//      trip landing back inside the window this exists to clear.
//
// The rule is pure and tested behaviourally. The wiring is pinned structurally, because the
// dangerous mistakes there are positional — WHICH caller runs first, WHETHER the tab is
// closed, WHETHER the probe is gated — and this project has shipped a correct fix that was
// inert three times (`6006428`, the `--claimed` omission, the recycle inside its own loop).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  warmupPlan, warmupWindowOpen, WARMUP_LEAD_MIN, WARMUP_MAX_ATTEMPTS,
} from '../scripts/auto-cart-bot/autologin-warmup.mjs';

const CRITICAL = 30;
const plan = (o: Record<string, unknown>) =>
  warmupPlan({ criticalLeadMin: CRITICAL, ...o } as Parameters<typeof warmupPlan>[0]);

// ── 1. Unknown never acts ─────────────────────────────────────────────────────────────────

test('an UNKNOWN Okta reading stands down — a password is never spent on a guess', () => {
  // `oktaSessionAlive` returns unknown for a busy profile, a 403 from RC's edge and a network
  // blip alike. The failure direction must always be "we did nothing", which is exactly the
  // status quo this improves on. Same rule as `hasAvailabilityInRange` returning null and an
  // unknown Okta probe never being reported as dead.
  for (const okta of [null, undefined]) {
    const r = plan({ minutesUntilRelease: 180, oktaAlive: okta });
    assert.equal(r.go, false, `unknown (${String(okta)}) must not act`);
    assert.match(r.why, /UNKNOWN/);
  }
});

test('only a definitive GONE acts', () => {
  assert.equal(plan({ minutesUntilRelease: 180, oktaAlive: false }).go, true);
  const alive = plan({ minutesUntilRelease: 180, oktaAlive: true });
  assert.equal(alive.go, false, 'a live Okta session has nothing to gain from a sign-in');
  assert.match(alive.why, /cookie/, 'and the reason should say why it is already cheap');
});

// ── 2. The windows are disjoint ───────────────────────────────────────────────────────────

test('the warm-up NEVER acts inside the critical lead', () => {
  // The boundary belongs to the release-critical caller: `<=`, not `<`. At T−30 exactly,
  // `maybeAutoLogin` owns the profile.
  for (const mins of [0, 1, 15, 29, CRITICAL]) {
    const r = plan({ minutesUntilRelease: mins, oktaAlive: false });
    assert.equal(r.go, false, `must stand down at T-${mins}`);
    assert.match(r.why, /inside the 30m lead|auto-login owns/);
  }
  // And it does act on the far side of that boundary.
  assert.equal(plan({ minutesUntilRelease: CRITICAL + 1, oktaAlive: false }).go, true);
});

test('the warm-up window and the critical window cannot overlap at any minute', () => {
  // Exhaustive over the whole range rather than sampled: this is THE property that keeps two
  // sign-in drivers off one Chromium profile, and an off-by-one in either bound reintroduces
  // exactly the contention the module exists to prevent.
  for (let mins = 0; mins <= WARMUP_LEAD_MIN + 60; mins++) {
    const warm = warmupWindowOpen({ minutesUntilRelease: mins, criticalLeadMin: CRITICAL }).open;
    const critical = mins <= CRITICAL;          // maybeAutoLogin's own condition
    assert.ok(!(warm && critical), `both windows open at T-${mins}`);
  }
});

test('too early stands down, so it cannot fire the night before', () => {
  // Deliberate: the Okta session it establishes has to still be there at T-30, and there is
  // an ABSOLUTE cap behind the rolling window whose origin is NOT established (2026-08-19).
  // Staying far inside any plausible bound beats reasoning about one nobody has pinned down.
  const r = plan({ minutesUntilRelease: WARMUP_LEAD_MIN + 1, oktaAlive: false });
  assert.equal(r.go, false);
  assert.match(r.why, /outside the \d+m warm-up window/);
});

test('the lead is bounded on both sides by the reasons that chose it', () => {
  // Below ~30m it would be inside the critical lead it exists to avoid; the night before is
  // where the unmeasured Okta cap lives. Pinned so a later "obvious improvement" has to
  // re-take the decision rather than drift into it.
  assert.ok(WARMUP_LEAD_MIN > CRITICAL,
    'a warm-up lead inside the critical lead is a warm-up that can never run');
  assert.ok(WARMUP_LEAD_MIN <= 360,
    'past ~6h this is betting on an Okta absolute cap nobody has measured');
});

// ── 3. The ration ─────────────────────────────────────────────────────────────────────────

test('one attempt per release, and no retry', () => {
  // A failed warm-up leaves us exactly where we started — maybeAutoLogin still has its full
  // budget at T-30 — so a second attempt buys a second password submission against the same
  // address for no change in outcome.
  assert.equal(WARMUP_MAX_ATTEMPTS, 1);
  const r = plan({ minutesUntilRelease: 180, oktaAlive: false, spent: 1 });
  assert.equal(r.go, false);
  assert.match(r.why, /already had its/);
});

test('an unreadable release time stands down', () => {
  const r = plan({ minutesUntilRelease: null, oktaAlive: false });
  assert.equal(r.go, false);
  assert.match(r.why, /could not read the release time/);
});

test('every stand-down says why', () => {
  // A silent gate is indistinguishable from a gate that never ran — the failure this project
  // has fixed in the watchdog, the rehearsal and five auto-login gates.
  for (const args of [
    { minutesUntilRelease: null, oktaAlive: false },
    { minutesUntilRelease: 9999, oktaAlive: false },
    { minutesUntilRelease: 5, oktaAlive: false },
    { minutesUntilRelease: 180, oktaAlive: true },
    { minutesUntilRelease: 180, oktaAlive: null },
    { minutesUntilRelease: 180, oktaAlive: false, spent: 9 },
  ]) {
    const r = plan(args);
    assert.equal(r.go, false);
    assert.ok(r.why && r.why.length > 15, `a bare or missing reason: ${JSON.stringify(r)}`);
  }
});

// ── 4. The wiring ─────────────────────────────────────────────────────────────────────────

const KW = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
/** Comments quote the shapes these tests forbid. */
const code = KW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function warmupBody(): string {
  const from = code.indexOf('async function maybeWarmupLogin');
  assert.ok(from > -1, 'maybeWarmupLogin must exist — anchor not found');
  const to = code.indexOf('\nasync function ', from + 10);
  assert.ok(to > from, 'the end anchor must be found AFTER the start');
  return code.slice(from, to);
}

test('the Okta probe is gated on the window, not run every tick', () => {
  // `oktaSessionAlive` hits /api/v1/sessions/me, and `checkAndReport` already calls it every
  // poll. A second unconditional call doubles our traffic to that endpoint from an address
  // both providers have blocked, to answer a question that matters minutes a month.
  const body = warmupBody();
  const win = body.indexOf('warmupWindowOpen(');
  const probe = body.indexOf('oktaSessionAlive(');
  assert.ok(win > -1, 'the window gate must be called');
  assert.ok(probe > win, 'the Okta probe must come AFTER the window check, never before');
  const between = body.slice(win, probe);
  assert.match(between, /if \(!win\.open\) return/,
    'and the window check must RETURN when closed, or gating it changes nothing');
});

test('the release-critical caller runs BEFORE the warm-up', () => {
  // The windows are disjoint, so this cannot matter today. It is pinned because if that
  // disjointness is ever broken by a future edit, the caller that can lose a campsite must be
  // the one that wins and the warm-up must be what gets skipped.
  const auto = code.indexOf('await maybeAutoLogin(ctx, page)');
  const warm = code.indexOf('await maybeWarmupLogin(ctx, page)');
  assert.ok(auto > -1 && warm > -1, 'both call sites must exist');
  assert.ok(auto < warm, 'maybeAutoLogin must be called first');
});

test('the warm-up runs in a throwaway tab that is always closed', () => {
  // The close is the cure: a renderer's memory dies with its page. In a `finally`, or a
  // sign-in that throws leaks the very renderer this is built to reclaim.
  const body = warmupBody();
  assert.match(body, /ctx\.newPage\(\)/, 'the trip must get its own page');
  const fin = body.indexOf('} finally {');
  assert.ok(fin > -1, 'the close must be in a finally, not on the happy path');
  assert.match(body.slice(fin), /tab\.close\(\)/);
});

test('the tab is what the login and the failure shot are bound to', () => {
  // Everything that touches a page must be the TAB: the resident page has not navigated, so
  // photographing it captures a page on which nothing happened. The auto-login's own comment
  // records this as the way a version of that change looked right and got it wrong.
  const body = warmupBody();
  assert.match(body, /attemptLogin\(ctx, tab,/, 'the login must run in the tab');
  assert.match(body, /saveFailureShot\(tab,/, 'and the screenshot must photograph the tab');
});

test('the ration is spent BEFORE the attempt and persisted', () => {
  // In memory it would be re-issued by `supervise.ps1` on every restart — and the RAM guard
  // killing this exact navigation is what causes restarts. Over a 2.5-hour window polled
  // every minute that is an unbounded sign-in loop from a previously blocked address.
  const body = warmupBody();
  const spend = body.indexOf('warmup.spent += 1');
  const attempt = body.indexOf('attemptLogin(');
  assert.ok(spend > -1 && attempt > spend, 'the ration must be spent before the attempt');
  assert.match(body.slice(spend, attempt), /saveWarmup\(/,
    'and written to disk before the attempt, or a kill mid-navigation refunds it silently');
});

test('a tab that cannot open is a stand-down, not a spent attempt', () => {
  // A browser too sick to open a page never asked RC anything — `provedNothing` applied
  // before the fact instead of refunded after it.
  const body = warmupBody();
  const tabFail = body.indexOf('could not open a warm-up tab');
  const spend = body.indexOf('warmup.spent += 1');
  assert.ok(tabFail > -1 && spend > tabFail,
    'the tab-open failure must return before the ration is spent');
});

test('success is judged by RE-PROBING Okta, not by the login returning ok', () => {
  // `ok` means the sign-in returned. What we came for is the Okta session, and this project
  // has twice recorded a verdict that restated the intent rather than reading the result.
  const body = warmupBody();
  const attempt = body.indexOf('attemptLogin(');
  const after = body.indexOf('oktaSessionAlive(', attempt);
  assert.ok(after > attempt, 'Okta must be re-probed after the attempt');
  assert.match(body.slice(after, after + 220), /alive === true/,
    'and the verdict must turn on that reading');
});

test('the warm-up does not post a session verdict', () => {
  // `checkAndReport` owns that field, runs moments later on the same tick, and asks RC
  // properly. A warm-up that failed says nothing new about whether RC accepts the current
  // token, and a second voice on one field is how two facts of different ages become one
  // record.
  const body = warmupBody();
  assert.ok(!/reportSession\(/.test(body),
    'the warm-up must not write the session verdict — checkAndReport is the authority');
});

test('the warm-up passes no coverage deadline', () => {
  // It is not trying to cover the release and CANNOT: the token lives ~60 minutes and the
  // release is hours away. A `sufficient` deadline here would report a perfectly successful
  // warm-up as a failure for not achieving something it was never aimed at.
  const body = warmupBody();
  assert.ok(!/sufficient:/.test(body),
    'a coverage deadline belongs to maybeAutoLogin, which must cover T+15');
});
