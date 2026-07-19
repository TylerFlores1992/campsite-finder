'use client';

import { useState } from 'react';
import { Loader2, Bell, Zap, Map as MapIcon, Tent } from 'lucide-react';
import { SignInButton, SignUpButton } from '@clerk/nextjs';

/** Marketing panel + subscribe surfaces. One consistent pitch for every
 *  non-paying audience — the CTA is the only thing that changes:
 *
 *  - signed OUT            → sign-up / sign-in buttons
 *  - signed in, never paid → Stripe checkout buttons + trial copy
 *  - signed in, lapsed     → Stripe checkout buttons + resubscribe copy
 *
 *  Search stays free for everyone (the bar is right above in the header).
 *  - <SubscribeGate>   full panel shown in place of the landing hero
 *  - <SubscribeBanner> slim strip above search results so browsing stays open
 */

interface SubscribeGateProps {
  /** true if the user has subscribed before (expired/cancelled) → no free trial, "resubscribe" copy. */
  returning?: boolean;
  /** true for visitors with no account → auth CTAs instead of checkout. */
  signedOut?: boolean;
}

function useCheckout() {
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
  return { loading, subscribe };
}

const FEATURE_CARDS = [
  {
    icon: <Bell size={18} className="text-green-700" />,
    title: 'Alerts in seconds',
    body: 'We watch booked campgrounds around the clock and email + text you the moment a site opens up — usually within seconds of the cancellation. Keep up to 10 active watches at a time.',
    badge: null,
  },
  {
    icon: <Zap size={18} className="text-amber-500" />,
    title: 'Auto-cart',
    body: 'Openings on recreation.gov can be added to your cart automatically. Your phone buzzes and the site is already waiting in your cart — just check out.',
    badge: 'NEW',
  },
  {
    icon: <MapIcon size={18} className="text-green-700" />,
    title: 'Live search — free for everyone',
    body: 'Search thousands of campgrounds with real-time availability, an interactive map, and filters for tents, RVs, hookups, and pets. Try it right above — no subscription needed.',
    badge: null,
  },
  {
    icon: <Tent size={18} className="text-green-700" />,
    title: 'Federal + state park coverage',
    body: 'Recreation.gov campgrounds nationwide — national parks, forests, and lakes — plus state parks in California, Texas, Arizona, Florida, New York, Oregon, Utah, North Carolina, Minnesota, and Missouri, with more rolling out. 5,500+ campgrounds and counting.',
    badge: null,
  },
];

function PricingButtons({ size = 'lg' }: { size?: 'lg' | 'sm' }) {
  const { loading, subscribe } = useCheckout();
  const base =
    size === 'lg'
      ? 'flex-1 px-5 py-3.5 rounded-2xl font-display font-semibold shadow-md transition-all flex items-center justify-center gap-2 disabled:opacity-60'
      : 'px-3 py-1.5 rounded-lg font-display font-semibold text-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-60 whitespace-nowrap';
  return (
    <>
      <button
        onClick={() => subscribe('monthly')}
        disabled={!!loading}
        className={`${base} bg-green-600 text-white hover:bg-green-700`}
      >
        {loading === 'monthly' ? <Loader2 size={size === 'lg' ? 16 : 12} className="animate-spin" /> : null}
        $2.50 / month
      </button>
      <button
        onClick={() => subscribe('yearly')}
        disabled={!!loading}
        className={`${base} bg-amber-500 text-white hover:bg-amber-600`}
      >
        {loading === 'yearly' ? <Loader2 size={size === 'lg' ? 16 : 12} className="animate-spin" /> : null}
        $20 / year{' '}
        <span className={size === 'lg' ? 'text-amber-100 text-xs font-normal' : 'text-amber-100 font-normal'}>
          (save 33%)
        </span>
      </button>
    </>
  );
}

/** Full marketing panel — rendered where the landing hero normally goes, so the
 *  header (with the working search bar) stays right above it. */
export default function SubscribeGate({ returning = false, signedOut = false }: SubscribeGateProps) {
  const headline = signedOut
    ? 'Get notified the instant a campsite opens up'
    : returning
      ? 'Welcome back — reactivate your alerts'
      : 'Never miss a campsite cancellation again';
  const subcopy = signedOut
    ? 'Search thousands of campgrounds free — right above, no account needed. When your spot is booked solid, CampHawk watches it around the clock and alerts you within seconds of a cancellation.'
    : returning
      ? 'Your subscription has ended, so watching and alerts are paused. Searching still works — resubscribe to start catching cancellations again.'
      : 'Searching is free — try it right above. A subscription turns on the good part: 24/7 watching of booked campgrounds, instant email + text alerts, and Auto-cart.';

  return (
    <div className="relative isolate h-full flex flex-col items-center text-center px-4 pt-10 pb-16 gap-6 overflow-y-auto bg-[#F3EFE0]">
      {/* Same hero scene as ever, softened so cards stay legible */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/hero-bg.png" alt="" className="h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#F3EFE0]/60 via-[#F3EFE0]/40 to-[#F3EFE0]/70" />
      </div>

      <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-green-800 max-w-2xl leading-tight [text-shadow:_0_1px_10px_rgb(255_255_255_/_0.7)]">
        {headline}
      </h1>
      <p className="text-gray-700 max-w-xl text-base sm:text-lg leading-relaxed [text-shadow:_0_1px_8px_rgb(255_255_255_/_0.85)]">
        {subcopy}
      </p>

      {/* Feature grid */}
      <div className="grid sm:grid-cols-2 gap-3 w-full max-w-2xl text-left">
        {FEATURE_CARDS.map((f) => (
          <div key={f.title} className="rounded-2xl bg-white/95 border border-gray-100 shadow-sm p-4">
            <div className="flex items-center gap-2">
              {f.icon}
              <h3 className="font-display font-bold text-sm text-gray-900">{f.title}</h3>
              {f.badge && (
                <span className="text-[10px] font-bold text-white bg-amber-500 rounded-full px-1.5 py-0.5">
                  {f.badge}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm text-gray-600 leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>

      {/* CTA card: auth for visitors, checkout for signed-in users */}
      <div className="w-full max-w-md rounded-2xl bg-white/95 border border-gray-100 shadow-lg p-5">
        <p className="font-display font-bold text-gray-900">
          {returning ? 'Pick up where you left off' : 'Start your 7-day free trial'}
        </p>
        {signedOut ? (
          <>
            <div className="mt-3 flex flex-col sm:flex-row gap-3">
              <SignUpButton mode="redirect">
                <button className="flex-1 px-5 py-3.5 rounded-2xl bg-green-600 hover:bg-green-700 text-white font-display font-semibold shadow-md transition-all">
                  Start your free trial
                </button>
              </SignUpButton>
              <SignInButton mode="redirect">
                <button className="flex-1 px-5 py-3.5 rounded-2xl bg-white border border-gray-200 text-gray-700 font-display font-semibold hover:bg-gray-50 transition-all">
                  Sign in
                </button>
              </SignInButton>
            </div>
            <p className="mt-3 text-sm text-gray-500">7-day free trial · then $2.50/mo or $20/yr · cancel anytime</p>
          </>
        ) : (
          <>
            <div className="mt-3 flex flex-col sm:flex-row gap-3">
              <PricingButtons size="lg" />
            </div>
            <p className="mt-3 text-sm text-gray-500">
              {returning ? 'Cancel anytime.' : '7-day free trial · cancel anytime before you’re charged.'}
            </p>
          </>
        )}
      </div>

      <p className="text-xs text-gray-500 [text-shadow:_0_1px_6px_rgb(255_255_255_/_0.8)]">
        © {new Date().getFullYear()} CampHawk ·{' '}
        <a href="/terms" className="underline underline-offset-2">Terms</a> ·{' '}
        <a href="/privacy" className="underline underline-offset-2">Privacy</a>
      </p>
    </div>
  );
}

/** Slim persistent strip above search results for unsubscribed users — browsing
 *  stays open, the upgrade path stays one tap away. */
export function SubscribeBanner({ returning = false }: SubscribeGateProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 bg-amber-50 border-b border-amber-200 px-3 py-2">
      <span className="text-xs text-amber-900">
        {returning
          ? '⏸ Watching is paused — resubscribe to catch cancellations on booked sites.'
          : '🦅 You’re browsing free — subscribe to watch booked sites and get instant alerts + Auto-cart.'}
      </span>
      <div className="flex items-center gap-2">
        <PricingButtons size="sm" />
      </div>
    </div>
  );
}
