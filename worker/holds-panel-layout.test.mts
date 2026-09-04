// Two reports from one iPhone screenshot, 2026-08-17. Both invisible from the source alone
// and both on screens that matter more than they look.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * "RC hold banners do not fit on the screen of my iPhone."
 *
 * A grid item's default `min-width` is `auto`, so the track sizes to the item's MAX-CONTENT.
 * A hold row is a flex line holding a `truncate` title — which is `white-space: nowrap` —
 * beside a `shrink-0` status chip and a `shrink-0` remove button. Nothing in it may shrink,
 * so the track grew past the viewport and the card hung off the right edge: the "Yours" chip
 * and most of "Open the hand-off again" were unreachable, on the one panel whose job is to
 * get somebody to a campsite inside fifteen minutes.
 *
 * The `min-w-0 flex-1` inside was already correct and could never have helped — it
 * constrains the flex CHILD, and the overflow was the grid TRACK one level up. That is why
 * this needs a test rather than a careful reading: the wrong fix looks like the right one.
 */
test('the holds grid cannot be widened by its contents', () => {
  const src = read('src/components/v2/HoldsPanel.tsx');
  assert.match(src, /className="grid grid-cols-\[minmax\(0,1fr\)\] gap-/,
    'the track must be minmax(0,1fr) — a bare `grid` sizes to max-content');
  assert.ok(!/className="grid gap-[\d.]+"/.test(src),
    'a bare `grid gap-*` is the shape that overflowed');
});

test('the row still relies on shrink-0 and truncate, which is why the track must be bounded', () => {
  // If these ever go away the guard above is arguably unnecessary — but it is also harmless,
  // and the pairing is what makes the bug reproducible. Asserted so a future reader can see
  // the two halves belong together rather than deleting the odd-looking one.
  //
  // THE PAIR NOW SPANS TWO FILES (2026-09-04). The row moved into `HoldRow.tsx` when the
  // watch cards started drawing it too — one definition rather than a second copy — so the
  // TRACK is in HoldsPanel and the CONTENT that overflows it is here. Re-anchored rather
  // than relaxed: pointing this back at HoldsPanel would find nothing and pass, which is
  // the vacuous-guard shape this project keeps paying for.
  const src = read('src/components/v2/HoldRow.tsx');
  assert.match(src, /className="truncate text-ch-body font-bold"/);
  assert.match(src, /shrink-0 rounded-ch-chip/);
});

test('every surface that draws a hold row bounds its own track', () => {
  // The row is shared now, so the overflow travels with it. A container that lays rows out
  // in a grid must bound the track wherever it is — the watch card learned this for free by
  // copying the class, and this is what stops the next one forgetting.
  for (const f of ['src/components/v2/HoldsPanel.tsx', 'src/components/v2/WatchCard.tsx']) {
    const src = read(f);
    if (!src.includes('<HoldRow')) continue;
    assert.ok(
      !/className="grid gap-[\d.]+"[^>]*>\s*\{[^}]*\.map\(\(h/.test(src),
      `${f} lays out hold rows in an unbounded grid track`,
    );
    assert.match(src, /grid-cols-\[minmax\(0,1fr\)\]/,
      `${f} draws hold rows and must bound the track that holds them`);
  }
});

/**
 * "The auto cart not signed in banner doesn't have a CampHawk logo to bring you back."
 *
 * `/connect` lives OUTSIDE the `(app)` route group, so it never receives `V2Nav`. That is
 * deliberate — a credential-entry screen should not carry an account menu and a row of tabs
 * inviting you away mid-sign-in — and it left the page with no mark and no way home.
 */
test('/connect offers a way back to the site', () => {
  const src = read('src/app/connect/page.tsx');
  assert.match(src, /import Logo from '@\/components\/Logo'/);
  assert.match(src, /href="\/"[\s\S]{0,240}<Logo /,
    'the logo must be inside a link to the home page, not decoration');
  assert.match(src, /aria-label="CampHawk/, 'an icon-only link needs an accessible name');
});

test('/connect still has no nav, deliberately', () => {
  // The fix is a logo, NOT the app chrome. Mounting V2Nav here would put an account menu and
  // three tabs on the screen where somebody is typing a third-party password — and the page
  // is outside the route group precisely so that cannot happen by accident.
  // COMMENTS STRIPPED FIRST. The comment beside the fix names `V2Nav` to explain why the
  // page does not have it, so a raw scan fails on its own explanation — and the "fix" a
  // hurried reader reaches for is deleting the explanation. Same rule as "must not kill by
  // image name" failing on the comment saying why not to.
  //
  // BLOCK comments, not just lines that START with a marker. The first version filtered
  // per line and left every CONTINUATION line of a `{/* … */}` block intact — which is
  // where the word actually sat, so the guard still failed on its own explanation and
  // looked like a real finding.
  const src = read('src/app/connect/page.tsx')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/V2Nav/.test(src), 'a credential screen must not gain the app nav');
});
