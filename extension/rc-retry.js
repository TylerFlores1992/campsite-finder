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

  /**
   * WHAT TO SHOW THE PERSON HOLDING THE PHONE, once `decide` has stopped.
   *
   * ## The bug this exists for (2026-09-22, reported from a real hand-off)
   *
   * The failure line read **"RC declined (401) — see console"**. Three things wrong with
   * it, and the third is the one that matters:
   *
   *   1. `RC` is our abbreviation. Nobody outside this repo expands it.
   *   2. `401` is an HTTP status. It is the single most useful fact we have and it means
   *      nothing whatever to the person reading it.
   *   3. **`see console` is an instruction that cannot be followed.** There is no console
   *      on a phone, inside an in-app webview, at 08:00. It is a message to a developer
   *      printed on a customer's screen — and it appears exactly when the developer is
   *      not there, which is the only time it is ever shown.
   *
   * And the sentence displaced the only thing worth saying: what to do next. A 401 and a
   * full cart have completely different remedies and both rendered as "RC declined".
   *
   * ## The technical string is NOT discarded — it moves
   *
   * `content-rc.js` writes it to `#camphawk-rc-status`'s `data-detail`, which
   * `lib/rc-precart-script`'s epilogue forwards beside the visible status. So the
   * diagnostic keeps the status code and the user gets a sentence, which is the split the
   * old line was trying to do with one string and could not.
   *
   * ## Classification mirrors `decide` ON PURPOSE, and is pinned to it
   *
   * `decide` answers "try again?" and this answers "so what do I tell them?" — the same
   * facts, two questions. They are separate functions because a retry rule that acquired
   * copy, or copy that acquired a retry rule, is how both get edited by someone who only
   * meant to change the other. `handoff-retry.test.mts` drives one table through BOTH, so
   * a case recognised by one and not the other fails.
   *
   * @param {object} o `{ status, error, netError }` — the same shape `decide` takes.
   * @returns {string} One sentence: what happened, then what to do about it.
   */
  function explain(o) {
    o = o || {};
    var msg = String(o.error == null ? '' : o.error).toLowerCase();
    var status = Number(o.status) || 0;

    if (msg.indexOf('already added') !== -1) return 'It is already in your cart.';
    if (msg.indexOf('maximum') !== -1) {
      return 'Your ReserveCalifornia cart is full. Check out or remove a site, then try again.';
    }
    // THE REMEDY IS THE POINT. A dead session is the one failure the person can actually
    // fix, in about twenty seconds, on the page they are already looking at — and the old
    // wording ("RC declined (401)") told them nothing was fixable.
    if (status === 401) {
      return 'Your ReserveCalifornia sign-in has expired. Sign in on this page, then add the site to your cart.';
    }
    if (status === 403) {
      return 'ReserveCalifornia would not accept the request. Book the site on this page.';
    }
    if (o.netError) return 'We could not reach ReserveCalifornia. Book the site on this page.';
    // "NOT AVAILABLE" AFTER THE RETRIES ARE SPENT IS THE HONEST LOSS. Said plainly rather
    // than hedged: somebody who is told "something went wrong" goes and retries a site that
    // has gone, and the useful next move is to look at what else is open.
    if (msg.indexOf('not available') !== -1) {
      return 'Someone else booked it first. The site is gone.';
    }
    return 'ReserveCalifornia would not add the site. Book it on this page.';
  }

  var api = { decide: decide, explain: explain, MAX_ATTEMPTS: MAX_ATTEMPTS, GAP_MS: GAP_MS };
  // Both consumers live in the same isolated world; the global is explicit so the
  // dependency is greppable from `content-rc.js` rather than implied by load order.
  if (typeof window !== 'undefined') window.__chHandoffRetry = api;
  if (typeof globalThis !== 'undefined') globalThis.__chHandoffRetry = api;
})();
