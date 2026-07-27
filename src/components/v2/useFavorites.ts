"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

/**
 * Favourites, shared by every surface that shows a heart.
 *
 * The API already existed and is unchanged — GET returns the bare id list and
 * is ungated for any signed-in user, POST/DELETE toggle one row. This is purely
 * the client-side half.
 *
 * ONE STORE PER PAGE IS NOT ENFORCED, so the toggle is optimistic AND
 * reconciled: a failed write rolls back rather than leaving a filled heart over
 * a row that was never saved. A heart that lies is worse than no heart — the
 * whole point is that the user trusts the list on the New watch screen.
 *
 * Signed out, everything is empty and `canFavorite` is false. Callers hide the
 * heart rather than showing one that opens a sign-in wall on click.
 */
export function useFavorites() {
  const { isLoaded, isSignedIn } = useAuth();
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    fetch("/api/favorites")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { favorites?: string[] } | null) => {
        if (cancelled || !j) return;
        setIds(new Set(j.favorites ?? []));
      })
      .catch(() => {
        /* non-fatal — hearts just render hollow */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  const isFavorite = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback(
    async (id: string) => {
      const wasFavorite = ids.has(id);
      const next = new Set(ids);
      if (wasFavorite) next.delete(id);
      else next.add(id);
      setIds(next);

      try {
        const r = wasFavorite
          ? await fetch(`/api/favorites?campgroundId=${encodeURIComponent(id)}`, {
              method: "DELETE",
            })
          : await fetch("/api/favorites", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ campgroundId: id }),
            });
        if (!r.ok) throw new Error(String(r.status));
      } catch {
        // Roll back to the truth we last had from the server.
        setIds((cur) => {
          const back = new Set(cur);
          if (wasFavorite) back.add(id);
          else back.delete(id);
          return back;
        });
      }
    },
    [ids],
  );

  return {
    loaded: isLoaded && (!isSignedIn || loaded),
    canFavorite: Boolean(isSignedIn),
    ids,
    isFavorite,
    toggle,
  };
}
