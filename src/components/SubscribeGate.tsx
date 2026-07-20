'use client';

import { useState } from 'react';
import {
  Loader2,
  Clock,
  Zap,
  Map as MapIcon,
  Globe2,
  Check,
} from 'lucide-react';
import { SignInButton, SignUpButton } from '@clerk/nextjs';

/** Marketing panel + subscribe surfaces. One consistent pitch for every
 *  non-paying audience — the CTA is the only thing that changes:
 *
 *  - signed OUT            → sign-up / sign-in live in the header (clean landing)
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
    icon: Clock,
    title: 'Alerts in seconds',
    body: 'We watch booked campgrounds around the clock and email + text you the moment a site opens up — usually within seconds of the cancellation.',
    badge: null as string | null,
  },
  {
    icon: Zap,
    title: 'Auto-cart',
    body: 'Openings on recreation.gov can be added to your cart automatically. Your phone buzzes and the site is already waiting in your cart — just check out.',
    badge: 'NEW' as string | null,
  },
  {
    icon: MapIcon,
    title: 'Live search — free for everyone',
    body: 'Search thousands of campgrounds with real-time availability, an interactive map, and filters for tents, RVs, hookups, and pets. Try it right above — no subscription needed.',
    badge: null as string | null,
  },
  {
    icon: Globe2,
    title: 'Federal + state park coverage',
    body: 'Recreation.gov campgrounds nationwide — national parks, forests, and lakes — plus state parks in CA, TX, AZ, FL, NY, MN, and more. 5,500+ campgrounds and counting.',
    badge: null as string | null,
  },
];

const INCLUDED = [
  'Up to 10 active watches',
  'Instant email + text alerts',
  'recreation.gov Auto-cart',
];

function PricingButtons({ size = 'lg' }: { size?: 'lg' | 'sm' }) {
  const { loading, subscribe } = useCheckout();
  const base =
    size === 'lg'
      ? 'flex-1 px-5 py-3.5 rounded-2xl font-display font-semibold shadow-md transition-all hover:-translate-y-0.5 flex items-center justify-center gap-2 disabled:opacity-60 disabled:hover:translate-y-0'
      : 'px-3 py-1.5 rounded-lg font-display font-semibold text-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-60 whitespace-nowrap';
  return (
    <>
      <button
        onClick={() => subscribe('monthly')}
        disabled={!!loading}
        className={`${base} bg-white text-green-700 border border-green-200 hover:bg-green-50`}
      >
        {loading === 'monthly' ? <Loader2 size={size === 'lg' ? 16 : 12} className="animate-spin" /> : null}
        $2.50 / month
      </button>
      <button
        onClick={() => subscribe('yearly')}
        disabled={!!loading}
        className={`${base} relative bg-green-600 text-white hover:bg-green-700 ${
          size === 'lg' ? 'shadow-green-600/25 flex-col gap-0.5' : ''
        }`}
      >
        {loading === 'yearly' ? <Loader2 size={size === 'lg' ? 16 : 12} className="animate-spin" /> : null}
        {size === 'lg' ? (
          <>
            <span className="leading-tight">$20 / year</span>
            <span className="text-green-100 text-xs font-normal leading-tight">(save 33%)</span>
          </>
        ) : (
          <>
            $20 / year{' '}
            <span className="text-green-100 font-normal">(save 33%)</span>
          </>
        )}
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
    <div className="relative isolate min-h-full flex flex-col items-center text-center px-4 pt-12 sm:pt-16 pb-16 gap-10 sm:gap-12 overflow-y-auto">
      {/* Hero */}
      <div className="flex flex-col items-center gap-5 pt-2 max-w-3xl">
        <h1 className="font-serif text-4xl sm:text-6xl font-semibold text-green-800 leading-[1.05] text-balance [text-shadow:_0_1px_12px_rgb(250_247_242_/_0.8)]">
          {headline}
        </h1>
        <p className="text-gray-600 max-w-xl text-base sm:text-lg leading-relaxed text-pretty [text-shadow:_0_1px_8px_rgb(250_247_242_/_0.9)]">
          {subcopy}
        </p>
      </div>

      {/* Signed-out CTA — sits above the feature grid. Visitors need an account
          before checkout, so these route through Clerk sign-up / sign-in. */}
      {signedOut && (
        <div className="w-full max-w-md rounded-3xl bg-background/90 ring-1 ring-green-100 shadow-lg backdrop-blur-sm p-6 text-center">
          <p className="font-serif text-xl font-semibold text-green-800">
            Start your 7-day free trial
          </p>

          <ul className="mt-4 grid gap-2 text-left">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-center gap-2 text-sm text-gray-700">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100">
                  <Check size={12} className="text-green-700" />
                </span>
                {item}
              </li>
            ))}
          </ul>

          <div className="mt-5 flex flex-col gap-3">
            <SignUpButton mode="redirect">
              <button className="w-full px-5 py-3.5 rounded-2xl font-display font-semibold text-white bg-green-600 hover:bg-green-700 shadow-md shadow-green-600/25 transition-all hover:-translate-y-0.5">
                Start your free trial
              </button>
            </SignUpButton>
            <SignInButton mode="redirect">
              <button className="w-full px-5 py-3.5 rounded-2xl font-display font-semibold text-green-700 bg-white border border-green-200 hover:bg-green-50 transition-colors">
                Sign in
              </button>
            </SignInButton>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            7-day free trial · then $2.50/mo or $20/yr · cancel anytime
          </p>
        </div>
      )}

      {/* Feature grid — translucent cream cards over the hero scene */}
      <div className="grid sm:grid-cols-2 gap-5 w-full max-w-4xl text-left">
        {FEATURE_CARDS.map((f) => {
          const Icon = f.icon;
          return (
            <div
              key={f.title}
              className="group rounded-2xl bg-background/70 ring-1 ring-black/5 shadow-sm backdrop-blur-sm p-6 transition-all hover:bg-background/85 hover:shadow-md hover:-translate-y-0.5"
            >
              <div className="flex items-center gap-2.5">
                <Icon size={20} className="shrink-0 text-amber-600" />
                <h3 className="font-serif text-lg font-semibold text-green-800">{f.title}</h3>
                {f.badge && (
                  <span className="ml-1 text-[10px] font-bold tracking-wide text-white bg-amber-500 rounded-full px-2 py-0.5">
                    {f.badge}
                  </span>
                )}
              </div>
              <p className="mt-3 text-sm text-gray-600 leading-relaxed">{f.body}</p>
            </div>
          );
        })}
      </div>

      {/* CTA — checkout for signed-in users who need a subscription. Signed-out
          visitors convert through the Sign up button in the header (clean hero). */}
      {!signedOut && (
        <div className="w-full max-w-md rounded-3xl bg-background/90 ring-1 ring-green-100 shadow-lg backdrop-blur-sm p-6 text-left">
          <p className="font-serif text-xl font-semibold text-green-800">
            {returning ? 'Pick up where you left off' : 'Start your 7-day free trial'}
          </p>
          {!returning && (
            <p className="mt-1 text-sm text-gray-500">
              Then just <span className="font-semibold text-green-700">$2.50/mo</span> or{' '}
              <span className="font-semibold text-green-700">$20/yr</span>.
            </p>
          )}

          <ul className="mt-4 grid gap-2">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-center gap-2 text-sm text-gray-700">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-100">
                  <Check size={12} className="text-green-700" />
                </span>
                {item}
              </li>
            ))}
          </ul>

          <div className="mt-5 flex flex-col sm:flex-row gap-3">
            <PricingButtons size="lg" />
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {returning ? 'Cancel anytime.' : 'Free for 7 days · cancel anytime before you\u2019re charged.'}
          </p>
        </div>
      )}

      <p className="text-xs text-gray-500 [text-shadow:_0_1px_6px_rgb(250_247_242_/_0.9)]">
        © {new Date().getFullYear()} CampHawk ·{' '}
        <a href="/terms" className="underline underline-offset-2 hover:text-green-800">Terms</a> ·{' '}
        <a href="/privacy" className="underline underline-offset-2 hover:text-green-800">Privacy</a>
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
          : '🦅 You\u2019re browsing free — subscribe to watch booked sites and get instant alerts + Auto-cart.'}
      </span>
      <div className="flex items-center gap-2">
        <PricingButtons size="sm" />
      </div>
    </div>
  );
}
