import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * Redesign primitive: Button.
 *
 * Variants carry meaning, they are not decoration (see the colour rules in
 * globals.css):
 *   primary — the action that gets you a site. Green.
 *   quiet   — secondary/neutral action. No colour claim.
 *   cart    — hands off to Recreation.gov (auto-cart, checkout). Blue.
 *   warn    — the user must act, e.g. reconnect an expired session. Red.
 *             NOT for "no sites open", which is a normal state.
 *
 * The 2px bottom shadow on the solid variants is the token system's pressed
 * affordance — it collapses to 1px and the button translates down on :active.
 */
export type ButtonVariant = "primary" | "quiet" | "cart" | "warn";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container. Solid CTAs are full-width in the mockups; inline actions are not. */
  fullWidth?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-ch-green text-white shadow-[0_2px_0_var(--color-ch-green-deep)] " +
    "hover:bg-[#228554] active:translate-y-px active:shadow-[0_1px_0_var(--color-ch-green-deep)]",
  quiet:
    "bg-ch-card text-ch-ink-2 border border-ch-line " +
    "hover:bg-ch-paper hover:border-ch-muted",
  cart:
    "bg-ch-blue text-white shadow-[0_2px_0_var(--color-ch-blue-deep)] " +
    "hover:bg-[#35569C] active:translate-y-px active:shadow-[0_1px_0_var(--color-ch-blue-deep)]",
  warn:
    "bg-ch-alert text-white shadow-[0_2px_0_var(--color-ch-alert-deep)] " +
    "hover:bg-[#C7503A] active:translate-y-px active:shadow-[0_1px_0_var(--color-ch-alert-deep)]",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-3 py-2.5 text-ch-meta",
  md: "px-3 py-3 text-[14.5px]",
  lg: "px-3 py-[19px] text-[17px]",
};

export default function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center rounded-ch-btn font-ch-body font-bold",
        "cursor-pointer transition-colors",
        // The global :focus-visible outline is the OLD palette's green; a class
        // selector outranks it so the primitives stay on the ch-* system.
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green",
        "disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none disabled:active:translate-y-0",
        "motion-reduce:transition-none motion-reduce:active:translate-y-0",
        VARIANT[variant],
        SIZE[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    />
  );
}
