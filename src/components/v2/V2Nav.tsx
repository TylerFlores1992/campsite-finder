"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, CreditCard, PlusCircle, Search } from "lucide-react";
import { useUser, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { useIsNativeApp } from "@/lib/native/context";
import { buttonClasses } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import BrandMark from "./BrandMark";

/**
 * Navigation for the redesign's three destinations, plus the account area.
 *
 * Desktop gets a top row; phones get a bottom tab bar, because the top of a
 * phone is the hardest place to reach and these are the app's primary moves.
 *
 * The three labels never shared a line on a phone header — that's what the
 * bottom bar solves. The header keeps only the brand and the account control,
 * both of which fit at any width, and the tab labels are single words so they
 * can't wrap at 320px either.
 *
 * Campground detail is deliberately not a fourth item: it's a drill-in with a
 * back link, and promoting it would imply you can browse to "a campground" with
 * nothing chosen.
 */
const LINKS = [
  { href: "/v2/watches", label: "Watches", short: "Watches", Icon: Bell },
  { href: "/v2/new", label: "New watch", short: "New", Icon: PlusCircle },
  { href: "/v2", label: "Available now", short: "Search", Icon: Search },
] as const;

async function openBillingPortal() {
  try {
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  } catch {
    /* the menu item just does nothing rather than throwing at the user */
  }
}

export default function V2Nav() {
  const pathname = usePathname();
  const isNative = useIsNativeApp();
  // useUser + conditional render is the codebase convention; this Clerk version
  // exports no <SignedIn>/<SignedOut>.
  const { isLoaded, isSignedIn } = useUser();
  const isActive = (href: string) =>
    href === "/v2" ? pathname === "/v2" : pathname.startsWith(href);

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-ch-line bg-ch-card/95 backdrop-blur">
        <div
          className="mx-auto flex max-w-[var(--ch-max)] items-center gap-4 px-4 sm:gap-6 sm:px-5"
          // Clears the notch in the native webview under Android 15+ edge-to-edge.
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <Link
            href="/v2"
            className="flex shrink-0 items-center gap-2 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <BrandMark size={26} />
            <span className="font-ch-display text-[18px] font-extrabold whitespace-nowrap tracking-[-.025em] sm:text-[19px]">
              CampHawk
            </span>
          </Link>

          {/* Desktop nav. Hidden on phones, where the bottom bar takes over. */}
          <nav aria-label="Main" className="hidden flex-1 gap-1 sm:flex">
            {LINKS.map(({ href, label }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "rounded-[9px] px-3 py-2 text-[13.5px] font-bold whitespace-nowrap transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
                    "motion-reduce:transition-none",
                    active
                      ? "bg-ch-green-soft text-ch-green-deep"
                      : "text-ch-muted hover:bg-ch-green-soft hover:text-ch-ink-2",
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </nav>

          {/* Account. Pushed right on phones, where there's no nav between. */}
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
            {!isLoaded ? (
              // Reserve the space so the header doesn't jump once auth resolves.
              <span aria-hidden="true" className="size-8" />
            ) : isSignedIn ? (
              <UserButton appearance={{ elements: { avatarBox: "w-8 h-8" } }}>
                {/* The ONLY route a subscriber has to the Stripe billing portal —
                    i.e. the only way to cancel or update payment. Hidden in the
                    native app, where surfacing billing would breach the store
                    rules that keep Stripe on the web. */}
                {!isNative && (
                  <UserButton.MenuItems>
                    <UserButton.Action
                      label="Manage subscription"
                      labelIcon={<CreditCard size={14} />}
                      onClick={openBillingPortal}
                    />
                  </UserButton.MenuItems>
                )}
              </UserButton>
            ) : (
              <>
                {/* Phones get ONE control. Two auth buttons plus the wordmark
                    don't share a 320px line, and the brand is not the thing that
                    should give way — sign-up is one tap from the sign-in page and
                    is also the guest banner's CTA. */}
                <SignInButton mode="redirect">
                  <button className="cursor-pointer rounded-[9px] px-2.5 py-2 text-[13px] font-bold whitespace-nowrap text-ch-ink-2 hover:bg-ch-green-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green">
                    Sign in
                  </button>
                </SignInButton>
                {/* Wrapped rather than adding `hidden` to the button: the button
                    already carries `inline-flex`, and two display utilities on one
                    element are resolved by Tailwind's source order, not by the
                    order they're written in — so `hidden` silently lost. */}
                <span className="hidden sm:contents">
                  <SignUpButton mode="redirect">
                    <button className={buttonClasses({ size: "sm", className: "whitespace-nowrap" })}>
                      Sign up
                    </button>
                  </SignUpButton>
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Phone tab bar. Fixed to the bottom, above the home indicator. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-ch-line bg-ch-card/98 backdrop-blur sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex">
          {LINKS.map(({ href, label, short, Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex flex-1 flex-col items-center gap-0.5 px-1 pt-2 pb-1.5",
                  "text-[11px] font-bold whitespace-nowrap transition-colors motion-reduce:transition-none",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green",
                  active ? "text-ch-green" : "text-ch-muted",
                )}
              >
                <Icon aria-hidden="true" className="size-5" strokeWidth={active ? 2.4 : 2} />
                {short}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
