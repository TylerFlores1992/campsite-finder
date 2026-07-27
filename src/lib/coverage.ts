/**
 * State normalisation + coverage figures for user-facing copy.
 *
 * WHY THIS EXISTS: `campgrounds.address->>'state'` is dirty. A raw
 * `count(distinct ...)` returns 67 values for 50 states, because the sync
 * adapters write a mix of USPS codes, full names, different cases and stray
 * whitespace — "VA" and "Virginia", "OR"/"Oregon"/"OREGON", " IL", "IN ". Any
 * copy derived straight from that column is wrong.
 *
 * This normalises at READ time rather than rewriting the column. Two reasons:
 * the redesign is a presentation-layer pass and shouldn't mutate production
 * data, and a one-off UPDATE would be undone by the next catalog sync anyway —
 * the real fix belongs in the source adapters, which is separate work.
 */

/** Full state names -> USPS code. Covers all 50 so future sync dirt is handled. */
const NAME_TO_CODE: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
  COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA",
  HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
  KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
  MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS",
  MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
  OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
  VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI",
  WYOMING: "WY",
};

/** Territories and the district — real places, but not states. Excluded from counts. */
const NON_STATE = new Set(["DC", "AS", "PR", "VI", "GU", "MP"]);

const STATE_CODES = new Set(Object.values(NAME_TO_CODE));

/** Code -> proper-cased name, for headings and URLs. Derived from NAME_TO_CODE
 *  so the two can never drift apart. */
const CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(NAME_TO_CODE).map(([name, code]) => [
    code,
    name
      .toLowerCase()
      .split(" ")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" "),
  ])
);

/** "CA" -> "California". Null for anything that isn't one of the 50. */
export function stateName(code: string | null | undefined): string | null {
  return code ? (CODE_TO_NAME[code.toUpperCase()] ?? null) : null;
}

/** "CA" -> "california". The URL segment for a state landing page. */
export function stateSlug(code: string): string | null {
  const name = stateName(code);
  return name ? name.toLowerCase().replace(/\s+/g, "-") : null;
}

/** "new-hampshire" -> "NH". Null for an unknown slug, which is a 404. */
export function slugToStateCode(slug: string): string | null {
  const name = slug.replace(/-/g, " ").toUpperCase();
  const code = NAME_TO_CODE[name];
  return code ?? null;
}

/** Every state, as { code, name, slug }, alphabetical by name. */
export function allStates(): Array<{ code: string; name: string; slug: string }> {
  return Object.entries(CODE_TO_NAME)
    .map(([code, name]) => ({ code, name, slug: name.toLowerCase().replace(/\s+/g, "-") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Canonicalise whatever the catalog holds into a USPS code.
 * Returns null for blanks, unknown values, and non-state territories, so a
 * caller counting states never has to special-case them.
 */
export function normalizeStateCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return null;
  const code = trimmed.length === 2 ? trimmed : NAME_TO_CODE[trimmed];
  if (!code || NON_STATE.has(code) || !STATE_CODES.has(code)) return null;
  return code;
}

/** Count distinct real states in a set of raw values. */
export function countStates(raws: Array<string | null | undefined>): number {
  const seen = new Set<string>();
  for (const r of raws) {
    const c = normalizeStateCode(r);
    if (c) seen.add(c);
  }
  return seen.size;
}

/**
 * Coverage figures for marketing copy.
 *
 * DERIVED, NOT GUESSED — re-run `npx tsx scripts/coverage-readout.mts` (needs
 * NODE_USE_ENV_PROXY=1) after any catalog sync and update these. They are
 * constants rather than a live query because the landing copy shouldn't hit the
 * database on every render.
 *
 * Last derived 2026-07-26.
 *
 * The split matters. Recreation.gov is national, so "all 50 states" is true but
 * says nothing about the hard part; state-park coverage is the differentiator
 * and is a smaller, honest number. Quoting only the 50 would oversell, quoting
 * only the 34 would undersell.
 */
export const COVERAGE = {
  /** Total campgrounds in the catalog. Round DOWN in copy — never overstate. */
  campgrounds: 8013,
  /** States with at least one campground of any kind. */
  states: 50,
  /** States with state-park coverage (any non-Recreation.gov source). */
  stateParkStates: 34,
  /**
   * Campgrounds with no usable state: 209 null, 66 empty, plus DC (2) and
   * American Samoa (1), which are real places but not states. Excluded above.
   */
  missingState: 278,
} as const;

/** "8,000+ campgrounds" — rounded down to the nearest thousand. */
export function campgroundsRounded(): string {
  return `${Math.floor(COVERAGE.campgrounds / 1000).toLocaleString()},000+`;
}
