// Account-level quotas, shared by the server enforcement and the UI copy so they
// can never drift apart (the cap used to be hardcoded in three files).
//
// Lowered 10 → 6 on 2026-08-01. Capacity math: a rec.gov watch costs ~4 req/min
// per campground-month against a 15/min-per-IP budget, so the watch cap is the
// only user-facing number that bounds how many shards a single account can force.
// Lowering the cap does NOT deactivate existing watches above it — accounts over
// the cap just can't add another until they're back under.
export const WATCH_LIMIT = 6;

/**
 * How long ReserveCalifornia keeps a site in a cart before dropping it.
 *
 * **READ OFF RC'S BUNDLE, NEVER OBSERVED.** The bundle exposes `extendShoppingCartTimer`
 * and the UI counts down from 15 minutes, but nobody has watched an RC cart actually
 * lapse. Treat it as the best available number and not a measurement — this codebase has
 * a run of confidently-held figures that turned out wrong (the "~8 hour RC session cap"
 * was really 1h20m; "the keep-warm renews the session" renewed nothing).
 *
 * That uncertainty is why every string built from this hedges — "about 15 minutes", "may
 * already have been released" — rather than asserting a deadline we cannot stand behind.
 *
 * WHY THE HOLD SWEEP IS STILL 45 MINUTES. `expireStaleHolds` is when WE give up and tell
 * the bot to let go; it is deliberately NOT lowered to match, because our own sweep
 * releasing a site at minute 15 would throw away a hold the user is walking towards. The
 * two numbers answer different questions, and the gap between them is exactly what the
 * copy now admits to instead of papering over.
 */
export const RC_CART_HOLD_MINUTES = 15;

/**
 * How many sites we can actually be holding at one release — the number the offer copy
 * has to be able to stand behind.
 *
 * `RC_SITES_PER_CART` is RC's, and it is measured: a third add to one cart on 2026-08-13
 * came back *"the maximum number of reservations allowed in the cart is '2'"*.
 *
 * `RC_MAX_CARTS` is OURS, and it is 1 because that is all we can prove. The hold runner
 * reuses `localStorage["shoppingCartKey"]` for every hold, so every hold the system has
 * ever made went into one of two carts. Whether one RC session may hold several carts at
 * once is unmeasured — `rc-probe.mjs --cart-cap` settles it, and this is the constant to
 * raise afterwards. Raising it before is promising capacity nobody has seen.
 *
 * WHY A CAP AT ALL, rather than offering and hoping. Offering a third hold for a release
 * we can only take two of is a promise that cannot be kept, and the cost is not the failed
 * cart — it is that a user who believes the site is handled STOPS WATCHING, and loses a
 * morning they could have won with an alarm clock. Same reasoning as withholding the
 * button when the runner is absent.
 */
export const RC_SITES_PER_CART = 2;
export const RC_MAX_CARTS = 1;
export const RC_HOLD_CAPACITY = RC_SITES_PER_CART * RC_MAX_CARTS;
