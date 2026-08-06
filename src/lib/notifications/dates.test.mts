// Stay dates, as a person would write them.
//
// Run: npm test   (pure — no network, no DB)
//
// The bug this guards: an alert read "Site Unit 42573 open 2026-09-04, 2026-09-05,
// 2026-09-06" and was understood as "the site opens on September 4th". In the same SMS
// thread sat a coming-soon text using "opens <date>" to mean a genuine release time, so
// the two readings were live at once. Formatting also buys ~24 characters back on a
// 160-character budget, which is the difference between one segment and two.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStayDates } from './dates';

test('consecutive nights collapse into a range', () => {
  assert.equal(formatStayDates(['2026-09-04', '2026-09-05', '2026-09-06']), 'Sep 4-6');
});

test('a single night is just that night', () => {
  assert.equal(formatStayDates(['2026-09-04']), 'Sep 4');
});

test('a gap stays visible — a range would promise a night that is not there', () => {
  assert.equal(formatStayDates(['2026-09-04', '2026-09-06']), 'Sep 4, Sep 6');
});

test('a run across a month boundary names both months', () => {
  assert.equal(formatStayDates(['2026-08-30', '2026-08-31', '2026-09-01']), 'Aug 30-Sep 1');
});

test('unsorted input is handled — the poller does not promise an order', () => {
  assert.equal(formatStayDates(['2026-09-06', '2026-09-04', '2026-09-05']), 'Sep 4-6');
});

test('duplicates do not create phantom groups', () => {
  assert.equal(formatStayDates(['2026-09-04', '2026-09-04', '2026-09-05']), 'Sep 4-5');
});

test('many separate groups are summarised rather than listed forever', () => {
  const out = formatStayDates(['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07', '2026-09-09']);
  assert.ok(out.startsWith('Sep 1, Sep 3, Sep 5'), out);
  assert.ok(out.includes('+2 more'), out);
});

test('it is SHORTER than the ISO list it replaces — the segment budget depends on it', () => {
  const iso = ['2026-09-04', '2026-09-05', '2026-09-06'];
  assert.ok(formatStayDates(iso).length < iso.join(', ').length);
});

test('a date is never shifted by the server timezone', () => {
  // `new Date('2026-09-04')` is midnight UTC, which renders as Sep 3 anywhere west of
  // Greenwich — including every US timezone this product serves. The parser is
  // deliberately string-based for exactly this reason.
  const prev = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(formatStayDates(['2026-09-04']), 'Sep 4');
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(formatStayDates(['2026-09-04']), 'Sep 4');
  } finally {
    process.env.TZ = prev;
  }
});

test('anything unparseable passes through untouched rather than being guessed at', () => {
  assert.equal(formatStayDates(['not-a-date']), 'not-a-date');
  assert.equal(formatStayDates([]), '');
});
