"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import Button, { buttonClasses } from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import DatePicker, { type DateRange } from "@/components/ui/DatePicker";
import FilterPanel, { EMPTY_FILTERS, type FilterValue } from "@/components/ui/FilterPanel";
import NightsPicker from "@/components/ui/NightsPicker";
import ResultCard from "./ResultCard";
import { useFavorites } from "./useFavorites";
import { SubscribeLink, subscribeSentence } from "./nativeSubscribe";
import { useSubscription } from "./useSubscription";
import SubscribeCta, { useAccountGate } from "./SubscribeCta";
import { useIsNativeApp } from "@/lib/native/context";
import { campgroundsRounded } from "@/lib/coverage";
import dynamic from "next/dynamic";
import { addDays, todayISO, thisWeekendRange, type ISODate } from "@/components/ui/date";
import { deviceCoords, hitLabel, ipCoords, searchLocations, type LocationHit } from "./geo";
import { LocateFixed, MapPin, Tent } from "lucide-react";
import type { Campground } from "@/lib/types";

/**
 * Explore — location + dates + filters, then live results.
 *
 * Talks to the EXISTING /api/search with the existing params. No data-layer
 * change: this is the same query the current UI issues, wearing the new controls.
 *
 * The two shared controls (DatePicker, FilterPanel) are imported, not
 * reimplemented — New watch mounts the same two. That single-source rule is the
 * whole point of phase 3, and the reason the current UI drifted.
 */

// mapbox-gl touches `window` at import time, so the map is client-only.
const ResultsMap = dynamic(() => import("./ResultsMap"), {
  ssr: false,
  loading: () => (
    <div className="h-[300px] animate-pulse rounded-ch-card border border-ch-line bg-ch-card motion-reduce:animate-none sm:h-[360px]" />
  ),
});

const RADII = [10, 25, 50, 100, 200];

/** Start tight. Most people search the place they're actually going, and a 50-mile
 *  default buried the campground they had in mind under everything within an hour's
 *  drive of it. Widening is one tap; noticing you were shown the wrong thing is not. */
const DEFAULT_RADIUS = 10;

type WhenPreset = "exact" | "tonight" | "weekend" | "flexible";

/** Next Friday→Sunday. Matches the existing QuickFilters helper's intent. */

/**
 * The search, as a query string.
 *
 * This exists so leaving Explore isn't destructive. Drilling into a campground
 * used to mean retyping the place, the dates and every filter to get back to
 * the same twelve results — the detail page's "Back to search" landed on an
 * empty form. Now the state round-trips through the URL: the detail link
 * carries it, the back link hands it straight back, and as a side effect a
 * search becomes a shareable link.
 *
 * Only what changes the RESULTS is encoded. `selectedId` is deliberately left
 * out: which pin was clicked is a view detail, not part of the search.
 */
interface SearchState {
  place: string;
  coords: { lat: number; lng: number } | null;
  radius: number;
  when: WhenPreset;
  range: DateRange;
  flexNights: number;
  weekendsOnly: boolean;
  filters: FilterValue;
}

function encodeSearch(s: SearchState): string {
  const q = new URLSearchParams();
  if (s.coords) {
    // 5dp is ~1m. More is noise in a URL a user might read or send.
    q.set("lat", s.coords.lat.toFixed(5));
    q.set("lng", s.coords.lng.toFixed(5));
  }
  if (s.place) q.set("place", s.place);
  q.set("radius", String(s.radius));
  if (s.when !== "exact") q.set("when", s.when);
  if (s.range.start) q.set("start", s.range.start);
  if (s.range.end) q.set("end", s.range.end);
  if (s.when === "flexible") q.set("nights", String(s.flexNights));
  if (s.weekendsOnly) q.set("weekends", "1");
  if (s.filters.siteType) q.set("type", s.filters.siteType);
  if (s.filters.rvLength) q.set("rv", String(s.filters.rvLength));
  for (const k of ["electric", "showers", "pets"] as const) {
    if (s.filters[k]) q.set(k, "1");
  }
  return q.toString();
}

function decodeSearch(q: URLSearchParams): Partial<SearchState> {
  const lat = Number(q.get("lat"));
  const lng = Number(q.get("lng"));
  const radius = Number(q.get("radius"));
  const nights = Number(q.get("nights"));
  const rv = Number(q.get("rv"));
  const when = q.get("when");
  const type = q.get("type");
  return {
    coords: Number.isFinite(lat) && Number.isFinite(lng) && q.has("lat") ? { lat, lng } : null,
    place: q.get("place") ?? "",
    radius: RADII.includes(radius) ? radius : DEFAULT_RADIUS,
    when: when === "tonight" || when === "weekend" || when === "flexible" ? when : "exact",
    range: { start: (q.get("start") as ISODate | null) ?? null, end: (q.get("end") as ISODate | null) ?? null },
    flexNights: Number.isFinite(nights) && nights > 0 ? nights : 2,
    weekendsOnly: q.get("weekends") === "1",
    filters: {
      ...EMPTY_FILTERS,
      siteType: type === "tent" || type === "rv" || type === "cabin" || type === "group" ? type : null,
      rvLength: Number.isFinite(rv) && rv > 0 ? rv : null,
      electric: q.get("electric") === "1",
      showers: q.get("showers") === "1",
      pets: q.get("pets") === "1",
    },
  };
}


/**
 * The closing line of the Explore first-run box, matched to who's reading it.
 *
 * It used to end with "Or browse campgrounds by state", which sent someone who
 * had just been told about watches sideways into a directory. The last thing on
 * a first-run panel should be the next step FOR THIS READER, and that differs:
 *
 *   signed out    -> the trial is the unlock, so say what it unlocks
 *   signed in, no sub -> already has an account; don't offer a trial they may
 *                    have used, and don't re-explain signing up
 *   subscribed    -> nothing. They have everything; a sales line here is noise.
 *   still loading / unknown -> nothing, rather than flashing the wrong pitch at
 *                    a paying subscriber. Same rule WatchCta follows.
 */
function ExploreAccountCta() {
  const { loaded, signedIn, subscribed, everSubscribed, unknown } = useSubscription();
  const isNative = useIsNativeApp();

  if (!loaded || unknown || subscribed) return null;

  // In the native app we never render a checkout route — Apple and Google
  // require digital subscriptions to go through in-app purchase.
  if (isNative) {
    return (
      <p className="mt-3 text-ch-fine leading-normal text-ch-green-deep/80">
        Watching booked campgrounds needs a subscription. {subscribeSentence()}{" "}
        <SubscribeLink className="text-ch-green-deep" />
      </p>
    );
  }

  return (
    <p className="mt-3 text-ch-fine leading-normal text-ch-green-deep/80">
      {signedIn
        ? "Watches, text alerts and auto-cart come with a subscription. "
        : "Searching is free and needs no account. Watches, text alerts and auto-cart need one. "}
      <a
        className="font-bold text-ch-green-deep underline underline-offset-2"
        href={signedIn ? "/" : "/sign-up"}
      >
        {signedIn
          ? everSubscribed
            ? "Resubscribe"
            : "Start your free trial"
          : "Start a 7-day free trial"}
      </a>
    </p>
  );
}

/**
 * The banner above the search rail, which now covers TWO account states rather
 * than one.
 *
 * It used to render only for signed-out guests, which left the person closest to
 * paying — signed in, no subscription — with no banner at all and no way to act
 * from this screen. Both now get the same box with the copy and the control that
 * fit them:
 *
 *   guest        -> search is free, an account is what unlocks watching
 *   free account -> the account isn't the missing piece, the subscription is
 *   subscribed   -> nothing. Selling to a customer is noise.
 *   loading/unknown -> nothing, rather than flashing a pitch at a subscriber.
 *
 * "Live availability is free and always will be" stays in both, because it is the
 * thing that makes the box read as context rather than a paywall — and it's true.
 */
function ExploreStatusBox() {
  const { gate } = useAccountGate();
  if (gate === "loading" || gate === "ready") return null;

  const guest = gate === "signedOut";

  return (
    <div className="mb-4 rounded-[13px] border border-[#C6D3EC] bg-[#EEF2FA] px-3.5 py-3">
      <p className="text-ch-body font-bold">
        {guest ? "You're searching as a guest" : "You're searching with a free account"}
      </p>
      <p className="mt-1 text-ch-meta leading-normal text-ch-ink-2">
        {guest
          ? "Live availability is free and always will be. An account is only needed to watch a campground that's already booked."
          : "Live availability is free and always will be. Watching a booked campground — and the text the moment someone cancels — needs a subscription."}
      </p>
      <SubscribeCta fallbackReturnTo="/search" className="mt-2.5" />
      <Link
        href="/watches"
        className="mt-2 inline-block text-ch-body font-bold text-ch-green hover:text-ch-green-deep"
      >
        See what a watch does
      </Link>
    </div>
  );
}

export default function Explore() {
  // Read client-side via Clerk rather than from the server. The root layout must
  // stay free of request-time APIs under Cache Components — reading auth there
  // is what 500'd every page in July.
  const { isLoaded, isSignedIn } = useAuth();
  const guest = isLoaded && !isSignedIn;
  // One store for every heart on the page — see ./useFavorites.
  const favorites = useFavorites();

  const [place, setPlace] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [suggestions, setSuggestions] = useState<LocationHit[]>([]);
  const [locating, setLocating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Origin used for the CURRENT results, so panning the form does not move the
  // map out from under pins that belong to the previous search.
  const [searchedAt, setSearchedAt] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState(DEFAULT_RADIUS);

  const [when, setWhen] = useState<WhenPreset>("exact");
  const [range, setRange] = useState<DateRange>({ start: null, end: null });
  const [flexNights, setFlexNights] = useState(2);
  const [weekendsOnly, setWeekendsOnly] = useState(false);

  const [filters, setFilters] = useState<FilterValue>(EMPTY_FILTERS);

  const [results, setResults] = useState<Campground[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow earlier search overwriting a newer one.
  const requestId = useRef(0);
  // Set once the URL has been read, so the first render can't overwrite a
  // restored search with the empty defaults.
  const hydrated = useRef(false);
  // Set when the restored state should fire a search as soon as it's applied.
  const [restoring, setRestoring] = useState(false);

  // Restore a search from the URL. This runs before anything else touches the
  // form so a returning user sees their results, not a blank page.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const q = new URLSearchParams(window.location.search);
    if (![...q.keys()].length) return;
    const d = decodeSearch(q);
    if (d.place !== undefined) setPlace(d.place);
    if (d.coords) setCoords(d.coords);
    if (d.radius) setRadius(d.radius);
    if (d.when) setWhen(d.when);
    if (d.range) setRange(d.range);
    if (d.flexNights) setFlexNights(d.flexNights);
    if (d.weekendsOnly !== undefined) setWeekendsOnly(d.weekendsOnly);
    if (d.filters) setFilters(d.filters);
    // Only auto-run with an origin. Without one the search would fall back to
    // geolocation and quietly answer a different question than the link asked.
    if (d.coords) setRestoring(true);
  }, []);

  useEffect(() => {
    if (place.trim().length < 2 || coords) {
      setSuggestions([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        setSuggestions(await searchLocations(place, ac.signal));
      } catch {
        /* suggestions are a convenience; failing quietly is correct */
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [place, coords]);

  /** "Use my location" — device position, IP as a coarse fallback. */
  const locateMe = useCallback(async () => {
    setLocating(true);
    setError(null);
    try {
      const found = (await deviceCoords()) ?? (await ipCoords());
      if (!found) {
        setError("We couldn't get your location. Type a place instead.");
        return;
      }
      setCoords(found);
      setPlace("My location");
      setSuggestions([]);
    } finally {
      setLocating(false);
    }
  }, []);

  const choosePreset = (p: WhenPreset) => {
    setWhen(p);
    if (p === "tonight") setRange({ start: todayISO(), end: addDays(todayISO(), 1) });
    else if (p === "weekend") setRange(thisWeekendRange());
    else if (p === "flexible") {
      const start = todayISO();
      setRange({ start, end: addDays(start, 30) });
    }
  };

  const search = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    // Searching with nothing entered means "near me" — asking the user to type a
    // place they're already standing in is a pointless gate. Device position
    // first, IP as a coarse fallback; only if BOTH fail do we ask for input.
    let origin = coords;
    if (!origin) {
      setLocating(true);
      try {
        origin = (await deviceCoords()) ?? (await ipCoords());
      } finally {
        setLocating(false);
      }
      if (!origin) {
        setLoading(false);
        setError("Type a place to search around — we couldn't get your location.");
        return;
      }
      setCoords(origin);
      if (!place.trim()) setPlace("Near me");
    }

    const qs = new URLSearchParams({
      lat: String(origin.lat),
      lng: String(origin.lng),
      radius: String(radius),
    });
    if (range.start) qs.set("startDate", range.start);
    if (range.end) qs.set("endDate", range.end);
    if (when === "flexible") qs.set("flexNights", String(flexNights));
    if (filters.siteType) qs.set("siteType", filters.siteType);
    if (filters.siteType === "rv" && filters.rvLength) qs.set("rvLength", String(filters.rvLength));

    // Amenity strings must match the catalog values exactly — the RPC does
    // `p_amenities <@ c.amenities`, so a typo silently returns nothing.
    const amenities: string[] = [];
    if (filters.electric) amenities.push("electric hookup");
    // No "drinking water" line: the chip was removed 2026-08-15. Its amenity is
    // rec.gov-only, so ticking it silently excluded every state-portal campground.
    if (filters.showers) amenities.push("showers");
    if (amenities.length) qs.set("amenities", amenities.join(","));

    try {
      const r = await fetch(`/api/search?${qs}`);
      if (!r.ok) throw new Error(`Search failed (${r.status})`);
      const j = (await r.json()) as { campgrounds: Campground[] };
      if (id !== requestId.current) return; // a newer search already landed
      // pets has no SQL param — filtered client-side off the returned column,
      // same as the current UI does.
      const rows = filters.pets ? j.campgrounds.filter((c) => c.petsAllowed) : j.campgrounds;
      setResults(rows);
      setSearchedAt(origin);
      setSelectedId(null);
      // Reflect the search in the address bar. replaceState, not push: each
      // search is a refinement of the same screen, and pushing would make Back
      // walk through every radius the user tried instead of leaving the page.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${encodeSearch({
          place,
          coords: origin,
          radius,
          when,
          range,
          flexNights,
          weekendsOnly,
          filters,
        })}`,
      );
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [coords, place, radius, range, when, flexNights, weekendsOnly, filters]);

  // Fire the restored search once the state from the URL has actually landed.
  useEffect(() => {
    if (!restoring || !coords) return;
    setRestoring(false);
    void search();
  }, [restoring, coords, search]);

  // Must agree with ResultCard: with no dates the API never checked availability,
  // so claiming "N with openings" in the heading while every card stays silent
  // about it is the same wrong answer twice, phrased two different ways.
  // Selected-first ordering for the map hoist. Stable otherwise, so the list
  // doesn't reshuffle for any other reason.
  const orderedResults = (() => {
    if (!results || !selectedId) return results;
    const picked = results.find((c) => c.id === selectedId);
    if (!picked) return results;
    return [picked, ...results.filter((c) => c.id !== selectedId)];
  })();

  // The query string for the CURRENT form. Handed to every result card so the
  // detail page can send the user back to exactly this search.
  const searchQuery = encodeSearch({
    place,
    coords,
    radius,
    when,
    range,
    flexNights,
    weekendsOnly,
    filters,
  });

  const datesChosen = Boolean(range.start && range.end);
  const openCount = datesChosen
    ? (results?.filter((c) => c.hasAvailability === true).length ?? 0)
    : 0;

  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
      {/* Guests get context, not a paywall. Search really is free, and saying so
          plainly converts better than hiding results behind a wall. */}
      <ExploreStatusBox />

      <div className="grid items-start gap-5 lg:grid-cols-[var(--ch-rail)_minmax(0,1fr)]">
        {/* ---------------- search rail ---------------- */}
        <form
          className="min-w-0 rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-pop"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <label htmlFor="v2-where" className="mb-2 block text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
            Where
          </label>
          <div className="relative">
            <input
              id="v2-where"
              value={place}
              onChange={(e) => {
                setPlace(e.target.value);
                setCoords(null); // typing invalidates the previously chosen point
              }}
              placeholder="City, park, or ZIP"
              autoComplete="off"
              className="w-full rounded-ch-input border border-ch-line bg-ch-card py-3 pl-3.5 pr-11 font-ch-display text-[14px] font-semibold text-ch-ink placeholder:text-ch-faint focus-visible:border-ch-green focus-visible:outline-none"
            />
            <button
              type="button"
              onClick={() => void locateMe()}
              disabled={locating}
              title="Use my location"
              aria-label="Use my location"
              className="absolute inset-y-0 right-0 grid w-11 cursor-pointer place-items-center rounded-r-ch-input text-ch-muted hover:text-ch-green disabled:cursor-wait focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green"
            >
              <LocateFixed
                aria-hidden="true"
                className={locating ? "size-4 animate-pulse motion-reduce:animate-none" : "size-4"}
              />
            </button>
          </div>
          {suggestions.length > 0 && (
            <ul className="mt-1 overflow-hidden rounded-ch-input border border-ch-line">
              {suggestions.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setPlace(hitLabel(hit));
                      setCoords({ lat: hit.lat, lng: hit.lng });
                      setSuggestions([]);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2.5 border-b border-ch-line bg-ch-card px-3 py-2 text-left text-ch-body last:border-b-0 hover:bg-ch-green-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green"
                  >
                    {/* The icon says which KIND of result this is — a campground
                        you can watch, or a town to search around. Without it the
                        two are indistinguishable in one flat list. */}
                    {hit.kind === "campground" ? (
                      <Tent aria-hidden="true" className="size-3.5 shrink-0 text-ch-green" />
                    ) : (
                      <MapPin aria-hidden="true" className="size-3.5 shrink-0 text-ch-muted" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold">{hit.name}</span>
                      {hit.kind === "campground" && hit.city && hit.city !== hit.name && (
                        <span className="text-ch-muted">
                          {" "}
                          · {hit.city}
                          {hit.state ? `, ${hit.state}` : ""}
                        </span>
                      )}
                      {hit.kind === "place" && hit.name.includes(",") && null}
                    </span>
                    <span className="shrink-0 text-ch-fine text-ch-faint">
                      {hit.kind === "campground" ? "campground" : "place"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <fieldset className="mt-4">
            <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">Within</legend>
            <div className="flex flex-wrap gap-1.5">
              {RADII.map((r) => (
                <Chip key={r} size="sm" selected={radius === r} onClick={() => setRadius(r)}>
                  {r} mi
                </Chip>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">When</legend>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {([
                ["exact", "Exact dates"],
                ["tonight", "Tonight"],
                ["weekend", "This weekend"],
                ["flexible", "Flexible"],
              ] as Array<[WhenPreset, string]>).map(([k, label]) => (
                <Chip key={k} size="sm" selected={when === k} onClick={() => choosePreset(k)}>
                  {label}
                </Chip>
              ))}
            </div>

            {when === "flexible" && (
              <div className="mb-2.5">
                <NightsPicker
                  nights={flexNights}
                  onNightsChange={setFlexNights}
                  weekendsOnly={weekendsOnly}
                  onWeekendsOnlyChange={setWeekendsOnly}
                  // Search flex is intentionally looser than watch flex: the
                  // weekend constraint is enforced by the watch, not by discovery.
                  showWeekendsOnly={false}
                />
              </div>
            )}

            <DatePicker
              value={range}
              onChange={(v) => {
                setRange(v);
                if (when !== "flexible") setWhen("exact");
              }}
              label={when === "flexible" ? "Search window" : "Trip dates"}
              meta={
                when === "flexible" && range.start
                  ? `any ${flexNights}-night stay in this window`
                  : undefined
              }
            />
          </fieldset>

          <div className="mt-4">
            <FilterPanel value={filters} onChange={setFilters} />
          </div>

          <div className="mt-4">
            <Button type="submit" fullWidth disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-ch-fine text-ch-alert">
              {error}
            </p>
          )}
        </form>

        {/* ---------------- results ---------------- */}
        <section className="min-w-0" aria-live="polite" aria-busy={loading}>
          {results === null && !loading && (
            /* FIRST-RUN EXPLAINER, not a placeholder.
               This is the first thing a new visitor sees, and "Where are you
               headed?" assumed they already knew what this screen was for and
               what to do with it. It now says what Explore does, walks the three
               controls in the order they're laid out, and answers the question
               that actually stops people: "everything's booked, now what?" —
               which is the whole product. It disappears the moment there are
               results, so it costs a returning user nothing. */
            <div className="rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-5 sm:p-6">
              <h2 className="font-ch-display text-ch-h font-bold text-ch-green-deep">
                Find a campsite that&apos;s actually open
              </h2>
              <p className="mt-1.5 max-w-[52ch] text-ch-body leading-relaxed text-ch-green-deep">
                {`Explore checks live availability at ${campgroundsRounded()} campgrounds — national forests, state parks, and everything in between — and shows you what's bookable right now.`}
              </p>

              <ol className="mt-4 max-w-[52ch]">
                {[
                  [
                    "Say where",
                    "A city, park or ZIP in the box on the left — or tap the crosshair to use your location. Leave it empty and we'll search near you.",
                  ],
                  [
                    "Say when",
                    // Don't name a night count here — Flexible asks for one. The
                    // old copy said "any 2 nights", which is just the default and
                    // made the feature sound fixed at two.
                    "Exact dates, or one tap for tonight or this weekend. Flexible is the useful one: say how many nights you need and give us a date range to hunt inside, and we'll take any stretch that long.",
                  ],
                  [
                    "Search",
                    "Green means sites are open right now. Tap any result for its full calendar, or the map to see where they are.",
                  ],
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

              {/* Its own block rather than an inline <strong> mid-paragraph.
                  The question is the hook for the paid feature and deserves to
                  be scannable, and running it inline left "Everything booked?"
                  and the sentence after it reading as one word at some widths. */}
              <div className="mt-4 border-t border-[#BFDDC9] pt-3">
                <p className="text-ch-meta font-bold text-ch-green-deep">Everything booked?</p>
                <p className="mt-1 max-w-[52ch] text-ch-fine leading-normal text-ch-green-deep/80">
                  That&apos;s what we&apos;re for. Start a watch on a full campground and
                  we&apos;ll check it every 15 seconds and text you the moment someone cancels.
                </p>
                <ExploreAccountCta />
              </div>
            </div>
          )}

          {loading && <ResultsSkeleton />}

          {results !== null && !loading && (
            <>
              <div className="mb-3.5">
                <h2 className="font-ch-display text-[19px] font-extrabold tracking-[-.03em]">
                  {openCount > 0
                    ? `${openCount} campground${openCount === 1 ? "" : "s"} with openings`
                    : `${results.length} campground${results.length === 1 ? "" : "s"} nearby`}
                </h2>
                <p className="mt-0.5 text-ch-meta text-ch-muted">
                  within {radius} mi{place ? ` of ${place}` : ""}
                </p>
              </div>

              {results.length > 0 && searchedAt && (
                <ResultsMap
                  campgrounds={results}
                  center={searchedAt}
                  radiusMiles={radius}
                  selectedId={selectedId}
                  // Selecting a pin moves that campground to the FRONT of the
                  // list rather than scrolling the page down to it. Scrolling
                  // pushed the map off-screen, so the next pin you wanted was
                  // gone; hoisting keeps the map and the answer together.
                  onSelect={setSelectedId}
                  datesChosen={datesChosen}
                  className="mb-3 h-[300px] sm:h-[360px]"
                />
              )}

              {results.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {orderedResults!.map((c) => (
                    <div
                      key={c.id}
                      id={`result-${c.id}`}
                      className={
                        selectedId === c.id
                          // Matches the selected pin, so "the red one on the map" and "the
                          // one at the top of the list" are visibly the same campground.
                          ? "rounded-ch-card ring-2 ring-ch-alert ring-offset-2 ring-offset-ch-paper"
                          : undefined
                      }
                    >
                      <ResultCard
                        campground={c}
                        startDate={range.start ?? undefined}
                        endDate={range.end ?? undefined}
                        backTo={searchQuery}
                        favorite={favorites.isFavorite(c.id)}
                        onToggleFavorite={
                          favorites.canFavorite ? () => void favorites.toggle(c.id) : undefined
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-ch-body text-ch-muted">
                  Nothing within {radius} mi. Try a wider radius.
                </p>
              )}

              {/* The conversion moment: booked isn't gone, it's watchable. */}
              {results.length > 0 && openCount < results.length && (
                <div className="mt-4 rounded-ch-card border border-dashed border-ch-line bg-white/60 p-6 text-center">
                  <h3 className="font-ch-display text-[14.5px] font-bold">
                    Nothing open for your dates?
                  </h3>
                  <p className="mx-auto mt-1.5 mb-3.5 max-w-[46ch] text-ch-body text-ch-muted">
                    The good spots are booked, not gone. Set a watch and we&apos;ll alert you within
                    seconds of a cancellation.
                  </p>
                  {/* A guest can't create a watch, so send them where the next
                      step actually is instead of into a 402 they can't read. */}
                  <Link
                    href={guest ? "/sign-up" : "/new"}
                    className={buttonClasses({ className: "px-5" })}
                  >
                    {guest ? "Start 7-day free trial" : "Create a watch"}
                  </Link>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-[188px] animate-pulse rounded-ch-card border border-ch-line bg-ch-card motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
