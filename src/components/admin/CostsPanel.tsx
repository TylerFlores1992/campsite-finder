'use client';

import { useState } from 'react';
import { Plus, Trash2, Pencil, Loader2 } from 'lucide-react';
import {
  BILLING_PERIODS,
  oneTimeTotalCents,
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
  mrrCents,
  monthLabel,
}: {
  initialItems: CostItem[];
  usage: UsageCounts;
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

  async function addRow() {
    const res = await fetch('/api/admin/costs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'New cost',
        category: 'other',
        amount_cents: 0,
        billing_period: 'monthly',
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

      {/* Fixed line items — read-only rows with explicit Edit / Remove */}
      <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-ch-display text-ch-h font-bold text-ch-ink">Fixed costs</h3>
          <button
            onClick={addRow}
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
              {items.map((it) =>
                editingId === it.id ? (
                  <EditRow
                    key={it.id}
                    item={it}
                    saving={savingId === it.id}
                    onCancel={() => setEditingId(null)}
                    onSave={(patch: Partial<CostItem>) => void saveRow({ ...it, ...patch })}
                  />
                ) : (
                  <tr key={it.id}>
                    <td className="py-2 pr-3 font-bold text-ch-ink">{it.label}</td>
                    <td className="py-2 pr-3 text-ch-ink-2 capitalize">{it.category}</td>
                    <td className="py-2 pr-3 text-ch-muted">{it.notes || '—'}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap text-ch-ink-2">
                      {fmtUSD(it.amount_cents)}
                      <span className="text-ch-muted">
                        {PERIOD_SUFFIX[it.billing_period] ?? ' / mo'}
                      </span>
                    </td>
                    {/* The derived figure, shown next to the billed one rather
                        than instead of it — the point of the yearly option is
                        being able to check a number against an invoice AND
                        still see what it costs per month. */}
                    <td className="py-2 pr-2 text-right font-bold whitespace-nowrap text-ch-ink">
                      {fmtUSD(monthlyCents(it))}
                    </td>
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
              )}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-ch-muted">
                    No cost items yet — add one.
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
              {/* Shown SEPARATELY from the fixed subtotal, never added to it. A
                  one-time cost has no run rate, so folding it into monthly burn
                  would overstate it forever and quietly move net margin — the one
                  figure on this tab anyone acts on. This is "spent to date". */}
              {oneTimeCents > 0 && (
                <>
                  <tr>
                    <td colSpan={4} className="pt-3 font-bold text-ch-muted">
                      One-time, to date
                    </td>
                    <td className="pt-3 text-right font-ch-display font-extrabold text-ch-ink">
                      {fmtUSD(oneTimeCents)}
                    </td>
                    <td />
                  </tr>
                  <tr>
                    <td colSpan={6} className="pt-1.5 text-ch-fine text-ch-muted">
                      Not part of the monthly or yearly totals — paid once, so it has no
                      run rate.
                    </td>
                  </tr>
                </>
              )}
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
}: {
  item: CostItem;
  saving: boolean;
  onSave: (patch: Partial<CostItem>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(item.label);
  const [category, setCategory] = useState(item.category);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [period, setPeriod] = useState<BillingPeriod>(item.billing_period);
  const [dollars, setDollars] = useState((item.amount_cents / 100).toString());

  const cents = Math.max(0, Math.round(Number(dollars) * 100) || 0);
  const perMonth = monthlyCents({ amount_cents: cents, billing_period: period });
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
      {/* Live, so you can see what a yearly figure works out to before saving. */}
      <td className="py-2 pr-2 text-right font-bold whitespace-nowrap text-ch-ink">
        {fmtUSD(perMonth)}
      </td>
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
