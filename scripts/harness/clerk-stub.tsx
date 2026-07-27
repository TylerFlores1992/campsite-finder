/**
 * @clerk/nextjs stub for the screenshot harness.
 *
 * Components render outside ClerkProvider here, where the real hooks throw.
 * Defaults to SIGNED OUT because that's the state with extra UI to inspect —
 * guest banners, account walls — and a signed-in shot is the subset.
 */
import type { ReactNode } from "react";

export function useAuth() {
  return { isLoaded: true, isSignedIn: false, userId: null, signOut: async () => {} };
}
export function useUser() {
  return { isLoaded: true, isSignedIn: false, user: null };
}
export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function SignedIn() {
  return null;
}
export function SignedOut({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function UserButton() {
  return null;
}
