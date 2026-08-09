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

export interface RcHandoff {
  /** The RC page to land on — the loop, never the park or the cart. See lib/booking-url. */
  url: string;
  /** Unit id, arrival and nights, for the extension's autofill fragment. */
  unitId?: string | null;
  arrivalDate?: string;
  nights?: number | null;
}

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
  let module = 'not checked';
  try {
    module = w.cordova?.require ? (w.cordova.require('cordova-plugin-inappbrowser.inappbrowser') ? 'loadable' : 'MISSING') : 'no cordova.require';
  } catch (e) {
    module = `MISSING (${String((e as Error).message).slice(0, 60)})`;
  }

  return {
    appBuild: build,
    nativeShell: String(isNativeShell()),
    capacitor: w.Capacitor ? 'present' : 'ABSENT',
    platform: w.Capacitor?.getPlatform?.() ?? 'unknown',
    capPlugins: w.Capacitor?.Plugins ? Object.keys(w.Capacitor.Plugins).join(', ') || '(none)' : 'ABSENT',
    cordova: w.cordova ? 'present' : 'ABSENT',
    inAppBrowser: w.cordova?.InAppBrowser?.open ? 'present' : 'ABSENT',
    iabModule: module,
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
async function injectableWebView(): Promise<null | { open: (url: string, code: string) => Promise<void> }> {
  if (!isNativeShell()) return null;
  const w = window as unknown as {
    cordova?: { InAppBrowser?: { open: (url: string, target: string, opts: string) => unknown } };
  };
  const iab = w.cordova?.InAppBrowser;
  if (!iab) return null;
  return {
    async open(url: string, code: string) {
      // `_blank` is the Cordova in-app webview (NOT a new tab). `location=yes` keeps the
      // URL bar visible, which matters here: the user is about to authenticate and pay on
      // reservecalifornia.com, and hiding the address bar while they do that is exactly
      // the pattern a phishing page uses. They should be able to see whose site it is.
      // `hardwareback=no` so Android's back button walks the RC history instead of
      // closing the webview on the first press — the same default that would have exited
      // the whole app before NativeBridge intercepted it.
      const ref = iab.open(url, '_blank', 'location=yes,hardwareback=no') as {
        addEventListener: (e: string, cb: () => void) => void;
        executeScript: (d: { code: string }, cb?: (r: unknown) => void) => void;
      };
      // `loadstop`, not `loadstart` — RC is a SPA and its token only exists once the app
      // has booted and made its first API call. Injecting earlier reads an empty
      // localStorage and reports "not signed in" for a session that is fine, which is the
      // same mistake `attemptLogin` made on the bot side (2026-08-09).
      ref.addEventListener('loadstop', () => ref.executeScript({ code }));
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
export async function openRcHandoff(h: RcHandoff): Promise<'injected' | 'in-app' | 'browser'> {
  const url = rcHandoffUrl(h);

  const injectable = await injectableWebView().catch(() => null);
  if (injectable) {
    // The injected code is the extension's, verbatim — see rcInjectedPrecart. Two
    // implementations of a precart is how they drift, and RC has already changed this
    // payload once (the `extraValues` requirement, 2026-08-06).
    const code = await rcInjectedPrecart();
    if (code) {
      await injectable.open(url, code);
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
    const res = await fetch('/api/rc-precart', { cache: 'force-cache' });
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
