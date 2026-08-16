'use client';

import { openRcHandoff, rcHandoffUrl, rcHandoffDiagnostics, type RcReport } from '@/lib/native/rc-handoff';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, AlertTriangle } from 'lucide-react';
import BrandMark from '@/components/v2/BrandMark';
import { buttonClasses } from '@/components/ui/Button';
import { useIsNativeApp } from '@/lib/native/context';
import { stayLabel } from '@/lib/hold-labels';
import { handoffCopy } from '@/lib/claim-copy';
import { rcHandoffStep, type RcCheck } from '@/lib/claim-gate';
import { loginInvocation } from '@/lib/rc-login-script';
import { RC_CART_URL } from '@/lib/booking-url';
import RcSignInForm from './RcSignInForm';

/**
 * The stages the injected sign-in emits, and the only ones the form reacts to.
 *
 * An allow-list rather than "anything that is not a precart stage", because the channel
 * carries the precart's own `load`/`submit`/`status` too and showing those under a sign-in
 * form would describe the wrong job. `rc-login-script.ts` is where these names come from.
 */
const LOGIN_STAGES = new Set(['signin-open', 'captcha', 'email', 'password', 'submitted']);

/**
 * The banner text that means the site is in the user's cart.
 *
 * OUR OWN COPY, not RC's — `content-rc.js` writes it into `#camphawk-rc-status`, which the
 * epilogue observes and reports as a `status` stage. That is the same line
 * `rc-holds-readout.mts` reads to decide whether a hand-off worked, so the screen and the
 * post-mortem cannot disagree about what happened.
 *
 * Matching on copy is normally the thing this codebase avoids — RC rewords its own pages and
 * a rule built on their sentence fails silently the day they do. This sentence is ours, and
 * changing it means changing the readout too; the guard below pins them together.
 */
const CARTED_BANNER = 'Added to cart';
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
 *
 * ## THE 2026-08-13 REDESIGN — what changed and why
 *
 * Run twice on a real iOS hold, this screen read as an unstyled document: a lucide tent
 * glyph, centred prose, and no way back into the app. Everything it said was accurate and
 * none of it looked like the product it belongs to, at the one moment somebody is being
 * asked to trust it with a campsite. Three structural changes came out of that:
 *
 *   • **One card carries the site.** Campground, site number, dates, and the deadline, in
 *     that order, at the top. The site number is the single fact the user must hold in
 *     their head while they act, so it is set at display size and never buried in a
 *     sentence — this was already true on two of the four states and not on the others.
 *   • **The brand mark is a link.** The claim page lives outside the `(app)` route group,
 *     so it has no nav, no backdrop and no way home. A user who arrives here from an email
 *     and wants their watches had to type the URL.
 *   • **The words are a function of the capability** (`lib/claim-copy`). What this screen
 *     may promise depends on whether the client can actually run the precart, and having
 *     both branches spelled out inline is how the wrong one gets edited.
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
  /** Was the hold ALREADY released when this screen first loaded? See the redirect effect. */
  const arrivedReleased = useRef<boolean | null>(null);

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
  const [rcCheck, setRcCheck] = useState<RcCheck>('idle');
  /**
   * What the injected sign-in last said about itself, and RC's own words when it failed.
   *
   * `loginStage` is the raw stage name so the form can act on `captcha` — the one report the
   * USER has a job for. Everything else is progress. `loginError` is Okta's banner text
   * verbatim: a paraphrase of "incorrect password" would be a guess derived from which
   * timeout expired, which is precisely what the bot's sign-in was fixed not to do.
   */
  const [loginStage, setLoginStage] = useState<string | null>(null);
  /** The precart reported the site is in their cart, so checkout is reachable. */
  const [carted, setCarted] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
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
   * THE TWO RC CART POSTS WERE THE LAST UNMEASURED LINK, and this is what closed it: two
   * synthetic holds on 2026-08-13 reported `✓ Added to cart` through this channel, the
   * first confirmed by eye on RC's own cart page. It stays because the question is only
   * settled on iOS — Android has never run `load` + `submit` — and because RC changes this
   * payload without telling anyone.
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
      // A token means the sign-in is done, whatever the last stage was. Leaving `captcha` on
      // screen after a successful login would tell the user to solve a challenge that is no
      // longer there — the same class of mistake as the claim screen asking someone to
      // "switch to your ReserveCalifornia tab" in an app that has no tabs.
      setLoginStage(null);
      setLoginError(null);
    }
    // THE SIGN-IN'S OWN STAGES. Read from the same channel as everything else, so what the
    // form shows and what is recorded against the hold cannot disagree — the rule that made
    // the release gate read `token captured` rather than a checkbox the user ticked.
    if (LOGIN_STAGES.has(r.stage)) setLoginStage(r.stage);
    // THE CART LANDED. Until now the screen said "tap the cart icon at the top", which is an
    // instruction to go and navigate a page we just put them on. We know the moment it
    // succeeds, so we can offer the one control that finishes the job instead.
    if ((r.stage === 'status' || r.stage === 'banner')
      && String((r.detail as { status?: string } | null)?.status ?? '').includes(CARTED_BANNER)) {
      setCarted(true);
    }
    // The webview closed. If nothing announced a token before it went, we did not confirm
    // a session — which is NOT the same as knowing there isn't one, and is treated that way
    // below: it downgrades to the checkbox rather than blocking the release.
    if (r.stage === 'closed') {
      setRcCheck((prev) => (prev === 'verified' ? prev : 'unconfirmed'));
    }
  }, [flushReports]);

  /**
   * WHICH PLATFORM, AND WHICH BINARY — stamped once per claim, before anything opens.
   *
   * The two RC cart POSTs were proven on 2026-08-13, and the write-up of that run very
   * nearly said "Android" out of pure habit: `client_reports` carried no platform at all,
   * and the real answer (iOS) came from the status bar of a screenshot the owner happened
   * to send. That is luck, not instrumentation.
   *
   * It matters because the platforms differ exactly where this feature lives — WKWebView
   * has its own cookie store and its own ITP rules, which is why the 08-09 sign-in tests
   * were repeated on iOS rather than inferred from Android. **A result on one is not a
   * result on both**, so a trace that cannot say which it was cannot settle either.
   *
   * `appBuild` rides along because it is the only fact that settles which binary answered
   * — the question that cost an evening on 2026-08-09 to three different wrong guesses.
   *
   * It goes through `onReport`, so it travels the buffered path already built for this and
   * needs no schema change. ONCE: the platform cannot change mid-flow, and a repeat would
   * push the cart's own verdict further from the end of a capped list. Nothing here is
   * sensitive — no token, no cart key, no URL — which matters because this does NOT pass
   * through the injected script's `scrub()`.
   */
  const platformNoted = useRef(false);
  const notePlatform = useCallback(() => {
    if (platformNoted.current) return;
    platformNoted.current = true;
    void rcHandoffDiagnostics()
      .then((d) => {
        onReport({
          n: 0,
          stage: 'platform',
          detail: {
            platform: d.platform ?? 'unknown',
            appBuild: d.appBuild ?? 'unknown',
            nativeShell: d.nativeShell ?? 'unknown',
            ua: d.ua ?? '',
          },
        });
      })
      // Never surface this. A diagnostic that can break the claim is worse than no
      // diagnostic, and `rcHandoffDiagnostics` dynamically imports a native plugin.
      .catch(() => {});
  }, [onReport]);

  /**
   * Open RC in the injectable webview so the user can sign in BEFORE anything is released.
   * No `unitId` — see the note on `rcCheck`; this must not be able to cart.
   */
  /**
   * Sign the user in to RC inside the webview, with credentials they just typed.
   *
   * THE CREDENTIALS LIVE IN THIS CLOSURE AND NOWHERE ELSE. They are not state, so they are
   * never in a React tree, never in a devtools snapshot, and gone the moment this returns.
   * They are handed to `afterLoad`, which is re-asked on every navigation — RC's sign-in
   * walks out to Okta and back, so a single injection would fire on the home page and never
   * again on the form.
   *
   * `sent` is what stops it firing twice. `__chRcLogin` is idempotent enough (it returns
   * early on an existing token) but a second submission of a password is not something to
   * leave to chance: Okta locks accounts, and the bot carries a two-strike rule for it.
   *
   * NO `unitId`, exactly as `prepareRc` does — `rcFragment` returns '' without one, so this
   * window physically cannot cart. Signing in and handing the site over stay separate acts,
   * which is what lets the user decide when the ~2.5s exposure window opens.
   */
  async function signInToRc(email: string, password: string) {
    notePlatform();
    setLoginError(null);
    setLoginStage(null);
    setRcCheck('opening');
    let sent = false;
    try {
      await openRcHandoff(
        { url: bookingUrl.current },
        {
          onReport,
          closeOnToken: true,
          afterLoad: () => {
            if (sent) return null;
            sent = true;
            return loginInvocation(email, password);
          },
        },
      );
    } catch {
      setRcCheck('unconfirmed');
      setLoginError('We could not open ReserveCalifornia. Try again, or sign in there yourself.');
    }
  }

  async function prepareRc() {
    notePlatform();
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
      // FIRST LOAD ONLY (`null` means we have not looked yet). This records whether the
      // hold was ALREADY released when we arrived, which is what separates "the bot just
      // let go, go now" from "this released an hour ago and the user tapped Open the
      // hand-off again". The redirect effect reads it; without this assignment the ref
      // stays null, the effect never sees it, and the fix is present but inert.
      if (arrivedReleased.current === null) arrivedReleased.current = j.status === 'released';
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
    // ONLY ON A TRANSITION WE WATCHED, never on arrival at an old one.
    //
    // Going straight to RC is right at 08:00: the bot has just let go and every pause is
    // exposure. It is wrong when the hold released an hour ago and the user has tapped
    // "Open the hand-off again" from the Watches tab — they are thrown into ReserveCalifornia
    // before they can read which site it is or what to do. Reported from the app on
    // 2026-08-13, and the effect had no way to tell the two apart because it only ever saw
    // the CURRENT status.
    //
    // `arrivedReleased` is set from the FIRST load. If it was already released when we got
    // here, this is a revisit: render the screen and let them press something. The button on
    // it opens RC through the same seam, so nothing is lost — it just stops happening TO them.
    if (arrivedReleased.current) return;
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
    notePlatform();
    void openRcHandoff({
      url: bookingUrl.current,
      unitId: state.unitId,
      arrivalDate: state.arrivalDate,
      nights: state.nights,
    }, { onReport });
  }, [state, onReport, notePlatform]);

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

  if (error) {
    return (
      <Shell>
        <Notice>{error}</Notice>
      </Shell>
    );
  }
  if (!state) {
    return (
      <Shell>
        <div className="flex justify-center py-10">
          <Loader2 className="animate-spin text-ch-muted" />
        </div>
      </Shell>
    );
  }

  const site = state.unitName ?? state.unitId ?? 'your site';
  const copy = handoffCopy(canInject);

  if (state.status === 'carted') {
    return (
      <Shell>
        <SiteCard
          site={site}
          stay={stayLabel(state.arrivalDate, state.nights)}
          heading={maybeGone ? 'This may already be gone' : "We're holding this for you"}
          tone={maybeGone ? 'warn' : 'hold'}
          footer={
            minsLeft !== null
              ? maybeGone
                ? 'ReserveCalifornia drops a cart after about 15 minutes, and it has been longer than that. It may already be free again — worth trying anyway.'
                : `ReserveCalifornia holds a cart about ${RC_CART_HOLD_MINUTES} minutes. About ${minsLeft} left.`
              : null
          }
        />

        <p className="mt-4 text-ch-body leading-relaxed text-ch-ink-2">
          When you tap the green button we let go and you take it. That swap takes a couple
          of seconds, and the site is open to anyone during it — so only tap when
          you&rsquo;re ready to finish.
        </p>

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
        */}
        <div className="mt-4">
          {rcCheck === 'verified' || signedIn ? (
            <Step tone="done" title={copy.readyTitle} />
          ) : rcCheck === 'opening' && !canInject ? (
            /*
              THE WAITING STEP IS FOR THE PATH WE CANNOT DRIVE. There the user has gone off to
              RC themselves and this screen has nothing to do but wait.
              ON THE INJECTABLE PATH THE FORM STAYS MOUNTED while the sign-in runs, and that
              is not cosmetic: `captcha` is the one stage the USER has a job for, and
              swapping the form out for a spinner would unmount the only thing able to tell
              them so. TypeScript found this — it narrowed `rcCheck` past 'opening' in the
              branch below and made the dead `busy` prop an error.
            */
            <Step tone="busy" title={copy.waitingTitle} body={copy.waitingBody} />
          ) : (
            /*
              THE SIGN-IN IS THE WHOLE STEP, AT THE SIZE OF THE WHOLE STEP (owner note 4).
              This used to read "Start hand-off", which names our internal process rather
              than the user's job, and then explained the actual instruction in grey text
              underneath. At 8am on a phone the instruction has to BE the button.
            */
            <>
              <Step tone="todo" title={copy.prepareTitle} body={copy.prepareBody} />
              {/*
                WE DO THE SIGNING IN NOW, on an injectable client. The user typed their
                ReserveCalifornia password into the app and we fill RC's own form with it
                inside this webview — so at 08:00 the job is "type it once", not "go and
                navigate a browser you did not open".

                THE SESSION HAS TO BE THEIRS, which is why this happens in the webview and
                not on our box: the cart is bound to the SESSION that made it, measured
                2026-08-06 when a second session on the same account read that cart as 0
                entries. A server-side login would mint a cart their phone could never see.

                ON A PLAIN BROWSER, `canInject` is false, `rcHandoffStep` returns 'finish'
                and this branch is unreachable — correct, because there is no injection
                there and a form we cannot act on would be a worse lie than the old button.
              */}
              {canInject ? (
                <RcSignInForm
                  onSubmit={signInToRc}
                  busy={rcCheck === 'opening'}
                  error={loginError}
                  stage={loginStage}
                />
              ) : (
                <button
                  onClick={prepareRc}
                  className={buttonClasses({ size: 'lg', fullWidth: true, className: 'mt-3' })}
                >
                  {copy.prepareCta}
                </button>
              )}
            </>
          )}

          {/* UNCONFIRMED IS NOT A REFUSAL. The webview closed without announcing a token,
              which may mean no session — or may mean we simply could not see one. Those
              are different facts and only the first would justify blocking, so the old
              checkbox comes back as the way through rather than a dead end.

              On the plain-browser path there is nothing to observe, so it is the only gate
              there is and shows from the start. */}
          {(rcCheck === 'unconfirmed' || !canInject) && !signedIn && (
            <label className="mt-3 flex w-full cursor-pointer items-start gap-3 rounded-ch-card border border-ch-line bg-ch-card p-4 text-left">
              <input
                type="checkbox"
                checked={signedIn}
                onChange={(e) => setSignedIn(e.target.checked)}
                className="mt-0.5 size-5 shrink-0 accent-ch-green"
              />
              <span className="text-ch-body leading-normal text-ch-ink">
                {canInject
                  ? "We couldn't confirm your ReserveCalifornia sign-in. Tick this if you're signed in and we'll hand over anyway."
                  : `I'm signed in to ReserveCalifornia and looking at ${site}`}
              </span>
            </label>
          )}
        </div>

        {/* THE RELEASE, shown only once it can actually be pressed. A dead button with an
            explanation underneath was still a dead button competing for attention with the
            step that would enable it; there is now exactly one live control on screen. */}
        {mayRelease ? (
          <button
            onClick={claim}
            disabled={busy}
            className={buttonClasses({ size: 'lg', fullWidth: true, className: 'mt-4' })}
          >
            {busy ? 'Releasing…' : copy.releaseCta}
          </button>
        ) : (
          !canInject && (
            <p className="mt-3 text-ch-meta text-ch-muted">
              Tick the box once you&rsquo;re signed in and on the page — we won&rsquo;t let
              go until then.
            </p>
          )
        )}
      </Shell>
    );
  }

  if (state.status === 'claiming') {
    return (
      <Shell>
        <SiteCard
          site={site}
          stay={stayLabel(state.arrivalDate, state.nights)}
          heading="Letting go — grab it now"
          tone="hold"
        />
        {/*
          THERE IS NO TAB IN THE APP. This told everyone to "switch to your ReserveCalifornia
          tab", which is true on a desktop where step one opened one — and meaningless on a
          phone, where the sign-in window has just closed itself and the user is looking at
          this screen with nothing to switch to. Reported from the app on 2026-08-12: "you
          can't get there".

          Instructions the reader cannot follow are worse than none: they read as a step
          missed, at the one moment the design is asking them to sit still for two seconds.
          On the app path we reopen RC ourselves the instant the bot lets go, so say that.
        */}
        <div className="mt-4 flex items-start gap-3 rounded-ch-card border border-ch-line bg-ch-card p-4">
          <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-ch-green" />
          <p className="text-ch-body leading-normal text-ch-ink">{copy.releasingBody}</p>
        </div>
        {state.stuck && (
          <Notice tone="warn">
            {/* A spinner that never resolves is worse than bad news. If the runner is
                down, say so and point at the thing that still works. */}
            This is taking longer than it should — our bot may be offline. The site is still
            held, so nothing is lost. Try again in a minute, or open ReserveCalifornia and
            search for {site}.
          </Notice>
        )}
      </Shell>
    );
  }

  if (state.status === 'released' || state.status === 'claimed') {
    /*
      STEP ONE BELONGS ON THIS SCREEN TOO — the ordinary flow is not the only way in.

      Reached from the 08:00 redirect, the user has already run `prepareRc` (it is what let
      them press the release button), so `rcCheck` is still 'verified' and this is exactly
      the screen it always was. Reached from "Open the hand-off again" on the Watches panel,
      the component has just mounted: `rcCheck` is 'idle' and there is no RC session in this
      webview, because nothing on this path ever asked for one.

      "Finish on ReserveCalifornia" runs the precart in that webview. With no session it
      spends `getToken`'s twelve-second wait on "Reading your session…" and then can only ask
      the user to sign in on RC's own page — which RC scrolls past its own sign-in control.
      Same symptom as the morning hold that started all this, same cause: the precart needs a
      session HERE and nothing on this screen established one.

      No new mechanism. The gate is `rcHandoffStep`, and the way through it is `prepareRc`,
      both already built for the pre-release screen.
    */
    const step = rcHandoffStep(canInject, rcCheck);
    return (
      <Shell>
        <SiteCard
          site={site}
          stay={stayLabel(state.arrivalDate, state.nights)}
          heading={`${site} is yours to book`}
          tone="done"
        />
        {step === 'finish' ? (
          <>
            <p className="mt-4 text-ch-body leading-relaxed text-ch-ink">{copy.afterBody}</p>
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
                notePlatform();
                void openRcHandoff({
                  url: bookingUrl.current,
                  unitId: state.unitId,
                  arrivalDate: state.arrivalDate,
                  nights: state.nights,
                }, { onReport });
              }}
              className={buttonClasses({ size: 'lg', fullWidth: true, className: 'mt-4' })}
            >
              {copy.afterCta}
            </a>
            {/*
              STRAIGHT TO THE CART, once the precart says there is one.

              The button above lands on the PARK page, because that is where the precart has
              to run. Before this, the screen then told the user to "tap the cart icon at the
              top" — an instruction to navigate a page we had just opened for them, and the
              last piece of browser wrangling left in the flow.

              Only rendered once a `status` report carried our own "Added to cart" banner, so
              it is offered on evidence rather than on optimism. A checkout button over an
              empty cart is the same broken promise as the copy rule this file has enforced
              since 2026-08-09.

              NAVIGATED FROM HERE rather than from inside the injected script: the precart
              runs on `loadstop`, so a script-driven navigation re-injects on arrival and can
              loop. This is one deliberate press instead.
            */}
            {carted && (
              <button
                onClick={() => {
                  notePlatform();
                  // No `unitId` — this window is for checking out, and rcFragment returns ''
                  // without one, so it physically cannot try to cart again.
                  void openRcHandoff({ url: RC_CART_URL }, { onReport });
                }}
                className={buttonClasses({ size: 'lg', fullWidth: true, className: 'mt-3' })}
              >
                Check out on ReserveCalifornia
              </button>
            )}
          </>
        ) : step === 'waiting' ? (
          <div className="mt-4">
            {/* No body text. The pre-release version of this says "nothing has been released
                yet — your site is still ours", which is the one thing that is no longer true
                here, and a reassurance that is false is worse than none. */}
            <Step tone="busy" title={copy.waitingTitle} />
          </div>
        ) : (
          <div className="mt-4">
            <Step tone="todo" title={copy.prepareTitle} body={copy.afterSignInBody} />
            <button
              onClick={prepareRc}
              className={buttonClasses({ size: 'lg', fullWidth: true, className: 'mt-3' })}
            >
              {copy.prepareCta}
            </button>
          </div>
        )}
        <a
          href={RC_CART_URL}
          className="mt-3 block text-center text-ch-meta text-ch-muted underline"
        >
          Go straight to your ReserveCalifornia cart
        </a>
      </Shell>
    );
  }

  return (
    <Shell>
      <Notice>
        {/* Every remaining status means there is nothing to hand over, and saying which
            beats a generic error: expired and failed have different next steps. */}
        {/* NOT "so we released the site" any more. A hold can also expire because we
            carted it and then could NOT let go — the RC session dies most of the day, and
            the release loop needs it — in which case RC dropped the cart on its own timer
            and we never touched it. Both endings put the site back on the open market,
            which is the part the reader needs; only one of them is us doing it. */}
        {state.status === 'expired'
          ? 'That hold expired — nobody claimed it, so the site is back on the open market.'
          : state.status === 'failed'
            ? "We couldn't hold that site. Your alerts carry on as normal."
            : 'Nothing is being held for you right now.'}
      </Notice>
    </Shell>
  );
}

/**
 * The site, at the size it has to be read at.
 *
 * The unit number is the one fact the user must carry into ReserveCalifornia's grid of
 * dozens, under a clock they can feel. Two of the four states already promoted it to
 * display size and the other two buried it in a sentence, which is exactly how the window
 * gets spent re-reading the sentence.
 */
function SiteCard({
  site, stay, heading, tone, footer,
}: {
  site: string;
  stay: string;
  heading: string;
  tone: 'hold' | 'done' | 'warn';
  footer?: string | null;
}) {
  const ring =
    tone === 'warn' ? 'border-ch-line bg-ch-ochre-soft' :
    tone === 'done' ? 'border-ch-green bg-ch-green-soft' :
    'border-ch-line bg-ch-card';
  return (
    <section className={`rounded-ch-card border-2 p-5 shadow-ch-card ${ring}`}>
      <p className="text-ch-meta font-bold uppercase tracking-[.08em] text-ch-muted">{heading}</p>
      {/* STEP THE SIZE DOWN FOR A LONG NAME. `rcSiteLabel` prefers RC's short human token
          (`#L006`) and that is what almost every hold carries — but the fallback is RC's
          full description ("Hook Up (E/W/S) Campsite #R306"), and at 34px that wraps to
          three lines and pushes the actual instruction off a phone screen. The point of
          setting this large was that it is read at a glance under a clock; a headline that
          costs half the viewport stops serving that. */}
      <p
        className={`mt-2 font-ch-display font-extrabold leading-[1.05] tracking-[-.03em] text-ch-ink ${
          site.length > 22 ? 'text-[22px]' : site.length > 12 ? 'text-[27px]' : 'text-[34px]'
        }`}
      >
        {site}
      </p>
      {stay && <p className="mt-2 text-ch-body text-ch-ink-2">{stay}</p>}
      {footer && (
        <p className="mt-3 border-t border-ch-line/70 pt-3 text-ch-meta leading-normal text-ch-ink-2">
          {footer}
        </p>
      )}
    </section>
  );
}

/** One step of the hand-off, in the state it is currently in. */
function Step({
  tone, title, body,
}: { tone: 'todo' | 'busy' | 'done'; title: string; body?: string }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-ch-card border p-4 ${
        tone === 'done' ? 'border-ch-green bg-ch-green-soft' : 'border-ch-line bg-ch-card'
      }`}
    >
      {/* A SHAPE AND A WORD, NEVER A COLOUR ALONE — the same rule the admin dashboard's
          StatusMark enforces, for the same reason: the owner is colour-blind, and a green
          tick and an amber dot are two grey dots to a deuteranope. */}
      <span className="mt-0.5 shrink-0">
        {tone === 'busy' ? (
          <Loader2 className="size-5 animate-spin text-ch-green" />
        ) : tone === 'done' ? (
          <span className="grid size-5 place-items-center rounded-full bg-ch-green text-[12px] font-bold text-white">
            ✓
          </span>
        ) : (
          <span className="grid size-5 place-items-center rounded-full bg-ch-ochre-soft text-[12px] font-bold text-ch-ochre-ink">
            1
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-ch-body font-bold text-ch-ink">{title}</span>
        {body && <span className="mt-1 block text-ch-meta leading-normal text-ch-ink-2">{body}</span>}
      </span>
    </div>
  );
}

function Notice({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'warn' }) {
  return (
    <div
      className={`mt-4 flex items-start gap-3 rounded-ch-card border p-4 ${
        tone === 'warn' ? 'border-ch-line bg-ch-ochre-soft' : 'border-ch-line bg-ch-card'
      }`}
    >
      {tone === 'warn' && <AlertTriangle size={18} className="mt-0.5 shrink-0 text-ch-ochre-ink" />}
      <p className="text-ch-body leading-normal text-ch-ink">{children}</p>
    </div>
  );
}

/**
 * The page frame — and the way back into the app.
 *
 * `/claim/<id>` lives OUTSIDE the `(app)` route group, deliberately: it is reached from an
 * email or a push by somebody who may not be signed in, and it carries a token in its URL.
 * The cost of that was no nav, no backdrop and no exit — a user who finished a hand-off and
 * wanted their watches had nowhere to press. The brand mark is that exit as well as the
 * only thing on the page that says whose screen this is.
 *
 * Native goes to /search rather than / for the same reason V2Nav does: the marketing home
 * page carries prices and Stripe checkout, which must never be reachable inside the app.
 */
function Shell({ children }: { children: React.ReactNode }) {
  const isNative = useIsNativeApp();
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-16 pt-6">
      <Link
        href={isNative ? '/search' : '/'}
        className="mb-5 inline-flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
      >
        <BrandMark size={40} />
        <span className="font-ch-display text-[22px] font-extrabold tracking-[-.025em] text-ch-ink">
          CampHawk
        </span>
      </Link>
      {children}
    </main>
  );
}
