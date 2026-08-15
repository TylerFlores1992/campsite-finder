/**
 * The batch mute statements, against the REAL database.
 *
 * ── WHY POSTGRES IS THE UNIT HERE ──────────────────────────────────────────────────────
 * The correctness of these two UPDATEs lives entirely inside array SQL — `array_agg`,
 * `unnest`, `= ANY`, and a COALESCE that exists because `array_agg` over an empty set
 * returns NULL while `watches.muted_site_ids` is NOT NULL. A mocked client would confirm
 * that we sent a string. The same reasoning as `claim.test.mts`.
 *
 * The empty-set case is not exotic: "unmute all" filters the array down to nothing, so a
 * missing COALESCE fails the constraint on the FIRST press of the button this feature was
 * built for.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────────────────
 * The fixture watch is dated 2020, so the poller's `end_date > CURRENT_DATE` filter can
 * never see it, and it is deleted on the way out. It holds no `rc_hold_requests` rows, so
 * the hazard behind `hold-fixture-safety.test.mts` — `dueHolds` not caring whether a
 * watch is active, and carting a real campsite for a fixture — does not arise here. The
 * muted ids are non-numeric sentinels for the same family of reason: nothing in this file
 * should resemble a real site id at a real campground.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, mutate } from '../src/lib/db/client';
import { applyMutes, cleanSiteIds, MAX_MUTES } from '../src/lib/watch-mutes';

let watchId: string;

/** Non-numeric, self-describing, and unmistakable in a production table. */
const S = (n: string) => `__camphawk-test-${n}__`;

before(async () => {
  const [user] = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  assert.ok(user, 'need at least one user row to hang a fixture watch off');
  const [cg] = await query<{ id: string }>(
    `SELECT id FROM campgrounds WHERE source = 'ridb' ORDER BY id LIMIT 1`,
  );
  assert.ok(cg, 'need at least one campground');

  const [w] = await mutate<{ id: string }>(
    `INSERT INTO watches (user_id, campground_id, start_date, end_date, min_nights, active)
     VALUES ($1, $2, '2020-01-01', '2020-01-03', 1, true) RETURNING id`,
    [user.id, cg.id],
  );
  watchId = w.id;
});

after(async () => {
  if (watchId) await mutate(`DELETE FROM watches WHERE id = $1`, [watchId]).catch(() => {});
});

async function mutes(): Promise<string[]> {
  const [row] = await query<{ muted_site_ids: string[] }>(
    `SELECT muted_site_ids FROM watches WHERE id = $1`,
    [watchId],
  );
  return [...(row?.muted_site_ids ?? [])].sort();
}

async function reset(to: string[] = []): Promise<void> {
  await mutate(`UPDATE watches SET muted_site_ids = $2 WHERE id = $1`, [watchId, to]);
}

test('muting adds ids', async () => {
  await reset();
  await applyMutes(watchId, { mute: [S('a'), S('b')] });
  assert.deepEqual(await mutes(), [S('a'), S('b')]);
});

test('muting is idempotent — a second press does not duplicate', async () => {
  await reset([S('a')]);
  await applyMutes(watchId, { mute: [S('a'), S('a'), S('b')] });
  assert.deepEqual(await mutes(), [S('a'), S('b')]);
});

test('unmuting the LAST site leaves an empty array, not NULL', async () => {
  // The bulk "unmute all" case. Without COALESCE, array_agg over the empty set returns
  // NULL and the NOT NULL constraint rejects the statement — so the button that this
  // whole feature is built around would fail on its most ordinary use.
  await reset([S('only')]);
  await applyMutes(watchId, { unmute: [S('only')] });
  const [row] = await query<{ muted_site_ids: string[] | null }>(
    `SELECT muted_site_ids FROM watches WHERE id = $1`,
    [watchId],
  );
  assert.notEqual(row?.muted_site_ids, null, 'muted_site_ids came back NULL');
  assert.deepEqual(row?.muted_site_ids, []);
});

test('unmuting removes only the named ids', async () => {
  await reset([S('a'), S('b'), S('c')]);
  await applyMutes(watchId, { unmute: [S('b')] });
  assert.deepEqual(await mutes(), [S('a'), S('c')]);
});

test('unmuting an id that is not muted is a no-op, not an error', async () => {
  await reset([S('a')]);
  await applyMutes(watchId, { unmute: [S('never-muted')] });
  assert.deepEqual(await mutes(), [S('a')]);
});

test('an id in BOTH lists ends up unmuted', async () => {
  // The safe direction, and the reason mutes are applied first. A site wrongly muted is
  // an alert the user never learns they missed; a site wrongly unmuted is only noise.
  await reset();
  await applyMutes(watchId, { mute: [S('x'), S('y')], unmute: [S('x')] });
  assert.deepEqual(await mutes(), [S('y')]);
});

test('an empty change touches nothing', async () => {
  await reset([S('a')]);
  await applyMutes(watchId, {});
  await applyMutes(watchId, { mute: [], unmute: [] });
  assert.deepEqual(await mutes(), [S('a')]);
});

test('a bulk mute of many ids is one statement and lands whole', async () => {
  await reset();
  const many = Array.from({ length: 300 }, (_, i) => S(`bulk-${i}`));
  await applyMutes(watchId, { mute: many });
  assert.equal((await mutes()).length, 300);
  await applyMutes(watchId, { unmute: many });
  assert.deepEqual(await mutes(), []);
});

test("an id with a quote in it is stored verbatim, not as SQL", async () => {
  // `sqlit` interpolates rather than binding, so this is the injection surface. The id is
  // deliberately shaped like a statement terminator.
  await reset();
  const nasty = `__camphawk-test-'); DROP TABLE watches; --__`;
  await applyMutes(watchId, { mute: [nasty] });
  assert.deepEqual(await mutes(), [nasty]);
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM watches WHERE id = $1`, [watchId]);
  assert.equal(n, 1, 'the fixture watch is gone — the id was executed rather than stored');
  await applyMutes(watchId, { unmute: [nasty] });
  assert.deepEqual(await mutes(), []);
});

test('cleanSiteIds drops what cannot be a site id and keeps order', () => {
  assert.deepEqual(cleanSiteIds(['b', 'a', 'b', ' c ', '', '   ', null, 7, {}]), ['b', 'a', 'c']);
  assert.deepEqual(cleanSiteIds(undefined), []);
  assert.deepEqual(cleanSiteIds('a'), [], 'a bare string is not a list');
  assert.deepEqual(cleanSiteIds(['x'.repeat(129)]), [], 'over-long ids are dropped');
  assert.equal(cleanSiteIds(Array.from({ length: MAX_MUTES + 50 }, (_, i) => `s${i}`)).length, MAX_MUTES);
});
