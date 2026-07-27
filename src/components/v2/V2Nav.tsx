"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard } from "lucide-react";
import { useUser, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { useIsNativeApp } from "@/lib/native/context";
import { buttonClasses } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import BrandMark from "./BrandMark";

/**
 * Navigation for the redesign's three destinations, plus the account area.
 *
 * PHONES FOLLOW THE MOCKUP: header art that collapses on scroll, then a
 * full-width row of three equal tabs. The earlier build tried to fit the three
 * labels into the header line, which is what broke — as their own row each tab
 * gets a third of the width and "Available now" fits comfortably, so nothing has
 * to be abbreviated or hidden.
 *
 * Desktop keeps the inline top row; there's ample width and no art to collapse.
 *
 * Campground detail is deliberately not a fourth destination: it's a drill-in
 * with a back link, and promoting it would imply you can browse to "a
 * campground" with nothing chosen.
 */
const LINKS = [
  { href: "/v2/watches", label: "Watches" },
  { href: "/v2/new", label: "New watch" },
  { href: "/v2", label: "Available now" },
] as const;

/** Scroll past this and the header art shrinks to a slim strip. */
const COLLAPSE_AT = 28;

async function openBillingPortal() {
  try {
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  } catch {
    /* the menu item just does nothing rather than throwing at the user */
  }
}

function AccountControl({ compact = false }: { compact?: boolean }) {
  const isNative = useIsNativeApp();
  // useUser + conditional render is the codebase convention; this Clerk version
  // exports no <SignedIn>/<SignedOut>.
  const { isLoaded, isSignedIn } = useUser();

  // Reserve the space so the header doesn't jump once auth resolves.
  if (!isLoaded) return <span aria-hidden="true" className="size-8" />;

  if (isSignedIn) {
    return (
      <UserButton appearance={{ elements: { avatarBox: "w-8 h-8" } }}>
        {/* The ONLY route a subscriber has to the Stripe billing portal — i.e.
            the only way to cancel or update payment. Hidden in the native app,
            where surfacing billing would breach the store rules that keep
            Stripe on the web. */}
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
    );
  }

  return (
    <>
      <SignInButton mode="redirect">
        <button
          className={cx(
            "cursor-pointer rounded-[9px] px-2.5 py-1.5 text-[13px] font-bold whitespace-nowrap",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
            compact
              ? "bg-white/90 text-ch-ink-2 shadow-ch-card backdrop-blur hover:bg-white"
              : "text-ch-ink-2 hover:bg-ch-green-soft",
          )}
        >
          Sign in
        </button>
      </SignInButton>
      {/* Wrapped rather than adding `hidden` to the button: the button already
          carries `inline-flex`, and two display utilities on one element resolve
          by Tailwind's source order, not the order written — `hidden` lost. */}
      <span className="hidden sm:contents">
        <SignUpButton mode="redirect">
          <button className={buttonClasses({ size: "sm", className: "whitespace-nowrap" })}>
            Sign up
          </button>
        </SignUpButton>
      </span>
    </>
  );
}

export default function V2Nav() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const isActive = (href: string) =>
    href === "/v2" ? pathname === "/v2" : pathname.startsWith(href);

  // Passive listener + a state change only on the transition, so scrolling
  // doesn't re-render on every frame.
  useEffect(() => {
    const onScroll = () => {
      const past = window.scrollY > COLLAPSE_AT;
      setCollapsed((prev) => (prev === past ? prev : past));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      {/* ---------------- phone: collapsing art + tab row ---------------- */}
      <div className="sm:hidden">
        <div
          className="relative overflow-hidden bg-[#24382A] transition-[height] duration-[260ms] ease-out motion-reduce:transition-none"
          style={{
            height: collapsed ? "var(--ch-header-min)" : "var(--ch-header)",
            paddingTop: "env(safe-area-inset-top)",
          }}
        >
          {/* CONTAIN, not cover, while expanded. The artwork has the wordmark
              baked into its left edge and the tagline into its right, so any
              horizontal crop clips one of them — at 326px it rendered as
              "ampHawk". Contain letterboxes against the same green instead, so
              the lockup survives every width. Collapsed is a 46px sliver where
              no text is expected, so cover is right there. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/app-header.jpg"
            alt=""
            className={cx(
              "size-full",
              collapsed ? "object-cover object-center" : "object-contain object-center",
            )}
          />
          <div className="absolute right-3 top-3 flex items-center gap-2">
            <AccountControl compact />
          </div>
        </div>

        <nav
          aria-label="Main"
          className="sticky top-0 z-20 flex border-b border-ch-line bg-ch-card"
        >
          {LINKS.map(({ href, label }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  // nowrap + a smaller step under 360px: at 320 each tab gets
                  // ~106px and "Available now" wraps to two lines at 12.5px,
                  // which makes the row two rows and undoes the point of it.
                  "flex-1 border-b-[2.5px] px-1 pt-3 pb-2.5 text-center font-bold whitespace-nowrap",
                  "text-[11.5px] min-[360px]:text-[12.5px]",
                  "-mb-px transition-colors motion-reduce:transition-none",
                  "focus-visible:outline-2 focus-visible:-outline-offset-[3px] focus-visible:outline-ch-green",
                  active
                    ? "border-ch-green text-ch-green"
                    : "border-transparent text-ch-muted",
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* ---------------- desktop: inline top row ---------------- */}
      <header className="sticky top-0 z-20 hidden border-b border-ch-line bg-ch-card/95 backdrop-blur sm:block">
        <div className="mx-auto flex max-w-[var(--ch-max)] items-center gap-6 px-5">
          <Link
            href="/v2"
            className="flex shrink-0 items-center gap-2 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <BrandMark size={28} />
            <span className="font-ch-display text-[19px] font-extrabold whitespace-nowrap tracking-[-.025em]">
              CampHawk
            </span>
          </Link>

          <nav aria-label="Main" className="flex flex-1 gap-1">
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

          <div className="flex shrink-0 items-center gap-2">
            <AccountControl />
          </div>
        </div>
      </header>
    </>
  );
}
