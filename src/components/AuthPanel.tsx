'use client';

import { SignIn, SignUp } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';
import { useIsNativeApp } from '@/lib/native/context';

// Renders the Clerk sign-in / sign-up widget, hiding third-party social buttons when
// running inside the native app. Social OAuth (Google) can't complete in an embedded
// webview, and offering it would trigger Apple's Sign in with Apple requirement — so the
// app is email/password only while the web keeps every method. The hide is CSS-driven
// (see .native-hide-social in globals.css), applied only when useIsNativeApp() is true.
// The class toggles on the client after hydration; web users are never native, so
// nothing flips for them.
//
// A NEW ACCOUNT GOES TO /welcome, NOT straight back to wherever it came from
// (2026-08-01). Clerk's widget takes no custom fields, so the phone number and the
// alert opt-ins are collected on the step immediately after — see
// components/v2/Welcome.tsx. The original destination rides along as `?next=`,
// because `forceRedirectUrl` overrides Clerk's own `redirect_url` handling and would
// otherwise strand someone who was halfway through setting up a watch. SIGN-IN is
// untouched: an existing account has already answered these questions.
export default function AuthPanel({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const isNativeApp = useIsNativeApp();
  const params = useSearchParams();

  const back = params.get('redirect_url');
  const afterSignUp = back ? `/welcome?next=${encodeURIComponent(back)}` : '/welcome';

  return (
    <div className={isNativeApp ? 'native-hide-social' : undefined}>
      {mode === 'sign-in' ? <SignIn /> : <SignUp forceRedirectUrl={afterSignUp} />}
    </div>
  );
}
