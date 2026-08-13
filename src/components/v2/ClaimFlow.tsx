'use client';

import { openRcHandoff, rcHandoffUrl, rcHandoffDiagnostics, type RcReport } from '@/lib/native/rc-handoff';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Check, AlertTriangle, Tent } from 'lucide-react';
import { formatStayDates } from '@/lib/notifications/dates';
import { RC_CART_HOLD_MINUTES } from '@/lib/limits';

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
  /** When the bot got it into RC's cart. Drives the honest countdown below. */
  cartedAt?: string | null;
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

  /**
   * STEP ONE OF THE CLAIM: sign in to RC *inside our own webview*, before the release.
   *
   * `lib/native/rc-handoff` worked this out and then it was never built: "the only way
   * through is a one-time sign-in to RC INSIDE our webview, whose data store then persists
   * for later claims... the answer is probably SIGN IN INSIDE THE WEBVIEW, AS STEP ONE OF
   * THE CLAIM". Every call to `openRcHandoff` was still on the far side of the release, so
   * there was no step one — the injectable webview did not exist until the drop had already
   * happened.
   *
   * That is not a cosmetic ordering problem. The webview we can inject into has its OWN
   * cookie jar (WKWebsiteDataStore on iOS, a separate CookieManager on Android), so signing
   * in via the system browser — which is what the old step 1 link opened — puts the session
   * somewhere the injection can never read. The only session that counts is one established
   * inside this webview, and the only chance to establish it was after the clock started.
   *
   * Measured on the 2026-08-12 hold, which is what forced this: the first injection reported
   * "Couldn't read your RC login", the user signed in mid-window, and a LATER injection then
   * captured a 939-char token. So the data store does persist across separate opens — the
   * mechanism was fine, only the ordering was wrong.
   *
   * OPENED WITHOUT A `unitId`, which is what makes this safe to do early: `rcFragment`
   * returns '' with no unit, the injected script finds no job and reports `idle` ("nothing
   * to cart"), and still captures the token on its way past. A rehearsal of everything
   * except the cart — the same shape as `rc-hold-runner --once` going through `withRC` with
   * a no-op callback rather than asserting from above an early return.
   */
  const [rcCheck, setRcCheck] = useState<'idle' | 'opening' | 'verified' | 'unconfirmed'>('idle');
  /** Does THIS binary have an injectable webview? Probed without opening one. */
  const [canInject, setCanInject] = useState(false);

  useEffect(() => {
    let live = true;
    void rcHandoffDiagnostics()
      .then((d) => { if (live) setCanInject(d.inAppBrowser === 'present'); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  /**
   * Ship what the injected precart says about itself back to the server.
   *
   * THE TWO RC CART POSTS ARE THE LAST UNMEASURED LINK. Sign-in, session persistence and
   * token capture are all proven on both platforms; `load` + `submit` are not, because
   * exercising them needs a genuine held unit. This is how the next real 8am hold answers
   * that on its own instead of us inferring it from whether the user got the site.
   *
   * BUFFERED AND FIRE-AND-FORGET. At 08:00:00 nothing may go in front of the precart, and
   * this runs on the same page as a user watching a clock — so reports accumulate and
   * flush on a debounce, never blocking, never awaited, never surfacing an error. A
   * diagnostic that can slow the thing it observes is not worth having.
   */
  const pending = useRef<RcReport[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushReports = useCallback(() => {
    const batch = pending.current;
    if (!batch.length) return;
    pending.current = [];
    // `keepalive` so a flush started as the tab is hidden or the webview closes still
    // goes out — which is exactly when the LAST report, the one carrying the cart's
    // verdict, would otherwise be lost.
    void fetch('/api/rc-holds/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: holdId, token, reports: batch }),
      keepalive: true,
    }).catch(() => {});
  }, [holdId, token]);

  const onReport = useCallback((r: RcReport) => {
    pending.current.push(r);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(flushReports, 1500);

    // THE VERIFICATION IS THE REPORT, not a second probe. `token captured` is the injected
    // script telling us it read a live RC access token out of THIS webview's storage —
    // which is the exact fact the release needs and the exact fact the checkbox could only
    // ever guess at. Read from the same channel the diagnostics use, so the thing gating
    // the button and the thing recorded on the hold can never disagree.
    if (r.stage === 'token' && (r.detail as { captured?: boolean } | null)?.captured) {
      setRcCheck('verified');
    }
    // The webview closed. If nothing announced a token before it went, we did not confirm
    // a session — which is NOT the same as knowing there isn't one, and is treated that way
    // below: it downgrades to the checkbox rather than blocking the release.
    if (r.stage === 'closed') {
      setRcCheck((prev) => (prev === 'verified' ? prev : 'unconfirmed'));
    }
  }, [flushReports]);

  /**
   * Open RC in the injectable webview so the user can sign in BEFORE anything is released.
   * No `unitId` — see the note on `rcCheck`; this must not be able to cart.
   */
  async function prepareRc() {
    setRcCheck('opening');
    try {
      // `closeOnToken`: this window's only job is the sign-in, and the claim screen is
      // UNDERNEATH it. A user who was already signed in gets a token instantly, the gate
      // flips, and they see none of it — stranded on RC's home page with nothing saying to
      // go back. Closing on the token puts them in front of the one button left to press.
      await openRcHandoff({ url: bookingUrl.current }, { onReport, closeOnToken: true });
    } catch {
      setRcCheck('unconfirmed');
    }
  }

  // The webview closing and the page going away are both "we are about to lose whatever
  // has not been sent". `pagehide` fires in cases `beforeunload` does not on iOS.
  useEffect(() => {
    const go = () => flushReports();
    window.addEventListener('pagehide', go);
    return () => { window.removeEventListener('pagehide', go); go(); };
  }, [flushReports]);

  /**
   * HOW LONG IS LEFT — because "We're holding it for you" was an open-ended promise we
   * cannot keep. RC drops a cart after about 15 minutes and we do not extend it, while
   * our own sweep waits 45; between those two numbers the screen was telling people we
   * held a site that RC had already released.
   *
   * The fix is NOT to shorten the sweep. Releasing at minute 15 would throw away a hold
   * whose owner is two minutes from claiming it. The fix is to stop claiming certainty:
   * count down while we are confident, then say plainly that it MAY be gone — hedged,
   * because RC_CART_HOLD_MINUTES is read off RC's bundle and has never been observed.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state?.status !== 'carted') return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [state?.status]);

  const minsLeft = (() => {
    if (!state?.cartedAt) return null;
    const held = (now - new Date(state.cartedAt).getTime()) / 60_000;
    if (!Number.isFinite(held)) return null;
    return Math.ceil(RC_CART_HOLD_MINUTES - held);
  })();
  const maybeGone = minsLeft !== null && minsLeft <= 0;

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
    // THE PARK'S OWN BOOKING PAGE, not reservecalifornia.com's homepage — which is where
    // this used to land, under a comment claiming otherwise. The fragment is read by the
    // desktop extension, which carts in the user's own session; on a phone nothing
    // consumes it, and the base URL is all they get. Dropping a phone user on RC's front
    // page to search for the park by hand spends the entire ~2.5s window this design
    // exists to protect.
    //
    // Routed through openRcHandoff so the day an injectable in-app webview exists, the
    // phone gets the same automatic cart the desktop extension already does — and it
    // changes in ONE place rather than in the three exits this screen has.
    void openRcHandoff({
      url: bookingUrl.current,
      unitId: state.unitId,
      arrivalDate: state.arrivalDate,
      nights: state.nights,
    }, { onReport });
  }, [state, onReport]);

  /**
   * May we let go?
   *
   * VERIFICATION IS A FAST PATH, NEVER A NEW BLOCKER. A confirmed token is strictly better
   * evidence than a ticked box, so it stands on its own — but "we could not confirm a
   * session" and "there is no session" are different facts, and only the second would
   * justify refusing. An unconfirmed check therefore falls back to the checkbox exactly as
   * before rather than locking the user out of a hold they waited all morning for. Same rule
   * as `unknown` never being reported as a dead RC session, and as the availability read
   * returning null instead of "fully booked".
   */
  const mayRelease = rcCheck === 'verified' || signedIn;

  async function claim() {
    // Defensive: the button is disabled, but nothing else stops a stray call, and this
    // one is not undoable — the bot lets go and the site is on the open market.
    if (!mayRelease) return;
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
        <h1 className="text-2xl font-bold text-ch-ink mt-3">
          {maybeGone ? `${site} may already be gone` : `We’re holding ${site} for you`}
        </h1>
        <p className="text-ch-muted mt-2">
          {stayLabel(state.arrivalDate, state.nights)}
        </p>
        {/* The deadline, stated once, near the top, where a decision is being made. */}
        {minsLeft !== null && (
          <p className={`mt-3 rounded-xl px-4 py-2 text-sm font-semibold ${maybeGone ? 'bg-ch-sand text-ch-ink' : 'bg-ch-green-soft text-ch-ink'}`}>
            {maybeGone
              ? 'ReserveCalifornia drops a cart after about 15 minutes, and it has been longer than that. It may already be free again — worth trying anyway.'
              : `ReserveCalifornia holds a cart about ${RC_CART_HOLD_MINUTES} minutes. About ${minsLeft} left.`}
          </p>
        )}
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
        {/*
          ONE THING TO DO AT A TIME.

          The screen used to show three numbered steps, a checkbox asserting "I'm signed in
          and looking at the site", and a release button that stayed dead until it was
          ticked. Every one of those is a thing to read at 8am, and the checkbox was the
          worst of them: it asked the user to promise something we could not check, gating
          the release on a claim rather than a fact.

          Now the app knows. `token captured` is the injected script reporting that it read a
          live RC session out of THIS webview, so the screen can simply advance: open RC ->
          wait -> let go. One button, whichever one is next.

          THE FINAL PRESS STAYS, deliberately. Releasing starts the ~2.5s window where the
          site belongs to nobody, and signing in is not the same intent as "I am ready now" —
          somebody can sign in and put the phone down. Auto-releasing on the token would hand
          the site to whoever else is watching while its owner is not looking, which is the
          exact failure this screen exists to prevent. What is removed is the busywork, not
          the decision.

          The browser path keeps the old three steps: without an injectable webview there is
          nothing to observe, so the checkbox is still the only thing standing between a
          signed-out user and a released site.
        */}
        {canInject ? (
          <div className="mt-5 w-full">
            {rcCheck === 'verified' ? (
              <p className="rounded-xl border border-ch-line bg-ch-green-soft p-4 text-left text-sm font-semibold text-ch-ink">
                Signed in to ReserveCalifornia. Tap below and it&rsquo;s yours.
              </p>
            ) : rcCheck === 'opening' ? (
              <p className="rounded-xl border border-ch-line p-4 text-left text-sm text-ch-ink">
                Waiting for you to sign in to ReserveCalifornia&hellip;
                <span className="mt-1 block text-ch-muted">
                  Sign in in that window, then come back here. Nothing has been released yet.
                </span>
              </p>
            ) : (
              <>
                <button
                  onClick={prepareRc}
                  className="w-full rounded-xl bg-ch-green-deep px-6 py-4 text-lg font-bold text-white"
                >
                  Start hand-off
                </button>
                <p className="mt-2 text-sm text-ch-muted">
                  Opens ReserveCalifornia so you can sign in. We keep holding{' '}
                  <strong>{site}</strong> until you say go.
                </p>
              </>
            )}
            {/* UNCONFIRMED IS NOT A REFUSAL. The webview closed without announcing a token,
                which may mean no session — or may mean we simply could not see one. Those
                are different facts and only the first would justify blocking, so the old
                checkbox comes back as the way through rather than a dead end. */}
            {rcCheck === 'unconfirmed' && !signedIn && (
              <label className="mt-3 flex w-full cursor-pointer items-start gap-3 rounded-xl border border-ch-line p-4 text-left">
                <input
                  type="checkbox"
                  checked={signedIn}
                  onChange={(e) => setSignedIn(e.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-ch-green-deep"
                />
                <span className="text-sm text-ch-ink">
                  We couldn&rsquo;t confirm your ReserveCalifornia sign-in. Tick this if
                  you&rsquo;re signed in and we&rsquo;ll hand over anyway.
                </span>
              </label>
            )}
          </div>
        ) : (
          <>
            <ol className="mt-5 w-full space-y-3 text-left text-sm text-ch-ink">
              <li className="flex gap-3">
                <span className="font-bold text-ch-green-deep">1.</span>
                <span>
                  <a
                    href={rcHandoffUrl({ url: bookingUrl.current })}
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
          </>
        )}

        {/* THE RELEASE, shown only once it can actually be pressed. A dead button with an
            explanation underneath was still a dead button competing for attention with the
            step that would enable it; on the app path there is now exactly one live control
            on screen at a time. */}
        {mayRelease && (
          <button
            onClick={claim}
            disabled={busy}
            className="mt-4 w-full rounded-xl bg-ch-green-deep px-6 py-4 text-lg font-bold text-white disabled:opacity-60"
          >
            {busy ? 'Releasing…' : "It's mine — hand it over"}
          </button>
        )}
        {!mayRelease && !canInject && (
          <p className="mt-3 text-sm text-ch-muted">
            Tick the box once you&rsquo;re signed in and on the page — we won&rsquo;t let go
            until then.
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
          href={rcHandoffUrl({
            url: bookingUrl.current,
            unitId: state.unitId,
            arrivalDate: state.arrivalDate,
            nights: state.nights,
          })}
          onClick={(e) => {
            // Kept as a real <a> with a real href — middle-click, long-press and "copy
            // link" all still work, and it degrades if JS is broken. The handler only
            // takes over when there is something better to do than follow it.
            e.preventDefault();
            void openRcHandoff({
              url: bookingUrl.current,
              unitId: state.unitId,
              arrivalDate: state.arrivalDate,
              nights: state.nights,
            }, { onReport });
          }}
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
