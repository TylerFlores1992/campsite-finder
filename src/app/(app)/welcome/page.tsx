import type { Metadata } from "next";
import { Suspense } from "react";
import Welcome from "@/components/v2/Welcome";

export const metadata: Metadata = {
  title: "Welcome — CampHawk",
  // Post-signup, per-account, and reachable only with a session. Nothing to index.
  robots: { index: false, follow: false },
};

/**
 * Where Clerk lands a brand-new account (see `AuthPanel`'s sign-up redirect), and
 * where Stripe returns after checkout. The work is all client-side — it reads the
 * account's own state — so the page is just the frame.
 *
 * Suspense because `Welcome` reads searchParams (`?next=`, `?subscribed=1`) via
 * `useSearchParams`, which opts the subtree into client rendering and needs a
 * boundary or the build errors.
 */
export default function WelcomePage() {
  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-8">
      <Suspense
        fallback={
          <div className="mx-auto h-64 max-w-[46rem] animate-pulse rounded-ch-card bg-ch-shell motion-reduce:animate-none" />
        }
      >
        <Welcome />
      </Suspense>
    </div>
  );
}
