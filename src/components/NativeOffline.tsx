'use client';

import { useEffect, useState } from 'react';
import { useIsNativeApp } from '@/lib/native/context';

/**
 * Offline banner for the native shell.
 *
 * WHY THIS EXISTS. The app is a webview pointed at production (`server.url`), so
 * there is no bundled copy of the site to fall back on: lose the connection and the
 * next navigation hands the user a raw platform error page — Chrome's dinosaur, or
 * a white screen with a WebKit error string. That page has our name nowhere on it,
 * and it looks exactly like the app crashed. For an alerts product, "the app is
 * broken" is a much more expensive impression than "you're offline".
 *
 * It's a BANNER, not a takeover. Whatever the user was already looking at is still
 * on screen and still useful — a campground they'd opened, the watches list they'd
 * loaded — and blanking that out to announce the network would destroy the one thing
 * that still works. It only tells them why the next tap won't do anything.
 *
 * NATIVE ONLY. On the web the browser has its own, better-understood offline
 * affordances and its own chrome to show them in.
 *
 * `navigator.onLine` is famously weak — it reports the link, not reachability, so it
 * can say "online" on a captive portal. That's fine here: this is an explanation, not
 * a gate. Nothing is blocked on it, so a false positive costs a banner that shouldn't
 * be there, not a broken app.
 */
export default function NativeOffline() {
  const isNative = useIsNativeApp();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!isNative) return;
    // Read once on mount rather than in useState's initialiser: the server has no
    // navigator, and seeding state from it would mismatch on hydration.
    setOffline(typeof navigator !== 'undefined' && navigator.onLine === false);

    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [isNative]);

  if (!isNative || !offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Pinned to the BOTTOM, clear of the home indicator. The top is taken by the
      // sticky nav and the status bar; overlaying it would cover the tabs, and
      // inserting the banner above it would reflow the whole page every time a
      // tunnel drops the signal. `inset-x-4` rather than a full-width bar so it
      // reads as a transient notice, not a piece of chrome.
      className="fixed inset-x-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-50 rounded-ch-card border border-ch-line bg-ch-ink px-4 py-3 text-center shadow-ch-card"
    >
      <p className="text-ch-body font-bold text-white">You&apos;re offline</p>
      <p className="mt-0.5 text-ch-fine leading-normal text-white/75">
        CampHawk needs a connection to check availability. We&apos;re still watching your
        campgrounds — alerts will arrive as soon as you&apos;re back.
      </p>
    </div>
  );
}
