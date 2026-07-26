"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "./cx";

/**
 * Redesign primitive: Collapsible — the toggle-and-drop used by filters, alert
 * history, past watches and the auto-cart trust panel.
 *
 * TWO THINGS THIS FIXES FROM THE HANDOFF MOCKUP:
 *
 * 1. No hardcoded max-height. The mockup animated `max-height: 0 → 620px`, which
 *    silently clips any panel taller than that — a long alert history or a full
 *    filter list would just lose its bottom. This animates
 *    `grid-template-rows: 0fr → 1fr` instead, which is content-height agnostic
 *    and still transitions.
 *
 * 2. Real ARIA. The mockup's toggle was a bare button with a rotating glyph and
 *    no relationship to the panel it controlled. Here the trigger carries
 *    aria-expanded/aria-controls, the panel is a labelled region, and the panel
 *    is `inert` while closed so its contents are neither focusable nor announced
 *    (the grid technique keeps them in the DOM, so without inert a keyboard user
 *    would tab into a collapsed panel).
 *
 * Uncontrolled by default; pass `open` + `onOpenChange` to control it.
 */
export interface CollapsibleProps {
  label: ReactNode;
  /** Right-aligned summary, e.g. "3 applied" / "all sites" / "3 this month". */
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode. Supply with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export default function Collapsible({
  label,
  summary,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
}: CollapsibleProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolled;

  const id = useId();
  const panelId = `${id}-panel`;
  const triggerId = `${id}-trigger`;

  const toggle = () => {
    if (!isControlled) setUncontrolled((v) => !v);
    onOpenChange?.(!open);
  };

  return (
    <div className={className}>
      <button
        type="button"
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className={cx(
          "flex w-full cursor-pointer items-center gap-2.5 border bg-ch-card px-3.5 py-3 text-left",
          "font-ch-body transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
          "motion-reduce:transition-none",
          open
            ? "rounded-t-ch-input border-ch-green"
            : "rounded-ch-input border-ch-line hover:border-ch-muted",
        )}
      >
        <span className="flex-1 text-[13px] font-bold text-ch-ink">{label}</span>
        {summary ? <span className="text-ch-fine font-semibold text-ch-muted">{summary}</span> : null}
        <ChevronDown
          aria-hidden="true"
          className={cx(
            "size-3.5 shrink-0 text-ch-muted transition-transform duration-200",
            "motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        // Not focusable or announced while collapsed — the content stays mounted
        // so the height transition has something to measure.
        inert={!open}
        className={cx(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          open
            ? "grid-rows-[1fr] rounded-b-ch-input border border-t-0 border-ch-green bg-ch-card"
            : "grid-rows-[0fr] border border-t-0 border-transparent",
        )}
      >
        <div className="overflow-hidden">
          <div className="px-3.5 pt-3 pb-[15px]">{children}</div>
        </div>
      </div>
    </div>
  );
}
