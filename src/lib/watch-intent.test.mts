/**
 * Guards for `src/lib/watch-intent.ts` and, more importantly, for the CHAIN it depends on.
 *
 * Under `src/` and not `worker/`, for the reason recorded in `acquisition.test.mts`.
 *
 * HALF OF THESE ARE STRUCTURAL, AND THAT IS THE POINT. `signUpToWatchHref` can be perfect
 * while a call site keeps its bare `/sign-up`, or while `AuthPanel` stops reading
 * `redirect_url` — and then the fix is present, inert, and looks correct in review. That
 * shape has cost this repo six recorded times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { newWatchPath, signUpToWatchHref } from './watch-intent';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** Comments quote the very shapes these tests forbid, so scan the CODE. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('the New watch screen gets /new’s parameter names, not /search’s', () => {
  // `/new` reads campground/start/end; `/search` uses startDate/endDate. A helper that
  // quietly renamed them would build a link that looks right and arrives EMPTY.
  assert.equal(
    newWatchPath({ campgroundId: 'rc-583', startDate: '2026-09-04', endDate: '2026-09-06' }),
    '/new?campground=rc-583&start=2026-09-04&end=2026-09-06',
  );
});

test('a partial intent carries what it has, and nothing empty', () => {
  assert.equal(newWatchPath({ startDate: '2026-09-04' }), '/new?start=2026-09-04');
  assert.equal(newWatchPath({}), '/new');
  assert.equal(newWatchPath({ campgroundId: '' }), '/new');
});

test('sign-up carries the destination, encoded, as redirect_url', () => {
  const href = signUpToWatchHref({ campgroundId: 'rc-583', startDate: '2026-09-04' });
  assert.equal(href, '/sign-up?redirect_url=%2Fnew%3Fcampground%3Drc-583%26start%3D2026-09-04');
  // Unencoded, the `&` would end redirect_url and the dates would be dropped on the floor —
  // a link that half-works, which is worse than one that plainly does not.
  assert.ok(!href.slice('/sign-up?'.length).includes('&'), 'the destination must be encoded');
});

test('it is redirect_url, the parameter AuthPanel actually reads', () => {
  // `forceRedirectUrl` is Clerk's own and would BYPASS /welcome — skipping the one screen
  // that asks how the user wants to be alerted. AuthPanel deliberately converts one into the
  // other; see its header.
  assert.ok(signUpToWatchHref({}).startsWith('/sign-up?redirect_url='));
});

// ── the chain, end to end. Any link in it can break the other two silently. ───────────────

test('AuthPanel still turns redirect_url into /welcome?next=', () => {
  const src = code('components/AuthPanel.tsx');
  assert.match(src, /params\.get\(['"]redirect_url['"]\)/, 'AuthPanel stopped reading redirect_url');
  assert.match(src, /\/welcome\?next=\$\{encodeURIComponent\(back\)\}/, 'the /welcome hop is gone');
  assert.match(src, /forceRedirectUrl=\{afterSignUp\}/, 'the destination is no longer forced');
});

test('Welcome still sends the user on to `next`', () => {
  const src = code('components/v2/Welcome.tsx');
  assert.match(src, /params\.get\(['"]next['"]\)/, 'Welcome stopped reading ?next');
  assert.match(src, /router\.push\(next\)/, 'Welcome no longer navigates to it');
});

test('Welcome stamps the acquisition source exactly once, off its own effect', () => {
  const src = code('components/v2/Welcome.tsx');
  assert.match(src, /fetch\(["']\/api\/user\/signup-source["'],\s*\{\s*method:\s*["']POST["']/);
  // Never awaited into the screen's own loading path: a diagnostic that can delay or fail the
  // thing it observes is not worth having.
  assert.ok(!/await fetch\(["']\/api\/user\/signup-source/.test(src));
});

test('AcquisitionCapture is mounted in the ROOT layout, not the (app) one', () => {
  // The SEO pages this exists to measure — /camping, the type hubs, /campground/<id> — sit
  // OUTSIDE the (app) route group. Mounted there it would miss exactly the traffic it was
  // built for, and would look like it was working.
  assert.match(code('app/layout.tsx'), /<AcquisitionCapture\s*\/>/);
  let appLayout = '';
  try { appLayout = code('app/(app)/layout.tsx'); } catch { /* fine */ }
  assert.ok(!appLayout.includes('AcquisitionCapture'), 'it must not be moved into the (app) group');
});

// ── no surface that HOLDS intent may discard it ──────────────────────────────────────────

test('every intent-holding component routes sign-up through watch-intent', () => {
  // A RULE, NOT A LIST. Pinning WatchCta and Explore by name is the version that passes while
  // the THIRD call site reintroduces the bug — which is how this one shipped in the first
  // place, beside a mechanism built for it that two files simply did not use.
  //
  // The selector is the capability: a component that knows a campground or a date range and
  // renders a sign-up link is one that can strand somebody. A file with neither (the nav, the
  // pricing page) has no intent to carry and is correctly out of scope.
  const dir = new URL('../components/v2/', import.meta.url);
  const offenders: string[] = [];
  let scanned = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.tsx')) continue;
    const src = code(`components/v2/${f}`);
    const holdsIntent = /campgroundId|range\.start|startDate/.test(src);
    // Matches a FIXED file too (`signUpToWatchHref`), not only a broken one. Keyed on the
    // literal alone, a component drops out of the selector the moment it is repaired — so the
    // guard would police only files that already fail it, and a later revert to `/sign-up`
    // would be invisible. That is the guard-anchored-on-the-wrong-thing shape, and the
    // `scanned >= 2` floor below is what catches it having happened.
    const signsUp = /["']\/sign-up["']|\/sign-up\?|signUpToWatchHref/.test(src);
    if (!holdsIntent || !signsUp) continue;
    scanned++;
    if (!/signUpToWatchHref\(/.test(src)) offenders.push(f);
  }
  assert.ok(scanned >= 2, `the selector matched only ${scanned} file(s) — it has stopped selecting`);
  assert.deepEqual(offenders, [], `these hold a campground or dates and discard them at sign-up: ${offenders.join(', ')}`);
});

// ── /auto-cart: the page that explains the differentiator ────────────────────────────────

test('/auto-cart describes BOTH lanes, and is reachable by a crawler', () => {
  // It said recreation.gov four times and ReserveCalifornia zero times, and was in no
  // sitemap — so the single capability that separates this product from every alerts-only
  // competitor had no crawlable page describing it. Found 2026-09-03 by searching for it.
  const page = read('app/auto-cart/page.tsx');
  const meta = page.slice(page.indexOf('export const metadata'), page.indexOf('function Step'));

  assert.match(meta, /ReserveCalifornia/, 'the title and description must name ReserveCalifornia');
  assert.match(meta, /Recreation\.gov/i, 'and Recreation.gov — it is one page for two lanes');
  assert.match(meta, /cancellation/i, 'the word somebody actually searches for');

  assert.match(code('app/sitemap.ts'), /\/auto-cart/, 'the page is not in the sitemap');
});

test('/auto-cart says the hold is California only, and does not promise the other portals', () => {
  // `supportsRcHold` is `source === 'reservecalifornia'` and is narrower than
  // `isUseDirectSource` ON PURPOSE: the bot signs in to ONE account and posts to
  // reservecalifornia.com, so an Ohio or Virginia watcher offered a hold is a promise
  // nothing on earth can perform. Two enforcers already exist in the product; a marketing
  // page that implies otherwise is a third place to get it wrong.
  const body = code('app/auto-cart/page.tsx');
  assert.match(body, /only ReserveCalifornia gets holds/i);
  for (const state of ['Ohio', 'Virginia', 'Arizona']) {
    assert.ok(body.includes(state), `${state} is watched but cannot be held — say so`);
  }
  // States we do not cover at all. The page listed Texas, New York and Oregon for years.
  for (const absent of ['Texas', 'New York', 'Oregon']) {
    assert.ok(!body.includes(absent), `${absent} is not a UseDirect portal we watch`);
  }
});

test('/auto-cart uses the shared beta wording rather than a paraphrase of its own', () => {
  // The drift `lib/autocart-beta` exists to prevent: two forms of words, and the careful
  // one quietly stops being the one people read. Anchored on the BODY, because the import
  // line sits above everything and a paraphrase in the markup would leave it matching.
  const src = read('app/auto-cart/page.tsx');
  const body = src.slice(src.indexOf('export const metadata'));
  assert.match(body, /AUTOCART_BETA_NOTE/, 'the RC section must render the shared note');
  assert.match(body, /AUTOCART_BETA_SCOPE/, 'and say which lane is NOT in testing');
  assert.ok(
    !/still under testing|in testing right now|may not always work/i.test(body),
    'a hand-written beta caveat has appeared beside the shared one',
  );
});
