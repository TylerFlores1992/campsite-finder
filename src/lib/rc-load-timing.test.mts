/**
 * RC'S OWN WEB TIER, AS AN INSTRUMENT RATHER THAN A FEELING (2026-09-03).
 *
 * Three separate things, all one gap: the hand-off could tell you RC had failed, could not
 * tell you how long a SUCCESSFUL load took, and could not tell you how often either happened.
 *
 * 1. **The readout did not recognise its own signal.** `rc-outage-hold.ts` ACTS on a `close`
 *    reason of `never-loaded` / `load-error` — it holds the campsite through the outage —
 *    while `closeReasonReading`, the thing a human reads at 08:15, called them
 *    *"unrecognised close reason"* at `info`. Two consumers of one fact and only one knew it.
 *
 * 2. **Success was silent.** The load watchdog records failures only, so a hand-off that took
 *    nineteen seconds and one that took two produced identical traces. "RC is slow" therefore
 *    stayed something the owner reported rather than a distribution anybody could read.
 *
 * 3. **No denominator.** RC failing to render was reported three times from a phone
 *    (2026-08-30, 08-31, 09-02) and nobody could say whether that was one hand-off in three or
 *    one in fifty. Those have different answers, so nobody could act on either.
 *
 * The guards below are half structural on purpose. Every pure function here can be perfect
 * while nothing calls it — which is exactly how `closeOnToken` shipped guarded-but-wrong in
 * #126, and how the load timing would ship as a report nobody renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeReasonReading, rcLoadReading, RC_SLOW_LOAD_MS } from './rc-token-liveness';
import { rcLoadStats, describeRcLoadStats } from './rc-load-stats';
import { RC_OUTAGE_GRACE_MIN } from './rc-outage-hold';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

const HANDOFF = () => code('./native/rc-handoff.ts');
const READOUT = () => code('../../scripts/rc-holds-readout.mts');
const OUTAGE = () => code('./rc-outage-hold.ts');

// ---------------------------------------------------------------------------
// 1. The close reasons the outage hold acts on are the ones the readout explains.
// ---------------------------------------------------------------------------

test("`never-loaded` and `load-error` name RC's web tier, not 'unrecognised'", () => {
  for (const reason of ['never-loaded', 'load-error']) {
    const r = closeReasonReading(reason, true);
    assert.doesNotMatch(r.text, /unrecognised/i,
      `${reason} is our own signal — reporting it as unknown is the defect`);
    assert.match(r.text, /web tier|never rendered|load error/i, reason);
  }
});

test('…and they are WARN, because a reading that says nothing happened is worse than none', () => {
  // `info` was the old behaviour and it is the direction that costs something: the reader is
  // told the hand-off ended for a reason nobody has a name for, when in fact RC would not
  // render — which on 08-31 took three attempts and ~5 minutes, and at 08:00 loses the site.
  for (const reason of ['never-loaded', 'load-error']) {
    assert.equal(closeReasonReading(reason, true).level, 'warn', reason);
    assert.equal(closeReasonReading(reason, false).level, 'warn',
      `${reason}: RC failing has nothing to do with whether a sign-in happened`);
  }
});

test('NOT fail, and not a reason to go looking in this repo', () => {
  // The cry-wolf rule, which this file has broken three times. Nothing of ours is broken when
  // RC will not render, and a red line here would be skimmed on the morning one is real.
  for (const reason of ['never-loaded', 'load-error']) {
    assert.ok(['info', 'warn'].includes(closeReasonReading(reason, true).level));
  }
  assert.ok(RC_OUTAGE_GRACE_MIN > 0, 'and the hold really is extended, so the text is true');
});

test('the two reasons are DERIVED from the outage hold, not a second hand-typed list', () => {
  // THE GUARD THAT SURVIVES THE NEXT REASON. If a third outage reason is added to
  // `OUTAGE_REASONS` and not taught to the readout, the reader is back to "unrecognised" over
  // a hold that is being deliberately held — the exact split this change closed.
  const src = OUTAGE();
  const m = src.match(/OUTAGE_REASONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'the outage reasons must be a readable literal');
  const reasons = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(reasons.length >= 2, 'sanity: the list was parsed');
  for (const reason of reasons) {
    const r = closeReasonReading(reason, true);
    assert.doesNotMatch(r.text, /unrecognised/i,
      `${reason} is acted on by rc-outage-hold but the readout cannot explain it`);
  }
});

test('and the HOST can actually send them — the signal exists end to end', () => {
  // A reading for a reason nothing emits is a guard over dead code. `closeOnce`'s union is
  // where they are produced.
  const src = HANDOFF();
  const m = src.match(/closeOnce = \(reason: ([^)]*)\)/);
  assert.ok(m, 'closeOnce must name its reasons in the signature');
  assert.match(m![1], /'never-loaded'/);
  assert.match(m![1], /'load-error'/);
});

// ---------------------------------------------------------------------------
// 2. How long a SUCCESSFUL load took — the number nothing had.
// ---------------------------------------------------------------------------

test('a non-reading is NULL, never a fast load', () => {
  // THE ABSENT-READING-AS-A-POSITIVE SHAPE, which this repo has paid for with `rc 0 MB` over
  // a 312 MB profile. Coercing a missing `ms` to 0 reports an instant render and drags every
  // aggregate towards health.
  for (const bad of [undefined, null, NaN, Infinity, -1, '2000', {}]) {
    assert.equal(rcLoadReading(bad), null, String(bad));
  }
});

test('a quick render is info and says the number; a slow one is warn', () => {
  const fast = rcLoadReading(1_800)!;
  assert.equal(fast.level, 'info');
  assert.match(fast.text, /1\.8s/, 'the duration itself is the reading');

  const slow = rcLoadReading(RC_SLOW_LOAD_MS)!;
  assert.equal(slow.level, 'warn', 'the threshold is inclusive — at the bound is already slow');
  assert.match(slow.text, /RC|web tier/i, "and it must say whose fault it is, or it reads as ours");
});

test('the slow threshold is bounded from BOTH sides, and the upper bound is load-bearing', () => {
  // AT OR ABOVE THE WATCHDOG IT COULD NEVER FIRE. No successful load can be slower than the
  // watchdog that would have closed the window, so a threshold there leaves an instrument
  // that is present, green, and structurally incapable of reporting anything.
  const m = HANDOFF().match(/LOAD_WATCHDOG_MS = ([\d_]+)/);
  assert.ok(m, 'the watchdog must be a readable literal');
  const watchdog = Number(m![1].replace(/_/g, ''));
  assert.ok(RC_SLOW_LOAD_MS < watchdog,
    `slow (${RC_SLOW_LOAD_MS}) must be reachable by a load the watchdog lets through (${watchdog})`);
  assert.ok(RC_SLOW_LOAD_MS >= 3_000,
    'below this it fires on healthy loads, and a warning on the normal path is one nobody reads');
});

test('the timing is taken from BEFORE the window opens, so it includes what the user waits', () => {
  const src = HANDOFF();
  const opened = src.indexOf('const openedAt = Date.now()');
  const open = src.indexOf('iab.open(url');
  assert.ok(opened > -1, 'the open time must be recorded');
  assert.ok(opened < open, 'reading it after the plugin has a window undercounts the wait');
});

test('it is reported on the FIRST load only', () => {
  // Later `loadstop`s are the user or RC's SPA moving around. Their durations measure a
  // different thing, and averaging them in poisons the one number this exists to produce.
  const src = HANDOFF();
  const at = src.indexOf("stage: 'rc-load'");
  assert.ok(at > -1, 'the report must exist');
  const before = src.slice(Math.max(0, at - 400), at);
  assert.match(before, /if \(firstLoad\)/, 'every load reporting would measure the wrong thing');
  assert.match(src, /const firstLoad = !everLoaded;/,
    'and `firstLoad` must be read BEFORE everLoaded is set, or it is always false');
});

test('the load watchdog is disarmed BEFORE the injection, which the comment claimed and the code did not', () => {
  // Until 2026-09-03 `ref.executeScript({ code })` was the first line of the handler, above
  // `everLoaded = true` — so a synchronous throw there left the watchdog armed and closed a
  // webview that had in fact rendered. The comment above it asserted the opposite ordering.
  const src = HANDOFF();
  const handler = src.indexOf("addEventListener('loadstop'");
  assert.ok(handler > -1);
  const loaded = src.indexOf('everLoaded = true;', handler);
  const disarm = src.indexOf('disarmLoadTimer();', handler);
  const inject = src.indexOf('ref.executeScript({ code });', handler);
  assert.ok(loaded > -1 && disarm > -1 && inject > -1, 'sanity: all three are in the handler');
  assert.ok(loaded < inject, 'a throw in the injection must not leave the watchdog armed');
  assert.ok(disarm < inject, 'nor leave the timer running against a page that loaded');
});

test('the diagnostic can never cost the cart', () => {
  // `onReport` is the caller's code and this sits on the cart path. A throw there must not
  // stop the injection the whole hand-off exists to make — the same rule that keeps
  // `recordClientReports` un-awaited.
  const src = HANDOFF();
  const at = src.indexOf("stage: 'rc-load'");
  const around = src.slice(at - 200, at + 200);
  assert.match(around, /try \{/, 'the report must be guarded');
  assert.match(around, /catch/);
});

// ---------------------------------------------------------------------------
// 3. The aggregate. The denominator is the point.
// ---------------------------------------------------------------------------

const load = (ms: unknown) => ({ stage: 'rc-load', detail: { ms } });
const closed = (reason: string) => ({ stage: 'close', detail: { reason } });

test('it counts hand-offs, timings and failures separately', () => {
  const s = rcLoadStats([
    [load(1000), closed('session')],
    [load(9000), closed('session')],
    [closed('never-loaded')],
    [closed('load-error')],
  ]);
  assert.equal(s.handoffs, 4);
  assert.equal(s.runsTimed, 2);
  assert.equal(s.samples, 2);
  assert.equal(s.slow, 1, '9s is over the threshold');
  assert.equal(s.neverLoaded, 1);
  assert.equal(s.loadError, 1);
});

test('a hand-off that reported NOTHING is not counted at all', () => {
  // A plain browser is the ordinary desktop case and a success. Counting it as a hand-off
  // with no timing would make every desktop booking read as a missing measurement, and the
  // denominator this whole module exists for would be meaningless.
  const s = rcLoadStats([[], [load(500)]]);
  assert.equal(s.handoffs, 1);
});

test('a malformed `ms` is SKIPPED, not counted as zero', () => {
  const s = rcLoadStats([[load('slow'), load(undefined), load(-4), load(4000)]]);
  assert.equal(s.samples, 1, 'only the real reading counts');
  assert.equal(s.medianMs, 4000, 'a zero here would report an instant render nobody measured');
});

test('the median is a value RC actually produced', () => {
  // On an even count the mean of the two middles is a duration nobody observed. This repo has
  // been misled by a derived figure presented as an observation before.
  const s = rcLoadStats([[load(1000)], [load(2000)], [load(3000)], [load(9000)]]);
  assert.ok([2000, 3000].includes(s.medianMs!), `interpolated median: ${s.medianMs}`);
  assert.equal(s.slowestMs, 9000);
});

test('one hold opened twice contributes two real timings', () => {
  const s = rcLoadStats([[load(1000), closed('session'), load(2000), closed('session')]]);
  assert.equal(s.samples, 2);
  assert.equal(s.runsTimed, 1, 'but it is still one hand-off');
});

test('with NO timings it refuses a distribution and does not claim health', () => {
  // "0 slow loads" over two plain-browser hand-offs is an absent reading rounded to a
  // positive one — the shape this file records more often than any other.
  const lines = describeRcLoadStats(rcLoadStats([[closed('session')], [closed('session')]])).join('\n');
  assert.match(lines, /no timings/i);
  assert.doesNotMatch(lines, /median/i, 'there is no median to report');
  assert.doesNotMatch(lines, /No hand-off failed/i,
    'silence about failures is not evidence there were none when nothing could report');
});

test('nothing at all produces nothing at all', () => {
  assert.deepEqual(describeRcLoadStats(rcLoadStats([])), []);
});

test('the gap between timed and total hand-offs is itself printed', () => {
  // Without it the median silently describes a subset, and a subset presented as the whole
  // is how a partial measurement becomes a claim.
  const lines = describeRcLoadStats(rcLoadStats([[load(1000)], [closed('session')]])).join('\n');
  assert.match(lines, /1 hand-off\(s\) reported no timing/);
});

test('failures are surfaced with a count, and a clean window says so explicitly', () => {
  const bad = describeRcLoadStats(rcLoadStats([[load(1000), closed('never-loaded')]])).join('\n');
  assert.match(bad, /⚠/);
  assert.match(bad, /never got RC to render/);
  const good = describeRcLoadStats(rcLoadStats([[load(1000), closed('session')]])).join('\n');
  assert.match(good, /No hand-off failed to render/,
    'an explicit all-clear, so an absent line is never read as one');
});

// ---------------------------------------------------------------------------
// 4. …and the readout actually uses all of it.
// ---------------------------------------------------------------------------

test('the readout ROUTES through the shared reading and the shared aggregate', () => {
  // THE FIX-PRESENT-BUT-INERT SHAPE. Every test above passes against a readout that renders
  // none of this.
  const src = READOUT();
  assert.match(src, /import \{[^}]*\brcLoadReading\b[^}]*\} from '\.\.\/src\/lib\/rc-token-liveness'/);
  assert.match(src, /import \{[^}]*\brcLoadStats\b[^}]*\} from '\.\.\/src\/lib\/rc-load-stats'/);
  assert.match(src, /rcLoadReading\(loadMs\)/, 'the per-hold line must ASK, not decide');
  assert.match(src, /describeRcLoadStats\(rcLoadStats\(/, 'and the aggregate must be printed');
  assert.match(src, /loadRead\.level === 'warn'/,
    'severity must come from the reading, or the one case that matters is unmarked');
});

test('the per-hold timing is taken from the FIRST rc-load report', () => {
  // `findLast` is right for `cart-verified` (the newest bundle's answer) and wrong here: a
  // hold reopened an hour later contributes a second first-load timing, and the one that
  // describes this hand-off is the one the user waited on.
  const src = READOUT();
  const at = src.indexOf("r.stage === 'rc-load'");
  assert.ok(at > -1, 'the readout must read the timing');
  assert.match(src.slice(Math.max(0, at - 120), at), /\.find\(/,
    'findLast here would report a later reopen as this hand-off');
});
