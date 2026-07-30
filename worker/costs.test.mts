// The cost arithmetic. A wrong answer here silently misstates net margin, which is
// the one figure on the admin Costs tab anyone acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyCents,
  yearlyCents,
  oneTimeTotalCents,
  fixedTotalCents,
  billedPeriods,
  lifetimeCents,
  lifetimeTotals,
  type CostItem,
} from '../src/lib/costs';

const item = (amount_cents: number, billing_period: CostItem['billing_period']): CostItem => ({
  id: billing_period + amount_cents,
  label: 'x',
  category: 'other',
  amount_cents,
  billing_period,
  notes: null,
  sort_order: 0,
});

test('monthly is taken as billed', () => {
  assert.equal(monthlyCents(item(2000, 'monthly')), 2000);
});

test('yearly divides by 12 rather than being summed raw', () => {
  // Summing the raw column would call a $20/yr domain $20/mo — 12x overstated.
  assert.equal(monthlyCents(item(2400, 'yearly')), 200);
  assert.equal(yearlyCents(item(2400, 'yearly')), 2400);
});

test('a one-time cost has NO monthly or yearly figure', () => {
  // The whole point: it must not become a permanent line in monthly burn.
  assert.equal(monthlyCents(item(99900, 'one_time')), 0);
  assert.equal(yearlyCents(item(99900, 'one_time')), 0);
});

test('one-time items are excluded from the fixed subtotal', () => {
  const items = [item(2000, 'monthly'), item(2400, 'yearly'), item(99900, 'one_time')];
  // 2000 + 200, and nothing from the 999.00 hardware purchase.
  assert.equal(fixedTotalCents(items), 2200);
});

test('one-time items total on their own, at face value', () => {
  const items = [item(2000, 'monthly'), item(99900, 'one_time'), item(12900, 'one_time')];
  assert.equal(oneTimeTotalCents(items), 112800);
});

test('a missing or zero amount cannot produce NaN in a total', () => {
  const items = [item(0, 'monthly'), { ...item(0, 'yearly'), amount_cents: undefined as unknown as number }];
  assert.equal(Number.isFinite(fixedTotalCents(items)), true);
  assert.equal(fixedTotalCents(items), 0);
});

// --- lifetime spend ----------------------------------------------------------
// The figures here answer "what has this cost, ever", so an error compounds rather
// than showing up once. The unknown-start case is the one that matters most: it must
// stay unknown instead of quietly counting as zero.

const dated = (
  amount_cents: number,
  billing_period: CostItem['billing_period'],
  started_at: string | null,
  ended_at: string | null = null,
): CostItem => ({ ...item(amount_cents, billing_period), started_at, ended_at });

const AS_OF = new Date('2026-07-30T12:00:00Z');

test('billing is counted in advance, so a plan started today counts once', () => {
  // Zero would report a subscription you have already paid for as having cost nothing.
  assert.equal(billedPeriods(dated(2000, 'monthly', '2026-07-30'), AS_OF), 1);
});

test('a monthly plan accrues one charge per calendar month', () => {
  // Apr, May, Jun, Jul.
  assert.equal(billedPeriods(dated(2000, 'monthly', '2026-04-15'), AS_OF), 4);
  assert.equal(lifetimeCents(dated(2000, 'monthly', '2026-04-15'), AS_OF), 8000);
});

test('a yearly plan bills once until the year is up', () => {
  assert.equal(billedPeriods(dated(9900, 'yearly', '2026-01-01'), AS_OF), 1);
  assert.equal(billedPeriods(dated(9900, 'yearly', '2025-01-01'), AS_OF), 2);
  assert.equal(lifetimeCents(dated(9900, 'yearly', '2025-01-01'), AS_OF), 19800);
});

test('an ended item stops accruing at its end date', () => {
  // Cancelled in May: Mar, Apr, May — not through July.
  assert.equal(billedPeriods(dated(1000, 'monthly', '2026-03-01', '2026-05-10'), AS_OF), 3);
});

test('an unknown start date is UNKNOWN, never zero', () => {
  assert.equal(billedPeriods(dated(2000, 'monthly', null), AS_OF), null);
  assert.equal(lifetimeCents(dated(2000, 'monthly', null), AS_OF), null);
});

test('items with no start date are excluded AND counted as unknown', () => {
  const items = [
    dated(2000, 'monthly', '2026-04-15'), // 4 x 2000 = 8000
    dated(2000, 'monthly', null), // unknown — must not contribute
    dated(99900, 'one_time', null), // one-time needs no date
  ];
  const t = lifetimeTotals(items, { sms: 0, email: 0, push: 0 }, AS_OF);
  assert.equal(t.recurringCents, 8000);
  assert.equal(t.oneTimeCents, 99900);
  assert.equal(t.unknownCount, 1, 'the missing row must be reported, not hidden');
  assert.equal(t.totalCents, 107900);
});

test('lifetime usage is added to the total', () => {
  const t = lifetimeTotals([], { sms: 1000, email: 0, push: 0 }, AS_OF);
  // 1000 texts at the default $0.0115 = $11.50.
  assert.equal(t.usageCents, 1150);
  assert.equal(t.totalCents, 1150);
});

test('a future start date cannot produce a negative total', () => {
  assert.equal(billedPeriods(dated(2000, 'monthly', '2027-01-01'), AS_OF), 0);
  assert.equal(lifetimeCents(dated(2000, 'monthly', '2027-01-01'), AS_OF), 0);
});
