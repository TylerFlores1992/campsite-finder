"use client";

import { useId } from "react";
import Chip from "./Chip";
import Collapsible from "./Collapsible";
import { cx } from "./cx";

/**
 * Shared control: FilterPanel — one instance on Explore, one on New watch.
 *
 * SHAPE MIRRORS THE LEGACY FilterState ON PURPOSE (src/components/Filters.tsx)
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
 * Amenities are AND-ed (`p_amenities <@ c.amenities`), so each added chip
 * narrows. Pets is filtered client-side off the returned `petsAllowed` column
 * rather than in SQL — same as today.
 *
 * NOT INCLUDED: the mockup's "Waterfront". `environment_tags` does carry
 * ocean/lake/river and the RPC returns it, so it's cheap to add client-side
 * later, but there's no query param for it today and building a dead chip is
 * exactly the failure mode this pass is meant to remove.
 */
export interface FilterValue {
  /** null = all types. One of 'tent' | 'rv' | 'cabin' | 'group'. */
  siteType: string | null;
  rvLength: number | null;
  pets: boolean;
  electric: boolean;
  water: boolean;
  showers: boolean;
}

export const EMPTY_FILTERS: FilterValue = {
  siteType: null,
  rvLength: null,
  pets: false,
  electric: false,
  water: false,
  showers: false,
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
  { value: "rv", label: "RV" },
  { value: "cabin", label: "Cabin" },
  { value: "group", label: "Group" },
];

const MUST_HAVE: Array<{ key: keyof Pick<FilterValue, "pets" | "electric" | "water" | "showers">; label: string }> = [
  { key: "pets", label: "Pets OK" },
  { key: "electric", label: "Hookups" },
  { key: "water", label: "Drinking water" },
  { key: "showers", label: "Showers" },
];

const RIG_LENGTHS = [24, 28, 32, 36, 40];

export function countApplied(v: FilterValue): number {
  return (
    (v.siteType ? 1 : 0) +
    (v.rvLength ? 1 : 0) +
    MUST_HAVE.filter(({ key }) => v[key]).length
  );
}

export default function FilterPanel({ value, onChange, defaultOpen, className }: FilterPanelProps) {
  const id = useId();
  const isRv = value.siteType === "rv";
  const applied = countApplied(value);

  const setSiteType = (next: string | null) => {
    onChange({
      ...value,
      siteType: next,
      // Leaving RV clears the rig length, so a filter can never keep narrowing
      // results from a control the user can no longer see.
      rvLength: next === "rv" ? value.rvLength : null,
    });
  };

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
        <div className="flex flex-wrap gap-1.5">
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
        </div>
      </fieldset>

      {isRv && (
        <fieldset className="mt-4">
          <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
            My rig length
          </legend>
          <div className="flex flex-wrap gap-1.5">
            <Chip
              size="sm"
              selected={value.rvLength === null}
              onClick={() => onChange({ ...value, rvLength: null })}
            >
              Any
            </Chip>
            {RIG_LENGTHS.map((ft) => (
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
          <p className="mt-2 px-0.5 text-ch-fine leading-normal text-ch-muted">
            Only campgrounds with a site that lists a length this long. Sites with no
            length on file are left out.
          </p>
        </fieldset>
      )}

      <fieldset className="mt-4">
        <legend className="mb-2 text-ch-label font-bold uppercase tracking-[.1em] text-ch-muted">
          Must have
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {MUST_HAVE.map(({ key, label }) => (
            <Chip
              key={key}
              size="sm"
              selected={value[key]}
              onClick={() => onChange({ ...value, [key]: !value[key] })}
            >
              {label}
            </Chip>
          ))}
        </div>
        <p className="mt-2 px-0.5 text-ch-fine leading-normal text-ch-muted" id={`${id}-hint`}>
          Nothing selected means every site counts. Each one you add narrows the results.
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
