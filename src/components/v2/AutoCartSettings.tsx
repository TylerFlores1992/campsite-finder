"use client";

import { useEffect, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import Button from "@/components/ui/Button";
import Tag from "@/components/ui/Tag";

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
  const [state, setState] = useState<AutoCartState | null>(null);
  // Computed when the data lands, not during render — Date.now() in a render
  // body is an impure call and React (correctly) rejects it.
  const [verified, setVerified] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
