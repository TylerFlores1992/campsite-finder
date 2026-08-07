'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Check, AlertTriangle, Tent } from 'lucide-react';
import { formatStayDates } from '@/lib/notifications/dates';

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
  /**
   * "I am signed in to ReserveCalifornia" — a gate, not a formality.
   *
   * Pressing the button starts a ~2.5s window in which the site belongs to nobody. A user
   * who is signed OUT spends that window on RC's login form, so the hold we kept for them
   * all morning is handed to whoever else is watching. The instruction was already in the
   * copy as a sentence, and a sentence immediately above an inviting green button is a
   * sentence people skim.
   *
   * Deliberately NOT remembered between visits. Each claim is its own risky moment, and a
   * box that arrives pre-ticked from last time is the sentence again.
   */
  const [signedIn, setSignedIn] = useState(false);
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
    // Defensive: the button is disabled, but nothing else stops a stray call, and this
    // one is not undoable — the bot lets go and the site is on the open market.
    if (!signedIn) return;
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
          {stayLabel(state.arrivalDate, state.nights)}
        </p>
        <p className="text-ch-ink mt-5">
          When you tap below we let go and you take it — that swap takes a couple of
          seconds, and the site is open to anyone during it, so only tap when you&rsquo;re
          ready to finish.
        </p>

        {/* NEW TAB on purpose: navigating away to sign in would lose this page, and the
            hold id + token live only in its URL.

            Points at the app ROOT, not a guessed /Customers/SignIn — RC is a SPA whose
            sign-in is an Okta page on another host, and the WAF 403s this project's
            egress so no deep path can be verified from here. One extra click beats a dead
            link on the one screen where a wrong turn costs the site. */}
        <a
          href="https://www.reservecalifornia.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 text-sm font-semibold text-ch-green-deep underline"
        >
          Not signed in? Open ReserveCalifornia and sign in (new tab)
        </a>

        <label className="mt-5 flex w-full cursor-pointer items-start gap-3 rounded-xl border border-ch-line p-4 text-left">
          <input
            type="checkbox"
            checked={signedIn}
            onChange={(e) => setSignedIn(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-ch-green-deep"
          />
          <span className="text-sm text-ch-ink">
            I&rsquo;m signed in to ReserveCalifornia in this browser
          </span>
        </label>

        <button
          onClick={claim}
          disabled={busy || !signedIn}
          className="mt-4 w-full rounded-xl bg-ch-green-deep px-6 py-4 text-lg font-bold text-white disabled:opacity-60"
        >
          {busy ? 'Releasing…' : "It's mine — hand it over"}
        </button>
        {/* Say WHY it is disabled. A dead button with no explanation reads as broken,
            and this one is the last step of a flow they have already waited hours for. */}
        {!signedIn && (
          <p className="mt-3 text-sm text-ch-muted">
            Tick the box once you&rsquo;re signed in — we won&rsquo;t let go until then.
          </p>
        )}
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

/**
 * "Sep 4-6 · 3 nights", not "2026-09-04".
 *
 * Same rule as the alert copy (lib/notifications/dates.ts): a bare ISO date is read as a
 * timestamp rather than a stay, and it was mis-read exactly that way in a real alert on
 * 2026-08-06. Days are stepped in UTC and re-serialised, never via `new Date(iso)` plus
 * local arithmetic — a bare date parses as midnight UTC and renders a day early for
 * everyone west of Greenwich, which on this screen would name the wrong night.
 */
function stayLabel(arrival?: string, nights?: number): string {
  if (!arrival) return '';
  const n = Math.max(1, nights ?? 1);
  const start = Date.parse(`${arrival}T00:00:00Z`);
  if (Number.isNaN(start)) return arrival;
  const dates = Array.from({ length: n }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  return `${formatStayDates(dates)} · ${n} night${n === 1 ? '' : 's'}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      {children}
    </main>
  );
}
