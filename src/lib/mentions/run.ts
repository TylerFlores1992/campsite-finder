import type { Candidate, ChecklistItem, MentionSource, SourceContext } from './types';
import { dedupeKey, scoreCandidate, type Score } from './score';
import { redditSource } from './sources/reddit';
import { googleAlertsSource } from './sources/google-alerts';
import { facebookGroupsSource } from './sources/facebook-groups';

/**
 * The orchestrator: run every source, score what came back, and say what is NEW.
 *
 * Pure of the database and of the network — both are injected — so the whole decision path
 * is testable in a sandbox where reddit.com and google.com are blocked at the proxy, which
 * is where it was written. The script is the only piece that touches Postgres.
 */

/** The registry. Adding a venue is adding a line here and a file under `sources/`. */
export const SOURCES: readonly MentionSource[] = [
  redditSource,
  googleAlertsSource,
  facebookGroupsSource,
];

export interface ScoredCandidate extends Candidate {
  key: string;
  scoring: Score;
}

export interface SourceReport {
  id: string;
  label: string;
  kind: MentionSource['kind'];
  /** Candidates it returned, before scoring. */
  found: number;
  /**
   * Set when the source could not answer. THE DIGEST MUST PRINT THIS. "0 found" and "could
   * not ask" render identically otherwise, and since silence is the expected weekly reading
   * here, a broken fetcher would stay invisible for months.
   */
  error?: string;
  checklist?: ChecklistItem[];
}

export interface RunResult {
  scored: ScoredCandidate[];
  reports: SourceReport[];
  /** True when at least one automatic source failed — the digest leads with it. */
  degraded: boolean;
}

/**
 * Run the sources.
 *
 * EVERY SOURCE IS WRAPPED, even though the interface says `fetch` must not reject. A
 * contract nothing enforces is a comment, and one source throwing would take the other two
 * findings with it — the failure mode where a bad week for Reddit erases a Google Alerts hit
 * nobody ever learns about.
 *
 * SEQUENTIAL. Three sources, seconds apart, against services that dislike bursts; there is
 * nothing to win by running them at once and a rate-limit to lose.
 */
export async function runSources(
  ctx: Omit<SourceContext, 'fetch'> & { fetch: SourceContext['fetch'] },
  sources: readonly MentionSource[] = SOURCES,
): Promise<RunResult> {
  const reports: SourceReport[] = [];
  const seen = new Map<string, ScoredCandidate>();
  let degraded = false;

  for (const source of sources) {
    let found = 0;
    let error: string | undefined;
    let checklist: ChecklistItem[] | undefined;

    try {
      const result = await source.fetch(ctx);
      error = result.error;
      checklist = result.checklist;
      for (const c of result.candidates) {
        const key = dedupeKey(c);
        // FIRST WINS. Two sources can surface the same article (a Google Alert on a Reddit
        // thread); keeping the first keeps the source that found it first, which is the more
        // useful attribution. Overwriting would make the digest's "via" column depend on
        // registry order, which is not a fact about anything.
        if (seen.has(key)) continue;
        seen.set(key, { ...c, key, scoring: scoreCandidate(c) });
        found++;
      }
    } catch (err) {
      error = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    // A MANUAL source failing is not degradation — it makes no request, so it cannot fail
    // in a way that hides findings. Only an automatic source going quiet does that.
    if (error && source.kind === 'automatic') degraded = true;
    reports.push({ id: source.id, label: source.label, kind: source.kind, found, error, checklist });
  }

  const scored = [...seen.values()].sort((a, b) => b.scoring.score - a.scoring.score);
  return { scored, reports, degraded };
}

/**
 * Split what came back into what a human should read now and what is merely recorded.
 *
 * `alreadySeen` comes from the database. THE FILTER IS APPLIED AFTER SCORING, not before
 * fetching, because everything scored gets written down — a candidate that scored 11 today
 * is the only evidence there is about whether the threshold is set right, and dropping it
 * early would make the threshold permanently unfalsifiable.
 */
export function partition(
  scored: readonly ScoredCandidate[],
  alreadySeen: ReadonlySet<string>,
): { surface: ScoredCandidate[]; record: ScoredCandidate[] } {
  const fresh = scored.filter((c) => !alreadySeen.has(c.key));
  return {
    surface: fresh.filter((c) => c.scoring.surfaced),
    record: fresh,
  };
}
