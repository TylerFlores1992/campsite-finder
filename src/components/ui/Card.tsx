import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * Redesign primitive: Card — the surface a watch or a search result sits on.
 *
 * States:
 *   default — resting
 *   hit     — a site is open right now. Green border, the loudest state in the UI.
 *   warn    — the user must act (expired session). Red border.
 *   paused  — not running. Content is dimmed, the surface goes slightly off-white.
 *
 * The emphasis states use a 1.5px border and shave 0.5px off the padding so the
 * card's outer box stays exactly the same size as a resting card. Without that
 * compensation a grid of cards visibly jitters the moment one of them opens —
 * which is precisely when the user is trying to read it.
 *
 * `paused` dims the content but NOT the action row: the whole point of a paused
 * card is that Resume stays easy to hit. Callers put actions in `children` after
 * a `[&_[data-card-actions]]` boundary, or simply outside the dimmed block.
 */
export type CardState = "default" | "hit" | "warn" | "paused";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  state?: CardState;
}

const STATE: Record<CardState, string> = {
  default: "border-ch-line p-[15px]",
  hit: "border-ch-green border-[1.5px] p-[14.5px]",
  warn: "border-ch-alert border-[1.5px] p-[14.5px]",
  paused: "border-ch-line p-[15px] bg-[#FBFCFA]",
};

export default function Card({ state = "default", className, ...rest }: CardProps) {
  return (
    <div
      data-state={state}
      className={cx(
        "rounded-ch-card border bg-ch-card shadow-ch-card",
        STATE[state],
        // Dim the descriptive content of a paused card, never its controls.
        state === "paused" && "[&_[data-card-dim]]:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}
