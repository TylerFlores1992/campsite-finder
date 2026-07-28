"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import DatePicker, { type DateRange } from "@/components/ui/DatePicker";
import FilterPanel, { EMPTY_FILTERS, type FilterValue } from "@/components/ui/FilterPanel";
import NightsPicker from "@/components/ui/NightsPicker";
import TrustPanel from "./TrustPanel";
import FavoriteHeart from "./FavoriteHeart";
import { useFavorites } from "./useFavorites";
import { providerLabel, supportsAutoCart } from "./providers";
import { addDays, formatRange, nightsBetween, todayISO } from "@/components/ui/date";
import { useIsNativeApp } from "@/lib/native/context";
import { NATIVE_LINKOUT, SUBSCRIBE_HREF } from "./nativeSubscribe";
import SubscribeCta, { useAccountGate } from "./SubscribeCta";
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
  const [filters, setFilters] = useState<FilterValue>(EMPTY_FILTERS);
  const [autoCart, setAutoCart] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

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
    setSaving(true);
    setError(null);
    setNeedsSubscription(false);
    setSignedOut(false);

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
        // NOT a redirect. Hard-navigating to /sign-in threw away the campground,
        // the dates and every filter the user had just set, and they came back
        // to an empty form with no idea what happened. Say what's wrong and let
        // them sign in from here — the form is still sitting there afterwards.
        setSignedOut(true);
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
                        <span className="font-semibold">{f.name}</span>
                        {f.city && (
                          <span className="text-ch-muted">
                            {" "}
                            · {f.city}
                            {f.state ? `, ${f.state}` : ""}
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
          </div>
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
              disabled={saving || flexTooLong || gate === "loading"}
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
                Watches need a subscription — $2.50/mo or $20/yr after a 7-day free trial.{" "}
                <a className="font-bold underline" href="/">
                  Start the trial
                </a>
              </>
            )}
          </p>
        )}
        {signedOut && (
          <p role="alert" className="mt-2.5 text-ch-fine leading-normal text-ch-alert">
            Your session expired before we could save this.{" "}
            <a className="font-bold underline" href="/sign-in">
              Sign in
            </a>{" "}
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
