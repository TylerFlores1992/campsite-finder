import Link from 'next/link';
import Logo from '@/components/Logo';
import { OPENINGS_STAT, OPENINGS_PERCENT } from '@/lib/openings-stat';

/**
 * "The campground I want is fully booked — now what?"
 *
 * WHY THIS PAGE AND NOT A HUNDRED OF THEM. The ask that produced it was to target the
 * problem rather than the campground name — "how to get a campsite that's sold out",
 * "campground fully booked what now" — and that instinct is sound and, importantly, is NOT
 * the bet that was already falsified. What failed on 2026-08-25 was retargeting the TITLES
 * of 6,934 existing facility pages onto "Cancellations" (see the header of `lib/seo.ts`);
 * the finding there was that our facility pages surface against discovery queries, which
 * says nothing about whether a dedicated problem page can rank. Those are different pages
 * answering different queries, and nothing in this repo has tested the second.
 *
 * SO IT IS TWO PAGES, NOT "a few dozen". A few dozen near-identical problem pages on a
 * two-month-old domain is the doorway-page pattern, and the site has already learned once
 * what happens when thin templating meets a query class with no demonstrated demand. Two
 * pages that are genuinely worth reading can be judged; forty cannot, and if they work the
 * next ones write themselves.
 *
 * THE HONEST CEILING, recorded so nobody reads a flat line as a bug. `docs/GROWTH.md` §6
 * establishes that the binding constraint is domain authority — nothing external links here
 * — so the expected outcome of this page in its first months is impressions at position ~50,
 * not clicks. It is worth having anyway: it is the page a human would link to, it is where
 * the measured statistic below lives, and it converts anybody who does land.
 *
 * THE STATISTIC IS THE REASON THIS IS NOT GENERIC ADVICE. Every competitor asserts that
 * cancellations happen. `lib/openings-stat` is a count of how often, taken from our own
 * hourly observations of 502 sold-out campgrounds. It is ours, it is checkable, and it is the
 * one thing on this page that cannot be copied from a blog.
 *
 * NO PRICES. This page is served inside the native apps' webview like everything else on
 * camphawk.app, and a price rendered there is a store-rules problem. It links to /pricing,
 * which handles that itself.
 */

export const metadata = {
  title: "Campground fully booked? How to get a sold-out campsite · CampHawk",
  description:
    'The campground you want is sold out. What actually works: how reservation windows ' +
    'open, why sites come back, how often we measured that happening, and how to be first ' +
    'when one does.',
  alternates: { canonical: 'https://camphawk.app/sold-out-campsite' },
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8">
      <h2 className="font-ch-display text-ch-title font-bold text-ch-ink">{title}</h2>
      <div className="mt-2 space-y-3 text-ch-body leading-relaxed text-ch-ink-2">{children}</div>
    </section>
  );
}

export default function SoldOutCampsitePage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <Link href="/" className="inline-block">
        <Logo />
      </Link>

      <h1 className="mt-6 font-ch-display text-ch-hero font-extrabold text-ch-green-deep">
        The campground is fully booked. Here&apos;s what actually works.
      </h1>
      <p className="mt-3 text-ch-body leading-relaxed text-ch-ink-2">
        Sold out is rarely final. Reservations get cancelled, held carts expire, and parks put
        inventory back. The problem is that the site is usually gone again within minutes, so
        the question is not whether one will appear — it is whether you will be looking at the
        moment it does.
      </p>

      <Section id="how-often" title="How often does a sold-out site actually come back?">
        <p>
          We can answer this with our own data rather than a guess. Between{' '}
          {OPENINGS_STAT.from} and {OPENINGS_STAT.to} we checked{' '}
          {OPENINGS_STAT.campgrounds.toLocaleString()} hard-to-book campgrounds every hour and
          counted only the moments when a stay that had been fully booked became bookable
          again — a real opening, not a stay that had simply never sold out.
        </p>
        <p>
          <strong>
            {OPENINGS_STAT.openings.toLocaleString()} openings across{' '}
            {OPENINGS_STAT.checks.toLocaleString()} checks — about {OPENINGS_PERCENT} of the
            time.
          </strong>{' '}
          That is the honest shape of it: on any given hour, almost certainly nothing. Over a
          few weeks of watching, quite often something. It is also why refreshing the booking
          page yourself is such poor odds — you would have to be looking during the one hour in
          a hundred that matters, and then be faster than everyone else looking too.
        </p>
        <p className="text-ch-meta text-ch-muted">
          That is a rate across a population of famously difficult campgrounds; your park will
          differ. We are not going to pretend it predicts yours.
        </p>
      </Section>

      <Section id="windows" title="First: check whether it is sold out, or just not open yet">
        <p>
          These are different problems and they look identical on the booking page. Most parks
          sell a rolling window — Recreation.gov and ReserveCalifornia both open reservations
          six months ahead — so a date beyond that window shows nothing available because
          nothing has been released, not because anyone booked it.
        </p>
        <p>
          If that is your situation, you do not need a cancellation at all. You need to be
          there when the window opens, which happens at a fixed local time and is over in
          seconds. We have measured ReserveCalifornia&apos;s 8am Pacific release to the second:
          sites flip from locked to bookable within a couple of seconds either side of 8:00:00.
        </p>
      </Section>

      <Section id="cancellations" title="Why sites come back at all">
        <p>
          Three things, and they behave differently:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Someone cancels.</strong> Most common as the trip gets close and plans
            change, but we see them at every lead time — including months out.
          </li>
          <li>
            <strong>A held cart expires.</strong> Someone put the site in a cart and did not
            check out. It comes back automatically, often within about fifteen minutes.
          </li>
          <li>
            <strong>The park releases inventory.</strong> Sites held back for maintenance,
            group bookings or walk-ups get returned to the pool, sometimes in batches.
          </li>
        </ul>
        <p>
          All three produce the same thing from your side: a site that was gone is suddenly
          bookable, usually without warning and usually not for long.
        </p>
      </Section>

      <Section id="what-works" title="What to actually do">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Widen the dates before you widen the park.</strong> A midweek night at the
            campground you want beats a Saturday at your third choice, and midweek openings are
            far easier to catch.
          </li>
          <li>
            <strong>Set the alert and stop refreshing.</strong> Watching by hand is the part
            that does not scale — see the numbers above.
          </li>
          <li>
            <strong>Be ready to book in under a minute.</strong> Be signed in to the
            reservation site in advance, with your details saved. The gap between an alert and
            the site being gone is measured in minutes.
          </li>
          <li>
            <strong>Do not stop watching once the alert arrives.</strong> If somebody beats you
            to it, the same site frequently frees again.
          </li>
        </ol>
      </Section>

      <Section id="camphawk" title="Where CampHawk fits">
        <p>
          We check every watched campground every 15 seconds, across Recreation.gov,
          ReserveCalifornia and eleven other state reservation systems, and text, email or push
          you the moment a stay you asked for becomes bookable.
        </p>
        <p>
          On Recreation.gov we can also{' '}
          <Link href="/auto-cart" className="font-semibold text-ch-green underline">
            put the site in your cart automatically
          </Link>{' '}
          — measured at about twelve seconds from the site opening to it being held for you —
          and on ReserveCalifornia we can hold a site through the 8am release and hand it over.
          That is the part a plain alert cannot do, because by the time you have read a text
          and opened an app, the fast people are already at checkout.
        </p>
        <p>
          <Link href="/search" className="font-semibold text-ch-green underline">
            Find your campground
          </Link>{' '}
          — searching is free. Watching and alerts are paid;{' '}
          <Link href="/pricing" className="font-semibold text-ch-green underline">
            see the plans
          </Link>
          .
        </p>
      </Section>

      <p className="mt-10 text-ch-fine text-ch-muted">
        CampHawk is an independent service and is not affiliated with, endorsed by or operated
        by Recreation.gov, the National Park Service, the US Forest Service, ReserveCalifornia
        or any state park agency. Reservation data comes from the sources listed on our{' '}
        <Link href="/sources" className="underline">
          data sources
        </Link>{' '}
        page.
      </p>
    </main>
  );
}
