"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Button, { buttonClasses } from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import DatePicker, { type DateRange } from "@/components/ui/DatePicker";
import FilterPanel, { EMPTY_FILTERS, type FilterValue } from "@/components/ui/FilterPanel";
import NightsPicker from "@/components/ui/NightsPicker";
import ResultCard from "./ResultCard";
import { addDays, todayISO, type ISODate } from "@/components/ui/date";
import type { Campground } from "@/lib/types";

/**
 * Available now — location + dates + filters, then live results.
 *
 * Talks to the EXISTING /api/search with the existing params. No data-layer
 * change: this is the same query the current UI issues, wearing the new controls.
 *
 * The two shared controls (DatePicker, FilterPanel) are imported, not
 * reimplemented — New watch mounts the same two. That single-source rule is the
 * whole point of phase 3, and the reason the current UI drifted.
 */

const RADII = [10, 25, 50, 100, 200];

type WhenPreset = "exact" | "tonight" | "weekend" | "flexible";

/** Next Friday→Sunday. Matches the existing QuickFilters helper's intent. */
function thisWeekend(): DateRange {
  const today = todayISO();
  const dow = new Date(today).getDay();
  // getDay on a local-midnight Date is safe here because todayISO is local.
  const toFriday = (5 - dow + 7) % 7;
  const start = addDays(today, toFriday);
  return { start, end: addDays(start, 2) };
}

interface Suggestion {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  latitude: number;
  longitude: number;
}

export default function AvailableNow() {
  const [place, setPlace] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [radius, setRadius] = useState(50);

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

  useEffect(() => {
    if (place.trim().length < 2 || coords) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/suggest?q=${encodeURIComponent(place.trim())}`);
        if (!r.ok) return;
        const j = (await r.json()) as { campgrounds: Suggestion[] };
        setSuggestions(j.campgrounds ?? []);
      } catch {
        /* suggestions are a convenience; failing quietly is correct */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [place, coords]);

  const choosePreset = (p: WhenPreset) => {
    setWhen(p);
    if (p === "tonight") setRange({ start: todayISO(), end: addDays(todayISO(), 1) });
    else if (p === "weekend") setRange(thisWeekend());
    else if (p === "flexible") {
      const start = todayISO();
      setRange({ start, end: addDays(start, 30) });
    }
  };

  const search = useCallback(async () => {
    if (!coords) {
      setError("Pick a place to search around.");
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    const qs = new URLSearchParams({
      lat: String(coords.lat),
      lng: String(coords.lng),
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
    if (filters.water) amenities.push("drinking water");
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
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [coords, radius, range, when, flexNights, filters]);

  const openCount = results?.filter((c) => c.hasAvailability === true).length ?? 0;

  return (
    <div className="mx-auto max-w-[var(--ch-max)] px-5 py-6">
      <div className="grid items-start gap-5 lg:grid-cols-[var(--ch-rail)_minmax(0,1fr)]">
        {/* ---------------- search rail ---------------- */}
        <form
          className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-pop"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <label htmlFor="v2-where" className="mb-2 block text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
            Where
          </label>
          <input
            id="v2-where"
            value={place}
            onChange={(e) => {
              setPlace(e.target.value);
              setCoords(null); // typing invalidates the previously chosen point
            }}
            placeholder="City, park, or ZIP"
            autoComplete="off"
            className="w-full rounded-ch-input border border-ch-line bg-ch-card px-3.5 py-3 font-ch-display text-[14px] font-semibold text-ch-ink placeholder:text-ch-faint focus-visible:border-ch-green focus-visible:outline-none"
          />
          {suggestions.length > 0 && (
            <ul className="mt-1 overflow-hidden rounded-ch-input border border-ch-line">
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      // Suggestions match on name OR city, so the two are often
                      // the same word ("Big Sur, Big Sur"). Only append the city
                      // when it adds something.
                      setPlace(s.city && s.city !== s.name ? `${s.name}, ${s.city}` : s.name);
                      setCoords({ lat: s.latitude, lng: s.longitude });
                      setSuggestions([]);
                    }}
                    className="w-full cursor-pointer border-b border-ch-line bg-ch-card px-3 py-2 text-left text-ch-body last:border-b-0 hover:bg-ch-green-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green"
                  >
                    <span className="font-semibold">{s.name}</span>
                    {s.city && <span className="text-ch-muted"> · {s.city}{s.state ? `, ${s.state}` : ""}</span>}
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
        <section aria-live="polite" aria-busy={loading}>
          {results === null && !loading && (
            <div className="rounded-ch-card border border-dashed border-ch-line bg-white/60 p-8 text-center">
              <h2 className="font-ch-display text-[15px] font-bold">Where are you headed?</h2>
              <p className="mx-auto mt-1.5 max-w-[40ch] text-ch-body text-ch-muted">
                Search a city or park to see what&apos;s open right now. No account needed.
              </p>
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

              {results.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {results.map((c) => (
                    <ResultCard
                      key={c.id}
                      campground={c}
                      startDate={range.start ?? undefined}
                      endDate={range.end ?? undefined}
                    />
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
                  <Link href="/v2/new" className={buttonClasses({ className: "px-5" })}>
                    Create a watch
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
