/**
 * The held-check cadence.
 *
 * What these guard is a SILENT loss: if the held check stops running often enough, no
 * error appears anywhere — `rcHeld` is simply empty, which is also what "nothing is
 * locked" looks like, which is the correct answer almost every cycle. The same shape as
 * the flex bug in `heldStayRun`, and as `hasAvailabilityInRange` returning a flat false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heldCheckDue, clampHeldInterval, RC_HELD_CHECK_DEFAULT_MS, holdIsNewsworthy, pacificWallClockToUtcMs, HOLD_MIN_LEAD_MS } from './held-cadence';

const MIN = 60_000;

test('a worker that has never checked is due immediately', () => {
  // A deploy at 07:55 against an 08:00 release must look BEFORE the release, not one
  // full interval after boot. `lastAt = 0` is "never", not "just now".
  assert.equal(heldCheckDue(0, Date.now(), 5 * MIN), true);
});

test('due only once the interval has elapsed', () => {
  const t = 1_000_000;
  assert.equal(heldCheckDue(t, t + 4 * MIN, 5 * MIN), false);
  assert.equal(heldCheckDue(t, t + 5 * MIN, 5 * MIN), true, 'exactly the interval counts as due');
  assert.equal(heldCheckDue(t, t + 9 * MIN, 5 * MIN), true);
});

test('a backwards clock does not wedge the check off', () => {
  // Fly machines resume from snapshots and NTP steps them. A `lastAt` in the future would
  // otherwise suppress the check until real time caught up — potentially hours, with an
  // 8am release inside the gap. Failing toward checking costs one grid fetch.
  const t = 1_000_000;
  assert.equal(heldCheckDue(t + 60 * MIN, t, 5 * MIN), true);
});

test('the interval can never exceed the newsworthiness floor it depends on', () => {
  // holdIsNewsworthy refuses any coming-soon alert with under an hour of lead. An interval
  // at or above that floor means a lock found at T-59min is announced at T-0 — i.e. never
  // — and nothing would report it, because "no held unit" is the usual answer.
  assert.equal(clampHeldInterval(60 * MIN), 15 * MIN, 'an hour is clamped to a quarter of the floor');
  assert.equal(clampHeldInterval(6 * 60 * MIN), 15 * MIN);
  assert.equal(clampHeldInterval(5 * MIN), 5 * MIN, 'a sane value passes through');
});

test('a broken env var falls back rather than stopping the check', () => {
  // RC_HELD_CHECK_MS='' → Number('') is 0, and 0 or NaN as an interval would make every
  // cycle due (harmless) or the arithmetic meaningless. A bad env var must not be able to
  // change the poller's behaviour silently in either direction.
  assert.equal(clampHeldInterval(Number('')), RC_HELD_CHECK_DEFAULT_MS);
  assert.equal(clampHeldInterval(Number('abc')), RC_HELD_CHECK_DEFAULT_MS);
  assert.equal(clampHeldInterval(-1), RC_HELD_CHECK_DEFAULT_MS);
});

test('the default leaves several chances inside the lead floor', () => {
  // Not asserting "300000" — asserting the PROPERTY that makes it safe, so changing the
  // number deliberately still passes and changing it carelessly does not.
  assert.ok(RC_HELD_CHECK_DEFAULT_MS * 4 <= 60 * MIN,
    'at least four held checks must fit inside the one-hour newsworthiness floor');
});

// ---------------------------------------------------------------------------
// THE SEVEN-HOUR ERROR (2026-08-26).
//
// `holdIsNewsworthy` lived in `poller.ts`, where importing the file starts the poller, so
// it had no test and carried this for three weeks: RC's `Lock` is a zone-less PACIFIC
// wall clock and it was read with a bare `new Date()`, i.e. as the server's zone, which on
// Fly is UTC. An 08:00 Pacific release was placed at 08:00 UTC — 01:00 PT — so the
// "at least an hour of lead" test shut the offer window at MIDNIGHT Pacific.
//
// These use the real production numbers rather than round ones, because the bug is a
// seven-hour shift and any fixture inside a seven-hour band of the boundary would pass
// against both the broken and the fixed version.
// ---------------------------------------------------------------------------

const PT = (s: string) => new Date(s); // ISO with an explicit offset — a real instant.

test('an 08:00 PACIFIC release is an instant in the afternoon UTC, not the morning', () => {
  // 2026-08-26 is PDT (UTC-7), so 08:00 PT === 15:00Z. Reading it as UTC would give 08:00Z.
  assert.equal(pacificWallClockToUtcMs('2026-08-26T08:00:00'),
    Date.parse('2026-08-26T15:00:00Z'),
    'a zone-less RC Lock must be read as Pacific; as UTC it lands seven hours early');
});

test('THE REFUSAL THAT WAS THE BUG: 05:08 PT is 2h52m of lead, and that IS news', () => {
  // The live case. A watch created at 05:07:46 PT was refused for 2.5 hours with
  // "too soon to be news" while the release was at 08:00 PT the same morning.
  const now = PT('2026-08-26T05:08:00-07:00');
  assert.equal(holdIsNewsworthy('2026-08-26T08:00:00', now), true,
    'nearly three hours of lead is exactly what the coming-soon alert is for');
});

test('the window closes an hour before the release — not eight', () => {
  const release = '2026-08-26T08:00:00';
  // 07:01 PT: 59 minutes out, under the floor.
  assert.equal(holdIsNewsworthy(release, PT('2026-08-26T07:01:00-07:00')), false);
  // 06:59 PT: 61 minutes out, over it.
  assert.equal(holdIsNewsworthy(release, PT('2026-08-26T06:59:00-07:00')), true);
  // MIDNIGHT PACIFIC is where the broken version drew the line. It must be news here.
  assert.equal(holdIsNewsworthy(release, PT('2026-08-26T00:00:00-07:00')), true,
    'the broken version placed the release at 01:00 PT, so it refused from midnight on');
});

test('the two offers that DID go out still go out — the fix is not a widening', () => {
  // Both real, and both must stay newsworthy: a fix that only moved the boundary would
  // be indistinguishable from one that removed the floor.
  assert.equal(holdIsNewsworthy('2026-08-26T08:00:00', PT('2026-08-25T12:16:54-07:00')), true);
  assert.equal(holdIsNewsworthy('2026-08-26T08:00:00', PT('2026-08-25T22:47:36-07:00')), true);
});

test('the 2026-08-06 creeping lock is still suppressed', () => {
  // The finding the floor exists for: a lock ~1 minute ahead that kept moving, which is a
  // cart being extended rather than an overnight release.
  assert.equal(holdIsNewsworthy('2026-08-06T08:15:00', PT('2026-08-06T08:14:00-07:00')), false);
  assert.equal(holdIsNewsworthy('2026-08-06T08:16:00', PT('2026-08-06T08:15:00-07:00')), false);
});

test('a release already past is never news', () => {
  assert.equal(holdIsNewsworthy('2026-08-26T08:00:00', PT('2026-08-26T09:00:00-07:00')), false);
});

test('STANDARD TIME resolves too — the offset is read per date, never hardcoded', () => {
  // January is PST (UTC-8). A fixed -7 would be an hour out; a fixed -8 would break August.
  assert.equal(pacificWallClockToUtcMs('2026-01-15T08:00:00'),
    Date.parse('2026-01-15T16:00:00Z'));
});

test('a ZONE-BEARING string is passed through, not re-interpreted as Pacific', () => {
  // If UseDirect ever sends an offset, that string already names an instant. Re-reading it
  // as Pacific would reintroduce the very shift this fixes, and returning NaN would be
  // worse: holdIsNewsworthy refuses on NaN, so every alert would switch off silently.
  assert.equal(pacificWallClockToUtcMs('2026-08-26T15:00:00Z'),
    Date.parse('2026-08-26T15:00:00Z'));
  assert.equal(pacificWallClockToUtcMs('2026-08-26T08:00:00-07:00'),
    Date.parse('2026-08-26T15:00:00Z'));
});

test('unparseable stays unparseable, and that REFUSES rather than alerting', () => {
  assert.ok(Number.isNaN(pacificWallClockToUtcMs('not a date')));
  assert.equal(holdIsNewsworthy('not a date', PT('2026-08-26T05:00:00-07:00')), false);
  assert.equal(holdIsNewsworthy('', PT('2026-08-26T05:00:00-07:00')), false);
});

test('THE DST TRANSITIONS — this is what the SECOND pass is for', () => {
  // The offset depends on the answer, so one pass reads it at the wrong instant. The naive
  // timestamp sits 7-8 hours BEFORE the true one, so the two disagree exactly when a
  // transition falls in that gap — twice a year, silently, by an hour.
  //
  // AUTUMN: 2026-11-01, PDT -> PST at 02:00 local (09:00Z). A wall clock of 08:00 is PST,
  // so 16:00Z. A single pass reads the offset at 08:00Z, where Pacific is still PDT, and
  // answers 15:00Z.
  assert.equal(pacificWallClockToUtcMs('2026-11-01T08:00:00'),
    Date.parse('2026-11-01T16:00:00Z'), 'autumn: 08:00 PST is 16:00Z');
  // SPRING: 2026-03-08, PST -> PDT at 02:00 local (10:00Z). 08:00 is PDT, so 15:00Z; a
  // single pass reads PST at 08:00Z and answers 16:00Z.
  assert.equal(pacificWallClockToUtcMs('2026-03-08T08:00:00'),
    Date.parse('2026-03-08T15:00:00Z'), 'spring: 08:00 PDT is 15:00Z');
  // And the day either side, so the assertions above cannot pass by landing on a constant.
  assert.equal(pacificWallClockToUtcMs('2026-10-31T08:00:00'), Date.parse('2026-10-31T15:00:00Z'));
  assert.equal(pacificWallClockToUtcMs('2026-03-09T08:00:00'), Date.parse('2026-03-09T15:00:00Z'));
});

test('THE POLLER USES THIS ONE — a fix nothing calls is not a fix', () => {
  // The shape this repo keeps paying for: the correct function exists and the caller kept
  // its own copy. `holdIsNewsworthy` was defined inside poller.ts precisely because
  // importing that file starts the poller, so the local copy is the natural thing to
  // re-add. Comments are stripped first, because the note left at the old site quotes both
  // the name and the broken expression to explain them.
  const src = readFileSync(new URL('./poller.ts', import.meta.url), 'utf8');
  const code = src.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.match(code, /import \{[^}]*\bholdIsNewsworthy\b[^}]*\} from '\.\/held-cadence'/,
    'poller.ts must import holdIsNewsworthy from held-cadence');
  assert.doesNotMatch(code, /(?:function|const|let)\s+holdIsNewsworthy\b/,
    'poller.ts must not define its own holdIsNewsworthy again');
  assert.doesNotMatch(code, /new Date\(availableAt\)/,
    'reading RC\'s zone-less Pacific Lock with a bare new Date() is the seven-hour bug');
});

test('the floor is an HOUR, and the cadence clamp is derived from the same number', () => {
  // clampHeldInterval takes the floor as a parameter and defaults to it. If the two ever
  // disagree, a lock found at T-59min is announced at T-0, i.e. never.
  assert.equal(HOLD_MIN_LEAD_MS, 60 * 60_000);
  assert.equal(clampHeldInterval(6 * 60 * 60_000), HOLD_MIN_LEAD_MS / 4);
});
