'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Check, AlertTriangle, Tent } from 'lucide-react';

/**
 * The hand-off, from the user's side.
 *
 * CampHawk's bot is holding a site in its own ReserveCalifornia cart. Only the session
 * that made that cart entry can remove it, so the user cannot simply take the site —
 * they ask, the bot lets go, and then they grab it. This screen runs that handshake and,
 * crucially, is honest about the one risky moment in it.
 *
 * THE EXPOSURE WINDOW. Between the bot releasing and the site landing in the user's cart
 * it is free for anybody. Measured at ~2.5s in the release probe, dominated by RC's two
 * precart round trips. That is why:
 *   • we do NOT release until the user presses the button — no point starting the clock
 *     while they read;
 *   • the poll is fast (600ms) once claiming, so no time is lost noticing the release;
 *   • the redirect happens the instant status flips, not after a friendly pause.
 *
 * The fallback is deliberately not a failure. If the recapture does not happen the site
 * is simply free and they can book it — exactly where an ordinary alert would leave
 * them — so the copy says that plainly rather than implying something broke.
 */
interface HoldState {
  status: string;
  stuck?: boolean;
  unitId?: string;
  unitName?: string | null;
  arrivalDate?: string;
  nights?: number;
}

export default function ClaimFlow({ holdId, token }: { holdId: string; token: string }) {
  const [state, setState] = useState<HoldState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const redirected = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/rc-holds/claim?id=${encodeURIComponent(holdId)}&token=${encodeURIComponent(token)}`);
      if (!r.ok) { setError('This link is no longer valid.'); return null; }
      const j = (await r.json()) as HoldState;
      setState(j);
      return j;
    } catch {
      return null;
    }
  }, [holdId, token]);

  useEffect(() => { void load(); }, [load]);

  // Fast poll only while the bot is mid-release. Every 600ms of delay here is 600ms the
  // site sits free for someone else, so this is not a place to be polite about polling.
  useEffect(() => {
    if (state?.status !== 'claiming') return;
    const t = setInterval(() => { void load(); }, 600);
    return () => clearInterval(t);
  }, [state?.status, load]);

  // The moment it is ours to take, go. Any pause here is pure exposure.
  useEffect(() => {
    if (state?.status !== 'released' || redirected.current) return;
    redirected.current = true;
    const frag = state.unitId
      ? `#camphawk-rc=${state.unitId}_${state.arrivalDate}_${state.nights ?? 1}_`
      : '';
    // The extension recognises this fragment and carts it in the user's own session.
    // Without the extension they land on the right site page and book by hand — slower,
    // but the site is genuinely free at that point, not lost.
    window.location.href = `https://www.reservecalifornia.com/${frag}`;
  }, [state]);

  async function claim() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/rc-holds/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: holdId, token }),
      });
      if (!r.ok) { setError('Could not claim this hold — it may have already been released.'); return; }
      await load();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Shell><p className="text-ch-ink">{error}</p></Shell>;
  if (!state) return <Shell><Loader2 className="animate-spin text-ch-muted" /></Shell>;

  const site = state.unitName ?? state.unitId ?? 'your site';

  if (state.status === 'carted') {
    return (
      <Shell>
        <Tent className="text-ch-green-deep" size={32} />
        <h1 className="text-2xl font-bold text-ch-ink mt-3">We&rsquo;re holding {site} for you</h1>
        <p className="text-ch-muted mt-2">
          {state.arrivalDate}
          {state.nights && state.nights > 1 ? ` · ${state.nights} nights` : ''}
        </p>
        <p className="text-ch-ink mt-5">
          Make sure you&rsquo;re signed in to ReserveCalifornia in this browser first. When you tap below we
          let go and you take it — that swap takes a couple of seconds, and the site is
          open to anyone during it, so only tap when you&rsquo;re ready to finish.
        </p>
        <button
          onClick={claim}
          disabled={busy}
          className="mt-6 w-full rounded-xl bg-ch-green-deep px-6 py-4 text-lg font-bold text-white disabled:opacity-60"
        >
          {busy ? 'Releasing…' : "It's mine — hand it over"}
        </button>
      </Shell>
    );
  }

  if (state.status === 'claiming') {
    return (
      <Shell>
        <Loader2 className="animate-spin text-ch-green-deep" size={32} />
        <h1 className="text-xl font-bold text-ch-ink mt-3">Letting go of {site}…</h1>
        <p className="text-ch-muted mt-2">Sending you to ReserveCalifornia the moment it&rsquo;s free.</p>
        {state.stuck && (
          <p className="mt-4 flex items-start gap-2 text-sm text-ch-ink">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            {/* A spinner that never resolves is worse than bad news. If the runner is
                down, say so and point at the thing that still works. */}
            <span>
              This is taking longer than it should — our bot may be offline. The site is still held, so
              nothing is lost. Try again in a minute, or open ReserveCalifornia and search for {site}.
            </span>
          </p>
        )}
      </Shell>
    );
  }

  if (state.status === 'released' || state.status === 'claimed') {
    return (
      <Shell>
        <Check className="text-ch-green-deep" size={32} />
        <h1 className="text-xl font-bold text-ch-ink mt-3">{site} is yours to book</h1>
        <p className="text-ch-muted mt-2">We&rsquo;ve let go — finish checkout on ReserveCalifornia.</p>
        <a
          href="https://www.reservecalifornia.com/Customers/ShoppingCart"
          className="mt-6 inline-block rounded-xl bg-ch-green-deep px-6 py-4 font-bold text-white"
        >
          Open ReserveCalifornia →
        </a>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-ch-ink">
        {/* Every remaining status means there is nothing to hand over, and saying which
            beats a generic error: expired and failed have different next steps. */}
        {state.status === 'expired'
          ? 'That hold expired — nobody claimed it, so we released the site.'
          : state.status === 'failed'
            ? "We couldn't hold that site. Your alerts carry on as normal."
            : 'Nothing is being held for you right now.'}
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      {children}
    </main>
  );
}
