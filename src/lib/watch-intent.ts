/**
 * CARRY THE INTENT THROUGH SIGN-UP.
 *
 * THE BUG THIS EXISTS TO FIX (found 2026-09-03). Someone finds a campground, presses "Start a
 * watch", and is sent to a BARE `/sign-up`. They create an account, and land on an empty
 * `/search` — the campground, the dates and the filters they had just chosen are gone, and
 * they are asked to find it again. `WatchCta` had assembled the exact destination three lines
 * above for a subscriber and then discarded it for the visitor with the highest intent in the
 * whole product: someone who has just tried to watch a specific site.
 *
 * THE CARRY-THROUGH ALREADY EXISTED AND SIMPLY WAS NOT USED. `/sign-up?redirect_url=X` is read
 * by `AuthPanel`, which hands Clerk `forceRedirectUrl=/welcome?next=X`, and `Welcome` pushes
 * `next` when the step is finished or skipped. That chain is three files old and its own
 * comment says why it was built: it would "otherwise strand someone who was halfway through
 * setting up a watch". `SubscribeCta` uses it. The two highest-intent call sites did not.
 *
 * MEASURED, so the size of it is not a guess: over the eight weeks to 2026-09-03, 13 organic
 * accounts, 8 finished the welcome step and only 4 ever created a watch. The drop is AFTER
 * onboarding, which is exactly where an empty `/search` is what we hand them.
 *
 * ONE DEFINITION, because the failure was two call sites disagreeing about the same idea.
 * Pinning it in a helper is what makes the guard in `src/lib/watch-intent.test.mts` a rule
 * ("no sign-up link discards intent") rather than an assertion about one component — and it
 * is the third call site, not these two, that would otherwise regress.
 */

export interface WatchIntent {
  /** Absent where there is no single campground yet — Explore's "nothing open" prompt. */
  campgroundId?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * The New watch screen, pre-filled with whatever is known.
 *
 * The parameter names are `campground` / `start` / `end` because that is what `/new` reads;
 * they are deliberately NOT the `startDate` / `endDate` that `/search` uses. Two screens, two
 * vocabularies, and a helper that quietly renamed them would produce a link that looks right
 * and arrives empty.
 */
export function newWatchPath(intent: WatchIntent): string {
  const qs = new URLSearchParams();
  if (intent.campgroundId) qs.set('campground', intent.campgroundId);
  if (intent.startDate) qs.set('start', intent.startDate);
  if (intent.endDate) qs.set('end', intent.endDate);
  const q = qs.toString();
  return q ? `/new?${q}` : '/new';
}

/**
 * Sign up, then land on the New watch screen with the campground and dates intact.
 *
 * `redirect_url` and not `forceRedirectUrl`: Clerk's own parameter is what `AuthPanel` reads,
 * and it deliberately routes through `/welcome` first so the alert preferences and the
 * optional phone number are still collected. Sending someone straight to `/new` would skip
 * the one screen that asks how they want to be told.
 */
export function signUpToWatchHref(intent: WatchIntent): string {
  return `/sign-up?redirect_url=${encodeURIComponent(newWatchPath(intent))}`;
}
