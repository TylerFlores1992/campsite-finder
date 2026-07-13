'use client';

import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';

/** Opt-in for the personal auto-cart bot. Flipping it on just enrolls the user
 *  (adds them to the bot's roster); the bot + a one-time rec.gov login still
 *  have to be set up by whoever runs the bot. */
export default function AutoCartToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/user/autocart')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function toggle() {
    const next = !enabled;
    setSaving(true);
    setEnabled(next); // optimistic
    try {
      const r = await fetch('/api/user/autocart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      setEnabled(!!d.enabled);
    } catch {
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
          <Zap size={13} className="text-amber-500" />
          Auto-cart openings
          <span className="text-[10px] font-normal text-gray-400">(beta)</span>
        </span>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Enable auto-cart"
          onClick={toggle}
          disabled={saving}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
            enabled ? 'bg-green-600' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-gray-400 leading-snug">
        {enabled
          ? 'On — your openings will be added to your recreation.gov cart by the CampHawk auto-cart bot. Requires the bot running + your one-time rec.gov login.'
          : 'Have openings auto-added to your recreation.gov cart via the CampHawk auto-cart bot (advanced).'}{' '}
        <a href="/auto-cart" target="_blank" className="text-green-700 underline underline-offset-2">
          How it works
        </a>
      </p>
    </div>
  );
}
