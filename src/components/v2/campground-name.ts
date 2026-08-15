/**
 * Campground names, made readable — and grouped by the park they belong to.
 *
 * Two problems, measured against the live catalog on 2026-08-15:
 *
 * 1. **2,719 rec.gov names are ALL CAPS** ("CAVE MOUNTAIN LAKE GROUP CAMP"), a third
 *    of the catalog shouting at the reader.
 * 2. **1,584 rows are divisions of 321 parks**, written as one long string —
 *    "Leo Carrillo SP — Canyon Campground (sites 25-77, 134-139)". Search for the park
 *    and you get three near-identical lines, each repeating the park name.
 *
 * THE PARENTHETICAL IS USUALLY THE ONLY DISCRIMINATOR, so it is never dropped.
 * `rc-539` and `rc-542` are BOTH "Leo Carrillo SP — Canyon Campground"; only
 * "(sites 1-24, 78-133)" vs "(sites 25-77, 134-139)" separates them. Blanket-stripping
 * trailing parentheses would make **374 campgrounds ambiguous** across 167 collision
 * groups. The fix is structural — show the park once and the division beneath it — not
 * a regex that deletes the end of the string.
 */

/** Both dashes appear in the catalog; em is the common one, en shows up in a few rows. */
const DASH = /\s*[—–]\s*/;

/** Characters that make up a "word" for casing purposes. Everything else separates. */
const WORD_CHARS = "A-Za-z0-9#'’/-";
const SEPARATOR = new RegExp(`^[^${WORD_CHARS}]+$`);
const SPLIT_WORDS = new RegExp(`([^${WORD_CHARS}]+)`);

/**
 * Tokens that must NOT be title-cased.
 *
 * Two-letter US state codes are handled separately (see `titleCaseWord`) because
 * "PORCUPINE (AK)" is a real name and "Porcupine (Ak)" is wrong. The rest are the
 * abbreviations that actually occur in this catalog.
 */
const KEEP_UPPER = new Set([
  'SP', 'SB', 'SRA', 'SHP', 'SNA', 'SF', 'NF', 'NP', 'NM', 'NRA', 'NWR', 'WMA',
  'BLM', 'USFS', 'USACE', 'COE', 'KOA', 'RV', 'ATV', 'OHV', 'ADA', 'US', 'USA',
  'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI',
  'NE', 'NW', 'SE', 'SW',
]);

/** Small words that stay lowercase unless they lead the phrase. */
const MINOR = new Set(['of', 'the', 'and', 'at', 'on', 'in', 'to', 'for', 'a', 'an', 'by']);

const STATE_CODE = /^[A-Z]{2}$/;

function titleCaseWord(word: string, index: number, inParens: boolean): string {
  if (!word) return word;

  // Anything with a digit is left exactly as written: "1-24", "401-460", "#L006".
  if (/\d/.test(word)) return word;

  const bare = word.replace(/[^A-Za-z]/g, '');
  if (KEEP_UPPER.has(bare)) return word;

  // A bare two-letter token inside parentheses is a state code — "(AK)", "(CA)".
  // Outside parentheses it is usually a word, so this is deliberately scoped.
  if (inParens && STATE_CODE.test(bare)) return word;

  const lower = word.toLowerCase();
  if (index > 0 && MINOR.has(lower)) return lower;

  // Capitalise after internal hyphens, slashes and apostrophes too, so
  // "OAK-HILL" becomes "Oak-Hill" and "O'BRIEN" becomes "O'Brien".
  return lower.replace(
    /(^|[-/'’])([a-z])/g,
    (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
  );
}

/**
 * Title-case a SHOUTING name, and leave every other name alone.
 *
 * The all-caps test is the guard: a name that already contains a lowercase letter was
 * cased by a human who meant it, and re-casing it would be us overruling the source.
 * Only strings with no lowercase at all are touched — 2,719 of 8,013 rows.
 */
export function tidyCase(name: string): string {
  if (!name) return name;
  if (/[a-z]/.test(name)) return name;

  let wordIndex = 0;
  let depth = 0;
  let out = '';
  for (const tok of name.split(SPLIT_WORDS)) {
    if (!tok) continue;
    if (SEPARATOR.test(tok)) {
      depth += (tok.match(/\(/g) ?? []).length - (tok.match(/\)/g) ?? []).length;
      if (depth < 0) depth = 0;
      out += tok;
      continue;
    }
    out += titleCaseWord(tok, wordIndex, depth > 0);
    wordIndex++;
  }
  return out;
}

export interface CampgroundName {
  /** "Leo Carrillo SP" — the park, or the whole name when there is no division. */
  park: string;
  /** "Canyon Campground (sites 25-77, 134-139)", or null when there is no division. */
  division: string | null;
  /** The full readable name, park included. */
  full: string;
}

/**
 * Split "Park — Division (detail)" into its parts, tidying the case of each.
 *
 * The detail stays attached to the division rather than being split out again: it is
 * what tells two divisions of the same name apart, so it travels with the label that
 * needs it.
 */
export function parseCampgroundName(raw: string): CampgroundName {
  const name = tidyCase((raw ?? '').trim());

  // The FIRST dash only, sliced by index. "A — B — C" is a park with a two-part
  // division, not two parks — and slicing keeps multi-word names intact on both sides.
  const m = DASH.exec(name);
  if (!m) return { park: name, division: null, full: name };

  const park = name.slice(0, m.index).trim();
  const division = name.slice(m.index + m[0].length).trim();
  if (!park || !division) return { park: name, division: null, full: name };
  return { park, division, full: name };
}

/** The park a campground belongs to — the same grouping key the suggest API uses. */
export function parkOf(raw: string): string {
  return parseCampgroundName(raw).park;
}

/**
 * What to show for one campground when the park name is ALREADY on screen above it.
 *
 * Falls back to the full name when there is no division, so a lone campground in a
 * grouped list never renders as an empty row.
 */
export function divisionLabel(raw: string): string {
  const { division, full } = parseCampgroundName(raw);
  return division ?? full;
}
