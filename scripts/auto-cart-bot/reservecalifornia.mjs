// ReserveCalifornia (CA State Parks) is NOT auto-carted by the bot. Tested, not assumed
// — 2026-08-05, against a live RC account, and worth reading before anyone tries again.
//
// WHAT WE ESTABLISHED
//
// 1. The cart is a free-floating object keyed by a GUID, not owned by an account.
//    `POST rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart` takes
//    `{"shoppingCartKey": "<guid>"}` in the BODY and returns that cart. Every entry in
//    the response carries `"CustomerId": 0` — the cart is not attached to the signed-in
//    customer at all.
// 2. So a second device sees nothing: it mints its own key and asks for a different
//    cart. Confirmed — cart on desktop, phone shows empty.
// 3. And the key CANNOT be handed over. Tested three URL shapes on a phone signed into
//    the same account, inside the 15-minute window, all with `?shoppingCartKey=<guid>`:
//    `/`, `/park/665/539`, and `/Web/Default.aspx`. None loaded the cart. RC's front end
//    only ever uses the key in its own storage; the query parameter is ignored.
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
