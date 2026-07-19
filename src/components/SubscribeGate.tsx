'use client';

import { useState } from 'react';
import {
  Loader2,
  Bell,
  Zap,
  Map as MapIcon,
  Tent,
  Check,
  Search,
  BellRing,
  ShieldCheck,
} from 'lucide-react';
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
    icon: Bell,
    iconClass: 'text-green-700',
    iconBg: 'bg-green-50 ring-green-100',
    title: 'Alerts in seconds',
    body: 'We watch booked campgrounds around the clock and email + text you the moment a site opens up — usually within seconds of the cancellation. Keep up to 10 active watches at a time.',
    badge: null as string | null,
  },
  {
    icon: Zap,
    iconClass: 'text-amber-600',
    iconBg: 'bg-amber-50 ring-amber-100',
    title: 'Auto-cart',
    body: 'Openings on recreation.gov can be added to your cart automatically. Your phone buzzes and the site is already waiting in your cart — just check out.',
    badge: 'NEW' as string | null,
  },
  {
    icon: MapIcon,
    iconClass: 'text-blue-600',
    iconBg: 'bg-blue-50 ring-blue-100',
    title: 'Live search — free for everyone',
    body: 'Search thousands of campgrounds with real-time availability, an interactive map, and filters for tents, RVs, hookups, and pets. Try it right above — no subscription needed.',
    badge: null as string | null,
  },
  {
    icon: Tent,
    iconClass: 'text-green-700',
    iconBg: 'bg-green-50 ring-green-100',
    title: 'Federal + state park coverage',
    body: 'Recreation.gov campgrounds nationwide — national parks, forests, and lakes — plus state parks in California, Texas, Arizona, Florida, New York, Oregon, Utah, North Carolina, Minnesota, and Missouri, with more rolling out. 5,500+ campgrounds and counting.',
    badge: null as string | null,
  },
];

const HOW_IT_WORKS = [
  {
    icon: Search,
    label: 'Search any campground',
    detail: 'Free, no account needed.',
  },
  {
    icon: BellRing,
    label: 'Watch the booked ones',
    detail: 'We monitor them 24/7.',
  },
  {
    icon: Zap,
    label: 'Grab the cancellation',
    detail: 'Instant alert + auto-cart.',
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
          size === 'lg' ? 'shadow-green-600/25' : ''
        }`}
      >
        {loading === 'yearly' ? <Loader2 size={size === 'lg' ? 16 : 12} className="animate-spin" /> : null}
        $20 / year{' '}
        <span className={size === 'lg' ? 'text-green-100 text-xs font-normal' : 'text-green-100 font-normal'}>
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
  const eyebrow = returning ? 'Your watches are paused' : 'Real-time cancellation alerts';

  return (
    <div className="relative isolate h-full flex flex-col items-center text-center px-4 pt-10 pb-16 gap-8 overflow-y-auto bg-[#F3EFE0]">
      {/* Same hero scene as ever, softened so cards stay legible */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/hero-bg.png" alt="" className="h-full w-full object-cover object-center" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#F3EFE0]/70 via-[#F3EFE0]/45 to-[#F3EFE0]/80" />
      </div>

      {/* Hero */}
      <div className="flex flex-col items-center gap-4 pt-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/90 border border-green-200 px-3 py-1 text-xs font-semibold text-green-700 shadow-sm backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-600" />
          </span>
          {eyebrow}
        </span>

        <h1 className="font-display text-3xl sm:text-5xl font-extrabold text-green-800 max-w-2xl leading-[1.1] text-balance [text-shadow:_0_1px_10px_rgb(255_255_255_/_0.7)]">
          {headline}
        </h1>
        <p className="text-gray-700 max-w-xl text-base sm:text-lg leading-relaxed text-pretty [text-shadow:_0_1px_8px_rgb(255_255_255_/_0.85)]">
          {subcopy}
        </p>

        {/* Trust / stats row */}
        <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-sm font-medium text-green-800">
          <span className="inline-flex items-center gap-1.5">
            <Tent size={15} className="text-green-700" /> 5,500+ campgrounds
          </span>
          <span aria-hidden className="text-green-300">•</span>
          <span className="inline-flex items-center gap-1.5">
            <Zap size={15} className="text-amber-600" /> Alerts in seconds
          </span>
          <span aria-hidden className="text-green-300">•</span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={15} className="text-green-700" /> Cancel anytime
          </span>
        </div>
      </div>

      {/* Feature grid */}
      <div className="grid sm:grid-cols-2 gap-3 w-full max-w-2xl text-left">
        {FEATURE_CARDS.map((f) => {
          const Icon = f.icon;
          return (
            <div
              key={f.title}
              className="group rounded-2xl bg-white/95 border border-gray-100 shadow-sm p-4 transition-all hover:shadow-md hover:-translate-y-0.5 hover:border-gray-200"
            >
              <div className="flex items-center gap-2.5">
                <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${f.iconBg}`}>
                  <Icon size={18} className={f.iconClass} />
                </span>
                <h3 className="font-display font-bold text-sm text-gray-900">{f.title}</h3>
                {f.badge && (
                  <span className="ml-auto text-[10px] font-bold text-white bg-amber-500 rounded-full px-1.5 py-0.5">
                    {f.badge}
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-sm text-gray-600 leading-relaxed">{f.body}</p>
            </div>
          );
        })}
      </div>

      {/* How it works — compact 3-step flow */}
      <div className="w-full max-w-2xl">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {HOW_IT_WORKS.map((step, i) => {
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className="flex items-center gap-3 rounded-2xl bg-white/70 border border-gray-100 px-4 py-3 text-left backdrop-blur-sm"
              >
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-600 text-white font-display font-bold text-sm">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-display font-semibold text-sm text-gray-900">
                    <Icon size={14} className="text-green-700 shrink-0" />
                    {step.label}
                  </p>
                  <p className="text-xs text-gray-500 leading-snug">{step.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* CTA card: auth for visitors, checkout for signed-in users */}
      <div className="w-full max-w-md rounded-3xl bg-white/95 border border-gray-100 shadow-lg ring-1 ring-green-100/60 p-6">
        <p className="font-display text-lg font-bold text-gray-900">
          {returning ? 'Pick up where you left off' : 'Start your 7-day free trial'}
        </p>
        {!returning && (
          <p className="mt-1 text-sm text-gray-500">
            Then just <span className="font-semibold text-green-700">$2.50/mo</span> or{' '}
            <span className="font-semibold text-green-700">$20/yr</span>.
          </p>
        )}

        {/* What's included */}
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

        {signedOut ? (
          <>
            <div className="mt-5 flex flex-col sm:flex-row gap-3">
              <SignUpButton mode="redirect">
                <button className="flex-1 px-5 py-3.5 rounded-2xl bg-green-600 hover:bg-green-700 text-white font-display font-semibold shadow-md shadow-green-600/25 transition-all hover:-translate-y-0.5">
                  Start your free trial
                </button>
              </SignUpButton>
              <SignInButton mode="redirect">
                <button className="flex-1 px-5 py-3.5 rounded-2xl bg-white border border-gray-200 text-gray-700 font-display font-semibold hover:bg-gray-50 transition-all">
                  Sign in
                </button>
              </SignInButton>
            </div>
            <p className="mt-3 text-xs text-gray-500">7-day free trial · then $2.50/mo or $20/yr · cancel anytime</p>
          </>
        ) : (
          <>
            <div className="mt-5 flex flex-col sm:flex-row gap-3">
              <PricingButtons size="lg" />
            </div>
            <p className="mt-3 text-xs text-gray-500">
              {returning ? 'Cancel anytime.' : 'Free for 7 days · cancel anytime before you\u2019re charged.'}
            </p>
          </>
        )}
      </div>

      <p className="text-xs text-gray-500 [text-shadow:_0_1px_6px_rgb(255_255_255_/_0.8)]">
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
