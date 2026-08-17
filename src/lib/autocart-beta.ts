/**
 * ReserveCalifornia auto-hold is labelled BETA, in one place.
 *
 * ## Why it needs saying at all
 *
 * The entitlement was never the gate. `hasAutocartEntitlement` has been
 * `is_beta OR (a live autocart/grandfathered subscription)` since migration 032, and the
 * poller's hold offer uses exactly that definition — so every beta tester with an RC watch
 * has been eligible for a "Hold it for me" button the whole time. Nothing had to be opened.
 *
 * What was missing is that nothing SAID SO. A tester would meet a button promising to take
 * a campsite off the market on their behalf, in a feature whose full path — offer, tap,
 * cart at 08:00, claim, release — has completed end to end on exactly one real morning
 * (2026-08-16, two holds) plus a handful of synthetic runs. That is real evidence and it is
 * not a track record.
 *
 * ## The cost this wording is defending against
 *
 * It is NOT the failed cart. It is that **a user who believes the site is handled stops
 * watching** — the rule the claim copy has been governed by since 2026-08-09. Somebody who
 * sets an alarm and loses the site to a faster human had a fair morning; somebody who went
 * back to sleep because we said we had it did not. So the label has to arrive BEFORE the
 * decision to rely on it, which is the confirm screen and the alert that carries it, and it
 * has to name the remedy rather than merely hedge.
 *
 * ## NOT IN SMS, deliberately
 *
 * The coming-soon offer text is 154 characters against a 160-character one-segment budget,
 * already after `fitOneSegment` trims the campground name. Any beta wording spends more
 * than the five characters of margin and tips the message into TWO segments — which is the
 * exact shape that was Undelivered/30007 thirteen times on 2026-08-05. A label nobody
 * receives, attached to an alert nobody receives, is strictly worse than no label. The text
 * already says "open your email or the app", and both of those carry it.
 * `worker/autocart-beta.test.mts` fails if it ever appears in `smsBody`.
 */

/** The badge. Short enough to sit beside a heading without wrapping on a phone. */
export const AUTOCART_BETA_LABEL = 'Beta';

/**
 * The sentence, in the one order that works: what it is, what it has done, what it can do
 * to you, and what to do about it. "Keep your alarm set" is the load-bearing half — a
 * caveat with no instruction reads as legal throat-clearing and changes nobody's morning.
 */
export const AUTOCART_BETA_NOTE =
  'Auto-hold is in beta. It has worked on real releases, and it can still miss — ' +
  'set an alarm for the release time and be ready to book it yourself.';

/** The same thing with a character budget, for a push body or a card subtitle. */
export const AUTOCART_BETA_NOTE_SHORT =
  'Beta — set an alarm too, in case we miss it.';
