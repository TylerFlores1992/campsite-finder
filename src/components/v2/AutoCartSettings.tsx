"use client";

import { useCallback, useEffect, useState } from "react";
import { AUTOCART_BETA_LABEL, AUTOCART_BETA_NOTE, AUTOCART_BETA_SCOPE } from "@/lib/autocart-beta";
import { buttonClasses } from "@/components/ui/Button";
import Button from "@/components/ui/Button";
import Tag from "@/components/ui/Tag";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";

/**
 * Auto-cart — the one-time Recreation.gov sign-in, and the switch that uses it.
 *
 * WHY THIS SCREEN NEEDED TO EXIST. Before it, the only route to /connect in the
 * redesign was the "Reconnect Recreation.gov" button on a watch card in the
 * authexpired state — the RECOVERY path. A new subscriber could not turn
 * auto-cart on at all; they could only repair it after it had already failed,
 * which it can't do if it was never on. The biggest differentiator in the
 * product was unreachable.
 *
 * FOUR STATES, all read from /api/user/autocart, which already returns
 * everything needed:
 *   not connected      -> the sign-in hasn't been done; offer it
 *   connected, off     -> signed in but the switch is off
 *   connected, on      -> working; say when the session was last verified
 *   session stale      -> on and connected, but the machine hasn't confirmed the
 *                         session within AUTOCART_SESSION_STALE_MS (45 min). The
 *                         poller falls back to a plain alert, silently — saying so
 *                         BEFORE a site is missed is the point. It is NOT an
 *                         expired login: the saved credentials mean the bot signs
 *                         back in itself, so this reads as "reconnecting".
 *
 * The /connect flow itself is untouched — it's a WebSocket bridge to the user's
 * own bot machine and has nothing to do with presentation. This links to it.
 */
interface AutoCartState {
  enabled: boolean;
  connected: boolean;
  verifiedAt: string | null;
  sessionFresh: boolean;
  sessionExpired: boolean;
  /** Plan gate — Auto-Cart tier, grandfathered pre-tier sub, or beta. */
  entitled: boolean;
}

/**
 * Relative, not a date. The freshness window is 45 minutes, so a live session is
 * always "today" and a date tells the reader nothing.
 */
function agoLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
}

export default function AutoCartSettings() {
  const isNative = useIsNativeApp();
  const { subscribed } = useSubscription();
  const [state, setState] = useState<AutoCartState | null>(null);
  // Computed when the data lands, not during render — Date.now() in a render
  // body is an impure call and React (correctly) rejects it.
  const [verified, setVerified] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step upgrade for existing subscribers: /api/stripe/plan swaps the price on
  // their LIVE subscription (prorated) the moment it's called, so a single click
  // must not be able to change what someone is billed. First click arms, second
  // confirms.
  const [upgradeArmed, setUpgradeArmed] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  const refresh = useCallback(() => {
    let cancelled = false;
    fetch("/api/user/autocart")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: AutoCartState | null) => {
        if (cancelled || !j) return;
        setState(j);
        setVerified(agoLabel(j.verifiedAt));
      })
      .catch(() => {
        /* falls through to the "couldn't load" state below */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  async function upgrade() {
    setUpgrading(true);
    setError(null);
    try {
      const r = await fetch("/api/stripe/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "autocart" }),
      });
      if (!r.ok) throw new Error(String(r.status));
      refresh();
    } catch {
      setError("The upgrade didn't go through. Nothing was changed — try again.");
    } finally {
      setUpgrading(false);
      setUpgradeArmed(false);
    }
  }

  async function checkout(interval: "monthly" | "yearly") {
    setUpgrading(true);
    try {
      const r = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "autocart", interval }),
      });
      const j = await r.json();
      if (j.url) window.location.assign(j.url);
      else setUpgrading(false);
    } catch {
      setUpgrading(false);
    }
  }

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    // Optimistic, then reconciled — a switch that waits on a round trip feels
    // broken, but one that lies about a failed write is worse.
    const before = state;
    setState((s) => (s ? { ...s, enabled: next } : s));
    try {
      const r = await fetch("/api/user/autocart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      setState(before);
      setError("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="h-20 animate-pulse rounded-ch-input bg-ch-shell motion-reduce:animate-none" />
    );
  }

  if (!state) {
    return (
      <p className="text-ch-body text-ch-muted">
        We couldn&apos;t load your auto-cart settings. Refresh to try again.
      </p>
    );
  }

  // THE PLAN GATE (2026-08-01). Auto-cart is the paid Auto-Cart tier; without it the
  // set-up flow and the toggle are replaced by the way to get it. The server enforces
  // this too (403 on enable, and the poller ignores the lane) — this screen is just
  // the honest version of that. IN THE NATIVE APP: no price and no purchase route,
  // same store rule as Pricing; the text says where to manage it and stops.
  if (!state.entitled) {
    return (
      <div>
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          <Tag kind="paused">Auto-Cart plan</Tag>
          <Tag kind="src">Recreation.gov only</Tag>
        </div>
        <p className="max-w-[62ch] text-ch-body leading-relaxed text-ch-ink-2">
          When a site opens up on Recreation.gov we can put it in your cart automatically,
          so it&apos;s held while you get to your phone. Auto-cart comes with the Auto-Cart
          plan.
        </p>
        {isNative ? (
          <p className="mt-3 text-ch-body text-ch-muted">
            Subscriptions are managed at camphawk.app.
          </p>
        ) : subscribed ? (
          <div className="mt-3 rounded-ch-input border border-ch-line px-3.5 py-3">
            <p className="text-ch-body font-bold">Add Auto-Cart to your subscription</p>
            <p className="mt-0.5 max-w-[58ch] text-ch-fine leading-normal text-ch-muted">
              $10 a month, or $50 a year — you keep your current billing cycle and Stripe
              prorates the difference from today.
            </p>
            {upgradeArmed ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={upgrading} onClick={() => void upgrade()}>
                  {upgrading ? "Upgrading…" : "Confirm upgrade"}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={upgrading}
                  onClick={() => setUpgradeArmed(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" className="mt-2.5" onClick={() => setUpgradeArmed(true)}>
                Upgrade to Auto-Cart
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="quiet" disabled={upgrading} onClick={() => void checkout("monthly")}>
              Auto-Cart — $10 / month
            </Button>
            <Button size="sm" disabled={upgrading} onClick={() => void checkout("yearly")}>
              Auto-Cart — $50 / year
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-ch-fine text-ch-alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        {state.sessionExpired ? (
          <Tag kind="paused">Reconnecting</Tag>
        ) : state.enabled && state.connected ? (
          <Tag kind="cart">On</Tag>
        ) : state.connected ? (
          <Tag kind="paused">Off</Tag>
        ) : (
          <Tag kind="paused">Not set up</Tag>
        )}
        <Tag kind="src">Recreation.gov only</Tag>
      </div>

      <p className="max-w-[62ch] text-ch-body leading-relaxed text-ch-ink-2">
        When a site opens up on Recreation.gov we can put it in your cart automatically, so it&apos;s
        held while you get to your phone. It signs in to your Recreation.gov account on a private
        machine we run, and saves that login there — encrypted, never on our web servers — so it can
        sign back in on its own whenever the session drops.
      </p>

      {/* NOT "your sign-in expired". The stale flag means the machine holding
          your session hasn't checked in for 45 minutes; the saved login means it
          signs back in by itself. Telling someone to redo a sign-in that is
          already repairing itself sends them on an errand for nothing. The
          manual link stays as a fallback for the case it doesn't recover. */}
      {state.sessionExpired && (
        <div className="mt-3 rounded-ch-input border border-[#E7C98C] bg-ch-ochre-soft px-3.5 py-3">
          <p className="text-ch-body font-bold text-ch-ochre-ink">
            Auto-cart is reconnecting
          </p>
          <p className="mt-1 text-ch-fine leading-normal text-ch-ochre-ink">
            The machine holding your Recreation.gov session hasn&apos;t checked in for a few
            minutes, so we can&apos;t hold a site for you right now. Your login is saved, so it
            signs back in on its own — and your watches keep alerting you the whole time. If this
            is still here in an hour, signing in again will fix it.
          </p>
          <a href="/connect" className={buttonClasses({ variant: "quiet", size: "sm", className: "mt-2.5" })}>
            Sign in to Recreation.gov again
          </a>
        </div>
      )}

      {!state.connected && (
        <a href="/connect" className={buttonClasses({ className: "mt-3" })}>
          Set up auto-cart
        </a>
      )}

      {/* BETA, and scoped to ReserveCalifornia ONLY.
          Recreation.gov auto-cart has been carting live sites for weeks and is not in
          testing; the ReserveCalifornia hold-and-hand-off path is, and it is the one a
          user could be surprised by — it asks them to finish the booking themselves in
          a webview at 08:00. Labelling the whole feature "Beta" would put a warning on
          a paid product that mostly works, which is its own kind of untrue.

          It sits beside the toggle rather than at the top of the card because this is
          where someone decides to rely on it. */}
      {state.connected && !state.sessionExpired && (
        <p className="mt-3 flex flex-wrap items-center gap-2 rounded-ch-input border border-[#E7C98C] bg-ch-ochre-soft px-3.5 py-2.5 text-ch-fine leading-normal text-ch-ink-2">
          <span className="rounded-full border border-[#E7C98C] bg-ch-card px-2 py-0.5 text-[11px] font-bold uppercase tracking-[.06em]">
            {AUTOCART_BETA_LABEL}
          </span>
          {/* ONE DEFINITION, COMPOSED — never a paraphrase. This block used to carry its
              own wording, which is the drift `@/lib/autocart-beta` exists to prevent. */}
          <span className="min-w-0 flex-1">
            {AUTOCART_BETA_NOTE} {AUTOCART_BETA_SCOPE}
          </span>
        </p>
      )}

      {state.connected && !state.sessionExpired && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-ch-input border border-ch-line px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-ch-body font-bold">
              {state.enabled ? "Auto-cart is on" : "Auto-cart is off"}
            </p>
            <p className="mt-0.5 text-ch-fine text-ch-muted">
              {verified
                ? `Session confirmed ${verified}.`
                : "Recreation.gov sign-in complete."}
            </p>
          </div>
          <Button
            variant={state.enabled ? "quiet" : "primary"}
            size="sm"
            disabled={saving}
            onClick={() => void toggle(!state.enabled)}
          >
            {saving ? "Saving…" : state.enabled ? "Turn off" : "Turn on"}
          </Button>
        </div>
      )}

      {state.connected && !state.sessionExpired && (
        <p className="mt-2 text-ch-fine text-ch-muted">
          Signed in on the wrong Recreation.gov account?{" "}
          <a href="/connect" className="font-bold text-ch-green hover:text-ch-green-deep">
            Sign in again
          </a>
          .
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-ch-fine text-ch-alert">
          {error}
        </p>
      )}
    </div>
  );
}
