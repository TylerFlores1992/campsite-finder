// A TEST FIXTURE MUST NEVER MAKE THE HOLD RUNNER TAKE THE CHROMIUM PROFILE.
//
// ── WHAT THIS COSTS WHEN IT IS WRONG, MEASURED 2026-08-19 ─────────────────────────────────
// The runner asks the keep-warm for the profile whenever the feed gives it work. The keep-warm
// yields, closes its browser and reopens — and the live access token lives in page memory
// (`window.__camphawkRcToken`), not in localStorage, so the reopen comes back signed out:
//
//     13:33:52 ♻ token exp in 45m; renewed=no; src=live; okta=ALIVE
//     13:49:07 → hold runner wants the profile — closing and standing down
//     13:49:50 RC loaded and STAYING OPEN — token source: none
//     13:50:38 ⚠ RC SESSION IS DEAD
//
// That killed a session which had sustained itself for SEVEN HOURS since a hand sign-in. The
// work it wanted the profile for was a `npm test` sentinel — the runner's log names
// `#L__t9003`, `#L__t9102`, `#L__t9007` — during CI for a pull request that changed only
// Markdown. A run landing near 08:00 takes the session a real cart depends on.
//
// ── WHY THE FILTER IS IN THE FEED AND NOT IN THE QUERIES ──────────────────────────────────
// `dueHolds` and `pendingClaims` are what the hold suites exist to test, so filtering them
// would gut the tests that make this table safe — which is exactly why the 2026-08-18 fix
// stopped at `nextHoldRelease` and `holdAtRisk`. Filtering the FEED costs those suites nothing
// and still means the runner never sees a fixture.
//
// This is a source scan rather than a real-DB test on purpose: the defect is three `.filter`
// calls in one route body, and standing up a Next route to prove a predicate is applied would
// test the harness. The PREDICATE itself is exercised directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRealUnitId } from '../src/lib/rc-holds';

const ROUTE = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
const body = ROUTE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const LIB = readFileSync('src/lib/rc-holds.ts', 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the predicate accepts real unit ids and rejects every sentinel shape', () => {
  for (const real of ['4734', '43821', '9003', '0']) {
    assert.equal(isRealUnitId(real), true, `${real} is a real RC unit id`);
  }
  // The shapes the suites actually use — `U()` produces `__t9003`.
  for (const fake of ['__t9003', '__t9102', '__camphawk-verify-DO-NOT-USE__', 'TEST', '']) {
    assert.equal(isRealUnitId(fake), false, `${fake} must never reach the runner`);
  }
  assert.equal(isRealUnitId(null), false, 'a missing id is not a real one');
  assert.equal(isRealUnitId(undefined), false);
});

test('it agrees with the SQL rule, which is the whole point of reusing it', () => {
  // Two forms of one rule. If they drift, the feed and the queries disagree about what a
  // fixture is — and the disagreement would be invisible at both call sites.
  const sql = /unit_id ~ '\^\[0-9\]\+\$'/.test(LIB);
  assert.ok(sql, 'REAL_UNIT must still be the numeric rule');
  assert.match(LIB, /\/\^\[0-9\]\+\$\/\.test\(unitId\)/,
    'and isRealUnitId must use the same character class, not a looser one');
});

test('ALL THREE work lists are filtered — each one makes the runner take the profile', () => {
  // `claim`, `cart` and `release` are all work. The 13:49 pass that killed the session read
  // "1 to hand over, 1 to cart, 1 to release" — every list had a fixture in it.
  assert.match(body, /claim: claimReal\.map\(forBot\)/, 'claims must be filtered');
  assert.match(body, /cart: cartReal\.map\(forBot\)/, 'due carts must be filtered');
  assert.match(body, /release: real\(stale\.toRelease\)\.map\(forBot\)/, 'releases must be filtered');
  assert.match(body, /const real = \(rows: HoldRequest\[\]\) => rows\.filter\(\(h\) => isRealUnitId\(h\.unit_id\)\)/,
    'and all three must go through one predicate, not three hand-rolled copies');
});

test('the fast-lane cadence follows the FILTERED lists', () => {
  // Keyed on the raw ones, a fixture would drop the runner onto its 1s poll — hammering the
  // feed for work it is no longer being given, which is the churn this exists to stop.
  assert.match(body, /pollMs: claimReal\.length \? 1000 : cartReal\.length \? 5000 : null/,
    'pollMs must be computed from the filtered lists');
  assert.ok(!/pollMs: claims\.length/.test(body), 'never from the unfiltered claims');
  assert.ok(!/cart\.length \? 5000/.test(body), 'nor the unfiltered carts');
});

test('the QUERIES stay unfiltered, so the hold suites keep their subject', () => {
  // The reason this fix lives in the feed at all. If somebody later "tidies" it into
  // `dueHolds`, the suites that make this table safe stop testing anything.
  assert.match(LIB, /export async function dueHolds/);
  const due = LIB.slice(LIB.indexOf('export async function dueHolds'));
  const stmt = due.slice(0, due.indexOf('}'));
  assert.ok(!/REAL_UNIT/.test(stmt),
    'dueHolds must NOT filter by unit id — the hold suites exist to test it');
});

test('`expired` is deliberately NOT filtered', () => {
  // It is a count of rows already swept, not work — the runner only logs it. Filtering it
  // would quietly under-report the sweep.
  assert.match(body, /expired: stale\.expired/,
    'the expired count passes through whole');
});
