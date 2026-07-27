import Link from "next/link";
import Card from "@/components/ui/Card";
import Tag from "@/components/ui/Tag";
import { buttonClasses } from "@/components/ui/Button";
import { providerLabel, supportsAutoCart } from "./providers";
import { SHOW_LIKELIHOOD } from "./likelihood";
import WatchCta from "./WatchCta";
import FavoriteHeart from "./FavoriteHeart";
import type { Campground } from "@/lib/types";

/**
 * A search result.
 *
 * THREE AVAILABILITY STATES, NOT TWO. `hasAvailability` is
 * true | false | undefined, and undefined genuinely means "we couldn't check" —
 * a provider timeout or a WAF block, not "booked". Collapsing it into "booked"
 * would stamp that badge on hundreds of campgrounds during a provider outage,
 * which is the exact bug the search adapters throw-instead-of-return-false to
 * avoid. Unknown says so.
 *
 * The card links to the detail page rather than straight out to the provider:
 * the calendar is where a user decides, and a raw outbound link loses them.
 */
export interface ResultCardProps {
  campground: Campground;
  /** Active search dates, forwarded so the detail page opens on the right month. */
  startDate?: string;
  endDate?: string;
  /** Favourites are owned by the page, so one store backs every heart on it.
      Omit onToggleFavorite (signed out) and no heart renders at all — better
      than one that answers a click with a sign-in wall. */
  favorite?: boolean;
  onToggleFavorite?: () => void;
}

export default function ResultCard({
  campground,
  startDate,
  endDate,
  favorite = false,
  onToggleFavorite,
}: ResultCardProps) {
  const { id, name, address, source, distanceMiles, hasAvailability } = campground;

  // With no dates, /api/search never checks availability — so every card would
  // read "Couldn't check", which sounds like a fault rather than a question we
  // were never asked. Say nothing about availability until dates exist.
  const datesChosen = Boolean(startDate && endDate);
  const open = datesChosen && hasAvailability === true;
  const booked = datesChosen && hasAvailability === false;
  const unknown = datesChosen && hasAvailability === undefined;

  const place = [address?.city, address?.state].filter(Boolean).join(", ");
  const distance =
    typeof distanceMiles === "number" ? `${Math.round(distanceMiles)} mi away` : null;

  const href = {
    pathname: `/v2/campground/${encodeURIComponent(id)}`,
    query: { ...(startDate ? { start: startDate } : {}), ...(endDate ? { end: endDate } : {}) },
  };

  return (
    <Card state={open ? "hit" : "default"} className="flex h-full flex-col">
      <div className="flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {open && <Tag kind="open">Sites open</Tag>}
          {booked && <Tag kind="paused">Booked — watch it</Tag>}
          {unknown && (
            <Tag kind="paused" srPrefix="Availability:">
              Couldn&apos;t check
            </Tag>
          )}
          {supportsAutoCart(source) && <Tag kind="cart">Auto-cart</Tag>}
          <Tag kind="src">{providerLabel(source, id)}</Tag>
        </div>

        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 font-ch-display text-ch-park font-bold leading-tight tracking-[-.02em]">
            {name}
          </h3>
          {onToggleFavorite && (
            <FavoriteHeart
              favorite={favorite}
              onToggle={onToggleFavorite}
              campgroundName={name}
              className="-mr-1.5 -mt-1"
            />
          )}
        </div>
        <p className="mt-0.5 text-ch-meta text-ch-muted">
          {[place, distance].filter(Boolean).join(" · ")}
        </p>

        {/* Feature E headline, OFF until there's enough history to be worth
            showing. The API still returns it and the markup is one flag away —
            flip SHOW_LIKELIHOOD in ./likelihood.ts when the data is ready. */}
        {SHOW_LIKELIHOOD && campground.likelihood && (
          <p className="mt-2 text-ch-fine text-ch-muted">
            Opens up on {Math.round(campground.likelihood.rate * 100)}% of checks{" "}
            {campground.likelihood.label}
          </p>
        )}
      </div>

      <div className="mt-3 grid gap-1.5 border-t border-ch-line pt-3">
        {/* A link, not a button — it navigates, so middle-click and
            open-in-new-tab have to work. buttonClasses keeps it visually
            identical to a real Button without duplicating the variant map. */}
        <Link href={href} className={buttonClasses({ variant: open ? "primary" : "quiet", fullWidth: true })}>
          {open ? "See what's open" : "See full calendar"}
        </Link>
        {/* Booked is the moment the product exists for — offer the watch right
            here rather than making the user find the New watch screen. Gated
            identically everywhere by WatchCta. */}
        {!open && (
          <WatchCta
            campgroundId={id}
            startDate={startDate}
            endDate={endDate}
            variant="primary"
            label="Start a watch"
          />
        )}
      </div>
    </Card>
  );
}
