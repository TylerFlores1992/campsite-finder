"use client";

import { useId } from "react";
import Chip from "./Chip";
import Collapsible from "./Collapsible";
import { cx } from "./cx";

/**
 * Shared control: FilterPanel — one instance on Explore, one on New watch.
 *
 * SHAPE MIRRORS THE FilterState THE SEARCH API EXPECTS
 * so wiring this into the real search is a swap, not a translation layer.
 *
 * TAXONOMY IS WHAT THE BACKEND ACTUALLY SUPPORTS, which differs from the handoff
 * mockup in three ways — all verified against production:
 *
 *  - Site type is SINGLE-select, not multi. The search RPC matches
 *    `p_site_type = ANY(c.site_types)` with one value, so a multi-select row
 *    would be a promise the query can't keep. The mockup put site types and
 *    amenities in one undifferentiated multi-select row; splitting them is both
 *    truthful and clearer.
 *  - Cabin is back and Group is new. The mockup dropped Cabin, but 1,280
 *    campgrounds have it and 1,447 have Group — the largest type missing from
 *    both the old UI and the mockup.
 *  - ADA is gone. `ada_accessible` is false for all 8,013 campgrounds, so the
 *    chip could only ever return nothing.
 *
 * Amenities are AND-ed (`p_amenities <@ c.amenities`), so each added chip narrows.
 *
 * SHOWERS AND PETS WERE REMOVED 2026-08-15, both on measurement, both for the reason
 * that already removed `drinking water` from this row:
 *
 *   - `showers` is RECREATION.GOV ONLY — 197 of 4,469 rec.gov rows and **zero** across
 *     all seven other sources (ReserveAmerica, Ohio, ReserveCalifornia, GoingToCamp,
 *     Minnesota, Illinois, Virginia). Ticking it silently excluded every state-portal
 *     campground. The owner found it from the other end: Silver Lake Campground has
 *     showers in real life and reads `["fire rings","picnic tables"]` here.
 *   - `pets_allowed` is `true` for **100% of every non-rec.gov source** (882/882
 *     ReserveAmerica, 478/478 Ohio, 392/392 ReserveCalifornia …). It is a DEFAULT, not
 *     a measurement, so the chip filtered nothing on eight sources and 80% of the
 *     catalog claims it. The column stays — JSON-LD publishes it — but it cannot carry
 *     a filter.
 *
 * The rule both break is the one this file's header already states: a chip that works
 * on rec.gov and quietly returns nothing elsewhere is worse than no chip, because
 * nothing tells the user which they got.
 *
 * NOT INCLUDED: the mockup's "Waterfront". `environment_tags` does carry
 * ocean/lake/river and the RPC returns it, so it's cheap to add client-side
 * later, but there's no query param for it today and building a dead chip is
 * exactly the failure mode this pass is meant to remove.
 */
export interface FilterValue {
  /** null = all types. One of 'tent' | 'rv' | 'cabin' | 'group'. */
  siteType: string | null;
  /** Minimum pad length in feet, INDEPENDENT of site type — see the fieldset. */
  rvLength: number | null;
  electric: boolean;
}

export const EMPTY_FILTERS: FilterValue = {
  siteType: null,
  rvLength: null,
  electric: false,
};

export interface FilterPanelProps {
  value: FilterValue;
  onChange: (value: FilterValue) => void;
  defaultOpen?: boolean;
  className?: string;
}

const SITE_TYPES: Array<{ value: string | null; label: string }> = [
  { value: null, label: "All types" },
  { value: "tent", label: "Tent" },
  // NO "RV" CHIP (2026-08-15, owner's call). "RV" as a site type overlapped the two
  // controls that answer the question more precisely and from better data: Hookups
  // beside it, and Pad length below. A camper picking RV almost always meant one of
  // those, and picking it INSTEAD narrowed by a `site_types` tag rather than by what
  // will actually fit and plug in.
  { value: "cabin", label: "Cabin" },
  { value: "group", label: "Group" },
];

/**
 * WHY "Hookups" HAS NO WATER OR SEWER SIBLING, measured against the live catalog on
 * 2026-08-15 so the next person does not "finish the set":
 *
 *   electric hookup   1,526 campgrounds, 8 sources
 *   sewer hookup         79 campgrounds, recreation.gov ONLY
 *   drinking water    2,153 campgrounds, recreation.gov only
 *   water hookup      DOES NOT EXIST — no ingest emits this value
 *
 * There is no RV water hookup in the data at all. Sewer exists but covers 1% of the
 * catalog from a single source, and amenities are AND-ed, so Electric+Sewer could
 * never return more than 79 campgrounds while silently excluding every state portal.
 * Both are the dead-chip failure this file's header comment already forbids.
 *
 * DRINKING WATER WAS REMOVED from this row on 2026-08-15 at the owner's request, for
 * the same reason showers and pets went later the same day: rec.gov-only coverage.
 *
 * HOOKUPS MOVED INTO "Site type" on 2026-08-15, which REVERSES a call recorded here
 * earlier the same day ("stays in Must-have ... the flat Must-have row reads better
 * than a nested one"). The reversal is left visible rather than overwritten, because
 * the reasoning that produced it was sound and only the surroundings changed: removing
 * showers and pets left "Must have" a section with exactly one chip in it, and a
 * one-item group is not a group. Electric is the only amenity in the catalog broad
 * enough to carry a filter — 9 of 14 sources — so there is nothing left to pair it with.
 */

/** Minimum PAD length in feet. Its own control since 2026-08-15 — see the fieldset. */
const PAD_LENGTHS = [24, 28, 32, 36, 40];

export function countApplied(v: FilterValue): number {
  return (v.siteType ? 1 : 0) + (v.rvLength ? 1 : 0) + (v.electric ? 1 : 0);
}

export default function FilterPanel({ value, onChange, defaultOpen, className }: FilterPanelProps) {
  const id = useId();
  const applied = countApplied(value);

  // NO LONGER CLEARS THE PAD LENGTH. It used to, because the control only existed while
  // RV was selected and a hidden filter that keeps narrowing results is a bug. Pad
  // length is its own always-visible control now, so there is nothing to hide and
  // nothing to clear — and a tent camper with a trailer can ask for a 32ft pad.
  const setSiteType = (next: string | null) => onChange({ ...value, siteType: next });

  return (
    <FilterPanelShell
      applied={applied}
      defaultOpen={defaultOpen}
      className={className}
    >
      <fieldset>
        <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
          Site type
        </legend>
        {/* HOOKUPS SITS IN THIS ROW, in the slot RV used to occupy (2026-08-15,
            owner's call) — it is not its own category.

            The DIVIDER before it is load-bearing, and replaces the separate labelled
            line this used to have. The chips to its left are SINGLE-select (picking
            Tent unpicks Cabin); Hookups is a TOGGLE that combines with whichever type
            is chosen. Dropped in as a plain sixth chip it would read as one more of the
            same, so tapping it would look like it had cleared the site type. The rule
            and `aria-pressed` carry that distinction without spending a heading on one
            chip. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {SITE_TYPES.map(({ value: v, label }) => (
            <Chip
              key={label}
              size="sm"
              selected={value.siteType === v}
              onClick={() => setSiteType(v)}
            >
              {label}
            </Chip>
          ))}
          <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-ch-line" />
          <Chip
            size="sm"
            selected={value.electric}
            aria-pressed={value.electric}
            onClick={() => onChange({ ...value, electric: !value.electric })}
          >
            Hookups
          </Chip>
        </div>

      </fieldset>

      {/* PAD LENGTH IS ITS OWN CONTROL, always visible (2026-08-15).
          It used to appear only while the RV site type was selected, and Explore only
          sent it in that case — so anyone with a trailer who had not also picked "RV"
          silently got no length filtering at all. The two are independent questions:
          what kind of site you want, and what will physically fit on it. */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
          Pad length
        </legend>
        <div className="flex flex-wrap gap-1.5">
          <Chip
            size="sm"
            selected={value.rvLength === null}
            onClick={() => onChange({ ...value, rvLength: null })}
          >
            Any
          </Chip>
          {PAD_LENGTHS.map((ft) => (
            <Chip
              key={ft}
              size="sm"
              selected={value.rvLength === ft}
              onClick={() => onChange({ ...value, rvLength: ft })}
            >
              {ft} ft
            </Chip>
          ))}
        </div>
        {/* Truthful version of the mockup's note, which claimed the opposite.
            The RPC requires EXISTS(campsite with max_vehicle_length >= N), so a
            campground with no length on file is excluded, not shown. */}
        <p className="mt-2 px-0.5 text-ch-fine leading-normal text-ch-muted" id={`${id}-hint`}>
          Only campgrounds with a site that lists a pad this long. Sites with no length
          on file are left out.
        </p>
      </fieldset>

    </FilterPanelShell>
  );
}

/** Split out so the summary wording lives in one place. */
function FilterPanelShell({
  applied,
  defaultOpen,
  className,
  children,
}: {
  applied: number;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible
      label="Filters"
      // "all sites" rather than "0 applied" — a count of zero reads as a broken
      // control, where the words say what you'll actually get.
      summary={applied ? `${applied} applied` : "all sites"}
      defaultOpen={defaultOpen}
      className={cx(className)}
    >
      {children}
    </Collapsible>
  );
}
