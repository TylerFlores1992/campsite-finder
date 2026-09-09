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
import { join } from 'node:path';
import { query, mutate } from './db/client';
import { setUserPhone, clearUserPhone } from './sms-consent';

// NOT a `user_` id. Every dashboard and the funnel readout scope real accounts with
// `LIKE 'user\_%'`, so this fixture cannot reach a count, a rate or a revenue figure.
const FIXTURE = '__smsconsent-test__';

const read = () =>
  readFileSync(join(import.meta.dirname, '../app/api/user/phone/route.ts'), 'utf8');
/** Comments stripped — every string asserted below also appears in the note explaining it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

async function reset() {
  await mutate('DELETE FROM users WHERE id = $1', [FIXTURE]);
  await mutate('INSERT INTO users (id, email) VALUES ($1, $2)', [FIXTURE, `${FIXTURE}@example.invalid`]);
}
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
