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
import { useSubscription } from "./useSubscription";

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
/** Collapse once scrolled past this… */
const COLLAPSE_AT = 96;
/** …and only expand again below this. The gap must exceed the height the band
 *  loses when it collapses (131 - 46 = 85px), or the layout shift that collapsing
 *  causes can itself push scrollY back under the expand threshold — which is the
 *  flutter. See the scroll effect. */
const EXPAND_AT = 8;
/** Matches the CSS height transition below; scroll readings are ignored for this
 *  long after a flip, because mid-animation layout answers nothing. */
const HEADER_ANIM_MS = 260;

/**
 * Open Stripe's billing portal.
 *
 * This used to swallow every failure — "the menu item just does nothing rather than
 * throwing at the user" — which meant a signed-in non-subscriber clicked "Manage
 * subscription" and got silence, because /api/stripe/portal 404s with "No
 * subscription found" when there is no stripe_customer_id. Nothing was broken; the
 * item simply should not have been offered. It is now hidden in that case, and the
 * two remaining failures say something instead of nothing.
 */
async function openBillingPortal(): Promise<void> {
  try {
    const res = await fetch("/api/stripe/portal", { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    // 409: the stored customer is gone (e.g. a test-mode leftover). The route already
    // tells us to send them to re-subscribe, so do that rather than dead-ending.
    if (data.error === "billing_profile_missing") {
      window.location.href = "/?resubscribe=1";
      return;
    }
    window.alert("We couldn't open the billing portal just now. Please try again shortly.");
  } catch {
    window.alert("We couldn't reach billing just now. Please check your connection and try again.");
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
  // Only offer "Manage subscription" when there is a subscription to manage. A
  // non-subscriber's click 404s inside the portal route and used to do nothing at
  // all. `unknown` counts as "show it": a failed status lookup must not hide billing
  // from an actual subscriber — the same rule the watch gate uses in reverse.
  const { subscribed, unknown } = useSubscription();
  const canManageBilling = subscribed || unknown;

  // Reserve the space so the header doesn't jump once auth resolves.
  if (!isLoaded) return <span aria-hidden="true" className="size-8" />;

  if (isSignedIn) {
    return (
      <>
        <UserButton appearance={{ elements: { avatarBox: "w-8 h-8" } }}>
          <UserButton.MenuItems>
            {/* ADMIN LIVES IN THE MENU, on every viewport (2026-08-08).
                It spent a while as a standalone shield beside the avatar, on the
                argument that the owner opens it constantly and a menu click is
                pure friction for its only user. True, and it cost more than it
                saved: two 32px buttons in a 46px collapsed header is most of the
                width the artwork's "FIND YOUR NEXT ADVENTURE" tagline occupies,
                so the header could not be made to look right with both there.
                One tap to reach a page one person visits beats a permanently
                crowded header for everyone. Same treatment on desktop rather than
                a viewport-dependent split — a control that moves depending on
                window width is harder to find than one that never moves.
                Still only drawn for an admin, and still only a link: /admin
                enforces access itself, so this grants nothing either way. */}
            {isAdmin && (
              <UserButton.Action
                label="Admin"
                labelIcon={<ShieldCheck size={14} />}
                onClick={() => router.push("/admin")}
              />
            )}
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
            {!isNative && canManageBilling && (
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
  //
  // HYSTERESIS IS LOAD-BEARING, NOT POLISH. The band is `sticky`, so it sits in
  // normal flow and collapsing it makes the document 85px shorter — which moves
  // the very scroll position the decision is based on. With a single threshold
  // that is a feedback loop: stop with the scroll near the trigger and it
  // collapses, the content shifts, scrollY lands back under the threshold, it
  // expands, and the header visibly flutters between the two heights (reported
  // on a real device 2026-08-01, "if you stop half way it starts to flutter").
  //
  // Two thresholds with a wide dead band mean the state that just fired cannot
  // immediately un-fire: once collapsed you must scroll nearly back to the top
  // to expand again, and the shift caused by collapsing can never reach
  // EXPAND_AT. The transition lock covers the animation itself, during which
  // layout is mid-flight and any reading is meaningless.
  useEffect(() => {
    let lockedUntil = 0;
    const onScroll = () => {
      if (performance.now() < lockedUntil) return;
      const y = window.scrollY;
      setCollapsed((prev) => {
        const next = prev ? y > EXPAND_AT : y > COLLAPSE_AT;
        if (next !== prev) lockedUntil = performance.now() + HEADER_ANIM_MS;
        return next;
      });
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
          // THE STATUS BAR MUST ADD TO THE HEIGHT, NOT EAT INTO IT. This was
          // `height: var(--ch-header)` with `paddingTop: env(safe-area-inset-top)`,
          // and Tailwind's border-box means the padding came OUT of the 131px — so
          // on a phone with a ~40px status bar the artwork got a third shorter and
          // the clock and battery sat on top of it. Collapsed (46px) it was worse:
          // the status bar covered nearly the whole band. Adding the inset to the
          // height gives the art its full size and puts the system icons in green
          // space above it. Reported on a real device 2026-08-01.
          style={{
            height: `calc(${collapsed ? "var(--ch-header-min)" : "var(--ch-header)"} + env(safe-area-inset-top))`,
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
          {/* THE CONTROLS SIT BESIDE THE ART, NOT ON TOP OF IT.
              They used to be `absolute right-3`, which put them exactly where the
              artwork's tagline ends — the JPEG carries "CampHawk" bottom-left and
              "FIND YOUR NEXT ADVENTURE" bottom-right, running to the right edge.
              Collapsed, `object-cover` scales the art to the full band width, so the
              avatar (and, for the owner, the admin shield beside it) landed squarely
              on the words. Reported on a real phone 2026-08-08.

              A flex row instead of a reserved-width guess, because the controls are
              32px, 76px or 0px wide depending on whether you are signed in and
              whether you are an admin — any hard-coded inset is wrong for two of
              those three. The browser measures them; the image takes what is left,
              and `object-contain`/`object-cover` re-fit inside the narrower box, so
              the tagline simply ends before the buttons begin. Nothing is clipped:
              at this aspect ratio the scale is width-driven, so the crop stays
              vertical and "CampHawk" can never lose its C — the failure the
              `object-contain` comment above was added for. */}
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
          {/* THE ART STAYS FULL-BLEED. A first attempt made the controls a flex
              sibling so the image took only the remaining width — which does stop
              them covering the tagline, and leaves a hard vertical seam where the
              cream sky stops and flat green starts. It reads as an image that
              failed to load. Full-bleed with a scrim is the right trade: the
              banner survives, and the tagline fades into the green rather than
              disappearing behind an opaque circle.

              Collapsed only, because expanded the controls sit over sky and there
              is nothing to protect. Pointer-events off so it can never eat a tap
              meant for the avatar. */}
          {collapsed && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-32 bg-gradient-to-l from-[#24382A] via-[#24382A]/85 to-transparent"
            />
          )}
          {/* `absolute` resolves against the PADDING box, so a plain `top-3` sits
              12px from the very top of the element and therefore UNDER the status
              bar — which is exactly where the account avatar was rendering, next to
              the clock and battery. Offset it by the inset explicitly. */}
          <div
            className="absolute right-3 flex items-center gap-2"
            style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
          >
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
