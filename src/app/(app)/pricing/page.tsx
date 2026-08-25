import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import PricingSection from "@/components/v2/PricingSection";
import RcHoldExplainer from "@/components/v2/RcHoldExplainer";

/**
 * /pricing — the dedicated plans page.
 *
 * The pricing comparison also lives on the marketing home (/#pricing), but a
 * standalone URL earns its keep three ways: the "Explore plan options" buttons on
 * the app tabs land HERE with no scroll dependency, it's a linkable/indexable
 * destination for marketing ("camphawk pricing" should resolve somewhere), and it
 * reads cleanly for someone sent the link directly.
 *
 * Server-rendered shell; the comparison itself is PricingSection, the SAME client
 * component the homepage mounts — one source of pricing truth, so the two pages
 * cannot drift. All the store-rule handling (native shows no prices) and
 * subscriber handling (never sold to) comes with it.
 */

const title = "Plans & pricing — CampHawk";
const description =
  "Searching is free. Watch a booked campground from $2.50 a month, or add Auto-Cart — openings go straight into your Recreation.gov cart. 7-day free trial.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "https://camphawk.app/pricing" },
};

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-8">
      <h1 className="font-ch-display text-[clamp(26px,4vw,36px)] font-extrabold leading-[1.05] tracking-[-.035em] text-ch-ink">
        Plans &amp; pricing
      </h1>
      <p className="mt-2 max-w-[56ch] text-ch-body leading-relaxed text-ch-ink-2">
        Live search is free and needs no account. A subscription is what keeps a watch
        running around the clock — and Auto-Cart is what wins the sites that vanish in
        minutes.
      </p>

      <div className="mt-6">
        <PricingSection />
      </div>

      {/* RC auto-hold was reachable only by RECEIVING AN ALERT, so the only way to find
          out it existed was to already be using it. It belongs on the page where somebody
          is deciding what a subscription buys them — and next to the honest-limits block
          below, which is the objection it raises ("does it book things without asking?"). */}
      <RcHoldExplainer className="mt-6" />

      {/* The same three honest-limit lines as the homepage. On a pricing page they
          pull extra weight: "does it book things without asking?" is the objection
          someone holds at exactly the moment they're deciding whether to pay. */}
      <div className="mt-6 rounded-ch-card border border-ch-line bg-ch-card p-4">
        <h2 className="font-ch-display text-ch-h font-bold">What we don&apos;t do</h2>
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

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link href="/search" className={buttonClasses({ className: "px-5" })}>
          Search campgrounds free
        </Link>
        <Link href="/" className="text-ch-body font-bold text-ch-green hover:text-ch-green-deep">
          Back to the home page
        </Link>
      </div>
    </div>
  );
}
