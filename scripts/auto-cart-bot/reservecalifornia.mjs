// ═══════════════════════════════════════════════════════════════════════════════════
// SETTLED 2026-08-06 — read this first; the notes below it predate the real test.
//
// PROVEN, with evidence, by scripts/auto-cart-bot/rc-probe.mjs:
//   1. The bot logs into RC unattended — no MFA, no CAPTCHA — but ONLY HEADFUL. Every
//      headless attempt died at the Okta email step; every headful one passed on the
//      first Enter. The production bot therefore needs a real display, not just a
//      process. On the mini-PC that is free; anywhere else it means a virtual display.
//   2. The bot CARTS. Confirmed by reading the cart back by name, not by trusting a
//      success flag: "Leo Carrillo SP - Canyon Campground - Hook Up (E) Campsite - 006,
//      Thu 08/27/2026 - Fri 08/28/2026", placeId 665 / facilityId 539.
//   3. THE CART KEY IS NOT ENOUGH — this is the one that decides the architecture.
//      `rc-probe.mjs --cart --handoff` logs a SECOND session into the SAME account from
//      a freshly deleted profile, confirms the two tokens differ, and asks it to read
//      the cart by key: 0 entries. The cart is bound to the SESSION that created it,
//      not to the account and not to the key.
//
// THE CONSEQUENCE, and it is not a small one: a bot-held cart is not merely unreachable
// by the user — the hold LOCKS THE UNIT. Carting without a working hand-off would take
// the site off the market and then deny it to the very person we alerted. That is worse
// than doing nothing, so RC auto-cart stays OFF until a hand-off is built and tested.
//
// What remains is in docs/CONTEXT.md → "ReserveCalifornia auto-cart". Short version:
// either move the session (works, but moves a live credential), or have the bot release
// its hold at the moment the user's own session takes it (moves nothing, small race).
// ═══════════════════════════════════════════════════════════════════════════════════
//
// ReserveCalifornia auto-cart: NOT enabled yet, but a viable path has been identified.
// Investigated 2026-08-05 against a live RC account AND by reading RC's own web bundle.
// Read this before touching it.
//
// WHAT WE ESTABLISHED
//
// 1. The cart is a free-floating object keyed by a GUID, not owned by an account.
//    `POST rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart` takes
//    `{"shoppingCartKey": "<guid>"}` in the BODY and returns that cart. Every entry
//    carries `"CustomerId": 0` — the cart is not attached to the signed-in customer.
//    Reading a cart still needs SOME valid Okta token (401 without one), but because the
//    cart is anonymous, any valid token can almost certainly read any cart by key.
// 2. The web app's SINGLE source of truth for "which cart am I" is
//    `localStorage["shoppingCartKey"]`. Confirmed by reading the bundle: every cart op
//    (emptyCart, extendShoppingCartTimer, checkout) reads the key from there, and
//    NOTHING reads it from the URL — which is exactly why the `?shoppingCartKey=` URL
//    test failed (three URL shapes, live cart, same account, phone all showed empty).
// 3. THEREFORE the transfer works by writing that one localStorage value. On desktop the
//    CampHawk extension does it (extension/content-rc.js, #camphawk-rccart=<key>): write
//    the key, reload, RC shows the held cart, human checks out. On mobile the native app
//    could do the same by injecting the value into its reservecalifornia.com webview.
// 4. THE 15-MINUTE HOLD IS NOT A CEILING. The bundle exposes `extendShoppingCartTimer`
//    ({shoppingCartKey}) — whoever holds the key can keep the cart alive. A bot can hold
//    a site well past 15 minutes while the user gets to their phone.
//
// TESTED 2026-08-05 — AND THE CROSS-SESSION HAND-OFF DOES NOT WORK. Writing the same
// shoppingCartKey into localStorage was tried in three places:
//   • the ORIGINAL window that created the cart (this PC, logged in as the owner) → the
//     cart showed. Trivial — same session, same token, same cookies.
//   • a fresh INCOGNITO window on the SAME PC, logged into the SAME account → EMPTY.
//   • the mini-PC → EMPTY.
// Same account, same key, fresh session ⇒ empty. So the cart is bound to the SESSION
// that created it — its Okta token and/or the AWS load-balancer stickiness cookies
// (`AWSALBAPP-*`, `stickounet`) — NOT to the cart key or the customer. `CustomerId: 0`
// was a red herring: the key alone is not a bearer of the cart.
//
// CONSEQUENCE: a bot on the mini-PC cannot create a cart the user's phone can later
// claim by key. The clean "bot holds, user claims" design is dead as a KEY hand-off.
//
// What remains, both with real costs:
//   1. FULL SESSION CLONE — the bot logs in AS the user, and we transfer the whole
//      session (Okta token + AWSALBAPP/stickounet cookies + cart key) to the user's
//      device so it BECOMES the bot's session. Fragile: the token expires in ~1 hour,
//      the cookies live on rdapi.reservecalifornia.com (a different subdomain, hard to
//      inject), and it moves a live RC session token around. Not attempted.
//   2. BOT COMPLETES CHECKOUT — the only true 24/7 auto-grab, but it spends the user's
//      money and must clear the Oct-2025 reCAPTCHA + Okta MFA. A different product.
//
// What DOES work today: the CampHawk browser extension carts in the USER'S OWN session
// on desktop (extension/content-rc.js precart path) — same session, so no hand-off.
// That needs the user at their machine; it is not the away-from-keyboard win.
//
// THE PRECART PAYLOAD IS SOLVED (2026-08-06). The submit used to come back HTTP 200 with
// IsSuccess:false naming one field ("Please confirm your booking dates…"). It is an
// "extra": RC's own bundle (assets/FacilityPreCart-*.js) submits them as
// `{extraId, extraValue}` — lowerCamel — read from `UnitDetail.Extras.$values` in the
// LOAD response, and ExtraType 0 is a CheckBox whose answer is the string "true".
// Five earlier attempts sent `ExtraId`/`Value`; unknown keys are dropped silently, so
// every one produced the SAME error and it looked like a wrong value. Both this repo's
// implementations (rc-probe.mjs, extension/content-rc.js) now do it RC's way, and
// scripts/rc-cart-canary.mts asserts the contract daily. Full write-up in
// docs/CONTEXT.md → "The precart extraValues contract".
//
// The consequence: a bot carting on the mini-PC creates a cart the user can never reach.
// It could truthfully report "carted" and the site would still be unbookable by them —
// which is worse than not carting, because auto-cart's one promise is that "it's in your
// cart" is verifiable.
//
// WHAT WOULD ACTUALLY WORK, and why it is a product decision rather than a patch:
// the bot would have to complete the CHECKOUT, not just the cart.
//
// The read operations are trivially automatable — every RC call is a JSON POST with an
// Okta bearer token (1-hour expiry) plus `installationsidentity: cali` and
// `storeid: 111`, no browser or DOM automation, unlike the rec.gov path. **But the cart
// page carries a reCAPTCHA badge** (observed 2026-08-05, alongside the Go To Checkout
// button). Whether it gates the checkout POST itself is UNVERIFIED, and it is the one
// control specifically designed to stop what this would be doing. Do not repeat the
// earlier claim that checkout is "just JSON" without testing that first.
//
// And it moves us from "we put it in your cart" to "we spent your money": RC charges at
// booking ($8.25 reservation fee per cart entry, plus the nightly rate), a wrong site or
// wrong date becomes a real charge and a cancellation fee, and it crosses the line that
// makes the rec.gov feature defensible — today a human always completes the purchase.
//
// Until that decision is made, the alert does the work: it links straight to the RC
// booking page, and the CampHawk browser extension (extension/content-rc.js) carts it in
// one tap if they're on a desktop with the extension installed.

export async function noteReserveCalifornia(job, log) {
  const url = job.bookingUrl.split('#')[0] || 'https://www.reservecalifornia.com/';
  log(`  ↗ CA State Parks opening: ${job.campgroundName} (${job.startDate}) — grab it from the CampHawk alert on your phone → ${url}`);
}
