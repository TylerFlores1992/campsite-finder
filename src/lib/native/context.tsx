'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';

// Whether the app is running inside the CampHawk native shell (Capacitor webview),
// detected from the User-Agent marker (`appendUserAgent: 'CampHawkApp'` in
// capacitor.config.ts).
//
// Detected CLIENT-SIDE, on purpose. An earlier version read the request User-Agent in
// the root layout (`await headers()`), but that opts the whole tree into dynamic
// rendering, which under this Next build's Cache Components model throws at request
// time in the root layout (no Suspense boundary) — it 500'd every page in production.
// Client detection keeps the root layout static. The tradeoff (a first-render flash of
// pricing UI before the effect resolves) only exists INSIDE the native app, and only
// there — web users are never native, so `isNativeApp` is false on both server and
// client and nothing flips. When the native app ships, if the flash matters, gate the
// pricing components on a mounted+native check rather than reintroducing a dynamic root
// layout.
const NativeAppContext = createContext<boolean>(false);

// The UA never changes after load, so the store never emits — subscribe is a no-op.
const noopSubscribe = () => () => {};
const getNativeSnapshot = () =>
  typeof navigator !== 'undefined' && navigator.userAgent.includes('CampHawkApp');
const getServerSnapshot = () => false;

export function NativeAppProvider({ children }: { children: React.ReactNode }) {
  // useSyncExternalStore reads the value SSR-safely (false on the server + during
  // hydration, then the real UA check on the client) without a setState-in-effect.
  const isNativeApp = useSyncExternalStore(noopSubscribe, getNativeSnapshot, getServerSnapshot);
  return <NativeAppContext.Provider value={isNativeApp}>{children}</NativeAppContext.Provider>;
}

/** True when rendered inside the native app — gate out Stripe/pricing UI on this. */
export function useIsNativeApp(): boolean {
  return useContext(NativeAppContext);
}

/**
 * WHICH STORE DID THIS INSTALL COME FROM? `null` outside the native app, and `null`
 * for a shell we cannot identify.
 *
 * ── WHY THIS EXISTS, AND WHAT IT IS *NOT* (2026-08-19) ─────────────────────────────
 * Apple rejected 1.0 (5) under guideline 3.1.1 and named the remedy in its own letter:
 * *"Apps on the United States storefront may link out to the default browser … for
 * payment mechanisms other than in-app purchase."* Turning that on is one flag — but
 * the flag is WEB-side, and the two native apps do not have the same availability. iOS
 * is United States only; the Android closed test is deliberately WORLDWIDE, because the
 * paid tester service requires it. One boolean would therefore fix Apple by showing
 * steering UI to non-US Play testers, which is the review failure the precondition in
 * `nativeSubscribe.tsx` exists to prevent.
 *
 * **This is a STORE check, not a COUNTRY check, and the distinction is load-bearing.**
 * A CampHawk iOS build can only have come from the App Store and an Android one only
 * from Play, so the device OS identifies the store exactly. It says nothing whatever
 * about the storefront COUNTRY — that is handled the only way it safely can be, by App
 * Store Connect availability being restricted to the US, so every iOS install is a US
 * storefront by construction. Device locale would NOT do that job: a US-storefront user
 * abroad still counts as US, and vice versa.
 *
 * An unrecognised UA returns `null` and is treated as not allowed, which is the safe
 * direction — a store we cannot name is a store whose rules we do not know.
 */
export type NativePlatform = 'ios' | 'android' | null;

const getPlatformSnapshot = (): NativePlatform => {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (!ua.includes('CampHawkApp')) return null;
  // Android first: an Android UA also contains "Linux", and some webviews carry
  // "Mac OS X" tokens, so the specific test has to win.
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return null;
};
const getPlatformServerSnapshot = (): NativePlatform => null;

/**
 * Read the store this install came from. Same `useSyncExternalStore` shape as
 * `useIsNativeApp` and for the same reason: reading the UA in the root layout via
 * `headers()` opts the whole tree into dynamic rendering and 500'd every page in
 * production on 2026-07-24. No provider, because the value never changes after load.
 */
export function useNativePlatform(): NativePlatform {
  return useSyncExternalStore(noopSubscribe, getPlatformSnapshot, getPlatformServerSnapshot);
}
