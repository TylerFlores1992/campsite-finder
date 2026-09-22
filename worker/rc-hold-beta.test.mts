/**
 * THE CLOSED RC-HOLD BETA — the flag, and the four places that have to honour it.
 *
 * `src/lib/autocart-beta.ts` answers "may this person be offered a ReserveCalifornia hold
 * while the path is still in testing?" On 2026-09-22 the answer became "only the owner",
 * because `#M421` carted and then lost the site: the hand-off webview reported
 * `storedToken: 'none'` and `oktaKeys: 0` on five consecutive injections, the precart could
 * only ask the user to sign in, and the row ended `released` with `claimed_at` NULL.
 *
 * ## It lives under `worker/`, not beside the module it tests
 *
 * Because it imports `worker/hold-offer.ts`, and the ROOT tsconfig excludes `worker/` —
 * so the same file under `src/lib/` typechecks against a config that cannot see half its
 * imports and fails `npm run typecheck` with a message about import extensions. The
 * placement costs nothing extra: this change already edits `worker/poller.ts`, so the
 * worker deploy fires either way.
 *
 * ## Why this file is mostly WIRING assertions
 *
 * `rcHoldBetaAllows` returning false for a stranger is worth about four lines. The way this
 * change fails is the shape this repo has recorded nine times — **fix present and inert**:
 * the function is perfect, and `holdOfferDecision` never receives its answer, or the poller
 * computes it and forgets to pass it, or the promise panel keeps rendering. Every one of
 * those leaves the pure tests green while a stranger is still handed a button that takes a
 * real campsite off the market. So the pure rule gets four tests and the wiring gets four.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import {
  RC_HOLD_BETA_OPEN, RC_HOLD_BETA_USER_IDS, rcHoldBetaAllows,
} from '../src/lib/autocart-beta';
import { holdOfferDecision, type HoldOfferFacts } from './hold-offer';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

// ── the rule ────────────────────────────────────────────────────────────────────────

test('an allowlisted id is allowed and a stranger is not', () => {
  assert.ok(RC_HOLD_BETA_USER_IDS.length > 0, 'an empty allowlist would switch the owner off too');
  for (const id of RC_HOLD_BETA_USER_IDS) assert.ok(rcHoldBetaAllows(id), `${id} must be allowed`);
  assert.ok(!rcHoldBetaAllows('user_someone_else'));
});

test('FAILS CLOSED on an absent id — the house shape, stated once more', () => {
  // "We could not tell who this is" is not "this is somebody entitled". An absent reading
  // rendered as a positive is the single most repeated failure in this repository, and the
  // cost here is a stranger being promised a campsite we will not take.
  for (const absent of [null, undefined, '']) {
    assert.equal(rcHoldBetaAllows(absent as string | null | undefined), false,
      `${JSON.stringify(absent)} must not be read as an allowance`);
  }
});

test('the allowlist is Clerk ids, never emails', () => {
  // An email is editable by its own owner, so an allowlist keyed on one is an allowlist the
  // allowed party can extend. Clerk ids are not user-editable.
  for (const id of RC_HOLD_BETA_USER_IDS) {
    assert.match(id, /^user_[A-Za-z0-9]+$/, `${id} is not a Clerk user id`);
    assert.ok(!id.includes('@'), `${id} looks like an email`);
  }
});

test('OPEN bypasses the list entirely, so reopening is one edit', () => {
  // Pinned as a property of the source, because the constant is `false` today and no runtime
  // test can exercise the other branch without mutating the module.
  const src = code('src/lib/autocart-beta.ts');
  assert.match(src, /if \(RC_HOLD_BETA_OPEN\) return true;/,
    'reopening must short-circuit before the list is consulted');
  assert.equal(typeof RC_HOLD_BETA_OPEN, 'boolean');
});

// ── the wiring, which is the part that can be inert ─────────────────────────────────

const OK: HoldOfferFacts = {
  hasUnit: true, entitled: true, botOk: true, roomToHold: true, portalOk: true,
  betaAllowed: true,
};

test('holdOfferDecision actually CONSULTS betaAllowed', () => {
  assert.deepEqual(holdOfferDecision(OK), { mayOffer: true, blockedBy: null });
  assert.deepEqual(holdOfferDecision({ ...OK, betaAllowed: false }),
    { mayOffer: false, blockedBy: 'beta-restricted' });
});

test('entitlement is reported ahead of the beta, and is NOT narrowed by it', () => {
  // Somebody who never had the plan must read as `not-entitled`. Reporting "the beta is
  // closed" to them describes a door they were never at — and the blocker is what gets
  // logged, so a wrong one sends a human to change the wrong thing.
  assert.equal(holdOfferDecision({ ...OK, entitled: false, betaAllowed: false }).blockedBy,
    'not-entitled');
  // And the converse, which is the whole design: a PAYING subscriber is still entitled.
  // Three people pay for this plan; collapsing the two facts would make them read as base
  // tier in the five other places that consult the same entitlement.
  assert.equal(holdOfferDecision({ ...OK, entitled: true, betaAllowed: false }).blockedBy,
    'beta-restricted');
});

test('the poller computes it AND feeds it to the decision', () => {
  // TWO ASSERTIONS BECAUSE NEITHER CATCHES THE OTHER'S MUTATION. Computing the fact and
  // never passing it leaves the poller offering holds to everyone; passing a hard-coded
  // `true` leaves the same hole with the call site looking right.
  const poller = code('worker/poller.ts');
  assert.match(poller, /const betaAllowed = rcHoldBetaAllows\(w\.user_id\)/,
    'the poller must ask the real function about the real watch owner');
  assert.match(poller, /holdOfferDecision\(\{[\s\S]{0,300}betaAllowed,/,
    'betaAllowed must be one of the facts holdOfferDecision judges');
});

test('/new stops promising AND stops selling the hold while the beta is closed', () => {
  // BOTH PANELS, and the upsell is the one that matters more: it does not merely describe
  // the feature, it links to /pricing and asks for money for it.
  const nw = code('src/components/v2/NewWatch.tsx');
  assert.match(nw, /const canRcHold = RC_HOLD_BETA_OPEN &&/,
    'the source gate must be ANDed with the beta flag, not replaced by it');
  const gates = [...nw.matchAll(/\{canRcHold &&/g)];
  assert.equal(gates.length, 2,
    `both RC panels must hang off canRcHold — found ${gates.length}`);
});
