"use client";

import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import Button from "@/components/ui/Button";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";
import SmsAlerts from "./SmsAlerts";
import AutoCartSettings from "./AutoCartSettings";

/**
 * Settings — where alerts get set up.
 *
 * This closes the last real gap before the route swap. A subscriber in the
 * redesign could create a watch but had nowhere to add a phone number, so they
 * got no text alerts — the headline feature they'd just paid for — and nowhere
 * to turn auto-cart on, so the biggest differentiator was reachable only after
 * it had already broken.
 *
 * ORDERED BY WHAT A NEW SUBSCRIBER NEEDS TO DO, not by what's easiest to build:
 * how we reach you first, then auto-cart, then billing, then the account. Every
 * section talks to an endpoint that already existed.
 */
export interface SettingsProps {
  /** Decided on the server — see the note in app/v2/settings/page.tsx. This is
      a boolean, never the allowlist, and it only draws a link: /admin does its
      own server-side check and 404s anyone else. */
  isAdmin?: boolean;
}

export default function Settings({ isAdmin = false }: SettingsProps) {
  const { isLoaded, isSignedIn, user } = useUser();
  const isNative = useIsNativeApp();
  const { subscribed, everSubscribed, loaded: subLoaded, unknown } = useSubscription();

  if (!isLoaded) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-ch-card border border-ch-line bg-ch-card motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }

  // Settings are per-account by definition — there is nothing to configure
  // without one, so this is a wall rather than an empty form.
  if (!isSignedIn) {
    return (
      <div className="mx-auto max-w-[46ch] text-center">
        <h2 className="font-ch-display text-ch-h font-bold">Settings need an account</h2>
        <p className="mt-1.5 text-ch-body text-ch-muted">
          Alerts go to your email, your phone and your devices, so they&apos;re tied to your account.
          Searching stays free either way.
        </p>
        <div className="mt-4 grid gap-2">
          <a href="/sign-in" className={buttonClasses({ fullWidth: true })}>
            Sign in
          </a>
          <Link href="/v2/search" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
            Back to Explore
          </Link>
        </div>
      </div>
    );
  }

  const email = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress;

  return (
    <div className="space-y-3">
      <Section
        title="How we reach you"
        blurb="When a site opens up we send every channel you've turned on, at once. Whichever gets to you first wins."
      >
        <div className="rounded-ch-input border border-ch-line px-3.5 py-3">
          <p className="text-ch-body font-bold">Email — always on</p>
          <p className="mt-0.5 text-ch-fine text-ch-muted">
            {email ? `Going to ${email}.` : "Going to your account email."} Change it from your
            account below.
          </p>
        </div>

        {/* Push is registered by the app itself when notifications are allowed;
            there's no server-side switch to expose, so this states the fact
            rather than offering a toggle that wouldn't do anything. */}
        {isNative && (
          <div className="mt-2 rounded-ch-input border border-ch-line px-3.5 py-3">
            <p className="text-ch-body font-bold">Push notifications</p>
            <p className="mt-0.5 text-ch-fine text-ch-muted">
              Controlled by your phone&apos;s notification settings for CampHawk.
            </p>
          </div>
        )}

        <div className="mt-3">
          <SmsAlerts />
        </div>
      </Section>

      <Section title="Auto-cart">
        <AutoCartSettings />
      </Section>

      {/* Apple and Google require digital subscriptions to go through in-app
          purchase, so the native app never renders a price or a checkout route.
          It points at the web instead. */}
      {!isNative && (
        <Section title="Subscription">
          {!subLoaded || unknown ? (
            <p className="text-ch-body text-ch-muted">
              We couldn&apos;t check your subscription just now.{" "}
              <button
                onClick={() => void openBillingPortal()}
                className="cursor-pointer font-bold text-ch-green underline underline-offset-2 hover:text-ch-green-deep"
              >
                Open the billing portal
              </button>{" "}
              to see where it stands.
            </p>
          ) : subscribed ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-ch-body font-bold">Your subscription is active</p>
                <p className="mt-0.5 text-ch-fine text-ch-muted">
                  Watching, alerts and auto-cart are all switched on.
                </p>
              </div>
              <Button variant="quiet" size="sm" onClick={() => void openBillingPortal()}>
                Manage billing
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-ch-body font-bold">
                  {everSubscribed ? "Your subscription has ended" : "No subscription yet"}
                </p>
                <p className="mt-0.5 max-w-[52ch] text-ch-fine leading-normal text-ch-muted">
                  Searching stays free. Watching a booked campground, text alerts and auto-cart need
                  a subscription.
                </p>
              </div>
              <a href="/" className={buttonClasses({ size: "sm" })}>
                {everSubscribed ? "Resubscribe" : "Start free trial"}
              </a>
            </div>
          )}
        </Section>
      )}

      {isNative && (
        <Section title="Subscription">
          <p className="text-ch-body text-ch-muted">
            Manage your plan at camphawk.app.
          </p>
        </Section>
      )}

      <Section title="Account">
        <p className="text-ch-body text-ch-ink-2">{email ?? "Signed in"}</p>
        <p className="mt-1 text-ch-fine text-ch-muted">
          Your email address, password and sign-in methods live in your account menu, in the top
          right of the page.
        </p>
      </Section>

      {/* Only drawn for an admin, and only ever a link. Nothing here grants
          access — /admin checks the allowlist itself and 404s (not 403s, so the
          page's existence isn't revealed to anyone else). */}
      {isAdmin && (
        <Section title="Admin">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-ch-body font-bold">Ops dashboard</p>
              <p className="mt-0.5 max-w-[52ch] text-ch-fine leading-normal text-ch-muted">
                Users, revenue, worker health, catalog syncs and running costs.
              </p>
            </div>
            <a href="/admin" className={buttonClasses({ variant: "quiet", size: "sm" })}>
              Open admin
            </a>
          </div>
        </Section>
      )}
    </div>
  );
}

async function openBillingPortal() {
  try {
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  } catch {
    /* the control just does nothing rather than throwing at the user */
  }
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <h2 className="font-ch-display text-ch-h font-bold">{title}</h2>
      {blurb && (
        <p className="mt-1 mb-3 max-w-[62ch] text-ch-fine leading-normal text-ch-muted">{blurb}</p>
      )}
      <div className={blurb ? "" : "mt-3"}>{children}</div>
    </section>
  );
}
