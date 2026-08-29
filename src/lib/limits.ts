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
 * How many campgrounds one watch may cover (migration 070).
 *
 * A park watch counts ONCE against WATCH_LIMIT, which is the point of it — but that
 * removes the only thing bounding how many campgrounds an account can put in front of
 * the poller. This is the replacement bound.
 *
 * TEN, measured against the catalog on 2026-08-15: of the 321 parks with more than one
 * division, 87 have 2, 75 have 3, 50 have 4 and 86 have 5-9 — so ten covers 298 of them
 * whole. Only 23 exceed it, and for those the division picker already lets the user
 * choose which parts they want, so nothing becomes unwatchable. It keeps the worst case
 * at 6 x 10 = 60 campgrounds instead of 6 x 70 = 420.
 *
 * WHY THE CEILING MATTERS AT ALL: multi-division parks are ReserveCalifornia and the
 * state portals, NOT recreation.gov — so this does not touch the rec.gov budget that
 * `poller.capacity` gauges. What it loads is UseDirect through /api/rc-proxy, whose WAFs
 * meter per IP, and every division is another campground polled every 15 seconds.
 */
export const MAX_DIVISIONS_PER_WATCH = 10;

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
 * `RC_MAX_CARTS` is OURS. ~~It is **2**~~ — **SUPERSEDED: it is 10, see two paragraphs
 * down.** The 2 is kept because it is how the ceiling was measured the first time, and
 * because the constant below is the authority either way. Measured, not hoped for: `rc-probe.mjs
 * --cart-cap` ran on 2026-08-15 and held two carts live at once on ONE session and ONE
 * account: cart A filled to two, a third add refused **in RC's own cap wording** (the
 * control, without which step 4 proves nothing), then the same unit accepted into a
 * genuinely different cart key. So the old ceiling of 2 was never RC's; it was the hold
 * runner reusing `localStorage["shoppingCartKey"]` for every hold, which it no longer does.
 *
 * IT IS **10** SINCE 2026-08-17, measured by `rc-probe.mjs --cart-ladder`: TEN distinct
 * cart keys held **twenty reservations at once** on one session and one account. Every rung
 * was controlled — each cart proven FULL by a third add refused in RC's own words before the
 * next was minted — and all twenty released HTTP 200 afterwards.
 *
 * **RC IS NO LONGER THE CONSTRAINT.** The ladder stopped because it ran out of campsites,
 * not because ReserveCalifornia objected, so twenty is a FLOOR and the per-account ceiling
 * is still unknown.
 *
 * ## READ THIS BEFORE TRUSTING THE NUMBER
 *
 * The binding constraint has MOVED, and the new one is ours. It is also much smaller than
 * a first reading of the 2026-08-16 morning suggested, and the correction is worth keeping
 * because the wrong version was very nearly written down here as fact.
 *
 * MEASURED, from `carted_at - release_at`: both holds that morning carted **1 second**
 * after their own release.
 *
 *     45722  release_at 08:00:42  carted 15:00:43Z  ->  1s
 *     45723  release_at 08:00:48  carted 15:00:49Z  ->  1s
 *
 * The earlier reading of "T+43s, then T+49s, so ~43s of startup plus ~6s per site" was an
 * artifact of two mistakes: `release_at` carries SECONDS and was assumed to be 08:00:00,
 * and the six seconds between the two carts was the gap between RC's OWN release times,
 * not our serial cost. Extrapolating that gave ~T+157s for the twentieth hold, which is
 * not supported by anything.
 *
 * WHAT IS STILL UNMEASURED is how this scales: n=2, six seconds apart, so those two never
 * contended for the runner at all. Twenty holds due in ONE pass go through a single
 * Chromium in sequence and nobody has watched that happen.
 *
 * So the number was raised as an explicit product decision by the owner on 2026-08-17,
 * with RC's half measured and the contention half not. The risk it accepts is the one this
 * comment has always named — a user who believes the site is handled STOPS WATCHING, and a
 * hold that carts too late costs a morning rather than a request.
 *
 * **Checking it needs no new instrumentation**: `scripts/rc-holds-readout.mts` prints the
 * lag per hold as `T+s`. That column is what caught the arithmetic above. If tail-end holds
 * start landing late on a busy morning, that is this decision showing up, and the answer is
 * to parallelise the precart rather than to shrink the number back.
 *
 * WHY A CAP AT ALL, rather than offering and hoping. Offering a third hold for a release
 * we can only take two of is a promise that cannot be kept, and the cost is not the failed
 * cart — it is that a user who believes the site is handled STOPS WATCHING, and loses a
 * morning they could have won with an alarm clock. Same reasoning as withholding the
 * button when the runner is absent.
 */
export const RC_SITES_PER_CART = 2;
export const RC_MAX_CARTS = 10;
export const RC_HOLD_CAPACITY = RC_SITES_PER_CART * RC_MAX_CARTS;

/**
 * Minutes after carting past which a `carted` hold stops counting toward
 * `RC_HOLD_CAPACITY` for its own release — see `holdWindowLoad` — even though
 * `worker/expire-holds.ts` keeps retrying its release forever.
 *
 * LIVED IN `worker/expire-holds.ts` UNTIL 2026-08-28, where only `reclaimLapsedHolds`
 * read it. `holdWindowLoad` (in `src/lib/rc-holds.ts`) needed the same number, and
 * `rc-holds.ts` already imports things `expire-holds.ts` imports FROM — putting the
 * constant there would have made the two files import each other. This is the leaf
 * both sides can read without creating that cycle, same reason `RC_HOLD_CAPACITY`
 * lives here rather than in either.
 *
 * WHY 180: three hours is meant to be obviously past any real cart lapse, not a
 * measured one — see `reclaimLapsedHolds`'s header for what is and is not known
 * about how long RC actually holds an unclaimed cart.
 */
export const HOLD_LAPSE_MIN = Number(process.env.HOLD_LAPSE_MIN ?? 180);
