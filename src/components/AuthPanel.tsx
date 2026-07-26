'use client';

import { SignIn, SignUp } from '@clerk/nextjs';
import { useIsNativeApp } from '@/lib/native/context';

// Renders the Clerk sign-in / sign-up widget, hiding third-party social buttons when
// running inside the native app. Social OAuth (Google) can't complete in an embedded
// webview, and offering it would trigger Apple's Sign in with Apple requirement — so the
// app is email/password only while the web keeps every method. The hide is CSS-driven
// (see .native-hide-social in globals.css), applied only when useIsNativeApp() is true.
// The class toggles on the client after hydration; web users are never native, so
// nothing flips for them.
export default function AuthPanel({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const isNativeApp = useIsNativeApp();
  return (
    <div className={isNativeApp ? 'native-hide-social' : undefined}>
      {mode === 'sign-in' ? <SignIn /> : <SignUp />}
    </div>
  );
}
