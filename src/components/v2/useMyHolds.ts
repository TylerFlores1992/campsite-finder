"use client";

import { useCallback, useEffect, useState } from "react";
import type { MyHold } from "./HoldRow";

/**
 * The signed-in user's live holds, fetched ONCE for the whole watches page.
 *
 * ## Why a hook rather than each surface fetching
 *
 * Since 2026-09-04 two things draw holds: the page-level panel (a real campsite in a cart,
 * ~15 minutes on it) and every watch card (its own offered and queued lists). Letting each
 * fetch would mean N+1 requests every 20 seconds and, worse, N+1 answers that can disagree
 * — a hold declined on a card would still be sitting in the panel until its own poll came
 * round. One fetch, one list, one `dismissed` set.
 *
 * ## The poll, and why it is not optional
 *
 * A hold changes state on the BOT's clock, not the user's. Somebody sitting on this page at
 * 07:59 should watch "we have it" appear without being told to pull to refresh.
 *
 * ## THE LOCAL LIST IS A HEAD START, NOT THE RECORD
 *
 * Removing writes server-side and the next poll drops the row on its own, on every device —
 * this only spares the user up to 20 seconds of looking at a row they just dismissed. It is
 * deliberately NOT optimistic: `dismissed` is appended only after the write comes back ok,
 * so a failed remove leaves the row where it is rather than hiding a hold that still exists.
 */
export function useMyHolds(): { holds: MyHold[]; dismiss: (id: string) => void } {
  const [holds, setHolds] = useState<MyHold[] | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/rc-holds/mine")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { holds?: MyHold[] } | null) => {
          if (!cancelled && j?.holds) setHolds(j.holds);
        })
        .catch(() => {
          /* Holds that fail to load must never break the watches page. */
        });
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const dismiss = useCallback((id: string) => setDismissed((d) => [...d, id]), []);

  return { holds: (holds ?? []).filter((h) => !dismissed.includes(h.id)), dismiss };
}
