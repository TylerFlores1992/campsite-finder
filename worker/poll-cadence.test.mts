/**
 * Lead-time tiering for the providers with no scheduler in front of them.
 *
 * EVERY FAILURE HERE IS SILENT. A watch that stops being checked produces no error, no
 * log line and no alert — and "no alert" is the correct output almost every cycle, so the
 * bug is indistinguishable from a quiet weekend. Same family as the flex bug in
 * `heldStayRun` and as `hasAvailabilityInRange` returning a flat false for a throttled
 * read. These tests exist because nothing else would notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DueTracker, intervalForLead, HOT_LEAD_DAYS } from './poll-cadence';

const w = (id: string, source: string, leadDays: number) => ({ id, source, leadDays });

test('nothing inside the hot window is ever slowed', () => {
  // THE ONE RULE THE DATA ACTUALLY FORCES. Feature E's roster clustered at 14-20 and
  // 45-51 days out, so there is NO measurement of how fast a short-lead opening
  // disappears — the "this weekend" case. Absence of evidence is not permission.
  for (const lead of [0, 1, 6, 13, HOT_LEAD_DAYS - 1]) {
    assert.equal(intervalForLead(lead, 'reservecalifornia'), 0, `lead ${lead} must stay hot`);
  }
});

test('the ladder only ever slows down as the stay gets further out', () => {
  // Monotonicity, not specific numbers: the steps are a cost judgement and may be
  // retuned, but an interval that shrinks as lead grows would be incoherent and is the
  // kind of thing an edit to the LADDER array could introduce silently.
  let prev = 0;
  for (let lead = 0; lead <= 400; lead++) {
    const ms = intervalForLead(lead, 'reservecalifornia');
    assert.ok(ms >= prev, `interval dropped at lead ${lead}: ${ms} < ${prev}`);
    prev = ms;
  }
});

test('Virginia is never tiered, because it is the one source that would lose openings', () => {
  // 70.1% / 74.6% hourly survival against 94-100% for its UseDirect siblings — roughly
  // one opening in four gone within the hour. Ten portals running the same software are
  // not interchangeable, and averaging them is exactly what would hide this.
  for (const lead of [20, 45, 120, 365]) {
    assert.equal(intervalForLead(lead, 'virginiastateparks'), 0, `Virginia at lead ${lead} must stay hot`);
    assert.ok(intervalForLead(lead, 'floridastateparks') > 0, 'its siblings do tier');
  }
});

test('an unparseable lead time fails toward checking, never toward skipping', () => {
  // A malformed start_date must not be able to switch a watch off. Costing one fetch is
  // the right side of that trade — the other side is an alerting outage with no error.
  assert.equal(intervalForLead(NaN, 'reservecalifornia'), 0);
  assert.equal(intervalForLead(Infinity, 'reservecalifornia'), 0);
});

test('a watch is checked on its first sight, not one interval later', () => {
  // A deploy, or a watch created this minute, must not sit out its whole interval before
  // anyone looks. The poller restarts on every worker deploy.
  const t = new DueTracker();
  assert.equal(t.due([w('a', 'reservecalifornia', 200)], 1_000_000).length, 1);
});

test('a far-out watch is skipped until its interval elapses', () => {
  const t = new DueTracker();
  const far = [w('a', 'reservecalifornia', 200)];
  const now = 1_000_000;
  assert.equal(t.due(far, now).length, 1, 'first sight');
  assert.equal(t.due(far, now + 15_000).length, 0, 'one poll cycle later: skipped');
  assert.equal(t.due(far, now + 60_000).length, 0, 'still inside the 5-minute step');
  assert.equal(t.due(far, now + 300_000).length, 1, 'due again');
});

test('a hot watch is never skipped, however often the cycle runs', () => {
  const t = new DueTracker();
  const hot = [w('a', 'reservecalifornia', 3)];
  let now = 1_000_000;
  for (let i = 0; i < 20; i++, now += 15_000) {
    assert.equal(t.due(hot, now).length, 1, `cycle ${i} must check a 3-day-out watch`);
  }
});

test('a backwards clock does not wedge a watch off', () => {
  // Fly machines resume from snapshots and NTP steps them. A `last` in the future would
  // otherwise suppress checks until real time caught up.
  const t = new DueTracker();
  const far = [w('a', 'reservecalifornia', 200)];
  t.due(far, 10_000_000);
  assert.equal(t.due(far, 1_000_000).length, 1, 'a jump backwards must check, not skip');
});

test('expired watches are pruned rather than accumulating forever', () => {
  // The poller is a long-running 512MB machine that has already been OOM-thrashed once
  // during a catalog sync. An unbounded map in the hot loop is not something to leave.
  const t = new DueTracker();
  t.due([w('a', 'ridb', 200), w('b', 'ridb', 200), w('c', 'ridb', 200)], 1_000);
  assert.equal(t.size, 3);
  t.due([w('b', 'ridb', 200)], 2_000);
  assert.equal(t.size, 1, 'watches no longer in the live set must be dropped');
});

test('two watches on the same source tier independently by their own dates', () => {
  // Tiering is per WATCH here, unlike rec.gov's per (campground, month). A user with a
  // September trip and an April one must not have the September one slowed to match.
  const t = new DueTracker();
  const now = 1_000_000;
  const both = [w('soon', 'reservecalifornia', 3), w('later', 'reservecalifornia', 200)];
  assert.equal(t.due(both, now).length, 2, 'both on first sight');
  const second = t.due(both, now + 15_000);
  assert.deepEqual(second.map((x) => x.id), ['soon'], 'only the near one is due a cycle later');
});
