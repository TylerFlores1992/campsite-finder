/**
 * The mention monitor — plugin interface.
 *
 * WHAT THIS IS FOR. CampHawk's best organic channel is people asking, in public, the exact
 * question the product answers: "how do I get a spot at Big Sur, everything is booked".
 * Finding those posts is the slow part; replying is not. So this finds them and hands them
 * to a human. It is a READER.
 *
 * ## IT NEVER POSTS, AND THAT IS STRUCTURAL RATHER THAN A PROMISE
 *
 * No source may write anything anywhere, and `src/lib/mentions/monitor.test.mts` fails the
 * build if a module under `sources/` acquires a POST, a form submit or an API token that
 * could author content. This is not squeamishness:
 *
 *   - Reddit bans undisclosed self-promotion and automated posting, and enforces it at the
 *     DOMAIN level. A shadowban on camphawk.app makes every link invisible sitewide —
 *     including a genuine recommendation from a real customer — with no meaningful appeal.
 *     That trades the channel permanently for a few weeks of comments.
 *   - A bot posing as the owner in a community that answers each other honestly is
 *     astroturfing, whatever the reply says.
 *
 * The value was never the typing.
 *
 * ## A SOURCE THAT COULD NOT ANSWER IS NOT A SOURCE THAT FOUND NOTHING
 *
 * `SourceResult` carries an explicit `error`, and the digest prints it. This is the single
 * most repeated failure in this codebase — `status = 'sent'` meaning only "Twilio returned
 * 2xx", `claimBotCommands` returning `[]` for both "nobody asked" and "the query threw", a
 * watchdog silent through the outage it exists for. A monitor that reports "no mentions
 * this week" because Reddit rate-limited it is the same shape, and it is worse here than
 * elsewhere: silence is the EXPECTED reading, so a broken fetcher is invisible for months.
 *
 * ## TWO KINDS OF SOURCE, AND THE SECOND IS NOT A COP-OUT
 *
 * `automatic` sources fetch. `manual` sources emit LINKS for a person to open, and exist
 * because some of the best venues cannot be read by a program without breaking the rules of
 * the site or risking the owner's account — Facebook Groups being the clear case (Meta
 * removed group-content reads from the Graph API in 2024, and scraping while logged in
 * violates the terms and risks the account that holds the group memberships).
 *
 * A checklist of the right search URLs, refreshed every run and printed beside the automatic
 * hits, is genuinely most of the value: the hard part is remembering to look and knowing
 * where. Pretending otherwise would mean shipping a scraper that breaks silently and takes
 * an account with it.
 */

/** One post, comment or article that might be worth a reply. */
export interface Candidate {
  /** The `MentionSource.id` that produced it. */
  source: string;
  /**
   * Stable within a source, forever. It is the dedupe key, so a source that derives it from
   * anything volatile (a rank, a timestamp, a shortened URL) will re-surface the same post
   * every run and train the reader to ignore the digest.
   */
  externalId: string;
  url: string;
  title: string;
  /** Post body or article snippet. Absent is normal, not an error. */
  body?: string;
  author?: string;
  /** Subreddit, group or feed name — where a reply would be posted. */
  community?: string;
  createdAt?: Date;
}

export interface SourceResult {
  candidates: Candidate[];
  /**
   * Set when the source could not answer. NEVER set alongside a partial success that should
   * be trusted — a caller reads this as "the number beside it is not a reading".
   */
  error?: string;
  /**
   * For `manual` sources: the URLs a human should open. Kept apart from `candidates` so a
   * checklist can never be counted as a finding.
   */
  checklist?: ChecklistItem[];
}

export interface ChecklistItem {
  label: string;
  url: string;
  /** Why this one is worth opening, in a few words. */
  note?: string;
}

/**
 * Everything a source needs from the outside world, injected.
 *
 * `fetch` IS A PARAMETER AND MUST STAY ONE. It is what makes every source testable with no
 * network at all — which is not a convenience here: the sandbox this was written in has
 * reddit.com, google.com and news.ycombinator.com blocked at the proxy (403 on CONNECT), so
 * a source that reached for global `fetch` could not be exercised even once before shipping.
 * That is the validated-somewhere-other-than-where-it-runs trap, and this repo has paid for
 * it with a Cordova plugin path and a headless RC login.
 */
export interface SourceContext {
  fetch: typeof globalThis.fetch;
  /** Only consider items newer than this. */
  since: Date;
  /** Per-source configuration, read from the environment by the runner. */
  env: Record<string, string | undefined>;
  /** A hard ceiling on items per source, so one noisy feed cannot fill a digest. */
  limit: number;
}

export interface MentionSource {
  /** Stable; it is stored on every row and is half the dedupe key. */
  id: string;
  label: string;
  kind: 'automatic' | 'manual';
  /**
   * Must resolve, never reject. A source that throws would take the whole run with it and
   * the other sources' findings with that — so the contract is to catch and return `error`.
   * `runSources` enforces it anyway, because a contract nothing checks is a comment.
   */
  fetch(ctx: SourceContext): Promise<SourceResult>;
}
