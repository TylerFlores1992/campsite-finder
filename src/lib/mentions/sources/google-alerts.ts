import type { Candidate, MentionSource, SourceContext, SourceResult } from '../types';

/**
 * Google Alerts, via the RSS delivery option — the only free, sanctioned way to watch Google.
 *
 * ## WHY THIS AND NOT "SERP WATCHING"
 *
 * There is no free Google Search API. The two things people mean by SERP watching are
 * different problems with different honest answers:
 *
 *   1. "Is anyone talking about us / our competitors?" — THIS FILE. Google Alerts indexes
 *      new pages matching a query and will deliver them to an RSS feed URL, free, forever,
 *      with no key. Set the alert up once in the UI and paste the feed URL into the env.
 *
 *   2. "Where do WE rank for X?" — that is Search Console, which is already connected and
 *      reports actual impressions and average position for our own pages. It is a strictly
 *      better instrument than a rank check because it is measured rather than sampled.
 *
 * Scraping google.com/search is neither: it violates the terms, it is blocked in practice,
 * and a paid SERP API is a spending decision rather than something to slip into a monitor.
 *
 * ## SETUP, WHICH IS A HUMAN STEP AND CANNOT BE AUTOMATED
 *
 *   google.com/alerts → create an alert → Show options → Deliver to: RSS feed →
 *   copy the feed URL. Suggested queries are in `SUGGESTED_ALERTS` below.
 *
 * Put them in `MENTIONS_GOOGLE_ALERT_FEEDS`, comma-separated. UNSET IS NOT AN ERROR and must
 * never be reported as one: nobody has set them up yet is the ordinary starting state, and a
 * monitor that cries wolf on its own configuration gets ignored along with its findings. It
 * is reported as "not configured", which is a different sentence from "found nothing".
 *
 * NEVER EXERCISED AGAINST A LIVE FEED FROM THE SESSION THAT WROTE IT — google.com answers
 * 403 to CONNECT at this sandbox's proxy. Parsing is tested against a captured Atom fixture.
 */

/** Paste these into google.com/alerts. Ordered by how likely a hit is to be a buyer. */
export const SUGGESTED_ALERTS: readonly { query: string; why: string }[] = [
  { query: '"campnab" OR "campflare"', why: 'somebody comparing tools in this exact category' },
  { query: '"campsite cancellation" alert', why: 'the problem, in the words people write' },
  { query: '"reservecalifornia" cancellation', why: 'our differentiator, and nobody else does it' },
  { query: '"camphawk"', why: 'anyone writing about us — reviews, mentions, complaints' },
  { query: 'campsite booking bot OR "camping reservation bot"', why: 'the category, broadly' },
];

/**
 * Strip the `<b>` highlighting and entities Google Alerts wraps matched terms in.
 *
 * THE ORDER IS THE WHOLE FUNCTION, and both halves of it were got wrong first time.
 *
 * 1. `&lt;`/`&gt;` are unescaped BEFORE tags are stripped. Google sends
 *    `<title type="html">`, so its bold markup arrives XML-escaped as `&lt;b&gt;` — strip
 *    tags first and there are no tags yet, the unescape then reveals them, and `<b>` reaches
 *    the digest. Caught by running it, not by reading it.
 * 2. `&amp;` is unescaped LAST. Doing it first turns `&amp;lt;` into `&lt;` and then into
 *    `<` — the classic double-unescape, which here would let markup out of a feed we do not
 *    control past a strip that has already run.
 */
export function unescapeAlertText(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * An href out of raw XML needs the XML escaping undone and NOTHING else.
 *
 * Deliberately not `unescapeAlertText`, which strips anything between angle brackets — that
 * is right for a title and wrong for a URL, where it would silently eat a path segment
 * rather than fail. One unescape, one job.
 */
export function xmlUnescapeAttr(raw: string): string {
  return raw.replace(/&amp;/g, '&');
}

/**
 * Google Alerts wraps the real destination in a redirect:
 * `https://www.google.com/url?rct=j&url=<the real one>&ct=ga&…`
 *
 * Unwrapped so the digest shows where a link actually goes. A reader deciding whether to
 * open something should not have to trust an opaque redirect, and the redirect is also what
 * makes two feeds report the same article as two different URLs.
 */
export function unwrapAlertUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
      const real = u.searchParams.get('url');
      if (real) return real;
    }
  } catch {
    /* a feed we do not control can carry anything; keep what we were given */
  }
  return href;
}

/**
 * Atom, not RSS, whatever the UI calls it. Exported because it is the whole testable surface.
 *
 * A HAND-ROLLED PARSER RATHER THAN A DEPENDENCY, deliberately. Google Alerts emits one rigid
 * shape and this reads four fields from it; an XML library would be a new package in the web
 * bundle's tree to save twenty lines. If the shape ever varies, this returns fewer entries
 * rather than wrong ones — and it is a diagnostic, so under-reading fails safe.
 */
export function parseAlertFeed(xml: string, feedLabel: string, since: Date): Candidate[] {
  const out: Candidate[] = [];
  for (const m of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/g)) {
    const entry = m[0];
    const id = /<id>([\s\S]*?)<\/id>/.exec(entry)?.[1]?.trim();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(entry)?.[1];
    const href = /<link[^>]*href="([^"]+)"/.exec(entry)?.[1];
    const published = /<published>([\s\S]*?)<\/published>/.exec(entry)?.[1]?.trim();
    if (!id || !title || !href) continue;

    const createdAt = published ? new Date(published) : undefined;
    // An unparseable date is treated as IN RANGE rather than dropped. `since` is a
    // convenience filter, not a correctness rule, and discarding an item because its
    // timestamp would not parse is the absent-reading-as-a-negative mistake.
    if (createdAt && Number.isFinite(createdAt.getTime()) && createdAt < since) continue;

    out.push({
      source: 'google-alerts',
      externalId: id,
      url: unwrapAlertUrl(xmlUnescapeAttr(href)),
      title: unescapeAlertText(title),
      body: unescapeAlertText(/<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] ?? ''),
      community: feedLabel,
      createdAt: createdAt && Number.isFinite(createdAt.getTime()) ? createdAt : undefined,
    });
  }
  return out;
}

export const googleAlertsSource: MentionSource = {
  id: 'google-alerts',
  label: 'Google Alerts',
  kind: 'automatic',

  async fetch(ctx: SourceContext): Promise<SourceResult> {
    const feeds = (ctx.env.MENTIONS_GOOGLE_ALERT_FEEDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (feeds.length === 0) {
      // NOT an error. See the header: unconfigured is the starting state, and the digest
      // renders this as a setup instruction rather than a failure.
      return {
        candidates: [],
        checklist: SUGGESTED_ALERTS.map((a) => ({
          label: a.query,
          url: 'https://www.google.com/alerts',
          note: a.why,
        })),
      };
    }

    const candidates: Candidate[] = [];
    const failures: string[] = [];
    for (const feed of feeds) {
      try {
        const res = await ctx.fetch(feed, { headers: { accept: 'application/atom+xml, application/xml' } });
        if (!res.ok) {
          failures.push(`${short(feed)} → HTTP ${res.status}`);
          continue;
        }
        candidates.push(...parseAlertFeed(await res.text(), 'Google Alerts', ctx.since));
      } catch (err) {
        failures.push(`${short(feed)} → ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      candidates,
      error: failures.length ? `${failures.length}/${feeds.length} feed(s) failed: ${failures.join('; ')}` : undefined,
    };
  },
};

/** Feed URLs carry a long opaque id; print enough to tell two apart and no more. */
function short(feed: string): string {
  return feed.length > 60 ? `${feed.slice(0, 57)}…` : feed;
}
