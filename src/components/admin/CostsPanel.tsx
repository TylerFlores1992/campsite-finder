'use client';

import { useState } from 'react';
import { Plus, Trash2, Check, Loader2 } from 'lucide-react';
import {
  COST_CATEGORIES,
  fixedTotalCents,
  fmtUSD,
  usageLines,
  usageTotalCents,
  type CostItem,
  type UsageCounts,
} from '@/lib/costs';

const CHANNEL_LABEL: Record<string, string> = { sms: 'SMS (Twilio)', email: 'Email (Resend)', push: 'Push (FCM)' };

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
  const [savedId, setSavedId] = useState<string | null>(null);

  const fixedCents = fixedTotalCents(items);
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
        setSavedId(row.id);
        setTimeout(() => setSavedId((s) => (s === row.id ? null : s)), 1500);
      }
    } finally {
      setSavingId((s) => (s === row.id ? null : s));
    }
  }

  async function addRow() {
    const res = await fetch('/api/admin/costs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'New cost', category: 'other', monthly_cents: 0, sort_order: 999 }),
    });
    if (res.ok) {
      const { item } = await res.json();
      setItems((prev) => [...prev, item]);
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

      {/* Fixed line items — editable */}
      <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-ch-display text-ch-h font-bold text-ch-ink">Fixed monthly costs</h3>
          <button
            onClick={addRow}
            className="inline-flex items-center gap-1.5 text-ch-body font-bold text-ch-green hover:text-ch-green-deep"
          >
            <Plus size={16} /> Add cost
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-ch-body">
            <thead>
              <tr className="text-left text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
                <th className="pb-2 font-medium">Item</th>
                <th className="pb-2 font-medium">Category</th>
                <th className="pb-2 font-medium">Notes</th>
                <th className="pb-2 font-medium text-right">$/month</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ch-line">
              {items.map((it) => (
                <tr key={it.id} className="group">
                  <td className="py-2 pr-3">
                    <input
                      value={it.label}
                      onChange={(e) => patchLocal(it.id, { label: e.target.value })}
                      onBlur={() => saveRow(it)}
                      className="w-full min-w-[8rem] rounded-md border border-transparent hover:border-ch-line focus:border-ch-green focus:outline-none px-2 py-1 font-bold text-ch-ink"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={it.category}
                      onChange={(e) => {
                        patchLocal(it.id, { category: e.target.value });
                        saveRow({ ...it, category: e.target.value });
                      }}
                      className="rounded-md border border-ch-line focus:border-ch-green focus:outline-none px-2 py-1 text-ch-ink-2 bg-ch-card capitalize rounded-ch-input"
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
                      value={it.notes ?? ''}
                      onChange={(e) => patchLocal(it.id, { notes: e.target.value })}
                      onBlur={() => saveRow(it)}
                      placeholder="—"
                      className="w-full min-w-[8rem] rounded-md border border-transparent hover:border-ch-line focus:border-ch-green focus:outline-none px-2 py-1 text-ch-muted"
                    />
                  </td>
                  <td className="py-2 pr-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <span className="text-ch-muted">$</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={(it.monthly_cents / 100).toString()}
                        onChange={(e) =>
                          patchLocal(it.id, { monthly_cents: Math.max(0, Math.round(Number(e.target.value) * 100)) })
                        }
                        onBlur={() => saveRow(it)}
                        className="w-20 rounded-md border border-ch-line focus:border-ch-green focus:outline-none px-2 py-1 text-right text-ch-ink"
                      />
                    </div>
                  </td>
                  <td className="py-2 pl-1 w-10 text-right">
                    {savingId === it.id ? (
                      <Loader2 size={15} className="animate-spin text-ch-faint inline" />
                    ) : savedId === it.id ? (
                      <Check size={15} className="text-ch-green inline" />
                    ) : (
                      <button
                        onClick={() => deleteRow(it.id)}
                        className="text-ch-faint hover:text-ch-alert opacity-0 group-hover:opacity-100 transition"
                        title="Delete"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-ch-muted">
                    No cost items yet — add one.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-ch-line">
                <td colSpan={3} className="pt-3 font-bold text-ch-muted">
                  Fixed subtotal
                </td>
                <td className="pt-3 text-right font-ch-display font-extrabold text-ch-ink">{fmtUSD(fixedCents)}</td>
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
