/**
 * TWO PEOPLE, ONE CAMPSITE — the guard over the fairness line.
 *
 * THE MEASURED CASE, reproduced here. On 2026-08-24 unit 43191 ("#96", Morro Bay, arrival
 * 2026-09-04, releasing 08-25 08:00 PT) was offered to melinda.flores0501 through "Morro
 * Lottery sites" and to tylerflores1992 through "Upper Section". RC lists one physical
 * campsite under more than one facility, so both offers were correct and there was still
 * only one campsite. The LATER watcher is the one who tapped, and nothing in the system
 * had an opinion about that.
 *
 * REAL DB ON PURPOSE. The ranking is a join across three tables and the de-dupe is a
 * `DISTINCT ON` inside `dueHolds`; a mock would test a copy of the SQL rather than the
 * SQL. Same reasoning as `claim.test.mts`, `hold-claim.test.mts` and `watch-mutes.test.mts`.
 * The pure ordering rule is tested without a database as well, because that is the part
 * whose edges are easy to get subtly wrong.
 *
 * FIXTURE SAFETY. Unit ids are the non-numeric `__t` sentinel, so the production hold
 * runner cannot cart one even if a run dies mid-test — the rule from 2026-08-15, when an
 * aborted run had the bot trying to cart a real campsite for fifteen minutes. Watches are
 * dated 2020 so the poller's `end_date > CURRENT_DATE` filter can never see them, and the
 * users are created by this test rather than borrowed, so a real account's rotation
 * counter is never touched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { orderLine, isContested, rankHoldLine } from './hold-line';
import { dueHolds } from '../src/lib/rc-holds';

const U = (n: string) => `__t${n}`;
const EARLY = 'test-hold-line-user-early';
const LATE = 'test-hold-line-user-late';
const W_EARLY = 'test-hold-line-watch-early';
const W_LATE = 'test-hold-line-watch-late';
/** Far enough out that `dueHolds` never sees these, except where a test wants it to. */
const RELEASE = '2030-06-01T08:00:00';

/** Pacific wall-clock `release_at`, N minutes from now — the shape `dueHolds` compares. */
function pacific(minutesFromNow: number): string {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

let campgroundId = '';

async function sweep() {
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_t%'`, []);
  await mutate(`DELETE FROM watches WHERE id = ANY($1::text[])`, [[W_EARLY, W_LATE]]);
  await mutate(`DELETE FROM users WHERE id = ANY($1::text[])`, [[EARLY, LATE]]);
}

before(async () => {
  await sweep();
  [{ id: campgroundId }] = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`, []);
  await mutate(
    `INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)`,
    [EARLY, 'hold-line-early@camphawk.invalid', LATE, 'hold-line-late@camphawk.invalid'],
  );
  // The ONE fact the owner's rule turns on: who started watching first.
  await mutate(
    `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, active, created_at)
     VALUES ($1, $2, $5, '2020-01-01', '2020-01-03', true, '2020-01-01T00:00:00Z'),
            ($3, $4, $5, '2020-01-01', '2020-01-03', true, '2020-06-01T00:00:00Z')`,
    [W_EARLY, EARLY, W_LATE, LATE, campgroundId],
  );
});

after(sweep);

async function offer(watchId: string, userId: string, unit: string, releaseAt: string) {
  const [r] = await mutate<{ id: string }>(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, arrival_date, nights, release_at, status)
     VALUES ($1, $2, $3, $4, '2030-06-05', 1, $5, 'offered') RETURNING id`,
    [watchId, userId, campgroundId, unit, releaseAt],
  );
  return r.id;
}

const seqOf = async (userId: string) =>
  (await query<{ s: string | null }>(`SELECT hold_offer_seq AS s FROM users WHERE id = $1`, [userId]))[0].s;

const holdRow = async (id: string) =>
  (await query<{ line_rank: number | null; status: string; note: string | null; upd: string }>(
    `SELECT line_rank, status, last_attempt_note AS note, updated_at::text AS upd
       FROM rc_hold_requests WHERE id = $1`, [id]))[0];

// ---------------------------------------------------------------- the rule, pure

test('never given first dibs outranks anyone who has, however long ago', () => {
  const out = orderLine([
    { id: 'b', userId: 'B', status: 'offered', offerSeq: 1, watchCreatedAt: '2019-01-01' },
    { id: 'a', userId: 'A', status: 'offered', offerSeq: 0, watchCreatedAt: '2025-01-01' },
  ]);
  // A watched three years later and still goes first: otherwise a new watcher starts at
  // the back of a queue that has never served them, which is not a queue.
  assert.deepEqual(out.map((c) => c.id), ['a', 'b']);
});

test('among people who have never had first dibs, earliest watch wins', () => {
  const out = orderLine([
    { id: 'late', userId: 'B', status: 'offered', offerSeq: 0, watchCreatedAt: '2026-08-24T19:45' },
    { id: 'early', userId: 'A', status: 'offered', offerSeq: 0, watchCreatedAt: '2026-08-24T16:53' },
  ]);
  // The measured pair, in the owner's stated order.
  assert.deepEqual(out.map((c) => c.id), ['early', 'late']);
});

test('among people who have, longest-ago wins — that is the rotation', () => {
  const out = orderLine([
    { id: 'recent', userId: 'B', status: 'offered', offerSeq: 9, watchCreatedAt: '2019-01-01' },
    { id: 'ancient', userId: 'A', status: 'offered', offerSeq: 2, watchCreatedAt: '2025-01-01' },
  ]);
  assert.deepEqual(out.map((c) => c.id), ['ancient', 'recent'],
    'the rotation ticket must outrank watch age, or rotation does nothing');
});

test('identical on every field, the order is still deterministic', () => {
  const same = { userId: 'A', status: 'offered', offerSeq: 0, watchCreatedAt: '2026-01-01' };
  assert.deepEqual(orderLine([{ id: 'z', ...same }, { id: 'a', ...same }]).map((c) => c.id), ['a', 'z'],
    'two shards ranking the same line must agree, or the ranks flap every cycle');
});

test('one person holding two offers for one site is NOT a contest', () => {
  // RC lists the same campsite under more than one facility, so a park watcher can hold
  // two correct offers for one site. Counting rows rather than people would rotate them
  // for competing with themselves.
  const mine = { status: 'offered', offerSeq: 0, watchCreatedAt: '2026-01-01' };
  assert.equal(isContested([{ id: 'a', userId: 'A', ...mine }, { id: 'b', userId: 'A', ...mine }]), false);
  assert.equal(isContested([{ id: 'a', userId: 'A', ...mine }, { id: 'b', userId: 'B', ...mine }]), true);
});

// ---------------------------------------------------------------- the line, against the DB

test('the earlier watch is ranked first, and BOTH keep their offer', async () => {
  const a = await offer(W_LATE, LATE, U('9101'), RELEASE);
  const b = await offer(W_EARLY, EARLY, U('9101'), RELEASE);
  const line = await rankHoldLine(RELEASE, U('9101'));

  assert.deepEqual(line.map((m) => m.rank), [1, 2]);
  assert.equal(line[0].id, b, 'the watch created first must be first in line');
  assert.equal((await holdRow(b)).line_rank, 1);
  assert.equal((await holdRow(a)).line_rank, 2);
  // Rule 2: nobody is silently excluded. Both rows are still live offers.
  assert.equal((await holdRow(a)).status, 'offered');
  assert.equal((await holdRow(b)).status, 'offered');
});

test('being FIRST IN LINE spends the rotation ticket — not winning, not merely being offered', async () => {
  assert.notEqual(await seqOf(EARLY), null, 'first in line must rotate even though nothing has been claimed');
  assert.equal(await seqOf(LATE), null, 'second in line keeps their place — that is "everyone else moves up"');
});

test('re-ranking the same contest does not flip it — the charge must not feed back', async () => {
  // THE BUG THIS CAUGHT, and it was a test that caught it rather than a review. Charging
  // the winner raises their live `hold_offer_seq`, so a live read sorts them BELOW the
  // person they just beat on the very next cycle: the ranks flip, the runner-up is charged
  // too, and the "you're first in line" on the offer screen changes under the reader. The
  // poller re-ranks every cycle, so this ran five times a minute in production.
  const firstBefore = await firstIdOf(U('9101'));
  const seqsBefore = [await seqOf(EARLY), await seqOf(LATE)];
  for (let cycle = 0; cycle < 5; cycle++) await rankHoldLine(RELEASE, U('9101'));

  assert.deepEqual([await seqOf(EARLY), await seqOf(LATE)], seqsBefore,
    'a re-rank charged somebody — with a live ticket this walks the whole line');
  assert.equal(await firstIdOf(U('9101')), firstBefore,
    'first in line changed without anything about the line changing');
});

async function firstIdOf(unit: string) {
  const [r] = await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE unit_id = $1 AND line_rank = 1`, [unit]);
  return r.id;
}

test('the NEXT contest between the same two people goes the other way', async () => {
  await offer(W_EARLY, EARLY, U('9102'), RELEASE);
  const late = await offer(W_LATE, LATE, U('9102'), RELEASE);
  const line = await rankHoldLine(RELEASE, U('9102'));

  assert.equal(line[0].id, late,
    'the user who had first dibs last time must now be behind, or the round-robin never turns');
  assert.notEqual(await seqOf(LATE), null, 'and now they have spent a ticket too');
});

test('an UNCONTESTED offer rotates nobody', async () => {
  const before = await seqOf(EARLY);
  await offer(W_EARLY, EARLY, U('9103'), RELEASE);
  await rankHoldLine(RELEASE, U('9103'));
  assert.equal(await seqOf(EARLY), before,
    'being offered a site nobody else wants must not cost a place in a future contest');
});

// ---------------------------------------------------------------- the cart

test('dueHolds serves ONE hold per campsite, and it is the one first in line', async () => {
  const soon = pacific(1);
  const behind = await offer(W_LATE, LATE, U('9104'), soon);
  const ahead = await offer(W_EARLY, EARLY, U('9104'), soon);
  await mutate(`UPDATE rc_hold_requests SET status = 'requested' WHERE id = ANY($1::text[])`,
    [[ahead, behind]]);
  await rankHoldLine(soon, U('9104'));

  const due = (await dueHolds(180, 20)).filter((h) => h.unit_id === U('9104'));
  assert.equal(due.length, 1,
    'serving both asks RC for the same unit twice — one cart succeeds and RC refuses the ' +
    'other in its own wording, which reads as a fault rather than as a queue');
  assert.equal(due[0].id, ahead);
});

test('the hold left behind SAYS SO, or the readout reports the 2026-08-07 outage', async () => {
  const [behind] = await query<{ id: string; note: string | null; status: string }>(
    `SELECT id, last_attempt_note AS note, status FROM rc_hold_requests
      WHERE unit_id = $1 AND line_rank = 2`, [U('9104')]);
  assert.ok(behind, 'the second hold must still exist — it is not cancelled, it is behind');
  assert.match(String(behind.note), /ahead of you in line/,
    'a `requested` hold past its release with last_attempt_note NULL is what the hold ' +
    'readout calls "NOTHING has tried to act on this hold at all" — the signature of a ' +
    'dead runner. Suppressing it silently would manufacture that false alarm.');
  assert.equal(behind.status, 'requested',
    'noteAttempt records that something looked and did nothing; it must not move status');
});

test('an unranked hold is still served — nothing regresses for the uncontested case', async () => {
  const soon = pacific(2);
  const solo = await offer(W_EARLY, EARLY, U('9105'), soon);
  await mutate(`UPDATE rc_hold_requests SET status = 'requested' WHERE id = $1`, [solo]);
  // Deliberately NOT ranked: this is a row from before migration 068, or a line the poller
  // has not reached. `line_rank` is NULL and it must still reach the runner.
  const due = (await dueHolds(180, 20)).filter((h) => h.unit_id === U('9105'));
  assert.equal(due.length, 1);
  assert.equal(due[0].id, solo);
});
