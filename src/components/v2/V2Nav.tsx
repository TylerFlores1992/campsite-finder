"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, PlusCircle, Search } from "lucide-react";
import HawkGlyph from "@/components/ui/HawkGlyph";
import { cx } from "@/components/ui/cx";

/**
 * Navigation for the redesign's three destinations.
 *
 * Desktop gets a top row; phones get a bottom tab bar, because the top of a
 * phone screen is the hardest place to reach and these are the app's primary
 * moves. The mockup used top tabs on mobile too — worth diverging from, since
 * this is a one-handed app people open outdoors.
 *
 * Campground detail is deliberately not a fourth item. It's a drill-in with a
 * back link; promoting it would imply you can browse to "a campground" with
 * nothing chosen.
 */
const LINKS = [
  { href: "/v2/watches", label: "Watches", Icon: Bell },
  { href: "/v2/new", label: "New watch", Icon: PlusCircle },
  { href: "/v2", label: "Available now", short: "Search", Icon: Search },
] as const;

function useIsActive() {
  const pathname = usePathname();
  // Exact match for the index so it isn't active on every child route.
  return (href: string) => (href === "/v2" ? pathname === "/v2" : pathname.startsWith(href));
}

export default function V2Nav() {
  const isActive = useIsActive();

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-ch-line bg-ch-card/95 backdrop-blur">
        <div
          className="mx-auto flex max-w-[var(--ch-max)] items-center gap-6 px-5"
          // Clears the notch in the native webview under Android 15+ edge-to-edge.
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <Link
            href="/v2"
            className="flex shrink-0 items-center gap-2 py-3.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
          >
            <HawkGlyph size={24} className="text-ch-green" />
            <span className="font-ch-display text-[19px] font-extrabold tracking-[-.025em]">
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
                    "rounded-[9px] px-3 py-2 text-[13.5px] font-bold transition-colors",
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
        </div>
      </header>

      {/* Phone tab bar. Fixed to the bottom, above the home indicator. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-ch-line bg-ch-card/98 backdrop-blur sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex">
          {LINKS.map(({ href, label, Icon, ...rest }) => {
            const active = isActive(href);
            const short = "short" in rest ? (rest.short as string) : label;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex flex-1 flex-col items-center gap-0.5 px-1 pt-2 pb-1.5",
                  "text-[11px] font-bold transition-colors motion-reduce:transition-none",
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
