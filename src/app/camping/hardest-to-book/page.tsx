import type { Metadata } from "next";
import Link from "next/link";
import { loadHardToBook, HARD_TO_BOOK } from "@/lib/hardToBook";
import { SITE_NAME, SITE_URL } from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";

/**
 * /camping/hardest-to-book — the editorial hub for the cancellation retarget.
 *
 * See `lib/hardToBook.ts` for why the list exists at all (it concentrates
 * internal link equity on the ~26 highest-intent leaves, which currently share a
 * state page with 869 others) and for why it is curated rather than computed.
 *
 * THE ROUTE IS STATIC AND SITS BESIDE `/camping/[state]`. Next resolves a static
 * segment ahead of a dynamic sibling, so this wins over the state route; and
 * `slugToStateCode('hardest-to-book')` returns null, so even if that order ever
 * inverted the dynamic route would 404 rather than render something wrong. It
 * lives under /camping rather than at the root so it inherits the existing
 * breadcrumb hierarchy and the topical cluster — the crawler already knows
 * /camping is about camping.
 *
 * THE PAGE MAKES NO CLAIM IT CANNOT SUPPORT. It does not say these are THE
 * hardest campgrounds to book, because nothing here measured that; it says they
 * are the ones that sell out fastest and that we picked them. The mechanism it
 * describes — sites released on a window, gone in minutes, cancellations as the
 * realistic way in — is generally true and is not a per-campground booking rule,
 * which is the kind of specific claim that rots silently when a provider changes
 * its policy.
 */

export const revalidate = 86400;

const title = `The campgrounds that are always booked | ${SITE_NAME}`;
const description =
  "Yosemite, Zion, Acadia and 15 more parks whose campgrounds sell out in minutes. " +
  "The realistic way in is a cancellation — here's how to catch one.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: `${SITE_URL}/camping/hardest-to-book` },
  openGraph: {
    title,
    description,
    url: `${SITE_URL}/camping/hardest-to-book`,
    type: "website",
  },
  twitter: { card: "summary", title, description },
};

export default async function HardestToBookPage() {
  const groups = await loadHardToBook();
  const total = groups.reduce((a, g) => a + g.campgrounds.length, 0);

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Camping by state", item: `${SITE_URL}/camping` },
      {
        "@type": "ListItem",
        position: 3,
        name: "Always booked",
        item: `${SITE_URL}/camping/hardest-to-book`,
      },
    ],
  };

  return (
    <div className="font-ch-body text-ch-ink">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumb) }}
      />

      <div className="mx-auto max-w-[var(--ch-max)] px-5 py-8">
        <nav aria-label="Breadcrumb" className="mb-4 text-ch-fine text-ch-muted">
          <Link className="font-bold text-ch-green hover:text-ch-green-deep" href="/">
            {SITE_NAME}
          </Link>
          <span className="mx-1.5">›</span>
          <Link className="font-bold text-ch-green hover:text-ch-green-deep" href="/camping">
            Camping by state
          </Link>
          <span className="mx-1.5">›</span>
          <span>Always booked</span>
        </nav>

        <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          The campgrounds that are always booked
        </h1>

        <div className="mt-3 max-w-[70ch] space-y-3 text-ch-body leading-relaxed text-ch-ink-2">
          <p>
            {`Some campgrounds are gone the moment their booking window opens. Refresh at the wrong second and a whole summer of Yosemite Valley is spoken for before you have finished typing. It is not a queue you can win by being organised — for these ${total > 0 ? total : ""} campgrounds, being early is not early enough.`}
          </p>
          <p>
            {"What does work is being there when somebody gives one back. Cancellations happen constantly — plans change, weather turns, someone holds three weekends and keeps one — and the site drops back into the booking system with no announcement, often in the middle of the night. Nearly every one of them is taken within minutes by whoever happened to be looking."}
          </p>
          <p>
            {"CampHawk is the part that happens to be looking. We recheck each of these campgrounds every 15 seconds, around the clock, and the moment a site frees up we text, email and push you a link straight to it."}
          </p>
        </div>

        <p className="mt-4 max-w-[70ch] text-ch-meta text-ch-muted">
          {/* Says out loud that the list is a judgement call. We have no
              national data on booking difficulty — Feature E's accrual has been
              stopped since July and never covered the short-lead window — and
              a page that implied we ranked these would be a claim we cannot
              back. See lib/hardToBook.ts. */}
          {"This is our own pick of famously oversubscribed national-park campgrounds, not a measured ranking. Live availability for every one of them is free to check."}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/search"
            className="rounded-ch-chip bg-ch-green px-4 py-2 text-ch-body font-bold text-white hover:bg-ch-green-deep"
          >
            Check availability now
          </Link>
        </div>

        {groups.length > 0 && (
          <div className="mt-8 space-y-7">
            {groups.map((g) => (
              <section key={g.park}>
                <h2 className="font-ch-display text-ch-h font-bold">{g.park}</h2>
                <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {g.campgrounds.map((c) => (
                    <li key={c.id} className="border-b border-ch-line py-1.5">
                      <Link
                        className="text-ch-body text-ch-ink-2 hover:text-ch-green hover:underline"
                        href={`/campground/${encodeURIComponent(c.id)}`}
                      >
                        {c.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <p className="mt-8 text-ch-meta text-ch-muted">
          {`Watching all ${HARD_TO_BOOK.length} is not the point — pick the one you actually want. `}
          <Link href="/camping" className="font-semibold text-ch-green hover:underline">
            Browse every state
          </Link>
          {" for the other 8,000."}
        </p>
      </div>
    </div>
  );
}
