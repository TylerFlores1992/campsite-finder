'use client';

import { useState } from 'react';
import { Plus, Trash2, Pencil, Loader2 } from 'lucide-react';
import {
  BILLING_PERIODS,
  oneTimeTotalCents,
  lifetimeTotals,
  COST_CATEGORIES,
  monthlyCents,
  fixedTotalCents,
  fmtUSD,
  usageLines,
  usageTotalCents,
  type BillingPeriod,
  type CostItem,
  type UsageCounts,
} from '@/lib/costs';

const CHANNEL_LABEL: Record<string, string> = { sms: 'SMS (Twilio)', email: 'Email (Resend)', push: 'Push (FCM)' };

/** Suffix per billing period. "once", not "/ once", which would read as a rate. */
const PERIOD_SUFFIX: Record<BillingPeriod, string> = {
  monthly: ' / mo',
  yearly: ' / yr',
  one_time: ' once',
};

export default function CostsPanel({
  initialItems,
  usage,
  lifetimeUsage,
  mrrCents,
  monthLabel,
}: {
  initialItems: CostItem[];
  usage: UsageCounts;
  lifetimeUsage: UsageCounts;
  mrrCents: number | null;
  monthLabel: string;
}) {
  const [items, setItems] = useState<CostItem[]>(initialItems);
  const [savingId, setSavingId] = useState<string | null>(null);
  // One row at a time is editable. The previous version made every field an
  // always-live input that auto-saved on blur, which meant a stray click could
  // change a figure with no way to back out, and the delete button only appeared
  // on :hover — invisible on a touch screen.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const fixedCents = fixedTotalCents(items);
  const yearlyItemCount = items.filter((i) => i.billing_period === 'yearly').length;
  const oneTimeCents = oneTimeTotalCents(items);
  const lifetime = lifetimeTotals(items, lifetimeUsage);
  const recurringItems = items.filter((i) => i.billing_period !== 'one_time');
  const oneTimeItems = items.filter((i) => i.billing_period === 'one_time');
  const usageCents = usageTotalCents(usage);
  const totalCents = fixedCents + usageCents;
  const netCents = mrrCents == null ? null : mrrCents - totalCents;

  function patchLocal(id: string, patch: Partial<CostItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function saveRow(row: CostItem) {
    setSavingId(row.id);
    try {
      const res = await fetch('/api/admin/costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });
      if (res.ok) {
        const { item } = await res.json();
        if (item) patchLocal(row.id, item);
        setEditingId((cur) => (cur === row.id ? null : cur));
      }
    } finally {
      setSavingId((s) => (s === row.id ? null : s));
    }
  }

  // The period comes from WHICH table's button was pressed, so a row always lands in
  // the section you added it from. Defaulting everything to 'monthly' would drop new
  // one-time rows into the recurring table, where they would appear to vanish.
  async function addRow(billingPeriod: BillingPeriod = 'monthly') {
    const res = await fetch('/api/admin/costs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: billingPeriod === 'one_time' ? 'New one-time cost' : 'New cost',
        category: 'other',
        amount_cents: 0,
        billing_period: billingPeriod,
        sort_order: 999,
      }),
    });
    if (res.ok) {
      const { item } = await res.json();
      setItems((prev) => [...prev, item]);
      setEditingId(item.id);
    }
  }

  async function deleteRow(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    await fetch('/api/admin/costs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  }

  /**
   * One row, used by both tables. Shared so edit, confirm-then-remove and the
   * start/end date fields cannot drift apart between recurring and one-time —
   * duplicating ~90 lines of table markup is how those two quietly diverge.
   *
   * `perMonth` adds the derived monthly column, which only the recurring table has:
   * a cost paid once has no monthly figure, and monthlyCents() returns 0 for it, so
   * showing the column there would print a confident "$0.00" beside a real purchase.
   */
  const renderRows = (rows: CostItem[], showPerMonth: boolean) =>
    rows.map((it) =>
      editingId === it.id ? (
        <EditRow
          key={it.id}
          item={it}
          saving={savingId === it.id}
          onCancel={() => setEditingId(null)}
          onSave={(patch: Partial<CostItem>) => void saveRow({ ...it, ...patch })}
          showPerMonth={showPerMonth}
        />
      ) : (
        <tr key={it.id}>
          <td className="py-2 pr-3 font-bold text-ch-ink">{it.label}</td>
          <td className="py-2 pr-3 text-ch-ink-2 capitalize">{it.category}</td>
          <td className="py-2 pr-3 text-ch-muted">
            {it.notes || '—'}
            {/* Only meaningful where it drives accrual. */}
            {showPerMonth && !it.started_at && (
              <span className="ml-1 text-ch-fine text-ch-alert">no start date</span>
            )}
          </td>
          <td className="py-2 pr-3 text-right whitespace-nowrap text-ch-ink-2">
            {fmtUSD(it.amount_cents)}
            {showPerMonth && (
              <span className="text-ch-muted">{PERIOD_SUFFIX[it.billing_period] ?? ' / mo'}</span>
            )}
          </td>
          {/* The derived figure, shown next to the billed one rather than instead of
              it — the point of the yearly option is being able to check a number
              against an invoice AND still see what it costs per month. */}
          {showPerMonth && (
            <td className="py-2 pr-2 text-right font-bold whitespace-nowrap text-ch-ink">
              {fmtUSD(monthlyCents(it))}
            </td>
          )}
          <td className="w-[7.5rem] py-2 text-right">
            {confirmId === it.id ? (
              <span className="inline-flex items-center gap-1.5">
                <button
                  onClick={() => void deleteRow(it.id)}
                  className="cursor-pointer text-ch-fine font-bold text-ch-alert hover:underline"
                >
                  Remove
                </button>
                <button
                  onClick={() => setConfirmId(null)}
                  className="cursor-pointer text-ch-fine text-ch-muted hover:underline"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <button
                  onClick={() => {
                    setConfirmId(null);
                    setEditingId(it.id);
                  }}
                  aria-label={`Edit ${it.label}`}
                  className="cursor-pointer rounded-ch-input p-1.5 text-ch-muted hover:bg-ch-green-soft hover:text-ch-green-deep"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => setConfirmId(it.id)}
                  aria-label={`Remove ${it.label}`}
                  className="cursor-pointer rounded-ch-input p-1.5 text-ch-muted hover:bg-ch-alert-soft hover:text-ch-alert"
                >
                  <Trash2 size={14} />
                </button>
              </span>
            )}
          </td>
        </tr>
      )
    );

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Fixed / month" value={fmtUSD(fixedCents)} sub="editable line items" />
        <SummaryCard label={`Usage · ${monthLabel}`} value={fmtUSD(usageCents)} sub="SMS/email/push" />
        <SummaryCard label="Total / month" value={fmtUSD(totalCents)} sub="fixed + usage" accent="amber" />
        <SummaryCard
          label="Net / month"
          value={netCents == null ? '—' : fmtUSD(netCents)}
          sub={mrrCents == null ? 'MRR unavailable' : `MRR ${fmtUSD(mrrCents)} − cost`}
          accent={netCents == null ? undefined : netCents >= 0 ? 'green' : 'red'}
        />
      </div>

      {/* LIFETIME SPEND — "what has this cost me, ever", as opposed to the run rate
          above. Deliberately its own block and never folded into the monthly cards:
          mixing a cumulative total with a monthly one is how a $99 annual fee ends up
          looking like monthly burn.

          The unknown count is shown rather than hidden. Items without a start date
          contribute NOTHING here, so a total presented as complete would understate
          spend by however many rows are unset — and silently, which is the failure
          mode this panel already avoids elsewhere. */}
      <div className="rounded-ch-card border border-ch-line bg-ch-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-ch-body font-bold text-ch-ink">Lifetime spend</h3>
          <span className="font-ch-display text-ch-title font-extrabold text-ch-ink">
            {fmtUSD(lifetime.totalCents)}
          </span>
        </div>
        <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1 text-ch-meta sm:grid-cols-3">
          <div className="flex justify-between gap-2">
            <dt className="text-ch-muted">Recurring, accrued</dt>
            <dd className="font-bold text-ch-ink-2">{fmtUSD(lifetime.recurringCents)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ch-muted">One-time</dt>
            <dd className="font-bold text-ch-ink-2">{fmtUSD(lifetime.oneTimeCents)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ch-muted">Usage, all time</dt>
            <dd className="font-bold text-ch-ink-2">{fmtUSD(lifetime.usageCents)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-ch-fine leading-normal text-ch-muted">
          Recurring items are counted from their start date, billed in advance — so a plan
          that began this month counts once. A cancelled item stops accruing at its end date.
        </p>
        {lifetime.unknownCount > 0 && (
          <p className="mt-1.5 text-ch-fine leading-normal text-ch-alert">
            {lifetime.unknownCount === 1
              ? '1 item has no start date, so it is missing from this total.'
              : `${lifetime.unknownCount} items have no start date, so they are missing from this total.`}{' '}
            Set one via Edit to include it.
          </p>
        )}
      </div>

      {/* TWO TABLES, not one list with a mixed subtotal. A recurring charge and a
          one-off purchase answer different questions — "what do I pay each month"
          versus "what have I bought" — and the columns differ too: "Per month" is
          meaningless for something paid once, so the one-time table doesn't have it.
          Keeping them in one table meant every row carried a column that was wrong
          for half of them. Rows are rendered by one shared function so the edit,
          confirm-then-remove and date-field behaviour cannot drift between the two. */}
      <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-ch-display text-ch-h font-bold text-ch-ink">Recurring costs</h3>
          <button
            onClick={() => addRow('monthly')}
            className="inline-flex cursor-pointer items-center gap-1.5 text-ch-body font-bold text-ch-green hover:text-ch-green-deep"
          >
            <Plus size={16} /> Add cost
          </button>
        </div>
        <p className="mb-3 text-ch-fine text-ch-muted">
          Enter the amount you&apos;re actually billed. Yearly plans are divided by 12 for the
          monthly total, so what you type here matches the invoice.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-ch-body">
            <thead>
              <tr className="text-left text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
                <th className="pb-2">Item</th>
                <th className="pb-2">Category</th>
                <th className="pb-2">Notes</th>
                <th className="pb-2 text-right">Billed</th>
                <th className="pb-2 text-right">Per month</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ch-line">
              {renderRows(recurringItems, true)}
              {recurringItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-ch-muted">
                    No recurring costs yet — add one.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-ch-line">
                <td colSpan={4} className="pt-3 font-bold text-ch-muted">
                  Fixed subtotal
                </td>
                <td className="pt-3 text-right font-ch-display font-extrabold text-ch-ink">
                  {fmtUSD(fixedCents)}
                </td>
                <td />
              </tr>
              {yearlyItemCount > 0 && (
                <tr>
                  <td colSpan={6} className="pt-1.5 text-ch-fine text-ch-muted">
                    {`Includes ${yearlyItemCount} yearly ${
                      yearlyItemCount === 1 ? 'item' : 'items'
                    } divided by 12. Fixed costs are ${fmtUSD(fixedCents * 12)} a year.`}
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </div>

      {/* One-time — its own table, its own subtotal, never added to the monthly one */}
      <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-ch-display text-ch-h font-bold text-ch-ink">One-time costs</h3>
          <button
            onClick={() => addRow('one_time')}
            className="inline-flex cursor-pointer items-center gap-1.5 text-ch-body font-bold text-ch-green hover:text-ch-green-deep"
          >
            <Plus size={16} /> Add one-time
          </button>
        </div>
        <p className="mb-3 text-ch-fine text-ch-muted">
          Bought once — hardware, a developer enrolment, a domain transfer. These never enter
          the monthly or yearly totals, because they have no run rate.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-ch-body">
            <thead>
              <tr className="text-left text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
                <th className="pb-2">Item</th>
                <th className="pb-2">Category</th>
                <th className="pb-2">Notes</th>
                <th className="pb-2 text-right">Paid</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ch-line">
              {renderRows(oneTimeItems, false)}
              {oneTimeItems.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-ch-muted">
                    Nothing bought outright yet.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-ch-line">
                <td colSpan={3} className="pt-3 font-bold text-ch-muted">
                  Spent to date
                </td>
                <td className="pt-3 text-right font-ch-display font-extrabold text-ch-ink">
                  {fmtUSD(oneTimeCents)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Usage — computed, read-only */}
      <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
        <h3 className="font-ch-display text-ch-h font-bold text-ch-ink mb-1">Usage costs · {monthLabel}</h3>
        <p className="text-ch-fine text-ch-muted mb-4">
          Computed from alerts sent this month. Rates are estimates (override with COST_PER_SMS_USD etc.).
        </p>
        <table className="w-full text-ch-body">
          <thead>
            <tr className="text-left text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
              <th className="pb-2 font-medium">Channel</th>
              <th className="pb-2 font-medium text-right">Sent</th>
              <th className="pb-2 font-medium text-right">Rate</th>
              <th className="pb-2 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ch-line">
            {usageLines(usage).map((l) => (
              <tr key={l.channel}>
                <td className="py-2 text-ch-ink-2">{CHANNEL_LABEL[l.channel] ?? l.channel}</td>
                <td className="py-2 text-right text-ch-ink-2">{l.count.toLocaleString()}</td>
                <td className="py-2 text-right text-ch-muted">
                  {l.rate === 0 ? 'free' : `$${l.rate.toFixed(4)}`}
                </td>
                <td className="py-2 text-right font-medium text-ch-ink">{fmtUSD(l.costCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-ch-line">
              <td colSpan={3} className="pt-3 font-bold text-ch-muted">
                Usage subtotal
              </td>
              <td className="pt-3 text-right font-ch-display font-extrabold text-ch-ink">{fmtUSD(usageCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'green' | 'amber' | 'red';
}) {
  const color =
    accent === 'green'
      ? 'text-ch-green-deep'
      : accent === 'amber'
        ? 'text-ch-ochre-ink'
        : accent === 'red'
          ? 'text-ch-alert'
          : 'text-ch-ink';
  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <p className="text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">{label}</p>
      <p className={`mt-1 font-ch-display text-[24px] font-extrabold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-ch-fine text-ch-muted">{sub}</p>}
    </div>
  );
}


/**
 * One row, in edit mode.
 *
 * Local draft state, committed on Save — so an accidental keystroke or a change
 * of mind costs nothing. The old panel wrote every keystroke's blur straight to
 * the database with no way back.
 */
function EditRow({
  item,
  saving,
  onSave,
  onCancel,
  showPerMonth,
}: {
  item: CostItem;
  saving: boolean;
  onSave: (patch: Partial<CostItem>) => void;
  onCancel: () => void;
  /** Recurring table only — the one-time table has no "Per month" column, so the
   *  editing row must not emit that cell or every cell after it shifts left. */
  showPerMonth: boolean;
}) {
  const [label, setLabel] = useState(item.label);
  const [category, setCategory] = useState(item.category);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [period, setPeriod] = useState<BillingPeriod>(item.billing_period);
  const [dollars, setDollars] = useState((item.amount_cents / 100).toString());
  // Blank stays blank and saves as NULL. Defaulting to today would invent a start
  // date and with it a lifetime figure that looks measured but isn't.
  const [startedAt, setStartedAt] = useState(item.started_at ?? '');
  const [endedAt, setEndedAt] = useState(item.ended_at ?? '');

  const cents = Math.max(0, Math.round(Number(dollars) * 100) || 0);
  const perMonthCents = monthlyCents({ amount_cents: cents, billing_period: period });
  // NO WIDTH IN HERE. Two width utilities on one element resolve by the order
  // Tailwind emits them, not the order they're written — putting `w-full` in the
  // shared string and `w-16` on the element is a coin flip, and it lost.
  const field =
    'rounded-ch-input border border-ch-line bg-ch-card px-2 py-1 text-ch-body text-ch-ink focus:border-ch-green focus:outline-none';

  return (
    <tr className="bg-ch-green-soft/40">
      <td className="py-2 pr-3">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="Item name"
          autoFocus
          className={`${field} w-full min-w-0`}
        />
      </td>
      <td className="py-2 pr-3">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Category"
          className={`${field} w-full capitalize`}
        >
          {COST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-3">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="—"
          aria-label="Notes"
          className={`${field} w-full min-w-0`}
        />
        {/* Start/end live in the notes cell rather than getting their own columns —
            this table is already six columns wide on a phone. Start drives lifetime
            spend; end stops a cancelled item accruing forever. */}
        <span className="mt-1 flex flex-wrap items-center gap-1 text-ch-fine text-ch-muted">
          <label className="flex items-center gap-1">
            <span className="sr-only">Start date</span>
            <span aria-hidden="true">from</span>
            <input
              type="date"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              aria-label="Start date"
              className={`${field} w-[8.5rem] text-ch-fine`}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="sr-only">End date, if cancelled</span>
            <span aria-hidden="true">to</span>
            <input
              type="date"
              value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              aria-label="End date if cancelled"
              className={`${field} w-[8.5rem] text-ch-fine`}
            />
          </label>
        </span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center justify-end gap-1">
          <span className="text-ch-muted">$</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            aria-label="Amount billed"
            className={`${field} w-[4.5rem] text-right`}
          />
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as BillingPeriod)}
            aria-label="Billing period"
            className={`${field} w-[5.5rem] shrink-0`}
          >
            {BILLING_PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_SUFFIX[p]}
              </option>
            ))}
          </select>
        </div>
      </td>
      {/* Live, so you can see what a yearly figure works out to before saving.
          Omitted in the one-time table, which has no such column — emitting it there
          would push every following cell one place left and misalign the row. */}
      {showPerMonth && (
        <td className="py-2 pr-2 text-right font-bold whitespace-nowrap text-ch-ink">
          {fmtUSD(perMonthCents)}
        </td>
      )}
      <td className="w-[7.5rem] py-2 text-right">
        {/* Wraps rather than clipping: at a narrow width Cancel drops under Save
            instead of disappearing off the edge of the card. */}
        <span className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
          <button
            onClick={() =>
              onSave({
                label: label.trim() || item.label,
                category,
                notes: notes.trim() || null,
                amount_cents: cents,
                billing_period: period,
                started_at: startedAt || null,
                ended_at: endedAt || null,
              })
            }
            disabled={saving}
            className="cursor-pointer rounded-ch-input bg-ch-green px-2.5 py-1 text-ch-fine font-bold text-white hover:bg-ch-green-deep disabled:opacity-60"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : 'Save'}
          </button>
          <button
            onClick={onCancel}
            className="cursor-pointer text-ch-fine text-ch-muted hover:underline"
          >
            Cancel
          </button>
        </span>
      </td>
    </tr>
  );
}
