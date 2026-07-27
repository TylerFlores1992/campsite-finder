'use client';

import { useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';

// App-side push bridge for the Capacitor native shell. NO-OP on the web
// (Capacitor.getPlatform() === 'web'): every native import is dynamic and guarded, so
// nothing ships to or runs in the browser bundle. On iOS/Android it:
//   1. requests notification permission and retrieves the device's FCM token,
//   2. POSTs that token to /api/user/push-token (the webview already carries the Clerk
//      session cookie, so the call is authenticated with no token plumbing),
//   3. deep-links the webview when the user taps a delivered notification.
//
// Uses @capacitor-firebase/messaging so BOTH platforms hand us a real *FCM registration
// token* — the backend (src/lib/notifications/push.ts) delivers via FCM HTTP v1 for both,
// with FCM relaying to APNs for iOS. (The previous @capacitor/push-notifications returned
// a raw APNs token on iOS, which FCM can't address — that's why iOS push never worked.)
// Firebase is auto-initialized by @capacitor-firebase/app once the platform config files
// are bundled (GoogleService-Info.plist on iOS, google-services.json on Android).
//
// Mounted once in the root layout. See capacitor.config.ts + docs/SETUP.md.
export default function NativeBridge() {
  const { isSignedIn } = useAuth();

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      const { Capacitor } = await import('@capacitor/core');
      const platform = Capacitor.getPlatform();
      if (platform !== 'ios' && platform !== 'android') return; // web: no-op

      const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');

      // Keep the webview out from under the status bar / notch, so the site header
      // (Sign in / Sign up) isn't rendered in the non-tappable status-bar strip. Also
      // set at launch via capacitor.config.ts; this reinforces it at runtime. Guarded —
      // setBackgroundColor is Android-only and throws on iOS.
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        await StatusBar.setOverlaysWebView({ overlay: false });
        await StatusBar.setStyle({ style: Style.Dark });
        if (platform === 'android') await StatusBar.setBackgroundColor({ color: '#faf7f2' });
      } catch (err) {
        console.warn('[native] status bar config failed', err);
      }

      // Send an FCM token to the backend to store against the signed-in user.
      const saveToken = async (token: string) => {
        try {
          await fetch('/api/user/push-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, platform }),
          });
        } catch (err) {
          console.error('[native] push-token register failed', err);
        }
      };

      // Token refresh (FCM rotates tokens): re-store whenever a new one is issued.
      const tokenHandle = await FirebaseMessaging.addListener('tokenReceived', (event) => {
        if (event.token) void saveToken(event.token);
      });
      cleanups.push(() => tokenHandle.remove());

      // Tapped a delivered notification → deep-link the webview. The `data` bag is set
      // by dispatchPush in src/lib/notifications/index.ts.
      const tapHandle = await FirebaseMessaging.addListener(
        'notificationActionPerformed',
        (event) => {
          const data = event.notification.data as Record<string, string> | undefined;
          const campgroundId = data?.campgroundId;
          if (campgroundId) {
            // Relative path keeps navigation inside the webview (the live site).
            window.location.assign(`/campground/${campgroundId}`);
          }
        }
      );
      cleanups.push(() => tapHandle.remove());

      // ---------------------------------------------------------- back button
      //
      // ANDROID ONLY — iOS has no hardware back. Without a listener, Capacitor's
      // default is to EXIT THE APP on any back press, from any screen. In a webview
      // app that reads as a crash: a user two taps deep into a campground presses
      // back expecting the search they came from and the app disappears. It's the
      // most common complaint about shells like this one, and it would land in the
      // first week of Play reviews.
      //
      // `canGoBack` comes from Capacitor's own webview history, which is what we
      // want — it's true for in-app navigation and false on a cold start.
      if (platform === 'android') {
        const { App } = await import('@capacitor/app');
        const backHandle = await App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) {
            window.history.back();
            return;
          }
          // Nowhere to go back TO. If they're somewhere other than the app's home,
          // send them home rather than closing — reaching a dead end shouldn't cost
          // them the session. Only a back press ON home exits, which is the
          // behaviour Android users expect.
          if (window.location.pathname !== '/search') {
            window.location.assign('/search');
            return;
          }
          void App.exitApp();
        });
        cleanups.push(() => backHandle.remove());
      }

      // ------------------------------------------------------- external links
      //
      // Booking links (recreation.gov, ReserveCalifornia, …) and anything else
      // off-origin must leave the webview. Two reasons, and the second is the one
      // that fails review:
      //
      //   1. A booking flow opened INSIDE the shell traps the user — our chrome is
      //      gone, the provider's site has no way back to us, and on Android the
      //      back button is the only escape. The whole point of an alert is that
      //      they finish the booking, so this is the conversion path.
      //   2. A checkout or account URL rendered inside the app looks like in-app
      //      purchasing to a reviewer. Handing it to the system browser makes it
      //      unambiguously the user's browser, not our app.
      //
      // Capacitor's `allowNavigation` already limits which hosts the webview will
      // load, but that produces a blocked navigation, not a good one. This turns it
      // into an intentional handoff.
      //
      // Delegated from the document so it covers links rendered at any time,
      // including ones React hasn't mounted yet. Capture phase, so it runs before
      // anything that might stop propagation.
      const { Browser } = await import('@capacitor/browser');
      const onClick = (e: MouseEvent) => {
        // Let modified clicks and non-primary buttons alone — they have their own
        // platform meaning, and overriding them is how you break long-press.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const anchor = (e.target as HTMLElement | null)?.closest?.('a');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href) return;

        let url: URL;
        try {
          url = new URL(href, window.location.href);
        } catch {
          return; // mailto:, tel:, a malformed href — leave it to the platform
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        // Same origin stays in the webview — that's the app. Clerk's hosted pages
        // are a different host but ARE part of signing in, so they stay too
        // (they're in allowNavigation for exactly that reason); sending auth to the
        // system browser would strand the session outside the app.
        // Same origin stays in the webview — but a target="_blank" one has to be
        // taken over. A webview has no tabs, so `_blank` opens an empty popup or
        // silently does nothing; the Terms and Privacy links in the SMS consent
        // block are both written that way, and they're consent copy the user has to
        // be able to actually read. Navigate in place and let the back button
        // (above) return them.
        if (url.hostname === window.location.hostname) {
          if (anchor.getAttribute('target') === '_blank') {
            e.preventDefault();
            window.location.assign(url.href);
          }
          return;
        }
        if (url.hostname.endsWith('camphawk.app') || url.hostname.endsWith('clerk.accounts.dev')) {
          return;
        }

        e.preventDefault();
        void Browser.open({ url: url.href }).catch((err) => {
          console.error('[native] external open failed', err);
          // Falling back to a normal navigation is better than a dead tap — the
          // worst case is the old in-webview behaviour, which is where we started.
          window.location.assign(url.href);
        });
      };
      document.addEventListener('click', onClick, true);
      cleanups.push(() => document.removeEventListener('click', onClick, true));

      // Register the token only for a signed-in user — an anonymous device has no
      // account to attach to. Re-runs on sign-in via the effect dependency.
      if (isSignedIn) {
        const registerToken = async () => {
          try {
            const { token } = await FirebaseMessaging.getToken();
            if (token) await saveToken(token);
          } catch (err) {
            console.error('[native] getToken failed', err);
          }
        };

        const perm = await FirebaseMessaging.checkPermissions();

        if (perm.receive === 'granted') {
          await registerToken();
        } else if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
          // ------------------------------------------------ WHEN we ask matters
          //
          // This used to prompt on the first signed-in load. That's the worst
          // possible moment: the user has just arrived, has no watches, and has no
          // idea what we'd notify them about — so the honest answer to "CampHawk
          // would like to send you notifications" is no. On iOS that answer is
          // effectively PERMANENT (the system dialog is one-shot; afterwards it's
          // a trip to Settings), and push is the product. A denied prompt costs us
          // the alert channel for the life of the install.
          //
          // So we ask at the moment the value is self-evident: the user has a
          // watch, and a notification is the thing that watch exists to deliver.
          const ask = async () => {
            const res = await FirebaseMessaging.requestPermissions();
            if (res.receive === 'granted') await registerToken();
          };

          // The moment of maximum context: they just created one. NewWatch fires
          // this after a successful save.
          const onWatchCreated = () => void ask();
          window.addEventListener('camphawk:watch-created', onWatchCreated);
          cleanups.push(() =>
            window.removeEventListener('camphawk:watch-created', onWatchCreated)
          );

          // And for someone who already had watches before this shipped, or who
          // created one on the web: ask on load, because the context is just as
          // real — they're waiting on an alert right now. Gated on actually having
          // one, so a browsing visitor is never prompted.
          //
          // This fetch runs at most once per install: after either answer the
          // permission is no longer 'prompt' and this branch is never reached again.
          try {
            const res = await fetch('/api/watches');
            if (res.ok) {
              const data = (await res.json()) as { watches?: unknown[] };
              if (Array.isArray(data.watches) && data.watches.length > 0) await ask();
            }
          } catch {
            /* offline or a hiccup — we'll ask on the next watch they create */
          }
        }
      }

      if (disposed) cleanups.forEach((fn) => fn());
    })().catch((err) => console.error('[native] bridge init failed', err));

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, [isSignedIn]);

  return null;
}
