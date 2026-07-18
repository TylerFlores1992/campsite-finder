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
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-600 text-white text-sm font-semibold">
        {n}
      </span>
      <div>
        <p className="font-display font-semibold text-gray-900">{title}</p>
        <div className="mt-1 text-sm text-gray-600 leading-relaxed">{children}</div>
      </div>
    </li>
  );
}

export default function AutoCartHelpPage() {
  return (
    <div className="min-h-screen bg-[#F3EFE0]">
      <header className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <Link href="/"><Logo markSize={30} /></Link>
          <Link href="/" className="text-sm text-gray-500 hover:text-green-700">← Back</Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-green-800">
            ⚡ Auto-cart — how it works
          </h1>
          <p className="mt-2 text-gray-600 leading-relaxed">
            When a campsite you&apos;re watching opens up, auto-cart adds it to your{' '}
            <strong>recreation.gov</strong> cart automatically — so instead of racing to book
            before someone else grabs it, it&apos;s already waiting in your cart and you just
            check out (from your phone, anywhere).
          </p>
        </div>

        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="font-display font-semibold text-gray-800 mb-3">What you need first</h2>
          <ul className="space-y-2 text-sm text-gray-600">
            <li>✅ A <strong>CampHawk account</strong> with at least one watch set up.</li>
            <li>✅ A <strong>recreation.gov account</strong> (the site you actually book on).</li>
            <li>✅ That&apos;s it — turn on the toggle and do a one-time sign-in (below).</li>
          </ul>
        </section>

        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="font-display font-semibold text-gray-800 mb-4">Set it up (one time)</h2>
          <ol className="space-y-5">
            <Step n={1} title="Set your watches">
              Search for a campground, pick your dates, and tap <strong>Notify me</strong> on any
              booked site. Auto-cart only acts on sites you&apos;re watching.
            </Step>
            <Step n={2} title="Turn on Auto-cart">
              Open the <strong>Watches</strong> panel (the bell, top-right) and flip{' '}
              <strong>&ldquo;Auto-cart openings&rdquo;</strong> on. That enrolls you with the bot.
            </Step>
            <Step n={3} title="Sign in to recreation.gov once">
              A recreation.gov <strong>login window opens</strong> — sign in and close it. That
              saves your session so sites can be added to your cart.{' '}
              <strong>Your password is never shared with CampHawk or stored anywhere</strong> —
              only your own browser session is kept.
            </Step>
            <Step n={4} title="You're done">
              From now on, when a watched site opens, it&apos;s added to your cart within seconds.
              You get your normal CampHawk alert — open recreation.gov on your phone, and it&apos;s
              already in your cart. Just <strong>check out</strong>.
            </Step>
          </ol>
        </section>

        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="font-display font-semibold text-gray-800 mb-3">Good to know</h2>
          <ul className="space-y-2 text-sm text-gray-600">
            <li>
              <strong>Finish on your phone.</strong> The cart is tied to your recreation.gov
              account, so it shows up wherever you&apos;re logged in.
            </li>
            <li>
              <strong>State parks</strong> (California, Texas, Arizona, Florida, New York, Oregon, and more) aren&apos;t
              auto-carted — their cart doesn&apos;t sync across devices. For those, your CampHawk alert
              includes a direct booking link: tap it on your phone and finish there.
            </li>
            <li>
              <strong>One grab per site.</strong> Once a specific site is carted for you, it
              won&apos;t be re-added — but a different site opening in the same campground still will.
            </li>
            <li>
              <strong>Cancellations move fast.</strong> Getting it into your cart buys you time,
              but recreation.gov only holds a cart for ~15 minutes — check out promptly.
            </li>
            <li>
              This automates <em>your own</em> account for personal use. Keep your watches current
              so it knows what to grab.
            </li>
          </ul>
        </section>

        <div className="text-center">
          <Link
            href="/"
            className="inline-block px-6 py-3 rounded-2xl bg-green-600 hover:bg-green-700 text-white font-display font-semibold shadow-md transition-colors"
          >
            Go set up a watch →
          </Link>
        </div>
      </main>
    </div>
  );
}
