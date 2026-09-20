/**
 * DOES THIS CAMPGROUND TAKE RESERVATIONS AT ALL?
 *
 * ── THE REPORT THIS EXISTS FOR (2026-09-20) ─────────────────────────────────────────
 * The owner: *"im still getting a ton of couldnt check badges on explore"*, with a
 * screenshot of eight cards all badged COULDN'T CHECK, all Recreation.gov, all offering
 * "Start a watch".
 *
 * Measured against production rather than guessed. One live Explore search — Bakersfield,
 * 100 miles, 2026-10-14 to 16 — returned 108 results: 50 open, 37 booked, **21 unknown**.
 * All 21 were looked up in the catalog and **21 of 21 carry `reservable = false`.**
 * Perfect separation, and the names match the screenshot (KCL, Selby, Campo Alto, Rancho
 * Nuevo). **678 of 7,620 visible campgrounds are non-reservable, every one of them
 * rec.gov.** KCL's own rec.gov page says it in as many words: *"Camping is available on
 * a first come-first serve basis--we do not take reservations."*
 *
 * **SO NOTHING FAILED.** rec.gov returns no campsites because there are none to reserve,
 * `hasAvailabilityInRange` correctly returns null rather than fabricating an empty, and
 * the card renders OUR failure badge over THEIR booking policy. The three-state rule
 * (true | false | undefined, and undefined is not "booked") is right and is not the
 * question: a fourth state was missing, and it is a fact about the campground rather than
 * about the read.
 *
 * ── THE SHARPER HALF IS THE WATCH, NOT THE BADGE ────────────────────────────────────
 * Those cards also offered "Start a watch", and a watch on a campground that takes no
 * reservations **can never fire** — there is no booking, so there is no cancellation. The
 * poller would find no campsites for the life of the watch and nothing anywhere would say
 * why. That is the same shape as `supportsRcHold` being narrower than `isUseDirectSource`:
 * an offer the product cannot possibly honour is worse than no offer, because the user
 * stops looking.
 *
 * ── A PURE FUNCTION, AND IT OWNS ITS OWN COPY ───────────────────────────────────────
 * Three surfaces advertise a watch over a named campground — the Explore card, the
 * campground page, and `/new` once one is chosen. Fixing one and not its siblings is the
 * failure this repo keeps recording (`holdsAhead` against the health route's inline
 * counts; the site mute honoured by one RC finder and not the other). So the decision and
 * the words are here, and the components render what they are given.
 *
 * ── `undefined` IS NOT `false` ──────────────────────────────────────────────────────
 * `reservable` is NOT NULL in the catalog, so a real row always answers. A payload that
 * does not carry the field is an older client or a partial read, and it reports
 * `'unknown'`, which behaves exactly as everything did before this module existed.
 * Guessing `'first-come'` would withhold a watch from a campground somebody can really
 * book — the expensive direction — and it is the absent-reading-as-a-negative failure
 * this file's own report is an instance of.
 */

export type BookingPolicy =
  /** The catalog says it takes reservations. Availability, and a watch, both mean something. */
  | 'reservable'
  /** The catalog says it does not. There is nothing to book and nothing to cancel. */
  | 'first-come'
  /** NOT REPORTED. Behaves exactly as before this module existed. */
  | 'unknown';

/**
 * Read the catalog's `reservable` column into a policy.
 *
 * EXPLICIT COMPARISONS, not truthiness: `undefined` and `false` are different answers and
 * only one of them is a fact.
 */
export function bookingPolicy(reservable: boolean | null | undefined): BookingPolicy {
  if (reservable === false) return 'first-come';
  if (reservable === true) return 'reservable';
  return 'unknown';
}

/**
 * May we offer to watch this campground?
 *
 * ONLY A POSITIVE `'first-come'` WITHHOLDS. An unknown policy keeps the offer, because a
 * watch that is merely unnecessary costs a user an alert that never arrives, while a watch
 * withheld from a bookable campground costs them the campsite.
 */
export function watchable(policy: BookingPolicy): boolean {
  return policy !== 'first-come';
}

/** The badge. Replaces "Couldn't check", which described a failure that did not happen. */
export const FIRST_COME_BADGE = 'First come, first served';

/**
 * Why there is no watch here.
 *
 * IT MUST NOT READ AS A FAULT AND MUST NOT READ AS A REFUSAL. Nothing went wrong and
 * nothing is being withheld from this user in particular — the campground simply cannot
 * be booked in advance, so it states the fact and what to do instead.
 */
export const FIRST_COME_WHY =
  "This campground doesn't take reservations, so there's nothing to cancel and an alert " +
  'would never arrive. Sites go to whoever turns up.';
