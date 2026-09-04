"use client";

import { useEffect, useState } from "react";

/**
 * The one-shot "this is going to be quiet for a while, and that is not a fault" note,
 * shown on /watches straight after a watch is created.
 *
 * WHY IT LIVES HERE AND NOT IN NewWatch. The answer needs the reservation portal, which
 * takes seconds and can fail, and making somebody stare at a spinner after the button
 * they pressed has already succeeded is worse than the problem being solved. The watch
 * is saved, the user lands where they expect, and this fills in behind them.
 *
 * ONE-SHOT BY CONSTRUCTION. It keys off `?new=<id>`, which only the create flow writes
 * and which any later navigation drops — so there is no "seen" flag to store, nothing
 * to expire, and no way for it to reappear on a watch the user has lived with for a
 * week. Dismissing strips the param so a back-navigation does not bring it back.
 *
 * SILENCE IS THE DEFAULT AND EVERY FAILURE FALLS INTO IT: no param, a 404, a 500, an
 * unparseable body, or `show: false` all render nothing. A note explaining a long wait
 * is worth having; a note that appears because a fetch failed is not. The decision
 * itself — including the rule that unknown availability must never read as "nothing is
 * free" — is `lib/watch-outlook`, tested there rather than asserted here.
 */
export default function NewWatchOutlook({ className = "" }: { className?: string }) {
  const [note, setNote] = useState<{ heading: string; body: string } | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("new");
    if (!id) return;
    let cancelled = false;
    fetch(`/api/watches/${encodeURIComponent(id)}/outlook`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { show?: boolean; heading?: string; body?: string } | null) => {
        if (!cancelled && j?.show && j.heading && j.body) setNote({ heading: j.heading, body: j.body });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!note) return null;

  return (
    <div className={`rounded-[13px] border border-ch-line bg-ch-card px-3.5 py-3 ${className}`}>
      <div className="flex items-start gap-2.5">
        <div className="flex-1">
          {/* Status is never carried by colour alone anywhere in this app, and this is
              not a status at all — it is an explanation, so it leads with words and
              uses the ordinary card surface rather than a warning tint. */}
          <p className="text-ch-body font-bold">{note.heading}</p>
          <p className="mt-1 text-ch-meta leading-normal text-ch-ink-2">{note.body}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setNote(null);
            const url = new URL(window.location.href);
            url.searchParams.delete("new");
            window.history.replaceState(null, "", url.toString());
          }}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 rounded-full px-2 py-1 text-ch-meta text-ch-muted hover:text-ch-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
