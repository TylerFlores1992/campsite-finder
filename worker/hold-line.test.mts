/**
 * TWO PEOPLE, ONE CAMPSITE — the guard over the fairness line.
 *
 * THE MEASURED CASE, reproduced here. On 2026-08-24 unit 43191 ("#96", Morro Bay, arrival
 * 2026-09-04, releasing 08-25 08:00 PT) was offered to two different users for the same
 * release, and nothing in the system had an opinion about who should get it.
 *
 * WHY THEY COLLIDED — CORRECTED 2026-08-26. This header used to say RC lists one physical
 * campsite under more than one facility. That is false: RC's September inventory has ZERO
 * overlap between the lottery pool and Upper Section. They collided because **both users
 * watch the same park**, which makes contention ordinary rather than an RC quirk — it
 * scales with the product.
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
import { readFileSync } from 'node:fs';
import { orderLine, isContested, rankHoldLine, BEHIND_NOTE } from './hold-line';
import { dueHolds } from '../src/lib/rc-holds';

/**
 * A sentinel unit id, NAMESPACED TO THIS SUITE.
 *
 * Non-numeric so the production hold runner can never cart one — the 2026-08-15 rule. The
 * `ln` segment is the part this file added: `npm test` runs suites CONCURRENTLY, and the
 * global `LIKE '__t%'` sweep several of them use deletes EVERY suite's fixtures, not its
 * own. Three files already shared that blast radius; adding more made a sibling's rows
 * vanish mid-run and failed an unrelated assertion in a way that reads exactly like a
 * regression. This suite sweeps only what it created.
 */
/** Comments stripped — this file's subject quotes the broken shapes to explain them. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

const U = (n: string) => `__tln${n}`;
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
  // AGE-GATED (#76): a per-suite prefix stops another suite wiping these rows and
  // does nothing about a second run of THIS suite, which CI produces on every push.
  // `offered_at` is the row's birth time and no status change moves it, so a live
  // run's rows are seconds old and protected while real litter is minutes old.
  await mutate(`DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_tln%'
                 AND offered_at < NOW() - interval '10 minutes'`, []);
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
  // AND IT MUST NOT ASSERT SOMETHING THAT MAY NEVER HAPPEN. The line ranks `offered` rows
  // too, so rank 1 may never tap — on 2026-08-25 that is exactly what happened, and rank 2
  // carted the site at T+2s with this note on his row claiming the other hold "is the one
  // being carted". `last_attempt_note` is the readout's evidence for what the runner did;
  // a flat assertion about a cart that did not occur is how the next morning gets read
  // backwards. The wording must stay CONDITIONAL.
  assert.doesNotMatch(String(behind.note), /is the one being carted/,
    'the note must not state that the hold ahead is being carted — it may never be tapped');
  assert.match(String(behind.note), /if they also ask for it/,
    'the note must say what happens IF the hold ahead is also requested');
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

// ---------------------------------------------------------------------------
// THE DE-DUPE WAS PER CALL, NOT PER CONTEST (fixed 2026-08-26).
//
// Every assertion above calls `dueHolds` ONCE, and one call has always returned one row.
// That is why the suite passed while the bot carted one campsite TWICE on 08-26: the
// runner polls every 15s, and the instant rank 1 left `requested` the `DISTINCT ON` had
// nothing left to de-dupe against, so rank 2 was served on the next pass.
//
// **THESE TESTS MUST CALL IT TWICE.** A single call cannot see this bug, and a guard that
// cannot see the bug is the shape this repo has paid for more than twenty times.
// ---------------------------------------------------------------------------

/** The whole point: serve, change status the way the runner would, serve again. */
async function serve(unit: string) {
  return (await dueHolds(180, 20)).filter((h) => h.unit_id === unit).map((h) => h.id);
}

test('ONCE THE WINNER IS CARTED, THE RUNNER-UP IS NOT SERVED — the 08-26 double-cart', async () => {
  const soon = pacific(2);
  const a = await offer(W_EARLY, EARLY, U('9201'), soon);
  const b = await offer(W_LATE, LATE, U('9201'), soon);
  await mutate(`UPDATE rc_hold_requests SET status = 'requested' WHERE id = ANY($1::text[])`, [[a, b]]);
  await rankHoldLine(soon, U('9201'));

  // CALL 1 — unchanged behaviour, and the only thing the old suite ever checked.
  //
  // WHICH of the two wins is deliberately NOT asserted here. Tests 1-11 own the ordering,
  // and by this point in the file the rotation ticket has already been charged, so naming
  // a winner would couple this test to the accumulated state of its siblings. What this
  // test is about is the TEMPORAL rule, so it takes whoever won and carts them.
  const first = await serve(U('9201'));
  assert.equal(first.length, 1, 'exactly one of the two is served on the first pass');
  const [winner] = first;
  const loser = winner === a ? b : a;

  // The runner carts it. This is the status change the old test never made.
  await mutate(`UPDATE rc_hold_requests SET status = 'carted', carted_at = NOW() WHERE id = $1`, [winner]);

  // CALL 2 — the bug. `DISTINCT ON` alone returns the loser here, 14 seconds later in
  // production, and RC ACCEPTS the second cart rather than refusing it.
  assert.deepEqual(await serve(U('9201')), [],
    'a unit already in RC\'s cart must not be served to the next person in line — that is ' +
    'two cart slots for one campsite and two users each told it is held');
  assert.equal(
    (await query<{ status: string }>(`SELECT status FROM rc_hold_requests WHERE id = $1`, [loser]))[0].status,
    'requested', 'the loser is held back, NOT cancelled — the offer is still theirs if the cart lapses');
});

test('...and stays unserved through claiming, released and claimed', async () => {
  // The hand-off states are the same double-book one step later: the winner is checking
  // out right now. Only `carted` was the observed case; the others are the same fault.
  for (const status of ['claiming', 'released', 'claimed']) {
    await mutate(
      `UPDATE rc_hold_requests SET status = $2 WHERE unit_id = $1 AND status <> 'requested'`,
      [U('9201'), status]);
    assert.deepEqual(await serve(U('9201')), [], `a ${status} hold must still block the line`);
  }
});

test('A REFUSED CART DOES NOT BLOCK THE LINE — failed and expired are not "spoken for"', async () => {
  // The dangerous over-correction. A cart RC refused never took the site, so blocking on it
  // would deny the unit to somebody who could still get it. Exactly one row is `requested`
  // at this point (the loser), so it must come back the moment nothing is carted.
  for (const status of ['failed', 'expired']) {
    await mutate(
      `UPDATE rc_hold_requests SET status = $2 WHERE unit_id = $1 AND status <> 'requested'`,
      [U('9201'), status]);
    assert.equal((await serve(U('9201'))).length, 1,
      `a ${status} hold never took the site, so the line must keep moving`);
  }
});
test('THE BLOCK IS SCOPED TO (release_at, unit_id) — both halves, in one fixture', async () => {
  // BOTH HALVES OR NEITHER. The first version of this test used a fresh `pacific(2)` per
  // test, so its "different unit" row never shared a release_at with the carted one — and
  // mutations dropping `unit_id` and dropping `release_at` from the scope BOTH survived.
  // The scope is only exercised when the rows genuinely collide on one half and not the
  // other, which means building all three against the same fixture.
  const shared = pacific(2);
  const other = pacific(1);

  const carted = await offer(W_EARLY, EARLY, U('9210'), shared);
  const sameReleaseOtherUnit = await offer(W_EARLY, EARLY, U('9211'), shared);
  // The OTHER watch, because `rc_hold_requests_unique` is (watch_id, unit_id,
  // arrival_date) and `offer()` uses one arrival — so one watch cannot hold the same unit
  // twice. A second user watching the same site is the realistic shape anyway.
  const sameUnitOtherRelease = await offer(W_LATE, LATE, U('9210'), other);
  await mutate(`UPDATE rc_hold_requests SET status = 'requested' WHERE id = ANY($1::text[])`,
    [[sameReleaseOtherUnit, sameUnitOtherRelease]]);
  await mutate(`UPDATE rc_hold_requests SET status = 'carted', carted_at = NOW() WHERE id = $1`,
    [carted]);

  // Drop `unit_id` from the scope and ONE carted site silences every other site releasing
  // at the same instant. Twenty holds share an 08:00, so that is far worse than the bug
  // being fixed here.
  assert.deepEqual(await serve(U('9211')), [sameReleaseOtherUnit],
    'a different unit at the SAME release must still be served');

  // Drop `release_at` and a cart today blocks the same campsite for every future release.
  assert.deepEqual(await serve(U('9210')), [sameUnitOtherRelease],
    'the same unit at a DIFFERENT release must still be served');
});

// ---------------------------------------------------------------------------
// THE NOTE NEVER REACHED A HOLD TAPPED AFTER THE LINE WAS RANKED (fixed 2026-08-28).
//
// Every test above sets BOTH rows to `requested` before calling `rankHoldLine`, so the
// note is written on the first and only pass and the suite is green. Production does the
// opposite: the poller offers both rows the evening before — `offered`, not `requested` —
// ranks the line then, and the tap arrives hours later. `rankHoldLine` notes only rows
// that are `requested` AT RANKING TIME, and for the primary held unit the rank call sat
// inside a block gated by `claimHoldNotification`, which fires once per release. So there
// was no second pass, ever.
//
// The runner-up's row then sits `requested` past its release with `last_attempt_note`
// NULL — which `rc-holds-readout.mts` reports as "NOTHING has tried to act on this hold at
// all", the 2026-08-07 dead-runner signature. The line manufactures that false alarm on
// every contested morning.
// ---------------------------------------------------------------------------

const noteOf = async (id: string) =>
  (await query<{ note: string | null; at: string | null }>(
    `SELECT last_attempt_note AS note, last_attempt_at::text AS at
       FROM rc_hold_requests WHERE id = $1`, [id]))[0];

test('A HOLD TAPPED AFTER THE LINE WAS RANKED IS STILL TOLD IT IS BEHIND', async () => {
  const ahead = await offer(W_EARLY, EARLY, U('9301'), RELEASE);
  const late = await offer(W_LATE, LATE, U('9301'), RELEASE);

  // THE EVENING BEFORE: both offered, neither tapped. This is the state the poller ranks
  // in, and it is why every assertion above missed this — they rank `requested` rows.
  const first = await rankHoldLine(RELEASE, U('9301'));
  assert.equal(first.length, 2, 'both offers are ranked, tapped or not');
  assert.equal((await noteOf(late)).note, null,
    'an OFFERED hold is not told it is behind — nobody has asked for anything yet, and a ' +
    'note on a row the user never tapped is a claim about a queue they are not in');

  // THE NEXT MORNING: the runner-up taps. Nothing about the line has changed except this.
  await mutate(`UPDATE rc_hold_requests SET status = 'requested' WHERE id = $1`, [late]);

  await rankHoldLine(RELEASE, U('9301'));
  assert.match(String((await noteOf(late)).note), /ahead of you in line/,
    'the tap is what makes the note true, and it arrives AFTER the line was ranked — the ' +
    'ordinary case, since an offer goes out the night before and is tapped at breakfast');
  assert.equal((await holdRow(late)).status, 'requested',
    'noting a hold must not move its status — it is behind, not cancelled');
  // AND THE HOLD IN FRONT IS NEVER NOTED. It is not behind anybody, and telling rank 1 it
  // is queued behind someone is worse than silence.
  assert.equal((await noteOf(ahead)).note, null,
    'the hold first in line has nobody ahead of it and must carry no note');
});

test('...and re-ranking an unchanged line does NOT rewrite the note', async () => {
  // The poller now re-ranks every cycle — every 15 seconds, all night. Without the skip,
  // `last_attempt_at` is stamped on each pass and permanently reads "0m ago", which
  // destroys the one column that says WHEN the line last changed its mind. It is also the
  // column the readout uses to tell "the runner TRIED 3m ago" from "nothing has looked".
  const late = (await query<{ id: string }>(
    `SELECT id FROM rc_hold_requests WHERE unit_id = $1 AND line_rank = 2`, [U('9301')]))[0].id;
  const before = await noteOf(late);
  assert.ok(before.at, 'precondition: the note was written by the test above');

  for (let cycle = 0; cycle < 3; cycle++) await rankHoldLine(RELEASE, U('9301'));

  const after = await noteOf(late);
  assert.equal(after.at, before.at,
    'a line that has not changed must not restamp last_attempt_at — the poller re-ranks ' +
    'every cycle, so an unconditional write is ~2,400 pointless writes across one night ' +
    'and leaves the age reading zero for ever');
  assert.equal(after.note, before.note, 'and the note itself is unchanged');
});

test('BEHIND_NOTE SURVIVES noteAttempt\'s 300-CHARACTER TRUNCATION', () => {
  // The skip above compares the stored value against this constant. `noteAttempt` slices
  // to 300, so a longer note could never equal what was stored: the comparison would fail
  // on every pass, the guard would silently stop guarding, and the churn would come back
  // with nothing failing. A fix present and inert — the shape this repo keeps paying for.
  assert.ok(BEHIND_NOTE.length <= 300,
    `the note is ${BEHIND_NOTE.length} chars and noteAttempt stores only the first 300`);
});

test('THE POLLER RE-RANKS BEFORE THE CLAIM GATE — or hold-line.ts is perfect and inert', () => {
  // THE HALF THAT ACTUALLY BROKE. `rankHoldLine` can note late tappers flawlessly and
  // change nothing, because for the primary held unit it was only ever CALLED once: its
  // call site sat inside the block guarded by `claimHoldNotification`, which is once per
  // (watch, release, unit), and every later cycle `continue`s before reaching it.
  //
  // Comments stripped — the source quotes the shape it fixed, and a guard that matches its
  // own explanation passes against code that does nothing.
  const src = code(readFileSync(new URL('./poller.ts', import.meta.url), 'utf8'));
  const claimIdx = src.indexOf('claimHoldNotification(w.id');
  const rankIdx = src.indexOf('rankHoldLine(held.availableAt');
  // BOTH ANCHORS ASSERTED PRESENT. A missing anchor makes indexOf return -1, and `-1 <
  // claimIdx` is true — so a renamed call would PASS this test while proving nothing.
  // That exact inversion has been recorded here more than twenty times.
  assert.ok(claimIdx > -1, 'anchor lost: the claim gate is no longer called as claimHoldNotification(w.id');
  assert.ok(rankIdx > -1, 'anchor lost: the primary held unit is no longer ranked on held.availableAt');
  assert.ok(rankIdx < claimIdx,
    'the primary held unit must be re-ranked ABOVE the claim gate. Below it, the line is ' +
    'ranked exactly once in the life of an offer, so anyone who taps afterwards is never ' +
    'told they are behind and their row reads as a dead runner at 08:15');
});
