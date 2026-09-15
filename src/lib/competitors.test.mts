/**
 * Guards for the comparison pages.
 *
 * Under `src/`, not `worker/` — `worker/**` is the first entry in `worker-deploy.yml`'s
 * `paths:`, so a guard over web modules there restarts both poller machines.
 *
 * THE FIRST TWO TESTS ARE THE POINT. The rest is plumbing. These pages make claims about
 * rival businesses on a public marketing surface, and both campnab.com and campflare.com
 * were unreachable from the environment they were written in — so anything specific about a
 * competitor would have been written from memory, which is how this becomes a legal problem
 * rather than a bad paragraph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPETITORS, competitorBySlug, comparisonUrl } from './competitors';
import { staticEntries } from './sitemap-sections';

const read = (p: string) => readFileSync(resolve(import.meta.dirname, '..', p), 'utf8');
/** The headers explain the forbidden shapes, so scan the CODE. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const RENDERER = 'components/v2/ComparisonPage.tsx';
const CONFIG = 'lib/competitors.ts';

test('no competitor price appears anywhere on these pages', () => {
  // Their pricing changes without telling us, so even a correct figure rots into an
  // incorrect one on a page nobody revisits. OUR prices are fine and are here on purpose;
  // what is forbidden is a number attached to their name.
  for (const c of COMPETITORS) {
    for (const file of [CONFIG, RENDERER, `app/vs/${c.slug}/page.tsx`]) {
      const src = code(file);
      const idx = src.indexOf(c.name);
      if (idx === -1) continue;
      // A price within 120 characters of a competitor's name is a price about them.
      const near = src.slice(Math.max(0, idx - 120), idx + 120);
      assert.ok(
        !/\$\s?\d/.test(near),
        `${file} puts a price next to "${c.name}" — we cannot verify their pricing`,
      );
    }
  }
});

test('no page asserts what a competitor does NOT do, or that we beat them', () => {
  // A two-column grid with ticks in our column persuades nobody who is shopping — they
  // assume we wrote it, because we did — and every cross in their column is a claim we
  // cannot stand behind. Comparative superlatives are the same problem in prose.
  const forbidden: [RegExp, string][] = [
    [/\b(they|campnab|campflare)\s+(do|does)(n't| not)\b/i, 'an assertion about what they do not do'],
    [/\bunlike (campnab|campflare|them)\b/i, 'an "unlike them" comparison'],
    [/\b(cheaper|faster|better|more accurate) than\b/i, 'an unverifiable comparative'],
    [/\bonly (campnab|campflare)\b/i, 'a claim about their limits'],
    [/\b(campnab|campflare) (only|can't|cannot|lacks|misses)\b/i, 'a claim about their limits'],
  ];
  for (const file of [CONFIG, RENDERER, ...COMPETITORS.map((c) => `app/vs/${c.slug}/page.tsx`)]) {
    const src = code(file);
    for (const [re, what] of forbidden) {
      assert.ok(!re.test(src), `${file} contains ${what}`);
    }
  }
});

test('every page links to the competitor’s own site, nofollow', () => {
  // "Check for yourself" is the only honest answer to "what do they do", and it is what
  // makes the page trustworthy rather than a rigged table. nofollow because we are not
  // vouching for a rival's site, and noopener because it is an external target.
  const src = code(RENDERER);
  assert.match(src, /competitor\.homepage/, 'the renderer never links out to them');
  assert.match(src, /rel="noopener nofollow"/);
  for (const c of COMPETITORS) assert.match(c.homepage, /^https:\/\//, `${c.slug} homepage`);
});

test('the pages say when NOT to buy from us — recreation.gov ships free alerts', () => {
  // True since July 2024, and the strongest thing on the page: a buyer who finds out later
  // feels sold to, and saying it first is what sets up the two things a free federal alert
  // cannot do. Losing this paragraph would make the page ordinary.
  const src = code(RENDERER);
  assert.match(src, /Recreation\.gov has its own free cancellation alerts/i);
  assert.match(src, /might not need to pay anyone/i);
});

test('the numbers are DERIVED from the product’s own constants, never typed', () => {
  // Hand-typed marketing copy drifts into overstating the catalog; this is the same reason
  // `campgroundsRounded()` rounds DOWN. A literal here is a claim that stops being true
  // silently.
  const src = code(RENDERER);
  assert.match(src, /campgroundsRounded\(\)/, 'the campground count is hardcoded');
  assert.match(src, /COVERAGE\.states/, 'the state count is hardcoded');
  assert.match(src, /COVERAGE\.stateParkStates/, 'the state-park count is hardcoded');
  assert.match(src, /DATA_SOURCES\.length/, 'the source count is hardcoded');
  assert.ok(!/8,000\+|8013|\b50 states\b/.test(src), 'a literal coverage number is in the copy');
});

test('the ReserveCalifornia claim carries the shared beta wording', () => {
  // The RC hold is in beta and the page is selling it to somebody deciding whether to pay.
  // Composed from lib/autocart-beta, never restated — that module exists because
  // AutoCartSettings once carried its own paraphrase and the careful sentence stopped being
  // the one people read.
  //
  // ANCHORED ON THE BODY, NOT THE FILE. The first version scanned the whole file, so
  // `AUTOCART_BETA_NOTE` matched on the IMPORT LINE — which sits above everything — and
  // deleting the caveat from the markup left the guard green. Caught by mutation, and it is
  // the same mistake recorded against autocart-beta.test.mts and half a dozen others here:
  // an assertion that matches an import proves the module is imported, not that it is used.
  const src = code(RENDERER);
  const i = src.indexOf('export default');
  assert.ok(i > -1, 'the renderer has no default export to anchor on — the guard reads nothing');
  const body = src.slice(i);
  assert.match(body, /ReserveCalifornia/);
  assert.match(body, /\{AUTOCART_BETA_NOTE\}/, 'the RC claim is unqualified, or the caveat is a paraphrase');
  assert.ok(
    !/still in testing|may not always work|under development/i.test(body),
    'a hand-written beta caveat has appeared beside the shared one',
  );
});

// ── plumbing, but each of these fails silently in production ─────────────────────────────

test('every competitor has a route, and every route has a competitor', () => {
  // The inert-fix shape: config without a route renders nothing, a route without config
  // throws on the non-null assertion at module scope and takes the build down.
  for (const c of COMPETITORS) {
    assert.ok(
      existsSync(resolve(import.meta.dirname, '..', `app/vs/${c.slug}/page.tsx`)),
      `no route for /vs/${c.slug}`,
    );
    assert.equal(competitorBySlug(c.slug)?.name, c.name);
  }
  assert.equal(competitorBySlug('nobody'), undefined);
});

test('/vs/(.*) is a PUBLIC route', () => {
  // Clerk's auth.protect() answers 404, not 401 — so an omission here is a 404 on the pages
  // built for the highest-intent queries we have, with nothing red anywhere.
  assert.match(code('middleware.ts'), /'\/vs\/\(\.\*\)'/);
});

test('every comparison page is in the sitemap, derived from the config', async () => {
  const urls = (await staticEntries()).map((e) => String(e.url));
  for (const c of COMPETITORS) {
    assert.ok(urls.includes(`https://camphawk.app/vs/${c.slug}`), `/vs/${c.slug} is not submitted`);
  }
  assert.match(code('lib/sitemap-sections.ts'), /COMPETITORS\.map/, 'the list is typed out and will go stale');
});

test('the canonical matches the route', () => {
  // A canonical pointing anywhere else de-indexes the page it is on, silently.
  for (const c of COMPETITORS) {
    assert.equal(comparisonUrl(c.slug), `https://camphawk.app/vs/${c.slug}`);
    assert.match(code(`app/vs/${c.slug}/page.tsx`), new RegExp(`comparisonUrl\\('${c.slug}'\\)`));
  }
});

test('the title and description carry the query somebody actually types', () => {
  for (const c of COMPETITORS) {
    const src = read(`app/vs/${c.slug}/page.tsx`);
    const meta = src.slice(src.indexOf('export const metadata'), src.indexOf('export default'));
    assert.ok(meta.includes(c.name), `the title does not name ${c.name}`);
    assert.match(meta, /CampHawk vs/, 'the "X vs Y" shape is the query');
    assert.match(meta, /cancellation/i);
  }
});
