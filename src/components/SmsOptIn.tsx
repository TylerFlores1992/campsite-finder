'use client';

import { useState } from 'react';
import { MessageSquare, Loader2, Check } from 'lucide-react';

interface SmsOptInProps {
  /** Demo mode renders the exact same form without making API calls (for carrier review). */
  demo?: boolean;
  /** In compact mode (e.g. the Watches panel) the form collapses to a small CTA
   *  when unsigned, and to a one-line "on · Turn off" row once signed up. */
  compact?: boolean;
  initialPhone?: string;
  initialSaved?: boolean;
  onSaved?: (phone: string | null) => void;
}

export default function SmsOptIn({ demo = false, compact = false, initialPhone = '', initialSaved = false, onSaved }: SmsOptInProps) {
  const [phone, setPhone] = useState(initialPhone);
  const [consented, setConsented] = useState(initialSaved);
  const [saved, setSaved] = useState(initialSaved);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
        setExpanded(false);
        onSaved?.(d.phone ?? null);
      }
    } catch {
      setError('Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function turnOff() {
    if (demo) return;
    setSaving(true);
    setError(null);
    try {
      await fetch('/api/user/phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '' }),
      });
      setPhone('');
      setConsented(false);
      setSaved(false);
      setExpanded(false);
      onSaved?.(null);
    } catch {
      setError('Could not update');
    } finally {
      setSaving(false);
    }
  }

  // Compact + already signed up → one-line status with a turn-off button.
  if (compact && saved) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg bg-green-50 border border-green-100 px-3 py-2">
        <span className="flex items-center gap-1.5 min-w-0 text-xs text-green-800">
          <MessageSquare size={13} className="text-green-600 shrink-0" />
          <span className="truncate">Text alerts on · {phone}</span>
        </span>
        <button
          onClick={turnOff}
          disabled={saving}
          className="shrink-0 text-xs font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : 'Turn off'}
        </button>
      </div>
    );
  }

  // Compact + not signed up + collapsed → small CTA that expands the full form.
  if (compact && !expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-green-200 bg-green-50 text-green-700 text-xs font-medium px-3 py-2 hover:bg-green-100 transition-colors"
      >
        <MessageSquare size={13} />
        Add text alerts (optional)
      </button>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] leading-snug text-gray-600 bg-green-50 border border-green-100 rounded-lg px-2.5 py-2">
        <strong>Text alerts are optional.</strong> CampHawk works fully with email alerts alone —
        you never need to give a phone number to create an account, subscribe, or use any feature.
        Adding your number and checking the box below is entirely voluntary, and you can skip it.
      </p>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
          <MessageSquare size={12} className="text-green-600" />
          Text alerts (optional)
        </label>
        {compact && expanded && (
          <button
            onClick={() => setExpanded(false)}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Cancel
          </button>
        )}
      </div>

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
          Yes, I&apos;d like to receive automated text messages from CampHawk when campgrounds
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
