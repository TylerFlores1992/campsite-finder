"use client";
import Link from "next/link";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Collapsible from "@/components/ui/Collapsible";
import SiteMuteList from "./SiteMuteList";
import DatePicker, { type DateRange } from "@/components/ui/DatePicker";
import NightsPicker from "@/components/ui/NightsPicker";
import TrustPanel from "./TrustPanel";
import FavoriteHeart from "./FavoriteHeart";
import { useFavorites } from "./useFavorites";
import { supportsAutoCart } from "./providers";
import { supportsRcHold } from "@/lib/sources/reservecalifornia/providers";
import { AUTOCART_BETA_LABEL, AUTOCART_BETA_NOTE } from "@/lib/autocart-beta";
import { divisionLabel, dropRedundantState, parseCampgroundName, placeLabel } from "./campground-name";
import { addDays, formatRange, nightsBetween, thisWeekendRange, todayISO } from "@/components/ui/date";
import { useIsNativeApp } from "@/lib/native/context";
import { NATIVE_LINKOUT, SUBSCRIBE_HREF } from "./nativeSubscribe";
import SubscribeCta, { useAccountGate } from "./SubscribeCta";
import type { Campground } from "@/lib/types";
import { WATCH_LIMIT, MAX_DIVISIONS_PER_WATCH } from "@/lib/limits";

/**
 * New watch — now the only place a watch is created.
 *
 * A campground search lives here, which the old UI had no equivalent for: you
 * could only watch something you'd already surfaced through a location search.
 * Result cards deep-link in with ?campground=, so arriving from a search still
 * skips straight past this step.
 *
 * Mounts the SAME DatePicker / NightsPicker as Explore. NOT the FilterPanel — see the
 * note at the fieldset it used to occupy.
 * Build once, import twice — two drifting copies is how the current UI got here.
 */

interface Division {
  id: string;
  name: string;
}

interface Suggestion {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  /** Every bookable part of this park. Absent on favourites, which are single rows. */
  divisions?: Division[];
  divisionCount?: number;
}

/** Does a favourite still match what's been typed? Name, town and state all
    count — "Yosemite", "Groveland" and "CA" are all reasonable ways to reach
    the same saved campground. */
function matchesQuery(f: Suggestion, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [f.name, f.city, f.state]
    .filter(Boolean)
    .some((v) => v!.toLowerCase().includes(needle));
}

/**
 * Which divisions start ticked: all of them, up to the cap.
 *
 * ALL, because a park watch counts as ONE watch — so covering the whole park is close to
 * free and is what someone who searched for the park meant. CAPPED, because the server
 * refuses more than `MAX_DIVISIONS_PER_WATCH` and three parks in the catalog exceed it
 * (Ohio's Grand Lake St. Marys has seventy). Defaulting to all seventy would make the
 * first press of Start watching fail with "pick fewer", which is a poor way to learn
 * about a limit you never chose.
 */
function defaultChosen(all: Array<{ id: string }>): ReadonlySet<string> {
  return new Set(all.slice(0, MAX_DIVISIONS_PER_WATCH).map((d) => d.id));
}

export interface NewWatchProps {
  /** Pre-selected campground id, from a result card or detail page. */
  initialCampgroundId?: string;
  initialStart?: string;
  initialEnd?: string;
}

export default function NewWatch({
  initialCampgroundId,
  initialStart,
  initialEnd,
}: NewWatchProps) {
  const router = useRouter();
  const isNative = useIsNativeApp();
  const { gate } = useAccountGate();

  const [campgroundId, setCampgroundId] = useState<string | null>(initialCampgroundId ?? null);
  const [campgroundName, setCampgroundName] = useState("");
  const [campgroundSource, setCampgroundSource] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // Favourites surface on focus and narrow as you type — see the picker below.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [favoriteRows, setFavoriteRows] = useState<Suggestion[]>([]);
  const favorites = useFavorites();

  const [mode, setMode] = useState<"exact" | "flexible">("exact");
  const [range, setRange] = useState<DateRange>({
    start: initialStart ?? null,
    end: initialEnd ?? null,
  });
  const [flexNights, setFlexNights] = useState(2);
  const [weekendsOnly, setWeekendsOnly] = useState(false);
  const [autoCart, setAutoCart] = useState(true);
  /**
   * Sites muted before the watch exists. Local only — there is no watch to write to
   * yet — and posted with the creation below. Cleared when the campground changes,
   * because a site id means nothing at a different campground and carrying one over
   * would silently mute an unrelated site.
   */
  const [muted, setMuted] = useState<ReadonlySet<string>>(new Set());
  const muteLocally = useCallback(
    async (change: { mute?: string[]; unmute?: string[] }) => {
      setMuted((prev) => {
        const next = new Set(prev);
        for (const id of change.mute ?? []) next.add(id);
        for (const id of change.unmute ?? []) next.delete(id);
        return next;
      });
      return true;
    },
    [],
  );

  /**
   * Drop mutes the list can no longer offer.
   *
   * Untick a division after muting some of its sites and those ids are still in `muted` —
   * they would be posted with a watch that does not cover that campground, which is the
   * one thing the id rules here forbid. Called whenever the inventory changes, so the set
   * can only ever contain ids from campgrounds currently covered.
   *
   * Reference-stable identity is NOT needed (it is not an effect dependency), but the
   * functional update is: pruning against a stale `muted` would resurrect ids.
   */
  const pruneMutes = useCallback((inventoryIds: string[]) => {
    const offered = new Set(inventoryIds);
    setMuted((prev) => {
      if ([...prev].every((id) => offered.has(id))) return prev;
      return new Set([...prev].filter((id) => offered.has(id)));
    });
  }, []);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  // The park's parts, and which of them to watch. Empty (or length 1) means an
  // ordinary single campground and the section never renders.
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  /**
   * The campgrounds this watch will actually cover: the checked divisions, or the single
   * campground when the park has none.
   *
   * ONE DEFINITION, read by the submit body AND by the mute picker. They were about to be
   * two — the picker gated on `divisions.length <= 1` while the payload gated on the
   * selection — and two rules for "what does this watch cover?" is exactly how the mute
   * list ended up absent on Leo Carrillo while the payload thought it was fine.
   */
  const targets = useMemo(
    () =>
      divisions.length > 1
        ? divisions.filter((d) => chosen.has(d.id))
        : campgroundId
          ? [{ id: campgroundId, name: campgroundName }]
          : [],
    [divisions, chosen, campgroundId, campgroundName],
  );


  // A site id is only meaningful at the campground it came from. Carrying mutes across
  // a change of campground would post ids that either match nothing or — worse, since
  // rec.gov ids are global — silently mute a site the user never saw.
  useEffect(() => {
    setMuted(new Set());
  }, [campgroundId]);

  // Resolve a pre-selected campground so the summary can name it.
  useEffect(() => {
    if (!campgroundId) return;
    let cancelled = false;
    fetch(`/api/campgrounds/${encodeURIComponent(campgroundId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { campground: Campground; divisions?: Division[] } | null) => {
        if (cancelled || !j) return;
        setCampgroundName(j.campground.name);
        setCampgroundSource(j.campground.source);
        setQ(parseCampgroundName(j.campground.name).park);
        // ALL CHECKED BY DEFAULT, here as well as in `pick()`.
        //
        // THIS EFFECT USED TO OVERWRITE `pick()` WITH JUST THE REPRESENTATIVE, and
        // because `pick()` sets `campgroundId` — which is what triggers this effect —
        // it ran a moment later and won every time. So `pick()`'s "ALL CHECKED BY
        // DEFAULT" was dead code, and searching for Leo Carrillo gave "1 of 3 selected".
        // Reported from production 2026-08-15 with a screenshot of exactly that.
        //
        // The old comment justified it as "arriving on a deep link means one division
        // was chosen explicitly" — a fair argument, but this effect cannot tell a deep
        // link from a pick, so it applied to both. A park watch counts as ONE watch now,
        // so covering the whole park is close to free and is what someone who searched
        // for the park meant.
        const all = j.divisions ?? [];
        setDivisions(all.length > 1 ? all : []);
        if (all.length > 1) setChosen(defaultChosen(all));
      })
      .catch(() => {
        /* the id still works even if the name doesn't resolve */
      });
    return () => {
      cancelled = true;
    };
  }, [campgroundId]);

  // Favourite campgrounds, with names — the bare id list the heart uses can't
  // populate a picker. details=1 is subscriber-gated, which is fine: this screen
  // is already behind the same gate. A 403 just means no shortcut list.
  useEffect(() => {
    if (!favorites.canFavorite) return;
    let cancelled = false;
    fetch("/api/favorites?details=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { favorites?: Suggestion[] } | null) => {
        if (cancelled || !j) return;
        setFavoriteRows(j.favorites ?? []);
      })
      .catch(() => {
        /* the search box still works without the shortcut */
      });
    return () => {
      cancelled = true;
    };
  }, [favorites.canFavorite]);

  useEffect(() => {
    if (q.trim().length < 2 || campgroundId) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/suggest?q=${encodeURIComponent(q.trim())}`);
        if (!r.ok) return;
        const j = (await r.json()) as { campgrounds: Suggestion[] };
        setSuggestions(j.campgrounds ?? []);
      } catch {
        /* suggestions are a convenience */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, campgroundId]);

  const pick = useCallback((s: Suggestion) => {
    setCampgroundId(s.id);
    setCampgroundName(s.name);
    setQ(s.name);
    setSuggestions([]);
    setPickerOpen(false);
    // ALL CHECKED BY DEFAULT. Someone who searched for the park and picked it wants
    // the park; making them tick four boxes to get what they just asked for is the
    // work this screen is supposed to remove.
    const all = s.divisions ?? [];
    setDivisions(all.length > 1 ? all : []);
    setChosen(defaultChosen(all));
  }, []);

  // Favourites shown in the picker: everything while the box is empty, then
  // narrowing as the query stops matching, until they drop away entirely and
  // only live search hits remain. Once a campground is chosen there's nothing
  // left to pick, so the list closes.
  const favoriteIds = favorites.ids;
  const visibleFavorites = campgroundId
    ? []
    : favoriteRows.filter((f) => favoriteIds.has(f.id) && matchesQuery(f, q));

  const submit = useCallback(async () => {
    if (!campgroundId) {
      setError("Pick a campground to watch.");
      return;
    }
    if (!range.start || !range.end) {
      setError(mode === "flexible" ? "Choose the window to watch." : "Choose your nights.");
      return;
    }
    if (targets.length === 0) {
      setError("Pick at least one part of the park to watch.");
      return;
    }

    setSaving(true);
    setError(null);
    setNeedsSubscription(false);
    setSignedOut(false);

    try {
      // ONE watch covering every checked division (migration 070). It counts once
      // against the 6-watch cap, which is the whole point of doing it server-side
      // rather than looping here: an earlier version POSTed once per division, and a
      // park then ate as many slots as it had parts.
      const r = await fetch("/api/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campgroundId: targets[0].id,
          // Sent even for a single campground, so there is one code path. The server
          // writes NO join rows for a list of one, which is what keeps such a watch
          // byte-identical to a pre-070 one all the way down to the poller.
          campgroundIds: targets.map((t) => t.id),
          startDate: range.start,
          endDate: range.end,
          // siteType is NOT SENT. Nothing in worker/ reads `site_type`, so
          // transmitting it only made a dead control look alive; the picker itself
          // was removed from this screen for the same reason.
          // The auto-cart toggle was PURELY DECORATIVE until 2026-08-01 — its value
          // was never sent, the column was never written, and the poller decided the
          // auto-cart lane from the account-level setting alone. Turning it off
          // carted anyway.
          autoCart,
          // MUTES COVER EVERY CHECKED DIVISION, and can only contain ids the picker
          // offered: it lists exactly `targets`, and `pruneMutes` drops anything that
          // leaves that set when the selection changes. That is what keeps
          // `muted_site_ids` — ONE column applying to the whole watch — from carrying an
          // id belonging to a campground this watch does not cover. Safe within a park
          // because campsite ids are unique there (10,757 sampled, zero collisions); it
          // would NOT be safe across unrelated campgrounds, where rec.gov's ids are global.
          ...(muted.size ? { mutedSiteIds: [...muted] } : {}),
          ...(mode === "flexible"
            ? { flexNights, ...(weekendsOnly ? { flexDays: "weekend" } : {}) }
            : {}),
        }),
      });

      if (r.status === 402) {
        setNeedsSubscription(true);
        return;
      }
      if (r.status === 401) {
        // NOT a redirect. Hard-navigating to /sign-in threw away the campground,
        // the dates and every filter the user had just set, and they came back
        // to an empty form with no idea what happened. Say what's wrong and let
        // them sign in from here — the form is still sitting there afterwards.
        setSignedOut(true);
        return;
      }
      if (r.status === 409) {
        setError(`You've hit the ${WATCH_LIMIT}-watch limit. Delete one to add another.`);
        return;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(j?.message ?? j?.error ?? `Couldn't create the watch (${r.status})`);
      }

      // The native shell asks for notification permission off the back of this,
      // rather than on first load when the user has nothing to be notified about
      // and no reason to say yes (see NativeBridge). No-op on the web — nothing
      // listens there.
      window.dispatchEvent(new CustomEvent("camphawk:watch-created"));
      router.push("/watches");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the watch");
    } finally {
      setSaving(false);
    }
    // EVERY VALUE THE BODY READS BELONGS HERE. `autoCart` was missing until the
    // divisions work added it, and the effect of an omission is invisible: useCallback
    // hands back a closure over whatever the value was when it was last rebuilt, so the
    // payload is stale while the JSX, the body and the API all look correct.
  }, [campgroundId, campgroundName, divisions, chosen, range, mode, flexNights, weekendsOnly, autoCart, muted, router]);

  const canAutoCart = campgroundSource ? supportsAutoCart(campgroundSource) : false;
  // Narrower than isUseDirectSource on purpose -- the bot holds ONE ReserveCalifornia
  // account, so advertising this on an Ohio watch would promise what nothing can perform.
  const canRcHold = campgroundSource ? supportsRcHold(campgroundSource) : false;
  const windowNights = range.start && range.end ? nightsBetween(range.start, range.end) : 0;
  // The API rejects flexNights longer than the window; catch it before the round trip.
  const flexTooLong = mode === "flexible" && windowNights > 0 && flexNights > windowNights;
  // The server refuses more than the cap with a 400. Catch it here, in the same spirit as
  // flexTooLong: a limit you can only discover by pressing the button reads as a bug.
  const tooManyDivisions = divisions.length > 1 && chosen.size > MAX_DIVISIONS_PER_WATCH;
  // Compared against the live helper rather than a flag, so the chip stays honest if
  // the user edits the dates afterwards (and across a midnight rollover).
  const weekend = thisWeekendRange();
  const isThisWeekend = range.start === weekend.start && range.end === weekend.end;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_288px]">
      <form
        className="rounded-ch-card border border-ch-line bg-ch-card p-5 shadow-ch-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="nw-cg" className="mb-2 block text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
          Which campground
        </label>
        <div className="relative">
          <input
            id="nw-cg"
            value={q}
            onFocus={() => setPickerOpen(true)}
            // Closing on blur has to outlast the mousedown that picked a row,
            // or the list disappears before the click lands. A frame is enough.
            onBlur={() => setTimeout(() => setPickerOpen(false), 120)}
            onChange={(e) => {
              setQ(e.target.value);
              setPickerOpen(true);
              setCampgroundId(null);
              setCampgroundSource(null);
            }}
            placeholder="Search a campground by name"
            autoComplete="off"
            className={`w-full rounded-ch-input border border-ch-line bg-ch-card py-3 pl-3.5 font-ch-display text-[14.5px] font-semibold text-ch-ink placeholder:text-ch-faint focus-visible:border-ch-green focus-visible:outline-none ${
              campgroundId && favorites.canFavorite ? "pr-11" : "pr-3.5"
            }`}
          />
          {/* Heart on the chosen campground. Favouriting from here is what makes
              the shortcut list above self-serving: watch it once, and next time
              it's one click from an empty search box. */}
          {campgroundId && favorites.canFavorite && (
            <FavoriteHeart
              favorite={favorites.isFavorite(campgroundId)}
              onToggle={() => void favorites.toggle(campgroundId)}
              campgroundName={campgroundName || undefined}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
            />
          )}
        </div>

        {pickerOpen && (visibleFavorites.length > 0 || suggestions.length > 0) && (
          <div className="mt-1 overflow-hidden rounded-ch-input border border-ch-line">
            {visibleFavorites.length > 0 && (
              <>
                <p className="border-b border-ch-line bg-ch-green-soft px-3 py-1.5 text-ch-label font-bold uppercase tracking-[.1em] text-ch-green-deep">
                  Your favorites
                </p>
                <ul>
                  {visibleFavorites.map((f) => (
                    <li key={`fav-${f.id}`} className="flex items-center border-b border-ch-line last:border-b-0">
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(f)}
                        className="min-w-0 flex-1 cursor-pointer bg-ch-card px-3 py-2 text-left text-ch-body hover:bg-ch-green-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green"
                      >
                        {/* A FAVOURITE IS ONE DIVISION, not a park, so it cannot collapse
                            to the park name the way a search hit does — that would name a
                            different thing. It gets the same TWO-LINE shape instead: park
                            in bold, the division beneath in muted text. The site ranges
                            stay on the second line, because two of Leo Carrillo's three
                            divisions are both "Canyon Campground" and the range is the
                            only thing telling them apart. */}
                        <span className="block font-semibold">
                          {parseCampgroundName(dropRedundantState(f.name, f.state)).park}
                          {placeLabel(f.city, f.state) && (
                            <span className="font-normal text-ch-muted">
                              {" · "}
                              {placeLabel(f.city, f.state)}
                            </span>
                          )}
                        </span>
                        {parseCampgroundName(f.name).division && (
                          <span className="mt-0.5 block text-ch-fine text-ch-muted">
                            {parseCampgroundName(f.name).division}
                          </span>
                        )}
                      </button>
                      <FavoriteHeart
                        favorite={favorites.isFavorite(f.id)}
                        onToggle={() => void favorites.toggle(f.id)}
                        campgroundName={f.name}
                        className="mr-1.5 bg-ch-card"
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {/* Search hits, minus anything already listed as a favourite — the
                same campground twice in one dropdown reads as a bug. */}
            {suggestions.filter((s) => !favoriteIds.has(s.id)).length > 0 && (
              <ul>
                {suggestions
                  .filter((s) => !favoriteIds.has(s.id))
                  .map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(s)}
                        className="w-full cursor-pointer border-b border-ch-line bg-ch-card px-3 py-2 text-left text-ch-body last:border-b-0 hover:bg-ch-green-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green"
                      >
                        <span className="font-semibold">
                          {parseCampgroundName(dropRedundantState(s.name, s.state)).full}
                        </span>
                        {(s.divisionCount ?? 1) > 1 && (
                          <span className="ml-1.5 rounded-full border border-ch-line bg-ch-paper px-1.5 py-0.5 text-ch-fine text-ch-muted">
                            {s.divisionCount} parts
                          </span>
                        )}
                        {placeLabel(s.city, s.state) && (
                          <span className="text-ch-muted"> · {placeLabel(s.city, s.state)}</span>
                        )}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}

        {/* WHICH PARTS OF THE PARK. Only rendered when the park actually has more than
            one bookable division — 321 parks do, and Carpinteria's four were being
            watched as four separate hand-made watches before this existed.
            Each checked box becomes its own watch, because a watch is keyed to one
            campground; the screen removes the repetition, not the rows. */}
        {divisions.length > 1 && (
          <fieldset className="mt-5">
            <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
              Which parts of the park
            </legend>
            <div className="rounded-[13px] border border-ch-line bg-ch-card">
              <div className="flex items-center justify-between gap-2 border-b border-ch-line px-3 py-2">
                <span className="text-ch-fine text-ch-muted">
                  {chosen.size} of {divisions.length} selected
                </span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setChosen(defaultChosen(divisions))}
                    className="rounded-lg px-2 py-1 text-ch-fine font-bold text-ch-green hover:bg-ch-green-soft"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setChosen(new Set())}
                    className="rounded-lg px-2 py-1 text-ch-fine font-bold text-ch-muted hover:bg-ch-green-soft hover:text-ch-ink"
                  >
                    None
                  </button>
                </div>
              </div>
              {/* Scrolls rather than growing: three parks in the catalog have twenty or
                  more divisions and Ohio's Grand Lake St. Marys has seventy, which
                  would otherwise push the date picker off the screen. */}
              <ul className="max-h-64 divide-y divide-ch-line overflow-y-auto overscroll-contain">
                {divisions.map((d) => (
                  <li key={d.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-ch-green-soft">
                      <input
                        type="checkbox"
                        checked={chosen.has(d.id)}
                        onChange={() =>
                          setChosen((prev) => {
                            const next = new Set(prev);
                            if (next.has(d.id)) next.delete(d.id);
                            else next.add(d.id);
                            return next;
                          })
                        }
                        className="mt-0.5 size-4 shrink-0 accent-ch-green"
                      />
                      {/* The division only — the park name is already the heading and
                          the field above. The trailing "(sites 25-77, ...)" STAYS: two
                          of Leo Carrillo's three divisions are both "Canyon
                          Campground" and the site range is the only thing telling
                          them apart. */}
                      <span className="text-ch-body">{divisionLabel(d.name)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            {tooManyDivisions && (
              <p role="alert" className="mt-2 px-0.5 text-ch-fine text-ch-alert">
                {chosen.size} parts selected — the most a single watch can cover is{" "}
                {MAX_DIVISIONS_PER_WATCH}. Untick a few.
              </p>
            )}
            <p className="mt-2 px-0.5 text-ch-fine leading-normal text-ch-muted">
              All the parts you keep are watched under ONE watch, so a whole park still
              counts as one of your {WATCH_LIMIT}. Up to {MAX_DIVISIONS_PER_WATCH}.
            </p>
          </fieldset>
        )}

        <fieldset className="mt-5">
          <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
            Which nights
          </legend>
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Chip size="sm" selected={mode === "exact" && !isThisWeekend} onClick={() => setMode("exact")}>
              Exact dates
            </Chip>
            {/* A SHORTCUT, not a third mode. It fills in the coming Fri->Sun and leaves
                the watch on exact dates, because that is what it is — two named nights.
                Modelling it as a mode would mean a third branch through validation and
                the submit payload for something that only differs by which dates are
                prefilled. It reads as selected only while the range still IS that
                weekend, so nudging a date afterwards doesn't leave a lying chip. */}
            <Chip
              size="sm"
              selected={mode === "exact" && isThisWeekend}
              onClick={() => {
                setMode("exact");
                setRange(thisWeekendRange());
              }}
            >
              This weekend
            </Chip>
            <Chip size="sm" selected={mode === "flexible"} onClick={() => setMode("flexible")}>
              Flexible
            </Chip>
          </div>

          {mode === "flexible" && (
            <div className="mb-2.5">
              <NightsPicker
                nights={flexNights}
                onNightsChange={setFlexNights}
                weekendsOnly={weekendsOnly}
                onWeekendsOnlyChange={setWeekendsOnly}
              />
            </div>
          )}

          <DatePicker
            value={range}
            onChange={setRange}
            label={mode === "flexible" ? "Window to watch" : "Trip dates"}
            meta={
              mode === "flexible" && range.start
                ? `any ${flexNights}-night${weekendsOnly ? " weekend" : ""} stay in this window`
                : undefined
            }
            minDate={todayISO()}
            defaultMonth={range.start ?? addDays(todayISO(), 1)}
          />
          {flexTooLong && (
            <p role="alert" className="mt-1.5 text-ch-fine text-ch-alert">
              {/* {' '} because the &apos; below makes SWC eat this node's leading
                  space — it rendered "3nights doesn't fit". */}
              {flexNights}{' '}
              nights doesn&apos;t fit in a {windowNights}-night window. Widen the
              window or shorten the stay.
            </p>
          )}
        </fieldset>

        {/*
          THE FILTER PANEL IS GONE FROM THIS SCREEN (2026-08-15), and its legend said why:
          "What counts as a match". It did not.

          Measured: `grep -rn "site_type\|siteType" worker/` returns ZERO hits, and
          `loadWatches` does not even SELECT the column. So a user picked RV, we sent it, and
          the poller alerted them for tent sites. Of the five controls only `siteType` was
          ever transmitted at all — rvLength, electric, showers and pets were collected here
          and dropped on submit.

          THIS IS THE SAME FILE'S SECOND OFFENCE. The auto-cart toggle a few lines below
          carries a comment recording that it was "PURELY DECORATIVE until 2026-08-01".

          WHY REMOVED RATHER THAN IMPLEMENTED. Making the poller honour it is the answer
          users would prefer, and it is a bigger job than it looks: our four buckets
          (tent/RV/cabin/group) have to map onto rec.gov's `campsite_type` vocabulary AND
          ReserveCalifornia's AND UseDirect's AND GoingToCamp's, and every source whose site
          records lack a type needs a deliberate include-or-exclude answer. Get that wrong in
          the strict direction and alerting stops silently, with no error anywhere — the
          failure mode this codebase has paid for repeatedly. A filter that works on rec.gov
          and quietly does not elsewhere is worse than none, because nothing tells the user
          which they got.

          What replaces it is better and already honoured by the poller: PER-SITE MUTING,
          which is explicit, source-agnostic, and excluded by both RC finders since
          2026-08-13. Implement type filtering later if the taxonomy work is funded; until
          then this screen promises only what it delivers.

          THE SAME PANEL STAYS ON EXPLORE, where it genuinely works — search resolves it to
          `p_site_type = ANY(c.site_types)` against the campground catalog. The defect was
          never the panel, it was this screen implying a watch would honour it.
        */}

        {/*
          MUTING, HERE AS WELL AS ON /manage/<token> (2026-08-15).

          The owner's reason: "most people won't know there is a mute section in manage
          watches, so if it is here also it will be more used." A control the poller
          genuinely honours was reachable only from a screen users arrive at by tapping a
          link in an alert — i.e. after the noise they wanted to avoid.

          It is also what REPLACES the site-type picker removed above: the only working way
          to say "not that kind of site" is to name the sites. Explicit and source-agnostic,
          rather than a taxonomy that would work on rec.gov and quietly not elsewhere.

          COLLAPSED BY DEFAULT. Muting nothing is the right default and the overwhelmingly
          common case; an open list of 300 sites between the dates and the submit button
          would bury the two controls that matter. Only rendered once a campground is
          chosen, because there is nothing to enumerate before that.

          IT COVERS EVERY CHECKED DIVISION, and an earlier version did not — it was hidden
          outright for any multi-division park, which is how the owner found Leo Carrillo
          offering no mute list at all (reported 2026-08-15). The reasoning then was that
          one submit made one watch PER division, so no single inventory described it. That
          stopped being true when a park became ONE watch: `muted_site_ids` is one column
          covering the whole watch, and campsite ids are unique WITHIN a park (10,757
          sampled, zero collisions), so listing every checked division is correct.

          Still keyed to `targets`, never to the park, so the list can only ever offer ids
          belonging to campgrounds this watch actually covers.
        */}
        {targets.length > 0 && (
          <div className="mt-5">
            <Collapsible
              label="Mute individual campsites"
              summary={muted.size ? `${muted.size} muted` : "optional"}
            >
              <p className="pb-2 text-ch-fine leading-normal text-ch-muted">
                Only want a handful of sites? Mute all, then unmute the ones you&apos;d
                actually take — we&apos;ll only wake you for those. You can change this any
                time from the watch.
              </p>
              <SiteMuteList
                campgroundIds={targets.map((t) => t.id)}
                divisionNames={Object.fromEntries(divisions.map((d) => [d.id, divisionLabel(d.name)]))}
                onInventory={pruneMutes}
                month={(range.start ?? todayISO()).slice(0, 7)}
                muted={muted}
                onChange={muteLocally}
                emptyMessage="We can't list this campground's individual sites, so there's nothing to mute. You'll still get alerts for the whole campground."
              />
            </Collapsible>
          </div>
        )}

        {canAutoCart && (
          <fieldset className="mt-5">
            <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
              Auto-cart
            </legend>
            <button
              type="button"
              onClick={() => setAutoCart(!autoCart)}
              aria-pressed={autoCart}
              className="flex w-full cursor-pointer items-center gap-3 rounded-ch-input border border-ch-line bg-ch-card px-3.5 py-3 text-left hover:border-ch-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ch-green"
            >
              <span className="flex-1">
                <span className="block text-ch-body font-bold">Add it to my cart automatically</span>
                <span className="mt-0.5 block text-ch-fine leading-normal text-ch-muted">
                  We put the site in your Recreation.gov cart the moment it opens, so it&apos;s
                  waiting when your phone buzzes.
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`relative h-6 w-10 shrink-0 rounded-full transition-colors motion-reduce:transition-none ${autoCart ? "bg-ch-green" : "bg-[#D3DBD2]"}`}
              >
                <span
                  className={`absolute top-[3px] size-[18px] rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${autoCart ? "translate-x-[19px]" : "translate-x-[3px]"}`}
                />
              </span>
            </button>
            {autoCart && <TrustPanel className="mt-2.5" />}
          </fieldset>
        )}

        {/* RESERVECALIFORNIA GETS A STATEMENT, AND IT IS NOT A REVERSAL OF THE CALL BELOW.
            That call removed a paragraph that INTRODUCED auto-cart and then WITHDREW it —
            three lines teaching the reader why they cannot have something. This is the
            opposite: for RC we can genuinely hold a site at its release, it has worked on a
            real morning, and until now the only way to discover it was to receive an alert.
            The owner hit exactly that on 2026-08-17 — "no sign of auto cart" on a Carpinteria
            watch, where the capability exists and nothing said so.

            THERE IS NO TOGGLE BECAUSE THERE IS NOTHING TO SET. An RC hold is offered per
            release, the night before, and only a tap authorises it — the poller records the
            offer and the bot never takes a site nobody asked for. A switch here would imply
            a standing consent this product deliberately does not take. So the panel says
            what will happen and where the decision lands, and nothing more. */}
        {canRcHold && (
          <div className="mt-5 rounded-ch-input border border-ch-line bg-ch-card px-3.5 py-3">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ch-body font-bold">We can grab a site at 8am</span>
              <span className="rounded-full bg-ch-sand px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ch-green-deep">
                {AUTOCART_BETA_LABEL}
              </span>
            </p>
            <p className="mt-1 text-ch-fine leading-normal text-ch-muted">
              ReserveCalifornia releases cancelled sites at 8am. The night before, we&apos;ll
              tell you which site is opening and offer to cart it the second it does —
              you decide then, site by site. Nothing to switch on here.
            </p>
            <p className="mt-1.5 text-ch-fine leading-normal text-ch-muted">
              {AUTOCART_BETA_NOTE}
            </p>
          </div>
        )}

        {/* NOTHING IS SAID HERE WHEN AUTO-CART IS UNAVAILABLE (2026-08-16, owner's call).
            This used to explain, in three lines, that auto-cart is Recreation.gov only and
            why ReserveCalifornia carts cannot follow you to your phone. It was accurate and
            it was answering a question nobody on this screen had asked: the toggle simply
            is not there, so the paragraph introduced a feature, withdrew it, and taught the
            reader a session-scoping detail about somebody else's shopping cart — all while
            they were trying to pick dates. The alert still arrives, which is the only part
            that affects them, and the watch summary beside this form already says so. */}
      </form>

      <aside className="rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-4">
        <h2 className="font-ch-display text-[13.5px] font-bold text-ch-green-deep">
          What we&apos;ll do
        </h2>
        {/* TWO JOBS, and they're different jobs.
            Once a campground is chosen this panel is a RECEIPT — it reads back
            exactly what's about to be created, so nobody sets up a watch on the
            wrong dates. Before that it was a single line that assumed the reader
            already knew what a watch was, which is precisely the person who
            doesn't. Empty state now explains the feature and the three steps;
            it's replaced by the summary the moment there's something to confirm. */}
        {campgroundId ? (
          <p className="mt-2 text-ch-body leading-relaxed text-ch-green-deep">
            Watch <strong className="font-extrabold">{campgroundName || "this campground"}</strong>{" "}
            for{" "}
            {mode === "flexible" ? (
              <>
                any <strong className="font-extrabold">{flexNights}-night</strong>
                {weekendsOnly ? " weekend" : ""} opening
              </>
            ) : (
              <strong className="font-extrabold">{formatRange(range.start, range.end) ?? "your dates"}</strong>
            )}
            {mode === "flexible" && range.start && (
              <> between <strong className="font-extrabold">{formatRange(range.start, range.end)}</strong></>
            )}
            , checking every 15 seconds. We&apos;ll text, email and push you the moment a site frees
            up — you don&apos;t need to keep this open.
          </p>
        ) : (
          <>
            <p className="mt-2 text-ch-body leading-relaxed text-ch-green-deep">
              A watch is a robot that refreshes a booked campground for you. We check it{" "}
              <strong className="font-extrabold">every 15 seconds, around the clock</strong>, and the
              instant someone cancels we text, email and push you — so you get the site instead of
              the next person hitting refresh.
            </p>
            <ol className="mt-3">
              {[
                ["Pick the campground", "Search by name above. Your favorites show up when you tap the box."],
                [
                  "Choose your nights",
                  // Flexible = how many nights + the window to search. Naming a
                  // number here read as though two was the only option.
                  "Exact dates, or Flexible: set how many nights you want and the date range to look in. Three nights anywhere in September gives us far more chances to catch a cancellation than one fixed weekend.",
                ],
                ["Start watching", "Then close the app. We'll find you when something opens."],
              ].map(([title, sub], i) => (
                <li
                  key={title}
                  className="flex gap-2.5 border-b border-[#BFDDC9] py-2.5 last:border-b-0"
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white text-[11px] font-extrabold text-ch-green-deep">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block text-ch-meta font-bold text-ch-green-deep">{title}</span>
                    <span className="mt-0.5 block text-ch-fine leading-normal text-ch-green-deep/80">
                      {sub}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-ch-fine leading-normal text-ch-green-deep/80">
              On Recreation.gov we can go one better and drop the site straight into your cart, so
              it&apos;s held while you get to your phone.
            </p>
          </>
        )}

        <div className="mt-4">
          {/* THE CONTROL HAS TO MATCH WHO'S READING IT. This used to render "Start
              watching" to everyone, including signed-out visitors, who could only
              discover it wouldn't work by pressing it. Now a visitor who cannot
              create a watch gets the step that IS available to them, and the
              submit button stays for people it can actually serve.

              `gate === "ready"` covers a failed status lookup as well as a real
              subscriber, so a billing hiccup never demotes a paying customer to a
              signup prompt. The post-submit messages below still handle the case
              where the server disagrees with what the client believed. */}
          {gate === "signedOut" || gate === "needsSub" ? (
            <SubscribeCta fallbackReturnTo="/new" fullWidth />
          ) : (
            <Button
              type="submit"
              fullWidth
              disabled={saving || flexTooLong || tooManyDivisions || gate === "loading"}
              onClick={() => void submit()}
            >
              {saving ? "Setting up…" : "Start watching"}
            </Button>
          )}
        </div>

        {/* THE ONE PLACE A PRICE COULD STILL REACH THE NATIVE APP. WatchCta gates
            the entry points, but this message is driven by the server's answer to
            a submit, so it renders on /new however the user got there — and a
            price plus a link into Stripe checkout is exactly what Apple and
            Google forbid. Native gets the same fact without either. */}
        {needsSubscription && (
          <p className="mt-2.5 text-ch-fine leading-normal text-ch-ochre-ink">
            {isNative ? (
              NATIVE_LINKOUT ? (
                <>
                  Watches need a subscription.{" "}
                  <a href={SUBSCRIBE_HREF} data-native-external="true" className="font-bold underline">
                    Subscribe at camphawk.app
                  </a>
                  , then come back and press Start watching — nothing you&apos;ve entered is lost.
                </>
              ) : (
                "Watches need a subscription. Manage your plan at camphawk.app, then come back and press Start watching — nothing you've entered is lost."
              )
            ) : (
              <>
                Watches need a subscription — from $2.50/mo after a 7-day free trial.{" "}
                <a className="font-bold underline" href="/pricing">
                  Compare plans
                </a>
              </>
            )}
          </p>
        )}
        {signedOut && (
          <p role="alert" className="mt-2.5 text-ch-fine leading-normal text-ch-alert">
            Your session expired before we could save this.{" "}
            <Link className="font-bold underline" href="/sign-in">
              Sign in
            </Link>{" "}
            and press Start watching again — nothing you&apos;ve entered is lost.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2.5 text-ch-fine text-ch-alert">
            {error}
          </p>
        )}
      </aside>
    </div>
  );
}
