'use client';

import { useState } from 'react';
import { MessageSquare, Loader2, Check } from 'lucide-react';

interface SmsOptInProps {
  /** Demo mode renders the exact same form without making API calls (for carrier review). */
  demo?: boolean;
  initialPhone?: string;
  initialSaved?: boolean;
  onSaved?: (phone: string | null) => void;
}

export default function SmsOptIn({ demo = false, initialPhone = '', initialSaved = false, onSaved }: SmsOptInProps) {
  const [phone, setPhone] = useState(initialPhone);
  const [consented, setConsented] = useState(initialSaved);
  const [saved, setSaved] = useState(initialSaved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (demo) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/user/phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? 'Could not save');
        setSaved(false);
      } else {
        setPhone(d.phone ?? '');
        setSaved(!!d.phone);
        onSaved?.(d.phone ?? null);
      }
    } catch {
      setError('Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
        <MessageSquare size={12} className="text-green-600" />
        Text alerts (optional)
      </label>

      <input
        type="tel"
        placeholder="(555) 123-4567"
        value={phone}
        onChange={(e) => {
          setPhone(e.target.value);
          setSaved(false);
        }}
        className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
      />

      <label className="flex items-start gap-2 text-xs text-gray-600 leading-snug cursor-pointer">
        <input
          type="checkbox"
          checked={consented}
          onChange={(e) => {
            setConsented(e.target.checked);
            setSaved(false);
          }}
          className="mt-0.5 accent-green-600"
        />
        <span>
          Yes, I&apos;d like to receive automated text messages from Camp Hawk when campgrounds
          I&apos;m watching have availability. Consent is not a condition of purchase.
        </span>
      </label>

      <p className="text-[11px] text-gray-400 leading-snug">
        <strong>Message frequency</strong> varies with campsite availability (typically at most one
        per watch). <strong>Message and data rates may apply.</strong> Reply <strong>HELP</strong>{' '}
        for help or <strong>STOP</strong> to cancel any time.{' '}
        <a href="/terms" className="underline" target="_blank">Terms of Service</a>
        {' · '}
        <a href="/privacy" className="underline" target="_blank">Privacy Policy</a>
      </p>

      <button
        onClick={save}
        disabled={saving || saved || !consented || !phone}
        className="w-full px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
      >
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : saved ? (
          <>
            <Check size={13} /> Signed up for texts
          </>
        ) : (
          'Yes, text me availability alerts'
        )}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
