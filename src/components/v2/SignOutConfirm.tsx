"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import Button from "@/components/ui/Button";

/**
 * "Sign out", on /settings, with a confirmation step.
 *
 * WHY IT EXISTS: raised in the Play closed-test feedback (2026-08-22) — signing
 * out happened immediately, with no chance to change your mind.
 *
 * WHY IT IS HERE AND NOT IN THE ACCOUNT MENU. Clerk's `UserButton` draws its own
 * "Sign out" and the only way to put a confirmation in front of it is to hide the
 * built-in with an `appearance` element key. That key is not present anywhere in
 * the installed `@clerk/*` packages, so it could only be guessed — and a guess
 * that stops matching on a Clerk upgrade fails OPEN: the built-in reappears
 * beside ours and the menu shows Sign out twice. This surface is entirely ours,
 * so nothing can rot silently.
 *
 * THEREFORE THE MENU'S SIGN OUT IS UNCHANGED, and this does not claim otherwise.
 * It adds a confirmed route, it does not gate the existing one.
 *
 * Signing out is not destructive — nothing is lost and signing back in restores
 * everything — so the confirm is deliberately lighter than DeleteAccount's:
 * `quiet` rather than `warn`, and the copy says the watches keep running, which
 * is the thing a user pressing this actually worries about.
 */
export default function SignOutConfirm() {
  const { signOut } = useClerk();
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  return (
    <>
      <p className="text-ch-body text-ch-ink-2">
        Your watches keep running while you&apos;re signed out — alerts still reach you by
        email and text.
      </p>

      {!confirming ? (
        <Button variant="quiet" className="mt-3" onClick={() => setConfirming(true)}>
          Sign out
        </Button>
      ) : (
        <div className="mt-3 rounded-ch-card border border-ch-line bg-ch-shell p-3.5">
          <p className="text-ch-body font-bold">Sign out of CampHawk?</p>
          <p className="mt-1 text-ch-fine leading-normal text-ch-ink-2">
            You&apos;ll need your email and password to get back in. Nothing is deleted.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={leaving}
              onClick={() => {
                setLeaving(true);
                void signOut({ redirectUrl: "/" });
              }}
            >
              {leaving ? "Signing out…" : "Yes, sign me out"}
            </Button>
            <Button variant="quiet" disabled={leaving} onClick={() => setConfirming(false)}>
              Stay signed in
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
