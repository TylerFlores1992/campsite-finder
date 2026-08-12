/**
 * `--ch-*` IS THE ONLY PALETTE, AND A STOCK TAILWIND COLOUR NOW RENDERS THE WRONG THING.
 *
 * The stock colour overrides were DELETED on 2026-07-27 once the last 13 files were
 * converted. That is what makes this worth a test rather than taste: before the deletion a
 * stray `bg-green-600` rendered CampHawk green by accident, so the mistake was invisible.
 * After it, the same class renders STOCK Tailwind green — a colour that appears nowhere
 * else in the product — and the only signal is somebody eventually looking at the page.
 *
 * ── WHY A TEST AND NOT ONLY A HOOK ─────────────────────────────────────────────────────
 * A PreToolUse hook fires on edits made through this harness. It cannot see a change made
 * in an editor, by another tool, or in a branch that predates the hook — and this repo's
 * whole lesson is that a guard wired only to the path you happen to be watching is the
 * guard that is absent when it matters. The suite sees every path into the tree.
 *
 * ── STARTING CLEAN IS THE POINT ────────────────────────────────────────────────────────
 * Two stragglers survived in `BetaTesters.tsx` (`text-red-600`, `text-red-500`) — in a file
 * CLAUDE.md lists among the converted, which is exactly how a "done" invariant rots. They
 * were converted to `text-ch-bad` and `hover:text-ch-alert`, both of which have precedent
 * in the admin panels for the same two jobs. A gate that is red the day it lands is a gate
 * people learn to ignore, so this one lands green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stock Tailwind colour families. `ch-` prefixed classes are ours and never match, because
 * the boundary requires the family name to follow the utility prefix directly.
 */
const FAMILIES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
  'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
  'purple', 'fuchsia', 'pink', 'rose',
].join('|');

/** `text-red-600`, `hover:bg-green-500/20`, `dark:border-gray-200` — with the shade. */
const STOCK = new RegExp(
  String.raw`(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|from|via|to|fill|stroke|divide|outline|decoration|shadow|accent|caret|placeholder)-(?:${FAMILIES})-\d{2,3}\b`,
  'g',
);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

test('no stock Tailwind colour survives in the app', () => {
  const offenders: string[] = [];
  for (const f of walk('src')) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      // Comments are allowed to name the thing they forbid — the same rule the PowerShell
      // and SQL-routing guards needed, learned the hard way five times over.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.match(STOCK) ?? []) offenders.push(`${f}:${i + 1} ${m}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    'the stock Tailwind palette overrides are deleted, so these render a colour that ' +
    'appears nowhere else in the product. Use a ch-* token:\n' + offenders.join('\n'),
  );
});

test('the guard actually recognises a stock colour', () => {
  // A regex that matches nothing passes this suite forever and proves nothing. Pin both
  // directions on strings, so the assertion above cannot be green by accident.
  for (const bad of [
    'className="text-red-600"',
    'className="mb-3 hover:text-red-500 transition-colors"',
    'className="bg-green-600 hover:bg-green-700"',
    'className="dark:border-gray-200"',
    'className="from-blue-500/40"',
  ]) {
    assert.ok(STOCK.test(bad), `should flag: ${bad}`);
    STOCK.lastIndex = 0; // the regex is /g — a stale lastIndex silently skips the next test
  }
  for (const good of [
    'className="text-ch-bad"',
    'className="text-ch-faint hover:text-ch-alert transition-colors"',
    'className="bg-ch-green-deep"',
    'className="text-ch-ink-2"',
    // Not a colour utility: a spacing or sizing class that merely contains a number.
    'className="mb-3 p-1.5 gap-2"',
  ]) {
    assert.ok(!STOCK.test(good), `should NOT flag: ${good}`);
    STOCK.lastIndex = 0;
  }
});
