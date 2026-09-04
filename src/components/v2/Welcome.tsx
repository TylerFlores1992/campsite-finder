"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import Button, { buttonClasses } from "@/components/ui/Button";
import Link from "next/link";
import SmsAlerts from "./SmsAlerts";
import { useSubscription } from "./useSubscription";

/**
 * The welcome step — everything an account needs, asked once, right after it's created.
 *
 * WHY IT IS A STEP AND NOT FIELDS ON THE SIGN-UP FORM. Clerk's `<SignUp />` is a
 * prebuilt widget; it takes no arbitrary fields, so a phone box and two checkboxes
 * cannot be added inside it without abandoning Clerk's hosted flow (and with it the
 * password rules, bot protection and verification we get for free). Clerk redirects
 * here the instant the account exists, so from the user's side it is still "part of
 * signing up" — which was the point: collect it now, not when an alert is already
 * being missed.
 *
 * TEXT ALERTS ARE OPTIONAL AND MUST STAY THAT WAY. This renders the SAME
 * `SmsAlerts` component as `/settings` and the public `/sms-opt-in` page, so the
 * A2P-approved consent script has exactly one source and cannot drift — the rule
 * that file already documents. Consequences that are load-bearing, not stylistic:
 *   - the consent box is UNCHECKED and nothing pre-fills a number,
 *   - saving a number is a separate deliberate action with its own button,
 *   - **Skip / Finish is always available** — no field here gates account creation,
 *     which is what "consent is not a condition of purchase" has to mean in the
 *     flow, not just in the sentence.
 * If this ever becomes required, the A2P campaign description has to change first.
 *
 * The auto-cart block appears only for someone who is actually entitled (the
 * Auto-Cart plan) — which after a normal sign-up means they arrive here again from
 * Stripe's success URL, subscription in hand. Showing "set up auto-cart" to someone
 * who hasn't bought it would be an ad dressed as a setup step.
 */
export default function Welcome() {
  const router = useRouter();
  const params = useSearchParams();
  const { subscribed, autocart, loaded: subLoaded } = useSubscription();

  const [email, setEmail] = useState<string | null>(null);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [autocartConnected, setAutocartConnected] = useState<boolean | null>(null);
  // A 401 from the prefs read means no session — see the signed-out block below.
  const [signedOut, setSignedOut] = useState(false);

  // Where to go when they're done: whatever sent them to sign-up, else the app.
  const next = params.get("next") || "/search";
  const justSubscribed = params.get("subscribed") === "1";

  // WHERE THIS ACCOUNT CAME FROM, stamped once (migration 072). This is the only moment it
  // can be: `document.referrer` lives on the page they LANDED on and is long gone by here,
  // so `AcquisitionCapture` stashed it in a cookie on the first pageview and this hands that
  // cookie to the server. Fire-and-forget on its own effect, never inside the Promise.all
  // below: a diagnostic must not be able to delay — or fail — the screen it observes, and a
  // 401 here (someone opened /welcome with no session) is an ordinary outcome, not an error.
  //
  // WHY HERE AND NOT IN `syncUser`: this runs on every authenticated page load, and a POST
  // per page view to write a column that can only be written once is a cost with no buyer.
  // The gap that leaves is an account that never reaches this screen; the write is idempotent
  // (`WHERE signup_source IS NULL`) precisely so a second caller can be added if that shows up
  // in the readout as a population of NULLs that ought not to be.
  useEffect(() => {
    fetch("/api/user/signup-source", { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/user/alert-prefs").then((r) => {
        if (r.status === 401 || r.status === 403 || r.status === 404) {
          if (!cancelled) setSignedOut(true);
          return null;
        }
        return r.ok ? r.json() : null;
      }),
      fetch("/api/user/autocart").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([prefs, ac]) => {
        if (cancelled) return;
        if (prefs) {
          setEmail(prefs.email ?? null);
          setEmailAlerts(prefs.emailAlerts !== false);
        }
        if (ac) setAutocartConnected(!!ac.connected);
      })
      .catch(() => {
        /* the form still works; save is what matters */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(async () => {
    setSaving(true);
    try {
      await fetch("/api/user/alert-prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailAlerts, onboarded: true }),
      });
    } catch {
      // Never trap someone on this screen because a preference write failed —
      // every choice here is changeable in Settings.
    }
    router.push(next);
  }, [emailAlerts, next, router]);

  if (loading) {
    return <div className="h-64 animate-pulse rounded-ch-card bg-ch-shell motion-reduce:animate-none" />;
  }

  // No session. Reachable two ways: someone opened the URL directly, or Clerk
  // redirected here a beat before the session cookie was readable. Either way a
  // dead end is the wrong answer — offer the way forward rather than a 404.
  if (signedOut) {
    return (
      <div className="mx-auto max-w-[46ch]">
        <h1 className="font-ch-display text-ch-title font-extrabold tracking-[-.03em]">
          Create your account first
        </h1>
        <p className="mt-1.5 text-ch-body text-ch-muted">
          This is the setup step we show once your account exists — alerts, an optional
          phone number, and auto-cart if you have it.
        </p>
        <div className="mt-4 grid gap-2">
          <Link href="/sign-up" className={buttonClasses({ fullWidth: true })}>
            Create an account
          </Link>
          <Link href="/sign-in" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const showAutocart = subLoaded && subscribed && autocart && autocartConnected === false;

  return (
    <div className="mx-auto max-w-[46rem]">
      <h1 className="font-ch-display text-[clamp(24px,4vw,32px)] font-extrabold leading-[1.08] tracking-[-.03em] text-ch-ink">
        {justSubscribed ? "You're subscribed — one last thing" : "You're in. How should we reach you?"}
      </h1>
      <p className="mt-2 max-w-[56ch] text-ch-body leading-relaxed text-ch-ink-2">
        Set this up now and an opening reaches you the moment we find it. You can change
        any of it later in Settings.
      </p>

      {/* ---------------------------------------------------------- email */}
      <section className="mt-5 rounded-ch-card border border-ch-line bg-ch-card p-4">
        <h2 className="font-ch-display text-ch-h font-bold">Email alerts</h2>
        <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-ch-body leading-normal text-ch-ink-2">
          <input
            type="checkbox"
            checked={emailAlerts}
            onChange={(e) => setEmailAlerts(e.target.checked)}
            className="mt-1 accent-[#1E7A4C]"
          />
          <span>
            Email me when a campsite I&apos;m watching opens up
            {email && <span className="block text-ch-fine text-ch-muted">to {email}</span>}
          </span>
        </label>
        {!emailAlerts && (
          <p className="mt-2 text-ch-fine leading-normal text-ch-ochre-ink">
            With email off, add a phone number below or you won&apos;t hear about openings
            at all.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------ sms */}
      <section className="mt-3 rounded-ch-card border border-ch-line bg-ch-card p-4">
        <h2 className="font-ch-display text-ch-h font-bold">Text alerts (optional)</h2>
        <p className="mt-1 max-w-[58ch] text-ch-fine leading-normal text-ch-muted">
          A text is what actually wakes you at 6am. Entirely optional — skip it and
          everything else still works.
        </p>
        {/* The real, A2P-approved form. One source for the consent script. */}
        <div className="mt-2.5">
          <SmsAlerts />
        </div>
      </section>

      {/* ------------------------------------------------------- auto-cart */}
      {showAutocart && (
        <section className="mt-3 rounded-ch-card border-2 border-ch-green bg-white p-4">
          <h2 className="font-ch-display text-ch-h font-bold text-ch-green-deep">
            Set up Auto-Cart
          </h2>
          <p className="mt-1 max-w-[58ch] text-ch-fine leading-normal text-ch-ink-2">
            One sign-in to Recreation.gov and we can put an opening straight into your
            cart, held while you get to your phone. It signs in on a private machine we
            run and saves that login there — encrypted, never on our web servers.
          </p>
          <Link href="/connect" className={buttonClasses({ size: "sm", className: "mt-2.5" })}>
            Sign in to Recreation.gov
          </Link>
        </section>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button disabled={saving} onClick={() => void finish()}>
          {saving && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
          Finish
        </Button>
        {/* Skip must be a real, obvious way out — see the component note. It records
            the same "don't ask again" stamp, so skipping isn't punished by nagging. */}
        <button
          type="button"
          disabled={saving}
          onClick={() => void finish()}
          className="text-ch-body font-bold text-ch-muted underline underline-offset-2 hover:text-ch-ink"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
