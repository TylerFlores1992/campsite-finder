"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";

/**
 * Per-site muting — ONE implementation, mounted by both screens that offer it.
 *
 * ── WHY IT IS SHARED ───────────────────────────────────────────────────────────────────
 * The owner asked for muting on the New watch screen because "most people won't know
 * there is a mute section in manage watches". That is a request for the SAME control in a
 * second place, and this repo has paid for a second copy every time it made one:
 * `content-rc.js` diverged from `rc-cart.mjs` and told users to click a cart icon for
 * months; `rc-test-login.bat` kept the unsupervised relaunch that `rc-login.bat` had
 * fixed. NewWatch's own header states the rule — "build once, import twice — two drifting
 * copies is how the current UI got here".
 *
 * The two callers differ only in what a change MEANS, which is the `onChange` prop:
 *   - /manage/<token>  → a write, straight to the API, on a watch that exists.
 *   - /new             → local state, posted with the watch that is about to be created.
 * Everything else — the inventory load, the filter, the muted-stay-visible rule, the
 * bulk control — is identical and lives here once.
 *
 * ── THE IDS ARE THE POLLER'S IDS, AND THAT IS THE WHOLE FEATURE ─────────────────────────
 * The inventory comes from `/api/campgrounds/<id>/availability`, which is
 * `getAvailabilityFromRecGov` for rec.gov and `getRCAvailabilityForMonth` for
 * ReserveCalifornia — the SAME functions the poller reads. RC's emits
 * `campsiteId: String(unit.UnitId)`, which is exactly what `findRCOpenUnit` and
 * `findRCHeldUnits` compare against (`muted.has(String(unit.UnitId))`), and rec.gov's
 * `campsiteId` is what `availableDatesForWatch` compares. So an id muted here is an id
 * the poller can match. Anything that changes where this list comes from breaks muting
 * silently, which is the failure recorded in `worker/site-mute.test.mts`.
 *
 * ── BULK, AND WHY IT IS TWO BUTTONS AND NOT ONE TOGGLE ──────────────────────────────────
 * The use case is "mute all but one or two", so muting everything must be one tap. A
 * single toggle whose label flips on whether everything is muted reads wrong in the
 * middle state — after unmuting your two keepers it says "Mute all" again, and pressing
 * it silently re-mutes them. Two buttons cannot lie about their direction.
 *
 * The COUNT in each label is what will actually change, not what is on screen: with a
 * filter active the labels say "Mute these 4", because a user who filtered to "B" and
 * pressed a button reading "Mute all" would reasonably expect all 300 sites. That
 * distinction is pinned by a test.
 */

/** A row in the list. `alerted` and `note` are decoration the manage screen adds. */
export interface MuteSite {
  id: string;
  name: string | null;
  loop: string | null;
  /** Sorts first. The manage screen sets this for sites that have alerted before. */
  alerted?: boolean;
  /** Which division this site belongs to. Only shown when more than one is covered. */
  division?: string | null;
}

export interface SiteMuteListProps {
  /**
   * Every campground whose sites should be listed — one for an ordinary watch, several
   * for a park watch covering divisions.
   *
   * SAFE ACROSS DIVISIONS BECAUSE IDS ARE UNIQUE WITHIN A PARK: 10,757 sampled across
   * ReserveCalifornia, Ohio and Minnesota multi-division parks, zero collisions. That
   * matters because `muted_site_ids` is ONE column on the watch and applies to every
   * campground it covers — so muting "#42" in one division would silence "#42" in a
   * sibling if the ids collided. It is emphatically NOT safe across unrelated
   * campgrounds, where rec.gov's global ids could match anything; the caller is
   * responsible for passing only campgrounds this one watch covers.
   */
  campgroundIds: string[];
  /** YYYY-MM the inventory is loaded for — the watch's first month. */
  month: string;
  muted: ReadonlySet<string>;
  /**
   * Apply a change. Returns false if it failed, so the optimistic update rolls back.
   * Both directions are BATCHES: bulk muting a 300-site campground one request per site
   * is not something to do to a phone on a campground's wifi.
   */
  onChange: (change: { mute?: string[]; unmute?: string[] }) => Promise<boolean>;
  /**
   * Sites to show even if the inventory call returns nothing — the manage screen seeds
   * this with sites that have alerted, so the list degrades to what it showed before
   * rather than to nothing on a provider that cannot enumerate.
   */
  seedSites?: MuteSite[];
  /** Extra per-row labels, e.g. "open now". Returned strings are joined with · */
  annotate?: (id: string) => (string | null)[];
  /**
   * campgroundId -> division label, so a park watch's rows can say which part they are
   * in. Two of Leo Carrillo's three divisions are both "Canyon Campground", so without
   * this a merged list would show the same site number twice with nothing telling them
   * apart. Only rendered when more than one campground is covered.
   */
  divisionNames?: Record<string, string>;
  /** Rendered when the campground genuinely has no listable sites. */
  emptyMessage?: string;
  /**
   * Every id currently listed, whenever the inventory changes.
   *
   * The New watch screen uses it to PRUNE mutes when the user changes which divisions
   * are covered: an id from a division they just unticked would otherwise still be
   * posted, attaching a mute to a watch that does not cover that campground.
   */
  onInventory?: (ids: string[]) => void;
}

export default function SiteMuteList({
  campgroundIds,
  month,
  muted,
  onChange,
  seedSites,
  annotate,
  divisionNames,
  emptyMessage,
  onInventory,
}: SiteMuteListProps) {
  const [sites, setSites] = useState<MuteSite[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // The effect must re-run when the COVERED SET changes — tick a division on and its
  // sites have to appear. `campgroundIds` is a fresh array on every render, so keying the
  // effect on the array itself would refetch every render; keying on its joined value
  // refetches exactly when the set really changed. Sorted, so re-ordering is not a change.
  const coveredKey = [...campgroundIds].sort().join(",");

  useEffect(() => {
    let cancelled = false;
    const seed = seedSites ?? [];
    setSites(null);

    (async () => {
      try {
        // ONE FETCH PER COVERED CAMPGROUND. A park watch lists every division it covers,
        // because the alternative is what the owner reported: Leo Carrillo offering no
        // mute list at all. Bounded by MAX_DIVISIONS_PER_WATCH, so this is at most ten
        // requests and usually one. A division that fails contributes nothing rather
        // than failing the list — losing one division's rows must not cost the ability
        // to unmute the rest.
        const perCampground = await Promise.all(
          campgroundIds.map(async (cid) => {
            try {
              const r = await fetch(
                `/api/campgrounds/${encodeURIComponent(cid)}/availability?month=${month}`,
              );
              if (!r.ok) return { cid, campsites: [] };
              const a = (await r.json()) as {
                campsites?: Array<{ campsiteId: string; campsiteName: string | null; loop: string | null }>;
              };
              return { cid, campsites: a.campsites ?? [] };
            } catch {
              return { cid, campsites: [] };
            }
          }),
        );
        if (cancelled) return;

        const seededIds = new Set(seed.map((s) => s.id));
        const multi = campgroundIds.length > 1;
        const rows: MuteSite[] = [];
        for (const { cid, campsites } of perCampground) {
          for (const cs of campsites) {
            rows.push({
              id: cs.campsiteId,
              name: cs.campsiteName,
              loop: cs.loop,
              alerted: seededIds.has(cs.campsiteId),
              division: multi ? (divisionNames?.[cid] ?? null) : null,
            });
          }
        }
        if (rows.length === 0) {
          setSites(seed);
          onInventory?.(seed.map((s) => s.id));
          return;
        }
        // Anything seeded or already muted that this month's grid doesn't list still
        // needs a row — otherwise a muted site becomes impossible to unmute.
        const ids = new Set(rows.map((r2) => r2.id));
        for (const s of seed) if (!ids.has(s.id)) rows.push(s);
        for (const id of muted) {
          if (!ids.has(id) && !seededIds.has(id)) rows.push({ id, name: null, loop: null });
        }
        rows.sort(
          (x, y) =>
            Number(!!y.alerted) - Number(!!x.alerted) ||
            (x.division ?? "").localeCompare(y.division ?? "") ||
            (x.loop ?? "").localeCompare(y.loop ?? "") ||
            (x.name ?? x.id).localeCompare(y.name ?? y.id, undefined, { numeric: true }),
        );
        setSites(rows);
        // The ids this list can actually offer. The caller prunes mutes against it, so
        // an id from a division the user just unticked is not posted with the watch.
        onInventory?.(rows.map((r2) => r2.id));
      } catch {
        if (!cancelled) setSites(seed);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `muted` is deliberately NOT a dependency: it changes on every tap, and refetching
    // a 300-site grid per tap would be absurd. It is read only to backfill rows for ids
    // the grid doesn't list, which is a load-time concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredKey, month, seedSites]);

  const apply = useCallback(
    async (change: { mute?: string[]; unmute?: string[] }, key: string) => {
      setBusy(key);
      setFailed(false);
      try {
        const ok = await onChange(change);
        if (!ok) setFailed(true);
      } catch {
        setFailed(true);
      } finally {
        setBusy(null);
      }
    },
    [onChange],
  );

  if (sites === null) {
    return <div className="h-16 animate-pulse rounded-ch-input bg-ch-shell motion-reduce:animate-none" />;
  }

  if (sites.length === 0) {
    return (
      <p className="text-ch-fine text-ch-muted">
        {emptyMessage ??
          "We can't list this campground's individual sites, so there's nothing to mute yet."}
      </p>
    );
  }

  // Muted sites stay visible whatever the filter says — a muted site you can't find is a
  // muted site you can't unmute.
  const q = filter.trim().toLowerCase();
  const visible = sites.filter(
    (s) =>
      !q ||
      muted.has(s.id) ||
      (s.name ?? s.id).toLowerCase().includes(q) ||
      (s.loop ?? "").toLowerCase().includes(q),
  );

  // What each bulk button would CHANGE — not what is on screen. See the header.
  const toMute = visible.filter((s) => !muted.has(s.id)).map((s) => s.id);
  const toUnmute = visible.filter((s) => muted.has(s.id)).map((s) => s.id);
  const filtered = q.length > 0;

  return (
    <>
      {sites.length > 12 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${sites.length} sites — try a name or loop`}
          aria-label="Filter campsites"
          className="mb-2 w-full rounded-ch-input border border-ch-line bg-ch-card px-3 py-2 text-ch-body text-ch-ink placeholder:text-ch-faint focus-visible:border-ch-green focus-visible:outline-none"
        />
      )}

      {(toMute.length > 0 || toUnmute.length > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {toMute.length > 0 && (
            <Button
              variant="quiet"
              size="sm"
              disabled={busy === "bulk"}
              onClick={() => void apply({ mute: toMute }, "bulk")}
            >
              {filtered ? `Mute these ${toMute.length}` : `Mute all ${toMute.length}`}
            </Button>
          )}
          {toUnmute.length > 0 && (
            <Button
              variant="quiet"
              size="sm"
              disabled={busy === "bulk"}
              onClick={() => void apply({ unmute: toUnmute }, "bulk")}
            >
              {filtered ? `Unmute these ${toUnmute.length}` : `Unmute all ${toUnmute.length}`}
            </Button>
          )}
          <span className="text-ch-fine text-ch-muted">
            {muted.size
              ? `${muted.size} of ${sites.length} muted`
              : "Mute all, then unmute the few you'd take"}
          </span>
        </div>
      )}

      {failed && (
        <p role="alert" className="mb-2 text-ch-fine text-ch-alert">
          That didn&apos;t save. Try again.
        </p>
      )}

      <ul className="max-h-[320px] overflow-y-auto">
        {visible.map((s) => {
          const isMuted = muted.has(s.id);
          const notes = [
            ...(annotate?.(s.id) ?? []),
            // FIRST, because on a park watch it is the thing that tells two identically
            // named sites apart — Leo Carrillo has two divisions both called "Canyon
            // Campground", so "#42" alone is ambiguous across them.
            s.division,
            s.loop,
            s.alerted ? "alerted before" : null,
          ].filter(Boolean);
          return (
            <li
              key={s.id}
              className="flex items-center gap-2.5 border-b border-ch-line py-2 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ch-body font-bold">{s.name ?? s.id}</span>
                {notes.length > 0 && (
                  <span className="mt-0.5 block text-ch-fine text-ch-muted">{notes.join(" · ")}</span>
                )}
              </span>
              <Button
                variant={isMuted ? "warn" : "quiet"}
                size="sm"
                disabled={busy === s.id || busy === "bulk"}
                onClick={() =>
                  void apply(isMuted ? { unmute: [s.id] } : { mute: [s.id] }, s.id)
                }
              >
                {isMuted ? "Muted" : "Mute"}
              </Button>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="py-3 text-ch-fine text-ch-muted">{`No site matches "${filter}".`}</li>
        )}
      </ul>
    </>
  );
}
