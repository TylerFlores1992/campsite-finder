// Cost model for the admin "Costs" tab. Two kinds of cost:
//  - FIXED line items (hosting/data/auth/comms subscriptions) — stored in the editable
//    `cost_items` table (migration 024), maintained by hand since these providers have
//    no simple billing API.
//  - USAGE costs (SMS / email / push) — computed live from the notifications table using
//    the per-unit rates below. SMS is the real variable cost; email/push default to $0
//    (covered by their plan / free), overridable via env.

export type CostCategory = 'hosting' | 'data' | 'auth' | 'comms' | 'other';

export const COST_CATEGORIES: CostCategory[] = ['hosting', 'data', 'auth', 'comms', 'other'];

export interface CostItem {
  id: string;
  label: string;
  category: string;
  monthly_cents: number;
  notes: string | null;
  sort_order: number;
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

export function fixedTotalCents(items: CostItem[]): number {
  return items.reduce((s, i) => s + (i.monthly_cents || 0), 0);
}

/** Format a cent amount as USD, e.g. 1234 -> "$12.34", -4583 -> "-$45.83". */
export function fmtUSD(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents) / 100;
  return `${sign}$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
