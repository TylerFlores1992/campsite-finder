// THE UNATTENDED SIGN-IN RUNS IN A THROWAWAY TAB, AND ITS BUDGET SURVIVES A KILL.
//
// Both halves come from one measured morning. On 2026-08-20 the auto-login ran at 07:30 on
// the RESIDENT page and cost 9,434 MB over twelve minutes — four times the worst renewal and
// six times as long, because `okta=GONE` forces a full password sign-in, the longest Okta
// navigation there is and the one nothing had ever measured:
//
//     07:29  12%   rc   300 MB  pid 6360    flat
//     07:31  64%   rc 2,811 MB  pid 6452    the Okta navigation
//     07:41  76%   rc 9,434 MB  pid 6452
//     07:43  12%   rc   230 MB  pid 7560    the RAM guard killed it
//
// WHY IT MATTERS MORE HERE THAN FOR THE RENEWAL: a guard kill leaves the profile lock reading
// as HELD for STALE_MS (10 min) and only a living holder renews it, so nothing can preempt it
// cooperatively. A kill at 07:33 clears by 07:43 and is harmless; a kill at 07:53 holds the
// lock past 08:00 and the runner cannot take the profile to cart.
//
// The tests are structural because `rc-keepwarm.mjs` starts the keep-warm loop on import, so
// nothing in it can be called. The BUDGET RULE is therefore a real module with real tests
// below — it has an arm that only ever runs after a crash, which is exactly the arm nobody
// exercises by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  settleBudget, budgetForRelease, blankBudget, MAX_KILL_REFUNDS,
} from '../scripts/auto-cart-bot/autologin-budget.mjs';

const SRC = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
/** Comment lines stripped: several quote the very shapes these tests forbid. */
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The body of `maybeAutoLogin`, bounded so an assertion cannot wander into a neighbour. */
function autoLoginBody(): string {
  const from = code.indexOf('async function maybeAutoLogin(');
  assert.ok(from > -1, 'maybeAutoLogin must still exist — anchor not found');
  const to = code.indexOf('\nasync function maybeRehearse(', from);
  assert.ok(to > from, 'the end anchor must be found AFTER the start, or the slice runs backwards');
  return code.slice(from, to);
}

// ── The tab ───────────────────────────────────────────────────────────────────────────────

test('the sign-in navigates a throwaway tab, not the resident page', () => {
  const body = autoLoginBody();
  assert.match(body, /const tab = await ctx\.newPage\(\)/, 'a tab must be opened');
  assert.match(body, /attemptLogin\(ctx, tab,/,
    'the login must run in the tab — on the resident page its 9.4 GB is not reclaimable');
  assert.ok(!/attemptLogin\(ctx, page,/.test(body),
    'the resident page must not be handed to attemptLogin at all');
});

test('the tab is closed in a finally — that close IS the reclaim', () => {
  const body = autoLoginBody();
  assert.match(body, /\}\s*finally\s*\{[\s\S]{0,600}await tab\.close\(\)/,
    'a thrown login, a failed screenshot or a failed report must not leave the tab parked');
});

test('EVERY page-taking call inside the attempt is bound to the tab', () => {
  // The half that would silently go wrong. A version that moved only `attemptLogin` looks
  // right, runs the navigation in the tab, and still reads and photographs the wrong page:
  //   - `window.__camphawkRcToken` is PER PAGE, so a resident read sees the pre-login nothing
  //     and turns a successful login into "STILL SHORT" and a `dead` verdict;
  //   - during a sign-in the tab sits on signin.reservecalifornia.com, a different origin from
  //     the `www.` one RC writes the token to — the reason `readTokenAnyOrigin` exists;
  //   - a screenshot of the resident page is a picture of a page on which nothing happened.
  const body = autoLoginBody();
  const attempt = body.slice(body.indexOf('const tab = await ctx.newPage()'));

  assert.ok(!/readLiveToken\(page\)/.test(attempt),
    'no token read after the tab opens may target the resident page');
  assert.ok(!/sessionLive\(ctx, page\)/.test(attempt),
    'the liveness probe must ask about the tab');
  assert.ok(!/saveFailureShot\(page/.test(attempt),
    'the failure screenshot must photograph the tab');

  assert.match(attempt, /readLiveToken\(tab\)/);
  assert.match(attempt, /sessionLive\(ctx, tab\)/);
  assert.match(attempt, /saveFailureShot\(tab/);
});

test('the resident page is refreshed after a successful sign-in', () => {
  // The tab mints into the SHARED profile, but the resident SPA is still rendered signed-out
  // and `checkAndReport` reads THAT page. Without this every later report announces a dead
  // session over a fresh hour of token — a repair that happened and cannot be seen. The tab
  // renewal needed exactly this step for exactly this reason.
  const body = autoLoginBody();
  assert.match(body, /page\.goto\(RC_HOME/, 'the resident page must be reloaded');
  assert.match(body, /primeToken\(page/, 'and re-primed, or its token is still per-page nothing');
});

test('a tab that cannot open stands down BEFORE the budget is spent', () => {
  // A browser too sick to open a page never asked RC anything — `provedNothing`, applied
  // before the fact instead of refunded after it. Spending first and refunding later would
  // work, and would be one more place the refund can be forgotten.
  const body = autoLoginBody();
  const open = body.indexOf('const tab = await ctx.newPage()');
  const spend = body.indexOf('autoLogin.spent += 1');
  assert.ok(open > -1 && spend > -1);
  assert.ok(open < spend, 'the tab is opened before the attempt is counted');
  assert.match(body.slice(open, spend), /if \(!tab\)[\s\S]{0,200}autoLoginSkip/,
    'a failed open must be a stand-down, not a spent attempt');
});

test('the auto-login no longer forces a browser recycle', () => {
  // The recycle restarts the whole browser to free memory the tab close already freed, and
  // restarts are not free: one turned the login rehearsal red on 08-18, and every one churns
  // the profile lock — at T−28 of a release, which is the worst moment for it. Reinstating
  // this line would put a browser restart back into the critical window while looking like
  // caution, which is why it is pinned rather than left to a comment.
  //
  // BOUNDED BY THE NEXT CALL, not by a character count. The first version of this test used a
  // fixed 900-char window and FAILED against correct code, because with comments stripped the
  // rehearsal's own `oktaTrip` sits well inside 900 characters of the auto-login's arm. A
  // window that reaches into the neighbour it is contrasting with cannot tell them apart —
  // and the same anchoring mistake has been made in this repo often enough to have a count.
  const at = code.indexOf('await maybeAutoLogin(ctx, page)');
  const reh = code.indexOf('await maybeRehearse(ctx, page)');
  assert.ok(at > -1, 'the auto-login call site must be found');
  assert.ok(reh > at, 'the rehearsal call must be found AFTER it, or the slice runs backwards');
  const arm = code.slice(at, reh);
  assert.ok(!/oktaTrip\s*=/.test(arm),
    'the auto-login arm must not set oktaTrip — the tab close is the reclaim now');
  // The REHEARSAL still navigates the resident page and must keep it, or a genuinely
  // unreclaimed trip is left in the resident browser with nothing to clean it up.
  assert.match(code.slice(reh, reh + 400), /oktaTrip\s*=/,
    'the rehearsal still navigates the resident page, so it must still recycle');
});

// ── The budget ────────────────────────────────────────────────────────────────────────────

test('a killed attempt is refunded — the accident that saved 2026-08-20, made deliberate', () => {
  // `startedAt` set means the process died mid-attempt: the RAM guard, a supervisor stop, a
  // power cut. RC was never told yes or no, so nothing was learned, so the attempt is given
  // back. Same rule as `provedNothing`, and as `unknown` never rounding to a verdict.
  const { budget, refunded } = settleBudget(
    { release: 'r', spent: 1, lastAt: 5, startedAt: 111, killed: 0 });
  assert.equal(refunded, true);
  assert.equal(budget.spent, 0, 'the killed attempt is given back');
  assert.equal(budget.killed, 1, 'and the allowance is used');
  assert.equal(budget.startedAt, 0, 'the in-flight mark is always cleared');
});

test('but only ONCE — a crash loop must still exhaust the budget', () => {
  // Without the bound, a process that dies on every attempt refunds for ever and the budget
  // stops existing. That is the crash-loop-spends-the-login-budget shape this whole change is
  // meant to close, arriving by the other door.
  const { budget, refunded } = settleBudget(
    { release: 'r', spent: 2, lastAt: 5, startedAt: 111, killed: MAX_KILL_REFUNDS });
  assert.equal(refunded, false, 'the allowance is spent');
  assert.equal(budget.spent, 2, 'so the attempt stands');
});

test('an attempt that reached a verdict is never refunded', () => {
  const { budget, refunded } = settleBudget(
    { release: 'r', spent: 1, lastAt: 5, startedAt: 0, killed: 0 });
  assert.equal(refunded, false);
  assert.equal(budget.spent, 1);
});

test('the in-flight mark is cleared even when the refund is refused', () => {
  // Leaving it set would re-offer the same refund on the next restart, turning a bounded
  // allowance into an unbounded one by a different route.
  const { budget } = settleBudget(
    { release: 'r', spent: 2, lastAt: 5, startedAt: 111, killed: MAX_KILL_REFUNDS });
  assert.equal(budget.startedAt, 0);
});

test('anything unreadable is a FRESH budget, never a spent one', () => {
  // A box that has never run this and a corrupt file both land here. Refusing to sign in
  // because a counter would not parse turns a diagnostics problem into a missed cart — the
  // opposite direction from `claimSyncJob`, which fails CLOSED because a doubled catalog sync
  // is worse than a skipped one. Here the skipped login is the worse half.
  for (const junk of [null, undefined, 'nonsense', 42, [], { spent: 'lots' }]) {
    const { budget } = settleBudget(junk as never);
    assert.equal(budget.spent, 0, `${JSON.stringify(junk)} must not read as a spent budget`);
    assert.equal(budget.killed, 0);
  }
  assert.deepEqual(settleBudget(null).budget, blankBudget());
});

test('a negative or non-finite counter cannot manufacture attempts', () => {
  const { budget } = settleBudget(
    { release: 'r', spent: -5, lastAt: NaN, startedAt: 111, killed: -1 } as never);
  assert.equal(budget.spent, 0);
  assert.equal(budget.lastAt, 0);
  assert.equal(budget.killed, 0);
});

test('a new release starts a new budget, kill allowance included', () => {
  // `killed` is about surviving one bad attempt for THIS cart. Carrying it forward would
  // silently halve tomorrow morning's margin, and nothing would say so.
  const spent = { release: 'yesterday', spent: 2, lastAt: 9, startedAt: 0, killed: 1 };
  const fresh = budgetForRelease(spent, 'today');
  assert.equal(fresh.release, 'today');
  assert.equal(fresh.spent, 0);
  assert.equal(fresh.killed, 0);
  // And the same release is left alone, or every poll would reset the budget to zero.
  assert.equal(budgetForRelease(spent, 'yesterday'), spent);
});

// ── The persistence, where it is wired ────────────────────────────────────────────────────

test('the budget is stamped and written BEFORE the attempt, not after', () => {
  // Written after, an attempt that never returns is an attempt the budget never saw — which
  // is the in-memory behaviour being replaced, and an unbounded one. `startedAt` is what lets
  // the next process tell "killed mid-navigation" from "tried and was told no"; those need
  // opposite answers and until now they were the same silence.
  const body = autoLoginBody();
  const stamp = body.indexOf('autoLogin.startedAt = Date.now()');
  const save = body.indexOf('saveAutoLogin(autoLogin)');
  const attempt = body.indexOf('await attemptLogin(');
  assert.ok(stamp > -1 && save > -1 && attempt > -1, 'all three anchors must be found');
  assert.ok(stamp < attempt, 'the in-flight mark is set before the login runs');
  assert.ok(save < attempt, 'and persisted before it runs, or a kill leaves no record');
});

test('reaching a verdict clears the in-flight mark, in the finally', () => {
  // Every branch above is a verdict, including the refunding ones. What `startedAt`
  // distinguishes is the process DYING — and a branch that returned did not die.
  const body = autoLoginBody();
  const fin = body.lastIndexOf('finally');
  assert.ok(fin > -1);
  const tail = body.slice(fin);
  assert.match(tail, /autoLogin\.startedAt = 0/, 'the mark must be cleared on every verdict');
  assert.match(tail, /saveAutoLogin\(autoLogin\)/, 'and the settled budget written');
});

test('the budget file lives under logs/, like the rehearsal ration', () => {
  assert.match(code, /AUTOLOGIN_STATE = path\.join\(HERE, 'logs', '\.autologin-budget\.json'\)/,
    'a file, never process memory — supervise.ps1 restarts this process on exit');
});

test('the rule is a module, so the crash arm is testable at all', () => {
  // Importing rc-keepwarm.mjs starts the keep-warm loop, which is why session-coverage.mjs,
  // renewal-schedule.mjs and rehearsal.mjs all exist. This decision has an arm that only runs
  // after a crash — the one nobody exercises by hand.
  assert.match(code, /from '\.\/autologin-budget\.mjs'/, 'the decision must be imported');
  const mod = readFileSync('scripts/auto-cart-bot/autologin-budget.mjs', 'utf8');
  assert.ok(!/require\(|from 'node:fs'|from 'fs'/.test(mod),
    'no filesystem in the rule — a test that stubbed fs would be testing the stub');
});
