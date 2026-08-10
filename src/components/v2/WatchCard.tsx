"use client";

import Link from "next/link";
import Card from "@/components/ui/Card";
import Tag from "@/components/ui/Tag";
import Button, { buttonClasses } from "@/components/ui/Button";
import { providerLabel, supportsAutoCart } from "./providers";
import { SHOW_LIKELIHOOD } from "./likelihood";
import { formatRange, nightsBetween, type ISODate } from "@/components/ui/date";

/**
 * A single watch.
 *
 * STATES, and what each is actually derived from — none are invented:
 *   hit         alerted within the poller's 1h re-notify window
 *   authexpired auto-cart is on but the bot's rec.gov session went stale — it
 *               self-heals from the saved login, so this is "reconnecting", not
 *               "you must act"
 *   stalled     this watch's provider is failing its detection canary
 *   paused      active = false
 *   watching    the resting state
 *
 * Two states from the handoff mockup are deliberately absent. "Closed for the
 * season" has no data behind it — there are no open/close dates anywhere in the
 * schema. And the Booked/Missed outcome pills would require attributing a
 * booking back to an alert, which the app can't see.
 *
 * DATES ARE TEXT, NOT A MINI CALENDAR. A calendar belongs where a date is being
 * chosen or availability browsed; on a card it's decoration that costs a third
 * of the space.
 */
export type WatchState = "watching" | "hit" | "paused" | "authexpired" | "stalled";

export interface WatchCardWatch {
  id: string;
  campground_id: string;
  campground_name: string;
  /** Only present if the API selects c.source — badge is omitted without it. */
  campground_source?: string;
  start_date: string;
  end_date: string;
  flex_nights: number | null;
  flex_days: string | null;
  site_type: string | null;
  auto_cart: boolean;
  active?: boolean;
  muted_site_ids?: string[] | null;
  notification_sent_at?: string | null;
  manage_url?: string;
  /** Bare manage token. manage_url points at the OLD /manage page; the redesign
      routes to its own screen so Manage doesn't leave the new UI. */
  manage_token?: string;
  likelihood?: { rate: number; samples: number };
  /** Sites the poller has SEEN open in the last few minutes — see lib/watch-openings.
   *  Absent for providers with no per-site id, which is why the count is optional
   *  everywhere rather than defaulted to zero. */
  open_sites?: { id: string; name: string | null; seenSecondsAgo: number }[];
  /** Every site releasing on a schedule, soonest first. */
  pending_holds?: { unitId: string; unitName: string | null; releaseAt: string; status: string }[];
  /** Sites the bot really did cart, recently — see lib/watch-openings. */
  carted_sites?: { campsiteId: string; at: string }[];
}

export interface WatchCardProps {
  watch: WatchCardWatch;
  /** Providers currently failing their detection canary. */
  stalledSources?: ReadonlySet<string>;
  /** Auto-cart is enabled but the rec.gov session is stale. */
  sessionExpired?: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

/** site_type is stored lowercase ('rv', 'tent'); "rv" shouldn't reach a user. */
const SITE_TYPE_LABEL: Record<string, string> = {
  tent: "Tent",
  rv: "RV",
  cabin: "Cabin",
  group: "Group",
};

function siteTypeLabel(raw: string | null): string | null {
  if (!raw) return null;
  return SITE_TYPE_LABEL[raw] ?? raw;
}

export function watchState(
  w: WatchCardWatch,
  stalledSources?: ReadonlySet<string>,
  sessionExpired?: boolean,
): WatchState {
  if (w.active === false) return "paused";
  // Matches the poller's re-notify window: inside an hour of an alert, the
  // opening it found is probably still there.
  // MEASURED BEATS INFERRED. `open_sites` is what the poller last SAW open; the
  // notification window below is a guess that the opening it alerted on is probably still
  // there. That guess got worse when alerting became transition-based (migration 039): a
  // site that simply stays open no longer re-alerts, so notification_sent_at ages out and
  // the card fell back to "Watching" while the site was still sitting there open.
  if (w.open_sites?.length) return "hit";
  const alerted = w.notification_sent_at ? Date.parse(w.notification_sent_at) : NaN;
  if (Number.isFinite(alerted) && Date.now() - alerted < HOUR_MS) return "hit";
  if (sessionExpired && w.auto_cart && w.campground_source === "ridb") return "authexpired";
  if (w.campground_source && stalledSources?.has(w.campground_source)) return "stalled";
  return "watching";
}

/** "8:00 AM" from RC's zone-less Pacific wall-clock. SLICED, never parsed: `new Date` on
 *  a string with no zone reads it as the viewer's local time and shifts the hour, which on
 *  a badge about an 8am release would name the wrong hour. Same rule as HoldConfirm. */
function releaseLabel(releaseAt: string): string {
  const hhmm = (releaseAt.split("T")[1] ?? "").slice(0, 5);
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return releaseAt;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${ampm}` : `${h12} ${ampm}`;
}

export default function WatchCard({ watch, stalledSources, sessionExpired }: WatchCardProps) {
  const state = watchState(watch, stalledSources, sessionExpired);
  const source = watch.campground_source;

  const start = watch.start_date.slice(0, 10) as ISODate;
  const end = watch.end_date.slice(0, 10) as ISODate;
  const flex = watch.flex_nights != null;
  const nights = flex ? watch.flex_nights! : nightsBetween(start, end);

  const spec = [
    `${nights} ${nights === 1 ? "night" : "nights"}`,
    watch.flex_days === "weekend" ? "weekends only" : null,
    siteTypeLabel(watch.site_type),
    watch.muted_site_ids?.length
      ? `${watch.muted_site_ids.length} site${watch.muted_site_ids.length === 1 ? "" : "s"} muted`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const cardState =
    state === "hit" ? "hit" : state === "authexpired" ? "warn" : state === "paused" ? "paused" : "default";

  return (
    <Card state={cardState} className="flex h-full flex-col">
      <div data-card-dim className="flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {/* Say HOW MANY when we know. "Site open" on a campground with four free
              sites undersells it, and the count is the thing that decides whether it is
              worth opening the watch. Falls back to the bare label for providers with no
              per-site id (ReserveAmerica, GoingToCamp, TN/SC), where a count would be
              invented. */}
          {state === "hit" && (
            <Tag kind="open">
              {watch.open_sites?.length
                ? `${watch.open_sites.length} site${watch.open_sites.length === 1 ? "" : "s"} open`
                : "Site open"}
            </Tag>
          )}
          {/* A hold is a different promise from an opening — it is not bookable yet, and
              saying "open" about it would send someone to a site they cannot take. */}
          {(() => {
            const holds = watch.pending_holds ?? [];
            if (!holds.length) return null;
            const asked = holds.filter((h) => h.status === "requested");
            const offered = holds.filter((h) => h.status === "offered");
            const when = releaseLabel(holds[0].releaseAt);
            return (
              <>
                {/* WHAT YOU ASKED FOR comes first and names the site: it is a commitment
                    the bot will act on, and the user needs to recognise it at 08:00. */}
                {asked.length > 0 && (
                  <Tag kind="cart">
                    Holding {asked.length === 1 ? (asked[0].unitName ?? "a site") : `${asked.length} sites`} · {when}
                  </Tag>
                )}
                {/* The rest are a COUNT, not a list. Naming four sites in a badge is a
                    paragraph; the number is what says "there is a choice to make". */}
                {offered.length > 0 && (
                  <Tag kind="watch">
                    {offered.length} more open{offered.length === 1 ? "s" : ""} {when}
                  </Tag>
                )}
              </>
            );
          })()}
          {/* SAY IT ONLY WHEN IT HAPPENED. This used to render from
              `auto_cart && alerted recently`, which asserted a cart nobody had checked
              for — and was wrong three ways: it never read the cart record; it fired on
              ReserveCalifornia watches, where `isAutocartLane` only matches `ridb` so an
              availability cart cannot happen at all; and once the badge began keying off
              seen-open it fired for any open site rather than a recent alert. Someone sent
              to an empty recreation.gov cart at 8am loses the site while they look for it.

              `carted_sites` is the bot's own record (autocart_jobs), the same table the
              one-cart-per-site rule reads, windowed to roughly how long rec.gov holds a
              cart. */}
          {watch.carted_sites?.length ? (
            <Tag kind="cart">
              {watch.carted_sites.length === 1 ? "In your cart" : `${watch.carted_sites.length} in your cart`}
            </Tag>
          ) : null}
          {/* Still worth saying when the session is the reason nothing was carted — that
              is a thing the user can fix, unlike an opening the bot simply did not win. */}
          {state === "hit" && watch.auto_cart && sessionExpired && watch.campground_source === "ridb" && (
            <Tag kind="paused">Not carted — reconnecting</Tag>
          )}
          {state === "watching" && <Tag kind="watch">Watching</Tag>}
          {state === "paused" && <Tag kind="paused">Paused</Tag>}
          {state === "authexpired" && <Tag kind="paused">Auto-cart reconnecting</Tag>}
          {state === "stalled" && <Tag kind="paused">Checks paused</Tag>}
          {source && <Tag kind="src">{providerLabel(source, watch.campground_id)}</Tag>}
        </div>

        <h3 className="font-ch-display text-ch-park font-bold leading-tight tracking-[-.02em]">
          {watch.campground_name}
        </h3>
        <p className="mt-2.5 text-ch-body font-bold text-ch-ink-2">
          {flex ? `Any ${nights} nights, ${formatRange(start, end)}` : formatRange(start, end)}
        </p>
        <p className="mt-0.5 text-ch-meta text-ch-muted">{spec}</p>

        {/* OFF until the history is deep enough to be worth showing. See
            ./likelihood.ts — one flag turns every percentage back on. */}
        {SHOW_LIKELIHOOD && watch.likelihood && (
          <p className="mt-1.5 text-ch-fine text-ch-muted">
            Opens up on {Math.round(watch.likelihood.rate * 100)}% of checks for dates this far out
          </p>
        )}
      </div>

      {state === "authexpired" && (
        <div className="mt-3 border-t border-ch-line pt-3">
          {/* The session going stale means the machine hasn't checked in, not
              that a login aged out — and the saved login means it recovers on its
              own. See AutoCartSettings for the full note. */}
          <p className="mb-2.5 text-ch-meta leading-normal text-ch-ink-2">
            Auto-cart can&apos;t hold a site for you right now — the machine holding your
            Recreation.gov session is reconnecting. It signs back in by itself, and we&apos;re still
            checking and still alerting you meanwhile.
          </p>
          <a href="/connect" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
            Sign in again if this sticks
          </a>
        </div>
      )}

      {state === "stalled" && (
        <div className="mt-3 border-t border-ch-line pt-3">
          <p className="text-ch-fine text-ch-muted">
            {source ? providerLabel(source, watch.campground_id) : "This provider"}
            {" isn't responding. We're retrying — your other watches are unaffected."}
          </p>
        </div>
      )}

      <div className="mt-3 flex gap-1.5 border-t border-ch-line pt-2.5">
        <a
          // from=watches so the detail page's back link says "Back to watches"
          // and returns there — landing on Explore is disorienting when you
          // never came from a search.
          href={`/campground/${encodeURIComponent(watch.campground_id)}?from=watches`}
          className={buttonClasses({ variant: "quiet", size: "sm", className: "flex-1" })}
        >
          Calendar
        </a>
        {watch.manage_token ? (
          <Link
            href={`/manage/${watch.manage_token}`}
            className={buttonClasses({ variant: "quiet", size: "sm", className: "flex-1" })}
          >
            Manage
          </Link>
        ) : (
          <Button variant="quiet" size="sm" className="flex-1" disabled>
            Manage
          </Button>
        )}
      </div>
    </Card>
  );
}
