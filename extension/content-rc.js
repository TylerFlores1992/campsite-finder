/*
 * CampHawk Quick Cart — ReserveCalifornia (CA State Parks).
 *
 * RC's cart is API-driven, so unlike rec.gov we don't drive the DOM — we POST
 * the same request the site does, from the user's own logged-in session:
 *   POST https://rdapi.reservecalifornia.com/api/webaccessfacility/submit/precartdataforbookingmodify
 *   Authorization: Bearer <ssoAccessToken from localStorage>
 * The alert link carries #camphawk-rc={unitId}_{arrival}_{nights}_{sleepingUnitId}.
 *
 * Runs entirely in the user's browser/session; CampHawk never sees their RC login.
 *
 * NOTE (maintainers): a couple of payload fields (customerClassificationId,
 * sleepingUnit.name) are unit/customer-specific. We send best-effort defaults captured
 * from a real add-to-cart; if RC rejects them the banner reports the error and the
 * user books manually. Re-capture a live payload if RC changes its schema.
 *
 * extraValues is NO LONGER a guess (2026-08-06). Many CA facilities declare a required
 * "extra" — e.g. the checkbox "Please confirm your booking dates before finalizing your
 * reservation." — and a submit that omits it comes back HTTP 200 with IsSuccess:false
 * and that field named. We answer it exactly the way RC's own bundle does; the wire
 * shape and the value rules are documented on buildExtraValues() below.
 */

(function () {
  const STASH = 'camphawk_rc';
  /**
   * WE ALREADY CARTED THIS — and it has to survive a page load.
   *
   * `carted` below is a module variable, which is enough for an SPA navigation and is
   * nothing at all across a real one: a fresh document gets a fresh `false`. That did not
   * matter while a successful cart left the user standing on the park page. It matters the
   * moment we navigate them to their cart, because BOTH consumers of this file run again
   * there — the extension matches `www.reservecalifornia.com/*`, and the webview
   * re-injects the whole bundle on every `loadstop` — and a second `submit` on a site we
   * already hold comes back "cart is already added", which is a REJECTION. Without this
   * marker, landing in the cart would overwrite a true success with a failure message: the
   * exact bug the `carting || carted` guard was written for, arriving through the one door
   * it cannot close.
   */
  const DONE = 'camphawk_rc_done';
  /**
   * How long to let the proof out before the context dies.
   *
   * `#camphawk-rc-status` is what `lib/rc-precart-script`'s epilogue observes, and
   * `✓ Added to cart` reaching `client_reports` is the evidence the two cart POSTs fired —
   * the thing two synthetic holds were run to establish on 2026-08-13. The observer is a
   * MutationObserver, so its callback is a microtask, and a navigation started in the same
   * turn is a race against it that nobody would ever see us lose.
   *
   * So: set the status, let it out, THEN go. Half a second is imperceptible to somebody who
   * has just been told their site is in the cart, and it is spent AFTER the cart exists —
   * the ~2.5s exposure window this design protects closed when `submit` returned.
   */
  const CART_NAV_DELAY_MS = 500;
  // RC does precart in TWO steps and the real UI always does both: `load` returns the
  // facility's rules (including the "extras" it will demand back) and takes the unit
  // lock; `submit` places it in the cart. Calling only `submit` is why an add could come
  // back 200-but-IsSuccess:false complaining about a field we never had the chance to see.
  const LOAD_ENDPOINT = 'https://rdapi.reservecalifornia.com/api/webaccessfacility/load/precartdataforbookingmodify';
  const ENDPOINT = 'https://rdapi.reservecalifornia.com/api/webaccessfacility/submit/precartdataforbookingmodify';
  // RC'S OWN "no cart yet" SENTINEL — the same constant the bot sends
  // (scripts/auto-cart-bot/rc-cart.mjs, NO_CART). An EMPTY string is not equivalent: it
  // fails .NET model validation with a ValidationProblemDetails on `shoppingCartKey`,
  // which is what the probe's first --cart run hit and read as a CAPTCHA.
  const NO_CART = '00000000-0000-0000-0000-000000000000';

  // -------------------------------------------------------------------------
  // ADOPT-CART PATH (2026-08-05). The one below builds a cart in the user's own
  // browser from the raw booking details. This one is different and much simpler:
  // the CampHawk BOT already created the cart server-side the instant the site
  // opened, and the alert just carries that cart's key. We hand the browser the
  // key and let RC show the held cart.
  //
  // ⚠️ TESTED 2026-08-05: this ADOPTS a cart only within the SAME session that created
  // it. Writing a cart key made by a DIFFERENT session (e.g. the mini-PC bot) does NOT
  // surface here — a fresh incognito window on the same PC, same RC account, showed an
  // empty cart. The RC cart is bound to the originating session (Okta token + AWSALBAPP
  // stickiness cookies), not to the key. So this path does NOT achieve the bot→user
  // hand-off it was built for; it only helps when THIS browser's own session made the
  // cart. Kept for that narrow case and as the anchor for any future session-clone work;
  // see scripts/auto-cart-bot/reservecalifornia.mjs for the full finding.
  //
  // Reading of RC's bundle (still accurate, just not sufficient): the cart is anonymous
  // (CustomerId 0), keyed by a shoppingCartKey GUID, and the web app's source of truth
  // for "which cart am I" is localStorage["shoppingCartKey"] — nothing reads it from the
  // URL, which is why ?shoppingCartKey= did nothing.
  const ADOPTED_FLAG = 'camphawk_rc_adopted';
  const adopt = location.hash.match(/camphawk-rccart=([0-9a-fA-F-]{30,})/);
  if (adopt) {
    try { localStorage.setItem('shoppingCartKey', adopt[1]); } catch {}
    // Strip the key from the URL bar (it authorises the cart) and mark that we
    // just adopted, so the post-reload run shows a confirmation instead of looping.
    try { sessionStorage.setItem(ADOPTED_FLAG, '1'); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
    return;
  }
  if (sessionStorage.getItem(ADOPTED_FLAG)) {
    try { sessionStorage.removeItem(ADOPTED_FLAG); } catch {}
    adoptBanner();
    return;
  }

  function readFragment() {
    const m = location.hash.match(/camphawk-rc=(\d+)_(\d{4}-\d{2}-\d{2})_(\d+)_(\d*)/);
    if (!m) return null;
    const data = { unitId: +m[1], arrivalDate: m[2], nights: +m[3], sleepingUnitId: m[4] ? +m[4] : null };
    try { sessionStorage.setItem(STASH, JSON.stringify(data)); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return data;
  }
  function stashed() { try { return JSON.parse(sessionStorage.getItem(STASH) || 'null'); } catch { return null; } }

  /**
   * Are we standing on RC's own cart page?
   *
   * Matched on the PATH, because that is what survives: `CART_URL` is capitalised exactly as
   * RC serves it, and RC has been observed serving its own links in other casings. The two
   * callers want opposite things from the answer — one must not navigate to where it already
   * is, the other must not offer a button to the page under the user's thumb.
   */
  function onCartPage() {
    try { return /\/customers\/shoppingcart/i.test(location.pathname); } catch { return false; }
  }
  function alreadyCarted() { try { return !!sessionStorage.getItem(DONE); } catch { return false; } }
  function rememberCarted(key) {
    try { sessionStorage.setItem(DONE, JSON.stringify({ cartKey: key || '', at: Date.now() })); } catch {}
  }
  /**
   * Take them to the cart, rather than telling them where it is.
   *
   * The status line used to end "tap the cart icon at the top of this page to check out" —
   * an instruction to go and navigate a page we had just put them on, at the one moment
   * they are least inclined to read carefully. Reported by the owner on 2026-08-23 after a
   * hold that otherwise worked perfectly.
   *
   * `location.assign` and not `replace`: the park page is where they came from and Back
   * should still take them there.
   */
  function goToCart() {
    if (onCartPage()) return;
    setTimeout(() => { try { location.assign(CART_URL); } catch {} }, CART_NAV_DELAY_MS);
  }

  const job = readFragment() || stashed();
  if (!job) return;

  const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

  // The page-world grabber (rc-inject.js) posts the live token here. RC's token
  // is Okta-encrypted in localStorage, so this capture is the only way to read it.
  // The cart key is CAPTURED but never WAITED ON. Nothing blocks on it any more: a session
  // with no cart gets one from RC's own `load` (see addToCart), so a key caught off RC's
  // traffic is now a preference, not a precondition.
  let capturedToken = null, capturedCartKey = null;
  /** Set when we gave up waiting for a token and asked the user to sign in. See addToCart. */
  let awaitingSignIn = false;
  const tokenWaiters = [];
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__camphawk_token) {
      capturedToken = e.data.__camphawk_token;
      tokenWaiters.splice(0).forEach((fn) => fn(capturedToken));
      // SIGNING IN IS THE BUTTON PRESS. RC's app broadcasts this token on its first
      // authenticated call, so it arrives within a second of the sign-in completing — long
      // before anybody could read a banner and find a control. Retrying here turns "sign in,
      // then come back and tap Add to cart" into "sign in", which is the whole of note 4.
      if (awaitingSignIn) { awaitingSignIn = false; addToCart(); }
    }
    if (e.data.__camphawk_cartkey) capturedCartKey = e.data.__camphawk_cartkey;
  });
  function waitFor(getVal, waiters, timeoutMs) {
    const v = getVal();
    if (v) return Promise.resolve(v);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      waiters.push((val) => { clearTimeout(t); resolve(val); });
    });
  }
  const getToken = (ms = 12000) => waitFor(() => capturedToken, tokenWaiters, ms);

  function occupantName() {
    const direct = ls('customerName') || ls('ssoCustomerName');
    if (direct) return direct;
    try {
      const d = JSON.parse(ls('customerDetail') || '{}');
      return [d.FirstName, d.LastName].filter(Boolean).join(' ') || d.Name || '';
    } catch { return ''; }
  }

  // .NET serialises collections as {"$type":…,"$values":[…]}, so Array.isArray() on one
  // is always false. Unwrap before touching any RC list.
  const unwrap = (v) => (Array.isArray(v) ? v : Array.isArray(v && v.$values) ? v.$values : []);

  /**
   * Answer the facility's required "extras", the way RC's own bundle does.
   *
   * Transcribed from assets/FacilityPreCart-*.js — the initializer walks
   * `UnitDetail.Extras.$values`, keeps the `IsWebViewable` ones, derives a value, and the
   * submit maps them to `{extraId, extraValue}`. Two details are load-bearing:
   *   • the keys are lowerCamel — `extraId`/`extraValue`. PascalCase is silently ignored,
   *     so the same "field is required" error comes back and looks like a wrong VALUE
   *     when it is really a wrong KEY.
   *   • ExtraType 0 is CheckBox (assets/extraTypes-*.js) and its tick handler sends the
   *     STRING "true". `DefaultValue: "Unchecked"` is the starting state, not the wire
   *     value — a required checkbox has to end up "true" or RC's validator refuses it.
   * scripts/rc-cart-canary.mts re-asserts both against the live bundle daily.
   */
  const EXTRA_CHECKBOX = 0, EXTRA_CHOICE = 4;
  function buildExtraValues(loadResult) {
    const extras = unwrap(loadResult && loadResult.UnitDetail && loadResult.UnitDetail.Extras);
    return extras.filter((e) => e.IsWebViewable).map((e) => {
      let value;
      if (e.ExtraType === EXTRA_CHECKBOX) {
        value = e.IsWebRequired || String(e.Value) === 'true' ||
          String(e.DefaultValue || '').toLowerCase() === 'checked' ? 'true' : 'false';
      } else {
        value = e.Value ? e.Value : e.DefaultValue;
        if (e.ExtraType === EXTRA_CHOICE && !value) value = '-- None --';
      }
      return { extraId: e.ExtraId, extraValue: value == null ? '' : value };
    });
  }

  let _cartKey = '';
  let _extraValues = [];
  function buildPayload() {
    return {
      arrivalDate: job.arrivalDate,
      nights: job.nights,
      confirmation_number: null,
      reservationId: 0,
      unitId: job.unitId,
      IsReservationDrawing: false,
      accessTypeId: 0,
      accountPassNumber: null,
      adults: 1,
      allowSpecialBenefits: false,
      children: 0,
      customerClassificationId: 1,
      discountPromoCode: null,
      dynamicOccupancyByNight: {},
      extraValues: _extraValues,
      fdUsageClassificationId: 1,
      fdUsageClassificationName: 'Regular',
      isCheckIn: false,
      isDiscount: false,
      isModifyPreCart: false,
      isOrganization: false,
      occupantName: occupantName(),
      occupantPhoneNumber: null,
      optionalAuthorizedPerson: null,
      padLength: '0',
      preCartReservationComments: null,
      precartComments: null,
      prevSelectedClassification: null,
      promoCode: null,
      reservationVehicles: [],
      selectedClassification: null,
      shoppingCartKey: _cartKey,
      sleepingUnit: job.sleepingUnitId
        ? { isWheeled: false, name: '', sleepingUnitTypeID: job.sleepingUnitId }
        : null,
      timeDuration: null,
      unitPriceType: 1,
      vehicleCount: 0,
      vehicleLength: '0',
      vehiclePlates: null,
      vehicleTypeIds: null,
      vehicles: [],
    };
  }

  // ONE ATTEMPT AT A TIME, AND NEVER A SECOND AFTER A GOOD ONE.
  //
  // The banner used to leave a live "Add to cart" button sitting beside "✓ Added to cart",
  // which is what the owner saw on the 2026-08-13 hand-off. Hiding the button is most of
  // the fix, but the guard belongs here too: `addToCart` is also reached from the auto-retry
  // below and from a re-injection on RC's next SPA navigation, neither of which involves a
  // button. A second submit on a site we already hold comes back "cart is already added",
  // which is a REJECTION — so it would overwrite a true success with a failure message.
  let carting = false, carted = false;

  async function addToCart() {
    if (carting || carted) return;
    carting = true;
    try { await runAddToCart(); } finally { carting = false; }
  }

  async function runAddToCart() {
    setState('working');
    setStatus('Reading your session…');
    // ONLY THE TOKEN IS A PRECONDITION. A cart key is not — see below.
    const token = await getToken();
    if (!token) {
      // THE USER'S JOB HERE IS TO SIGN IN, so say that and nothing else (owner note 4).
      // This used to read "Couldn't read your RC login — sign in, then click Add to cart"
      // in small grey type beside a large orange Add-to-cart button, i.e. the loudest thing
      // on screen was the one action that cannot possibly work yet.
      //
      // There is no button in this state at all. `rc-inject.js` broadcasts the access token
      // the moment RC's app makes its first authenticated call, so signing in is itself the
      // trigger — see the waiter below. Making somebody find and press a button after that
      // spends the exposure window on a tap we can do for them.
      awaitingSignIn = true;
      setState('signin');
      setStatus('Sign in above, and we’ll add it the moment you’re through.');
      return;
    }

    // WHERE THE CART KEY COMES FROM — and why not having one is no longer a dead end.
    //
    // This used to REFUSE without a key caught off RC's own traffic, telling the user to
    // "click the 🛒 cart icon once (to start your cart)". A fresh session never has one, so
    // on 2026-08-13 a real hold produced a full client_reports trace with no `load`, no
    // `submit` and no error — the two cart POSTs were not failing, they were never tried,
    // and the user spent the ~2.5s hand-off window tapping Add to cart by hand.
    //
    // THE BOT HAS NEVER HAD A CART KEY EITHER. `rc-hold-runner` passes `existing || NO_CART`
    // and `precartInPage` adopts whatever `load` hands back — "that is how a fresh session is
    // supposed to acquire one". So the step this refused to reach IS the step that mints the
    // key. Same contract, same order, now on both sides.
    //
    // The "a minted one creates a phantom cart" warning this replaces was about a
    // CLIENT-INVENTED GUID, which is a different thing: nothing on RC's side ever heard of
    // it. NO_CART is RC's own sentinel for "I have no cart", answered with a real key that we
    // then adopt — including into localStorage, below, which is the app's sole source of
    // truth for which cart it is showing.
    //
    // NO WAITING. localStorage is that source of truth and reading it is synchronous; the
    // 5-second wait for a broadcast was affordable only while it gated the whole attempt.
    // At 08:00:00 five seconds is twice the entire exposure window.
    _cartKey = capturedCartKey || ls('shoppingCartKey') || NO_CART;
    setStatus('Adding to your cart…');
    // RC's rdApi wants the same token in BOTH accesstoken and authorization, plus two
    // constant headers (installationsidentity=cali, storeid=111).
    const rcHeaders = {
      'Content-Type': 'application/json',
      accesstoken: token,
      authorization: 'Bearer ' + token,
      installationsidentity: 'cali',
      storeid: '111',
    };
    try {
      // Step 1 — load. Gives us the facility's required extras and takes the unit lock.
      // Non-fatal: if it fails we still try the submit with no extras, which is strictly
      // no worse than what this did before.
      try {
        const lr = await fetch(LOAD_ENDPOINT, {
          method: 'POST', credentials: 'include', headers: rcHeaders,
          body: JSON.stringify(buildPayload()),
        });
        const lj = JSON.parse(await lr.text());
        const lres = lj && lj.Result ? lj.Result : lj;
        _extraValues = buildExtraValues(lres);
        // ADOPT THE KEY `load` HANDS BACK. This is the line that makes a session with no
        // cart able to cart at all, and it is the bot's own behaviour verbatim. Read
        // BEFORE the submit, which is the call that needs it.
        if (lres && lres.ShoppingCartKey) _cartKey = lres.ShoppingCartKey;
        // Reported through the status channel as a fact, never the key itself — a cart key
        // authorises the cart and travels no further than this page.
        console.log('[CampHawk RC] precart load ok — cart key ' +
          (_cartKey === NO_CART ? 'STILL MISSING (RC returned none)' : 'in hand'));
      } catch (e) {
        console.log('[CampHawk RC] precart load failed, submitting without extras:', e);
      }

      // Step 2 — submit.
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: rcHeaders,
        body: JSON.stringify(buildPayload()),
      });
      // READ THE BODY ONCE. It used to be `res.clone().text()` on the success path and
      // `res.text()` on the failure path, which is two ways to consume one stream and one
      // more thing to get wrong now that the success path also needs a field out of it.
      const raw = await res.text();
      let result = null;
      try { const j = JSON.parse(raw); result = j && j.Result ? j.Result : j; } catch { /* HTML error page */ }
      // RC ANSWERS HTTP 200 WITH IsSuccess:false. Judging by status code reports a failed
      // cart as a success — the same trap as "an empty grid means fully booked". The one
      // promise auto-cart makes is that "it's in your cart" is true, so read the payload.
      let ok = res.ok;
      let apiError = '';
      if (ok && result && result.IsSuccess === false) {
        ok = false;
        apiError = result.ErrorMessage || 'RC declined';
      }
      if (ok) {
        // ADOPT THE CART WE JUST MADE, or RC's own page shows EMPTY and a working cart
        // reads as a failure. The submit happened over HTTP and the SPA never heard about
        // it: `localStorage["shoppingCartKey"]` is still whatever it was — on a session
        // that started with none, still nothing. This is the same write the bot does at
        // the end of `precartInPage`, and it is only correct because it is the SAME
        // session that made the cart (cross-session adoption was tested and fails).
        const newKey = (result && result.ShoppingCartKey) || (_cartKey === NO_CART ? '' : _cartKey);
        if (newKey) { try { localStorage.setItem('shoppingCartKey', newKey); } catch {} }
        carted = true;
        // BEFORE THE NAVIGATION, AND BEFORE ANYTHING ELSE THAT CAN THROW. This is what stops
        // the re-injection on the cart page from submitting a second time — see DONE.
        rememberCarted(newKey);
        setState('carted');
        // `✓ Added to cart` STAYS AS THE LEADING TOKEN. `client_reports` is read for it,
        // `ClaimFlow` matches on it to offer checkout, and `rc-holds-readout` calls it "the
        // one that proves the RC cart POSTs work on mobile". The tail after it is ours to
        // change; that phrase is not.
        //
        // The tail used to be "tap the cart icon at the top of this page to check out",
        // which was already an improvement on naming a place instead of a control — and it
        // is still an instruction to go and navigate. We know the cart exists, so we can
        // take them to it. Owner, 2026-08-23.
        // "THIS IS YOUR CART" WAS A CLAIM ABOUT THE PAGE, AND IT WAS FALSE ONCE.
        // 2026-08-29, Android: RC held the reservation (its own inventory dropped, and the
        // unit vanished from the bookable list) while the cart UI asked a SIGNED-IN user to
        // log in — the account menu offered "Log out" in the same breath. So the cart can be
        // real and unreachable, and asserting otherwise leaves somebody staring at an empty
        // page being told to check out. Say what is true — the site is held — and give the
        // one remedy that costs nothing.
        setStatus(onCartPage()
          ? '✓ Added to cart — check the dates and check out. If this page looks empty, reload it: the site is held.'
          : '✓ Added to cart — opening your cart…');
        // LAST, so a status the report channel needs is already written and every line above
        // has run. Delayed — see CART_NAV_DELAY_MS.
        goToCart();
      } else {
        let detail = apiError;
        console.log('[CampHawk RC] full error body:', raw);
        if (!detail) {
          try {
            const j = JSON.parse(raw);
            detail = j.errors ? Object.keys(j.errors).join(', ') : (j.title || raw.slice(0, 160));
          } catch { detail = raw.slice(0, 160); }
        }
        setState('failed');
        setStatus(`RC declined (${res.status}) — ${(detail || 'see console').replace(/<br\/?>/g, ' ')}`);
      }
    } catch (e) {
      setState('failed');
      setStatus('Couldn’t reach RC — book manually.');
    }
  }

  // --- banner ----------------------------------------------------------------
  //
  // THREE STATES, AND THEY MUST NOT BLUR (reported from two real iOS hand-offs,
  // 2026-08-13). This bar showed "✓ Added to cart" next to a still-live orange "Add to
  // cart" button, sitting over RC's own Sub Total row — so the moment it succeeded it
  // invited a second tap, and a second submit on a held site comes back "cart is already
  // added", i.e. a rejection printed over a success. Before that, when there was no session
  // yet, the loudest control on screen was the one action that could not possibly work.
  //
  //   signin  → the user must sign in. NO button: the token broadcast does the retry.
  //   working → we are mid-POST. No control at all; nothing to press and nothing to undo.
  //   carted  → done. The only control is the way to checkout.
  //
  // RESTRAINED ON PURPOSE. This is injected into ReserveCalifornia's own page, so heavy
  // chrome reads as an ad or a phishing overlay, and it renders inside the ~2.5s exposure
  // window where a thrown exception costs a campsite. Bigger type and one control at a
  // time, not a redesign.
  const CART_URL = 'https://www.reservecalifornia.com/Customers/ShoppingCart';
  const BAR_CSS =
    'position:fixed;z-index:2147483647;left:50%;bottom:20px;transform:translateX(-50%);' +
    'background:#1F3D2E;color:#FAF7F2;font:14px system-ui,sans-serif;padding:12px 16px;border-radius:14px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.28);display:flex;align-items:center;gap:12px;max-width:92vw';
  const ACTION_CSS =
    'background:#E8873A;color:#fff;border:0;border-radius:10px;padding:9px 13px;font:600 14px system-ui,sans-serif;' +
    'cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-block';

  let statusEl, headlineEl, actionEl, subEl;

  /**
   * RC's own sign-in control, or null.
   *
   * Matched on the ACCESSIBLE NAME rather than a class or a path: RC ships a new bundle
   * whenever it likes and its class names are generated, but the words a user reads to log
   * in are the stable part. Anchors and buttons only — clicking a random <div> whose text
   * happens to say "sign in" is how an injected script starts pressing things nobody meant.
   *
   * Deliberately narrow. Returning null is a fine outcome; the caller says so and stops.
   */
  function findSignIn() {
    const wants = /^(log ?in|sign ?in|login|signin)$/i;
    for (const el of document.querySelectorAll('a,button')) {
      const t = (el.textContent || '').trim();
      if (t && wants.test(t) && el.offsetParent !== null) return el;
    }
    // Second pass: some builds label it only for screen readers.
    for (const el of document.querySelectorAll('a[aria-label],button[aria-label]')) {
      if (wants.test((el.getAttribute('aria-label') || '').trim())) return el;
    }
    return null;
  }

  /**
   * Put the top of RC's page on screen.
   *
   * RC restores a scroll position and lands the user down at the availability calendar, with
   * its own sign-in control off screen above them — so "Sign in to ReserveCalifornia" was an
   * instruction pointing at something they could not see. Reported from a real hand-off.
   *
   * Only ever called for the sign-in state. Scrolling the page under somebody who is mid-cart
   * would be its own bug, and this is the one moment where what they need is definitely at
   * the top.
   */
  function scrollToTop() {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { try { window.scrollTo(0, 0); } catch {} }
  }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  /**
   * Which of the three (plus two ordinary ones) the bar is in.
   *
   * The STATUS LINE is untouched by this — `#camphawk-rc-status` still carries whatever
   * `setStatus` wrote, verbatim, because `lib/rc-precart-script`'s epilogue observes that
   * element and forwards it as the hand-off's verdict. The diagnostic and the user's own
   * screen must never be able to disagree, so this changes the frame around the sentence
   * and never the sentence.
   */
  function setState(name) {
    if (!headlineEl || !actionEl) return;
    const big = name === 'signin';
    // WHEN IT IS DONE, SAY ONE THING. Reported from a real hand-off: the finished banner
    // carried an eagle, a headline, "CA State Parks - <date> (1 night)", a status sentence
    // AND a button — four lines to say "it worked", stacked over RC's own checkout controls.
    // The headline already says it, so `carted` drops the subtitle and the status line and
    // keeps the one thing left to do.
    //
    // The status ELEMENT stays in the DOM and `setStatus` keeps writing to it. It is hidden,
    // never removed: `lib/rc-precart-script`'s epilogue reads `#camphawk-rc-status` to
    // report the hand-off's verdict, so removing it would blind the diagnostic at the exact
    // moment it has something worth saying.
    // The instruction is useless if its target is off screen — see scrollToTop.
    if (name === 'signin') scrollToTop();
    const done = name === 'carted';
    if (subEl) subEl.style.display = done ? 'none' : '';
    if (statusEl) statusEl.style.display = done ? 'none' : '';
    headlineEl.textContent =
      name === 'signin' ? 'Sign in to ReserveCalifornia' :
      name === 'working' ? 'Adding your site…' :
      name === 'carted' ? '✓ It’s in your cart' :
      name === 'failed' ? 'We couldn’t add it' :
      'CampHawk';
    headlineEl.style.fontSize = big ? '17px' : '14px';
    actionEl.textContent = '';
    if (name === 'carted') {
      // NO CONTROL WHEN THEY ARE ALREADY LOOKING AT IT. An "Open cart" button on the cart
      // page is the same class of mistake as telling an app user to "switch to your
      // ReserveCalifornia tab" — it names an action that has already happened, which reads
      // as a step still outstanding.
      if (onCartPage()) return;
      const a = document.createElement('a');
      a.textContent = 'Open cart';
      a.href = CART_URL;
      a.style.cssText = ACTION_CSS;
      actionEl.appendChild(a);
    } else if (name === 'signin') {
      // A WAY TO THE LOGIN FORM — not a retry of the cart.
      //
      // This state deliberately had no control, on the reasoning that signing in is itself
      // the trigger (rc-inject.js broadcasts the token on RC's first authenticated call), so
      // a button would only duplicate an automatic retry. That reasoning holds for the CART
      // and misses what the user actually needs, reported from a real hand-off: RC lands
      // them scrolled down its own page with the sign-in control off screen, so the thing
      // they are being told to do has no visible affordance at all.
      //
      // So this button does not touch the cart. It finds RC's own sign-in control and
      // presses it, which is exactly what the user would do if they could see it.
      const b = document.createElement('button');
      b.textContent = 'Log in';
      b.style.cssText = ACTION_CSS;
      b.onclick = () => {
        const el = findSignIn();
        // NEVER NAVIGATE ON A GUESS. A hardcoded sign-in URL is a URL nothing keeps honest,
        // and RC drives its own OIDC redirect from JS — so if the control is not found, say
        // so and leave the page alone rather than sending them somewhere invented.
        if (el) { el.click(); setStatus('Opening the sign-in form…'); }
        else setStatus('Use the menu at the top right to log in, then come back.');
      };
      actionEl.appendChild(b);
    } else if (name === 'idle' || name === 'failed') {
      // The manual escape hatch, and the only two states it belongs in. Never in `signin`
      // (it cannot work), never in `working` (it would double-submit), never in `carted`
      // (that is the bug this rewrite is for).
      const b = document.createElement('button');
      b.textContent = name === 'failed' ? 'Try again' : 'Add to cart';
      b.style.cssText = ACTION_CSS;
      b.onclick = () => { carted = false; addToCart(); };
      actionEl.appendChild(b);
    }
  }

  function banner() {
    const bar = document.createElement('div');
    bar.style.cssText = BAR_CSS;
    bar.innerHTML =
      '<span style="font-size:18px">🦅</span>' +
      '<span style="min-width:0">' +
      '<span id="camphawk-rc-head" style="font-weight:700;display:block;line-height:1.25"></span>' +
      `<span id="camphawk-rc-sub" style="opacity:.7;font-size:12px">CA State Parks · ${job.arrivalDate} (${job.nights} night${job.nights > 1 ? 's' : ''})</span><br>` +
      '<span id="camphawk-rc-status" style="opacity:.85"></span></span>' +
      '<span id="camphawk-rc-action"></span>';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:transparent;color:#FAF7F2;border:0;font-size:16px;cursor:pointer;opacity:.7';
    close.onclick = () => { try { sessionStorage.removeItem(STASH); } catch {} bar.remove(); };
    bar.appendChild(close);
    document.body.appendChild(bar);
    statusEl = bar.querySelector('#camphawk-rc-status');
    headlineEl = bar.querySelector('#camphawk-rc-head');
    actionEl = bar.querySelector('#camphawk-rc-action');
    subEl = bar.querySelector('#camphawk-rc-sub');
    setState('idle');
  }
  banner();

  // A CART WE ALREADY MADE IS NOT A CART TO MAKE AGAIN.
  //
  // Reached on the cart page we navigate to, and on any other reload of this session. It is
  // ABOVE the consent read on purpose: `chrome.storage.local.get` is async, so leaving this
  // to the `carted` guard inside `addToCart` would work today and depends on a callback
  // ordering nothing states. Deciding here means the re-submit is impossible rather than
  // merely prevented.
  if (alreadyCarted()) {
    carted = true;
    setState('carted');
    // Same correction as the one at the submit — see the comment there. Both sites said
    // "this is your cart"; fixing one would leave the other telling the old story on every
    // reload, which is the shape that keeps a corrected finding alive in this repo.
    setStatus(onCartPage()
      ? '✓ Added to cart — check the dates and check out. If this page looks empty, reload it: the site is held.'
      : '✓ Added to cart — open your cart to check out.');
  } else {
    chrome.storage.local.get({ accepted: false, enabled: false }, ({ accepted, enabled }) => {
      if (accepted && enabled) addToCart();
      else setStatus('Auto-cart off — use the button, or enable it in the CampHawk extension.');
    });
  }

  // Shown after we've adopted the bot's cart key and reloaded. RC has loaded the
  // held cart by now; this just points the user at it. No API calls, no auth — the
  // cart is already theirs to check out.
  function adoptBanner() {
    const cartUrl = 'https://www.reservecalifornia.com/Customers/ShoppingCart';
    const bar = document.createElement('div');
    bar.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;bottom:20px;transform:translateX(-50%);' +
      'background:#1F3D2E;color:#FAF7F2;font:14px system-ui,sans-serif;padding:12px 16px;border-radius:14px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.28);display:flex;align-items:center;gap:12px;max-width:92vw';
    bar.innerHTML =
      '<span style="font-size:18px">🦅</span>' +
      '<span><strong>CampHawk</strong> held your site — it’s in your cart.<br>' +
      '<span style="opacity:.85">Review the dates and check out before the hold expires.</span></span>';
    const btn = document.createElement('a');
    btn.textContent = 'Open cart';
    btn.href = cartUrl;
    btn.style.cssText = 'background:#E8873A;color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer;white-space:nowrap;text-decoration:none';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:transparent;color:#FAF7F2;border:0;font-size:16px;cursor:pointer;opacity:.7';
    close.onclick = () => bar.remove();
    bar.appendChild(btn); bar.appendChild(close);
    document.body.appendChild(bar);
  }
})();
