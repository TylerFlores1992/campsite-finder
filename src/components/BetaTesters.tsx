'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Check, Clock } from 'lucide-react';

interface Tester {
  email: string;
  added_at: string;
  signed_up: boolean;
  is_beta: boolean;
}

export default function BetaTesters() {
  const [testers, setTesters] = useState<Tester[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'invited'>('all');

  async function load() {
    try {
      const r = await fetch('/api/admin/beta');
      const d = await r.json();
      setTesters(d.testers ?? []);
    } catch {
      /* leave as-is */
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const v = email.trim();
    if (!v) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await fetch('/api/admin/beta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: v }),
      });
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error || 'Could not add'); return; }
      // Say whether the setup email actually went. Adding a tester sends one, and
      // a silent failure here means someone sits waiting for an invite that never
      // arrived — the exact problem the invite was added to solve.
      const res = (await r.json().catch(() => ({}))) as {
        invited?: boolean; alreadyListed?: boolean;
      };
      setNote(
        res.alreadyListed
          ? 'Already on the list — no second invite sent.'
          : res.invited
            ? 'Added, and the setup email is on its way.'
            : 'Added, but the setup email failed to send. Check the logs.',
      );
      setEmail('');
      await load();
    } catch {
      setError('Could not add');
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string) {
    if (!confirm(`Remove beta access for ${target}?`)) return;
    setTesters((t) => t.filter((x) => x.email !== target)); // optimistic
    try {
      await fetch('/api/admin/beta', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target }),
      });
    } finally {
      load();
    }
  }

  const activeCount = testers.filter((t) => t.signed_up).length;
  const invitedCount = testers.length - activeCount;
  const filtered =
    filter === 'active'
      ? testers.filter((t) => t.signed_up)
      : filter === 'invited'
        ? testers.filter((t) => !t.signed_up)
        : testers;

  return (
    <div className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-ch-display font-semibold text-ch-ink">Beta testers</h2>
        <span className="text-sm text-ch-muted">{testers.length} on the list</span>
      </div>

      <form onSubmit={add} className="flex gap-2 mb-4">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="tester@example.com"
          className="flex-1 rounded-xl border border-ch-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ch-green"
        />
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-xl bg-ch-green px-4 py-2 text-sm font-semibold text-white hover:bg-ch-green-deep disabled:opacity-60"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Add
        </button>
      </form>
      {error && <p className="mb-3 text-xs text-red-600">{error}</p>}
      {note && <p className="mb-3 text-xs text-ch-ink-2">{note}</p>}

      {!loading && testers.length > 0 && (
        <div className="inline-flex rounded-lg border border-ch-line p-0.5 mb-4 text-xs font-medium">
          {([
            ['all', 'All', testers.length],
            ['active', 'Active', activeCount],
            ['invited', 'Invited', invitedCount],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                filter === key ? 'bg-ch-green text-white' : 'text-ch-muted hover:text-ch-ink'
              }`}
            >
              {label} <span className={filter === key ? 'text-white/70' : 'text-ch-muted'}>{count}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-ch-muted text-sm py-4">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : testers.length === 0 ? (
        <p className="text-sm text-ch-muted py-2">No beta testers yet. Add an email above.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-ch-muted py-2">No {filter} testers.</p>
      ) : (
        <ul className="divide-y divide-ch-line">
          {filtered.map((t) => (
            <li key={t.email} className="flex items-center gap-3 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ch-ink truncate">{t.email}</p>
                <p className="text-[11px] text-ch-muted">
                  added {new Date(t.added_at).toLocaleDateString()}
                </p>
              </div>
              {t.signed_up ? (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-ch-green-deep bg-ch-green-soft border border-ch-green-soft rounded-full px-2 py-0.5"
                  title="Signed up and has beta access"
                >
                  <Check size={11} /> active
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-ch-muted bg-ch-paper border border-ch-line rounded-full px-2 py-0.5"
                  title="Pre-approved — access applies when they sign up"
                >
                  <Clock size={11} /> invited
                </span>
              )}
              <button
                onClick={() => remove(t.email)}
                className="text-ch-faint hover:text-red-500 transition-colors"
                title="Remove beta access"
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
