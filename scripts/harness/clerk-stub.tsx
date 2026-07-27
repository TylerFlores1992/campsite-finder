/**
 * @clerk/nextjs stub for the screenshot harness.
 *
 * Components render outside ClerkProvider here, where the real hooks throw.
 * Defaults to SIGNED OUT because that's the state with extra UI to inspect —
 * guest banners, account walls — and a signed-in shot is the subset. Set
 * `window.__CH_SIGNED_IN = true` in a preset entry to flip it, which is what
 * signed-in-only UI (favourite hearts) needs to render at all.
 */
import type { ReactNode } from "react";

function signedIn(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as Record<string, unknown>).__CH_SIGNED_IN);
}

export function useAuth() {
  const on = signedIn();
  return { isLoaded: true, isSignedIn: on, userId: on ? "user_demo" : null, signOut: async () => {} };
}
export function useUser() {
  const on = signedIn();
  return { isLoaded: true, isSignedIn: on, user: on ? { id: "user_demo" } : null };
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
export function UserButton({ children }: { children?: ReactNode }) {
  return <span data-clerk-userbutton>{children}</span>;
}
UserButton.MenuItems = function MenuItems({ children }: { children?: ReactNode }) {
  return <>{children}</>;
};
UserButton.Action = function Action(_: { label?: string; labelIcon?: ReactNode; onClick?: () => void }) {
  return null;
};
export function SignInButton({ children }: { children?: ReactNode; mode?: string }) {
  return <>{children}</>;
}
export function SignUpButton({ children }: { children?: ReactNode; mode?: string }) {
  return <>{children}</>;
}
