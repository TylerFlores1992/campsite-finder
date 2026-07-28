import Link from 'next/link';
import Logo from '@/components/Logo';

export const metadata = {
  title: 'Support — CampHawk',
  description:
    'Help with CampHawk: alerts that never arrived, text messages, subscriptions, auto-cart, and deleting your account.',
  alternates: { canonical: 'https://camphawk.app/support' },
};

/**
 * Support page — the App Store's required Support URL, and a genuinely useful
 * page rather than a compliance stub.
 *
 * It answers the questions people actually write in about, in the order they get
 * asked, so most of them never need to send the email. The "alerts didn't arrive"
 * checklist is first because it is the one failure that matters: someone paid for
 * notifications and didn't get one.
 *
 * NO PRICES ON THIS PAGE, deliberately. It is reachable from inside the native
 * app (any webview page is), and Apple and Google forbid an app showing the price
 * of a subscription sold outside their in-app purchase. Everything here talks
 * about *managing* a subscription, never what it costs — so the page is safe in
 * both places and needs no native variant. See docs/CONTEXT.md → store-billing.
 *
 * Must be listed in `isPublicRoute` (src/middleware.ts) or Clerk's auth.protect()
 * returns 404 to signed-out visitors — which is every App Review reviewer.
 */
export default function SupportPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-10 text-ch-ink">
      <Link href="/" className="inline-block mb-6">
        <Logo markSize={30} />
      </Link>
      <h1 className="text-2xl font-bold mb-1">CampHawk Support</h1>
      <p className="text-sm text-ch-muted mb-8">
        Email{' '}
        <a href="mailto:alerts@camphawk.app" className="text-ch-green-deep underline">
          alerts@camphawk.app
        </a>{' '}
        and a human will answer. Most questions are below.
      </p>

      <div className="space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="font-semibold text-base mb-2">What CampHawk does</h2>
          <p>
            Searching live campground availability is free and needs no account. If the dates you
            want are already booked, you can set a <strong>watch</strong>: we check that campground
            every 15 seconds, around the clock, and alert you the moment someone cancels — usually
            within seconds. You book on the official reservation site; CampHawk is not affiliated
            with Recreation.gov, ReserveCalifornia, or any state park system.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">I didn&apos;t get an alert</h2>
          <p className="mb-2">Work down this list — it is almost always one of these:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong>Check the watch is still active.</strong> Open Watches. A watch that was
              stopped, or that has passed its dates, no longer checks anything.
            </li>
            <li>
              <strong>Check your email spam folder.</strong> Email alerts always send; they
              occasionally get filtered. Add our sending address to your contacts.
            </li>
            <li>
              <strong>Text alerts need your number saved.</strong> Settings → How we reach you.
              Entering the number and agreeing to the consent box is what turns texts on; nothing
              else does.
            </li>
            <li>
              <strong>Push needs permission.</strong> In the app, check CampHawk is allowed to send
              notifications in your phone&apos;s settings. We only ask after your first watch
              exists, so it is easy to have never been asked.
            </li>
            <li>
              <strong>Nobody cancelled.</strong> The unglamorous answer. A popular weekend can go
              its whole run with no cancellation — we alert when one happens, we can&apos;t make
              one happen.
            </li>
          </ul>
          <p className="mt-2">
            If none of that explains it, email us with the campground and dates and we will look at
            the actual alert log for your watch.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Text messages</h2>
          <p>
            Texts are optional and always have been — you are never required to give a number to
            use CampHawk. Turn them on in Settings by entering your number and agreeing to the
            consent box, and off again by clearing the number. Reply <strong>STOP</strong> to any
            message to stop them immediately. Message and data rates may apply.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Auto-cart (Recreation.gov only)</h2>
          <p>
            For Recreation.gov campgrounds we can add an opening straight to your cart, so you only
            have to check out. It works only there, because other reservation systems tie the cart
            to a browser session that can&apos;t reach your phone. You connect your Recreation.gov
            login once; those credentials are stored encrypted on a private machine we run and{' '}
            <strong>never reach CampHawk&apos;s web servers or database</strong>. You can turn
            auto-cart off at any time in Settings.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Managing your subscription</h2>
          <p>
            Searching is free forever. Watching a booked campground, text alerts and auto-cart come
            with a subscription, which is managed at{' '}
            <a href="https://camphawk.app" className="text-ch-green-deep underline">
              camphawk.app
            </a>
            . Open Settings → Subscription → Manage billing to change your payment method or cancel.
            Cancelling stops future charges and you keep access until the period you have already
            paid for ends.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Deleting your account</h2>
          <p>
            Settings → <strong>Delete account</strong>. This removes your watches, alert history and
            saved campgrounds permanently, and it cannot be undone. If you have a subscription it is{' '}
            <strong>cancelled immediately</strong> — you will not be charged again, and the
            remainder of the period you have already paid for is not refunded. Delete the account
            only when that is what you want; to simply stop paying, cancel from the billing portal
            instead and keep your watches.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Where CampHawk works</h2>
          <p>
            Every Recreation.gov campground in all 50 states, plus state parks in 34 states across
            the ReserveCalifornia/UseDirect, ReserveAmerica, GoingToCamp and Tennessee/South
            Carolina systems. If a campground you want is missing, email us — adding a system is
            work we do based on what people ask for.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Contact</h2>
          <p>
            <a href="mailto:alerts@camphawk.app" className="text-ch-green-deep underline">
              alerts@camphawk.app
            </a>
            . Also see our{' '}
            <Link href="/terms" className="text-ch-green-deep underline">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="text-ch-green-deep underline">
              Privacy Policy
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
