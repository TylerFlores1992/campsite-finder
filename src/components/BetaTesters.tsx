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
    try {
      const r = await fetch('/api/admin/beta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: v }),
      });
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error || 'Could not add'); return; }
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

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-display font-semibold text-gray-800">Beta testers</h2>
        <span className="text-sm text-gray-500">{testers.length} on the list</span>
      </div>

      <form onSubmit={add} className="flex gap-2 mb-4">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="tester@example.com"
          className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
        />
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Add
        </button>
      </form>
      {error && <p className="mb-3 text-xs text-red-600">{error}</p>}

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : testers.length === 0 ? (
        <p className="text-sm text-gray-400 py-2">No beta testers yet. Add an email above.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {testers.map((t) => (
            <li key={t.email} className="flex items-center gap-3 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 truncate">{t.email}</p>
                <p className="text-[11px] text-gray-400">
                  added {new Date(t.added_at).toLocaleDateString()}
                </p>
              </div>
              {t.signed_up ? (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5"
                  title="Signed up and has beta access"
                >
                  <Check size={11} /> active
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-500 bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5"
                  title="Pre-approved — access applies when they sign up"
                >
                  <Clock size={11} /> invited
                </span>
              )}
              <button
                onClick={() => remove(t.email)}
                className="text-gray-300 hover:text-red-500 transition-colors"
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
