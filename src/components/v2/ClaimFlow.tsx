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
const LOGIN_STAGES = new Set(['signin-open', 'signin-missing', 'captcha', 'email', 'password', 'submitted']);

/**
 * How many distinct pages the sign-in may be handed the credentials on.
 *
 * RC → Okta authorize → Okta login → callback is four, and a CAPTCHA can add one. Past that
 * it is a redirect loop, and a loop that keeps posting a password is the one failure in this
 * flow worth bounding absolutely: Okta locks accounts, and a locked account at 07:59 costs
 * the site the hold exists to save.
 */
const MAX_LOGIN_PAGES = 6;

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
  /** The park AND division this site belongs to — what the user checks RC against. */
  campgroundName?: string | null;
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
   * When this webview's RC token dies, as an ABSOLUTE instant — not the seconds we were told.
   *
   * `expiresInSec` is a snapshot taken when the report was written, and the user may sit on
   * this screen for minutes before tapping. Storing the deadline means the gate asks "how
   * long is left NOW", which is the only version of the question that matters: on 08-29 the
   * reported figure fell 134 -> 116 across a single hand-off and the precart was refused.
   */
  const [tokenDeadline, setTokenDeadline] = useState<number | null>(null);
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
  /**
   * RUNNING IN THE APP, AND THE APP CANNOT INJECT — a binary that is too old, or built
   * without the Cordova plugin. NOT the same as a plain browser, and that difference is
   * what this exists for.
   *
   * On 2026-08-29 the bot carted #94 at T+6s and the owner lost the site anyway: their
   * phone was on `1.0 (1)`, Capacitor's DEFAULT versionCode, i.e. a local debug build with
   * no Cordova plugins. `canInject` was false, so the claim screen rendered the
   * plain-browser copy — which is CORRECT for a browser and, inside the app, is
   * indistinguishable from working. Nothing anywhere said "this build cannot cart for
   * you". They believed it was handled, and it was not.
   *
   * A browser is `nativeShell: false` and the manual path is the right answer there, so
   * this must never fire on one — a warning shown to every desktop user is noise, and
   * noise is what gets a warning deleted.
   *
   * BOTH FALSE UNTIL THE PROBE ANSWERS, so a slow probe shows nothing rather than
   * flashing a warning at someone whose app is fine; and a probe that THROWS leaves this
   * false, because "we could not tell" must not be rendered as "your app is broken". Same
   * rule as `unknown` never rounding to `signed-out`.
   */
  const [staleShell, setStaleShell] = useState(false);

  useEffect(() => {
    let live = true;
    void rcHandoffDiagnostics()
      .then((d) => {
        if (!live) return;
        setCanInject(d.inAppBrowser === 'present');
        setStaleShell(d.nativeShell === 'true' && d.inAppBrowser !== 'present');
      })
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

    /**
     * THE VERIFICATION IS THE REPORT, not a second probe. `token captured` is the injected
     * script telling us it read an RC access token out of THIS webview's storage — read from
     * the same channel the diagnostics use, so the thing gating the button and the thing
     * recorded on the hold can never disagree.
     *
     * ## PRESENCE IS NOT LIVENESS, and this gate read presence until 2026-08-21
     *
     * It fired on `captured` alone. On the 08-21 test the phone reported
     *
     *     token { captured: true, decodable: true, expiresInSec: -82599 }
     *
     * — a token that had expired **23 hours earlier** — and the screen said "verified". The
     * user released a real hold against a session that was already dead, the precart then
     * found `storedToken: "none"`, sat on "Reading your session…", and the site went back on
     * the open market having been carted for nobody.
     *
     * That is the `status = 'sent'` family exactly: a field that only ever meant "something
     * was there". `expiresInSec` has been in this report since migration 058, whose own note
     * says **"Never presence, always liveness"** — the reporter supplied it and the gate
     * ignored it.
     *
     * ## Three outcomes, because "expired" and "could not tell" are different facts
     *
     *  - decodable and still alive  → `verified`, the fast path, unchanged.
     *  - decodable and ALREADY DEAD → NOT verified, and the user is TOLD, because this is
     *    positive evidence of no session rather than an absence of evidence.
     *  - undecodable or no expiry   → `unconfirmed`, unchanged. We could not tell, and an
     *    unknown must never round to a verdict in either direction.
     *
     * NONE OF THEM LOCKS ANYONE OUT. `mayRelease` still accepts the checkbox, so a wrong
     * expiry read costs a sentence rather than a hold somebody waited all morning for —
     * the same rule that makes an unconfirmed check fall back rather than refuse.
     */
    if (r.stage === 'token' && (r.detail as { captured?: boolean } | null)?.captured) {
      const d = r.detail as { expiresInSec?: unknown; decodable?: unknown } | null;
      const secs = typeof d?.expiresInSec === 'number' ? d.expiresInSec : null;
      if (secs != null && secs <= 0) {
        // DEAD, AND SAID SO. Silence here would leave the screen looking exactly as it did
        // on 08-21: an apparently ready hand-off over a session that cannot cart anything.
        setRcCheck('unconfirmed');
        setLoginStage(null);
        setLoginError(
          'Your ReserveCalifornia sign-in has expired. Sign in again before handing the site '
          + 'over — releasing now would put it back on the open market for anyone.',
        );
      } else {
        // NOT `verified` — NOT ANY MORE (2026-09-01, #249). A live Okta token is step ONE of
        // RC's sign-in; `verified` used to flip here and was the token-only check the owner
        // objected to, and it was wrong in the way that matters: a token exists in exactly
        // the state where RC renders signed out (step two cut off). The gate now flips on
        // `rc-session { loggedIn: true }` below, which is RC's own `customerId`. The token
        // still carries the deadline, because expiry is a separate fact the gate needs.
        //
        // The DEADLINE, so a long pause on this screen is counted against it. `null` when we
        // could not decode one — the gate must not act on a number it does not have.
        setTokenDeadline(secs != null ? Date.now() + secs * 1000 : null);
        // A live token means the sign-in is done, whatever the last stage was. Leaving
        // `captcha` on screen after a successful login would tell the user to solve a
        // challenge that is no longer there — the same class of mistake as the claim screen
        // asking someone to "switch to your ReserveCalifornia tab" in an app with no tabs.
        setLoginStage(null);
        setLoginError(null);
      }
    }
    // RC'S OWN VERDICT, AND THE ONLY THING THAT FLIPS THE GATE (2026-09-01). `loggedIn` is
    // `!!localStorage.customerId` on RC's origin — the expression RC's SPA boots
    // `isLoggedIn` from, and the key only step two of its sign-in writes. This is the
    // owner's "verify they're in fact signed in" done against the fact RC itself uses,
    // rather than against a token RC has not finished with. Strictly `true`: a bundle older
    // than #249 sends no such stage and must not flip anything.
    if (r.stage === 'rc-session' && (r.detail as { loggedIn?: unknown } | null)?.loggedIn === true) {
      setRcCheck('verified');
      setLoginStage(null);
      setLoginError(null);
    }
    // RC IS STILL FINISHING, AND THE WINDOW HAS SAID SO TO THE USER. The bundle shows its own
    // notice inside the webview (that is where the user is looking); this mirrors it on the
    // screen underneath for when they come back. Nothing is closed and nothing is refused.
    if (r.stage === 'settle-timeout') {
      setLoginError(
        'ReserveCalifornia is still finishing your sign-in. In the RC window, wait until your '
        + 'name shows at the top, then tap Done.',
      );
    }
    // THE SIGN-IN'S OWN STAGES. Read from the same channel as everything else, so what the
    // form shows and what is recorded against the hold cannot disagree — the rule that made
    // the release gate read `token captured` rather than a checkbox the user ticked.
    if (LOGIN_STAGES.has(r.stage)) setLoginStage(r.stage);
    // THE SIGN-IN NEVER RAN. Distinct from "it ran and RC said no", which is `failed` and
    // carries RC's own words. This one is ours: the webview loaded a bundle with no sign-in
    // in it — in practice a cached copy from before a deploy, which is why the remedy the
    // user is offered is "try again" and not "check your password". Before this stage
    // existed the screen simply sat there, which is what the user saw on 2026-08-16.
    // THE SIGN-IN'S OWN VERDICT. Until 2026-08-16 every terminal path of `__chRcLogin`
    // returned a value into `executeScript`, which discards it — so a failed sign-in and an
    // absent one produced identical evidence, and a real test run reported nothing at all.
    if (r.stage === 'login-result') {
      const d = r.detail as { ok?: boolean; stage?: string; reason?: string | null } | null;
      if (d?.ok) { setLoginStage(null); setLoginError(null); }
      else {
        setRcCheck('unconfirmed');
        setLoginStage(null);
        // RC's or Okta's own words when we have them — never our paraphrase, because the
        // remedy for "wrong password" and for "we never found the form" is not the same.
        setLoginError(d?.reason || 'The sign-in did not complete. Try again, or sign in on ReserveCalifornia yourself.');
      }
    }
    if (r.stage === 'login-unavailable' || r.stage === 'login-threw') {
      setRcCheck('unconfirmed');
      setLoginStage(null);
      setLoginError(
        'We could not start the sign-in. Close this and tap it again — if it happens twice, '
        + 'sign in on ReserveCalifornia yourself and come back.',
      );
    }
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
            // THE CAPABILITY, NOT JUST THE PLATFORM — these were computed here and thrown
            // away, and their absence cost a real campsite on 2026-08-29. That morning the
            // bot carted #94 at T+6s and the phone never signed in or carted, and the only
            // clue in the whole record was `appBuild: "1.0 (1)"` — Capacitor's DEFAULT
            // versionCode, i.e. a local debug build with no Cordova plugins. The cause had
            // to be inferred from a version number three files away from the thing that
            // actually decides: `inAppBrowser`.
            //
            // `canInject` is exactly `inAppBrowser === 'present'`, so recording it makes the
            // hand-off say why it took the manual path instead of leaving it to be deduced.
            // `iabModule` separates "the plugin is absent from this binary" from "it is
            // present but had not clobbered the global when we looked" — a timing answer and
            // an installation answer, which is the distinction `rcHandoffDiagnostics` was
            // written for and which this report was silently discarding.
            //
            // `capPlugins` is deliberately NOT carried: it is a long comma-joined list, and
            // `client_reports` keeps only the TAIL of 40 entries — the trim that ate
            // `✓ Added to cart` off the front of both 2026-08-13 hand-offs.
            inAppBrowser: d.inAppBrowser ?? 'unknown',
            iabModule: d.iabModule ?? 'unknown',
            cordova: d.cordova ?? 'unknown',
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
   * ONCE PER PAGE — not once per hand-off, and not once per load.
   *
   * The first version fired exactly once, and that could never have worked: `__chRcLogin`
   * begins by clicking RC's sign-in control, which NAVIGATES to
   * `signin.reservecalifornia.com` and takes the whole JS context with it. The script died
   * mid-flight on the park page and was never invoked again on the page that has the form,
   * so the webview simply sat there — which is exactly what a user saw on 2026-08-16, and
   * indistinguishable from the TypeError being fixed in the same change. The comment right
   * here already said `afterLoad` was "re-asked on every navigation"; the flag defeated it.
   *
   * Firing on every load is the other wrong answer. Okta locks accounts, the bot carries a
   * two-strike rule for exactly this, and a repeat `loadstop` on the page we just submitted
   * on would resubmit the password. Keying on the URL separates the two: a new page is a new
   * step of the sign-in and gets a turn; a reload of the same page does not.
   *
   * `MAX_LOGIN_PAGES` is the backstop. Okta's flow is a handful of pages, so anything past
   * that is a redirect loop, and a loop that keeps posting a password is the one failure here
   * worth bounding absolutely rather than reasoning about.
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
    const pages = new Set<string>();
    try {
      await openRcHandoff(
        { url: bookingUrl.current },
        {
          onReport,
          closeOnToken: true,
          afterLoad: (at: string) => {
            // Origin + path, never the query: Okta's callback carries `?code=…&state=…`,
            // which is exchangeable for the session. Keying on the full URL would also make
            // every retry of one step look like a new page. Same rule as the reporter's
            // `href()`, and for the same reason.
            let key = at;
            try { const u = new URL(at); key = u.origin + u.pathname; } catch { /* keep raw */ }
            if (pages.has(key) || pages.size >= MAX_LOGIN_PAGES) return null;
            pages.add(key);
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
    /**
     * THE REFETCH IS OUTSIDE THE TRY, AND THAT IS THE WHOLE FIX.
     *
     * `await load()` used to sit beside the POST inside one `try`, so a refetch that threw
     * was reported as `Network error. Try again.` — over a release that had ALREADY
     * HAPPENED. Measured on the 08-21 test: `claim_started 15:01:46`, `released 15:01:54`,
     * status `released`, and the owner's screen showed nothing but that error.
     *
     * Two things make it worse than a wrong message. **"Try again" is advice for an action
     * that cannot be repeated** — the bot has let go and the site is on the open market. And
     * `if (error) return <Notice>` replaces the ENTIRE screen, so a successful release
     * destroyed the hand-off UI the user needed next.
     *
     * So the POST alone decides the verdict. A failed refetch is a stale screen, which the
     * poll below fixes on its own, and never a claim that "failed".
     */
    let released = false;
    try {
      const r = await fetch('/api/rc-holds/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: holdId, token }),
      });
      if (!r.ok) {
        setError('Could not claim this hold — it may have already been released.');
        return;
      }
      released = true;
    } catch {
      // ONLY the POST reaching us at all. If this throws, nothing was released — the
      // request never completed — so "try again" is honest here and only here.
      setError('Network error. Try again.');
      return;
    } finally {
      setBusy(false);
    }
    // Best effort, and deliberately unguarded by the error state above: the release stands
    // whatever this does.
    if (released) await load().catch(() => {});
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
          place={state.campgroundName}
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

        {/*
          THE APP CANNOT CART, AND IT MUST SAY SO — this is the 2026-08-29 loss.

          The bot did its half perfectly that morning: #94 was carted at T+6s and held. What
          failed was the phone, and it failed SILENTLY, because a build with no injectable
          webview renders the plain-browser copy — which is the correct copy for a browser
          and, inside the app, looks exactly like a working hand-off. The owner read a screen
          that never mentioned the words "sign in for you" or "cart", believed it was
          handled, and the site went back on the market.

          So the notice names three things, in the order they are needed: that this build
          will not do it, what to do INSTEAD RIGHT NOW (the release is live and manual still
          works — the site is not lost yet), and the actual remedy afterwards. A caveat with
          no instruction changes nobody's morning; that rule is why the auto-hold beta label
          names an alarm clock rather than just warning.

          ABOVE the "when you tap the green button" paragraph deliberately. That paragraph is
          the instruction they are about to act on, and a correction printed underneath the
          thing it corrects is read second or not at all — the same ordering argument that
          puts the beta label above the promise rather than below it.
        */}
        {staleShell && (
          <Notice tone="warn">
            This version of the app cannot sign in or add to your cart for you. Do that
            yourself on ReserveCalifornia now — the site stays held until you tap the green
            button, so it is not lost. Afterwards, update CampHawk from the Play Store so
            the next one is automatic.
          </Notice>
        )}

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
                THE TWO CLIENTS NEED DIFFERENT CONTROLS, and this is the one place that
                decides which.

                INJECTABLE: we do the signing in. The user types their ReserveCalifornia
                password here and we fill RC's own form with it inside this webview, so at
                08:00 the job is "type it once" rather than "go and navigate a browser you
                did not open". THE SESSION HAS TO BE THEIRS, which is why it happens in the
                webview and not on our box: the cart is bound to the SESSION that made it,
                measured 2026-08-06 when a second session on the same account read that cart
                as 0 entries. A server-side login would mint a cart their phone could never
                see.

                PLAIN BROWSER: an ANCHOR, not a button, and the difference is not stylistic.
                The button said "Open ReserveCalifornia in another tab" while `openRcHandoff`
                ends in `window.location.href = url` for web — so it opened in THIS tab and
                destroyed the claim screen. Reported from a phone on 2026-08-16. Losing this
                screen mid-flow is the whole cost: the site number, the dates and the release
                button all live here, and the only way back is Back.

                `window.open` inside `prepareRc` would NOT fix it. That function is async and
                awaits `injectableWebView()` before it reaches the web branch, so by then the
                user-gesture window has closed and Safari blocks the popup — a fix that looks
                right in review and fails on the device it was written for. A real link cannot
                be blocked and costs nothing to reason about.

                There is no sign-in form on that side deliberately: nothing there can act on
                it, and a form we cannot honour is a worse lie than the old button was.
              */}
              {canInject ? (
                <RcSignInForm
                  onSubmit={signInToRc}
                  busy={rcCheck === 'opening'}
                  error={loginError}
                  stage={loginStage}
                />
              ) : (
                <a
                  href={bookingUrl.current}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses({ size: 'lg', fullWidth: true, className: 'mt-3 block text-center' })}
                >
                  {copy.prepareCta}
                </a>
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
          place={state.campgroundName}
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
    // THE THIRD ARGUMENT IS THE POINT, and without it the gate's liveness check is inert —
    // the fix-present-and-unwired shape this repo has paid for repeatedly. Computed at
    // render, so a user who read the screen for two minutes is judged on what is left now.
    const tokenSecsLeft = tokenDeadline != null ? (tokenDeadline - Date.now()) / 1000 : null;
    const step = rcHandoffStep(canInject, rcCheck, tokenSecsLeft);
    return (
      <Shell>
        <SiteCard
          site={site}
          stay={stayLabel(state.arrivalDate, state.nights)}
          place={state.campgroundName}
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
  site, stay, place, heading, tone, footer,
}: {
  site: string;
  stay: string;
  /** Park + division. Optional: an older payload has none, and a missing line beats a wrong one. */
  place?: string | null;
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
      {/* THE PLACE, DIRECTLY UNDER THE SITE. A user who taps through to ReserveCalifornia
          lands on a division page and has to decide whether it is the right one — and on
          2026-08-16 somebody could not, because this card named the site and the dates and
          never the park. South Carlsbad alone has several similarly-named northern
          divisions, and since migration 070 one watch can span them, so the division name
          is the only thing that tells them apart.

          Under the site number, not above it: the number is still the fact they carry in
          their head, and this is what they check once they arrive. */}
      {place && <p className="mt-1 text-ch-body text-ch-ink-2">{place}</p>}
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
