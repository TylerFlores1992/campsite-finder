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

  if (!holds || holds.length === 0) return null;

  return (
    <section className={className} aria-label="Sites we're holding">
      <h2 className="mb-2 font-ch-display text-ch-h font-bold">Holds</h2>
      <div className="grid gap-2.5">
        {holds.map((h) => (
          <HoldRow key={h.id} hold={h} />
        ))}
      </div>
    </section>
  );
}

function HoldRow({ hold }: { hold: MyHold }) {
  const held = hold.status === "carted" || hold.status === "claiming";
  const released = hold.status === "released";
  // READY MEANS THERE IS SOMETHING TO PRESS, not that the hold exists. A `requested` hold
  // is real and important and there is nothing whatever for its owner to do until 08:00, so
  // giving it the same urgent styling as a site sitting in a cart teaches people to ignore
  // the styling.
  const ready = held || released;

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
