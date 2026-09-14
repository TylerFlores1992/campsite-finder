/**
 * GUARDS FOR `scripts/app-review-precheck.mts`.
 *
 * The check exists because two of the four App Store rejections were the same class —
 * something true of the artefact and false of what the reviewer was handed. Its own first
 * version then made that mistake about itself: it hardcoded a Clerk id belonging to the
 * SANDBOX test account, called it the demo account, and reported CLEAN over a Sign-In
 * account carrying a live grandfathered Stripe subscription.
 *
 * THESE ARE STRUCTURAL BECAUSE THE BEHAVIOUR CANNOT BE ASSERTED. "The demo account is
 * clean" is a statement about production data that is legitimately false whenever anyone
 * is mid-test, so a behavioural test of it would fail for a non-defect and be deleted by
 * the next person it inconvenienced — taking these with it.
 *
 * COMMENTS ARE STRIPPED before matching. The script's own header quotes the id it must not
 * use as a subject, in order to explain why; a guard that failed on its own explanation
 * gets "fixed" by deleting the explanation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RAW = readFileSync(new URL('../../scripts/app-review-precheck.mts', import.meta.url), 'utf8');
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('it asks hasActiveSubscription rather than re-implementing the rule', () => {
  assert.match(CODE, /import \{ hasActiveSubscription \} from '@\/lib\/auth'/,
    'the entitlement rule has ONE definition');
  assert.match(CODE, /await hasActiveSubscription\(/,
    'importing it is not calling it — the import alone is the fix-present-and-inert shape');

  // AND THE VERDICT MUST BE THAT CALL'S ANSWER. is_beta short-circuits
  // hasActiveSubscription BEFORE any subscription row is read, so branching on a local
  // `status === 'active' || 'trialing'` reads as equivalent and reports a beta tester as
  // CLEAN — the exact account that sees no paywall with an empty table.
  //
  // THE FIRST VERSION OF THIS BANNED THAT EXPRESSION OUTRIGHT AND FAILED AT BASELINE. The
  // script uses it to pick which rows to DESCRIBE in the failure message, after the verdict
  // is already decided, which is fine. A guard written from the shape of the bug can be
  // wrong about the rule — so pin where the decision comes from, not a string.
  assert.match(CODE, /const subscribed = await hasActiveSubscription\(/,
    'the verdict must BE the shared rule\'s answer');
  assert.match(CODE, /if \(!subscribed\)/,
    'and the clean branch must key on it, or the call is computed and ignored');
});

test('the subject is an EMAIL from the console, never a hardcoded Clerk id', () => {
  assert.match(CODE, /process\.argv\[2\]/, 'it must take the account to check as an argument');
  assert.doesNotMatch(CODE, /user_[A-Za-z0-9]{8}/,
    'a hardcoded Clerk id is what pointed the first version at the wrong account');
  assert.match(CODE, /WHERE email = \$1/, 'the lookup is by email');
});

test('an account that does not exist is a REFUSAL, not a pass', () => {
  // "No such account" and "clean" are opposite readings: the first means the reviewer
  // cannot sign in at all. Rounding an absent reading to the reassuring verdict is this
  // repo's most-repeated failure.
  const refusal = CODE.indexOf('users.length !== 1');
  assert.ok(refusal > -1, 'anchors moved — this guard is measuring nothing');
  const tail = CODE.slice(refusal, refusal + 400);
  assert.match(tail, /process\.exit\(1\)/, 'a missing account must exit non-zero');
});

test('it prints the Clerk id, which is the only thing that can be compared to the allowlist', () => {
  // Through review REVENUECAT_SANDBOX_USER_IDS must hold the SIGN-IN account's id, and
  // nothing in a session can read that Vercel value — so the script has to emit the id
  // for a human to compare. Without it the check answers half the question.
  assert.match(CODE, /clerk id/i, 'the id must be in the output');
  assert.match(CODE, /REVENUECAT_SANDBOX_USER_IDS/,
    'and it must say what the id is for, or nobody makes the comparison');
});
