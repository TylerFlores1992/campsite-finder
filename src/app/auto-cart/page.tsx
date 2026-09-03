import Link from 'next/link';
import Logo from '@/components/Logo';
import { AUTOCART_BETA_NOTE, AUTOCART_BETA_SCOPE } from '@/lib/autocart-beta';

/**
 * "How does CampHawk actually grab the site for me?" — the one public page that answers it,
 * for BOTH lanes.
 *
 * IT DESCRIBED ONE LANE AND DENIED THE OTHER (corrected 2026-09-03). The page said
 * recreation.gov four times, ReserveCalifornia zero times, and carried a "Good to know" line
 * asserting that California state parks "aren't auto-carted". That has been wrong since the
 * RC day-before hold shipped on 2026-08-07 — and it was wrong on the single capability that
 * most separates this product from Campnab and Campflare, on the only page that exists to
 * explain it. It was also absent from `sitemap.ts`, so nothing pointed a crawler at it.
 *
 * WHY THE OLD LINE WAS HALF RIGHT, WHICH IS WHY IT IS CORRECTED RATHER THAN DELETED. Its
 * observation — a ReserveCalifornia cart does not follow you between sessions — is a real
 * measured finding (2026-08-06: a second session on the SAME account reads the bot's cart as
 * empty, because the cart is bound to the session that made it). The conclusion drawn from it
 * was what went stale. It is exactly why the RC design is hold-and-HAND-OFF rather than plain
 * auto-cart, so the fact belongs on the page — as the reason the two lanes differ.
 *
 * THE TWO LANES ARE DELIBERATELY NOT MERGED INTO ONE STORY. They are different mechanisms
 * with different consent models, and blurring them would misdescribe both:
 *
 *   recreation.gov     a standing watch-level toggle; carts whenever a watched site opens.
 *   ReserveCalifornia  no toggle at all. A hold is offered per release, the night before, and
 *                      only a tap authorises it — because the hold takes a real campsite off
 *                      the market for everybody else, and that is not a consent to collect
 *                      weeks in advance. `/new` states it the same way, with no switch.
 *
 * THE BETA WORDING IS COMPOSED, NEVER RESTATED. `AUTOCART_BETA_NOTE` and
 * `AUTOCART_BETA_SCOPE` come from `@/lib/autocart-beta`, which exists because
 * `AutoCartSettings` once carried its own paraphrase and the careful sentence quietly stopped
 * being the one people read.
 *
 * NO BETA BADGE HERE, DELIBERATELY, and it is not a dodge. `AUTOCART_BETA_LABEL` is a chip for
 * in-app surfaces where a whole sentence will not fit; on a help page there is room for the
 * sentence, which says more. It also keeps this file out of the badge-implies-note guard in
 * `worker/autocart-beta.test.mts`, whose file list is hardcoded — widening that selector is a
 * real improvement and belongs in its own change, not as a rider on a marketing page, because
 * touching anything under `worker/` restarts both poller machines.
 */

export const metadata = {
  title: 'Auto-cart for Recreation.gov and ReserveCalifornia cancellations · CampHawk',
  description:
    'How CampHawk grabs a cancelled campsite for you: automatic carting on Recreation.gov, ' +
    'and a day-before hold on ReserveCalifornia that carts the site within seconds of the ' +
    '8am release and hands it to you.',
  alternates: { canonical: 'https://camphawk.app/auto-cart' },
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ch-green text-white text-sm font-semibold">
        {n}
      </span>
      <div>
        <p className="font-ch-display font-semibold text-ch-ink">{title}</p>
        <div className="mt-1 text-sm text-ch-ink-2 leading-relaxed">{children}</div>
      </div>
    </li>
  );
}

export default function AutoCartHelpPage() {
  return (
    <div className="min-h-screen bg-[#F3EFE0]">
      <header
        // Same safe-area fix as /admin — this page is outside the (app) group too, so
        // nothing else supplies the status-bar inset. It is reachable from the auto-cart
        // setup flow in the app, so it can be the first screen a phone shows.
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
        className="bg-white border-b border-ch-line px-4 pb-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link href="/"><Logo markSize={30} /></Link>
          <Link href="/" className="text-sm text-ch-muted hover:text-ch-green-deep">← Back</Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        <div>
          <h1 className="font-ch-display text-3xl font-extrabold text-ch-green-deep">
            ⚡ Auto-cart — how it works
          </h1>
          <p className="mt-2 text-ch-ink-2 leading-relaxed">
            Finding the cancellation is only half of it. The other half is getting the site
            before somebody else does — and CampHawk can do that part for you on{' '}
            <strong>Recreation.gov</strong>{' '}and on{' '}<strong>ReserveCalifornia</strong>. They
            work differently, because the two booking systems do, so they are explained
            separately below.
          </p>
        </div>

        <section className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
          <h2 className="font-ch-display font-semibold text-ch-ink mb-3">What you need first</h2>
          <ul className="space-y-2 text-sm text-ch-ink-2">
            <li>✅ A{' '}<strong>CampHawk account</strong>{' '}on the{' '}
              <Link href="/pricing" className="underline hover:text-ch-green-deep">Auto-Cart plan</Link>,
              with at least one watch set up.
            </li>
            <li>✅ An account on the site you actually book on —{' '}
              <strong>Recreation.gov</strong>,{' '}<strong>ReserveCalifornia</strong>, or both.
            </li>
            <li>✅ Nothing else. Each lane takes one setup step, once.</li>
          </ul>
        </section>

        {/* ── Recreation.gov ─────────────────────────────────────────────────────────── */}
        <section className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
          <h2 className="font-ch-display font-semibold text-ch-ink mb-1">
            Recreation.gov — automatic carting
          </h2>
          <p className="mb-4 text-sm text-ch-ink-2 leading-relaxed">
            Cancellations on Recreation.gov happen at any hour, so this lane is a standing
            setting: once it is on, a watched site that frees up is added to your cart within
            seconds, whatever time it is.
          </p>
          <ol className="space-y-5">
            <Step n={1} title="Set your watches">
              Search for a campground, pick your dates, and tap{' '}
              <strong>Watch this campground</strong>{' '}on any booked site. Auto-cart only acts on
              sites you&apos;re watching.
            </Step>
            <Step n={2} title="Turn on auto-cart">
              Go to{' '}<strong>Settings</strong>{' '}and, under{' '}<strong>Auto-cart</strong>, tap{' '}
              <strong>Set up auto-cart</strong>. Once it&apos;s connected the same block gives you a{' '}
              <strong>Turn on</strong>{' '}/{' '}<strong>Turn off</strong>{' '}switch.
            </Step>
            <Step n={3} title="Sign in to Recreation.gov once">
              You enter your Recreation.gov email and password once. They&apos;re saved,{' '}
              <strong>encrypted, on a private machine we run</strong>{' '}— the always-on computer
              that holds your logged-in browser — so auto-cart signs back in by itself if the
              session drops.{' '}
              <strong>They never reach CampHawk&apos;s web servers or database.</strong>
            </Step>
            <Step n={4} title="You're done">
              From now on, when a watched site opens, it&apos;s added to your cart within seconds.
              You get your normal CampHawk alert — open Recreation.gov on your phone, and it&apos;s
              already in your cart. Just{' '}<strong>check out</strong>.
            </Step>
          </ol>
        </section>

        {/* ── ReserveCalifornia ──────────────────────────────────────────────────────── */}
        <section className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
          <h2 className="font-ch-display font-semibold text-ch-ink mb-1">
            ReserveCalifornia — a hold at the 8am release
          </h2>
          <p className="mb-4 text-sm text-ch-ink-2 leading-relaxed">
            California is different in a way that matters. When somebody cancels a
            ReserveCalifornia site, it usually does not go back on sale immediately — it is
            locked until the next morning&apos;s release, and then a lot of people are refreshing
            at once. So instead of watching for it all day, CampHawk spots the site the{' '}
            <strong>night before</strong>{' '}and offers to be there at the moment it frees.
          </p>
          <ol className="space-y-5">
            <Step n={1} title="Watch a ReserveCalifornia campground">
              There is nothing to switch on, and that is deliberate — see below. Just watch the
              park you want.
            </Step>
            <Step n={2} title="The evening before, we offer">
              When we see a site that is about to be released, you get an alert with a{' '}
              <strong>Hold it for me</strong>{' '}button.{' '}
              <strong>Nothing happens unless you tap it.</strong>
            </Step>
            <Step n={3} title="At the release, we cart it">
              At 8am, within a couple of seconds of the site actually freeing, our bot puts it
              in a cart — so it is off the market while you get to your phone, instead of gone
              to whoever refreshed fastest.
            </Step>
            <Step n={4} title="You take it over">
              Open the claim link, sign in to ReserveCalifornia, and tap{' '}
              <strong>hand it over</strong>. We release the site and your own session carts it,
              about two seconds later. Then you check out as normal.
            </Step>
          </ol>
          <div className="mt-5 rounded-xl border border-ch-line bg-[#F3EFE0] p-4 text-sm text-ch-ink-2 leading-relaxed">
            <p>{AUTOCART_BETA_NOTE}</p>
            <p className="mt-2">{AUTOCART_BETA_SCOPE}</p>
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
          <h2 className="font-ch-display font-semibold text-ch-ink mb-3">Good to know</h2>
          <ul className="space-y-2 text-sm text-ch-ink-2">
            <li>
              <strong>Why California needs the hand-off.</strong>{' '}A ReserveCalifornia cart
              belongs to the browser session that made it — a second session on the same
              account reads that cart as empty. So we cannot simply cart a site and leave it
              for you the way Recreation.gov allows; we hold it, you take it over, and the
              gap between those two is about two seconds.
            </li>
            <li>
              <strong>Holds are California only.</strong>{' '}CampHawk watches ten state park
              systems that run on the same booking software — Arizona, Florida, Illinois,
              Minnesota, Missouri, Nevada, Ohio, Virginia and Wyoming alongside California —
              and{' '}<strong>only ReserveCalifornia gets holds</strong>. For the others your
              alert carries a direct booking link: tap it on your phone and finish there. We
              would rather say so than offer a button we cannot honour.
            </li>
            <li>
              <strong>No standing setting on California, on purpose.</strong>{' '}A hold takes a
              real campsite off the market for everybody else watching it. That is not
              something to authorise weeks ahead in a settings screen, so it is authorised one
              release at a time, by you, the night before.
            </li>
            <li>
              <strong>One grab per site.</strong>{' '}Once a specific site is carted for you, it
              won&apos;t be re-added — but a different site opening in the same campground still will.
            </li>
            <li>
              <strong>Cancellations move fast.</strong>{' '}Getting it into your cart buys you time,
              but a cart is only held for a matter of minutes — check out promptly.
            </li>
            <li>
              This automates{' '}<em>your own</em>{' '}account for personal use. Keep your watches current
              so it knows what to grab.
            </li>
          </ul>
        </section>

        <div className="text-center">
          <Link
            href="/"
            className="inline-block px-6 py-3 rounded-2xl bg-ch-green hover:bg-ch-green-deep text-white font-ch-display font-semibold shadow-md transition-colors"
          >
            Go set up a watch →
          </Link>
        </div>
      </main>
    </div>
  );
}
