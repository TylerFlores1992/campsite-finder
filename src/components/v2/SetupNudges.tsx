"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * "Your alerting isn't finished" banners, on every app tab.
 *
 * WHY THIS MOVED (2026-08-05). These two nudges lived inside WatchesList, so they only
 * ever appeared on /watches. A subscriber who lands on Explore, starts a watch and
 * never opens the Watches tab was never told they had no phone number on file, or that
 * auto-cart was sitting unconnected. Reported by a real account: six live watches, an
 * auto-cart entitlement, nothing connected, and no idea.
 *
 * AUTO-CART IS RECREATION.GOV ONLY, so the "connect auto-cart" prompt is gated on
 * owning at least one rec.gov watch. Prompting someone to set up a bot that cannot fire
 * for any watch they own would be worse than silence.
 *
 * A third banner briefly lived here, telling users whose watches are all state-park
 * portals that auto-cart cannot cover them. It was removed on request — a permanent
 * notice about a feature you can't use is clutter, not help. The coverage limit is
 * still stated on the auto-cart settings and marketing pages; don't reintroduce it as
 * a banner.
 *
 * Rules this file inherits from the rest of the app:
 *   - NEVER nag on a failed or unresolved read. `data === null` renders nothing, so a
 *     Clerk blip or a 500 can't tell a fully-configured subscriber they're broken.
 *   - Signed-out renders nothing (the endpoint 401s and we stay quiet).
 *   - Nothing here names a price, so unlike PricingLink it is safe in the native app —
 *     and app users are exactly the ones who need a phone number on file.
 *   - Status is never carried by colour alone: every banner leads with a heading that
 *     states the situation in words.
 */

interface SetupStatus {
  hasPhone: boolean;
  autocartConnected: boolean;
  autocartEnabled: boolean;
  autocartEntitled: boolean;
  recgovWatches: number;
  liveWatches: number;
}

export default function SetupNudges({ className = "" }: { className?: string }) {
  const [data, setData] = useState<SetupStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/setup-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: SetupStatus | null) => {
        if (!cancelled && j) setData(j);
      })
      // Silence on failure, deliberately — see the note above.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;

  // Nothing to finish setting up until there is something to be alerted about. A
  // brand-new account with no watches is not misconfigured, it's just new.
  if (data.liveWatches === 0) return null;

  const noPhone = !data.hasPhone;
  const autocartUnconnected =
    data.autocartEntitled && !data.autocartConnected && data.recgovWatches > 0;

  if (!noPhone && !autocartUnconnected) return null;

  return (
    <div className={`space-y-3.5 ${className}`}>
      {noPhone && (
        <Nudge
          tone="warn"
          title="You're only getting email alerts"
          body="Openings often last minutes. A text is what actually reaches you in time — add your number and we'll send both."
          href="/settings"
          cta="Turn on text alerts"
        />
      )}

      {autocartUnconnected && (
        <Nudge
          title="Auto-cart isn't connected"
          body={`${
            data.recgovWatches === 1
              ? "One of your watches is on Recreation.gov."
              : `${data.recgovWatches} of your watches are on Recreation.gov.`
          } Connect once and we'll put an opening straight into your cart, so it's held while you get to your phone. You'll still get the alert either way.`}
          href="/connect"
          cta="Connect auto-cart"
        />
      )}
    </div>
  );
}

function Nudge({
  title,
  body,
  href,
  cta,
  tone = "neutral",
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
  /** `warn` is for a gap that costs the user alerts. Everything else is information,
   *  and dressing information up as a warning is how a banner gets ignored. */
  tone?: "warn" | "neutral";
}) {
  const box =
    tone === "warn"
      ? "border-[#E7C98C] bg-ch-ochre-soft"
      : "border-ch-line bg-ch-card";
  return (
    <div className={`rounded-[13px] border px-3.5 py-3 ${box}`}>
      <p className="text-ch-body font-bold">{title}</p>
      <p className="mt-1 text-ch-meta leading-normal text-ch-ink-2">{body}</p>
      <Link
        href={href}
        className="mt-1.5 inline-block text-ch-body font-bold text-ch-green hover:text-ch-green-deep"
      >
        {cta}
      </Link>
    </div>
  );
}
