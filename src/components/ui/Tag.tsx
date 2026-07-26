import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * Redesign primitive: Tag — the small status/source label on a card.
 *
 * Non-interactive by design. Kinds map onto the colour rules:
 *   open   — a site is available right now (green, the only "good news" tag)
 *   watch  — you asked for this; we're checking (ochre)
 *   cart   — Recreation.gov handoff (blue)
 *   paused — not running. Neutral, NEVER red: a paused or booked state is
 *            normal, not an error.
 *   alert  — the user must act (red)
 *   src    — which provider you'll check out on. Neutral, sentence case.
 *
 * ACCESSIBILITY: the handoff brief flagged that status was conveyed by colour
 * plus an uppercase word with nothing for screen readers. `srPrefix` renders a
 * visually-hidden lead-in so "Recreation.gov" is announced as
 * "Booking provider: Recreation.gov" rather than a bare proper noun. Status
 * kinds default to a sensible prefix; pass `srPrefix={null}` to opt out when the
 * surrounding text already carries the meaning.
 */
export type TagKind = "open" | "watch" | "cart" | "paused" | "alert" | "src";

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  kind: TagKind;
  /** Visually-hidden lead-in. Defaults per kind; `null` disables it. */
  srPrefix?: string | null;
}

const KIND: Record<TagKind, string> = {
  open: "bg-ch-green text-white uppercase tracking-[.09em] font-bold",
  watch: "bg-ch-ochre-soft text-ch-ochre-ink uppercase tracking-[.09em] font-bold",
  cart: "bg-ch-blue text-white uppercase tracking-[.09em] font-bold",
  paused: "bg-[#EDF0EB] text-ch-muted uppercase tracking-[.09em] font-bold",
  alert: "bg-ch-alert text-white uppercase tracking-[.09em] font-bold",
  // Provider names are proper nouns — uppercasing them hurts more than it helps.
  src: "bg-[#EDF0EB] text-[#5E7266] tracking-[.04em] font-semibold",
};

const DEFAULT_SR_PREFIX: Record<TagKind, string | null> = {
  open: "Status:",
  watch: "Status:",
  cart: "Status:",
  paused: "Status:",
  alert: "Needs attention:",
  src: "Booking provider:",
};

export default function Tag({ kind, srPrefix, className, children, ...rest }: TagProps) {
  const prefix = srPrefix === undefined ? DEFAULT_SR_PREFIX[kind] : srPrefix;
  return (
    <span
      className={cx(
        "inline-block rounded-ch-tag px-2 py-1 font-ch-body text-[10px] leading-none",
        KIND[kind],
        className,
      )}
      {...rest}
    >
      {prefix ? <span className="sr-only">{prefix} </span> : null}
      {children}
    </span>
  );
}
