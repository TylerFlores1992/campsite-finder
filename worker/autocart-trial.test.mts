/**
 * Guards for the comped, self-expiring auto-cart grant (migration 077).
 *
 * REAL DB, because the whole mechanism is one `> NOW()` inside three SQL predicates and a
 * test asserting against a copy of them would assert the copy.
 *
 * UNDER `worker/` DELIBERATELY, unlike the other guards added this session. The predicate
 * lives in `worker/poller.ts` as well as in `src/lib`, so this genuinely is worker code and
 * a change here SHOULD fire a worker deploy — the poller is one of the three readers, and
 * shipping the web half without it is the deploy-by-different-routes trap that opened the
 * T−30 alarm hole.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, mutate } from '../src/lib/db/client';
import { hasAutocartEntitlement, hasActiveSubscription } from '../src/lib/auth';

const U = '__tact-trial-user';
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

before(async () => {
  await mutate(`DELETE FROM users WHERE id = $1`, [U]).catch(() => {});
  await mutate(
    `INSERT INTO users (id, email, is_beta) VALUES ($1, $2, false)`,
    [U, `${U}@example.invalid`],
  );
});

after(async () => {
  await mutate(`DELETE FROM users WHERE id = $1`, [U]).catch(() => {});
});

const setGrant = (v: string | null) =>
  mutate(`UPDATE users SET autocart_trial_until = $1::timestamptz WHERE id = $2`, [v, U]);

test('no grant, no subscription, not beta — not entitled', async () => {
  await setGrant(null);
  assert.equal(await hasAutocartEntitlement(U), false);
});

test('a future grant entitles; a past one does not', async () => {
  // THE ENTIRE MECHANISM. `> NOW()` is what makes "put them back on alerts when the week is
  // up" arithmetic rather than a cron job somebody has to remember to write.
  await setGrant(new Date(Date.now() + 86_400_000).toISOString());
  assert.equal(await hasAutocartEntitlement(U), true, 'a live grant must entitle');

  await setGrant(new Date(Date.now() - 1000).toISOString());
  assert.equal(await hasAutocartEntitlement(U), false, 'an expired grant must NOT entitle');
});

test('it expires by itself, with nothing to run', async () => {
  // A grant one second out is entitled, and the same row is not entitled two seconds later
  // with no statement in between. That is the property; if it ever needs a sweep to be
  // correct, the sweep is a thing that can fail to run.
  await setGrant(new Date(Date.now() + 1200).toISOString());
  assert.equal(await hasAutocartEntitlement(U), true);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(await hasAutocartEntitlement(U), false, 'it needed a sweep — the design is wrong');
});

test('the grant does NOT grant a subscription', async () => {
  // It is a demonstration, not a free plan: someone comped the auto-cart lane still cannot
  // create watches. Collapsing the two would hand out the paid product by accident.
  await setGrant(new Date(Date.now() + 86_400_000).toISOString());
  assert.equal(await hasAutocartEntitlement(U), true);
  assert.equal(await hasActiveSubscription(U), false, 'the comp leaked into the watch gate');
});

test('NULL is the ordinary state and never entitles', async () => {
  await setGrant(null);
  const [row] = await query<{ v: string | null }>(
    `SELECT autocart_trial_until::text v FROM users WHERE id = $1`, [U]);
  assert.equal(row.v, null);
  assert.equal(await hasAutocartEntitlement(U), false);
});

// ── all THREE copies of the predicate read it ────────────────────────────────────────────

test('the poller and the admin query read the grant too', () => {
  // `hasAutocartEntitlement` is the definition, and the poller and the admin list each carry
  // their own SQL copy because a function cannot be imported into one statement. A grant the
  // poller cannot see is the fix-present-and-inert shape at its worst: the settings screen
  // says entitled, the toggle turns on, and the lane never runs — which is a promise we
  // break at 08:00 rather than a bug somebody notices.
  for (const f of ['worker/poller.ts', 'src/app/admin/users/queries.ts', 'src/lib/auth.ts']) {
    assert.match(
      read(f).replace(/^\s*--.*$/gm, ''),
      /autocart_trial_until > NOW\(\)/,
      `${f} carries a copy of the entitlement predicate and does not read the grant`,
    );
  }
});

test('no SQL comment in the predicate files carries a backtick', () => {
  // These queries are template literals: one backtick in a comment terminates the string and
  // the parse error surfaces somewhere unrelated. CLAUDE.md records it costing a build twice;
  // adding this column cost it a third time, inside the comment explaining the column.
  for (const f of ['worker/poller.ts', 'src/lib/auth.ts']) {
    const bad = read(f)
      .split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /^\s*--/.test(l) && l.includes('`'));
    assert.deepEqual(bad, [], `${f} has a backtick inside a SQL comment`);
  }
});

test('nothing about the grant touches Stripe or billing', () => {
  // What makes it safe to hand out and safe to revoke. If this ever writes a tier or a
  // subscription row, revoking stops being one harmless statement.
  const src = read('scripts/grant-autocart-trial.mts');
  assert.ok(!/subscriptions|stripe|tier|is_beta\s*=/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the grant script reaches into billing');
  assert.match(src, /autocart_trial_until = NULL/, 'there is no way to revoke it');
});

test('the grant script takes a DATE, never a number of days', () => {
  // A 7-day comp granted 2026-09-15 expires on the 22nd; the trip it was bought for was the
  // 24th to the 27th. A duration hides that arithmetic, a date makes the caller look at a
  // calendar. This is the first thing a later "improvement" would undo.
  const src = read('scripts/grant-autocart-trial.mts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /--until/, 'the date flag is gone');
  assert.ok(!/--days|addDays|\* 7 \*/.test(src), 'a duration interface has crept in');
});

test('the script warns when rec.gov is not linked', () => {
  // Granting the lane to an account that has not connected rec.gov gives them a switch that
  // does nothing, and only they can fix that. Reporting a bare "granted" would be a success
  // that has not happened yet.
  const src = read('scripts/grant-autocart-trial.mts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /if \(!user\.autocart_connected\)/);
  assert.match(src, /HAS NOT LINKED RECREATION\.GOV/);
});
