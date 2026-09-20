import Link from "next/link";
import Card from "@/components/ui/Card";
import Tag from "@/components/ui/Tag";
import { buttonClasses } from "@/components/ui/Button";
import { providerLabel, supportsAutoCart } from "./providers";
import { SHOW_LIKELIHOOD } from "./likelihood";
import WatchCta from "./WatchCta";
import FavoriteHeart from "./FavoriteHeart";
import {
  bookingPolicy,
  watchable,
  FIRST_COME_BADGE,
  FIRST_COME_WHY,
} from "@/lib/booking-policy";
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
 * AND A FOURTH STATE THAT IS NOT ABOUT THE READ AT ALL. A campground that takes no
 * reservations returns no campsites because there are none, so `hasAvailability` is
 * correctly `undefined` and this card was stamping OUR failure badge over THEIR booking
 * policy — 678 rec.gov campgrounds, and 21 of 21 unknowns in one measured search. Worse,
 * it offered a watch, which on a first-come campground can never fire: no booking, no
 * cancellation, nothing to alert about. `bookingPolicy` decides; see that module for the
 * measurement and for why only an explicit `false` withholds anything.
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
  /** The Explore search, encoded. Round-tripped through the detail page so its
      back link restores the search instead of resetting it. */
  backTo?: string;
  favorite?: boolean;
  onToggleFavorite?: () => void;
}

export default function ResultCard({
  campground,
  startDate,
  endDate,
  backTo,
  favorite = false,
  onToggleFavorite,
}: ResultCardProps) {
  const { id, name, address, source, distanceMiles, hasAvailability, reservable } =
    campground;

  // With no dates, /api/search never checks availability — so every card would
  // read "Couldn't check", which sounds like a fault rather than a question we
  // were never asked. Say nothing about availability until dates exist.
  const datesChosen = Boolean(startDate && endDate);
  const policy = bookingPolicy(reservable);
  const firstCome = policy === "first-come";
  const open = datesChosen && hasAvailability === true;
  const booked = datesChosen && hasAvailability === false;
  // `&& !firstCome` is the fix: a first-come campground reports `undefined` for the whole
  // life of the watch, so without this the two badges are the same cards and the wrong one
  // wins. It is the reason to gate rather than to reorder — both would otherwise render.
  const unknown = datesChosen && hasAvailability === undefined && !firstCome;

  const place = [address?.city, address?.state].filter(Boolean).join(", ");
  const distance =
    typeof distanceMiles === "number" ? `${Math.round(distanceMiles)} mi away` : null;

  const href = {
    pathname: `/campground/${encodeURIComponent(id)}`,
    query: {
      ...(startDate ? { start: startDate } : {}),
      ...(endDate ? { end: endDate } : {}),
      ...(backTo ? { back: backTo } : {}),
    },
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
          {firstCome && (
            <Tag kind="paused" srPrefix="Booking:">
              {FIRST_COME_BADGE}
            </Tag>
          )}
          {/* AND NOT THE AUTO-CART BADGE EITHER. `supportsAutoCart` is `source === 'ridb'`
              — a fact about the PROVIDER — and every one of the 678 non-reservable
              campgrounds is rec.gov, so this badge was on all of them, promising to put a
              site in a cart that can never exist. The provider fact is left alone and the
              call site answers the second question. */}
          {supportsAutoCart(source) && watchable(policy) && <Tag kind="cart">Auto-cart</Tag>}
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
          {open ? "See what's open" : firstCome ? "See details" : "See full calendar"}
        </Link>
        {/* Booked is the moment the product exists for — offer the watch right
            here rather than making the user find the New watch screen. Gated
            identically everywhere by WatchCta.

            AND WITHHELD ENTIRELY ON A FIRST-COME CAMPGROUND, which is the half that
            matters more than the badge: there is no reservation to cancel, so the watch
            could never fire and the user would stop looking on the strength of it. The
            sentence replaces the button rather than merely hiding it — a card that offers
            nothing and says nothing reads as broken. */}
        {!open &&
          (watchable(policy) ? (
            <WatchCta
              campgroundId={id}
              startDate={startDate}
              endDate={endDate}
              variant="primary"
              label="Start a watch"
            />
          ) : (
            <p className="text-ch-fine leading-normal text-ch-muted">{FIRST_COME_WHY}</p>
          ))}
      </div>
    </Card>
  );
}
