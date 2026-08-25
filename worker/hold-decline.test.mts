/**
 * "No thanks" — declining an offer, and what the Holds panel puts at the top.
 *
 * TWO ASKS FROM ONE SCREENSHOT. The owner reported that "Open the hand-off again" — a
 * finished hand-off — sat above "Hold it for me", the card with a deadline on it, and that
 * there was no way to dismiss an offer at all.
 *
 * The dismissal is the consequential half and is tested against the REAL DB, because the
 * whole decision is one `UPDATE .. WHERE status = 'offered'` and the property that matters
 * is what it REFUSES. A mock would test a copy of that predicate. The ordering is a pure
 * module for the opposite reason: a structural guard reading a component's source can only
 * assert that some text is present, which this project has watched go vacuous 23 times.
 *
 * FIXTURE SAFETY: non-numeric `__t` unit ids, so the production hold runner cannot cart one
 * even if a run dies mid-test; watches dated 2020 so the poller cannot see them; users
 * created here rather than borrowed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { declineHold, holdWindowLoad } from '../src/lib/rc-holds';
import { rankHoldLine } from './hold-line';
import { isFinishedHandoff, byUrgency, FINISHED_AFTER_MS } from '../src/lib/hold-ordering';

/**
 * A sentinel unit id, NAMESPACED TO THIS SUITE.
 *
 * Non-numeric so the production hold runner can never cart one — the 2026-08-15 rule. The
 * `dc` segment is the part this file added: `npm test` runs suites CONCURRENTLY, and the
 * global `LIKE '__t%'` sweep several of them use deletes EVERY suite's fixtures, not its
 * own. Three files already shared that blast radius; adding more made a sibling's rows
 * vanish mid-run and failed an unrelated assertion in a way that reads exactly like a
 * regression. This suite sweeps only what it created.
 */
const U = (n: string) => `__tdc${n}`;
const A = 'test-decline-user-a';
const B = 'test-decline-user-b';
const WA = 'test-decline-watch-a';
const WB = 'test-decline-watch-b';
const RELEASE = '2030-07-01T08:00:00';
let campgroundId = '';

async function sweep() {
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_tdc%'`, []);
  await mutate(`DELETE FROM watches WHERE id = ANY($1::text[])`, [[WA, WB]]);
  await mutate(`DELETE FROM users WHERE id = ANY($1::text[])`, [[A, B]]);
}

before(async () => {
  await sweep();
  [{ id: campgroundId }] = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`, []);
  await mutate(`INSERT INTO users (id, email) VALUES ($1,$2),($3,$4)`,
    [A, 'decline-a@camphawk.invalid', B, 'decline-b@camphawk.invalid']);
  await mutate(
    `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, active, created_at)
     VALUES ($1,$2,$5,'2020-01-01','2020-01-03',true,'2020-01-01T00:00:00Z'),
            ($3,$4,$5,'2020-01-01','2020-01-03',true,'2020-06-01T00:00:00Z')`,
    [WA, A, WB, B, campgroundId]);
});

after(sweep);

async function offer(watchId: string, userId: string, unit: string, status = 'offered') {
  const [r] = await mutate<{ id: string }>(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, arrival_date, nights, release_at, status)
     VALUES ($1,$2,$3,$4,'2030-07-05',1,$5,$6) RETURNING id`,
    [watchId, userId, campgroundId, unit, RELEASE, status]);
  return r.id;
}

const statusOf = async (id: string) =>
  (await query<{ status: string; note: string | null }>(
    `SELECT status, last_attempt_note AS note FROM rc_hold_requests WHERE id = $1`, [id]))[0];

// ------------------------------------------------------------------ declining

test('declining an offer retracts it, and says that is what happened', async () => {
  const id = await offer(WA, A, U('8001'));
  assert.equal(await declineHold(id), true);
  const row = await statusOf(id);
  assert.equal(row.status, 'expired');
  assert.match(String(row.note), /declined by the user/,
    'a decline and a lapse are different events; the readout must be able to tell them apart');
});

test('and it frees the capacity seat, which is why hiding the card was never enough', async () => {
  const keep = await offer(WA, A, U('8002'));
  const drop = await offer(WB, B, U('8003'));
  const before = await holdWindowLoad(RELEASE);
  assert.equal(await declineHold(drop), true);
  assert.equal(await holdWindowLoad(RELEASE), before - 1,
    'an offered row occupies a capacity seat — the button is in an email we cannot retract');
  assert.equal((await statusOf(keep)).status, 'offered', 'and it frees only its own');
});

test('declining moves the next person UP the line', async () => {
  // The two halves of this session meeting: the fairness line orders live holds, so a
  // decline is the one dismissal that genuinely changes somebody else's morning.
  const first = await offer(WA, A, U('8004'));
  const second = await offer(WB, B, U('8004'));
  const line = await rankHoldLine(RELEASE, U('8004'));
  assert.equal(line[0].id, first, 'the earlier watch starts first in line');

  assert.equal(await declineHold(first), true);
  const after = await rankHoldLine(RELEASE, U('8004'));
  assert.equal(after.length, 1, 'a declined hold leaves the line entirely');
  assert.equal(after[0].id, second);
  assert.equal(after[0].rank, 1, 'and the person behind moves up');
});

test('a hold the bot is about to cart CANNOT be declined by this control', async () => {
  // `requested` is a commitment the bot is going to honour. Retracting it is a cancel —
  // a different act, with a different confirmation, and getting it wrong at 07:59 loses a
  // campsite. The X on an offer must never quietly become that.
  const id = await offer(WA, A, U('8005'), 'requested');
  assert.equal(await declineHold(id), false, 'refused');
  assert.equal((await statusOf(id)).status, 'requested', 'and the row is untouched');
});

test('a hold that IS a real campsite in a real cart cannot be declined either', async () => {
  // THE 2026-08-13 LEAK WITH A BUTTON ON IT. Marking a carted row terminal does not
  // release the cart — it takes the site off the market for every other camper and deletes
  // the last thing on screen still pointing at it.
  for (const st of ['carted', 'claiming', 'released', 'claimed', 'expired']) {
    const id = await offer(WA, A, U(`80${st.length}${st.slice(0, 2)}`), st);
    assert.equal(await declineHold(id), false, `${st} must not be declinable`);
    assert.equal((await statusOf(id)).status, st, `${st} row was mutated`);
  }
});

// ------------------------------------------------------------------ what goes on top

const hold = (status: string, releaseAt = '2030-01-01T08:00:00', updatedAt: string | null = null) =>
  ({ status, releaseAt, updatedAt });

test('a live offer outranks a finished hand-off — the reported bug, inverted', () => {
  // The API orders by release_at, so a hand-off from an EARLIER release always won. That
  // put "Open the hand-off again" above "Hold it for me" for ever.
  const rows = [
    hold('released', '2020-01-01T08:00:00'),
    hold('offered', '2030-01-01T08:00:00'),
  ].sort(byUrgency);
  assert.deepEqual(rows.map((r) => r.status), ['released', 'offered'],
    'a fresh hand-off is still the most actionable thing on the page');

  const withCart = [
    hold('released', '2020-01-01T08:00:00'),
    hold('offered', '2030-01-01T08:00:00'),
    hold('carted', '2031-01-01T08:00:00'),
  ].sort(byUrgency);
  assert.equal(withCart[0].status, 'carted',
    'a real campsite in a real cart with fifteen minutes on it goes first, whatever its release');
  assert.equal(withCart.at(-1)!.status, 'offered');
});

test('nothing to do until 08:00 sorts last, so urgency keeps meaning something', () => {
  const rows = [hold('requested'), hold('offered'), hold('claiming')].sort(byUrgency);
  assert.deepEqual(rows.map((r) => r.status), ['claiming', 'offered', 'requested']);
});

test('an unknown status sorts LAST, rather than being promoted above a cart', () => {
  const rows = [hold('something-new'), hold('carted')].sort(byUrgency);
  assert.equal(rows[0].status, 'carted');
});

test('a hand-off is only "finished" after an hour, and never before', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.equal(isFinishedHandoff(hold('released', '2030-01-01', at(5 * 60_000)), now), false,
    'a hand-off five minutes old is a campsite waiting to be booked');
  assert.equal(isFinishedHandoff(hold('released', '2030-01-01', at(FINISHED_AFTER_MS + 1)), now), true);
});

test('only a RELEASED hold is ever filed away', () => {
  const now = Date.now();
  const ancient = new Date(now - 30 * 24 * 3600_000).toISOString();
  for (const st of ['carted', 'claiming', 'offered', 'requested']) {
    assert.equal(isFinishedHandoff(hold(st, '2030-01-01', ancient), now), false,
      `${st} was collapsed out of sight — hiding it does not release it`);
  }
});

test('an unknown age counts as FRESH, never as stale', () => {
  // Same rule as `unknown` never rounding to "not subscribed": hiding a row that may still
  // matter costs a campsite, showing one an hour too long costs some space.
  assert.equal(isFinishedHandoff(hold('released', '2030-01-01', null)), false);
  assert.equal(isFinishedHandoff(hold('released', '2030-01-01', 'not a date')), false);
});
