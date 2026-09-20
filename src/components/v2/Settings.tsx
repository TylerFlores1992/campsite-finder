"use client";

import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/Button";
import Button from "@/components/ui/Button";
import { useIsNativeApp } from "@/lib/native/context";
import { useSubscription } from "./useSubscription";
import SmsAlerts from "./SmsAlerts";
import AutoCartSettings from "./AutoCartSettings";
import { SubscribeLink, SubscribeSentence } from "./nativeSubscribe";
import { useManageSubscription } from "./manageSubscription";
import DeleteAccount from "./DeleteAccount";
import SignOutConfirm from "./SignOutConfirm";
import BuildStamp from "./BuildStamp";

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
export default function Settings() {
  const { isLoaded, isSignedIn, user } = useUser();
  const isNative = useIsNativeApp();
  const { subscribed, everSubscribed, loaded: subLoaded, unknown, billing } = useSubscription();
  const manage = useManageSubscription(billing);

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
          <Link href="/sign-in" className={buttonClasses({ fullWidth: true })}>
            Sign in
          </Link>
          <Link href="/search" className={buttonClasses({ variant: "quiet", fullWidth: true })}>
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

      {/* ── MANAGEMENT IS NOT PURCHASE, AND THIS SECTION USED TO CONFLATE THEM ────────
          It was wrapped in `{!isNative && …}` under the comment *"Apple and Google
          require digital subscriptions to go through in-app purchase, so the native app
          never renders a price or a checkout route."* That sentence is TRUE and it is
          about BUYING. Applied to MANAGING it is backwards: both stores expect an
          in-app-purchase subscriber to be able to reach the subscription they bought, and
          the native arm below it offered a paying subscriber one flat sentence and no way
          out at all. Our first production Play subscriber reported exactly that on
          2026-09-19.

          The purchase half is untouched: `SubscribeSentence` / `SubscribeLink` still own
          the non-subscriber arm, still carry no price, and `StorePaywall`, `WatchCta`,
          `NewWatch` and `LINKOUT_BY_STORE` are not involved here at all.

          ROUTED ON THE STORED PROVIDER, NOT ON `isNative`. `useManageSubscription` reads
          `subscriptions.provider`, so a Play subscriber reaches Play whether they opened
          the app or camphawk.app on a laptop, and a web subscriber reaches the Stripe
          portal from inside the app. The device answers a question nobody asked. */}
      <Section title="Subscription">
        {!subLoaded ? (
          <p className="text-ch-body text-ch-muted">Checking your subscription…</p>
        ) : subscribed || unknown ? (
          /* `unknown` IS GROUPED WITH `subscribed`, DELIBERATELY. A failed lookup must
             never fall through to the "No subscription yet" arm below — that is the rule
             that stops a Clerk blip telling a paying subscriber to subscribe, and the
             destination's own copy says we could not check rather than guessing a store. */
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-ch-body font-bold">
                {unknown ? "Your subscription" : "Your subscription is active"}
              </p>
              <p className="mt-0.5 max-w-[52ch] text-ch-fine leading-normal text-ch-muted">
                {subscribed
                  ? `Watching, alerts and auto-cart are all switched on. ${manage.destination.detail}`
                  : manage.destination.detail}
              </p>
            </div>
            <Button variant="quiet" size="sm" onClick={manage.open}>
              {manage.destination.label}
            </Button>
          </div>
        ) : isNative ? (
          <>
            <p className="text-ch-body text-ch-muted"><SubscribeSentence /></p>
            {/* Never offered to someone already paying — a "Subscribe" prompt on a
                live subscription reads as a billing failure. */}
            <SubscribeLink className="mt-2 text-ch-body text-ch-green" />
          </>
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
            <Link href="/" className={buttonClasses({ size: "sm" })}>
              {everSubscribed ? "Resubscribe" : "Start free trial"}
            </Link>
          </div>
        )}
      </Section>

      <Section title="Account">
        <p className="text-ch-body text-ch-ink-2">{email ?? "Signed in"}</p>
        <p className="mt-1 text-ch-fine text-ch-muted">
          Your email address, password and sign-in methods live in your account menu, in the top
          right of the page.
        </p>
      </Section>

      {/* Sign out sits ABOVE "Delete account" deliberately: they are the two ways
          to leave, and the reversible one should be the one you meet first. */}
      <Section title="Sign out">
        <SignOutConfirm />
      </Section>

      {/* Its own section, at the bottom, with a plain title. Apple 5.1.1(v) wants
          deletion genuinely reachable from inside the app, and a reviewer should
          not have to hunt for it — so it is not tucked inside "Account" above. */}
      <Section title="Delete account">
        <DeleteAccount />
      </Section>
      {/* The admin link used to live here. It moved into the account menu
          (V2Nav) — it's an account-level destination, not a setting. */}

      {/* Native only, and it renders nothing on the web. Answers "am I testing the new
          build or the old one?" without leaving the app for TestFlight. */}
      <BuildStamp />
    </div>
  );
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
