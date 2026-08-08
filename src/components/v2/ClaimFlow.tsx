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
  /** The park's own booking page — where the hand-off lands. */
  bookingUrl?: string;
}

export default function ClaimFlow({ holdId, token }: { holdId: string; token: string }) {
  const [state, setState] = useState<HoldState | null>(null);
  // Captured on first load, BEFORE the release. The redirect fires the instant status
  // flips, and re-reading state there would race the fetch that set it.
  const bookingUrl = useRef<string>('https://www.reservecalifornia.com/');
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
      if (j.bookingUrl) bookingUrl.current = j.bookingUrl;
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
    // THE PARK'S OWN BOOKING PAGE, not reservecalifornia.com's homepage — which is where
    // this used to land, under a comment claiming otherwise. The fragment is read by the
    // desktop extension, which carts in the user's own session; on a phone nothing
    // consumes it, and the base URL is all they get. Dropping a phone user on RC's front
    // page to search for the park by hand spends the entire ~2.5s window this design
    // exists to protect. The base is stripped of any existing fragment so we cannot emit
    // two.
    window.location.href = `${bookingUrl.current.split('#')[0]}${frag}`;
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

        {/*
          ORDER THE STEPS, DON'T JUST MENTION THEM.

          The old screen offered a sign-in link and a checkbox, then released and sent the
          user to RC to *start* looking. On a desktop with the extension that is fine —
          it carts for them. On a PHONE nothing consumes the fragment, so the release
          started a clock and only THEN did the user begin navigating, signing in and
          hunting for the site. The claim link is tapped on a phone at 8am; that is the
          normal case, not the edge case.

          So the navigation now happens BEFORE the release. Open the loop in another tab,
          find the site, come back, hand over. The exposure becomes "tap over and press
          book", not "tap over, sign in, search, scroll, press book". Nothing here is
          clever — it just stops spending the window on work that could have been done
          while the bot was still holding it.

          NEW TAB on purpose: navigating away would lose this page, and the hold id and
          token live only in its URL.
        */}
        <ol className="mt-5 w-full space-y-3 text-left text-sm text-ch-ink">
          <li className="flex gap-3">
            <span className="font-bold text-ch-green-deep">1.</span>
            <span>
              <a
                href={bookingUrl.current.split('#')[0]}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-ch-green-deep underline"
              >
                Open ReserveCalifornia in another tab
              </a>{' '}
              and sign in. Find <strong>{site}</strong> and get as far as you can without
              booking — the site will look taken, because we&rsquo;re the ones holding it.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-bold text-ch-green-deep">2.</span>
            <span>Come back here and tap the button. We let go.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-bold text-ch-green-deep">3.</span>
            <span>Switch to that tab and book <strong>{site}</strong> straight away.</span>
          </li>
        </ol>

        <label className="mt-5 flex w-full cursor-pointer items-start gap-3 rounded-xl border border-ch-line p-4 text-left">
          <input
            type="checkbox"
            checked={signedIn}
            onChange={(e) => setSignedIn(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-ch-green-deep"
          />
          <span className="text-sm text-ch-ink">
            I&rsquo;m signed in to ReserveCalifornia and looking at {site}
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
            Tick the box once you&rsquo;re signed in and on the page — we won&rsquo;t let
            go until then.
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
        {/* Name the site again, here, at the size it needs to be read at. This is the one
            second the user has to load the target into their head before they act, and
            the previous screen's copy has already scrolled out of mind. */}
        <p className="mt-3 rounded-xl bg-ch-green-soft px-5 py-2 text-xl font-bold text-ch-ink">{site}</p>
        <p className="text-ch-muted mt-2">
          Switch to your ReserveCalifornia tab and book it — we&rsquo;ll also send you
          there if you stay here.
        </p>
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
        {/* THE SITE NUMBER, BIG. This screen is read in a hurry while a clock the user
            can feel is running, and the single fact they need is which site to tap on a
            grid of dozens. Burying it in a sentence is how you spend the window
            re-reading the sentence. */}
        <p className="mt-4 rounded-xl bg-ch-green-soft px-5 py-3 text-2xl font-bold text-ch-ink">{site}</p>
        <p className="text-ch-muted mt-2">
          {stayLabel(state.arrivalDate, state.nights)} — we&rsquo;ve let go. If you already
          have ReserveCalifornia open, switch to it and book now.
        </p>
        {/* The LOOP page (see bookingUrlFor), not the park and not the cart. The cart is
            only populated for desktop users whose extension caught the release; on a
            phone it is empty, and sending someone to an empty cart to explain a site they
            are trying to book is the worst of both. The fragment is carried so an
            extension user who lands here rather than via the auto-redirect still gets the
            autofill — it is inert everywhere else. */}
        <a
          href={`${bookingUrl.current.split('#')[0]}${
            state.unitId ? `#camphawk-rc=${state.unitId}_${state.arrivalDate}_${state.nights ?? 1}_` : ''
          }`}
          className="mt-6 inline-block rounded-xl bg-ch-green-deep px-6 py-4 font-bold text-white"
        >
          Book {site} on ReserveCalifornia →
        </a>
        <a
          href="https://www.reservecalifornia.com/Customers/ShoppingCart"
          className="mt-4 block text-sm text-ch-muted underline"
        >
          Already in your cart? Go to checkout
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
