import type { Metadata } from "next";
import Link from "next/link";
import { Bell, Clock, MapPin, ShoppingCart, Zap } from "lucide-react";
import { buttonClasses } from "@/components/ui/Button";
import Pricing from "@/components/v2/Pricing";
import { COVERAGE, campgroundsRounded } from "@/lib/coverage";
import { SITE_NAME } from "@/lib/seo";

/**
 * The marketing home — what `/` becomes at the route swap.
 *
 * WHY THIS EXISTS AS A SEPARATE PAGE FROM SEARCH. Every other screen in the
 * redesign replaced a live one; the homepage didn't have a counterpart, and the
 * live `/` does two jobs at once — it sells the product and it searches. Folding
 * both into Explore would have handed the search screen a sales pitch that
 * subscribers see forever, or dropped the pitch entirely and taken the funnel
 * with it. So they split: this sells, /v2/search searches, and the hero sends
 * people to the second one in one tap.
 *
 * SERVER-RENDERED, ON PURPOSE. This is the page Google indexes first and the
 * one that carries the site's <h1>. Everything above the fold is static markup —
 * only the pricing controls are client-side, because they need to know who's
 * reading. The live homepage renders its entire pitch client-side inside a
 * Clerk-gated branch, which is the same defect the campground pages had.
 *
 * No request-time APIs here. Under this build's Cache Components model a
 * dynamic API in a layout without a Suspense boundary throws at request time and
 * 500s every page — it caused a full outage in July. A page is safe, but there's
 * nothing here that needs one anyway.
 */

const title = `${SITE_NAME} — Campsite availability and cancellation alerts`;
const description =
  "Live campsite availability at 8,000+ campgrounds nationwide. See what's open tonight, and get alerted within seconds when a booked site is cancelled.";

export const metadata: Metadata = {
  title,
  description,
  robots: { index: false, follow: false }, // dark-launched; lifts at the swap
};

const FEATURES = [
  {
    icon: Clock,
    title: "Alerts in seconds",
    body: "We check watched campgrounds every 15 seconds, around the clock. When someone cancels, you hear about it before the site is back in circulation — not the next morning.",
  },
  {
    icon: ShoppingCart,
    title: "Auto-cart on Recreation.gov",
    body: "We can put the opening straight into your cart, so it's held while you get to your phone. You just check out.",
  },
  {
    icon: MapPin,
    title: "Live search — free, no account",
    body: `Real-time availability at ${campgroundsRounded()} campgrounds, on a map, with filters for tents, RVs, hookups and pets. No subscription, no sign-up.`,
  },
  {
    icon: Zap,
    title: "Flexible dates find more",
    body: "Say how many nights you need and a window to look in. Any three nights in September gives us far more chances to catch a cancellation than one fixed weekend.",
  },
];

export default function V2HomePage() {
  return (
    <div>
      {/* ---------------------------------------------------------- hero */}
      <section className="mx-auto max-w-[var(--ch-max)] px-5 pt-10 pb-6 sm:pt-16">
        <h1 className="max-w-[16ch] font-ch-display text-[clamp(30px,5vw,44px)] font-extrabold leading-[1.03] tracking-[-.035em] text-ch-ink">
          The campsite you wanted is already booked. We wait for it.
        </h1>
        <p className="mt-4 max-w-[56ch] text-[15px] leading-relaxed text-ch-ink-2">
          {`CampHawk watches booked campgrounds around the clock and tells you the second someone cancels — usually within seconds. Live search across ${campgroundsRounded()} campgrounds is free and needs no account.`}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/v2/search" className={buttonClasses({ size: "lg", className: "px-6" })}>
            Search campgrounds free
          </Link>
          <Link
            href="/v2/watches"
            className={buttonClasses({ variant: "quiet", size: "lg", className: "px-6" })}
          >
            See what a watch does
          </Link>
        </div>

        <p className="mt-4 text-ch-fine text-ch-muted">
          {`Every Recreation.gov campground in all ${COVERAGE.states} states, plus state parks in ${COVERAGE.stateParkStates}.`}
        </p>
      </section>

      {/* ------------------------------------------------------- features */}
      <section className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
        <div className="grid gap-3 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title: t, body }) => (
            <div
              key={t}
              className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card"
            >
              <span className="grid size-9 place-items-center rounded-full bg-ch-green-soft text-ch-green-deep">
                <Icon aria-hidden="true" className="size-4.5" />
              </span>
              <h2 className="mt-2.5 font-ch-display text-ch-h font-bold">{t}</h2>
              <p className="mt-1 text-ch-body leading-relaxed text-ch-ink-2">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------- how it works */}
      <section className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
        <h2 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          How it works
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            [
              "Find the campground",
              "Search by place and dates. If sites are open you'll see them right there — that part's free.",
            ],
            [
              "Watch it if it's full",
              "One tap. Pick exact dates, or any N nights inside a window you're free.",
            ],
            [
              "Get the site",
              "Text, email and push the moment it opens — and on Recreation.gov it can already be in your cart.",
            ],
          ].map(([t, body], i) => (
            <li key={t} className="rounded-ch-card border border-ch-line bg-ch-card p-4">
              <span className="grid size-6 place-items-center rounded-full bg-ch-green-soft text-[12px] font-extrabold text-ch-green-deep">
                {i + 1}
              </span>
              <p className="mt-2 text-ch-body font-bold">{t}</p>
              <p className="mt-1 text-ch-fine leading-normal text-ch-muted">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* -------------------------------------------------------- pricing */}
      <section className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
        <div className="rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-5 sm:p-6">
          {/* LAUNCH PRICING IS A PROMISE ABOUT THE FUTURE, so it says "while
              we're new" rather than putting a countdown on it. Manufactured
              urgency — a deadline that never arrives, or a "was" price that was
              never charged — is the thing that makes pricing copy untrustworthy,
              and this is the screen where trust converts. If the price does go
              up, this line is already true; if it never does, nobody was lied
              to. */}
          <span className="inline-block rounded-ch-chip bg-white px-3 py-1 text-ch-label font-bold tracking-[.1em] text-ch-green-deep uppercase">
            Launch pricing
          </span>
          <h2 className="mt-2.5 font-ch-display text-ch-title font-extrabold tracking-[-.03em] text-ch-green-deep">
            Searching is free. Watching is $2.50 a month, or $20 a year.
          </h2>
          <p className="mt-2 max-w-[58ch] text-ch-body leading-relaxed text-ch-green-deep">
            One subscription covers up to 10 watches at once, text and email alerts, and auto-cart
            on Recreation.gov. Cancel any time — and live search keeps working either way.
          </p>
          <p className="mt-2 max-w-[58ch] text-ch-meta leading-normal text-ch-green-deep">
            This is introductory pricing while we&apos;re new, and it will go up as we add
            campgrounds and states. Subscribe now and you keep the rate you signed up at for as
            long as your subscription runs.
          </p>
          <div className="mt-4">
            <Pricing />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- honest limits */}
      <section className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
        <div className="rounded-ch-card border border-ch-line bg-ch-card p-4">
          <h2 className="font-ch-display text-ch-h font-bold">What we don&apos;t do</h2>
          {/* Worth the space. The objection a sceptical visitor is already
              holding is "so it books things for me without asking?" — answering
              it before they ask converts better than another benefit would. */}
          <ul className="mt-2 max-w-[62ch]">
            {[
              "We never book or pay for anything. Checkout is always yours, on the provider's site.",
              "We can't create availability — if nobody cancels, there's nothing to find.",
              "We can't cancel or change a reservation you already have.",
            ].map((line) => (
              <li
                key={line}
                className="flex gap-2 border-b border-ch-line py-2 text-ch-body leading-normal text-ch-ink-2 last:border-b-0"
              >
                <span aria-hidden="true" className="text-ch-muted">
                  —
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------------------------------------------------- close */}
      <section className="mx-auto max-w-[var(--ch-max)] px-5 pt-2 pb-10">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/v2/search" className={buttonClasses({ size: "lg", className: "px-6" })}>
            <Bell aria-hidden="true" className="size-4" />
            Find a campsite
          </Link>
          <Link
            href="/camping"
            className="text-ch-body font-bold text-ch-green hover:text-ch-green-deep"
          >
            Or browse campgrounds by state
          </Link>
        </div>
      </section>
    </div>
  );
}
