/**
 * ONE place where CampHawk hands a user over to ReserveCalifornia to finish a booking.
 *
 * ## Why this exists as a seam rather than three `window.location.href =` lines
 *
 * The hand-off is the last two seconds of the whole auto-cart design: the bot lets go of
 * the site and the user's own session has to re-take it. On a DESKTOP with the CampHawk
 * extension that is automatic — the `#camphawk-rc=` fragment is read by
 * `extension/content-rc.js`, which POSTs the precart from the user's own logged-in
 * session. On a PHONE nothing consumes the fragment, so the user lands on the right page
 * and taps through by hand, spending the window this design exists to protect.
 *
 * Closing that gap needs an in-app webview we can inject JavaScript into, which is native
 * work — a new binary and a new review. This module is the seam that work lands in: today
 * every caller goes through `openRcHandoff`, and adding the native path later changes ONE
 * function instead of hunting three call sites that had each drifted their own way.
 *
 * ## The plugin situation, verified 2026-08-09 — READ THIS BEFORE PICKING ONE
 *
 * I recommended `@capacitor/inappbrowser` for this and was WRONG; the API does not exist.
 * Unpacked and checked, rather than assumed:
 *
 *   @capacitor/inappbrowser  v4.0.2  — openInWebView / openInSystemBrowser /
 *                                      openInExternalBrowser / close / 3 listeners.
 *                                      NO script injection of any kind.
 *   @capgo/inappbrowser      v13.0.0 — open / openWebView / setUrl / close / listeners.
 *                                      NO executeScript, no preShowScript.
 *   cordova-plugin-inappbrowser v7.0.0 — HAS `executeScript({code}, cb)`. Capacitor still
 *                                      supports Cordova plugins, so this is the shortest
 *                                      real path; the alternative is ~150 lines of Swift +
 *                                      Kotlin wrapping WKWebView.evaluateJavaScript and
 *                                      WebView.evaluateJavascript in our own plugin.
 *
 * `@capacitor/browser`, which the app uses today, is SFSafariViewController on iOS and
 * Custom Tabs on Android. Those are separate processes by design and can never be
 * injected into. That is the whole reason mobile re-cart is manual — not an oversight.
 *
 * ## THE UNRESOLVED PROBLEM — settle this BEFORE writing any native code
 *
 * Injection and the user's SESSION are, on both platforms, mutually exclusive:
 *
 *   iOS      SFSafariViewController shares Safari's cookies — and cannot be injected.
 *            WKWebView can be injected — and has its own isolated WKWebsiteDataStore.
 *   Android  Custom Tabs share Chrome's cookies — and cannot be injected.
 *            WebView can be injected — and has its own CookieManager.
 *
 * So the very property that makes injection possible is the property that loses the RC
 * login. The desktop extension does not have this problem because it runs inside the
 * user's real browser, in their real session — which is exactly why it works.
 *
 * The precart POSTs with the user's `ssoAccessToken` from RC's localStorage. In a fresh,
 * isolated webview there is no token, because there is no session. Injecting into it would
 * find nothing and cart nothing.
 *
 * The only way through is a one-time sign-in to RC INSIDE our webview, whose data store
 * then persists for later claims. That has two costs worth weighing before building
 * anything: a setup step users must complete before their first hold (and will not have
 * completed on the morning it first matters), and asking someone to type a password into a
 * webview inside a third-party app — which is the shape of a phishing flow and draws
 * scrutiny in App Review even when the page is genuinely reservecalifornia.com.
 *
 * ...AND THE ANSWER IS PROBABLY "SIGN IN INSIDE THE WEBVIEW, AS STEP ONE OF THE CLAIM".
 * The objection above treats the sign-in as an extra cost. It is not: the user must be
 * signed in to RC to check out AT ALL, and today's manual flow already requires it. So the
 * question was never whether they sign in, only WHERE the session lives. Put it in our
 * webview and the isolated data store stops being a problem and becomes the point — it
 * persists, so it is once, not once per claim.
 *
 * ## What the research settled (2026-08-09), and what it did not
 *
 * **App Review.** The risk is smaller than "password in a webview" sounds. Guideline 4.8
 * (Login Services) governs third-party login TO YOUR APP — the user is not signing into
 * CampHawk, so it does not apply. 4.2 (minimum functionality) is the usual webview-wrapper
 * hazard and this app already cleared it. The real hazard is different and is GOOGLE's,
 * not Apple's: Google has blocked its OAuth endpoint in embedded webviews since 2021, so
 * if RC offers "Sign in with Google" that path dies with `disallowed_useragent` inside any
 * WKWebView. **Check whether RC offers social login before building.** The username/
 * password Okta form is unaffected.
 *
 * **Cordova plugins under Capacitor 8.** Supported — Capacitor 9 makes Cordova optional
 * rather than removing it, and the compatibility breakage reported against 8 is
 * SPM-specific. This build uses CocoaPods (forced, see docs/PLAY-STORE.md §0a), which is
 * the unaffected path. `cordova-plugin-inappbrowser` is alive: published 2026-06-22. Note
 * its `cordovaDependencies` gates 8.0.0 behind `cordova: >100`, the standard "not yet"
 * marker, so 7.0.0 is what resolves. Still needs a real Codemagic build to confirm.
 *
 * **Does RC's Okta accept a WKWebView?** Untestable from a sandbox, but the evidence leans
 * FAVOURABLE, and more so than the pessimism above implied:
 *   - RC's edge does not gate on user agent: `signin.reservecalifornia.com` answers an
 *     identical 302 to Safari, to a bare WKWebView UA, and to ours.
 *   - Our own logs are the best evidence we have. The bot's Okta login fails HEADLESS and
 *     works HEADFUL, every time (rc-probe.mjs). A WKWebView is real WebKit with a real
 *     compositor — much closer to headful than to headless.
 *   - A reCAPTCHA appearing is survivable here, unlike for the bot: a human is holding the
 *     phone and can solve it. The challenge only ever blocked us because nobody was there.
 *
 * **THE USER-AGENT WORRY — CHECKED, AND IT DOES NOT APPLY HERE.** I flagged that
 * `appendUserAgent: 'CampHawkApp'` would announce us to Okta, the way `CampsiteFinder/1.0`
 * did to rec.gov. Right principle, wrong target: Capacitor applies that string in
 * `Bridge.java`, to the BRIDGE's WebView. A Cordova InAppBrowser creates its own WebView,
 * which gets the platform default — our marker never reaches RC.
 *
 * So the first build deliberately does NOT override the UA. The default Android WebView
 * string does contain `; wv`, which identifies it as a webview and which RC could gate on
 * — but that is the experiment. Overriding it at the same time would change two variables
 * at once and make a failure unattributable, and a hardcoded Chrome version is its own
 * fingerprint the moment it goes stale. If RC refuses the webview, the follow-up is one
 * line: `cordova.preferences.OverrideUserAgent` in capacitor.config.ts, which the plugin
 * reads (InAppBrowser.java does `settings.setUserAgentString`).
 *
 * ## The rule that keeps this shippable
 *
 * The web layer deploys continuously to apps that are ALREADY INSTALLED. A binary built
 * before the native plugin exists must not break when this code calls it, so every
 * capability is feature-detected at runtime and falls back. Never `import` a native plugin
 * at module scope here.
 */

// The one definition of "is this token evidence of a usable session?", shared with the
// claim gate. NOT a native plugin, so a module-scope import is fine here.
import { rcCloseAction, isMidSignIn } from '@/lib/rc-token-liveness';

export interface RcHandoff {
  /** The RC page to land on — the loop, never the park or the cart. See lib/booking-url. */
  url: string;
  /** Unit id, arrival and nights, for the extension's autofill fragment. */
  unitId?: string | null;
  arrivalDate?: string;
  nights?: number | null;
}

/**
 * One thing the injected script (or the host) has to say about what happened.
 *
 * `n` is the page's own counter, from 1, so a gap identifies a DROPPED report rather than a
 * step that never ran — the distinction that "did the cart fire?" keeps turning on. Host-
 * side events (`loaderror`, `closed`) carry `n: 0` because the page cannot witness them.
 *
 * `detail` is deliberately loose: this is a diagnostic, and the day RC changes something
 * the useful field will be one nobody predicted. Never carries a token, a cart key, or a
 * URL query string — the last because Okta's callback query is an OAuth authorization code.
 * See lib/rc-precart-script.
 */
export type RcReport = { n: number; stage: string; detail: Record<string, unknown> | null };

/**
 * The `#camphawk-rc=` fragment the desktop extension reads.
 *
 * Inert everywhere else — a phone, a desktop without the extension, and RC itself all
 * ignore it — so it is always safe to carry. Trailing underscore is deliberate: the
 * fourth field is `sleepingUnitId`, which we do not have and the extension defaults.
 */
export function rcFragment(h: RcHandoff): string {
  if (!h.unitId) return '';
  return `#camphawk-rc=${h.unitId}_${h.arrivalDate}_${h.nights ?? 1}_`;
}

/** The full destination: the loop page plus the fragment, with no double `#`. */
export function rcHandoffUrl(h: RcHandoff): string {
  return `${h.url.split('#')[0]}${rcFragment(h)}`;
}

/**
 * Running inside the CampHawk native shell?
 *
 * ASKS CAPACITOR FIRST, falls back to the UA marker. `lib/native/context` uses the UA
 * because it must answer during SSR and hydration, where `window.Capacitor` does not yet
 * exist — a good reason there, and the wrong basis here. This runs on a tap, long after
 * the bridge has booted, and `Capacitor.isNativePlatform()` is the platform's own answer
 * rather than a string we hope survived.
 *
 * That distinction is not theoretical: on 2026-08-09 this returned false inside the app on
 * an emulator, sending the hand-off to the external browser and reporting "not running
 * inside the app, or no plugin" — a message that named two causes because I could not tell
 * them apart. Asking the bridge removes the guess.
 */
function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return true;
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('CampHawkApp');
}

/**
 * What this runtime actually has — for the admin test, and for any future "why did it do
 * that?".
 *
 * Every field is a fact, not a conclusion. The first version of the test button reported
 * "not running inside the app, OR no plugin", which is two causes with two different fixes
 * wearing one sentence — the same defect as `OK on attempt 2` not saying what failed, and
 * as "missing or unparseable" for a service account that was present.
 */
export async function rcHandoffDiagnostics(): Promise<Record<string, string>> {
  if (typeof window === 'undefined') return { runtime: 'server' };
  const w = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: object };
    cordova?: { InAppBrowser?: { open?: unknown }; require?: (id: string) => unknown };
  };

  // WHICH BINARY IS THIS? The single most decisive fact and the one I kept guessing at.
  // The plugin only exists in builds made after 2026-08-09, so "is InAppBrowser missing
  // because the build predates it, or because it failed to install?" is answered by the
  // build number and by nothing else. @capacitor/app is already a dependency.
  let build = 'unknown';
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    build = `${info.version} (${info.build})`;
  } catch {
    build = 'unavailable (not native, or plugin missing)';
  }

  // Cordova applies a plugin's `clobbers` during its own bootstrap, so probing the global
  // can be a timing answer rather than an installation one. `cordova.require` asks the
  // module loader directly, which does not depend on when we looked.
  // NOT named `module`: assigning that identifier can shadow the CommonJS wrapper, which
  // Next flags as an error. This is only a diagnostic string.
  let pluginModule = 'not checked';
  try {
    pluginModule = w.cordova?.require ? (w.cordova.require('cordova-plugin-inappbrowser.inappbrowser') ? 'loadable' : 'MISSING') : 'no cordova.require';
  } catch (e) {
    pluginModule = `MISSING (${String((e as Error).message).slice(0, 60)})`;
  }

  return {
    appBuild: build,
    nativeShell: String(isNativeShell()),
    capacitor: w.Capacitor ? 'present' : 'ABSENT',
    platform: w.Capacitor?.getPlatform?.() ?? 'unknown',
    capPlugins: w.Capacitor?.Plugins ? Object.keys(w.Capacitor.Plugins).join(', ') || '(none)' : 'ABSENT',
    cordova: w.cordova ? 'present' : 'ABSENT',
    inAppBrowser: w.cordova?.InAppBrowser?.open ? 'present' : 'ABSENT',
    iabModule: pluginModule,
    ua: navigator.userAgent.slice(0, 110),
  };
}

/**
 * Can this BINARY inject into an in-app webview?
 *
 * Always false today — no injecting plugin is installed. It is written as a probe rather
 * than a constant so that the day one is added, this returns true on the new binary and
 * stays false on every older one still in the wild, with no web-side release needed to
 * tell them apart.
 */
/**
 * How the ReserveCalifornia window is presented — and why each flag is here.
 *
 * `_blank` (passed separately) is the Cordova in-app webview, NOT a new tab.
 *
 * **`location=yes` STAYS, permanently.** The user is about to authenticate and pay on
 * reservecalifornia.com, and hiding the address bar while they do that is precisely the
 * pattern a phishing page uses. They must be able to see whose site this is.
 *
 * `hardwareback=no` so Android's back button walks RC's history instead of closing the
 * webview on the first press — the same default that would have exited the whole app
 * before NativeBridge intercepted it.
 *
 * `toolbarposition=top` — the bar was at the bottom, where it sat ON TOP of the page's own
 * content and rendered as a truncated URL between two dead arrows. RC's booking pages put
 * their controls at the bottom, so the two fought.
 *
 * **`presentationstyle=fullscreen` is owner note 5**, reported from two real iOS hand-offs:
 * "seeing the page behind the webview at the top looks choppy". That is the plugin's iOS
 * default, `pagesheet` — a card presentation that deliberately leaves the presenting screen
 * visible above it. Two pages layered at the top of a phone, one of them ours and one of
 * them RC's, at the moment somebody is deciding whether to trust this with a campsite. It
 * also stops a swipe-down dismissing the window, which on the cart path would kill the
 * webview mid-POST. Android ignores the flag; its InAppBrowser is already full-height.
 *
 * The toolbar colours are the app's own (`--color-ch-green-deep` on `--color-ch-paper`),
 * so the seam that remains reads as CampHawk chrome around RC's page rather than as an
 * unstyled system bar between two apps. Hex, uppercase, `#RRGGBB` — the plugin parses these
 * itself and silently ignores anything else, which would leave the default grey with no
 * error anywhere.
 */
const IAB_OPTIONS = [
  'location=yes',
  'hardwareback=no',
  'toolbarposition=top',
  'presentationstyle=fullscreen',
  'toolbartranslucent=no',
  'toolbarcolor=#16603B',
  'closebuttoncolor=#FAF7F2',
  'navigationbuttoncolor=#FAF7F2',
  'closebuttoncaption=Done',
].join(',');

/**
 * How long the sign-in window may sit on Okta's callback after a live token before we close
 * it anyway. See the deferred close in `open` — this bounds "wait for RC to finish", so a
 * callback that never resolves cannot strand the user on a page with no way back.
 *
 * Ten seconds: RC's own bootstrap off the callback is a redirect and an API call or two, so
 * a healthy one is far inside this and closes on `settled` long before the timer. It is a
 * backstop for the pathological case, not a delay anybody should normally experience — and
 * it is only ever reached on a sign-in that already succeeded, never on the cart path, where
 * `closeOnToken` is false.
 */
const SIGN_IN_SETTLE_MS = 10_000;

/**
 * How long the webview may sit with NO `loadstop` at all before we take it down ourselves.
 *
 * ## WHY THIS EXISTS (2026-09-01)
 *
 * Reported repeatedly, and finally pinned down: RC's app regularly fails to render — its own
 * "We're having trouble loading the application" screen, or nothing at all. On 2026-08-31 it
 * took **three attempts and ~5 minutes**; the same happened mid-test on 08-30. Until now
 * NOTHING in this file guarded that case:
 *
 *   - `loaderror` was reported and otherwise IGNORED — no retry, no close, no message.
 *   - the only timer was `SIGN_IN_SETTLE_MS`, which arms only AFTER a live token, so a page
 *     that never loads never arms anything.
 *   - there is no `loadstart` listener, so "never started" and "started and hung" were the
 *     same silence.
 *
 * So the user was left on a dead window whose Done button did not respond, and **force-quit
 * was the only way out.**
 *
 * ## WHAT THIS DOES AND DOES NOT BUY — read this before trusting it
 *
 * The timer runs in the MAIN app's JS context, not in the InAppBrowser. That is deliberate:
 * a wedged webview cannot run its own watchdog, which is the same reason `worker/claim.ts`
 * and the keep-warm's own watchdog live outside the loop they guard.
 *
 * **It cannot save a fully wedged app.** Owner report, 2026-09-01: when it sticks, the RC page
 * will not scroll AND the native Done button does not respond — so the renderer and the app's
 * UI are both gone, and a `setTimeout` in the main webview will not fire either. That case is
 * memory (see CLAUDE.md on RC's Okta navigations allocating 2.3-9.4 GB) and it needs a
 * different answer.
 *
 * **What it does buy** is every case short of that: a slow load, a `loaderror`, RC's own
 * trouble-loading screen, a network stall. Those are the common ones, they currently end in a
 * force-quit as well, and after this they end in a message and a closed window. And it makes
 * the event LEAVE A RECORD, which the fatal case never has — the page cannot report on a
 * renderer that is gone, so today these freezes are invisible in `client_reports`.
 *
 * 20s: RC's healthy first paint is a couple of seconds. A load still unfinished at 20s is not
 * going to be useful at 08:00, where the whole cart window is seconds wide. Long enough not to
 * cut off a slow connection, short enough that nobody sits there wondering.
 */
const LOAD_WATCHDOG_MS = 20_000;

async function injectableWebView(): Promise<null | {
  open: (
    url: string, code: string, onReport?: (r: RcReport) => void, closeOnToken?: boolean,
    afterLoad?: (url: string) => string | null,
  ) => Promise<void>;
}> {
  if (!isNativeShell()) return null;
  const w = window as unknown as {
    cordova?: { InAppBrowser?: { open: (url: string, target: string, opts: string) => unknown } };
  };
  const iab = w.cordova?.InAppBrowser;
  if (!iab) return null;
  return {
    async open(
      url: string, code: string, onReport?: (r: RcReport) => void, closeOnToken = false,
      afterLoad?: (url: string) => string | null,
    ) {
      const ref = iab.open(url, '_blank', IAB_OPTIONS) as {
        addEventListener: (e: string, cb: (ev?: unknown) => void) => void;
        executeScript: (d: { code: string }, cb?: (r: unknown) => void) => void;
        close?: () => void;
      };
      // WHERE THE WEBVIEW IS, so `closeOnToken` can ask whether RC has FINISHED with the
      // token as well as whether the token is real. See isMidSignIn for the trace that
      // made this necessary. Seeded with the URL we opened, so the already-signed-in path
      // — no Okta, no callback — has a definite answer from the first message onward and
      // never waits. Only a NON-EMPTY loadstop URL replaces it: the plugin can report an
      // empty one, and an empty string would throw away the last thing we did know.
      let lastUrl = url;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      let closedAlready = false;
      // HAS THIS WEBVIEW EVER RENDERED ANYTHING? The load watchdog and the `loaderror` arm
      // both turn on this one fact, and they need opposite things from it: the watchdog only
      // guards the FIRST load, and `loaderror` only acts BEFORE one. See each for why.
      let everLoaded = false;
      // ONE closer, so every path clears the timer and every path names its reason. Three
      // reasons, and they are the whole diagnostic: `token` is the ordinary already-signed-in
      // close, `settled` is RC leaving the callback under its own steam (the fix working),
      // and `timeout` is RC never leaving it. A hand-off that still fails will say which of
      // the three it took, which is what tells the next reader whether this was the right
      // half of the problem.
      const closeOnce = (reason: 'token' | 'settled' | 'timeout' | 'never-loaded' | 'load-error') => {
        if (closedAlready) return;
        closedAlready = true;
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        onReport?.({ n: 0, stage: 'close', detail: { reason } });
        try { ref.close?.(); } catch { /* the user can close it themselves */ }
      };
      // THE LOAD WATCHDOG. Armed at open, disarmed by the FIRST loadstop.
      //
      // FIRST LOAD ONLY, and that bound is the whole design. Re-arming on every loadstop
      // would make this "no navigation for 20s", which is what a user READING the page looks
      // like — it would close the window under somebody halfway through checking their dates.
      // A mid-flow hang is a different fault and this is not the instrument for it.
      let loadTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        loadTimer = null;
        if (everLoaded || closedAlready) return;
        closeOnce('never-loaded');
      }, LOAD_WATCHDOG_MS);
      const disarmLoadTimer = () => {
        if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
      };
      // THE REPORT CHANNEL, wired BEFORE the first injection — the plugin fires `message`
      // for anything the page posts through `cordova_iab`, and the injected reporter's very
      // first act is to announce itself. Registering after `loadstop` would miss it.
      if (onReport) {
        ref.addEventListener('message', (ev) => {
          const data = (ev as { data?: Record<string, unknown> } | undefined)?.data;
          if (!data || data.camphawk !== 'rc-precart') return;
          const r = data as unknown as RcReport;
          onReport(r);
          // CLOSE ONCE WE HAVE WHAT WE CAME FOR — sign-in only.
          //
          // The caller's screen is UNDERNEATH this webview, so a user who was already signed
          // in got a token captured instantly, the gate flipped, and they saw none of it:
          // they were left sitting on RC's home page with nothing telling them to go back.
          // Observed 2026-08-12 on the first real run. The state changed correctly and the
          // interface never said so, which is indistinguishable from it not working.
          //
          // NEVER on the cart path. There `closeOnToken` is false, because the token is the
          // MIDDLE of that job — closing on it would kill the webview before the two cart
          // POSTs it exists to make.
          //
          // PRESENCE IS NOT LIVENESS. This tested `captured` alone until 2026-08-24, so a
          // STALE token — the ordinary state here, since it comes from the SERVER and no
          // local clear reaches it — closed the sign-in window in under a second and read
          // as "auto login worked". The credentials were never typed, and the site was
          // then handed over against no session at all. The gate next door had learned
          // this on 08-21 (#152) and this sibling had not. `mayCloseOnToken` is the one
          // definition both now share, so this window closes exactly when the gate would
          // flip to `verified` — never on `expired`, which is what has to stay open so the
          // sign-in can run, and never on `unknown`.
          //
          // AND NOT WHILE RC IS STILL FINISHING (2026-08-31). A live token is necessary and
          // was never sufficient: on the `/login/callback` page RC's SPA is still completing
          // the OAuth exchange, and closing there left a session that authenticated its own
          // API calls while rendering SIGNED OUT — no name in the header, and a cart the
          // owner was told was theirs and could not open. `isMidSignIn` carries the trace
          // and the hand-bisect that established it.
          const action = rcCloseAction({
            closeOnToken, stage: r.stage, detail: r.detail,
            currentUrl: lastUrl, timerArmed: settleTimer !== null,
          });
          if (action === 'close') {
            closeOnce('token');
          } else if (action === 'arm' && !closedAlready) {
            // THE TIMEOUT IS NOT OPTIONAL. "Wait for RC to leave the callback" with no bound
            // is the 2026-08-12 stranded-when-it-worked bug by another door: if RC never
            // leaves, the window never closes and the user is left on a page with nothing
            // telling them to go back. Bounded, the worst case is a slow close.
            settleTimer = setTimeout(() => {
              settleTimer = null;
              closeOnce('timeout');
            }, SIGN_IN_SETTLE_MS);
          }
        });
        // Host-side facts the page cannot report about itself. `n: 0` marks them as ours;
        // the page's own reports are numbered from 1, so a gap means a dropped message
        // rather than a step that never ran.
        ref.addEventListener('loaderror', (ev) => {
          const e = ev as { message?: string; code?: number } | undefined;
          onReport({ n: 0, stage: 'loaderror', detail: { message: e?.message ?? '', code: e?.code ?? null } });
          // ACT ON IT — until 2026-09-01 this was recorded and otherwise ignored, so a
          // webview that failed outright sat there until the user force-quit the app.
          //
          // ONLY BEFORE A SUCCESSFUL LOAD. After one, the page is up and doing its job, and a
          // later `loaderror` may be a sub-resource — an image, a font, one analytics beacon
          // RC's own page failed to fetch. Closing a working hand-off over a missing icon at
          // 08:00 would be far worse than the fault this arm exists for.
          if (!everLoaded && !closedAlready) {
            disarmLoadTimer();
            closeOnce('load-error');
          }
        });
        // A USER-DRIVEN CLOSE ENDS THE DEFERRAL TOO. Without this a pending timer fires on a
        // webview that is already gone — calling `close()` on a dead ref and, worse, emitting
        // a `close` report claiming a reason that never happened.
        ref.addEventListener('exit', () => {
          closedAlready = true;
          if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
          disarmLoadTimer();
          onReport({ n: 0, stage: 'closed', detail: null });
        });
      }
      // `loadstop`, not `loadstart` — RC is a SPA and its token only exists once the app
      // has booted and made its first API call. Injecting earlier reads an empty
      // localStorage and reports "not signed in" for a session that is fine, which is the
      // same mistake `attemptLogin` made on the bot side (2026-08-09).
      //
      // Fires again on every navigation, which is intended: RC's adopt path reloads, and a
      // re-injected reporter re-announces without re-installing (see the route).
      ref.addEventListener('loadstop', (ev?: unknown) => {
        ref.executeScript({ code });
        // WHICH PAGE THIS IS. The plugin puts it on the event; both platforms send it. It is
        // handed to `afterLoad` because a sign-in walks across several pages and the caller
        // has to be able to tell them apart — see the note below.
        // RC RENDERED SOMETHING. Recorded before anything else on this path: the injection
        // below can throw on a sick page, and a `catch` that skipped this would leave the
        // watchdog armed and close a webview that had in fact come up.
        everLoaded = true;
        disarmLoadTimer();
        const at = String((ev as { url?: string } | undefined)?.url ?? '');
        if (at) lastUrl = at;
        // RC HAS LEFT THE SIGN-IN FLOW — this is the signal the deferred close waits for, and
        // it is RC's own rather than a guess at how long its bootstrap takes.
        if (settleTimer && at && !isMidSignIn(at)) closeOnce('settled');
        // A SECOND, ONE-OFF INJECTION — this is where a credential goes, and the reason it is
        // separate from `code`.
        //
        // `code` is the bundle `/api/rc-precart` serves, byte-identical for every user and
        // cached. A password can never be part of it. This callback is evaluated per
        // injection instead, so the secret exists only in the string handed to this one
        // `executeScript` and nowhere else — not on our servers, not in the served script,
        // not in any log.
        //
        // AFTER `code`, always: the bundle is what defines `window.__chRcLogin`, and calling
        // it first would be a silent no-op — `executeScript` returns nothing useful, so a
        // reversed order would look exactly like a login that ran and did nothing.
        //
        // Re-evaluated on EVERY `loadstop`, which is intended. RC's sign-in walks through
        // Okta and back, and the caller decides on each pass whether there is still anything
        // to do; returning null is how it says no.
        //
        // THE URL IS PASSED BECAUSE "EVERY LOADSTOP" AND "EVERY PAGE" ARE NOT THE SAME THING.
        // A caller holding a credential must not resubmit it on a repeat load of the page it
        // just submitted on — Okta locks accounts — but it MUST get a turn on the next page,
        // because the sign-in control navigates to `signin.reservecalifornia.com` and takes
        // the whole JS context with it. Without this the injected sign-in ran on the park
        // page, clicked through to Okta, and was never invoked again on the form; the caller
        // had no way to tell those two cases apart, so it had to pick one and be wrong.
        if (afterLoad) {
          const once = afterLoad(at);
          if (once) ref.executeScript({ code: once });
        }
      });
    },
  };
}

/**
 * Send the user to RC to finish the booking.
 *
 * Returns how it was handled, so a caller can tell the user what to expect — "we're
 * carting it for you" and "find the site and tap book" are different instructions and
 * showing the wrong one is worse than showing neither.
 */
export async function openRcHandoff(
  h: RcHandoff,
  opts?: {
    onReport?: (r: RcReport) => void;
    closeOnToken?: boolean;
    /**
     * Extra source to run after the served bundle, re-asked on every navigation.
     *
     * A FUNCTION, not a string, so a credential is never held for the life of the handoff —
     * the caller can hand one over on the pass that needs it and `null` on every other.
     * Ignored entirely without an injectable webview, which is correct: there is no
     * injection there, so a caller must never assume its login ran.
     *
     * Receives the URL that just finished loading, so a caller can act once per PAGE rather
     * than once per hand-off or once per load. See the call site for why nothing weaker works.
     */
    afterLoad?: (url: string) => string | null;
  },
): Promise<'injected' | 'in-app' | 'browser'> {
  const url = rcHandoffUrl(h);

  const injectable = await injectableWebView().catch(() => null);
  if (injectable) {
    // The injected code is the extension's, verbatim — see rcInjectedPrecart. Two
    // implementations of a precart is how they drift, and RC has already changed this
    // payload once (the `extraValues` requirement, 2026-08-06).
    const code = await rcInjectedPrecart();
    if (code) {
      await injectable.open(url, code, opts?.onReport, opts?.closeOnToken === true, opts?.afterLoad);
      return 'injected';
    }
  }

  // NO INJECTION AVAILABLE. Inside the app this is the system browser — a real browser,
  // with the user's own RC cookies and session, which is what makes booking possible at
  // all. It just cannot be automated.
  if (isNativeShell()) {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return 'in-app';
    } catch {
      window.location.href = url;
      return 'browser';
    }
  }

  // Desktop/web: same tab. The extension, if installed, picks up the fragment on arrival.
  window.location.href = url;
  return 'browser';
}

/**
 * The precart script to inject, or null if we cannot serve one.
 *
 * SERVED, NOT COPIED. `/api/rc-precart` hands back the bytes of `extension/content-rc.js`
 * — 332 lines of hard-won behaviour (RC's two-step load-then-submit, the `extraValues`
 * contract it answers 200-but-IsSuccess:false without, unit defaults from a live capture).
 * A second implementation for the phone would be two versions of one wire contract, which
 * this codebase has a rule against; see `rc-cart.mjs`.
 *
 * Returning null on any doubt is deliberate: `openRcHandoff` only reports 'injected' when
 * this returns code, so a failure degrades to the manual flow instead of promising a cart
 * that never happens.
 */
async function rcInjectedPrecart(): Promise<string | null> {
  try {
    // `default`, NOT `force-cache`. force-cache serves a cached response even when STALE,
    // which silently defeats the route's short max-age — the one property that makes a
    // broken precart a push to master rather than an app release. Within the 5-minute
    // window this is still a cache hit with no network, so 08:00:00 pays nothing for it.
    const res = await fetch('/api/rc-precart', { cache: 'default' });
    if (!res.ok) return null;
    const code = await res.text();
    // A truncated or error-page body would inject nothing and report success, and the
    // claim screen would tell the user we were carting for them. Cheap sanity check on
    // the one string that must be there.
    return code.includes('precartdataforbookingmodify') ? code : null;
  } catch {
    return null;
  }
}
