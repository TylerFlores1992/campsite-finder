/*
 * WHETHER TO TRY THE HAND-OFF CART AGAIN — the user's side of the 08:00 exchange.
 *
 * ## The gap this closes
 *
 * The bot makes up to BURST_BUDGET (40) attempts, 500ms apart, from T-15s to T+30s, to
 * WIN a campsite. Until 2026-09-21 the user's own session made exactly ONE attempt to
 * take it back: `content-rc.js` fired a single POST and, on `IsSuccess: false`, went
 * straight to `setState('failed')`. Forty tries to take it, one to hand it over.
 *
 * Three things make a single attempt lose a site that was ours a second earlier:
 *
 *   1. OUR OWN RELEASE MAY NOT HAVE PROPAGATED. `remove/cartentry` returns in ~97ms and
 *      nothing establishes that RC's availability reflects it instantly. A POST that
 *      lands too early is refused because WE still hold the unit.
 *   2. RC IS FLAKY. Twenty identical calls once returned nineteen 200s and one 500
 *      (2026-07-30). A single bad draw currently costs the campsite outright.
 *   3. A COMPETITOR'S CART CAN LAPSE seconds later.
 *
 * ## Why this is a separate file
 *
 * Because the deciding is the part that gets things wrong, and a conclusion reached
 * inside a string of injected JavaScript can only be checked by running a phone. Same
 * division as `rcCloseAction` and `classifyRcAppSession`. It is loaded into the same
 * isolated world as `content-rc.js` (manifest) and concatenated ahead of it into the
 * webview bundle (`lib/rc-precart-script`), and `src/lib/handoff-retry.test.mts` calls
 * this exact file rather than a transcription of it.
 *
 * ## Why it is NOT as conservative as the bot's `isNotAvailable`
 *
 * The bot's rule is "anything not positively recognised STOPS the burst", because 40
 * fast POSTs from one residential IP into a WAF 403 makes the fault worse. This is five
 * POSTs over six seconds from one handset, so the balance is the other way round: the
 * expensive outcome here is giving up on a site that was about to be free. The two
 * refusals that retrying provably cannot help — and the one that means we already have
 * it — are still recognised and still stop.
 */
(function () {
  /** Five attempts over ~6s. Long enough for a release to propagate, short enough that
   *  nobody is left watching a spinner over a site that is genuinely gone. */
  var MAX_ATTEMPTS = 5;
  var GAP_MS = 1200;

  /**
   * @param {object} o
   * @param {number} o.attempt      1-based, the attempt that just failed.
   * @param {number} [o.status]     HTTP status, or 0/undefined for a network error.
   * @param {string} [o.error]      RC's own ErrorMessage, verbatim.
   * @param {boolean} [o.netError]  the fetch threw rather than answering.
   * @returns {{retry: boolean, waitMs: number, reason: string, held: boolean}}
   */
  function decide(o) {
    o = o || {};
    var attempt = Number(o.attempt) || 1;
    var status = Number(o.status) || 0;
    var msg = String(o.error == null ? '' : o.error).toLowerCase();
    var stop = function (reason, held) {
      return { retry: false, waitMs: 0, reason: reason, held: !!held };
    };

    // WE ALREADY HAVE IT. RC says this when the unit is in a cart bound to this session,
    // so it is a WIN, not a failure — the same string the bot's `isNotAvailable`
    // deliberately excludes. Reporting it as a failure is what made the runner log
    // "could not hold #R359" about seventy-five times over a site it was holding.
    if (msg.indexOf('already added') !== -1) return stop('the site is already in your cart', true);

    // A CAPACITY REFUSAL. RC's cart holds two; a third is refused and no amount of
    // retrying changes that. Recognised for the same reason the bot recognises it.
    if (msg.indexOf('maximum') !== -1) return stop('RC says the cart is full');

    // RETRYING PROVABLY MAKES THESE WORSE. 401 is a dead session — the next POST carries
    // the same dead token. 403 is the WAF, and this household IP has eaten a twelve-hour
    // block from RC before.
    if (status === 401) return stop('the ReserveCalifornia session is not valid');
    if (status === 403) return stop('ReserveCalifornia refused the request');

    if (attempt >= MAX_ATTEMPTS) return stop('tried ' + MAX_ATTEMPTS + ' times');

    // EVERYTHING ELSE RETRIES, INCLUDING "not available". That message covers both "a
    // competitor has it" and "RC has not caught up with our own release yet", and those
    // are opposite facts that arrive as one string. Five attempts is cheap when it is the
    // first and decisive when it is the second.
    return {
      retry: true,
      waitMs: GAP_MS,
      reason: o.netError ? 'could not reach RC' : (msg || 'RC refused, reason unstated'),
      held: false,
    };
  }

  var api = { decide: decide, MAX_ATTEMPTS: MAX_ATTEMPTS, GAP_MS: GAP_MS };
  // Both consumers live in the same isolated world; the global is explicit so the
  // dependency is greppable from `content-rc.js` rather than implied by load order.
  if (typeof window !== 'undefined') window.__chHandoffRetry = api;
  if (typeof globalThis !== 'undefined') globalThis.__chHandoffRetry = api;
})();
