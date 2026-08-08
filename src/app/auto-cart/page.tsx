import Link from 'next/link';
import Logo from '@/components/Logo';

export const metadata = {
  title: 'Auto-cart — how it works · CampHawk',
  description:
    'How CampHawk auto-cart adds a campsite to your recreation.gov cart automatically when a spot you are watching opens up.',
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
            When a campsite you&apos;re watching opens up, auto-cart adds it to your{' '}
            <strong>recreation.gov</strong>{' '}cart automatically — so instead of racing to book
            before someone else grabs it, it&apos;s already waiting in your cart and you just
            check out (from your phone, anywhere).
          </p>
        </div>

        <section className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
          <h2 className="font-ch-display font-semibold text-ch-ink mb-3">What you need first</h2>
          <ul className="space-y-2 text-sm text-ch-ink-2">
            <li>✅ A{' '}<strong>CampHawk account</strong>{' '}with at least one watch set up.</li>
            <li>✅ A{' '}<strong>recreation.gov account</strong> (the site you actually book on).</li>
            <li>✅ That&apos;s it — turn on the toggle and do a one-time sign-in (below).</li>
          </ul>
        </section>

        <section className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
          <h2 className="font-ch-display font-semibold text-ch-ink mb-4">Set it up (one time)</h2>
          <ol className="space-y-5">
            <Step n={1} title="Set your watches">
              Search for a campground, pick your dates, and tap{' '}
              <strong>Watch this campground</strong>{' '}on any booked site. Auto-cart only acts on
              sites you&apos;re watching.
            </Step>
            <Step n={2} title="Set up auto-cart">
              Go to{' '}<strong>Settings</strong>{' '}and, under{' '}<strong>Auto-cart</strong>, tap{' '}
              <strong>Set up auto-cart</strong>. Once it&apos;s connected the same block gives you a{' '}
              <strong>Turn on</strong>{' '}/{' '}<strong>Turn off</strong>{' '}switch.
            </Step>
            <Step n={3} title="Sign in to recreation.gov once">
              You enter your recreation.gov email and password once. They&apos;re saved,{' '}
              <strong>encrypted, on a private machine we run</strong>{' '}— the always-on computer
              that holds your logged-in browser — so auto-cart signs back in by itself if the
              session drops.{' '}
              <strong>They never reach CampHawk&apos;s web servers or database.</strong>
            </Step>
            <Step n={4} title="You're done">
              From now on, when a watched site opens, it&apos;s added to your cart within seconds.
              You get your normal CampHawk alert — open recreation.gov on your phone, and it&apos;s
              already in your cart. Just{' '}<strong>check out</strong>.
            </Step>
          </ol>
        </section>

        <section className="bg-white rounded-2xl border border-ch-line shadow-sm p-5">
          <h2 className="font-ch-display font-semibold text-ch-ink mb-3">Good to know</h2>
          <ul className="space-y-2 text-sm text-ch-ink-2">
            <li>
              <strong>Finish on your phone.</strong>{' '}The cart is tied to your recreation.gov
              account, so it shows up wherever you&apos;re logged in.
            </li>
            <li>
              <strong>State parks</strong> (California, Texas, Arizona, Florida, New York, Oregon, and more) aren&apos;t
              auto-carted — their cart doesn&apos;t sync across devices. For those, your CampHawk alert
              includes a direct booking link: tap it on your phone and finish there.
            </li>
            <li>
              <strong>One grab per site.</strong>{' '}Once a specific site is carted for you, it
              won&apos;t be re-added — but a different site opening in the same campground still will.
            </li>
            <li>
              <strong>Cancellations move fast.</strong>{' '}Getting it into your cart buys you time,
              but recreation.gov only holds a cart for ~15 minutes — check out promptly.
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
