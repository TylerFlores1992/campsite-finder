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

/** Running inside the CampHawk native shell? Mirrors lib/native/context's UA marker. */
function isNativeShell(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('CampHawkApp');
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
      const ref = iab.open(url, '_blank', 'location=yes,beforeload=yes') as {
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
 * DELIBERATELY NOT WRITTEN HERE. `extension/content-rc.js` is 332 lines of hard-won
 * behaviour — RC's two-step load-then-submit precart, the `extraValues` contract it
 * returns 200-but-IsSuccess:false without, and unit-specific defaults captured from a real
 * add-to-cart. Re-implementing that from memory for the phone would produce a second
 * version to keep in sync with the first, and the codebase already has a rule about this
 * (see `rc-cart.mjs`, shared so the probe and the runner cannot drift).
 *
 * So the injected code will be SERVED from the one source, not copied. Returning null
 * until that endpoint exists keeps the fallback honest rather than shipping a half-copy
 * that carts nothing and reports success.
 */
async function rcInjectedPrecart(): Promise<string | null> {
  return null;
}
