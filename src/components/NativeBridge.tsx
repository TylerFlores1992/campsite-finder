'use client';

import { useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';

// App-side push bridge for the Capacitor native shell. This is a NO-OP on the web
// (Capacitor.getPlatform() === 'web'): every native import is dynamic and guarded, so
// nothing ships to or runs in the browser bundle. On iOS/Android it:
//   1. requests notification permission and registers with APNs/FCM,
//   2. POSTs the device token to /api/user/push-token (the webview already carries the
//      Clerk session cookie, so the call is authenticated with no token plumbing),
//   3. deep-links the webview when the user taps a delivered notification.
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

      const { PushNotifications } = await import('@capacitor/push-notifications');
      const { App } = await import('@capacitor/app');

      // Register the token only for a signed-in user — an anonymous device has no
      // account to attach to. Re-runs on sign-in via the effect dependency.
      if (isSignedIn) {
        const perm = await PushNotifications.checkPermissions();
        let granted = perm.receive === 'granted';
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
          granted = (await PushNotifications.requestPermissions()).receive === 'granted';
        }
        if (granted) await PushNotifications.register();
      }

      // FCM/APNs handed us a token → send it to the backend to store.
      const regHandle = await PushNotifications.addListener('registration', async (token) => {
        try {
          await fetch('/api/user/push-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token.value, platform }),
          });
        } catch (err) {
          console.error('[native] push-token register failed', err);
        }
      });
      cleanups.push(() => regHandle.remove());

      const errHandle = await PushNotifications.addListener('registrationError', (err) => {
        console.error('[native] push registration error', err);
      });
      cleanups.push(() => errHandle.remove());

      // Tapped a delivered notification → deep-link the webview. The `data` bag is set
      // by dispatchPush in src/lib/notifications/index.ts.
      const tapHandle = await PushNotifications.addListener(
        'pushNotificationActionPerformed',
        (action) => {
          const data = action.notification.data as Record<string, string> | undefined;
          const campgroundId = data?.campgroundId;
          if (campgroundId) {
            // Relative path keeps navigation inside the webview (the live site).
            window.location.assign(`/campground/${campgroundId}`);
          }
        }
      );
      cleanups.push(() => tapHandle.remove());

      // Keep the reference used so the import isn't tree-shaken; App is also where a
      // future appUrlOpen (universal-link) handler would attach.
      void App;

      if (disposed) cleanups.forEach((fn) => fn());
    })().catch((err) => console.error('[native] bridge init failed', err));

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, [isSignedIn]);

  return null;
}
