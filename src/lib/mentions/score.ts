/**
 * "Is this post worth replying to?" — the pure half of the monitor.
 *
 * Separated from every fetcher on purpose. The fetchers cannot run in this sandbox at all
 * (reddit.com and google.com are 403 at the proxy), so if the decision lived inside them it
 * would ship having never once been executed. It is also the part that will actually be
 * tuned: the queries change weekly, the HTTP does not.
 *
 * ## PRECISION OVER RECALL, DELIBERATELY, AND THE ARITHMETIC SAYS WHY
 *
 * At CampHawk's size this surfaces perhaps two or three genuinely relevant posts a week.
 * A digest that is mostly noise gets skimmed and then ignored, and an ignored digest is
 * worth exactly nothing — so a miss costs one post and a false positive costs the whole
 * instrument. That is why the threshold is high, why a strong term is required rather than
 * merely counted, and why the anti-terms exist.
 *
 * ## THE STRUCTURE: A GATE, THEN A SCORE
 *
 * A candidate must contain at least one STRONG term — something only a person with this
 * exact problem writes. Weak signals then rank the survivors. Scoring without the gate is
 * how "camping" ends up on the list: it appears in every post in every camping subreddit,
 * so it separates nothing while looking like evidence.
 */

import type { Candidate } from './types';

/**
 * The problem, in the words people actually use. One of these must appear.
 *
 * `campnab` and `campflare` are competitors, and a post naming one is somebody who has
 * already decided they want this category — the highest-intent string on the list.
 */
export const STRONG_TERMS: readonly string[] = [
  'campnab',
  'campflare',
  'campsite assist',
  'cancellation alert',
  'cancellation notification',
  'campsite alert',
  'campground alert',
  'notify me when a campsite',
  'alert when a campsite',
  'snag a campsite',
  'get a cancellation',
  'watch for cancellations',
  'reservecalifornia',
  'reserve california',
  'recreation.gov alert',
  'campsite cancellation',
  'campground cancellation',
];

/**
 * Circumstance. These do not qualify a post on their own — plenty of people say "fully
 * booked" about a hotel — but beside a strong term they say this is a real person stuck
 * right now rather than a general discussion of the category.
 */
export const CONTEXT_TERMS: readonly string[] = [
  'fully booked',
  'sold out',
  'all reserved',
  'no availability',
  'nothing available',
  'booked solid',
  'impossible to get',
  'how do i get a spot',
  'how do you get a spot',
  'any tips for booking',
  'released at 8am',
  'booking window',
  'refresh',
];

/**
 * Reasons to stay out of a thread. Each of these is a real way the strong terms fire on
 * something that is not a customer:
 *
 *   - somebody selling or transferring a reservation — replying with a tool reads as
 *     touting, and the sub usually forbids it;
 *   - a thread about scalping or resale bots, where "cancellation alert" is the villain;
 *   - a competitor's own promotion, where a reply is a fight rather than a recommendation.
 */
export const ANTI_TERMS: readonly string[] = [
  'for sale',
  'selling my reservation',
  'transfer my reservation',
  'scalper',
  'scalping',
  'reseller',
  'venmo',
  'paypal me',
  'dm me for',
  'affiliate link',
  'promo code',
  'discount code',
];

/** Named so a change is a decision rather than a nudge. */
export const STRONG_POINTS = 10;
export const CONTEXT_POINTS = 3;
export const QUESTION_POINTS = 4;
export const ANTI_PENALTY = 12;
/** A candidate at or above this is worth a human's attention. */
export const SURFACE_THRESHOLD = 12;

export interface Score {
  score: number;
  /** Why it scored what it did, for the digest — a bare number is not actionable. */
  reasons: string[];
  surfaced: boolean;
}

/**
 * Lower-cased title and body, joined.
 *
 * Punctuation is NOT stripped: "reserve california" and "reservecalifornia" are separate
 * entries in STRONG_TERMS precisely because both spellings occur, and normalising them
 * together would hide which one matched from the digest.
 */
function haystack(c: Candidate): string {
  return `${c.title} ${c.body ?? ''}`.toLowerCase();
}

function hits(text: string, terms: readonly string[]): string[] {
  return terms.filter((t) => text.includes(t));
}

/**
 * A question is a request for help, which is the only kind of post where an unsolicited
 * product mention is welcome. A statement about camping is a conversation we were not
 * invited to.
 *
 * Matched on the TITLE only. Bodies are full of rhetorical questions, and a body match
 * would qualify nearly everything — a signal that fires on everything is not a signal.
 */
function looksLikeAQuestion(title: string): boolean {
  const t = title.toLowerCase().trim();
  if (t.includes('?')) return true;
  return /^(how|what|where|when|is there|are there|any(one|body)?|does any|can i|need help|help)\b/.test(t);
}

export function scoreCandidate(c: Candidate): Score {
  const text = haystack(c);
  const strong = hits(text, STRONG_TERMS);
  const context = hits(text, CONTEXT_TERMS);
  const anti = hits(text, ANTI_TERMS);
  const reasons: string[] = [];

  // THE GATE. No strong term, no candidate — whatever else it scored. Without this,
  // "camping" plus "fully booked" clears any threshold worth setting, and every post in
  // r/camping qualifies.
  if (strong.length === 0) {
    return { score: 0, reasons: ['no strong term — this is not somebody with our problem'], surfaced: false };
  }
  reasons.push(`mentions ${strong.join(', ')}`);

  let score = strong.length * STRONG_POINTS;
  if (context.length > 0) {
    score += context.length * CONTEXT_POINTS;
    reasons.push(`stuck right now (${context.join(', ')})`);
  }
  if (looksLikeAQuestion(c.title)) {
    score += QUESTION_POINTS;
    reasons.push('asking a question, so a reply is welcome');
  }
  if (anti.length > 0) {
    // A PENALTY, NOT A VETO, and the difference is deliberate: "promo code" appears in
    // plenty of honest threads. Large enough that one anti-term sinks a bare strong match
    // and small enough that a post fitting on every other axis can still survive it.
    score -= anti.length * ANTI_PENALTY;
    reasons.push(`⚠ stay out unless it reads right (${anti.join(', ')})`);
  }

  return { score, reasons, surfaced: score >= SURFACE_THRESHOLD };
}

/**
 * The dedupe key. Source plus the source's own id, never the URL — Reddit serves the same
 * post under several URLs (with and without the slug, old./www., a share suffix), so a
 * URL-keyed monitor re-surfaces the same thread until the reader stops trusting it.
 */
export function dedupeKey(c: Candidate): string {
  return `${c.source}:${c.externalId}`;
}
