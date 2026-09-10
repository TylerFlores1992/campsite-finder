// SMS CONSENT IS RECORDED BY THE WRITE THAT CAPTURES IT.
//
// THE DEFECT (measured against production, 2026-09-09). Migration 034 added
// `users.sms_consent_at` so A2P 10DLC consent could be evidenced per subscriber, backfilled
// every account that already held a number on 2026-08-01, and then NOTHING EVER WROTE THE
// COLUMN AGAIN. Seventeen accounts held a phone; ten had no consent row; all ten were created
// after the backfill; all ten were being sent SMS. The evidence existed for the accounts that
// predated it and for nobody since.
//
// REAL DB ON PURPOSE. The whole behaviour is two SQL statements — a COALESCE that must not
// restamp and a clear that must reset. A test written against a copy of those statements would
// assert the copy, which is the reason `applyMutes` was extracted for its own guard.
//
// AND THE CALLER IS PINNED SEPARATELY. The module can be perfect while the route goes back to
// its own inline UPDATE, which is the fix-present-and-inert shape this repo has recorded five
// times. Both halves or neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { query, mutate } from './db/client';
import { setUserPhone, clearUserPhone } from './sms-consent';

// NOT a `user_` id. Every dashboard and the funnel readout scope real accounts with
// `LIKE 'user\_%'`, so this fixture cannot reach a count, a rate or a revenue figure.
//
// PER-RUN, NOT A FIXED SENTINEL, and that distinction is the one #203 left open. That PR gave
// the hold suites a per-SUITE prefix plus a ten-minute age gate, which stops one suite wiping
// another — and CLAUDE.md records in as many words that it does NOT cover "a suite with a
// single FIXED sentinel deleted by exact id", which is "mutually destructive between two runs
// of ITSELF".
//
// CORRECTED 2026-09-09, an hour after this was written. The first version said two CI runs per
// push make that the ORDINARY case. IT DOES NOT: `verify.yml` has carried a concurrency group
// keyed on the bare branch name with `cancel-in-progress` since 2026-08-15, added after PR #44
// measured exactly this — two runs 18s apart, one failing in `ridb-photos.test.mts` on a row
// the sibling was writing. The `push` and `pull_request` runs collide for seconds and then one
// is cancelled. Recorded rather than quietly rewritten, because a fix resting on a false
// premise is how the premise survives.
//
// THE REAL EXPOSURE IS TWO OTHER THINGS, AND BOTH ARE DOCUMENTED AS HAVING HAPPENED:
//   1. A local `npm run verify` while CI runs. CLAUDE.md records it TWICE on 2026-08-28, both
//      times by the person enforcing the rule against it — once while idling waiting on that
//      very CI run. LANES.md's SERIAL rule is the only guard, and it is a habit.
//   2. A branch run overlapping a MASTER run. Different branch names are different concurrency
//      groups, so nothing cancels either: "merging IS starting a test run".
//
// Under either, run B's DELETE lands between run A's write and its read, and A fails asserting
// a consent date B removed. `email` is UNIQUE too, so the INSERT collides outright. MEASURED
// rather than argued: two concurrent runs of the pre-fix version failed 2 of 5 each, on exactly
// those assertions; two of the fixed version pass 5/5.
//
// A per-run suffix removes the shared row entirely. The prefix stays so the sweep below can
// find strays, and so nothing else can mistake these for real accounts.
const PREFIX = '__smsconsent-';
const FIXTURE = `${PREFIX}${randomUUID().slice(0, 8)}`;

const read = () =>
  readFileSync(join(import.meta.dirname, '../app/api/user/phone/route.ts'), 'utf8');
/** Comments stripped — every string asserted below also appears in the note explaining it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/**
 * Strays from a run that was killed before its `after()` — GitHub cancels the older run on a
 * second push, and a cancelled run cleans up nothing.
 *
 * TEN MINUTES, matching #203, and the gate is the whole point: a CONCURRENT run's rows are
 * seconds old and must survive, or this becomes the very cross-run destruction it exists to
 * prevent. Only rows old enough that no live run could own them are swept.
 */
async function sweepStrays() {
  await mutate(
    `DELETE FROM users
      WHERE id LIKE $1 AND created_at < NOW() - interval '10 minutes'`,
    [`${PREFIX}%`]
  );
}

async function reset() {
  await mutate('DELETE FROM users WHERE id = $1', [FIXTURE]);
  await mutate('INSERT INTO users (id, email) VALUES ($1, $2)', [FIXTURE, `${FIXTURE}@example.invalid`]);
}

test.before(sweepStrays);
const consentOf = async () => {
  const r = await query<{ phone: string | null; sms_consent_at: string | null }>(
    'SELECT phone, sms_consent_at::text AS sms_consent_at FROM users WHERE id = $1',
    [FIXTURE]
  );
  return r[0]!;
};

test('saving a number for the first time records consent', async () => {
  await reset();
  assert.equal((await consentOf()).sms_consent_at, null, 'fixture should start with no consent');

  await setUserPhone(FIXTURE, '+15095551234');

  const row = await consentOf();
  assert.equal(row.phone, '+15095551234');
  assert.ok(row.sms_consent_at, 'consent must be stamped by the write that captured the number');
});

test('changing the number does NOT restamp the consent date', async () => {
  await reset();
  await setUserPhone(FIXTURE, '+15095551234');
  const first = (await consentOf()).sms_consent_at;
  assert.ok(first);

  await setUserPhone(FIXTURE, '+15095559999');

  const after = await consentOf();
  assert.equal(after.phone, '+15095559999', 'the number itself must change');
  assert.equal(
    after.sms_consent_at,
    first,
    'the evidence is when they first agreed — a number change is not a new consent event'
  );
});

test('removing the number clears the consent', async () => {
  await reset();
  await setUserPhone(FIXTURE, '+15095551234');
  assert.ok((await consentOf()).sms_consent_at);

  await clearUserPhone(FIXTURE);

  const row = await consentOf();
  assert.equal(row.phone, null);
  assert.equal(row.sms_consent_at, null, 'removing the number IS the withdrawal');
});

test('re-adding after a removal stamps FRESH, never the old date', async () => {
  await reset();
  await setUserPhone(FIXTURE, '+15095551234');
  const original = (await consentOf()).sms_consent_at;
  assert.ok(original);

  await clearUserPhone(FIXTURE);
  await setUserPhone(FIXTURE, '+15095551234');

  const again = (await consentOf()).sms_consent_at;
  assert.ok(again, 'a re-add must record consent');
  assert.notEqual(
    again,
    original,
    'inheriting a date from a period the subscriber had opted out of would overstate the evidence'
  );
});

test('the phone route calls the module rather than writing its own UPDATE', () => {
  const src = code(read());
  assert.match(src, /setUserPhone\(userId, normalized\)/, 'the save path must go through the module');
  assert.match(src, /clearUserPhone\(userId\)/, 'the remove path must go through the module');
  assert.doesNotMatch(
    src,
    /UPDATE users SET phone/,
    'an inline UPDATE here is the write that silently stopped recording consent'
  );
});

test.after(async () => {
  await mutate('DELETE FROM users WHERE id = $1', [FIXTURE]);
});
