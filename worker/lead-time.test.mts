// The hot/cold decision for a campground-month. Wrong in the hot direction it burns
// the per-IP budget that keeps detection at 15s; wrong in the cold direction it
// quietly slows exactly the watches whose openings are snapped up in minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadDaysUntil } from './lead-time';

// Fixed clock: 2026-08-01T00:00:00Z. Everything below is relative to it.
const NOW = Date.parse('2026-08-01T00:00:00Z');

test('leadDaysUntil', async (t) => {
  await t.test('a stay starting today is lead 0', () => {
    assert.equal(leadDaysUntil('2026-08-01', '2026-08', NOW), 0);
  });

  await t.test('a stay already in progress clamps to 0, never negative', () => {
    // start_date is in the past but end_date keeps the watch active — a negative
    // lead would sort BELOW hot thresholds in surprising ways; 0 is the honest value.
    assert.equal(leadDaysUntil('2026-07-28', '2026-07', NOW), 0);
    assert.equal(leadDaysUntil('2026-07-28', '2026-08', NOW), 0);
  });

  await t.test('lead is counted to the first wanted night, not the month boundary', () => {
    // Watch starts Aug 20; its August pair is 19 days out even though August itself
    // started today.
    assert.equal(leadDaysUntil('2026-08-20', '2026-08', NOW), 19);
  });

  await t.test('a later month of a long watch is far-out even when the stay has begun', () => {
    // The reason this is per (watch, month): a watch running Aug 1 – Oct 31 must not
    // drag its October pages into the hot tier on August 1st.
    assert.equal(leadDaysUntil('2026-08-01', '2026-10', NOW), 61);
  });

  await t.test('the 14-day hot boundary lands where the default threshold expects', () => {
    // RECGOV_HOT_LEAD_DAYS defaults to 14: <= 14 hot, > 14 cold.
    assert.equal(leadDaysUntil('2026-08-15', '2026-08', NOW), 14, 'still hot');
    assert.equal(leadDaysUntil('2026-08-16', '2026-08', NOW), 15, 'first cold day');
  });

  await t.test('partial days round UP — "14.5 days out" is 15, not 14', () => {
    // Ceil, so a pair goes hot only once it is genuinely within the threshold; a
    // floor would flip it half a day early.
    const halfDayEarlier = NOW - 12 * 60 * 60 * 1000; // 2026-07-31T12:00Z
    assert.equal(leadDaysUntil('2026-08-15', '2026-08', halfDayEarlier), 15);
  });
});
