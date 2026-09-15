import Link from "next/link";
import { COVERAGE, campgroundsRounded } from "@/lib/coverage";
import { DATA_SOURCES } from "@/lib/data-sources";
import { AUTOCART_BETA_NOTE } from "@/lib/autocart-beta";
import { comparisonUrl, type Competitor } from "@/lib/competitors";
import { SITE_NAME, SITE_URL } from "@/lib/seo";
import { jsonLdScript } from "@/lib/jsonld";

/**
 * "CampHawk vs <competitor>" — one component, one route per competitor.
 *
 * Read `src/lib/competitors.ts` before changing a word here. The short version: we make no
 * claim about a competitor we have not verified and quote none of their prices or features,
 * because both sites are unreachable from where this was written and a remembered fact about
 * a rival is how a marketing page becomes a false-advertising problem.
 *
 * WHAT THAT LEAVES IS BETTER THAN A RIGGED TABLE. A two-column grid with ticks in our column
 * and crosses in theirs persuades nobody who is actually shopping — they assume we wrote it,
 * because we did. What does persuade is a specific, checkable claim next to an invitation to
 * go and check the other one. So the page is: what we do, stated precisely; the questions to
 * ask whoever you pick; and where you should not buy from us at all.
 *
 * EVERY NUMBER IS DERIVED, NEVER TYPED. `COVERAGE`, `DATA_SOURCES.length` and the poll
 * interval come from the same constants the product uses, so the page cannot drift into
 * overstating the catalog the way hand-typed marketing copy always eventually does.
 *
 * A SERVER COMPONENT with no "use client". This is SEO-load-bearing prose; the type hubs
 * spent their first life shipping a loading skeleton to Google and nothing here needs state.
 */

/** From `worker/fly.toml` POLL_INTERVAL_MS. Stated in seconds because that is how it reads. */
const POLL_SECONDS = 15;

export interface ComparisonPageProps {
  competitor: Competitor;
}

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <li className="border-t border-ch-line pt-3.5 first:border-0 first:pt-0">
      <p className="font-ch-display text-ch-body font-bold text-ch-ink">{q}</p>
      <div className="mt-1 text-ch-body leading-relaxed text-ch-ink-2">{children}</div>
    </li>
  );
}

export default function ComparisonPage({ competitor }: ComparisonPageProps) {
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: `${SITE_NAME} vs ${competitor.name}`,
        item: comparisonUrl(competitor.slug),
      },
    ],
  };

  return (
    <div
      // OUTSIDE THE (app) ROUTE GROUP, so V2Nav never supplies the status-bar inset — the
      // same reason /admin and /auto-cart reserve it themselves. On Android 16 the webview
      // draws under the status bar and anything in the top ~48px takes no taps, which here
      // would be the h1 of a page built to convert somebody who is comparing tools.
      // Registered in `src/lib/safe-area-top.test.mts` as the owner for both /vs routes.
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 2.5rem)" }}
      className="mx-auto max-w-[46rem] px-5 pb-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumb) }}
      />

      <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em] text-ch-green-deep">
        {SITE_NAME} vs {competitor.name}
      </h1>

      <p className="mt-3 text-ch-body leading-relaxed text-ch-ink-2">
        {competitor.known} So does CampHawk. Rather than tell you what{" "}
        {competitor.name}{" "}
        does — their site is the honest source for that, and it&apos;s{" "}
        <a
          href={competitor.homepage}
          rel="noopener nofollow"
          className="underline hover:text-ch-green-deep"
        >
          right here
        </a>{" "}
        — this page says exactly what CampHawk does, so you can check it against whatever
        else you&apos;re looking at.
      </p>

      {/* ── the honest disarming bit, first ────────────────────────────────────────── */}
      <section className="mt-8 rounded-ch-card border border-ch-line bg-white/70 p-5">
        <h2 className="font-ch-display text-ch-body font-bold text-ch-ink">
          Start here: you might not need to pay anyone
        </h2>
        <p className="mt-1.5 text-ch-body leading-relaxed text-ch-ink-2">
          Since July 2024, <strong>Recreation.gov has its own free cancellation alerts</strong>.
          If every trip you take is a federal campground — national parks, national forests,
          Corps of Engineers — turn those on first and see whether they&apos;re enough. We would
          rather you found that out here than a month after paying us.
        </p>
        <p className="mt-2.5 text-ch-body leading-relaxed text-ch-ink-2">
          Two things a free federal alert cannot do, and they are the whole reason CampHawk
          exists: it does not cover <strong>state parks</strong>, and it does not{" "}
          <strong>book anything for you</strong>. An alert still means you racing to a
          checkout page against everyone else who got the same alert.
        </p>
      </section>

      {/* ── what we do, all of it checkable ───────────────────────────────────────── */}
      <h2 className="mt-9 font-ch-display text-[19px] font-extrabold tracking-[-.02em] text-ch-ink">
        What CampHawk does
      </h2>
      <ul className="mt-4 grid gap-3.5">
        <Q q={`${DATA_SOURCES.length} booking systems, not just Recreation.gov`}>
          {campgroundsRounded()} campgrounds across all {COVERAGE.states} states, with
          state-park coverage in {COVERAGE.stateParkStates} of them — ReserveCalifornia,
          ReserveAmerica, GoingToCamp and nine other state portals alongside the federal
          catalog. Every source is named at{" "}
          <Link href="/sources" className="underline hover:text-ch-green-deep">
            /sources
          </Link>
          , so you can check the coverage for the parks you actually book before you pay.
        </Q>

        <Q q="It can put the site in your cart, not just tell you about it">
          On Recreation.gov, the Auto-Cart plan signs into your own account and adds a
          cancelled site to your cart within seconds of it opening — so you check out from
          your phone instead of racing a notification. That is the difference between knowing
          about a cancellation and getting it.{" "}
          <Link href="/auto-cart" className="underline hover:text-ch-green-deep">
            How it works
          </Link>
          .
        </Q>

        <Q q="ReserveCalifornia sites are held at the 8am release">
          California cancellations mostly don&apos;t go back on sale straight away — they are
          locked until the next morning&apos;s release, when everybody refreshes at once.
          CampHawk spots the site the night before, offers to be there, and carts it within a
          couple of seconds of it freeing, then hands it to you.{" "}
          <span className="text-ch-muted">{AUTOCART_BETA_NOTE}</span>
        </Q>

        <Q q={`Checks every ${POLL_SECONDS} seconds`}>
          Not a periodic sweep. Watched campgrounds are re-checked continuously, which is what
          makes carting within seconds possible at all.
        </Q>

        <Q q="Flexible dates, and per-site muting">
          Watch for &quot;any two nights in this window&quot; rather than one fixed range —
          which, on a popular weekend, is usually the difference between getting something and
          getting nothing. And if one loop keeps opening and you don&apos;t want it, mute that
          site instead of the whole campground.
        </Q>

        <Q q="$2.50 a month, or $10 if you want the carting">
          $2.50/mo or $20/yr for alerts; $10/mo or $50/yr for the Auto-Cart plan. There is a
          7-day free trial and you can cancel from your own settings.{" "}
          <Link href="/pricing" className="underline hover:text-ch-green-deep">
            Pricing
          </Link>
          .
        </Q>
      </ul>

      {/* ── the questions, which apply to everyone including us ───────────────────── */}
      <h2 className="mt-9 font-ch-display text-[19px] font-extrabold tracking-[-.02em] text-ch-ink">
        What to ask before you pick one
      </h2>
      <p className="mt-2 text-ch-body leading-relaxed text-ch-ink-2">
        These are the questions that actually decide whether a cancellation service works for
        your trip. Ask them of {competitor.name}, of us, and of anyone else — and take the
        answers from each service&apos;s own site rather than from a rival&apos;s comparison
        page, this one included.
      </p>
      <ul className="mt-4 grid gap-3.5">
        <Q q="Does it cover the booking system your campground actually uses?">
          The single most common way one of these tools disappoints someone. A service that
          only reads Recreation.gov is no use for a California state park, and vice versa.
          Look up your specific campground before you pay.
        </Q>
        <Q q="Does it only notify, or can it book?">
          On a popular site an alert can be twenty people racing the same checkout. Ask
          whether the tool does anything after the notification.
        </Q>
        <Q q="How often does it check, and does it say?">
          &quot;Real-time&quot; is not a number. A tool that checks every few minutes and one
          that checks every few seconds are different products at the same price.
        </Q>
        <Q q="Can it do flexible dates?">
          If you can move a night either way, a service that only takes a fixed range is
          throwing away most of your chances.
        </Q>
        <Q q="What happens when there are no cancellations?">
          Sometimes there simply aren&apos;t any — a popular weekend can go quiet for a week.
          Ask what you are paying for in that case, and how easily you can stop.
        </Q>
      </ul>

      <div className="mt-9 rounded-ch-card border border-ch-line bg-white/70 p-5 text-center">
        <p className="font-ch-display text-ch-body font-bold text-ch-ink">
          Search is free, and needs no account
        </p>
        <p className="mx-auto mt-1.5 max-w-[46ch] text-ch-body text-ch-muted">
          Look up the campground you want and see what CampHawk knows about it before you
          decide anything.
        </p>
        <Link
          href="/search"
          className="mt-4 inline-block rounded-ch-btn bg-ch-green px-6 py-3 font-ch-display font-semibold text-white transition-colors hover:bg-ch-green-deep"
        >
          Search a campground →
        </Link>
      </div>

      <p className="mt-8 text-ch-fine leading-relaxed text-ch-muted">
        {competitor.name}{" "}
        is not affiliated with CampHawk, and we don&apos;t speak for them.
        Everything above describes CampHawk; for {competitor.name}&apos;s features and prices,{" "}
        <a href={competitor.homepage} rel="noopener nofollow" className="underline">
          see their site
        </a>
        .
      </p>
    </div>
  );
}
