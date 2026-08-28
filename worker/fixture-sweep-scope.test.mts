/**
 * A FIXTURE SWEEP MAY ONLY REACH ITS OWN SUITE'S ROWS, AND ONLY WHEN THEY ARE OLD.
 *
 * `npm test` hits the production database on purpose, and CI runs it on every push - so two
 * runs overlap routinely, and neither lane has to have typed a command for it to happen.
 * `docs/LANES.md`'s "one test run at a time" rule cannot cover that case by construction.
 *
 * WHAT WENT WRONG (issue #76, two confirmed occurrences 25 minutes apart, both on a
 * docs-only branch). Four suites shared the sentinel prefix `__t`, and three of them swept
 * the whole prefix in `before()`. A starting run therefore deleted a RUNNING run's working
 * set:
 *
 *   * `rc-holds.test.mts:164` - a row `markCarted` had written two statements earlier was
 *     gone by the next SELECT.
 *   * `expire-holds.test.mts:83` - zero rows expired, because the rows were not there. The
 *     sweeping run was a *merge to master*, and the victim suite does not even own the sweep.
 *
 * THE OLD COMMENT STATED THE ASSUMPTION AND IT WAS FALSE: "the leaked rows belong to a
 * PREVIOUS run's watch, which this process has never seen." True only when no other run is
 * live. Every run's fixtures carried the same prefix, so litter and a live working set were
 * indistinguishable.
 *
 * IT WAS SILENT IN THE DANGEROUS DIRECTION. The swept run dies on a null or a zero several
 * statements from the cause, while the sweeping run passes clean and logs `swept N hold
 * fixture(s) left by an earlier run` - a line that reads as self-healing working, at the
 * exact moment it is destroying a live run. Same family as `status = 'sent'`.
 *
 * THE FIX IS BOTH HALVES, AND EITHER ALONE IS INSUFFICIENT:
 *
 *   1. A PER-SUITE PREFIX (`__trh`, `__teh`, `__tfi`, `__tcap`, `__tln`, `__tdc`) - so one
 *      suite's sweep can never reach another's rows. That covers occurrence 2, where the
 *      victim was a different suite entirely.
 *   2. AN AGE GATE on `offered_at` - so two concurrent runs of the SAME suite do not wipe
 *      each other. That covers occurrence 1. `offered_at` is the row's birth time and no
 *      status change moves it, unlike `updated_at`, which a live run's `markCarted` bumps -
 *      so a concurrent run's rows are seconds old and protected while litter is minutes old.
 *
 * WHY MECHANICAL. Reproducing this needs two overlapping runs against one database, which no
 * test can arrange; and the failure it produces looks exactly like an unrelated regression,
 * so the next person to see it re-runs CI and moves on. That is precisely the shape that has
 * to be guarded structurally or not at all - same reasoning as `hold-fixture-safety.test.mts`
 * (a numeric fixture id) and `sql-routing.test.mts` (a write handed to `query()`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '.');

/** Comments stripped: this file's own explanations quote the broken patterns. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/** Postgres `LIKE` escaping - `\_` is a literal underscore. Undo it to compare with `U()`. */
function likeToPrefix(pattern: string): string {
  return pattern.replace(/\\\\/g, '\\').replace(/\\_/g, '_').replace(/%$/, '');
}

interface Suite { file: string; prefix: string | null; sweeps: { like: string; tail: string }[]; }

function suites(): Suite[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.test.mts'))
    // EXCLUDE SELF. This file's own regexes contain both the INSERT it selects on and the
    // DELETE it parses, so it matched itself, found no `U()` helper, and reported three
    // failures about a file that inserts nothing. A scanner that scans itself is measuring
    // its own source, not the codebase.
    .filter((f) => f !== 'fixture-sweep-scope.test.mts')
    .map((f) => {
      const src = code(readFileSync(join(DIR, f), 'utf8'));
      const u = src.match(/const U = \(n: string\) => `([^`]*)\$\{n\}`/);
      // SELECTED ON THE TWO THINGS UNDER TEST, not on how fixtures are created. The first
      // draft selected on `INSERT INTO rc_hold_requests` and found NONE of the four suites
      // that matter - they create rows through `offerHold`/`requestHold`, so the scan
      // reported two files and would have passed while the bug it guards sat in the other
      // four. A selector describing the wrong property is how `hold-fixture-safety` missed
      // six suites for months.
      const hasSweep = /DELETE FROM rc_hold_requests WHERE unit_id LIKE/.test(src);
      if (!u && !hasSweep) return null;
      // Every LIKE sweep in the file, with whatever clause follows it up to the closing
      // backtick - the age gate lives in that tail.
      const sweeps = [...src.matchAll(
        /DELETE FROM rc_hold_requests WHERE unit_id LIKE '([^']*)'([\s\S]*?)`/g)]
        .map((m) => ({ like: m[1], tail: m[2] }));
      return { file: f, prefix: u ? u[1] : null, sweeps };
    })
    .filter((s): s is Suite => s !== null);
}

test('every hold suite that writes fixtures was found - or the checks below are vacuous', () => {
  const all = suites();
  assert.ok(all.length >= 5,
    `expected at least five hold-fixture suites, found ${all.length} - has the table been `
    + 'renamed, or the INSERT moved behind a helper this scan cannot see?');
  const sweeping = all.filter((s) => s.sweeps.length > 0);
  assert.ok(sweeping.length >= 3,
    `expected at least three suites to sweep by unit_id prefix, found ${sweeping.length}`);
});

test('NO SUITE SWEEPS A PREFIX BROADER THAN ITS OWN - the #76 cross-suite wipe', () => {
  for (const s of suites()) {
    for (const sweep of s.sweeps) {
      const prefix = likeToPrefix(sweep.like);
      assert.ok(s.prefix,
        `${s.file} sweeps by unit_id prefix but defines no U() helper, so there is nothing `
        + 'to check its scope against');
      assert.equal(prefix, s.prefix,
        `${s.file} sweeps '${prefix}%' but its own fixtures are '${s.prefix}...'. A sweep `
        + "wider than the suite deletes a CONCURRENT run's live rows - that is issue #76, "
        + 'and the victim dies on a null several statements from the cause while this run '
        + 'logs "swept N fixture(s)" and passes.');
    }
  }
});

test('EVERY PREFIX SWEEP IS AGE-GATED - two runs of the SAME suite must not wipe each other', () => {
  for (const s of suites()) {
    for (const sweep of s.sweeps) {
      assert.match(sweep.tail, /offered_at\s*<\s*NOW\(\)\s*-\s*interval\s*'\d+\s*minutes'/,
        `${s.file}'s sweep is not age-gated. A per-suite prefix stops one suite wiping `
        + 'another, and stops nothing when the same suite runs twice at once - which is '
        + "occurrence 1 in #76. Gate on offered_at, which is the row's birth time; "
        + "updated_at is moved by a live run's own markCarted and would protect nothing.");
      const mins = Number(sweep.tail.match(/interval\s*'(\d+)\s*minutes'/)![1]);
      assert.ok(mins >= 5,
        `${s.file} gates at ${mins} minutes, which a slow CI run can cross - the window has `
        + 'to exceed a full suite run, not a fast one');
      assert.ok(mins <= 60,
        `${s.file} gates at ${mins} minutes, which leaves real litter being retried by the `
        + 'production runner for an hour - the thing the sweep exists to prevent');
    }
  }
});

test('THE PREFIXES ARE DISTINCT, and none is a prefix of another', () => {
  // A containment check, not just equality: `__t` and `__trh` are different strings, and a
  // sweep for `__t%` still matches `__trh0001`. That is the original bug exactly.
  const withPrefix = suites().filter((s) => s.prefix);
  const seen = new Map<string, string>();
  for (const s of withPrefix) {
    for (const [other, file] of seen) {
      assert.ok(!s.prefix!.startsWith(other) && !other.startsWith(s.prefix!),
        `${s.file} uses '${s.prefix}' and ${file} uses '${other}' - one contains the other, `
        + "so a LIKE sweep for either reaches the other suite's rows");
    }
    seen.set(s.prefix!, s.file);
  }
  assert.ok(seen.size >= 5, `expected at least five distinct prefixes, found ${seen.size}`);
});

test('every prefix is still NON-NUMERIC - the property that makes a fixture un-cartable', () => {
  // Namespacing must not quietly cost the guarantee `hold-fixture-safety` exists for: real
  // RC unit ids are numeric, so a sentinel is refused by RC rather than locking a campsite.
  for (const s of suites()) {
    if (!s.prefix) continue;
    assert.ok(/^\D/.test(s.prefix),
      `${s.file}'s prefix '${s.prefix}' starts with a digit - a fixture id must never be `
      + "numeric, or the production runner POSTs it to RC's precart");
  }
});
