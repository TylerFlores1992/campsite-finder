"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { stayLabel, releaseLabel } from "@/lib/hold-labels";
import { RC_CART_HOLD_MINUTES } from "@/lib/limits";
import { isFinishedHandoff, byUrgency } from "@/lib/hold-ordering";
import { AUTOCART_BETA_LABEL, AUTOCART_BETA_NOTE_SHORT } from "@/lib/autocart-beta";

/**
 * Sites CampHawk is holding for you — on the Watches tab, where you look for them.
 *
 * ## Why this is a feature and not decoration
 *
 * A hold is the most perishable object in the product: the bot has a real campsite locked
 * in a real ReserveCalifornia cart, RC drops that cart after about fifteen minutes, and
 * until now the ONLY way in was the alert that announced it. One email, one push, one
 * device. Swipe the notification away and the site was unreachable — the claim URL carries
 * a token, so it cannot be guessed, and nothing in the app listed it.
 *
 * So the thing with a fifteen-minute fuse was the one thing with no home screen. It has one
 * now, and it sits ABOVE the watch list because at 08:00 nothing else on this page matters.
 *
 * ## In-app navigation, deliberately
 *
 * These are plain `<Link>`s. The claim screen's automatic cart depends on running inside the
 * app's own webview — `canInject` — and anything that hands the URL to the system browser
 * (`Browser.open`, a `target="_blank"`) silently drops the user onto the manual path, which
 * is precisely the failure the whole hand-off exists to remove. Navigating within the shell
 * keeps the capability.
 */
interface MyHold {
  id: string;
  status: string;
  unitLabel: string;
  campgroundName: string | null;
  arrivalDate: string;
  nights: number;
  releaseAt: string;
  cartedAt: string | null;
  claimUrl?: string;
  holdUrl?: string;
  updatedAt: string | null;
  dismissToken?: string;
}

export default function HoldsPanel({ className }: { className?: string }) {
  const [holds, setHolds] = useState<MyHold[] | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/rc-holds/mine")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { holds?: MyHold[] } | null) => {
          if (!cancelled && j?.holds) setHolds(j.holds);
        })
        .catch(() => {
          /* A hold panel that breaks the watches page is worse than no hold panel. */
        });
    };
    load();
    // A hold changes state on the bot's clock, not the user's. Somebody sitting on this
    // page at 07:59 should see "we have it" appear without being told to pull to refresh.
    const t = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // THE LOCAL LIST IS A HEAD START, NOT THE RECORD. Removing writes `claimed` server-side
  // and the next poll drops the row on its own, on every device — this only spares the user
  // up to 20 seconds of looking at a row they just dismissed. It is deliberately NOT
  // optimistic: `dismissed` is appended only after the write comes back ok, so a failed
  // remove leaves the row where it is rather than hiding a hold that still exists.
  const visible = holds?.filter((h) => !dismissed.includes(h.id)) ?? [];
  if (visible.length === 0) return null;

  // FINISHED HAND-OFFS ARE COLLAPSED, NOT DELETED. The row is still the only route back to
  // a site somebody may have booked and want to check, so it stays reachable — it just
  // stops occupying the space above a live offer. Consolidating them behind one line is
  // what the owner asked for when there are several.
  const live = visible.filter((h) => !isFinishedHandoff(h)).sort(byUrgency);
  const finished = visible.filter(isFinishedHandoff).sort(byUrgency);

  return (
    <section className={className} aria-label="Sites we're holding">
      <h2 className="mb-2 font-ch-display text-ch-h font-bold">Holds</h2>
      {/* `grid-cols-[minmax(0,1fr)]`, NOT a bare `grid`, AND IT IS NOT COSMETIC.
          A grid item's default `min-width` is `auto`, so the track sizes to the item's
          MAX-CONTENT — and a hold row is a flex line holding a `truncate` title (which is
          `white-space: nowrap`) beside a `shrink-0` status chip and a `shrink-0` remove
          button. Nothing in that row is allowed to shrink, so the track grew past the
          viewport and the whole card hung off the right edge of an iPhone: the "Yours" chip
          and most of "Open the hand-off again" were unreachable, on the one panel whose job
          is to get somebody to a campsite inside fifteen minutes.
          The inner `min-w-0 flex-1` was already correct and could never have helped — it
          constrains the flex CHILD, and the overflow was the grid TRACK one level up. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
        {live.map((h) => (
          <HoldRow key={h.id} hold={h} onRemoved={(id) => setDismissed((d) => [...d, id])} />
        ))}
      </div>

      {finished.length > 0 && (
        <details className="mt-2.5">
          <summary className="cursor-pointer rounded-ch-card border border-ch-line bg-ch-card px-3.5 py-2.5 text-ch-meta text-ch-ink-2">
            {finished.length} finished hand-off{finished.length === 1 ? "" : "s"} — already
            let go
          </summary>
          <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-2.5">
            {finished.map((h) => (
              <HoldRow
                key={h.id}
                hold={h}
                onRemoved={(id) => setDismissed((d) => [...d, id])}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/**
 * "I'm done with this one" / "no thanks" — and why each row gets the control it gets.
 *
 * ## `released`: the hand-off is over
 *
 * The bot has already let go, the site is on ReserveCalifornia for whoever gets there
 * first, and nothing further will happen to the row. It nonetheless sat in this list for
 * ever, because `/api/rc-holds/mine` keeps `carted`/`claiming`/`released` regardless of age
 * and **nothing in the product had ever called the PATCH that retires one**. That is the
 * space the owner reported this eating, and `claimed` is exactly the state for it.
 *
 * ## `offered`: THIS ONE NEEDED A SERVER-SIDE DECLINE FIRST
 *
 * This panel used to give `offered` no remove at all, and the reasoning was right at the
 * time: there was no decline path, so an X could only ever hide the row while the bot went
 * on to cart the site at 08:00 anyway, and **a control that appears to cancel and does not
 * is worse than no control**. The owner asked for the X; the honest way to give it was to
 * build `declineHold`, not to hide the card.
 *
 * It is not cosmetic. An `offered` row occupies a capacity seat — `holdWindowLoad` counts
 * it, because the button is in an email we cannot retract — and since the fairness line it
 * occupies a POSITION too, so declining moves the next person up. Hiding a card could
 * never do either.
 *
 * ## `carted` / `claiming` get NO control, and the omission is the design
 *
 * The bot is holding a real campsite in a real cart right now. Hiding that row does not
 * release it; it takes the site off the market for every other camper and removes the only
 * thing on screen still pointing at it. That is the 2026-08-13 leak with a button on it.
 *
 * ## Why declining asks twice
 *
 * It cannot be undone — the offer is retracted, and a later tap on the emailed link finds
 * nothing to act on. This is the same rule that gives the `hold` action a confirm page of
 * its own rather than acting on a GET: the irreversible ones ask. Retiring a `released`
 * row does not, because by then there is nothing left to lose.
 *
 * ## The token
 *
 * `dismissToken` is the watch's manage token — the same pair that authorises RELEASING the
 * site. Never weaker than the authorisation for the more consequential act on the same
 * row. It is minted server-side for the caller's own watches, which is why this no longer
 * digs it back out of `claimUrl`: an `offered` row has no claim URL to dig in.
 */
function HoldRow({ hold, onRemoved }: { hold: MyHold; onRemoved: (id: string) => void }) {
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const held = hold.status === "carted" || hold.status === "claiming";
  const released = hold.status === "released";
  const offered = hold.status === "offered";
  const token = (released || offered) && hold.dismissToken ? hold.dismissToken : null;
  // READY MEANS THERE IS SOMETHING TO PRESS, not that the hold exists. A `requested` hold
  // is real and important and there is nothing whatever for its owner to do until 08:00, so
  // giving it the same urgent styling as a site sitting in a cart teaches people to ignore
  // the styling.
  const ready = held || released;

  async function remove() {
    if (!token) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      // DELETE declines an offer, PATCH retires a finished hand-off. Two verbs because
      // they are two different acts on the server: one retracts a promise and frees a
      // capacity seat, the other only files the row away.
      const r = await fetch("/api/rc-holds/claim", {
        method: offered ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hold.id, token }),
      });
      if (!r.ok) {
        // A 409 is the server refusing because the hold has moved on — most likely the
        // bot already carted it. Saying "try again" there would be wrong twice over, so
        // it says what happened and the next poll will show the real state.
        setRemoveError(
          r.status === 409
            ? "Too late to withdraw this one — it has already been acted on."
            : "Could not remove that just now. Try again in a moment.",
        );
        return;
      }
      onRemoved(hold.id);
    } catch {
      setRemoveError("Could not remove that just now. Try again in a moment.");
    } finally {
      setRemoving(false);
      setConfirming(false);
    }
  }

  return (
    <div
      className={
        ready
          ? "rounded-ch-card border-2 border-ch-green bg-ch-green-soft p-3.5"
          : "rounded-ch-card border border-ch-line bg-ch-card p-3.5"
      }
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-ch-body font-bold">
            {hold.campgroundName ?? "A watched campground"}
          </p>
          <p className="mt-0.5 text-ch-meta text-ch-ink-2">
            Site <strong className="font-bold">{hold.unitLabel}</strong>
            {" · "}
            {stayLabel(hold.arrivalDate, hold.nights)}
          </p>
        </div>
        <StatusChip status={hold.status} />
        {/* ONLY EVER ON A `released` ROW — see removeToken's header for why the other four
            statuses have no button. `title` and `aria-label` both say "from this list"
            rather than "remove the hold", because by this point there is no hold left to
            remove and the site is already back on the open market. */}
        {token && (
          <button
            type="button"
            onClick={() => (offered ? setConfirming(true) : remove())}
            disabled={removing || confirming}
            title={offered ? "I don't want this one" : "Remove from this list"}
            aria-label={
              offered
                ? `Don't hold ${hold.unitLabel} for me`
                : `Remove ${hold.unitLabel} from this list`
            }
            className="-my-1.5 -mr-1.5 grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-[15px] leading-none text-ch-ink-2 hover:bg-black/[.07] hover:text-ch-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green disabled:opacity-50"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>

      <p className="mt-2 text-ch-meta leading-normal text-ch-ink-2">
        <StatusLine hold={hold} />
      </p>

      {held && hold.claimUrl && (
        <Link href={hold.claimUrl} className={buttonClasses({ fullWidth: true, className: "mt-3" })}>
          Claim {hold.unitLabel}
        </Link>
      )}
      {released && hold.claimUrl && (
        <Link
          href={hold.claimUrl}
          className={buttonClasses({ variant: "quiet", fullWidth: true, className: "mt-3" })}
        >
          Open the hand-off again
        </Link>
      )}
      {removeError && (
        <p className="mt-2 text-ch-meta text-ch-ochre-ink">{removeError}</p>
      )}
      {/* THE SECOND ASK. Declining retracts the offer for good — a later tap on the emailed
          link finds nothing to act on — so it is confirmed, exactly as the `hold` action
          itself is. It also says what declining DOES, because "we'll let it go" is the part
          that makes the choice a real one rather than a tidy-up. */}
      {offered && confirming && (
        <div className="mt-3 rounded-xl border border-ch-line bg-ch-card p-3">
          <p className="text-ch-meta leading-normal text-ch-ink-2">
            Drop this one? We won&rsquo;t try for {hold.unitLabel}, and if somebody else is
            watching it they move up the queue. You can still book it yourself when it opens.
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={removing}
              className={buttonClasses({ variant: "quiet", className: "flex-1" })}
            >
              Yes, drop it
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={buttonClasses({ variant: "quiet", className: "flex-1" })}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
      {offered && !confirming && hold.holdUrl && (
        <>
          {/* THE LABEL SITS ABOVE THE BUTTON, not under it. This card is one of the two
              places somebody decides to rely on the bot instead of setting an alarm — the
              other is the confirm screen, which carries the full note — and a caveat read
              after the decision is no caveat. The SHORT form, because this is a dense list
              and the long one would push the button off a phone screen. One definition:
              `@/lib/autocart-beta`, never a paraphrase. */}
          <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-ch-meta leading-normal text-ch-ink-2">
            <span className="rounded-ch-chip bg-ch-sand px-1.5 py-0.5 text-ch-fine font-bold uppercase tracking-[.06em] text-ch-green-deep">
              {AUTOCART_BETA_LABEL}
            </span>
            <span className="min-w-0 flex-1">{AUTOCART_BETA_NOTE_SHORT}</span>
          </p>
          <Link href={hold.holdUrl} className={buttonClasses({ fullWidth: true, className: "mt-2" })}>
            Hold it for me
          </Link>
        </>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  // COLOUR IS NEVER THE ONLY SIGNAL — the owner is colour-blind, and this is the same rule
  // the admin dashboard's LEVEL_MARK enforces. Each chip carries a distinct word; the hue
  // is the redundant third channel behind the word and the border weight above.
  const map: Record<string, { label: string; cls: string }> = {
    offered: { label: "Offered", cls: "bg-ch-ochre-soft text-ch-ochre-ink" },
    requested: { label: "Queued", cls: "bg-ch-ochre-soft text-ch-ochre-ink" },
    carted: { label: "In our cart", cls: "bg-ch-green text-white" },
    claiming: { label: "Handing over", cls: "bg-ch-green text-white" },
    released: { label: "Yours", cls: "bg-ch-green text-white" },
  };
  const s = map[status];
  if (!s) return null;
  return (
    <span className={`shrink-0 rounded-ch-chip px-2 py-1 text-ch-fine font-bold ${s.cls}`}>
      {s.label}
    </span>
  );
}

function StatusLine({ hold }: { hold: MyHold }) {
  switch (hold.status) {
    case "offered":
      return (
        <>
          Releases {releaseLabel(hold.releaseAt)}. We can grab it the second it opens — tap
          below and we&rsquo;ll be waiting.
        </>
      );
    case "requested":
      return (
        <>
          We&rsquo;ll try for this the second it opens, {releaseLabel(hold.releaseAt)}.
          Nothing to do until then — we&rsquo;ll tell you.
        </>
      );
    case "carted":
      return (
        <>
          It&rsquo;s in our cart.{" "}
          {/* THE DEADLINE, hedged the same way the claim screen hedges it.
              RC_CART_HOLD_MINUTES is read off RC's own bundle and has never been observed,
              so this says "about" and never counts down to a number we cannot stand behind. */}
          ReserveCalifornia keeps a cart about {RC_CART_HOLD_MINUTES} minutes, so claim it
          soon.
        </>
      );
    case "claiming":
      return <>We&rsquo;re letting go so you can take it. Open it and finish up.</>;
    case "released":
      return <>We&rsquo;ve let go — it&rsquo;s on ReserveCalifornia for you to book.</>;
    default:
      return null;
  }
}
