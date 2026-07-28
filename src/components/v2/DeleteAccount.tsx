"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import Button from "@/components/ui/Button";
import { useSubscription } from "./useSubscription";

/**
 * "Delete account", on /settings.
 *
 * Exists because the App Store requires it (Apple 5.1.1(v): an app offering
 * account creation must offer in-app deletion), but the copy is written for the
 * person pressing it, not for the reviewer.
 *
 * THE RULE FOR THIS SCREEN: say what happens BEFORE it happens, including the
 * part the user won't like. Deleting cancels the subscription immediately and the
 * rest of the paid period is not refunded — burying that would be the kind of
 * surprise that produces a chargeback and a one-star review, and it is exactly
 * what a reviewer looks for.
 *
 * Two steps on purpose. Not a typed confirmation, which reads as hostile for
 * something Apple wants to be genuinely reachable, but not a single tap either:
 * this destroys every watch the user has set up.
 */
export default function DeleteAccount() {
  const { signOut } = useClerk();
  const { subscribed } = useSubscription();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/user/delete", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // The route is careful to say what state things are actually in — pass
        // its words through rather than replacing them with a generic failure.
        setError(body.error ?? "We couldn't delete your account. Nothing was changed.");
        setDeleting(false);
        return;
      }
      // The Clerk user is gone, so the session is already void. Sign out to clear
      // it locally and land somewhere that renders signed-out.
      await signOut({ redirectUrl: "/" });
    } catch {
      setError("We couldn't reach the server, so nothing was deleted. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <>
      <p className="text-ch-body text-ch-ink-2">
        Deleting your account removes your watches, alert history and saved campgrounds
        permanently. This can&apos;t be undone.
      </p>
      <p className="mt-1.5 text-ch-body text-ch-ink-2">
        {subscribed ? (
          <>
            <strong>Your subscription is cancelled immediately.</strong> You won&apos;t be charged
            again, and the remainder of the period you&apos;ve already paid for is not refunded.
          </>
        ) : (
          <>
            If you have a subscription, it is <strong>cancelled immediately</strong> — you
            won&apos;t be charged again, and the remainder of the period you&apos;ve already paid
            for is not refunded.
          </>
        )}
      </p>

      {!confirming ? (
        <Button variant="warn" className="mt-3" onClick={() => setConfirming(true)}>
          Delete account
        </Button>
      ) : (
        <div className="mt-3 rounded-ch-card border border-ch-alert/40 bg-ch-alert/5 p-3.5">
          <p className="text-ch-body font-bold">Delete your account?</p>
          <p className="mt-1 text-ch-fine leading-normal text-ch-ink-2">
            Everything above happens as soon as you press the button, and we can&apos;t bring any
            of it back.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="warn" disabled={deleting} onClick={() => void remove()}>
              {deleting ? "Deleting…" : "Yes, delete my account"}
            </Button>
            <Button variant="quiet" disabled={deleting} onClick={() => setConfirming(false)}>
              Keep my account
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2.5 text-ch-fine leading-normal text-ch-alert">
          {error}
        </p>
      )}
    </>
  );
}
