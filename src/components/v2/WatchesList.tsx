"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import WatchCard, { type WatchCardWatch } from "./WatchCard";
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

const WATCH_LIMIT = 10;

interface HealthCheck {
  name: string;
  ok: boolean;
  ageSeconds?: number | null;
}

export default function WatchesList() {
  const [watches, setWatches] = useState<WatchCardWatch[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stalledSources, setStalledSources] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/watches")
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
          if (c.name?.startsWith("detect:") && !c.ok) down.add(c.name.slice("detect:".length));
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

  if (error) {
    return (
      <p role="alert" className="text-ch-body text-ch-alert">
        {error}
      </p>
    );
  }

  if (!watches || watches.length === 0) return <FirstRun />;

  const stalledCount = watches.filter(
    (w) => w.campground_source && stalledSources.has(w.campground_source),
  ).length;
  const stalledName = watches.find(
    (w) => w.campground_source && stalledSources.has(w.campground_source),
  );

  return (
    <>
      {stalledCount > 0 && stalledName?.campground_source && (
        <div className="mb-3.5 rounded-[13px] border border-[#E7C98C] bg-ch-ochre-soft px-3.5 py-3">
          <p className="text-ch-body font-bold">
            {providerLabel(stalledName.campground_source, stalledName.campground_id)} isn&apos;t
            responding
          </p>
          <p className="mt-1 text-ch-meta leading-normal text-ch-ink-2">
            {stalledCount} {stalledCount === 1 ? "watch is" : "watches are"} affected. We&apos;re
            retrying automatically. Your other watches are unaffected.
          </p>
        </div>
      )}

      <div className="mb-3.5 flex items-center gap-2.5 rounded-[13px] border border-ch-line bg-ch-card px-3.5 py-3">
        <div className="flex-1">
          <p className="text-ch-body font-bold">
            {watches.length} of {WATCH_LIMIT} watches running
          </p>
          <p className="mt-0.5 text-ch-fine text-ch-muted">
            We check every 15 seconds, around the clock.
          </p>
        </div>
        <Link href="/v2/new" className={buttonClasses({ size: "sm", className: "shrink-0" })}>
          New watch
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {watches.map((w) => (
          <WatchCard key={w.id} watch={w} stalledSources={stalledSources} />
        ))}
      </div>
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
          ["Up to 10 watches at once", "One per campground and date range."],
          ["Alerts in seconds", "Push, text and email the moment a site frees up."],
          ["Auto-cart on Recreation.gov", "The site lands in your cart before you finish reading the alert."],
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
        <a href="/sign-up" className={buttonClasses({ fullWidth: true })}>
          Start 7-day free trial
        </a>
        <a href="/sign-in" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
          Sign in
        </a>
        <Link href="/v2" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
          Keep searching without an account
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
      <Link href="/v2/new" className={buttonClasses({ fullWidth: true, className: "mt-4" })}>
        Create your first watch
      </Link>
      <p className="mt-2 text-center text-ch-fine text-ch-muted">
        Most people start with the trip they already missed out on.
      </p>
    </div>
  );
}
