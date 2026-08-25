import { AUTOCART_BETA_LABEL, AUTOCART_BETA_NOTE } from "@/lib/autocart-beta";
import { RC_CART_HOLD_MINUTES } from "@/lib/limits";

/**
 * "We can hold a California site for you at 08:00" — said out loud, at last.
 *
 * ## Why this exists
 *
 * ReserveCalifornia auto-hold was invisible. The marketing site described Auto-Cart as a
 * Recreation.gov feature and stopped there; `/new` mentions holds only for a hold-capable
 * source; and everything else about it — the offer, the tap, the cart, the hand-off — is
 * reachable only by RECEIVING AN ALERT. So the only way to discover the feature was to
 * already be using it, which the owner reported as "no sign of auto cart".
 *
 * ## It is not the Auto-Cart toggle, and conflating them is the trap
 *
 * `supportsAutoCart` is `source === 'ridb'`: the watch-level switch drives the
 * RECREATION.GOV lane. An RC hold is not a watch setting at all — it is offered per
 * release, the night before, and only a tap authorises it. There is deliberately NO
 * standing switch, because a switch would imply a consent this product does not take: a
 * hold takes a real campsite off the market for every other camper, and nobody should be
 * doing that on a preference set weeks ago. That is worth stating as a feature rather
 * than leaving a reader to notice a missing control.
 *
 * ## The beta wording comes from ONE definition
 *
 * `@/lib/autocart-beta` — never a paraphrase. That module exists because a tester met a
 * button promising to take a campsite off the market with nothing anywhere saying "beta",
 * and a second form of words is how the careful one quietly stops being the one people
 * read. The note names the remedy ("set an alarm") on purpose: a caveat with no
 * instruction changes nobody's morning.
 *
 * Server component — it holds no state and reads no session, so it costs the marketing
 * page nothing.
 */
export default function RcHoldExplainer({ className }: { className?: string }) {
  return (
    <section
      className={`rounded-ch-card border border-ch-line bg-ch-card p-4 sm:p-5 ${className ?? ""}`}
      aria-labelledby="rc-hold-explainer"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="rc-hold-explainer" className="font-ch-display text-ch-h font-bold">
          California 8am releases — we can hold the site while you wake up
        </h2>
        <span className="rounded-full bg-ch-sand px-2 py-0.5 text-ch-fine font-bold uppercase tracking-[.06em] text-ch-green-deep">
          {AUTOCART_BETA_LABEL}
        </span>
      </div>

      <p className="mt-2 max-w-[62ch] text-ch-body leading-relaxed text-ch-ink-2">
        When somebody cancels a ReserveCalifornia booking, the site usually does not go back
        on sale straight away — it is released at 08:00 the next morning, and it can be gone
        in seconds. Because we can see the release time the night before, we can tell you
        what is coming and offer to be there when it opens.
      </p>

      <ol className="mt-3 max-w-[62ch] space-y-2 text-ch-body leading-relaxed text-ch-ink-2">
        <Step n={1}>
          <strong className="font-bold text-ch-ink">The night before</strong>, you get an
          alert naming the site, the nights and the exact release time — with a
          &ldquo;hold it for me&rdquo; button.
        </Step>
        <Step n={2}>
          <strong className="font-bold text-ch-ink">You tap it, or you don&rsquo;t.</strong>{" "}
          Nothing happens unless you do. There is no standing setting for this, on purpose
          — holding a site takes it off the market for everyone else, and that is not a
          decision to make weeks in advance.
        </Step>
        <Step n={3}>
          <strong className="font-bold text-ch-ink">At 08:00 we put it in a cart</strong> —
          in seconds, before most people have found the page.
        </Step>
        <Step n={4}>
          <strong className="font-bold text-ch-ink">We text you and let go</strong> so your
          own account can take it. ReserveCalifornia keeps a cart about{" "}
          {RC_CART_HOLD_MINUTES} minutes, so it is worth answering promptly. You do the
          booking and the paying — we never do either.
        </Step>
      </ol>

      {/* THE CAVEAT ARRIVES BEFORE THE READER DECIDES, not underneath the promise —
          the same placement rule the confirm screen follows, and the reason is that the
          cost of a miss is not the failed cart but a user who stopped watching. */}
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 max-w-[62ch] text-ch-meta leading-normal text-ch-ink-2">
        <span className="rounded-full bg-ch-sand px-2 py-0.5 text-ch-fine font-bold uppercase tracking-[.06em] text-ch-green-deep">
          {AUTOCART_BETA_LABEL}
        </span>
        <span className="min-w-0 flex-1">{AUTOCART_BETA_NOTE}</span>
      </p>

      <p className="mt-2 max-w-[62ch] text-ch-meta leading-normal text-ch-muted">
        ReserveCalifornia parks only. Recreation.gov has its own auto-cart, which is not in
        testing and works differently — you connect it once and openings go straight into
        your cart.
      </p>
    </section>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-ch-green-soft text-ch-fine font-bold text-ch-green-deep"
      >
        {n}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}
