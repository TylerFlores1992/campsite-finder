// The admin chart's bucketing — raw daily rows → the points a range actually plots.
//
// Run: npm test   (the script globs src/**/*.test.mts as well as worker/**)
//
// Pure, no network, no DB. Worth testing because every failure here is SILENT and
// plausible-looking: a missing bucket just draws a shorter line, and a cumulative
// series that forgets its history draws a correct-shaped curve starting from the
// wrong number. Neither throws, and both look like data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucket } from './MetricChart';

/** N days before today, as the server's YYYY-MM-DD. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

test('30d always returns 30 buckets, zero-filling the quiet days', () => {
  // Two rows, 30 slots. A series that skipped its empty days would return 2 points
  // and draw a line implying signups only ever happened twice.
  const out = bucket([{ day: daysAgo(20), n: 3 }, { day: daysAgo(2), n: 5 }], '30d');
  assert.equal(out.length, 30);
  assert.equal(
    out.reduce((s, b) => s + b.n, 0),
    8,
    'zero-filling must not invent or drop volume'
  );
  assert.equal(out.filter((b) => b.n > 0).length, 2);
});

test('a cumulative series starts from history OUTSIDE the window, not from zero', () => {
  // THE bug worth guarding. 200 users existed before the last 30 days; the chart must
  // open at 200 and end at 205, not open at 0 and end at 5. Both are smooth rising
  // curves — only the numbers say which one is right.
  const rows = [
    { day: '2020-01-01', n: 200 },
    { day: daysAgo(10), n: 3 },
    { day: daysAgo(1), n: 2 },
  ];
  const out = bucket(rows, '30d', true);
  assert.equal(out[0].n, 200, 'must carry the pre-window total forward');
  assert.equal(out[out.length - 1].n, 205);
});

test('a cumulative series never decreases', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ day: daysAgo(24 - i), n: i % 4 }));
  const out = bucket(rows, '30d', true);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].n >= out[i - 1].n, `total fell at ${out[i].key}`);
  }
});

test('12m buckets by MONTH and returns 12 of them', () => {
  const out = bucket([{ day: daysAgo(5), n: 4 }], '12m');
  assert.equal(out.length, 12);
  assert.match(out[0].key, /^\d{4}-\d{2}$/, 'month keys are YYYY-MM');
  // Asserts the TOTAL, not which bucket: five days ago is last month for the first
  // few days of any month, and an assertion that only holds mid-month is a test that
  // fails on the 4th for no reason. (It did.)
  assert.equal(out.reduce((s, b) => s + b.n, 0), 4, 'the row lands in exactly one month');
});

test('12m sums every day of a month into one bucket', () => {
  // Same month, three days — one bucket of 6, not three buckets.
  const d = new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const out = bucket(
    [
      { day: `${ym}-01`, n: 1 },
      { day: `${ym}-02`, n: 2 },
      { day: `${ym}-03`, n: 3 },
    ],
    '12m'
  );
  assert.equal(out[out.length - 1].n, 6);
});

test('all-time starts at the first row, not at a fixed window', () => {
  const out = bucket([{ day: '2026-03-14', n: 1 }, { day: daysAgo(1), n: 1 }], 'all');
  assert.equal(out[0].key, '2026-03', 'begins at the month of the earliest row');
  assert.ok(out.length >= 5, 'spans March to now');
});

test('no rows returns an empty-but-shaped range, not a crash', () => {
  // An empty table on a fresh deploy must render an axis, not throw.
  assert.equal(bucket([], '30d').length, 30);
  assert.equal(bucket([], '12m').length, 12);
  assert.equal(bucket([], '30d', true).every((b) => b.n === 0), true);
});
