import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * Redesign primitive: Chip.
 *
 * A toggle, not a link — site types, radii, date presets, alert channels. Green
 * when selected is consistent with the colour rules: a selected chip widens what
 * counts as available, so it earns the colour.
 *
 * Exposed as aria-pressed rather than a checkbox role: these are buttons that
 * flip a filter, and screen readers announce "pressed"/"not pressed" correctly.
 * Callers that need single-select (radio) semantics should pass role="radio"
 * themselves and manage the group.
 */
export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
  selected?: boolean;
  /** Denser padding for rails and mobile filter rows. */
  size?: "sm" | "md";
}

export default function Chip({
  selected = false,
  size = "md",
  className,
  type = "button",
  ...rest
}: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cx(
        "inline-flex items-center rounded-ch-chip border font-ch-body cursor-pointer transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
        "disabled:cursor-not-allowed disabled:opacity-55",
        "motion-reduce:transition-none",
        size === "sm" ? "px-[11px] py-[7px] text-ch-meta" : "px-3 py-[7px] text-ch-meta",
        selected
          ? "bg-ch-green-soft border-ch-green text-ch-green-deep font-bold"
          : "bg-ch-card border-ch-line text-ch-ink-2 font-semibold hover:border-ch-muted",
        className,
      )}
      {...rest}
    />
  );
}
