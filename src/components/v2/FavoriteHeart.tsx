"use client";

import { Heart } from "lucide-react";

/**
 * The heart. Filled = favourited, hollow = not.
 *
 * Presentational only — the caller owns the state, so the same button works on
 * a result card, in the New watch search bar, and anywhere else, all reading
 * from the one useFavorites store.
 *
 * aria-pressed carries the state for screen readers; colour alone would leave
 * "favourited" invisible to anyone who can't see the fill.
 */
export interface FavoriteHeartProps {
  favorite: boolean;
  onToggle: () => void;
  /** Named in the label so a page full of hearts isn't a page of "Favorite". */
  campgroundName?: string;
  className?: string;
}

export default function FavoriteHeart({
  favorite,
  onToggle,
  campgroundName,
  className,
}: FavoriteHeartProps) {
  const what = campgroundName ? ` ${campgroundName}` : "";
  return (
    <button
      type="button"
      aria-pressed={favorite}
      aria-label={favorite ? `Remove${what} from favorites` : `Add${what} to favorites`}
      title={favorite ? "Favorited" : "Add to favorites"}
      onClick={(e) => {
        // Cards wrap these in links; a heart click must not navigate.
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={`grid size-8 shrink-0 cursor-pointer place-items-center rounded-full transition-colors hover:bg-ch-green-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ch-green ${className ?? ""}`}
    >
      <Heart
        aria-hidden="true"
        className={favorite ? "size-4 text-ch-alert" : "size-4 text-ch-muted"}
        fill={favorite ? "currentColor" : "none"}
      />
    </button>
  );
}
