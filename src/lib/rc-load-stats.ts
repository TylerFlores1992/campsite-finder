/**
 * HOW OFTEN DOES RESERVECALIFORNIA'S OWN WEB TIER LOSE US A HAND-OFF, AND HOW SLOW IS IT?
 *
 * ## Why an aggregate, when every hold already prints its own line
 *
 * RC failing to render is the one risk on the hand-off path that nothing in this repo could
 * SIZE. It has been reported three times from a phone — 2026-08-30 mid-test, 2026-08-31
 * (three attempts, ~5 minutes), 2026-09-02 ("a RC load freeze that crashed the app") — and
 * every time the answer was "yes, it happens", never "it happens on N hand-offs in M". A
 * per-hold line cannot answer that: the reader sees the one they are looking at.
 *
 * That matters because the remedies differ by an order of magnitude. One failure in fifty is
 * a note in the copy; one in three is a reason to reconsider whether the claim link should
 * open RC at all. Nobody could tell those apart, so nobody could act.
 *
 * ## THE DENOMINATOR IS THE POINT, and leaving it out is how this lies
 *
 * "0 failed loads" is not a health reading unless you also know how many hand-offs there
 * were and how many could have reported. A window with two hand-offs, both from a plain
 * browser, produces the identical line to a window where RC behaved perfectly fifty times.
 * So `handoffs`, `runsTimed` and `samples` are all reported and `describeRcLoadStats`
 * REFUSES a distribution when there are no samples, rather than printing zeros — the same
 * rule as `recgov-429-profile.mts` refusing a verdict until all 24 hours have data, and as
 * `rcLoadReading` returning null rather than 0.
 *
 * ## Pure, and separate from the readout
 *
 * For the reason the four readings in `rc-token-liveness` are: the branch that says "RC is
 * failing for a third of your users" cannot be reached without real hand-offs in the
 * database, so written inline in `scripts/rc-holds-readout.mts` it would ship having never
 * once run — and it is the branch that matters.
 */
import { RC_SLOW_LOAD_MS } from './rc-token-liveness';

/** One stored `client_reports` entry, as loose as it is on the wire. */
export interface RcLoadReport { stage?: unknown; detail?: unknown }

export interface RcLoadStats {
  /** Hand-offs that reported ANYTHING. The denominator; without it no count below means much. */
  handoffs: number;
  /** …of those, how many carried at least one load timing. The gap is pre-2026-09-03 bundles. */
  runsTimed: number;
  /** Individual timings. A hold opened twice contributes two, and both are real measurements. */
  samples: number;
  /** Samples at or over `RC_SLOW_LOAD_MS`. */
  slow: number;
  /** An OBSERVED value, never an interpolated one — see below. Null with no samples. */
  medianMs: number | null;
  slowestMs: number | null;
  /** Hand-offs the load watchdog closed: RC never rendered at all. */
  neverLoaded: number;
  /** Hand-offs the webview failed outright before rendering. */
  loadError: number;
}

function reasonOf(r: RcLoadReport): string | null {
  if (r.stage !== 'close') return null;
  const reason = (r.detail as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * @param runs one array of reports per hand-off. A run with no reports at all is NOT counted:
 *   a plain browser is the ordinary desktop case and a success, and counting it as a hand-off
 *   with no timing would make every desktop booking look like a missing measurement.
 */
export function rcLoadStats(runs: RcLoadReport[][]): RcLoadStats {
  const all: number[] = [];
  const s: RcLoadStats = {
    handoffs: 0, runsTimed: 0, samples: 0, slow: 0,
    medianMs: null, slowestMs: null, neverLoaded: 0, loadError: 0,
  };
  for (const run of runs) {
    if (!Array.isArray(run) || run.length === 0) continue;
    s.handoffs += 1;
    let timedHere = 0;
    for (const r of run) {
      if (r.stage === 'rc-load') {
        const ms = (r.detail as { ms?: unknown } | null)?.ms;
        // THE SAME VALIDATION AS `rcLoadReading`, and for the same reason: a malformed `ms`
        // coerced to 0 would report an instant load and drag the median towards health.
        if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) { all.push(ms); timedHere += 1; }
        continue;
      }
      const reason = reasonOf(r);
      if (reason === 'never-loaded') s.neverLoaded += 1;
      else if (reason === 'load-error') s.loadError += 1;
    }
    s.samples += timedHere;
    if (timedHere > 0) s.runsTimed += 1;
  }
  s.slow = all.filter((ms) => ms >= RC_SLOW_LOAD_MS).length;
  if (all.length > 0) {
    all.sort((a, b) => a - b);
    // THE LOWER MIDDLE, NOT THE MEAN OF TWO. Every number printed here should be one RC
    // actually produced; an averaged median on an even count is a duration nobody measured,
    // and this repo has been misled by a derived figure presented as an observation before.
    s.medianMs = all[Math.floor((all.length - 1) / 2)];
    s.slowestMs = all[all.length - 1];
  }
  return s;
}

/** Lines for the readout. Returns [] when there is nothing honest to say. */
export function describeRcLoadStats(s: RcLoadStats): string[] {
  if (s.handoffs === 0) return [];
  const out: string[] = [];
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const outages = s.neverLoaded + s.loadError;

  if (s.samples === 0) {
    // NOT "RC WAS FINE". No timing at all means either every client predates the
    // instrument (2026-09-03) or none of them was injectable. Saying "0 slow loads" here
    // would be an absent reading rounded to a positive one.
    out.push(`RC LOAD: no timings in ${s.handoffs} hand-off(s) — every client predates the`);
    out.push('  rc-load report (2026-09-03), or none was an injectable webview. Not a verdict.');
  } else {
    out.push(`RC LOAD: ${s.samples} timing(s) across ${s.runsTimed} of ${s.handoffs} hand-off(s)`
      + ` — median ${secs(s.medianMs!)}, slowest ${secs(s.slowestMs!)}`);
    if (s.slow > 0) {
      out.push(`  ⚠ ${s.slow} of ${s.samples} took ${secs(RC_SLOW_LOAD_MS)} or more. That is RC's`);
      out.push('    own web tier, not ours, and at 08:00 it is the whole margin.');
    }
    if (s.runsTimed < s.handoffs) {
      // THE GAP IS ITS OWN READING. Without it the median silently describes a subset, and
      // a subset presented as the whole is how a partial measurement becomes a claim.
      out.push(`  (${s.handoffs - s.runsTimed} hand-off(s) reported no timing — an older client`);
      out.push('   bundle or a plain browser, so the figures above describe the rest.)');
    }
  }

  if (outages > 0) {
    out.push(`  ⚠ ${outages} hand-off(s) never got RC to render at all`
      + ` (${s.neverLoaded} timed out, ${s.loadError} errored). Those holds keep their site`);
    out.push('    for an extra grace window — see rc-outage-hold.');
  } else if (s.samples > 0) {
    out.push('  No hand-off failed to render RC in this window.');
  }
  return out;
}
