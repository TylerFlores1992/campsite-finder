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
// STILL UNPROVEN (the one make-or-break): that a DIFFERENT logged-in session adopts a
// foreign cart key written to its localStorage and sees that cart. Everything points to
// yes (anonymous cart, pure-GUID addressing, localStorage is the store), but it must be
// confirmed with the two-browser test before the bot side is built. See docs/CONTEXT.md.
//
// THE BOT SIDE, once confirmed: the bot needs an RC session (its own login, or a stored
// user login via a /connect flow like rec.gov) to POST precartdata and create the cart,
// then reports the shoppingCartKey back on the autocart_job. No payment automation, no
// checkout — the reCAPTCHA lives only on the final checkout the human does.
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
