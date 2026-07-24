'use client';

import { createContext, useContext } from 'react';

// Whether the app is running inside the CampHawk native shell (Capacitor webview),
// detected from the User-Agent marker (`appendUserAgent: 'CampHawkApp'` in
// capacitor.config.ts). The value is resolved on the SERVER in the root layout (from
// the request User-Agent header) and provided here, so the very first render already
// has the correct value — no flash of in-app pricing UI before a client effect runs,
// which matters because that UI must never appear in the store build (IAP rules).
const NativeAppContext = createContext<boolean>(false);

export function NativeAppProvider({
  isNativeApp,
  children,
}: {
  isNativeApp: boolean;
  children: React.ReactNode;
}) {
  return <NativeAppContext.Provider value={isNativeApp}>{children}</NativeAppContext.Provider>;
}

/** True when rendered inside the native app — gate out Stripe/pricing UI on this. */
export function useIsNativeApp(): boolean {
  return useContext(NativeAppContext);
}

/** Server-side check: does a request User-Agent belong to the native shell? */
export function isNativeUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && userAgent.includes('CampHawkApp');
}
