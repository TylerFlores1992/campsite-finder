import type { Candidate, MentionSource, SourceContext, SourceResult } from '../types';

/**
 * Reddit, through the PUBLIC JSON endpoints — no OAuth, no app registration, no token.
 *
 * `https://www.reddit.com/search.json?q=…` is the same data reddit.com's own search page
 * renders, and it needs no credential. That matters beyond convenience: a monitor holding an
 * API token is one credential away from being able to post, and this one is structurally
 * unable to. `monitor.test.mts` fails if a token or a POST appears in this directory.
 *
 * A DESCRIPTIVE USER-AGENT IS NOT OPTIONAL. Reddit rate-limits generic and absent agents
 * hard, and asks that automated clients identify themselves. The polite version gets a much
 * higher ceiling than we will ever need, and it is also simply the honest thing to send.
 *
 * SEQUENTIAL, WITH A GAP. Firing every query at once is what turns a courteous reader into
 * something that looks like a scraper — the same lesson as the rec.gov scheduler, where
 * `pMap(4)` bursting then idling tripped a breaker that pacing did not. There are a handful
 * of queries a day here; there is nothing to gain by being quick.
 *
 * NEVER VALIDATED AGAINST LIVE REDDIT FROM THE SESSION THAT WROTE IT — reddit.com answers
 * 403 to CONNECT at this sandbox's proxy. The parsing is tested against captured fixtures
 * and the shape is from Reddit's documented listing format, but THE FIRST REAL RUN IS THE
 * FIRST REAL EVIDENCE. Expect to fix a field name; do not expect the shape to be wrong.
 */

/**
 * What to search for. Subreddit-scoped where the community is the right one, and global for
 * the competitor names, because somebody comparing tools may ask anywhere.
 */
export const REDDIT_QUERIES: readonly string[] = [
  'campnab',
  'campflare',
  'campsite cancellation alert',
  'reservecalifornia cancellation',
  'subreddit:CampingandHiking campsite cancellation',
  'subreddit:camping campsite cancellation',
  'subreddit:CampingGear campsite alert',
  'subreddit:Yosemite campsite cancellation',
  'subreddit:CAStateParks reservation',
  'subreddit:AskCamping fully booked',
];

/** Between requests. Courtesy, not a rate limit we have measured. */
export const REDDIT_GAP_MS = 1500;

interface RedditChild {
  kind?: string;
  data?: {
    id?: string;
    name?: string;
    title?: string;
    selftext?: string;
    author?: string;
    subreddit?: string;
    permalink?: string;
    created_utc?: number;
    over_18?: boolean;
  };
}

/**
 * One listing page into candidates.
 *
 * Exported because it is the only part of this file that can be exercised without network,
 * and it is where every realistic bug lives — a renamed field, a missing permalink, a
 * timestamp in the wrong unit.
 */
export function parseListing(json: unknown, since: Date): Candidate[] {
  const children = (json as { data?: { children?: RedditChild[] } })?.data?.children;
  if (!Array.isArray(children)) return [];

  const out: Candidate[] = [];
  for (const child of children) {
    const d = child?.data;
    // `name` is the fullname (t3_abc123) and is the stable id; `id` alone can collide
    // across kinds. Either will do, but a row with neither cannot be deduped and must be
    // dropped rather than given a synthetic key that changes every run.
    const externalId = d?.name || d?.id;
    if (!d || !externalId || typeof d.title !== 'string') continue;
    if (d.over_18) continue;

    // `created_utc` is SECONDS. Read as milliseconds it lands in 1970, every post looks
    // older than any `since`, and the monitor silently returns nothing forever.
    const createdAt = typeof d.created_utc === 'number' ? new Date(d.created_utc * 1000) : undefined;
    if (createdAt && createdAt < since) continue;

    out.push({
      source: 'reddit',
      externalId,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : `https://www.reddit.com/comments/${d.id}`,
      title: d.title,
      body: typeof d.selftext === 'string' ? d.selftext.slice(0, 2000) : undefined,
      author: d.author,
      community: d.subreddit ? `r/${d.subreddit}` : undefined,
      createdAt,
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const redditSource: MentionSource = {
  id: 'reddit',
  label: 'Reddit',
  kind: 'automatic',

  async fetch(ctx: SourceContext): Promise<SourceResult> {
    const candidates: Candidate[] = [];
    const failures: string[] = [];

    for (const [i, q] of REDDIT_QUERIES.entries()) {
      if (i > 0) await sleep(Number(ctx.env.MENTIONS_REDDIT_GAP_MS ?? REDDIT_GAP_MS));
      const url =
        'https://www.reddit.com/search.json' +
        `?q=${encodeURIComponent(q)}&sort=new&t=week&limit=${Math.min(ctx.limit, 100)}`;
      try {
        const res = await ctx.fetch(url, {
          headers: {
            // Identify honestly. A contact address is what Reddit asks for and is what gets
            // a human rather than a block if this ever misbehaves.
            'user-agent': 'CampHawkMentionMonitor/1.0 (read-only; +https://camphawk.app)',
            accept: 'application/json',
          },
        });
        if (!res.ok) {
          failures.push(`"${q}" → HTTP ${res.status}`);
          continue;
        }
        candidates.push(...parseListing(await res.json(), ctx.since));
      } catch (err) {
        failures.push(`"${q}" → ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // PARTIAL FAILURE IS REPORTED ALONGSIDE THE RESULTS, not instead of them. One query
    // being rate-limited must not discard the other nine — and it must not be swallowed
    // either, or a monitor whose queries are all failing reads as a quiet week.
    return {
      candidates,
      error: failures.length ? `${failures.length}/${REDDIT_QUERIES.length} queries failed: ${failures.join('; ')}` : undefined,
    };
  },
};
