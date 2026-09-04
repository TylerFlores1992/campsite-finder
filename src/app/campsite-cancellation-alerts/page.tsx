import Link from 'next/link';
import Logo from '@/components/Logo';
import { OPENINGS_STAT, OPENINGS_PERCENT } from '@/lib/openings-stat';

/**
 * The category page: "campsite cancellation alert", "campground cancellation notification",
 * "campsite availability alerts". Somebody searching this has already decided they want a
 * tool and is choosing one — the highest-intent query class we have, and until now the site
 * had no page for it at all. `/auto-cart` explains one feature; `/` sells the product; there
 * was nothing that answers the category question.
 *
 * IT NAMES RECREATION.GOV'S OWN FREE ALERTS, DELIBERATELY. They have existed since July 2024
 * and anyone comparing tools finds them in a minute; a page that omits them reads as a page
 * that hopes you will not check. Saying it plainly costs nothing we were going to keep — the
 * visitor either wanted a free rec.gov-only alert, in which case we were never the answer, or
 * they want the two things that survive it, which is exactly what the page then leads with.
 *
 * NO PRICE COMPARISON, and this is a standing rule from `docs/GROWTH.md` §5 rather than a
 * stylistic choice: the free floor in this category is genuinely free and much larger than it
 * looks, so undercutting is not a wedge and putting it in copy invites the one comparison we
 * lose. The wedge is auto-cart and the thirteen non-recreation.gov systems.
 *
 * NO PRICES AT ALL, for the separate store-rules reason — this renders inside the native
 * webview. /pricing owns that.
 *
 * WHAT WOULD MAKE THIS PAGE WORK IS NOT ON IT. `docs/GROWTH.md` §6: nothing external links to
 * this domain, so the ceiling here is impressions rather than clicks until that changes. Do
 * not read a flat line as a content problem and rewrite it.
 */

export const metadata = {
  title: 'Campsite cancellation alerts: how they work and what to look for · CampHawk',
  description:
    'What a campsite cancellation alert service actually does, how quickly openings have to ' +
    'be caught, what recreation.gov gives away free, and the two things that separate ' +
    'services once you have looked.',
  alternates: { canonical: 'https://camphawk.app/campsite-cancellation-alerts' },
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8">
      <h2 className="font-ch-display text-ch-title font-bold text-ch-ink">{title}</h2>
      <div className="mt-2 space-y-3 text-ch-body leading-relaxed text-ch-ink-2">{children}</div>
    </section>
  );
}

export default function CancellationAlertsPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <Link href="/" className="inline-block">
        <Logo />
      </Link>

      <h1 className="mt-6 font-ch-display text-ch-hero font-extrabold text-ch-green-deep">
        Campsite cancellation alerts: how they work, and what actually differs
      </h1>
      <p className="mt-3 text-ch-body leading-relaxed text-ch-ink-2">
        A cancellation alert service watches a campground you could not book and tells you when
        a site frees up. Every one of them does that. What separates them is how fast they
        notice, which reservation systems they can see, and whether they can do anything about
        it other than tell you.
      </p>

      <Section id="how" title="How they work">
        <p>
          Reservation systems publish availability, so a service polls that availability on a
          loop and compares it with the last look. When a stay you asked for goes from booked
          to bookable, it sends you a text, an email or a push notification with a link.
        </p>
        <p>
          The whole game is the loop interval and what happens next. A service checking every
          few minutes will genuinely find you openings on quiet campgrounds; on a contested one
          it will reliably tell you about a site somebody else has already taken.
        </p>
      </Section>

      <Section id="speed" title="How much speed matters, in numbers">
        <p>
          Between {OPENINGS_STAT.from} and {OPENINGS_STAT.to} we watched{' '}
          {OPENINGS_STAT.campgrounds.toLocaleString()} hard-to-book campgrounds every hour and
          counted only genuine openings — a stay that had been fully booked becoming bookable
          again. It happened {OPENINGS_STAT.openings.toLocaleString()} times in{' '}
          {OPENINGS_STAT.checks.toLocaleString()} checks, about {OPENINGS_PERCENT} of them.
        </p>
        <p>
          Rare, in other words, and then gone quickly. That is why the interval is the
          specification worth reading and why &ldquo;we check often&rdquo; is not an answer.
          CampHawk checks every 15 seconds, continuously.
        </p>
      </Section>

      <Section id="free" title="Check the free option first — we mean it">
        <p>
          Recreation.gov has had its own availability alerts since 2024. They are free, they
          cover every reservable Recreation.gov location, and you are limited to a few active
          alerts at a time. If your trip is a Recreation.gov campground and you are happy to
          race everyone else to the booking page, start there. You should not pay for something
          the booking system gives away.
        </p>
        <p>
          There are free tiers elsewhere in this category too. It is worth ten minutes to check
          whether one covers you before paying anybody, including us.
        </p>
      </Section>

      <Section id="difference" title="The two things that survive that">
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            <strong>State reservation systems.</strong>{' '}
            Recreation.gov&apos;s alerts only cover
            Recreation.gov. A large share of the campgrounds people cannot book are on state
            systems — ReserveCalifornia above all, plus a dozen others — and those systems do
            not offer alerts of their own. CampHawk watches{' '}
            <Link href="/sources" className="font-semibold text-ch-green underline">
              fourteen sources
            </Link>
            , and that is where most of what we find lives.
          </li>
          <li>
            <strong>Doing something about it, not just telling you.</strong> An alert still
            requires you to be holding your phone. On Recreation.gov we can{' '}
            <Link href="/auto-cart" className="font-semibold text-ch-green underline">
              put the site in your cart for you
            </Link>{' '}
            — around twelve seconds from the opening appearing — and on ReserveCalifornia we can
            hold a site through the 8am release and hand it to you. Recreation.gov will never
            build that; it would be carting against itself.
          </li>
        </ol>
      </Section>

      <Section id="checklist" title="What to ask of any service, including this one">
        <ul className="list-disc space-y-2 pl-5">
          <li>How often does it actually check, in seconds?</li>
          <li>Does it cover your reservation system, or only Recreation.gov?</li>
          <li>Can it handle flexible dates, or only one exact stay?</li>
          <li>Does it text you, or only email? An email at 3am is not an alert.</li>
          <li>Does it do anything beyond notifying you?</li>
          <li>Can you cancel in one click without emailing anybody?</li>
        </ul>
      </Section>

      <Section id="start" title="If you want to try ours">
        <p>
          Searching is free — you can check availability across all fourteen systems without an
          account.{' '}
          <Link href="/search" className="font-semibold text-ch-green underline">
            Find your campground
          </Link>
          , and if it is booked out,{' '}
          <Link href="/sold-out-campsite" className="font-semibold text-ch-green underline">
            here is what actually works
          </Link>
          . Watching and alerts are paid;{' '}
          <Link href="/pricing" className="font-semibold text-ch-green underline">
            the plans are here
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
