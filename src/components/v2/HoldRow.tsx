"use client";

import { useState } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { stayLabel, releaseLabel } from "@/lib/hold-labels";
import { RC_CART_HOLD_MINUTES } from "@/lib/limits";
import { AUTOCART_BETA_LABEL, AUTOCART_BETA_NOTE_SHORT } from "@/lib/autocart-beta";

/**
 * ONE hold, wherever it is being shown.
 *
 * ## Why this is its own file (2026-09-04)
 *
 * It lived inside `HoldsPanel`. When the `offered` and `requested` lists moved onto the
 * watch card, two surfaces needed to draw the same row — and a second copy of a row that
 * decides whether somebody trusts the bot at 08:00 is the failure this repo has already
 * paid for: `content-rc.js` spent months telling users to click a cart icon while
 * `rc-cart.mjs` did the right thing, because the two had drifted.
 *
 * So the panel and the card render THIS, and the only thing that differs is `variant`,
 * which changes chrome and nothing else. A variant that changed copy would be the second
 * copy arriving by another door.
 */
export interface MyHold {
  id: string;
  /** Which watch this belongs to — how the watches page files it under a card. */
  watchId: string;
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

/**
 * "I'm done with this one" / "no thanks" / "actually, don't" — and why each row gets the
 * control it gets.
 *
 * ## `released`: the hand-off is over
 *
 * The bot has already let go, the site is on ReserveCalifornia for whoever gets there
 * first, and nothing further will happen to the row. It nonetheless sat in the list for
 * ever, because `/api/rc-holds/mine` keeps `carted`/`claiming`/`released` regardless of age
 * and nothing in the product had ever called the PATCH that retires one.
 *
 * ## `offered`: THIS ONE NEEDED A SERVER-SIDE DECLINE FIRST
 *
 * The panel used to give `offered` no remove at all, and the reasoning was right at the
 * time: with no decline path an X could only hide the row while the bot carted the site at
 * 08:00 anyway, and **a control that appears to cancel and does not is worse than no
 * control**. The honest way to give the owner the X was to build `declineHold`.
 *
 * It is not cosmetic. An `offered` row occupies a capacity seat — `holdWindowLoad` counts
 * it, because the button is in an email we cannot retract — and since the fairness line it
 * occupies a POSITION too, so declining moves the next person up.
 *
 * ## `requested`: A CANCEL, WHICH IS A DIFFERENT ACT (owner's ask, 2026-09-04)
 *
 * This one had no control either, and for a sharper reason than `offered` did: the user
 * already said yes, so retracting it is a cancel and **getting it wrong at 07:59 loses a
 * campsite**. `cancelHold` is the honest version — it refuses inside
 * `HOLD_CANCEL_CUTOFF_MIN` of the release, because past that the feed may already have
 * handed the row to the runner and our database no longer decides what happens.
 *
 * That refusal is REPORTED AS ITSELF. "Too close to the release" and "already acted on" are
 * different facts, and telling somebody at 07:55 that their hold had already been carted
 * would be a wrong story about what is happening — which is exactly the kind of lie the
 * missing control was avoiding in the first place.
 *
 * ## `carted` / `claiming` get NO control, and the omission is the design
 *
 * The bot is holding a real campsite in a real cart right now. Hiding that row does not
 * release it; it takes the site off the market for every other camper and removes the only
 * thing on screen still pointing at it. That is the 2026-08-13 leak with a button on it.
 *
 * ## Why declining and cancelling ask twice
 *
 * Neither can be undone — the offer is retracted, and a later tap on the emailed link finds
 * nothing to act on. Same rule that gives the `hold` action a confirm page of its own
 * rather than acting on a GET: the irreversible ones ask. Retiring a `released` row does
 * not, because by then there is nothing left to lose.
 *
 * ## The token
 *
 * `dismissToken` is the watch's manage token — the same pair that authorises RELEASING the
 * site. Never weaker than the authorisation for the more consequential act on the same row.
 * It is minted server-side for the caller's own watches.
 */
export default function HoldRow({
  hold,
  onRemoved,
  variant = "panel",
}: {
  hold: MyHold;
  onRemoved: (id: string) => void;
  /** `panel` draws its own card; `card` is already inside one, so it drops the chrome. */
  variant?: "panel" | "card";
}) {
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const held = hold.status === "carted" || hold.status === "claiming";
  const released = hold.status === "released";
  const offered = hold.status === "offered";
  const queued = hold.status === "requested";
  const token = (released || offered || queued) && hold.dismissToken ? hold.dismissToken : null;
  /** Both of the irreversible ones. `released` is retired without asking. */
  const asks = offered || queued;
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
      // DELETE drops a hold before the bot acts (declining an offer, cancelling a queued
      // one — the server dispatches on the row's own status); PATCH retires a finished
      // hand-off. Two verbs because they are two different acts on the server: one stops
      // something from happening, the other only files the row away.
      const r = await fetch("/api/rc-holds/claim", {
        method: asks ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hold.id, token }),
      });
      if (!r.ok) {
        // A 409 is the server refusing because the hold has moved on or is too close to
        // its release, and THOSE ARE DIFFERENT FACTS. Saying "try again" for either would
        // be wrong; saying "already carted" for a hold that is merely imminent is a wrong
        // story about what is happening. `reason` is what tells them apart.
        const body = (await r.json().catch(() => ({}))) as { reason?: string };
        setRemoveError(
          r.status !== 409
            ? "Could not remove that just now. Try again in a moment."
            : body.reason === "too-late"
              ? "Too close to the release to call this off — we're already lining it up. " +
                "If you don't want the site, just don't claim it and we'll let it go."
              : "Too late to withdraw this one — it has already been acted on.",
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
        variant === "card"
          ? ""
          : ready
            ? "rounded-ch-card border-2 border-ch-green bg-ch-green-soft p-3.5"
            : "rounded-ch-card border border-ch-line bg-ch-card p-3.5"
      }
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          {/* INSIDE A CARD THE PARK NAME IS THE HEADING ABOVE IT, so repeating it on every
              row is noise in a space that has none to spare. The SITE is what distinguishes
              one row from the next there; in the panel the park is what identifies it. */}
          {variant === "card" ? (
            <p className="truncate text-ch-body font-bold">Site {hold.unitLabel}</p>
          ) : (
            <>
              <p className="truncate text-ch-body font-bold">
                {hold.campgroundName ?? "A watched campground"}
              </p>
              <p className="mt-0.5 text-ch-meta text-ch-ink-2">
                Site <strong className="font-bold">{hold.unitLabel}</strong>
                {" · "}
                {stayLabel(hold.arrivalDate, hold.nights)}
              </p>
            </>
          )}
          {variant === "card" && (
            <p className="mt-0.5 text-ch-meta text-ch-ink-2">
              {stayLabel(hold.arrivalDate, hold.nights)}
            </p>
          )}
        </div>
        {variant === "panel" && <StatusChip status={hold.status} />}
        {token && (
          <button
            type="button"
            onClick={() => (asks ? setConfirming(true) : remove())}
            disabled={removing || confirming}
            title={
              offered
                ? "I don't want this one"
                : queued
                  ? "Call this off"
                  : "Remove from this list"
            }
            aria-label={
              offered
                ? `Don't hold ${hold.unitLabel} for me`
                : queued
                  ? `Call off the hold on ${hold.unitLabel}`
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
      {removeError && <p className="mt-2 text-ch-meta text-ch-ochre-ink">{removeError}</p>}
      {/* THE SECOND ASK. Both of these retract something for good — a later tap on the
          emailed link finds nothing to act on — so they are confirmed, exactly as the
          `hold` action itself is. Each says what it DOES, because "we'll let it go" is the
          part that makes the choice a real one rather than a tidy-up. */}
      {asks && confirming && (
        <div className="mt-3 rounded-xl border border-ch-line bg-ch-card p-3">
          <p className="text-ch-meta leading-normal text-ch-ink-2">
            {offered ? (
              <>
                Drop this one? We won&rsquo;t try for {hold.unitLabel}, and if somebody else is
                watching it they move up the queue. You can still book it yourself when it
                opens.
              </>
            ) : (
              <>
                Call it off? We won&rsquo;t try for {hold.unitLabel} at{" "}
                {releaseLabel(hold.releaseAt)}, and if somebody else is watching it they move
                up the queue. You can still book it yourself when it opens.
              </>
            )}
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={removing}
              className={buttonClasses({ variant: "quiet", className: "flex-1" })}
            >
              {offered ? "Yes, drop it" : "Yes, call it off"}
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
          {/* THE LABEL SITS ABOVE THE BUTTON, not under it. This is one of the two places
              somebody decides to rely on the bot instead of setting an alarm — the other is
              the confirm screen, which carries the full note — and a caveat read after the
              decision is no caveat. The SHORT form, because this is a dense list and the
              long one would push the button off a phone screen. One definition:
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

export function StatusChip({ status }: { status: string }) {
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

export function StatusLine({ hold }: { hold: MyHold }) {
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
