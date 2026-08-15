/**
 * EVERY FILTER THE PANEL OFFERS MUST REACH THE SEARCH REQUEST.
 *
 * ── THE FAILURE THIS GUARDS ────────────────────────────────────────────────────────────
 * This repo has shipped the same defect three times: a control the user operates whose
 * value goes nowhere. `site_type` on the New watch screen was transmitted and persisted
 * and read by NOTHING in `worker/`; `rvLength`, `electric`, `showers` and `pets` were
 * collected on that screen and dropped on submit; the auto-cart toggle was "PURELY
 * DECORATIVE until 2026-08-01". Each was invisible by reading any single file.
 *
 * The Explore panel is the one place these filters DO work — measured against production
 * on 2026-08-15: site type 80 → 56/52/4/16, pad length 80 → 49/24/7, and a nonsense value
 * returning 0 in both cases, which is what proves the SQL clause is live rather than
 * merely present. This test exists so that stays true.
 *
 * ── WHY IT IS A FIELD SWEEP, NOT A LIST ────────────────────────────────────────────────
 * It derives the field names from `FilterValue` itself, so ADDING a filter to the panel
 * without wiring it to the query fails here. A hand-written list of three fields would
 * pass for ever against a fourth that does nothing — which is exactly how the last one
 * survived review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

const panelSrc = read('../src/components/ui/FilterPanel.tsx');
const panel = strip(panelSrc);
const explore = strip(read('../src/components/v2/Explore.tsx'));

/** The declared fields of FilterValue, read from the interface rather than hard-coded. */
function filterFields(): string[] {
  const body = panel.slice(
    panel.indexOf('export interface FilterValue {'),
    panel.indexOf('}', panel.indexOf('export interface FilterValue {')),
  );
  return [...body.matchAll(/^\s*(\w+)\s*[?:]/gm)].map((m) => m[1]);
}

test('FilterValue is exactly the filters that survive on the data', () => {
  // Removed 2026-08-15 on measurement, both because the underlying column cannot carry
  // a filter — not because they were unpopular:
  //   showers      rec.gov ONLY: 197 of 4,469 rec.gov rows, ZERO across the other seven
  //                sources, so ticking it silently excluded every state portal. Found by
  //                the owner from the other end — Silver Lake has showers in real life
  //                and reads ["fire rings","picnic tables"] here.
  //   pets         `pets_allowed` is true for 100% of every non-rec.gov source. A
  //                default, not a measurement.
  assert.deepEqual(filterFields().sort(), ['electric', 'rvLength', 'siteType']);
  for (const gone of ['showers', 'pets']) {
    assert.ok(
      !new RegExp(`\\b${gone}\\b`).test(strip(panel)),
      `\`${gone}\` is back in the filter panel. It was removed because its column is a ` +
        `rec.gov-only or always-true value, so the chip returns nothing or filters ` +
        `nothing depending on which source a campground came from — and nothing tells ` +
        `the user which they got.`,
    );
  }
});

test('every declared filter reaches the search request', () => {
  const search = explore.slice(explore.indexOf('const qs = new URLSearchParams'));
  assert.ok(search.length, 'the search request builder was not found — renamed?');
  const reached: Record<string, boolean> = {
    siteType: /qs\.set\("siteType"/.test(search),
    rvLength: /qs\.set\("rvLength"/.test(search),
    electric: /amenities\.push\("electric hookup"\)/.test(search),
  };
  for (const f of filterFields()) {
    assert.ok(
      reached[f],
      `FilterValue declares \`${f}\` but nothing in the search builder transmits it. ` +
        'That is the decorative-control defect this codebase has shipped three times: ' +
        'the chip highlights, the count says "applied", and the query never hears about it.',
    );
  }
});

test('pad length is NOT gated on the site type', () => {
  /**
   * It used to be `filters.siteType === "rv" && filters.rvLength`, matching a control
   * that only appeared while RV was selected. Now that pad length is its own always-
   * visible chip row, that gate would mean someone who set 32 ft without also picking
   * "RV" saw the chip selected and the count say "1 applied" while the parameter was
   * never sent — a filter that lies about being on.
   */
  assert.ok(
    /if \(filters\.rvLength\) qs\.set\("rvLength"/.test(explore),
    'the rvLength parameter is conditional on something other than rvLength itself',
  );
  assert.ok(
    !/siteType === "rv" && filters\.rvLength/.test(explore),
    'the rvLength parameter is still gated on the RV site type, so a pad length set ' +
      'under any other type is shown as applied and silently not sent',
  );
  assert.ok(
    !/rvLength: next === "rv"/.test(panel),
    'selecting a different site type still clears the pad length. That rule existed ' +
      'because the control used to disappear; it is now always visible, so clearing it ' +
      'destroys a filter the user can still see.',
  );
});

test('an old shared link cannot apply a removed filter', () => {
  // A URL from before the removal may still carry ?showers=1&pets=1. Reading those back
  // would apply a filter with no control able to turn it off — an invisible narrowing,
  // which is worse than the chip ever was.
  const decode = explore.slice(
    explore.indexOf('function decodeSearch'),
    explore.indexOf('\n}', explore.indexOf('function decodeSearch')),
  );
  assert.ok(decode.length, 'decodeSearch not found — renamed?');
  for (const gone of ['showers', 'pets']) {
    assert.ok(
      !new RegExp(`q\\.get\\("${gone}"\\)`).test(decode),
      `decodeSearch still reads ?${gone}= from the URL, so an old link applies a filter ` +
        'the user has no way to see or clear',
    );
  }
});

test('the panel counts what it will actually send', () => {
  const counter = panel.slice(
    panel.indexOf('export function countApplied'),
    panel.indexOf('\n}', panel.indexOf('export function countApplied')),
  );
  assert.ok(counter.length, 'countApplied not found — renamed?');
  for (const f of filterFields()) {
    assert.ok(
      new RegExp(`\\bv\\.${f}\\b`).test(counter),
      `countApplied ignores \`${f}\`, so the summary can read "all sites" while that ` +
        'filter is narrowing the results',
    );
  }
});
