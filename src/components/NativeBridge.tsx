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

      // Register the token only for a signed-in user — an anonymous device has no
      // account to attach to. Re-runs on sign-in via the effect dependency.
      if (isSignedIn) {
        const perm = await FirebaseMessaging.checkPermissions();
        let granted = perm.receive === 'granted';
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
          granted = (await FirebaseMessaging.requestPermissions()).receive === 'granted';
        }
        if (granted) {
          try {
            const { token } = await FirebaseMessaging.getToken();
            if (token) await saveToken(token);
          } catch (err) {
            console.error('[native] getToken failed', err);
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
