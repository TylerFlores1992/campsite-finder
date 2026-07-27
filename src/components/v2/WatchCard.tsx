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
 *   authexpired auto-cart is on but the rec.gov session went stale
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
  const alerted = w.notification_sent_at ? Date.parse(w.notification_sent_at) : NaN;
  if (Number.isFinite(alerted) && Date.now() - alerted < HOUR_MS) return "hit";
  if (sessionExpired && w.auto_cart && w.campground_source === "ridb") return "authexpired";
  if (w.campground_source && stalledSources?.has(w.campground_source)) return "stalled";
  return "watching";
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
          {state === "hit" && <Tag kind="open">Site open</Tag>}
          {/* Only claim the cart when auto-cart could actually have run. With a
              stale session the poller falls back to a plain alert and nothing is
              carted — telling the user it's waiting for them would send them to
              an empty cart while the site goes to someone else. */}
          {state === "hit" && watch.auto_cart && !sessionExpired && (
            <Tag kind="cart">In your cart</Tag>
          )}
          {state === "hit" && watch.auto_cart && sessionExpired && (
            <Tag kind="alert">Not carted — sign-in expired</Tag>
          )}
          {state === "watching" && <Tag kind="watch">Watching</Tag>}
          {state === "paused" && <Tag kind="paused">Paused</Tag>}
          {state === "authexpired" && <Tag kind="alert">Action needed</Tag>}
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
          <p className="mb-2.5 text-ch-meta leading-normal text-ch-ink-2">
            Your Recreation.gov sign-in expired, so auto-cart is off for this watch. We&apos;re still
            checking and will still alert you — we just can&apos;t hold the site while you get to
            your phone.
          </p>
          <a href="/connect" className={buttonClasses({ variant: "warn", fullWidth: true })}>
            Reconnect Recreation.gov
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
          href={`/v2/campground/${encodeURIComponent(watch.campground_id)}?from=watches`}
          className={buttonClasses({ variant: "quiet", size: "sm", className: "flex-1" })}
        >
          Calendar
        </a>
        {watch.manage_token ? (
          <Link
            href={`/v2/manage/${watch.manage_token}`}
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
