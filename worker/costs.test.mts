// The cost arithmetic. A wrong answer here silently misstates net margin, which is
// the one figure on the admin Costs tab anyone acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyCents,
  yearlyCents,
  oneTimeTotalCents,
  fixedTotalCents,
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
