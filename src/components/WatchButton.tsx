'use client';

import { useState } from 'react';
import { Bell, Loader2, Check } from 'lucide-react';
import { useUser } from '@clerk/nextjs';
import { useIsNativeApp } from '@/lib/native/context';

interface WatchButtonProps {
  campgroundId: string;
  campgroundName: string;
  startDate: string;
  endDate: string;
  flexNights?: number;
  flexDays?: 'weekend';
  siteType?: string | null;
}

export default function WatchButton({ campgroundId, campgroundName, startDate, endDate, flexNights, flexDays, siteType }: WatchButtonProps) {
  const { isSignedIn } = useUser();
  const isNativeApp = useIsNativeApp();
  const [state, setState] = useState<'idle' | 'loading' | 'watching' | 'subscribe' | 'limit'>('idle');

  async function createWatch() {
    setState('loading');
    const res = await fetch('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campgroundId, startDate, endDate, siteType, flexNights, flexDays }),
    });
    if (res.status === 402) { setState('subscribe'); return; }
    if (res.status === 409) { setState('limit'); return; } // 10-watch cap reached
    if (res.ok) { setState('watching'); return; }
    setState('idle');
  }

  async function startCheckout(interval: 'monthly' | 'yearly') {
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (state !== 'idle') return;
    if (!isSignedIn) { window.location.href = '/sign-in'; return; }
    createWatch();
  }

  if (state === 'watching') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 font-medium">
        <Check size={12} /> Alert set
      </span>
    );
  }

  if (state === 'limit') {
    return (
      <span className="inline-flex items-center text-xs text-amber-700" onClick={(e) => e.stopPropagation()}>
        Watch limit reached (10) — remove one first.
      </span>
    );
  }

  if (state === 'subscribe') {
    // In the native app we can't sell the subscription (App/Play IAP rules) — point to
    // the web instead of showing Stripe checkout buttons.
    if (isNativeApp) {
      return (
        <span className="text-xs text-gray-500" onClick={(e) => e.stopPropagation()}>
          Subscribe at camphawk.app to set alerts.
        </span>
      );
    }
    return (
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-gray-500">Subscribe:</span>
        <button
          onClick={() => startCheckout('monthly')}
          className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
        >
          $2.50/mo
        </button>
        <button
          onClick={() => startCheckout('yearly')}
          className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
        >
          $20/yr
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      title={`Get notified when ${campgroundName} has availability`}
      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors disabled:opacity-50"
    >
      {state === 'loading' ? <Loader2 size={11} className="animate-spin" /> : <Bell size={11} />}
      {state === 'loading' ? 'Saving…' : 'Notify me'}
    </button>
  );
}
