/**
 * THE TAP DOES NOT RE-RANK THE LINE — a real gap, not yet built when this file was added.
 *
 * `rankHoldLine` only writes "another watcher is ahead of you" onto a row already
 * `requested`. The poller re-ranks every pass through its "held" branch, but that branch
 * stops the instant the release passes — the site is no longer locked by then — and a tap
 * lands closest to the release, which is exactly when a poller pass may never run again
 * before the cart. On 2026-08-25 the runner-up tapped fourteen seconds after the last
 * poller rank pass and never got a note at all: `hold-line.test.mts`'s own header records
 * that a genuine contest then reads as two clean carts in the readout.
 *
 * THE FIX is in `src/lib/notifications/actions.ts`'s `hold` case: re-rank the line the
 * instant `requestHold` succeeds, rather than waiting for the next poller pass that may
 * never come. This file tests that call site directly, through `performAction`, because a
 * test of `rankHoldLine` alone (as `hold-line.test.mts` already has, extensively) cannot
 * see whether anything actually calls it after a tap — the same "absence is the bug" shape
 * `hold-offer-gate.test.mts` was built for.
 *
 * REAL DB ON PURPOSE, same reasoning as `hold-line.test.mts`: the ranking is a join across
 * three tables and `performAction` is the real production entry point a tap hits.
 *
 * FIXTURE SAFETY. Non-numeric `__t`-prefixed unit ids (2026-08-15 rule — the production
 * hold runner cannot cart one). Watches dated 2020 so the poller's `end_date > CURRENT_DATE`
 * filter never sees them. Own sentinel prefix (`__ttap`) and own user/watch ids, so this
 * suite sweeps only what it created — `npm test` runs files concurrently and a shared
 * `LIKE '__t%'` sweep deletes a sibling suite's live rows mid-run (issue #76).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, mutate } from '../src/lib/db/client';
import { rankHoldLine } from './hold-line';
import { mintActionToken, performAction } from '../src/lib/notifications/actions';

const U = (n: string) => `__ttap${n}`;
const EARLY = 'test-hold-tap-user-early';
const LATE = 'test-hold-tap-user-late';
const W_EARLY = 'test-hold-tap-watch-early';
const W_LATE = 'test-hold-tap-watch-late';
/** Far enough out that nothing else treats this as a real release. */
const RELEASE = '2030-06-01T08:00:00';

let campgroundId = '';

async function sweep() {
  await mutate(`DELETE FROM action_tokens WHERE watch_id = ANY($1::text[])`, [[W_EARLY, W_LATE]]);
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_ttap%'`, []);
  await mutate(`DELETE FROM watches WHERE id = ANY($1::text[])`, [[W_EARLY, W_LATE]]);
  await mutate(`DELETE FROM users WHERE id = ANY($1::text[])`, [[EARLY, LATE]]);
}

before(async () => {
  await sweep();
  [{ id: campgroundId }] = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`, []);
  // is_beta gives both users the entitlement `performAction`'s hold case requires, without
  // dragging Stripe subscription fixtures into a test about ranking.
  await mutate(
    `INSERT INTO users (id, email, is_beta) VALUES ($1, $2, true), ($3, $4, true)`,
    [EARLY, 'hold-tap-early@camphawk.invalid', LATE, 'hold-tap-late@camphawk.invalid'],
  );
  await mutate(
    `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, active, created_at)
     VALUES ($1, $2, $5, '2020-01-01', '2020-01-03', true, '2020-01-01T00:00:00Z'),
            ($3, $4, $5, '2020-01-01', '2020-01-03', true, '2020-06-01T00:00:00Z')`,
    [W_EARLY, EARLY, W_LATE, LATE, campgroundId],
  );
});

after(sweep);

async function offer(watchId: string, userId: string, unit: string) {
  const [r] = await mutate<{ id: string }>(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, arrival_date, nights, release_at, status)
     VALUES ($1, $2, $3, $4, '2030-06-05', 1, $5, 'offered') RETURNING id`,
    [watchId, userId, campgroundId, unit, RELEASE],
  );
  return r.id;
}

const holdRow = async (id: string) =>
  (await query<{ status: string; note: string | null }>(
    `SELECT status, last_attempt_note AS note FROM rc_hold_requests WHERE id = $1`, [id]))[0];

test('TAPPING THE RUNNER-UP RE-RANKS THE LINE RIGHT THEN — the note lands without waiting for the poller', async () => {
  await offer(W_EARLY, EARLY, U('1'));
  const behindId = await offer(W_LATE, LATE, U('1'));

  // The line is ranked ONCE, while both rows are still `offered` — the state a real
  // contest is in right after the coming-soon alert goes out. `noteAttempt` only touches
  // `requested` rows, so nothing is written to either row yet. This is the state on
  // 2026-08-25 right before the runner-up tapped.
  await rankHoldLine(RELEASE, U('1'));
  assert.equal((await holdRow(behindId)).note, null,
    'an offered row must carry no note yet — nothing has asked for it');

  // THE TAP. No further call to `rankHoldLine` is made from this test — if the fix in
  // `actions.ts` were removed, `performAction` would flip the row to `requested` and stop,
  // exactly as it did before the fix, and the assertions below would fail.
  const token = await mintActionToken(W_LATE, 'hold', U('1'));
  assert.ok(token, 'could not mint a hold token for the fixture');
  const result = await performAction(token!);
  assert.equal(result.ok, true, `tap failed: ${result.message}`);

  const row = await holdRow(behindId);
  assert.equal(row.status, 'requested', 'the tap must still flip the row — ranking must not replace it');
  assert.match(String(row.note), /ahead of you in line/,
    'the runner-up\'s note must be written by the TAP itself, not left for a poller pass ' +
    'that may never run again before the release');
});

test('TAPPING THE ONLY OFFER RE-RANKS TOO, AND ROTATES NOBODY — an uncontested tap must not misfire', async () => {
  const soloId = await offer(W_EARLY, EARLY, U('2'));
  const before = (
    await query<{ s: string | null }>(`SELECT hold_offer_seq AS s FROM users WHERE id = $1`, [EARLY])
  )[0].s;

  const token = await mintActionToken(W_EARLY, 'hold', U('2'));
  const result = await performAction(token!);
  assert.equal(result.ok, true, `tap failed: ${result.message}`);

  const row = await holdRow(soloId);
  assert.equal(row.status, 'requested');
  assert.equal(row.note, null, 'a solo tap is not a contest — nobody is "ahead" of a line of one');
  const afterSeq = (
    await query<{ s: string | null }>(`SELECT hold_offer_seq AS s FROM users WHERE id = $1`, [EARLY])
  )[0].s;
  assert.equal(afterSeq, before, 'an uncontested tap must not spend the rotation ticket either');
});

// ---------------------------------------------------------------- the call site itself

const actionsSrc = readFileSync('src/lib/notifications/actions.ts', 'utf8');
/** Source with comment lines stripped, so a comment describing the call cannot itself
 *  satisfy an assertion about the call — the same discipline `hold-offer-gate.test.mts` and
 *  the twenty-plus prior "a guard passed vacuously" entries in CLAUDE.md were built for. */
const code = actionsSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the hold case calls rankHoldLine, and it is reachable ONLY after a successful tap', () => {
  const holdCase = code.match(/case 'hold': \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
  assert.ok(holdCase, 'could not locate the hold case in actions.ts');
  assert.match(holdCase, /rankHoldLine\(req\.release_at, String\(req\.unit_id\)\)/,
    'the hold case must re-rank the line for the tapped (release_at, unit_id)');

  const reqNull = holdCase.indexOf('if (!req) {');
  const rankCall = holdCase.indexOf('rankHoldLine(');
  assert.ok(reqNull !== -1 && rankCall !== -1);
  assert.ok(reqNull < rankCall,
    'rankHoldLine must run AFTER the null-request guard — ranking on a tap that failed to ' +
    'match a row would rank a line the tap never touched');
});

test('the re-rank is awaited, not fire-and-forget', () => {
  // A serverless function can be frozen the instant its response is sent. An unawaited
  // background call here is not guaranteed to run at all, which is worse than the bug this
  // file exists to fix: a note that is sometimes written looks identical, from the readout,
  // to one written every time — until the one morning it silently was not.
  const holdCase = code.match(/case 'hold': \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
  assert.match(holdCase, /await rankHoldLine\(/, 'the call must be awaited');
});
