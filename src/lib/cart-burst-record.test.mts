/**
 * THE FAST CART LANE MUST LEAVE A RECORD NOTHING CAN OVERWRITE.
 *
 * On 2026-09-17 a real user's hold was lost and "did the 500 ms burst fire, or is it broken?"
 * could not be answered — the burst's summary lived in `error` (overwritten by the slow lane's
 * ~110 retries) on a loss, and only in `log()` on a win, and `tail-log` rolls in thirteen
 * minutes. `src/lib/bot-events.ts` → `cartBurstReading` carries the full account.
 *
 * Every rule below is a way that could silently come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOT_EVENT_KINDS, cartBurstReading } from './bot-events';

const runner = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');
const readout = readFileSync('scripts/bot-events-readout.mts', 'utf8');

/** Anchors that silently invert: `indexOf` misses return -1, and `slice(-1)` passes vacuously. */
const at = (hay: string, needle: string, what: string): number => {
  const i = hay.indexOf(needle);
  assert.ok(i > -1, `anchor moved — this guard is measuring nothing: ${what}`);
  return i;
};

test('the kind is allow-listed, or the server stores it with a NULL kind', () => {
  // `recordNativeAlloc` silently stored an unrecognised context as NULL — in the table,
  // absent from the readout, and looking exactly like the instrument working.
  assert.ok((BOT_EVENT_KINDS as readonly string[]).includes('cart-burst'));
});

test('BOTH the win and the loss path emit — a win used to report no burst note at all', () => {
  const win = at(runner, 'ok: true, cartKey, cartEntryKey', 'the win report');
  const loss = at(runner, 'could not hold ${h.unitName ?? h.unitId}', 'the loss log line');
  // Scoped windows, not a whole-file count: a single emit would otherwise satisfy both.
  // ANCHORED AT THE START OF A LINE, so the call has to be REACHABLE. A substring match is
  // satisfied by `void 0 && noteBurst(...)` and by `if (false) noteBurst(...)` — the
  // fix-present-and-inert shape, which is how a dead `maybeMemoryDump` once passed 33 tests.
  // Both of these mutations survived the first round of this very suite.
  assert.match(runner.slice(win - 400, win), /\n\s*noteBurst\(h, \{[^}]*won: true/,
    'the WIN path does not record the burst — the case that used to report nothing at all');
  assert.match(runner.slice(loss, loss + 400), /\n\s*noteBurst\(h, \{[^}]*won: false/,
    'the LOSS path does not record the burst');
});

test('it is gated on waitedForRelease, or ~110 slow-lane retries each emit a row', () => {
  const fn = at(runner, 'const noteBurst = (h,', 'noteBurst');
  assert.match(runner.slice(fn, fn + 300), /if \(!waitedForRelease\) return;/,
    'ungated, this fires on every ordinary retry — and an absent row then means nothing');
});

test('it is NOT gated on the burst having retried — absence must mean "the lane never ran"', () => {
  const fn = at(runner, 'const noteBurst = (h,', 'noteBurst');
  const body = runner.slice(fn, fn + 1200);
  assert.doesNotMatch(body, /attempts\s*[<>]=?\s*\d/,
    'gating on an attempt count destroys the third reading: a lane that armed and stopped on '
    + 'attempt 1 is a different fault from one that never ran, and both would then look identical');
});

test('the emit never delays the cart — fire-and-forget, never awaited', () => {
  const fn = at(runner, 'const noteBurst = (h,', 'noteBurst');
  assert.match(runner.slice(fn, fn + 1200), /void reportBotEvent\('cart-burst'/,
    'a diagnostic that can delay the thing it observes is not worth having at 08:00:00');
  for (const m of ['noteBurst(h, { attempts, won: true', 'noteBurst(h, { attempts, won: false']) {
    const i = at(runner, m, m);
    assert.doesNotMatch(runner.slice(i - 10, i), /await\s*$/, `${m} is awaited on the cart path`);
  }
});

test('no cart key and no token reach the event', () => {
  const fn = at(runner, 'const noteBurst = (h,', 'noteBurst');
  const body = runner.slice(fn, fn + 1200);
  // Do not collect a field you then have to filter — an OAuth code and a password have each
  // reached a report in this repo by exactly this route.
  for (const banned of ['cartKey', 'entryKey', 'TOKEN', 'accesstoken']) {
    assert.ok(!body.includes(banned), `the burst event carries ${banned}`);
  }
});

test('the offset is MEASURED, not derived from the lead constant', () => {
  const fn = at(runner, 'const laneOpenedAt', 'laneOpenedAt');
  assert.match(runner.slice(fn, fn + 120), /laneOpenedAt = Date\.now\(\)/);
  const nb = at(runner, 'firstOffsetMs:', 'firstOffsetMs');
  assert.match(runner.slice(nb, nb + 80), /laneOpenedAt - releaseMoment/,
    '-BURST_LEAD_MS is arithmetic about where we MEANT to wake, and cannot show an overshoot');
});

test('the readout renders it, and an empty list is not an all-clear', () => {
  at(readout, "recentBotEvents('cart-burst'", 'the fetch');
  // LINE-ANCHORED: the function can be perfect and never called, and a substring match is
  // satisfied by `void 0 && cartBurstReading(x)`. That mutation survived the first round.
  assert.match(readout, /\n\s*printVerdict\([^\n]*cartBurstReading\(x\)/,
    'the reading is computed and never printed — the fix-present-and-inert shape');
  const head = at(readout, 'CART BURSTS:', 'the section');
  const empty = readout.slice(head, head + 1200);
  // The empty branch must state the THIRD reading — no row at all means the lane never ran —
  // and must not offer an all-clear, which is the one sentence that would retire the finding.
  assert.match(empty, /absent row is the/,
    'silence must be reported as the finding it is, not as nothing to report');
  assert.match(empty, /never ran/, 'the empty branch must name what an absent row means');
  assert.doesNotMatch(empty, /all[ -]clear|nothing to report|no problems/i,
    'an empty list is not an all-clear, and saying so is the whole point of this branch');
});

test('a win reads as a win', () => {
  const r = cartBurstReading({ attempts: 3, won: true, firstOffsetMs: -14000, lastOffsetMs: 1440 });
  assert.equal(r.kind, 'won');
  assert.match(r.text, /WON IT on attempt 3 at T\+1\.4s/);
});

test('a race that was lost is NOT reported as a broken lane', () => {
  const r = cartBurstReading({
    attempts: 31, won: false, firstOffsetMs: -14000, lastOffsetMs: 31000, reason: '30s window closed',
  });
  assert.equal(r.kind, 'raced');
  assert.match(r.text, /T-14\.0s to T\+31\.0s/, 'a negative offset is the finding and must render signed');
  assert.match(r.text, /burst is not broken/);
});

test('one attempt is NOT a race — it names the fault instead', () => {
  const r = cartBurstReading({
    attempts: 1, won: false, firstOffsetMs: -14000, lastOffsetMs: 900,
    reason: 'RC said something else: HTTP 403',
  });
  assert.equal(r.kind, 'stopped-early');
  assert.match(r.text, /ARMED and stopped after one attempt/);
  assert.match(r.text, /HTTP 403/, 'the reason is what distinguishes it from a lost race');
  assert.doesNotMatch(r.text, /competitor was faster/);
});

test('a missing offset is NAMED, never rendered as T+0.0s and never dropped', () => {
  // An absent reading standing in for a real one is this repo's most-repeated failure, and
  // `T+0.0s` would read as the sharpest possible measurement rather than as no measurement.
  // DROPPING it is the same failure wearing different clothes, and it is what the first
  // version of this function did: with no offsets the window simply vanished from the
  // sentence, so "we recorded no timing" and "the timing was not worth showing" read alike.
  // This guard therefore pins BOTH directions, and the second one is the one that fired.
  const none = cartBurstReading({ attempts: 5, won: false, reason: 'x' });
  assert.equal(none.kind, 'raced');
  assert.match(none.text, /no timing recorded/, 'absence must be stated, not omitted');
  assert.doesNotMatch(none.text, /T\+0\.0s/);

  // One end present is the harder case: the window still renders, and the missing end says so
  // rather than borrowing the other end's number or quietly collapsing to a point.
  const half = cartBurstReading({ attempts: 5, won: false, lastOffsetMs: 31_000, reason: 'x' });
  assert.match(half.text, /from T\? to T\+31\.0s/);

  // The two single-offset branches read `at(last)` bare, so they carry the same rule.
  const armed = cartBurstReading({ attempts: 1, won: false, reason: 'x' });
  assert.match(armed.text, /T\?/);
  assert.doesNotMatch(armed.text, /T\+0\.0s/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE BURST STOPPED ON ITS OWN SUCCESS, AND WE HELD #R359 FOR FIFTEEN MINUTES
 * WHILE LOGGING "COULD NOT HOLD" (2026-09-21, from the runner's own log).
 *
 *   15:00:00  ✗ could not hold #R359: HTTP 200 (13 fast attempts ending T-0.5s
 *             … RC said something else: HTTP 200)
 *   15:00:24  ✗ could not hold #R359: cart is already added   <- and ~75 more
 *   15:15:03  ✓ held #R359 — entry 9b6aa2dc-…
 *
 * Two defects, one response:
 *
 *   1. `verdict()` sets `error: res?.ErrorMessage || ''`, and a SUCCESSFUL submit has no
 *      ErrorMessage. `why = v.error || \`HTTP ${status}\`` therefore produced the literal
 *      string "HTTP 200", `isNotAvailable` did not recognise it, and `shouldRetryBurst`
 *      stopped the lane — half a second before the release, with 15 budget left.
 *   2. `findCartEntry` could not identify our entry, so a cart RC said was ours read as a
 *      miss ~75 times, each one a real precart round-trip.
 *
 * These are STRUCTURAL assertions because the burst loop lives inside `withRC` with a
 * Playwright page, a live RC session and a running browser behind it. Extracting it to
 * make it callable is a larger and riskier change than the fix; what matters here is
 * positional — WHICH signals the verdict consults, and in WHAT ORDER.
 * ──────────────────────────────────────────────────────────────────────────── */

const RUNNER = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');

/** The burst attempt body, bounded so an assertion cannot wander into the release loop. */
function burstBody(): string {
  const from = RUNNER.indexOf('const result = await precartInPage(page, {');
  assert.ok(from > -1, 'the burst precart call must still exist — anchor not found');
  const to = RUNNER.indexOf('await report({ id: h.id, ok: false', from);
  assert.ok(to > from, 'the failure report must still follow it — anchor not found');
  return RUNNER.slice(from, to).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('an empty ErrorMessage is no longer reported as "RC said something else"', () => {
  const body = burstBody();
  // The exact shape that produced "HTTP 200". If this comes back, so does the bug.
  assert.ok(!/v\?\.error \|\| `HTTP \$\{result\?\.submitted\?\.status\}`/.test(body),
    'the bare || fallback from ErrorMessage straight to the status must not return');
  assert.match(body, /isSuccess === true/,
    'a successful submit must be distinguished from an unrecognised refusal');
  assert.match(body, /RC accepted the submit and our entry could not be identified/,
    'and must say which of the two it was, in words the next reader can act on');
});

test('a cart RC says is ours is read back by CONTENTS when the matcher misses', () => {
  const body = burstBody();
  assert.match(body, /listCartEntries\(/,
    'the contents fallback must exist — each hold mints its own cart, so one entry is ours');
  assert.match(body, /already added/,
    "and must fire on RC's own \"cart is already added\", which is proof we hold it");
  // ORDER: the fallback must run BEFORE the found/not-found branch, or it cannot change
  // the verdict — the fix-present-and-inert shape.
  assert.ok(body.indexOf('listCartEntries(') < body.indexOf('if (check.found) {'),
    'the fallback must run before the verdict is taken');
});

test('the fallback demands a POSITIVE reading, three ways', () => {
  const body = burstBody();
  const arm = body.slice(body.indexOf('if (!check.found && cartKey)'), body.indexOf('if (check.found) {'));
  assert.ok(arm.length > 200, 'the fallback arm must still exist — anchor not found');
  // AN UNREADABLE CART IS NOT AN EMPTY ONE. listCartEntries returns [] for both.
  assert.match(arm, /status === 200/, 'a non-200 must not be read as a cart');
  assert.match(arm, /length === 1/, 'and only exactly one entry identifies ours');
  // NO ENTRY KEY, NO RELEASE. Marking carted without one strands the campsite.
  assert.match(arm, /if \(key\)/, 'and an entry with no key must not be adopted');
  // PINNED ON THE CONDITION, NOT THE DECLARATION. The first version asserted `/rcSaysOurs/`,
  // which still matched after `if (rcSaysOurs)` was replaced with `if (true)` — the variable
  // was merely still declared. That is the most dangerous mutation of the five, because
  // without this precondition the fallback adopts a stray entry on any refusal and the bot
  // can release somebody else's hold. Verified: it survived, then did not.
  assert.match(arm, /if \(rcSaysOurs\)/,
    'RC must positively say it is ours, and that must be the CONDITION, not just a variable');
  assert.match(arm, /isSuccess === true \|\| said\.includes\('already added'\)/,
    'and the two signals that constitute it must both be read');
});

test('the import is present, so the fallback is not a reference to nothing', () => {
  // A call to an unimported symbol throws at the worst possible moment — inside the burst,
  // at the release, on the one path that either gets somebody a campsite or does not.
  assert.match(RUNNER, /import \{[^}]*listCartEntries[^}]*\} from '\.\/rc-cart\.mjs'/,
    'listCartEntries must be imported from rc-cart.mjs');
});
