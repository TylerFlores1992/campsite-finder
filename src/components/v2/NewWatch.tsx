"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import DatePicker, { type DateRange } from "@/components/ui/DatePicker";
import FilterPanel, { EMPTY_FILTERS, type FilterValue } from "@/components/ui/FilterPanel";
import NightsPicker from "@/components/ui/NightsPicker";
import TrustPanel from "./TrustPanel";
import { providerLabel, supportsAutoCart } from "./providers";
import { addDays, formatRange, nightsBetween, todayISO } from "@/components/ui/date";
import type { Campground } from "@/lib/types";

/**
 * New watch — now the only place a watch is created.
 *
 * A campground search lives here, which the old UI had no equivalent for: you
 * could only watch something you'd already surfaced through a location search.
 * Result cards deep-link in with ?campground=, so arriving from a search still
 * skips straight past this step.
 *
 * Mounts the SAME DatePicker / NightsPicker / FilterPanel as Explore.
 * Build once, import twice — two drifting copies is how the current UI got here.
 */

interface Suggestion {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
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

  const [campgroundId, setCampgroundId] = useState<string | null>(initialCampgroundId ?? null);
  const [campgroundName, setCampgroundName] = useState("");
  const [campgroundSource, setCampgroundSource] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const [mode, setMode] = useState<"exact" | "flexible">("exact");
  const [range, setRange] = useState<DateRange>({
    start: initialStart ?? null,
    end: initialEnd ?? null,
  });
  const [flexNights, setFlexNights] = useState(2);
  const [weekendsOnly, setWeekendsOnly] = useState(false);
  const [filters, setFilters] = useState<FilterValue>(EMPTY_FILTERS);
  const [autoCart, setAutoCart] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);

  // Resolve a pre-selected campground so the summary can name it.
  useEffect(() => {
    if (!campgroundId) return;
    let cancelled = false;
    fetch(`/api/campgrounds/${encodeURIComponent(campgroundId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { campground: Campground } | null) => {
        if (cancelled || !j) return;
        setCampgroundName(j.campground.name);
        setCampgroundSource(j.campground.source);
        setQ(j.campground.name);
      })
      .catch(() => {
        /* the id still works even if the name doesn't resolve */
      });
    return () => {
      cancelled = true;
    };
  }, [campgroundId]);

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

  const submit = useCallback(async () => {
    if (!campgroundId) {
      setError("Pick a campground to watch.");
      return;
    }
    if (!range.start || !range.end) {
      setError(mode === "flexible" ? "Choose the window to watch." : "Choose your nights.");
      return;
    }
    setSaving(true);
    setError(null);
    setNeedsSubscription(false);

    try {
      const r = await fetch("/api/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campgroundId,
          startDate: range.start,
          endDate: range.end,
          siteType: filters.siteType ?? undefined,
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
        window.location.href = "/sign-in";
        return;
      }
      if (r.status === 409) {
        setError("You've hit the 10-watch limit. Delete one to add another.");
        return;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(j?.message ?? j?.error ?? `Couldn't create the watch (${r.status})`);
      }
      router.push("/v2/watches");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the watch");
    } finally {
      setSaving(false);
    }
  }, [campgroundId, range, mode, flexNights, weekendsOnly, filters.siteType, router]);

  const canAutoCart = campgroundSource ? supportsAutoCart(campgroundSource) : false;
  const windowNights = range.start && range.end ? nightsBetween(range.start, range.end) : 0;
  // The API rejects flexNights longer than the window; catch it before the round trip.
  const flexTooLong = mode === "flexible" && windowNights > 0 && flexNights > windowNights;

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
        <input
          id="nw-cg"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCampgroundId(null);
            setCampgroundSource(null);
          }}
          placeholder="Search a campground by name"
          autoComplete="off"
          className="w-full rounded-ch-input border border-ch-line bg-ch-card px-3.5 py-3 font-ch-display text-[14.5px] font-semibold text-ch-ink placeholder:text-ch-faint focus-visible:border-ch-green focus-visible:outline-none"
        />
        {suggestions.length > 0 && (
          <ul className="mt-1 overflow-hidden rounded-ch-input border border-ch-line">
            {suggestions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    setCampgroundId(s.id);
                    setCampgroundName(s.name);
                    setQ(s.name);
                    setSuggestions([]);
                  }}
                  className="w-full cursor-pointer border-b border-ch-line bg-ch-card px-3 py-2 text-left text-ch-body last:border-b-0 hover:bg-ch-green-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ch-green"
                >
                  <span className="font-semibold">{s.name}</span>
                  {s.city && (
                    <span className="text-ch-muted">
                      {" "}
                      · {s.city}
                      {s.state ? `, ${s.state}` : ""}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <fieldset className="mt-5">
          <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
            Which nights
          </legend>
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Chip size="sm" selected={mode === "exact"} onClick={() => setMode("exact")}>
              Exact dates
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
              {flexNights} nights doesn&apos;t fit in a {windowNights}-night window. Widen the
              window or shorten the stay.
            </p>
          )}
        </fieldset>

        <fieldset className="mt-5">
          <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
            What counts as a match
          </legend>
          <FilterPanel value={filters} onChange={setFilters} />
        </fieldset>

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

        {!canAutoCart && campgroundSource && (
          <p className="mt-5 text-ch-fine leading-normal text-ch-muted">
            Auto-cart is Recreation.gov only —{" "}
            {providerLabel(campgroundSource, campgroundId ?? undefined)} carts are tied to a browser
            session and wouldn&apos;t follow you to your phone. You&apos;ll still get the alert.
          </p>
        )}
      </form>

      <aside className="rounded-ch-card border border-[#BFDDC9] bg-ch-green-soft p-4">
        <h2 className="font-ch-display text-[13.5px] font-bold text-ch-green-deep">
          What we&apos;ll do
        </h2>
        <p className="mt-2 text-ch-body leading-relaxed text-ch-green-deep">
          {campgroundId ? (
            <>
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
              , checking every 15 seconds.
            </>
          ) : (
            "Pick a campground and we'll tell you the second it opens."
          )}
        </p>

        <div className="mt-4">
          <Button type="submit" fullWidth disabled={saving || flexTooLong} onClick={() => void submit()}>
            {saving ? "Setting up…" : "Start watching"}
          </Button>
        </div>

        {needsSubscription && (
          <p className="mt-2.5 text-ch-fine leading-normal text-ch-ochre-ink">
            Watches need a subscription — $2.50/mo or $20/yr after a 7-day free trial.{" "}
            <a className="font-bold underline" href="/">
              Start the trial
            </a>
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
