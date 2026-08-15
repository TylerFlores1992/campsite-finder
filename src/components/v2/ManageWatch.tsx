"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import Button, { buttonClasses } from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Tag from "@/components/ui/Tag";
import Collapsible from "@/components/ui/Collapsible";
import SiteMuteList, { type MuteSite } from "./SiteMuteList";
import { providerLabel, supportsAutoCart } from "./providers";
import { formatRange, nightsBetween, type ISODate } from "@/components/ui/date";

/**
 * Manage one watch, in the redesign.
 *
 * WHY THIS EXISTS AT ALL: the Watches list's Manage button followed
 * `manage_url`, which points at /manage/<token> — the OLD page. Tapping it
 * inside the new UI dropped you into the previous design mid-flow. This is the
 * same screen wearing the ch-* system, hitting the SAME /api/manage/<token>
 * endpoint with the same ops. No API change beyond the watches list also
 * returning the bare token so this route can be built.
 *
 * TOKEN-AUTHORIZED, not session-authorized, exactly like the old page. That's
 * what lets a tapped SMS link work with no login, and every op is scoped server
 * side to the token's own watch.
 *
 * MUTING ANY CAMPSITE, not just ones you've been alerted about. An earlier
 * version of this screen only listed sites from the alert history, on the theory
 * that those were the useful subset. That's backwards for the case that
 * actually matters: you know the site by the road is noisy BEFORE it opens, and
 * waiting to be alerted about it first means being woken up by exactly the site
 * you wanted to avoid. The full inventory is loaded from the availability
 * endpoint (same call the old page made), with the alerted sites merged in and
 * shown first — and a filter, since a big campground runs to hundreds of sites.
 *
 * Best-effort: providers other than rec.gov / ReserveCalifornia may not
 * enumerate. When the list comes back empty we fall back to the alerted sites,
 * so the screen degrades to what it did before rather than to nothing.
 *
 * THE MUTE LIST ITSELF NOW LIVES IN `SiteMuteList` (2026-08-15), because /new
 * offers the same control and a second copy of it would drift. The inventory
 * load, the filter, the muted-stay-visible rule and the bulk buttons moved there
 * wholesale; what stays here is the batch WRITE, which is this screen's own —
 * /new has no watch to write to yet.
 */

interface Watch {
  id: string;
  campground_id: string;
  campground_name: string;
  source: string;
  reservations_url: string | null;
  start_date: string;
  end_date: string;
  min_nights: number;
  flex_nights: number | null;
  flex_days: string | null;
  site_type: string | null;
  active: boolean;
  auto_cart: boolean;
  muted_site_ids: string[];
}

interface Alert {
  created_at: string;
  channel: string;
  status: string;
  site_name: string | null;
}

interface Site {
  id: string;
  name: string | null;
  muted: boolean;
}

/** A row in the mute list: every site we can enumerate, plus the alerted ones. */
/** A site the poller has seen open in the last few minutes. See lib/watch-openings for
 *  why this is a last-seen record rather than a live check. */
interface OpenSite { id: string; name: string | null; seenSecondsAgo: number; bookUrl?: string | null }

/** A site locked until a scheduled release. `offered` is one tap from being held. */
interface Hold {
  unitId: string;
  unitName: string | null;
  arrivalDate: string;
  nights: number;
  releaseAt: string;
  status: "offered" | "requested";
  holdUrl?: string | null;
}

/** "just now" / "2 min ago". Deliberately coarse: the underlying figure is the age of a
 *  poll, and a to-the-second reading would imply a precision this is not. */
/** "8 AM" from RC's zone-less Pacific wall-clock. Sliced, never parsed — see HoldConfirm. */
function releaseLabel(releaseAt: string): string {
  const hhmm = (releaseAt.split("T")[1] ?? "").slice(0, 5);
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return releaseAt;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${ampm}` : `${h12} ${ampm}`;
}

function seenLabel(secs: number): string {
  if (secs < 90) return "just now";
  return `${Math.round(secs / 60)} min ago`;
}

export default function ManageWatch({ token }: { token: string }) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  // Sites this watch has ALERTED about. They seed the full inventory below, and
  // are the whole list on a provider that can't enumerate its sites.
  const [alertedSites, setAlertedSites] = useState<Site[]>([]);
  const [muted, setMuted] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<OpenSite[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/manage/${token}`);
      if (!r.ok) {
        setError(
          r.status === 404
            ? "This link has expired. Open the watch from your Watches list instead."
            : "Could not load this watch.",
        );
        return;
      }
      const d = (await r.json()) as {
        watch: Watch; alerts: Alert[]; sites: Site[]; open?: OpenSite[]; holds?: Hold[];
      };
      setOpen(d.open ?? []);
      setHolds(d.holds ?? []);
      setWatch(d.watch);
      setAlerts(d.alerts ?? []);
      setAlertedSites(d.sites ?? []);
      setMuted(new Set(d.watch.muted_site_ids ?? []));
    } catch {
      setError("Could not load this watch.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Whole-watch ops: stop, resume, remove. Muting goes through `changeMutes`. */
  const act = useCallback(
    async (op: string) => {
      setBusy(op);
      try {
        const r = await fetch(`/api/manage/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as { removed?: boolean; watch?: Watch };
        if (d.removed) setRemoved(true);
        else if (d.watch) {
          setWatch(d.watch);
          setMuted(new Set(d.watch.muted_site_ids ?? []));
        }
      } catch {
        setError("That didn't save. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [token],
  );

  /**
   * Apply a batch of mutes/unmutes. ONE request whichever size it is — "mute all"
   * on a 300-site campground must not be 300 round trips from a phone.
   *
   * Optimistic, like the single-site path it replaces: a control that waits on a
   * round trip feels broken. Rolled back on failure, and the server's own
   * `muted_site_ids` is what we settle on, so a partial write can't leave the
   * screen claiming something the poller won't honour.
   */
  const changeMutes = useCallback(
    async (change: { mute?: string[]; unmute?: string[] }): Promise<boolean> => {
      const before = muted;
      const next = new Set(muted);
      for (const id of change.mute ?? []) next.add(id);
      for (const id of change.unmute ?? []) next.delete(id);
      setMuted(next);
      try {
        const r = await fetch(`/api/manage/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "setMutes", ...change }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as { watch?: Watch };
        if (d.watch) {
          setWatch(d.watch);
          setMuted(new Set(d.watch.muted_site_ids ?? []));
        }
        return true;
      } catch {
        setMuted(before);
        return false;
      }
    },
    [token, muted],
  );

  /** Stable identity, or SiteMuteList's loader refetches the grid on every render. */
  const seedSites = useMemo<MuteSite[]>(
    () => alertedSites.map((s) => ({ id: s.id, name: s.name, loop: null, alerted: true })),
    [alertedSites],
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-[46rem] px-5 py-6">
        <div className="h-[280px] animate-pulse rounded-ch-card border border-ch-line bg-ch-card motion-reduce:animate-none" />
      </div>
    );
  }

  if (removed) {
    return (
      <div className="mx-auto max-w-[46ch] px-5 py-12 text-center">
        <h1 className="font-ch-display text-ch-h font-bold">Watch removed</h1>
        <p className="mt-1.5 text-ch-body text-ch-muted">
          We&apos;ve stopped checking, and you won&apos;t get any more alerts for it.
        </p>
        <Link href="/watches" className={buttonClasses({ className: "mt-4" })}>
          Back to watches
        </Link>
      </div>
    );
  }

  if (error && !watch) {
    return (
      <div className="mx-auto max-w-[46ch] px-5 py-12 text-center">
        <h1 className="font-ch-display text-ch-h font-bold">Can&apos;t open this watch</h1>
        <p className="mt-1.5 text-ch-body text-ch-muted">{error}</p>
        <Link
          href="/watches"
          className={buttonClasses({ variant: "quiet", className: "mt-4" })}
        >
          Back to watches
        </Link>
      </div>
    );
  }

  if (!watch) return null;

  const openIds = new Set(open.map((o) => o.id));
  const isRecGov = watch?.source === "ridb";

  const start = watch.start_date.slice(0, 10) as ISODate;
  const end = watch.end_date.slice(0, 10) as ISODate;
  const flex = watch.flex_nights != null;
  const nights = flex ? watch.flex_nights! : nightsBetween(start, end);
  const bookUrl =
    watch.source === "ridb"
      ? `https://www.recreation.gov/camping/campgrounds/${watch.campground_id}`
      : watch.reservations_url;

  return (
    <div className="mx-auto max-w-[46rem] px-5 py-5">
      <Link
        href="/watches"
        className="inline-flex items-center gap-1 pb-3 text-[13px] font-bold text-ch-green hover:text-ch-green-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        Back to watches
      </Link>

      <Card state={watch.active ? "default" : "paused"}>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {watch.active ? <Tag kind="watch">Watching</Tag> : <Tag kind="paused">Paused</Tag>}
          {watch.auto_cart && supportsAutoCart(watch.source) && <Tag kind="cart">Auto-cart</Tag>}
          <Tag kind="src">{providerLabel(watch.source, watch.campground_id)}</Tag>
        </div>
        <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          {watch.campground_name}
        </h1>
        <p className="mt-2 text-ch-body font-bold text-ch-ink-2">
          {flex ? `Any ${nights} nights, ${formatRange(start, end)}` : formatRange(start, end)}
        </p>
        <p className="mt-0.5 text-ch-meta text-ch-muted">
          {[
            `${nights} ${nights === 1 ? "night" : "nights"}`,
            watch.flex_days === "weekend" ? "weekends only" : null,
            muted.size ? `${muted.size} site${muted.size === 1 ? "" : "s"} muted` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-ch-line pt-3">
          <Link
            href={`/campground/${encodeURIComponent(watch.campground_id)}?from=watches`}
            className={buttonClasses({ variant: "quiet", size: "sm" })}
          >
            Calendar
          </Link>
          {bookUrl && (
            <a
              href={bookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: "quiet", size: "sm" })}
            >
              Open on {providerLabel(watch.source, watch.campground_id)}
            </a>
          )}
          <Button
            variant={watch.active ? "quiet" : "primary"}
            size="sm"
            disabled={busy === (watch.active ? "stop" : "resume")}
            onClick={() => void act(watch.active ? "stop" : "resume")}
          >
            {watch.active ? "Pause checks" : "Resume checks"}
          </Button>
        </div>
      </Card>

      {error && (
        <p role="alert" className="mt-3 text-ch-body text-ch-alert">
          {error}
        </p>
      )}

      {/* OPEN RIGHT NOW, above the mute list rather than inside it. The mute list is a
          settings control sorted alphabetically over hundreds of rows; "what can I book
          this second" is a different question and does not survive being a marker on row
          214. Times are shown because this is a LAST-SEEN record, not a live check —
          see lib/watch-openings. */}
      {open.length > 0 && (
        <section className="mt-4 rounded-xl border border-ch-green-deep/30 bg-ch-green-soft p-4">
          <h2 className="text-ch-label font-bold tracking-[.1em] text-ch-ink uppercase">
            {open.length} site{open.length === 1 ? "" : "s"} open now
          </h2>
          <ul className="mt-2 space-y-2">
            {open.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ch-body font-bold text-ch-ink">
                    {o.name ?? o.id}
                  </span>
                  <span className="block text-ch-fine text-ch-muted">{seenLabel(o.seenSecondsAgo)}</span>
                </span>
                {o.bookUrl && (
                  <a
                    href={o.bookUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-ch bg-ch-green-deep px-3 py-1.5 text-ch-meta font-bold text-white"
                  >
                    Book
                  </a>
                )}
              </li>
            ))}
          </ul>
          {/* SAY WHERE THE LINK LANDS, because it differs by provider and the row names a
              site. rec.gov has a real per-campsite page; ReserveCalifornia has no per-site
              URL and no linkable dates, so the best that exists is the loop. Letting the
              user expect a site page and land on a loop list is how the 8am window gets
              spent hunting. */}
          <p className="mt-2 text-ch-fine text-ch-muted">
            Last seen by our checks, not a live look.{" "}
            {isRecGov
              ? "Book goes straight to the site page."
              : "Book opens the loop on the provider — pick the site and dates there."}
          </p>
        </section>
      )}

      {/* ALREADY YOURS, above the offers. This is a commitment the bot will act on at
          08:00 and the one thing on this screen the user must be able to recognise in a
          hurry; burying it under a list of things they could ALSO do inverts that. */}
      {holds.some((h) => h.status === "requested") && (
        <section className="mt-4 rounded-xl border border-ch-green-deep bg-ch-green-soft p-4">
          <h2 className="text-ch-label font-bold tracking-[.1em] text-ch-ink uppercase">
            We&rsquo;ll grab {holds.filter((h) => h.status === "requested").length === 1 ? "this" : "these"} for you
          </h2>
          <ul className="mt-2 space-y-1">
            {holds.filter((h) => h.status === "requested").map((h) => (
              <li key={h.unitId} className="flex items-baseline justify-between gap-3 text-ch-body">
                <span className="min-w-0 truncate font-bold text-ch-ink">{h.unitName ?? h.unitId}</span>
                <span className="shrink-0 text-ch-fine text-ch-muted">{releaseLabel(h.releaseAt)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-ch-fine text-ch-muted">
            You&rsquo;ll get an alert the moment it&rsquo;s in the cart, with a link to take it.
          </p>
        </section>
      )}

      {/* OPENING ON A SCHEDULE — each with its own one-tap hold. These are not bookable
          yet, so they are deliberately styled as an offer rather than as availability;
          calling them "open" would send someone at a site they cannot take. */}
      {holds.some((h) => h.status === "offered") && (
        <section className="mt-4 rounded-xl border border-ch-line p-4">
          <h2 className="text-ch-label font-bold tracking-[.1em] text-ch-muted uppercase">
            Opening {releaseLabel(holds.find((h) => h.status === "offered")!.releaseAt)}
          </h2>
          <ul className="mt-2 space-y-2">
            {holds.filter((h) => h.status === "offered").map((h) => (
              <li key={h.unitId} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ch-body font-bold text-ch-ink">
                    {h.unitName ?? h.unitId}
                  </span>
                  <span className="block text-ch-fine text-ch-muted">
                    {h.nights} night{h.nights === 1 ? "" : "s"} from {h.arrivalDate}
                  </span>
                </span>
                {h.holdUrl ? (
                  <a
                    href={h.holdUrl}
                    className="shrink-0 rounded-ch bg-ch-green-deep px-3 py-1.5 text-ch-meta font-bold text-white"
                  >
                    Hold it
                  </a>
                ) : (
                  <span className="shrink-0 text-ch-fine text-ch-muted">link unavailable</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-ch-fine text-ch-muted">
            Only ask for one you actually want — while we hold it, nobody else can book it.
          </p>
        </section>
      )}

      <div className="mt-4">
        <Collapsible
          label="Mute individual campsites"
          summary={muted.size ? `${muted.size} muted` : undefined}
        >
          <p className="pb-2 text-ch-fine leading-normal text-ch-muted">
            Mute a site to stop hearing about it — the one by the road, the one with no shade,
            the one you already tried. The watch keeps running for every other site.
          </p>
          <SiteMuteList
            campgroundId={watch.campground_id}
            month={watch.start_date.slice(0, 7)}
            muted={muted}
            onChange={changeMutes}
            seedSites={seedSites}
            annotate={(id) => [openIds.has(id) ? "open now" : null]}
            emptyMessage="We can't list this campground's individual sites, so there's nothing to mute yet. Sites you get alerted about will appear here."
          />
        </Collapsible>
      </div>

      {alerts.length > 0 && (
        <div className="mt-3">
          <Collapsible label="Alerts sent" summary={`${alerts.length}`}>
            <ul>
              {alerts.map((a, i) => (
                <li
                  key={`${a.created_at}-${i}`}
                  className="flex items-center gap-2.5 border-b border-ch-line py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ch-body font-bold">
                      {a.site_name ?? "A site opened up"}
                    </p>
                    <p className="mt-0.5 text-ch-fine text-ch-muted">
                      {new Date(a.created_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}{" "}
                      · {a.channel}
                      {a.status !== "sent" ? ` · ${a.status}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Collapsible>
        </div>
      )}

      {/* Delete last, and behind a confirm step. window.confirm() is what the old
          page used; it's suppressible and looks nothing like the rest of the UI,
          so the confirmation is in-page. */}
      <div className="mt-5 rounded-ch-card border border-ch-line bg-ch-card p-4">
        {!confirmRemove ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ch-fine text-ch-muted">
              Done with this trip? Removing the watch deletes it and its alert history.
            </p>
            <Button variant="quiet" size="sm" onClick={() => setConfirmRemove(true)}>
              Remove watch
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ch-body font-bold">Remove this watch permanently?</p>
            <span className="flex gap-1.5">
              <Button variant="quiet" size="sm" onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
              <Button
                variant="warn"
                size="sm"
                disabled={busy === "remove"}
                onClick={() => void act("remove")}
              >
                Remove
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
