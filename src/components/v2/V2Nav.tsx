"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import HawkGlyph from "@/components/ui/HawkGlyph";
import { cx } from "@/components/ui/cx";

/**
 * Top nav for the redesign's three destinations.
 *
 * Campground detail is deliberately NOT a fourth item — it's a drill-in reached
 * from a search result or a watch, and it keeps a back link instead. Promoting
 * it to the nav would imply you can browse to "a campground" with nothing chosen.
 *
 * Desktop shows the row inline; on mobile it becomes a bottom-anchored tab bar in
 * a later commit. For now the same row wraps, which is honest for a work in
 * progress and avoids half-building the mobile chrome.
 */
const LINKS: Array<{ href: string; label: string }> = [
  { href: "/v2/watches", label: "Watches" },
  { href: "/v2/new", label: "New watch" },
  { href: "/v2", label: "Available now" },
];

export default function V2Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-ch-line bg-ch-card/95 backdrop-blur">
      <div
        className="mx-auto flex max-w-[var(--ch-max)] items-center gap-6 px-5"
        // Clears the notch inside the native webview under Android 15+ edge-to-edge.
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

        <nav aria-label="Main" className="flex flex-1 flex-wrap gap-1">
          {LINKS.map(({ href, label }) => {
            // Exact match for the index so it isn't active on every child route.
            const active = href === "/v2" ? pathname === "/v2" : pathname.startsWith(href);
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
  );
}
