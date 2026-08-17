"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import { stayLabel, releaseLabel } from "@/lib/hold-labels";
import { RC_CART_HOLD_MINUTES } from "@/lib/limits";

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
        {visible.map((h) => (
          <HoldRow key={h.id} hold={h} onRemoved={(id) => setDismissed((d) => [...d, id])} />
        ))}
      </div>
    </section>
  );
}

/**
 * "I'm done with this one" — the only remove this panel can honestly offer.
 *
 * ## Why it is on `released` and nothing else
 *
 * A released hold is FINISHED: the bot has already let go, the site is on
 * ReserveCalifornia for whoever gets there first, and nothing further will happen to the
 * row. It nonetheless sat in this list for ever, because `/api/rc-holds/mine` keeps
 * `carted`/`claiming`/`released` regardless of age and **nothing in the product had ever
 * called the PATCH that retires one** — `markClaimed` existed, with a comment explaining
 * that it distinguishes an abandoned hand-off from a completed one, and had no caller. So
 * every hand-off anyone has ever completed is still on their Watches tab. That is the
 * space the owner reported this eating, and `claimed` is exactly the state for it.
 *
 * The other four statuses get NO remove, and the omission is the design:
 *
 *   - `carted` / `claiming` — the bot is holding a real campsite in a real cart right now.
 *     Hiding that row does not release it; it takes the site off the market for every other
 *     camper and removes the only thing on screen still pointing at it. That is the
 *     2026-08-13 leak with a button on it.
 *   - `offered` / `requested` — there is no decline path server-side, so a remove here could
 *     only ever hide the row while the bot went on to cart the site at 08:00 anyway. A
 *     control that appears to cancel and does not is worse than no control. Giving these a
 *     real "no thanks" means a server-side decline (and freeing the capacity seat an
 *     `offered` row occupies), which is hold-lifecycle work, not panel work.
 *
 * ## The token
 *
 * Read back out of `claimUrl`, which this row already holds — the same hold id + manage
 * token pair that authorises RELEASING the site. Never weaker than the authorisation for
 * the more consequential act on the same row.
 */
function removeToken(claimUrl: string | undefined): string | null {
  if (!claimUrl) return null;
  try {
    return new URL(claimUrl, window.location.origin).searchParams.get("t");
  } catch {
    return null;
  }
}

function HoldRow({ hold, onRemoved }: { hold: MyHold; onRemoved: (id: string) => void }) {
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const held = hold.status === "carted" || hold.status === "claiming";
  const released = hold.status === "released";
  const token = released ? removeToken(hold.claimUrl) : null;
  // READY MEANS THERE IS SOMETHING TO PRESS, not that the hold exists. A `requested` hold
  // is real and important and there is nothing whatever for its owner to do until 08:00, so
  // giving it the same urgent styling as a site sitting in a cart teaches people to ignore
  // the styling.
  const ready = held || released;

  async function remove() {
    if (!token) return;
    setRemoving(true);
    setRemoveError(false);
    try {
      const r = await fetch("/api/rc-holds/claim", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hold.id, token }),
      });
      if (!r.ok) { setRemoveError(true); return; }
      onRemoved(hold.id);
    } catch {
      setRemoveError(true);
    } finally {
      setRemoving(false);
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
            onClick={remove}
            disabled={removing}
            title="Remove from this list"
            aria-label={`Remove ${hold.unitLabel} from this list`}
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
        <p className="mt-2 text-ch-meta text-ch-ochre-ink">
          Could not remove that just now. Try again in a moment.
        </p>
      )}
      {hold.status === "offered" && hold.holdUrl && (
        <Link href={hold.holdUrl} className={buttonClasses({ fullWidth: true, className: "mt-3" })}>
          Hold it for me
        </Link>
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
