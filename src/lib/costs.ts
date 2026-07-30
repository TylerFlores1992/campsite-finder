// Cost model for the admin "Costs" tab. Two kinds of cost:
//  - FIXED line items (hosting/data/auth/comms subscriptions) — stored in the editable
//    `cost_items` table (migration 024), maintained by hand since these providers have
//    no simple billing API.
//  - USAGE costs (SMS / email / push) — computed live from the notifications table using
//    the per-unit rates below. SMS is the real variable cost; email/push default to $0
//    (covered by their plan / free), overridable via env.

export type CostCategory = 'hosting' | 'data' | 'auth' | 'comms' | 'other';

export const COST_CATEGORIES: CostCategory[] = ['hosting', 'data', 'auth', 'comms', 'other'];

export type BillingPeriod = 'monthly' | 'yearly' | 'one_time';

export const BILLING_PERIODS: BillingPeriod[] = ['monthly', 'yearly', 'one_time'];

/** Human label for the period selector and the line-item list. */
export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  monthly: 'per month',
  yearly: 'per year',
  one_time: 'one-time',
};

export interface CostItem {
  id: string;
  label: string;
  category: string;
  /**
   * The amount ON THE INVOICE, in cents — not normalised to a month. A yearly
   * plan stores the yearly figure, so it can be checked against the bill.
   * Divide with monthlyCents() for anything that sums or compares costs.
   */
  amount_cents: number;
  billing_period: BillingPeriod;
  notes: string | null;
  sort_order: number;
}

/**
 * A line item's cost per month.
 *
 * Everything that totals or compares costs MUST go through this. The column
 * holds the billed amount, so summing it raw would count a $20/year domain as
 * $20/month and overstate costs by 12x — silently, in the one figure (net
 * margin) you'd act on.
 */
export function monthlyCents(item: Pick<CostItem, 'amount_cents' | 'billing_period'>): number {
  const amount = item.amount_cents || 0;
  // A one-time cost has NO monthly figure. Returning the amount would add it to burn
  // every month forever; amortising it would need a purchase date and a lifetime this
  // table does not store, and a guessed lifetime moves net margin without saying so.
  // It is reported separately by oneTimeTotalCents().
  if (item.billing_period === 'one_time') return 0;
  return item.billing_period === 'yearly' ? Math.round(amount / 12) : amount;
}

/** Annualised, for the yearly view. */
export function yearlyCents(item: Pick<CostItem, 'amount_cents' | 'billing_period'>): number {
  const amount = item.amount_cents || 0;
  if (item.billing_period === 'one_time') return 0; // same reasoning as monthlyCents
  return item.billing_period === 'yearly' ? amount : amount * 12;
}

/**
 * Everything paid once, summed — "spent to date", not a run rate.
 *
 * Kept out of the recurring totals on purpose, so it can be shown without making
 * monthly burn or net margin wrong. Do not add this to fixedTotalCents().
 */
export function oneTimeTotalCents(items: CostItem[]): number {
  return items
    .filter((i) => i.billing_period === 'one_time')
    .reduce((s, i) => s + (i.amount_cents || 0), 0);
}

// Per-unit usage rates in USD. Env-overridable so they can be tuned without a deploy.
// Defaults: Twilio US outbound (~$0.0079) + typical carrier fee (~$0.0035) ≈ $0.0115.
export const USAGE_RATES = {
  sms: Number(process.env.COST_PER_SMS_USD ?? 0.0115),
  email: Number(process.env.COST_PER_EMAIL_USD ?? 0),
  push: Number(process.env.COST_PER_PUSH_USD ?? 0),
};

export type UsageChannel = 'sms' | 'email' | 'push';

export interface UsageCounts {
  sms: number;
  email: number;
  push: number;
}

export interface UsageLine {
  channel: UsageChannel;
  count: number;
  rate: number;
  costCents: number;
}

export function usageLines(counts: UsageCounts): UsageLine[] {
  return (Object.keys(USAGE_RATES) as UsageChannel[]).map((channel) => {
    const count = counts[channel] ?? 0;
    const rate = USAGE_RATES[channel];
    return { channel, count, rate, costCents: Math.round(count * rate * 100) };
  });
}

export function usageTotalCents(counts: UsageCounts): number {
  return usageLines(counts).reduce((s, l) => s + l.costCents, 0);
}

/** Fixed costs per month, with yearly items divided down. */
export function fixedTotalCents(items: CostItem[]): number {
  return items.reduce((s, i) => s + monthlyCents(i), 0);
}

/** Format a cent amount as USD, e.g. 1234 -> "$12.34", -4583 -> "-$45.83". */
export function fmtUSD(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents) / 100;
  return `${sign}$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
