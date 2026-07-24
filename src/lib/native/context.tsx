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
