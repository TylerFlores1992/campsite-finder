/**
 * Calling off a hold you already queued — the X on a `requested` row (owner's ask,
 * 2026-09-04).
 *
 * ## Why this is not just `declineHold` with a wider status list
 *
 * `rc-holds.ts`'s own header explains why `requested` had no control for a year:
 * *"`requested` is a commitment the bot is about to honour — retracting it is a CANCEL, a
 * different act with a different confirmation, and getting it wrong at 07:59 loses a
 * campsite."* So the button needed a verb that carries the timing rule, not a looser
 * predicate on the existing one.
 *
 * ## Real-DB, for the reason every hold suite is
 *
 * The whole decision is one `UPDATE ... WHERE status = 'requested' AND release_at > ...`,
 * and the properties that matter are the two it REFUSES. A mock would assert a copy of that
 * predicate — which is the mistake `rc-holds-readout` already paid for.
 *
 * ## Fixture safety
 *
 * Non-numeric `__tcx` unit ids so the production runner can never cart one (2026-08-15).
 * Watches dated 2020 so the poller cannot see them. Per-suite prefix plus an `offered_at`
 * age gate, so neither a sibling suite nor a second run of this one wipes live rows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, mutate } from '../src/lib/db/client';
import { cancelHold, declineHold, markCarted } from '../src/lib/rc-holds';
import { HOLD_CANCEL_CUTOFF_MIN, RC_HOLD_FEED_MAX_LEAD_SEC } from '../src/lib/limits';

const U = (n: string) => `__tcx${n}`;
const USER = 'test-cancel-user';
const WATCH = 'test-cancel-watch';
let campgroundId = '';

/** A Pacific wall-clock string N minutes from now — the shape `release_at` is stored in. */
const pacific = (offsetMinutes: number) => {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
};

async function sweep() {
  await mutate(
    `DELETE FROM rc_hold_requests WHERE unit_id LIKE '\\_\\_tcx%'
       AND offered_at < NOW() - interval '10 minutes'`, []);
  await mutate(`DELETE FROM watches WHERE id = $1`, [WATCH]);
  await mutate(`DELETE FROM users WHERE id = $1`, [USER]);
}

before(async () => {
  await sweep();
  [{ id: campgroundId }] = await query<{ id: string }>(`SELECT id FROM campgrounds LIMIT 1`, []);
  await mutate(`INSERT INTO users (id, email) VALUES ($1,$2)`, [USER, 'cancel@camphawk.invalid']);
  await mutate(
    `INSERT INTO watches (id, user_id, campground_id, start_date, end_date, active, created_at)
     VALUES ($1,$2,$3,'2020-01-01','2020-01-03',true,'2020-01-01T00:00:00Z')`,
    [WATCH, USER, campgroundId]);
});

after(sweep);

async function row(unit: string, status: string, releaseMinutes: number) {
  const [r] = await mutate<{ id: string }>(
    `INSERT INTO rc_hold_requests
       (watch_id, user_id, campground_id, unit_id, arrival_date, nights, release_at, status)
     VALUES ($1,$2,$3,$4,'2030-07-05',1,$5,$6) RETURNING id`,
    [WATCH, USER, campgroundId, unit, pacific(releaseMinutes), status]);
  return r.id;
}

const stateOf = async (id: string) =>
  (await query<{ status: string; note: string | null }>(
    `SELECT status, last_attempt_note AS note FROM rc_hold_requests WHERE id = $1`, [id]))[0];

/** Comfortably outside the cutoff, i.e. an ordinary "the night before" cancel. */
const SAFE = HOLD_CANCEL_CUTOFF_MIN + 60;
/** Inside it — the bot may already have the row. */
const IMMINENT = Math.max(1, HOLD_CANCEL_CUTOFF_MIN - 2);

test('a queued hold well ahead of its release can be called off', async () => {
  const id = await row(U('1'), 'requested', SAFE);
  assert.equal(await cancelHold(id), 'cancelled');
  const s = await stateOf(id);
  assert.equal(s.status, 'expired');
  assert.match(String(s.note), /cancelled by the user/,
    'a cancel, a decline and a lapse are three different events and all land on `expired` — ' +
    'the note is the only thing that tells them apart in the readout');
});

test('a cancel and a DECLINE are distinguishable afterwards', async () => {
  // Both write `expired`, deliberately (see cancelHold's header: a seventh status means a
  // CHECK migration and every consumer that enumerates them). So the notes must differ, or
  // the readout cannot say which happened.
  const cancelled = await row(U('2'), 'requested', SAFE);
  const declined = await row(U('3'), 'offered', SAFE);
  await cancelHold(cancelled);
  await declineHold(declined);
  const a = await stateOf(cancelled);
  const b = await stateOf(declined);
  assert.equal(a.status, 'expired');
  assert.equal(b.status, 'expired');
  assert.notEqual(a.note, b.note, 'two different acts must not leave the same trace');
  assert.match(String(b.note), /declined by the user/);
});

test('TOO CLOSE TO THE RELEASE is refused, and the row is untouched', async () => {
  // The whole reason `requested` had no button until now. Past the cutoff the feed may
  // already have handed this row to the runner, and our database no longer decides.
  const id = await row(U('4'), 'requested', IMMINENT);
  assert.equal(await cancelHold(id), 'too-late');
  assert.equal((await stateOf(id)).status, 'requested',
    'a refused cancel must leave the hold exactly as it was — the bot is still going to cart it');
});

test('"too late" and "already acted on" are DIFFERENT answers', async () => {
  // Collapsing them would tell somebody at 07:55 that their hold had already been carted,
  // which is a wrong story about what is happening — the same class of lie that kept the
  // control off the panel in the first place.
  const imminent = await row(U('5'), 'requested', IMMINENT);
  const carted = await row(U('6'), 'carted', SAFE);
  assert.equal(await cancelHold(imminent), 'too-late');
  assert.equal(await cancelHold(carted), 'not-queued');
});

test('a CARTED hold cannot be cancelled — that is the 2026-08-13 leak with a button on it', async () => {
  const id = await row(U('7'), 'carted', SAFE);
  assert.equal(await cancelHold(id), 'not-queued');
  assert.equal((await stateOf(id)).status, 'carted',
    'marking it terminal here does not release the site; it only removes the last thing ' +
    'on screen still pointing at it');
});

test('an OFFERED hold is not this verb — declining frees a seat and a line position', async () => {
  const id = await row(U('8'), 'offered', SAFE);
  assert.equal(await cancelHold(id), 'not-queued');
  assert.equal((await stateOf(id)).status, 'offered');
});

test('cancelling twice is not a second success', async () => {
  const id = await row(U('9'), 'requested', SAFE);
  assert.equal(await cancelHold(id), 'cancelled');
  assert.equal(await cancelHold(id), 'not-queued', 'the second press must not report success');
});

test('THE RACE IS SAFE: a cart landing after a cancel still leaves a releasable row', async () => {
  // This is what makes the cutoff a question of honesty rather than of safety. `markCarted`
  // is `WHERE id = $1 AND status <> 'carted'`, so the bot's write wins over a cancel that
  // slipped through — and the row is then `carted` with a cart key, which is exactly what
  // `expireStaleHolds` looks for. Nothing is stranded.
  const id = await row(U('10'), 'requested', SAFE);
  assert.equal(await cancelHold(id), 'cancelled');
  assert.equal(await markCarted(id, 'cart-key-x', 'entry-key-x'), true,
    'a cancelled row must still be cartable, or a lost race strands a real campsite with ' +
    'nothing looking for it');
  const [r] = await query<{ status: string; cart_key: string | null }>(
    `SELECT status, cart_key FROM rc_hold_requests WHERE id = $1`, [id]);
  assert.equal(r.status, 'carted');
  assert.equal(r.cart_key, 'cart-key-x', 'expireStaleHolds needs the key to let go');
});

// ── the two numbers that must not drift apart ────────────────────────────────────────

test('the cutoff is DERIVED from the feed lead, not chosen', async () => {
  assert.ok(
    HOLD_CANCEL_CUTOFF_MIN > RC_HOLD_FEED_MAX_LEAD_SEC / 60,
    'the cutoff must exceed the widest lead the feed will serve a hold on, or a cancel ' +
    'can be accepted for a row the runner is already holding',
  );
  const src = readFileSync('src/lib/limits.ts', 'utf8');
  assert.match(src, /HOLD_CANCEL_CUTOFF_MIN\s*=[^;]*RC_HOLD_FEED_MAX_LEAD_SEC/,
    'a hand-written number here becomes a second copy of the feed lead, which is how ' +
    'nextHoldRelease came to disagree with dueHolds about whether a hold still existed');
});

test('the FEED reads the same ceiling — one definition, both ends', async () => {
  // Structural: the derivation above is worthless if the route still carries its own 600.
  const route = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(route, /Math\.min\(\s*RC_HOLD_FEED_MAX_LEAD_SEC/,
    'the feed must clamp to the shared constant, not to a literal of its own');
});
