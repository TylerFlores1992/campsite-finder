/**
 * TWO BOT-SIDE FIXES, AND BOTH FAIL SILENTLY IF THE WIRING SLIPS.
 *
 * 1. **A SKIPPED REHEARSAL COUNTED AS A REHEARSAL** (2026-09-21, from the box's own log).
 *    `recordRehearsal` stamps `ran_at = NOW()` on EVERY call including a skip, and the feed
 *    handed that to `shouldRehearse` as `hoursSinceLastRun`. So a skip satisfied the very
 *    gap it was being measured against:
 *
 *        03:00 · skip  the session is live — a rehearsal would prove nothing   (correct)
 *        03:07 · skip  rehearsed 0h ago
 *
 *    The thing it had "rehearsed 0h ago" WAS that skip — and 03:07 came right after the box
 *    update, the event that ENDS the RC session and replaces the code, so the one
 *    informative rehearsal was declined on the strength of a non-event.
 *
 * 2. **THE REQUEST COUNTER SAW ONE TAB** (#26). `attach(page)` binds to a single Page, so
 *    every request the trip's other tabs made was invisible to the counter whose job is to
 *    say what the browser was doing.
 *
 * Both are one-line wirings behind a lot of prose, which is exactly the fix-present-and-inert
 * shape — so what is pinned here is that the wire is connected, not that the prose is nice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

const HOLDS = code('src/lib/rc-holds.ts');
const FEED = code('src/app/api/auto-cart/rc-holds/route.ts');
const COUNTER = code('scripts/auto-cart-bot/rc-request-count.mjs');
const KEEPWARM = code('scripts/auto-cart-bot/rc-keepwarm.mjs');

// ── 1. the rehearsal gap ────────────────────────────────────────────────────────────

test('the gap query EXCLUDES skips — that is the entire fix', () => {
  const i = HOLDS.indexOf('export async function lastRehearsalAttempt');
  assert.ok(i > -1, 'lastRehearsalAttempt is gone — re-anchor this test');
  const fn = HOLDS.slice(i, HOLDS.indexOf('\n}', i));
  assert.match(fn, /FROM rc_login_rehearsal_log/,
    'it must read the LOG, which records every call, not the singleton');
  assert.match(fn, /WHERE skipped_why IS NULL/,
    'a skip must not count as an attempt — this predicate IS the bug fix');
  assert.match(fn, /ORDER BY ran_at DESC/, 'and take the newest');
});

test('a FAILED rehearsal still counts as an attempt', () => {
  // Deliberate. The gap rations logins from an address whose anti-bot posture cost twelve
  // hours once, and a login that failed spent that budget exactly as a passing one did.
  // Filtering on `ok IS TRUE` would retry a failing login every twenty minutes.
  const i = HOLDS.indexOf('export async function lastRehearsalAttempt');
  const fn = HOLDS.slice(i, HOLDS.indexOf('\n}', i));
  assert.ok(!/\bok IS TRUE\b/.test(fn) && !/\bok = true\b/.test(fn),
    'the gap must not filter on success — a failed attempt still spent the login');
});

test('the FEED serves the attempt, not the last row written', () => {
  // THE WIRING, and the half that can be inert: `lastRehearsalAttempt` can be perfect while
  // the feed still hands `rehearsal?.ran_at` to the box, which is the value that was wrong.
  assert.match(FEED, /lastRehearsalAttempt\(\)/, 'the feed must call it');
  assert.match(FEED, /lastRehearsalAt: rehearsalAttempt\?\.ran_at/,
    'and lastRehearsalAt must come from the ATTEMPT, never from the singleton row');
  assert.ok(!/lastRehearsalAt: rehearsal\?\.ran_at/.test(FEED),
    'the old wiring is the bug — a skip writes that row too');
});

test('the singleton is still read for its OWN purpose', () => {
  // `lastRehearsal` stays: /api/health/status reads `ran_at`/`ok_at` to answer "has the
  // rehearsal gone quiet", which is a different question and one a skip SHOULD answer.
  assert.match(FEED, /lastRehearsal\(\)/, 'both are served; they answer different questions');
});

// ── 2. the request counter ──────────────────────────────────────────────────────────

test('attach takes a context, and the keep-warm passes one', () => {
  assert.match(COUNTER, /function attach\(target\)/,
    'attach must not be page-specific — Page and BrowserContext share the event shape');
  assert.match(COUNTER, /target\.on\('request'/, 'and bind to whatever it was given');
  assert.match(KEEPWARM, /requestCounter\.attach\(ctx\)/,
    'the keep-warm must attach the CONTEXT — a page binding sees one tab');
});

test('it attaches to exactly ONE target — double counting is worse than undercounting', () => {
  // A context handler already fires for its pages. Attaching both would silently double
  // every resident request, and a counter that doubles is worse than one that undercounts:
  // the undercount is the failure everybody already suspects.
  const attaches = [...KEEPWARM.matchAll(/requestCounter\.attach\(/g)];
  assert.equal(attaches.length, 1, `attach is called ${attaches.length} times — must be once`);
  assert.ok(!/requestCounter\.attach\(page\)/.test(KEEPWARM),
    'the page binding must be gone, not merely joined by a context one');
});

// ── THREE DIAGNOSTICS, added 2026-09-23 ────────────────────────────────────────────
//
// Four of the five "mechanism not established" items need the SAME thing: one more field
// recorded at the moment of failure. Not analysis — a reading nobody took. These pin that
// each is recorded, and that none of them asserts the mechanism it is measuring.

const RUNNER = code('scripts/auto-cart-bot/rc-hold-runner.mjs');
const CART = code('scripts/auto-cart-bot/rc-cart.mjs');
const GUARD = code('scripts/auto-cart-bot/update-guard.mjs');
const CONTENT = code('extension/content-rc.js');

test('update-guard records WHAT `requested` read, not just that it refused', () => {
  // 2026-09-21: an update the owner had requested was refused for being outside the quiet
  // window, which `if (!requested && …)` says cannot happen. The note recorded only the
  // refusal, so "the feed said no" and "the guard never got an answer" were the same row.
  // `feedReachable` is already true by this branch, so a false `requested` here means the
  // feed ANSWERED and said no — the fact that separates them.
  assert.match(GUARD, /updateRequested=\$\{requested\}/,
    'the refusal must carry the value it refused on');
});

test('findCartEntry reports the entry SHAPE on a miss, and never the values', () => {
  assert.match(CART, /const shape = \(!hit && list\.length\)/,
    'only on a miss with a non-empty list — a hit needs no explaining');
  assert.match(CART, /Object\.keys\(e \?\? \{\}\)/, 'KEY NAMES, which cannot carry a secret');
  // The standing rule: do not collect a value you would then have to filter. An OAuth code
  // was published on 2026-08-09 and a password on 08-16, both that way.
  assert.ok(!/Object\.values\(|JSON\.stringify\(e\)\s*\)/.test(CART.split('const shape')[1] ?? ''),
    'the shape must never carry entry VALUES');
});

test('the runner logs both readings the matcher miss needs', () => {
  // Two facts settle "why does findCartEntry miss a cart RC says is ours", and both are
  // already in hand at that call site: whether `locked` was null (nothing to match ON) and
  // which fields the entries carry (nothing to match AGAINST).
  assert.match(RUNNER, /locked=\$\{locked === null \? 'NULL' : 'present'\}/,
    'the null-locked candidate must be recorded, not assumed');
  assert.match(RUNNER, /entryFields=/, 'and what the entries actually carried');
});

test('the client reads its cart back ON A REFUSAL — the reading #M450 needed', () => {
  // The existing verification only runs at /customers/shoppingcart, which a failed
  // hand-off never reaches, so a decline produced no cart reading at all.
  assert.match(CONTENT, /void readCartAfterFailure\(res\.status, apiError\)/,
    'the failure branch must take the reading');
  assert.match(CONTENT, /async function readCartAfterFailure/, 'and the helper must exist');
  // ITS OWN STAGE. `cart-verified` means "we carted and confirmed it"; a failure reusing
  // that phrase would read as a success in every readout that greps for it.
  assert.match(CONTENT, /cart-after-failure:/, 'a distinct label, never cart-verified');
  assert.ok(!/readCartAfterFailure[\s\S]{0,900}cart-verified/.test(CONTENT),
    'the failure reading must not borrow the success phrase');
});

test('the diagnostic can never become the failure it is diagnosing', () => {
  const i = CONTENT.indexOf('async function readCartAfterFailure');
  const fn = CONTENT.slice(i, CONTENT.indexOf('\n  }', i));
  assert.match(fn, /try \{/, 'it must swallow its own errors');
  assert.match(fn, /catch \(e\) \{/, 'including the parse');
  // `entries: null` and `entries: 0` are opposite facts — "could not read" vs "empty".
  assert.match(fn, /let entries = null;/, 'an unreadable cart must not default to empty');
  assert.match(CONTENT, /void readCartAfterFailure/,
    'called with void — a diagnostic must not delay the screen somebody is reading');
});

test('every identifier the new helper uses is DEFINED in that file', () => {
  // A draft called `report(...)` and used `CART_LOAD`, neither of which exists here — it
  // would have thrown a ReferenceError on the first refusal, i.e. exactly when it was
  // needed. `node --check` passes on that happily; only this notices.
  for (const id of ['CART_LOAD', 'NO_CART']) {
    assert.match(CONTENT, new RegExp(`const ${id} =`), `${id} must be declared in content-rc.js`);
  }
  assert.ok(!/\breport\(/.test(CONTENT),
    'there is no report() in this file — it reports through the [CampHawk RC] console hook');
  assert.match(CONTENT, /console\.log\('\[CampHawk RC\] cart-after-failure:/,
    'and the reading must go through that hook, which scrubs on the way');
});
