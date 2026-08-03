import Link from 'next/link';
import Logo from '@/components/Logo';
import { DATA_SOURCES, ADDITIONAL_PORTALS, AFFILIATION_DISCLAIMER } from '@/lib/data-sources';

export const metadata = {
  title: 'Data sources — CampHawk',
  description:
    'Every official source CampHawk gets campground and availability information from, with a link to each one. CampHawk is independent and does not represent any government entity.',
  alternates: { canonical: 'https://camphawk.app/sources' },
};

/**
 * Public "where our data comes from" page.
 *
 * WHY IT EXISTS: Google Play rejected the Android listing on 2026-08-03 under the
 * Misleading Claims policy — an app surfacing government information must cite a
 * clear, official, functional source for it and carry an obvious disclaimer that it
 * does not represent the government. This is the accessible source list; the store
 * descriptions link here, and the footer does too so it is reachable from inside the
 * native app (any webview page is), not only from the listing.
 *
 * The disclaimer is FIRST and unmissable, deliberately. The old store description
 * had the same facts in its final paragraph and that was not enough.
 *
 * NO PRICES on this page — it is reachable inside the native app, and both stores
 * forbid showing the price of a subscription sold outside their in-app purchase.
 * Same rule as /support. See docs/CONTEXT.md → store-billing.
 *
 * Must be listed in `isPublicRoute` (src/middleware.ts) or Clerk's auth.protect()
 * returns 404 to signed-out visitors — which is every store reviewer.
 */
export default function SourcesPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-10 text-ch-ink">
      <Link href="/" className="inline-block mb-6">
        <Logo markSize={30} />
      </Link>

      <h1 className="text-2xl font-bold mb-4">Where CampHawk&apos;s information comes from</h1>

      <div className="mb-8 rounded-lg border border-ch-line bg-white/70 p-4 text-sm leading-relaxed">
        <p className="font-semibold mb-1">CampHawk is not a government app.</p>
        <p>{AFFILIATION_DISCLAIMER}</p>
      </div>

      <div className="space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="font-semibold text-base mb-2">How the data is obtained</h2>
          <p>
            CampHawk does not create campground or availability information. It reads what the
            official reservation systems below publish, and shows it to you unchanged. When a
            campsite opens up, CampHawk sends you to that same official site to book it — every
            reservation, payment and cancellation happens there, under that agency&apos;s terms,
            not CampHawk&apos;s.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-3">Official sources</h2>
          <ul className="space-y-3">
            {DATA_SOURCES.map((s) => (
              <li key={s.key}>
                <a
                  href={s.url}
                  className="text-ch-green-deep underline font-medium"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {s.name}
                </a>
                <div className="text-ch-muted">{s.coverage}</div>
                <div className="text-ch-muted break-all">{s.url}</div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-3">Additional official portals</h2>
          <p className="mb-3 text-ch-muted">
            Some of the sources above serve more than one state, or publish through a separate
            open-data service. Those portals are:
          </p>
          <ul className="space-y-3">
            {ADDITIONAL_PORTALS.map((p) => (
              <li key={p.url}>
                <a
                  href={p.url}
                  className="text-ch-green-deep underline font-medium"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {p.name}
                </a>
                <div className="text-ch-muted break-all">{p.url}</div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Accuracy</h2>
          <p>
            Availability changes constantly and CampHawk can only report what a reservation system
            told it at the time it last checked. The official site linked from every campground page
            and every alert is always the authority. If the two disagree, the official site is
            correct.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-base mb-2">Questions</h2>
          <p>
            Email{' '}
            <a href="mailto:alerts@camphawk.app" className="text-ch-green-deep underline">
              alerts@camphawk.app
            </a>{' '}
            and a human will answer.
          </p>
        </section>
      </div>
    </div>
  );
}
