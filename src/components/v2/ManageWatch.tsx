"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import Button, { buttonClasses } from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Tag from "@/components/ui/Tag";
import Collapsible from "@/components/ui/Collapsible";
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
 * The old page's campsite-mute list is deliberately NOT rebuilt from the
 * availability endpoint here. That fetch enumerates every site in the
 * campground on load, and the useful subset — sites you've actually been
 * alerted about — is what /api/manage already returns.
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

export default function ManageWatch({ token }: { token: string }) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [muted, setMuted] = useState<ReadonlySet<string>>(new Set());
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
      const d = (await r.json()) as { watch: Watch; alerts: Alert[]; sites: Site[] };
      setWatch(d.watch);
      setAlerts(d.alerts ?? []);
      setSites(d.sites ?? []);
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

  const act = useCallback(
    async (op: string, siteId?: string) => {
      setBusy(op + (siteId ?? ""));
      // Optimistic for mute/unmute — a checkbox that waits on a round trip feels
      // broken. Rolled back below if the write fails.
      const before = muted;
      if (siteId) {
        const next = new Set(muted);
        if (op === "mute") next.add(siteId);
        else next.delete(siteId);
        setMuted(next);
      }
      try {
        const r = await fetch(`/api/manage/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, siteId }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as { removed?: boolean; watch?: Watch };
        if (d.removed) setRemoved(true);
        else if (d.watch) {
          setWatch(d.watch);
          setMuted(new Set(d.watch.muted_site_ids ?? []));
        }
      } catch {
        if (siteId) setMuted(before);
        setError("That didn't save. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [token, muted],
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
        <Link href="/v2/watches" className={buttonClasses({ className: "mt-4" })}>
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
          href="/v2/watches"
          className={buttonClasses({ variant: "quiet", className: "mt-4" })}
        >
          Back to watches
        </Link>
      </div>
    );
  }

  if (!watch) return null;

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
        href="/v2/watches"
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
            href={`/v2/campground/${encodeURIComponent(watch.campground_id)}?from=watches`}
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

      {sites.length > 0 && (
        <div className="mt-4">
          <Collapsible
            label="Sites you've been alerted about"
            summary={muted.size ? `${muted.size} muted` : `${sites.length}`}
          >
            <p className="pb-2 text-ch-fine leading-normal text-ch-muted">
              Mute a site to stop hearing about it — the site by the road, the one you
              already tried. The watch keeps running for everything else.
            </p>
            <ul>
              {sites.map((s) => {
                const isMuted = muted.has(s.id);
                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-2.5 border-b border-ch-line py-2.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-ch-body font-bold">
                      {s.name ?? s.id}
                    </span>
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={busy === (isMuted ? "unmute" : "mute") + s.id}
                      onClick={() => void act(isMuted ? "unmute" : "mute", s.id)}
                    >
                      {isMuted ? "Unmute" : "Mute"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Collapsible>
        </div>
      )}

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
