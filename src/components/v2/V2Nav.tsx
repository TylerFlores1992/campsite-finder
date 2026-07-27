"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CreditCard,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";
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
 * gets a third of the width and "Explore" fits comfortably, so nothing has
 * to be abbreviated or hidden.
 *
 * Desktop keeps the inline top row; there's ample width and no art to collapse.
 *
 * Campground detail is deliberately not a fourth destination: it's a drill-in
 * with a back link, and promoting it would imply you can browse to "a
 * campground" with nothing chosen.
 */
const LINKS = [
  { href: "/watches", label: "Watches" },
  { href: "/new", label: "New watch" },
  { href: "/search", label: "Explore" },
] as const;

/** Scroll past this and the header art shrinks to its wordmark strip. */
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

/**
 * Whether the signed-in user is an admin, resolved on the SERVER.
 *
 * The nav is a client component, so it cannot import `lib/admin` — that module
 * is `server-only` precisely so the allowlist can't reach the JS bundle, and
 * the tempting shortcut (comparing `user.emailAddresses[0]` to a literal) is
 * the copy-paste bug documented in `lib/admin.ts`. So the boolean is fetched
 * from `/api/admin/status`, which does the real check.
 *
 * Fetched only when signed in (the route is Clerk-protected and 404s otherwise),
 * once per mount, and any failure just leaves the link undrawn — /admin enforces
 * access itself, so a missing link costs an admin one typed URL and a wrongly
 * drawn one grants nothing.
 */
function useIsAdmin(enabled: boolean): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/admin/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setIsAdmin(Boolean(data?.isAdmin));
      })
      .catch(() => {
        /* leave the link undrawn */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return isAdmin;
}

function AccountControl({ compact = false }: { compact?: boolean }) {
  const isNative = useIsNativeApp();
  const router = useRouter();
  // useUser + conditional render is the codebase convention; this Clerk version
  // exports no <SignedIn>/<SignedOut>.
  const { isLoaded, isSignedIn } = useUser();
  const isAdmin = useIsAdmin(Boolean(isLoaded && isSignedIn));

  // Reserve the space so the header doesn't jump once auth resolves.
  if (!isLoaded) return <span aria-hidden="true" className="size-8" />;

  if (isSignedIn) {
    return (
      <>
        {/* Admin sits IN the header, beside the avatar, rather than inside the
            account menu. It's the one destination the owner opens constantly
            and nobody else can see at all, so a click to open a menu first is
            pure friction for the only person who uses it. Icon-only: it's a
            personal shortcut, not something that needs explaining, and a label
            would push the nav around on phones.
            Only drawn for an admin, and only ever a link — /admin 404s for
            anyone else, so this grants nothing. */}
        {isAdmin && (
          <Link
            href="/admin"
            aria-label="Admin dashboard"
            title="Admin"
            className={cx(
              "grid size-8 shrink-0 place-items-center rounded-full transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
              compact
                ? "bg-white/90 text-ch-ink-2 shadow-ch-card backdrop-blur hover:bg-white"
                : "text-ch-muted hover:bg-ch-green-soft hover:text-ch-green-deep",
            )}
          >
            <ShieldCheck aria-hidden="true" className="size-4" />
          </Link>
        )}
        <UserButton appearance={{ elements: { avatarBox: "w-8 h-8" } }}>
          <UserButton.MenuItems>
            {/* Settings lives here rather than as a fourth tab: it's visited once
              at setup and rarely after, and the account menu is where people
              already look for it. */}
            <UserButton.Action
              label="Alerts & settings"
              labelIcon={<SettingsIcon size={14} />}
              onClick={() => router.push("/settings")}
            />
            {/* The ONLY route a subscriber has to the Stripe billing portal — i.e.
              the only way to cancel or update payment. Hidden in the native app,
              where surfacing billing would breach the store rules that keep
              Stripe on the web. */}
            {!isNative && (
              <UserButton.Action
                label="Manage subscription"
                labelIcon={<CreditCard size={14} />}
                onClick={openBillingPortal}
              />
            )}
          </UserButton.MenuItems>
        </UserButton>
      </>
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
          <button
            className={buttonClasses({
              size: "sm",
              className: "whitespace-nowrap",
            })}
          >
            Sign up
          </button>
        </SignUpButton>
      </span>
    </>
  );
}

export default function V2Nav() {
  const pathname = usePathname();
  const isNative = useIsNativeApp();
  const [collapsed, setCollapsed] = useState(false);
  const isActive = (href: string) =>
    // /v2 is the marketing home, so it must match exactly — otherwise it would
    // light up as "active" on every page in the subtree.
    href === "/" ? pathname === "/" : pathname.startsWith(href);

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
      {/* ---------------- phone: collapsing art + tab row ----------------
          The band and the tabs pin TOGETHER. Scrolling shrinks the art down to
          the strip carrying the wordmark and tagline rather than hiding it, so
          the brand and the three destinations stay on screen the whole way down
          the page and everything else scrolls under them. */}
      <div className="sticky top-0 z-30 sm:hidden">
        <div
          className="relative overflow-hidden bg-[#24382A] transition-[height] duration-[260ms] ease-out motion-reduce:transition-none"
          style={{
            height: collapsed ? "var(--ch-header-min)" : "var(--ch-header)",
            paddingTop: "env(safe-area-inset-top)",
          }}
        >
          {/* EXPANDED: contain. The artwork carries the wordmark on its left
              edge and the tagline on its right, so any horizontal crop clips one
              — it rendered as "ampHawk" before. Contain letterboxes against the
              same green instead, so the lockup survives every width.

              COLLAPSED: cover, anchored to the BOTTOM. That's the strip the
              wordmark and tagline sit in, so shrinking the band keeps the brand
              on screen instead of leaving a meaningless sliver of sky. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/app-header.jpg"
            alt="CampHawk — find your next adventure"
            className={cx(
              "size-full",
              collapsed
                ? "object-cover object-bottom"
                : "object-contain object-center",
            )}
          />
          <div className="absolute right-3 top-3 flex items-center gap-2">
            <AccountControl compact />
          </div>
        </div>

        <nav
          aria-label="Main"
          className="flex border-b border-ch-line bg-ch-card"
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
                  // ~106px and "Explore" wraps to two lines at 12.5px,
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
          {/* The wordmark is the last route back onto `/`, which is the only page
              carrying Stripe checkout. This header is desktop-only, so in practice
              it's a tablet in the native app — but that's still a tablet showing
              prices. Native goes home to Explore instead, which is where the app
              launches anyway. */}
          <Link
            href={isNative ? "/search" : "/"}
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
