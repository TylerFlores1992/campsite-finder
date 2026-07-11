'use client';

import { useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { UserButton } from '@clerk/nextjs';
import Logo from './Logo';

interface SubscribeGateProps {
  /** true if the user has subscribed before (expired/cancelled) → no free trial, "resubscribe" copy. */
  returning: boolean;
}

const FEATURES = [
  'Watch any booked campground and get alerted within seconds of a cancellation',
  'Recreation.gov (federal) + California State Parks',
  'Email & text notifications',
  'Links straight to the open site to book fast',
];

export default function SubscribeGate({ returning }: SubscribeGateProps) {
  const [loading, setLoading] = useState<'monthly' | 'yearly' | null>(null);

  async function subscribe(interval: 'monthly' | 'yearly') {
    setLoading(interval);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else setLoading(null);
    } catch {
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
        <Logo markSize={32} />
        <UserButton />
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-10 text-center">
        <div className="text-5xl mb-4">🦅</div>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-green-700 max-w-xl leading-tight">
          {returning ? 'Welcome back — reactivate to start watching' : 'Start watching campsites'}
        </h1>
        <p className="mt-3 text-gray-500 max-w-md">
          {returning
            ? 'Your subscription has ended. Resubscribe to set watches and get instant cancellation alerts again.'
            : 'Camp Hawk watches booked campgrounds around the clock and pings you the moment a cancellation opens up.'}
        </p>

        <ul className="mt-6 space-y-2 text-left max-w-md w-full">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
              <Check size={16} className="text-green-600 mt-0.5 shrink-0" />
              {f}
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-col sm:flex-row gap-3 w-full max-w-md">
          <button
            onClick={() => subscribe('monthly')}
            disabled={!!loading}
            className="flex-1 px-5 py-3.5 rounded-2xl bg-green-600 text-white font-display font-semibold shadow-md hover:bg-green-700 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
          >
            {loading === 'monthly' ? <Loader2 size={16} className="animate-spin" /> : null}
            $5 / month
          </button>
          <button
            onClick={() => subscribe('yearly')}
            disabled={!!loading}
            className="flex-1 px-5 py-3.5 rounded-2xl bg-amber-500 text-white font-display font-semibold shadow-md hover:bg-amber-600 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
          >
            {loading === 'yearly' ? <Loader2 size={16} className="animate-spin" /> : null}
            $50 / year <span className="text-amber-100 text-xs font-normal">(save 17%)</span>
          </button>
        </div>

        <p className="mt-4 text-sm text-gray-500">
          {returning ? 'Cancel anytime.' : '7-day free trial · cancel anytime before you’re charged.'}
        </p>
        <p className="mt-6 text-xs text-gray-400">
          <a href="/terms" className="underline">Terms</a> · <a href="/privacy" className="underline">Privacy</a>
        </p>
      </main>
    </div>
  );
}
