"use client";

import HoldRow, { type MyHold } from "./HoldRow";
import { isFinishedHandoff, byUrgency } from "@/lib/hold-ordering";

/**
 * Sites CampHawk is HOLDING FOR YOU RIGHT NOW — on the Watches tab, above everything.
 *
 * ## Why this is a feature and not decoration
 *
 * A hold is the most perishable object in the product: the bot has a real campsite locked
 * in a real ReserveCalifornia cart, RC drops that cart after about fifteen minutes, and
 * before this the ONLY way in was the alert that announced it. One email, one push, one
 * device. Swipe the notification away and the site was unreachable — the claim URL carries
 * a token, so it cannot be guessed, and nothing in the app listed it.
 *
 * ## WHAT IT NO LONGER SHOWS (2026-09-04)
 *
 * The `offered` and `requested` lists moved onto the watch cards, where the rest of that
 * watch's information lives. Both are about TOMORROW morning and neither can be acted on
 * now, so stacking them here pushed the thing with a fifteen-minute fuse further down the
 * page the busier a user got.
 *
 * **What is left here is exactly what a card will not show**, which is `panelHolds`'s rule
 * and deliberately not an urgency test — see `@/lib/hold-placement`. That one phrasing also
 * keeps the ORPHANS: an `offered` hold whose watch was deleted, or any hold at all when
 * `/api/watches` failed while `/api/rc-holds/mine` succeeded. Those have no card to appear
 * on, and they are why this component still renders in `WatchesList`'s error and
 * "no watches yet" branches.
 *
 * ## In-app navigation, deliberately
 *
 * The links inside a row are plain `<Link>`s. The claim screen's automatic cart depends on
 * running inside the app's own webview — `canInject` — and anything that hands the URL to
 * the system browser (`Browser.open`, a `target="_blank"`) silently drops the user onto the
 * manual path, which is precisely the failure the whole hand-off exists to remove.
 */
export default function HoldsPanel({
  holds,
  onRemoved,
  className,
}: {
  holds: MyHold[];
  onRemoved: (id: string) => void;
  className?: string;
}) {
  if (holds.length === 0) return null;

  // FINISHED HAND-OFFS ARE COLLAPSED, NOT DELETED. The row is still the only route back to
  // a site somebody may have booked and want to check, so it stays reachable — it just
  // stops occupying the space above a live offer.
  const live = holds.filter((h) => !isFinishedHandoff(h)).sort(byUrgency);
  const finished = holds.filter(isFinishedHandoff).sort(byUrgency);

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
          <HoldRow key={h.id} hold={h} onRemoved={onRemoved} />
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
              <HoldRow key={h.id} hold={h} onRemoved={onRemoved} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
