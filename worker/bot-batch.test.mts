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
