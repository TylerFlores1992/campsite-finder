"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import Collapsible from "@/components/ui/Collapsible";
import WatchCard, { type WatchCardWatch } from "./WatchCard";
import HoldsPanel from "./HoldsPanel";
import WatchCta from "./WatchCta";
import { PlanOptionsButton } from "./SubscribeCta";
import SetupNudges from "./SetupNudges";
import { providerLabel } from "./providers";

/**
 * The Watches destination — a real page now, not a slide-over.
 *
 * Three top-level states, all reachable today:
 *   signed out -> the account wall (searching stays free)
 *   no watches -> first run, explaining what a watch is before asking for one
 *   watches    -> quota, provider-outage banner, cards
 *
 * The outage banner is backed by /api/health/status, which already tracks a
 * per-source detection canary with last-success timestamps. Nothing new was
 * needed for it — it was ops-only until now.
 */

import { WATCH_LIMIT } from "@/lib/limits";

interface HealthCheck {
  name: string;
  /** 'ok' | 'warn' | 'fail'. NOT a boolean — an earlier version read `c.ok`,
      which is undefined on every row, so !c.ok was true and EVERY provider
      rendered as down. */
  level: "ok" | "warn" | "fail";
  detail?: string;
  ageSeconds?: number | null;
}

export default function WatchesList() {
  const [watches, setWatches] = useState<WatchCardWatch[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stalledSources, setStalledSources] = useState<ReadonlySet<string>>(new Set());
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // includeInactive: paused watches are hidden by default so the old panel
    // keeps its behaviour. The redesign wants them — a paused watch you can't
    // see is a watch you can't resume.
    fetch("/api/watches?includeInactive=1")
      .then(async (r) => {
        if (r.status === 401 || r.status === 403 || r.status === 404) {
          if (!cancelled) setSignedOut(true);
          return null;
        }
        if (!r.ok) throw new Error(`Couldn't load your watches (${r.status})`);
        return r.json();
      })
      .then((j: { watches: WatchCardWatch[] } | null) => {
        if (!cancelled && j) setWatches(j.watches ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-cart session freshness. The poller already falls back to normal alerts
  // on a stale session; this is what lets a card say so before a site is missed.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/autocart")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { sessionExpired?: boolean } | null) => {
        if (cancelled || !j) return;
        setSessionExpired(Boolean(j.sessionExpired));
      })
      .catch(() => {
        /* non-fatal — the card just stays in its resting state */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Which providers are currently failing detection. Best-effort: a health blip
  // must never stop the watches list rendering.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health/status")
      .then((r) => (r.ok || r.status === 503 ? r.json() : null))
      .then((j: { checks?: HealthCheck[] } | null) => {
        if (cancelled || !j?.checks) return;
        const down = new Set<string>();
        for (const c of j.checks) {
          // Only a hard 'fail' means the provider is down. 'warn' covers things
          // like "no canary run yet" or a stale-but-recent check, which is not
          // something to alarm a user about mid-search.
          if (c.name?.startsWith("detect:") && c.level === "fail") {
            down.add(c.name.slice("detect:".length));
          }
        }
        setStalledSources(down);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="h-[200px] animate-pulse rounded-ch-card border border-ch-line bg-ch-card motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }

  if (signedOut) return <AccountWall />;

  // THE HOLDS PANEL SITS ABOVE BOTH REMAINING EXITS, on purpose. A hold is a real campsite
  // locked in ReserveCalifornia's cart with a ~15-minute fuse; a failed watch-list fetch is
  // a page to reload, and "no watches yet" is a state a hold contradicts rather than
  // precludes (a deleted watch leaves its hold behind). If this page half-breaks at 08:00,
  // the one thing on it that cannot wait must still be reachable.
  if (error) {
    return (
      <>
        <HoldsPanel className="mb-3.5" />
        <p role="alert" className="text-ch-body text-ch-alert">
          {error}
        </p>
      </>
    );
  }

  if (!watches || watches.length === 0) {
    return (
      <>
        <HoldsPanel className="mb-3.5" />
        <FirstRun />
      </>
    );
  }

  const stalledCount = watches.filter(
    (w) => w.campground_source && stalledSources.has(w.campground_source),
  ).length;
  const stalledName = watches.find(
    (w) => w.campground_source && stalledSources.has(w.campground_source),
  );

  return (
    <>
      {/* FIRST. At 08:00 a site sitting in our cart outranks every other thing on this
          page, including a provider outage banner — the outage cannot be acted on and the
          hold has minutes left. */}
      <HoldsPanel className="mb-3.5" />

      {stalledCount > 0 && stalledName?.campground_source && (
        <div className="mb-3.5 rounded-[13px] border border-[#E7C98C] bg-ch-ochre-soft px-3.5 py-3">
          <p className="text-ch-body font-bold">
            {providerLabel(stalledName.campground_source, stalledName.campground_id)}
            {" isn't responding"}
          </p>
          <p className="mt-1 text-ch-meta leading-normal text-ch-ink-2">
            {stalledCount === 1 ? "1 watch is" : `${stalledCount} watches are`}
            {" affected. We're retrying automatically. Your other watches are unaffected."}
          </p>
        </div>
      )}

      {/* The phone and auto-cart nudges used to be written out here. They now live in
          SetupNudges so they render on EVERY app tab — a subscriber who never opens
          this page was never told their alerting was half-configured. One component,
          one definition; a second copy here would drift from it within a month. */}
      <SetupNudges className="mb-3.5" />

      <div className="mb-3.5 flex items-center gap-2.5 rounded-[13px] border border-ch-line bg-ch-card px-3.5 py-3">
        <div className="flex-1">
          <p className="text-ch-body font-bold">
            {watches.filter((w) => w.active !== false).length} of {WATCH_LIMIT} watches running
          </p>
          <p className="mt-0.5 text-ch-fine text-ch-muted">
            We check every 15 seconds, around the clock.
          </p>
        </div>
        <WatchCta fullWidth={false} className="shrink-0 text-ch-fine" label="New watch" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {watches.map((w) => (
          <WatchCard
            key={w.id}
            watch={w}
            stalledSources={stalledSources}
            sessionExpired={sessionExpired}
          />
        ))}
      </div>

      <AlertHistory />
    </>
  );
}

function AccountWall() {
  return (
    <div className="mx-auto max-w-[46ch]">
      <h2 className="font-ch-display text-ch-h font-bold">Watches need an account</h2>
      <p className="mt-1.5 text-ch-body text-ch-muted">
        Searching stays free. Watches run on our servers around the clock, so they&apos;re tied to
        your account.
      </p>
      <ol className="mt-4 rounded-ch-card border border-ch-line bg-ch-card p-4">
        {[
          [`Up to ${WATCH_LIMIT} watches at once`, "One per campground and date range."],
          ["Alerts in seconds", "Push, text and email the moment a site frees up."],
          ["Auto-cart on Recreation.gov", "With the Auto-Cart plan, the site lands in your cart before you finish reading the alert."],
        ].map(([title, sub], i) => (
          <li key={title} className="flex gap-3 border-b border-ch-line py-3 last:border-b-0">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ch-green-soft text-[12px] font-extrabold text-ch-green-deep">
              {i + 1}
            </span>
            <span>
              <span className="block text-ch-body font-bold">{title}</span>
              <span className="mt-0.5 block text-ch-fine leading-normal text-ch-muted">{sub}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-4 grid gap-2">
        <Link href="/sign-up" className={buttonClasses({ fullWidth: true })}>
          Start 7-day free trial
        </Link>
        {/* Between the trial and Sign in, same size as both — see PlanOptionsButton. */}
        <PlanOptionsButton fullWidth />
        <Link href="/sign-in" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
          Sign in
        </Link>
        <Link href="/search" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
          Keep exploring without an account
        </Link>
      </div>
    </div>
  );
}

function FirstRun() {
  return (
    <div className="mx-auto max-w-[46ch]">
      <h2 className="font-ch-display text-ch-h font-bold">No watches yet</h2>
      <p className="mt-1.5 text-ch-body text-ch-muted">
        A watch keeps checking a booked campground for you and tells you the moment someone cancels.
      </p>
      <ol className="mt-4 rounded-ch-card border border-ch-line bg-ch-card p-4">
        {[
          ["Pick a campground and your nights", "Exact dates, or any 2 nights in a month you're free."],
          ["We check every 15 seconds", "Around the clock, right up until your trip date."],
          ["You get the site", "Push, text and email in seconds — and on Recreation.gov we can drop it straight in your cart."],
        ].map(([title, sub], i) => (
          <li key={title} className="flex gap-3 border-b border-ch-line py-3 last:border-b-0">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ch-green-soft text-[12px] font-extrabold text-ch-green-deep">
              {i + 1}
            </span>
            <span>
              <span className="block text-ch-body font-bold">{title}</span>
              <span className="mt-0.5 block text-ch-fine leading-normal text-ch-muted">{sub}</span>
            </span>
          </li>
        ))}
      </ol>
      <WatchCta className="mt-4" label="Create your first watch" />
      <p className="mt-2 text-center text-ch-fine text-ch-muted">
        Most people start with the trip they already missed out on.
      </p>
    </div>
  );
}

/**
 * Alert history — what we sent, and when.
 *
 * NO "BOOKED" / "MISSED" PILLS. The handoff mockup showed an outcome per alert,
 * but checkout happens on the provider's site and we never see it, so those
 * would have been invented. What IS true and worth showing: the channel and the
 * time, plus a failed send, which is exactly what a user wants when they think
 * we went quiet on them.
 */
function AlertHistory() {
  const [alerts, setAlerts] = useState<
    Array<{
      id: string;
      createdAt: string;
      channel: string;
      status: string;
      campgroundName: string | null;
      siteName: string | null;
    }> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/watches/alerts")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) setAlerts(j.alerts ?? []);
      })
      .catch(() => {
        /* history is a nice-to-have; never break the page for it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!alerts || alerts.length === 0) return null;

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="mt-4">
      <Collapsible label="Alert history" summary={`${alerts.length} recent`}>
        <ul>
          {alerts.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2.5 border-b border-ch-line py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-ch-body font-bold">
                  {a.campgroundName ?? "A watched campground"}
                  {a.siteName ? ` · ${a.siteName}` : ""}
                </p>
                <p className="mt-0.5 text-ch-fine text-ch-muted">
                  {fmt(a.createdAt)} · {a.channel}
                  {a.status !== "sent" ? ` · ${a.status}` : ""}
                </p>
              </div>
              {a.status !== "sent" && (
                <span className="shrink-0 rounded-ch-chip bg-ch-alert-soft px-2 py-1 text-ch-fine font-bold text-ch-alert">
                  not delivered
                </span>
              )}
            </li>
          ))}
        </ul>
      </Collapsible>
    </div>
  );
}
