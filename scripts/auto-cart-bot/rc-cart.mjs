// RC precart, shared by the probe and the production hold runner.
//
// Extracted so there is exactly ONE copy of the payload contract. It took five rounds
// of guessing to learn that RC wants `{extraId, extraValue}` in lowerCamel and that a
// required checkbox answers with the string "true" (see docs/CONTEXT.md → "The precart
// extraValues contract"). A second copy of that would drift, and the failure mode is
// silent: HTTP 200 with IsSuccess:false, which reads as a wrong value rather than a
// wrong shape.

export const PRECART_LOAD =
  'https://rdapi.reservecalifornia.com/api/webaccessfacility/load/precartdataforbookingmodify';
export const PRECART_SUBMIT =
  'https://rdapi.reservecalifornia.com/api/webaccessfacility/submit/precartdataforbookingmodify';
export const CART_LOAD =
  'https://rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart';
export const CART_REMOVE_ENTRY =
  'https://rdapi.reservecalifornia.com/api/webaccesscustomer/remove/cartentry';
/** RC's own sentinel for "no cart yet". An empty string fails validation. */
export const NO_CART = '00000000-0000-0000-0000-000000000000';

export async function precartInPage(page, { unitId, arrival, nights, cartKey }) {
return page.evaluate(
  async ({ loadUrl, submitUrl, unitId, arrival, nights, cartKey, NO_CART }) => {
    const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    const token = ls('ssoAccessToken') || ls('accessToken');
    let occupant = ls('customerName') || ls('ssoCustomerName') || '';
    if (!occupant) {
      try { const c = JSON.parse(ls('customerDetail') || '{}'); occupant = [c.FirstName, c.LastName].filter(Boolean).join(' '); } catch {}
    }
    const body = {
      arrivalDate: arrival, nights, confirmation_number: null, reservationId: 0,
      unitId, IsReservationDrawing: false, accessTypeId: 0, accountPassNumber: null,
      adults: 1, allowSpecialBenefits: false, children: 0, customerClassificationId: 1,
      discountPromoCode: null, dynamicOccupancyByNight: {}, extraValues: [],
      fdUsageClassificationId: 1, fdUsageClassificationName: 'Regular', isCheckIn: false,
      isDiscount: false, isModifyPreCart: false, isOrganization: false,
      occupantName: occupant, occupantPhoneNumber: null, optionalAuthorizedPerson: null,
      padLength: '0', preCartReservationComments: null, precartComments: null,
      prevSelectedClassification: null, promoCode: null, reservationVehicles: [],
      selectedClassification: null, shoppingCartKey: cartKey || NO_CART,
      sleepingUnit: null, timeDuration: null, unitPriceType: 1, vehicleCount: 0,
      vehicleLength: '0', vehiclePlates: null, vehicleTypeIds: null, vehicles: [],
    };
    const headers = {
      'Content-Type': 'application/json', accesstoken: token,
      authorization: 'Bearer ' + token, installationsidentity: 'cali', storeid: '111',
    };
    // NEVER let a network rejection throw out of here. A browser `fetch` that
    // rejects with "Failed to fetch" has NOT told us the request failed to
    // arrive — CORS forbids reading a response the browser did receive, so a WAF
    // 403 and an unreachable host are the same exception. Throwing killed the
    // whole probe and reported the one thing we can be sure isn't the answer.
    // Record it and let the Node-side replay (outside CORS) get the real status.
    const call = async (url) => {
      try {
        const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
        const raw = await res.text();
        return { status: res.status, ok: res.ok, raw };
      } catch (e) {
        return { status: 0, ok: false, raw: '', netError: String((e && e.message) || e) };
      }
    };
    // RC ANSWERS HTTP 200 WITH IsSuccess:false. Judging by status code reports a
    // failed cart as a success — the same "a 200 is not success" trap as
    // empty-grid-means-booked. Always read the payload.
    const verdict = (r) => {
      try {
        const j = JSON.parse(r.raw);
        const res = j?.Result ?? j;
        return { isSuccess: res?.IsSuccess === true, error: res?.ErrorMessage || '', cartKey: res?.ShoppingCartKey || '' };
      } catch { return { isSuccess: false, error: '(unparseable body)', cartKey: '' }; }
    };

    const loaded = await call(loadUrl);
    let loadRes = null;
    try { const j = JSON.parse(loaded.raw); loadRes = j?.Result ?? j; } catch {}
    // If `load` handed back a cart key, use it — that is how a fresh session is
    // supposed to acquire one.
    if (loadRes?.ShoppingCartKey) body.shoppingCartKey = loadRes.ShoppingCartKey;

    // THE EXTRAS — no longer guessed. RC's own web bundle was read
    // (assets/FacilityPreCart-*.js), and it settles both halves of the question:
    //
    //   xs = (s) => { ... a.UnitDetail.Extras.$values.forEach((n) => {
    //          if (n.IsWebViewable) { let r = {...n};
    //            r.value = r.ExtraType === ke.CheckBox
    //              ? (r.Value ? r.Value.toString() === "true"
    //                         : !!(r.DefaultValue?.toLowerCase() === "checked"))
    //              : (r.Value ? r.Value : r.DefaultValue);
    //            if (r.ExtraType === ke.Choice && !r.value) r.value = "-- None --";
    //   ... and on submit:
    //     l.extraValues.forEach(h => u.extraValues.push({
    //       extraId: h.ExtraId, extraValue: h.value }))
    //
    // TWO facts, and the first is why five rounds of guessing all failed:
    //  1. THE KEYS ARE lowerCamel — `extraId` / `extraValue`. Every earlier attempt
    //     sent `ExtraId` + `Value`, which the API ignores, so the answer never
    //     landed and the SAME "required field" error came back each time. The
    //     error was honest; our key names were wrong.
    //  2. ExtraType 0 = CheckBox (assets/extraTypes-*.js), and the tick handler is
    //     `u(e.ExtraId, checked ? "true" : "false")` — a checkbox answers with the
    //     STRING "true", not "Checked". DefaultValue "Unchecked" describes the
    //     starting state, not the wire value.
    // Source of truth: RC's shipped code, re-asserted by scripts/rc-cart-canary.mts.
    const extras = [];
    const paths = [];
    const seen = new Set();
    (function walk(node, at) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      const arr = Array.isArray(node) ? node : Array.isArray(node.$values) ? node.$values : null;
      if (arr) {
        for (const item of arr) {
          if (item && typeof item === 'object' && 'ExtraId' in item) {
            extras.push(item);
            paths.push(at);
          }
          walk(item, at);
        }
        return;
      }
      for (const [kk, vv] of Object.entries(node)) {
        if (kk === '$type' || kk === '$id') continue;
        walk(vv, at ? `${at}.${kk}` : kk);
      }
    })(loadRes, '');

    // RC's own value derivation, transcribed. Only IsWebViewable extras are sent,
    // and every one of them is — not just the required ones, because that is what
    // the UI does and a missing optional extra is a difference we'd rather not have.
    const CHECKBOX = 0, CHOICE = 4;
    const rcValue = (e) => {
      if (e.ExtraType === CHECKBOX) {
        // A REQUIRED checkbox must end up ticked or RC's own validator rejects it
        // (`IsWebRequired && !value` → "…is required"). An optional one keeps its
        // default. This is the human ticking the box, which is the only way the
        // real UI ever gets past this screen.
        if (e.IsWebRequired) return 'true';
        return String(e.Value ?? '').toString() === 'true' ||
          String(e.DefaultValue ?? '').toLowerCase() === 'checked' ? 'true' : 'false';
      }
      const v = e.Value ? e.Value : e.DefaultValue;
      if (e.ExtraType === CHOICE && !v) return '-- None --';
      return v ?? '';
    };
    const viewable = extras.filter((e) => e.IsWebViewable !== false);
    const needed = extras.filter((e) => e.IsWebRequired || e.Required || e.IsCRSRequired);

    const attempts = [];
    if (viewable.length) {
      body.extraValues = viewable.map((e) => ({ extraId: e.ExtraId, extraValue: rcValue(e) }));
    }
    let submitted = await call(submitUrl);
    attempts.push({
      shape: viewable.length
        ? `RC's own shape: ${JSON.stringify(body.extraValues).slice(0, 200)}`
        : 'extraValues: [] (no viewable extras declared)',
      v: verdict(submitted),
    });

    // ONE fallback, and only one: the initializer reads a checkbox's stored answer
    // as a real boolean, so a server that type-checks might want `true` rather than
    // "true". Trying both is cheap; trying twelve was the mistake.
    if (!verdict(submitted).isSuccess && viewable.length) {
      body.extraValues = viewable.map((e) => {
        const v = rcValue(e);
        return { extraId: e.ExtraId, extraValue: e.ExtraType === CHECKBOX ? v === 'true' : v };
      });
      const r = await call(submitUrl);
      attempts.push({ shape: 'same, checkbox as a real boolean', v: verdict(r) });
      if (verdict(r).isSuccess) submitted = r;
    }

    // ADOPT THE CART WE JUST MADE. The submit happens over HTTP and the page never
    // hears about it — `localStorage["shoppingCartKey"]` is still whatever it was
    // (empty, on a fresh session), so the RC cart page shows EMPTY and the run
    // looks like a failure it isn't. The app's sole source of truth is this one
    // value, so write it. Same session, so this is the adoption case that works.
    const newKey = verdict(submitted).cartKey;
    if (verdict(submitted).isSuccess && newKey) {
      try { localStorage.setItem('shoppingCartKey', newKey); } catch { /* ignore */ }
    }

    return {
      loaded: { status: loaded.status, ok: loaded.ok, raw: loaded.raw.slice(0, 600), v: verdict(loaded), netError: loaded.netError },
      submitted: { status: submitted.status, ok: submitted.ok, raw: submitted.raw.slice(0, 1200), v: verdict(submitted), netError: submitted.netError },
      loadedFull: loaded.raw,
      // Handed back so Node can replay the EXACT request outside the browser's
      // CORS rules when the in-page fetch is rejected without a status.
      replay: { headers, body },
      usedKey: body.shoppingCartKey,
      finalKey: ls('shoppingCartKey'),
      attempts,
      // Every extra definition we found and where it lived, so a failed run still
      // teaches us the shape rather than only that four guesses missed.
      extrasFound: extras.map((e, i) => ({
        at: paths[i],
        ExtraId: e.ExtraId,
        Name: String(e.Name ?? '').slice(0, 90),
        DefaultValue: e.DefaultValue,
        ExtraType: e.ExtraType,
        required: Boolean(e.IsWebRequired || e.Required || e.IsCRSRequired),
        keys: Object.keys(e).filter((k) => k !== '$type' && k !== '$id').join(','),
      })),
      neededCount: needed.length,
      // Diagnostics for the "required field" hunt.
      occupantName: occupant,
      occupantKeys: ['customerName', 'ssoCustomerName', 'customerDetail'].map((k) => `${k}=${ls(k) ? 'set' : 'EMPTY'}`).join(' '),
    };
  },
  { loadUrl: PRECART_LOAD, submitUrl: PRECART_SUBMIT, unitId, arrival, nights, cartKey, NO_CART }
);
}

/**
 * Read a cart's contents and find OUR entry.
 *
 * Matched on (placeId, facilityId) from the load response's LockedShoppingCart, because
 * RC's cart entries carry no unit field at all — a matcher that looked for one reported
 * an empty cart for a full one, twice. Returns the entry key, which is how a single hold
 * is released without disturbing anything else in the cart.
 */
export async function findCartEntry(requestCtx, headers, cartKey, { placeId, facilityId, unitId }) {
  const r = await requestCtx.post(CART_LOAD, {
    headers, data: { shoppingCartKey: cartKey }, timeout: 30_000,
  });
  const raw = await r.text();
  try {
    const res = JSON.parse(raw)?.Result ?? {};
    const list = res.CartEntry?.$values ?? (Array.isArray(res.CartEntry) ? res.CartEntry : []);
    const hit = list.find(
      (e) =>
        (placeId != null && Number(e.PlaceId) === Number(placeId) &&
         facilityId != null && Number(e.FacilityId) === Number(facilityId)) ||
        (unitId != null && JSON.stringify(e).includes(String(unitId))),
    );
    return { found: !!hit, entryKey: hit?.CartEntryKey ?? null, count: list.length, status: r.status() };
  } catch {
    return { found: false, entryKey: null, count: 0, status: r.status() };
  }
}

/** Release ONE entry, leaving the rest of the cart alone. A bot holding several sites
 *  must never empty the whole cart to let go of one. */
export async function releaseEntry(requestCtx, headers, cartKey, cartEntryKey) {
  const r = await requestCtx.post(CART_REMOVE_ENTRY, {
    headers, data: { shoppingCartKey: cartKey, cartEntryKey }, timeout: 30_000,
  });
  return { ok: r.ok(), status: r.status() };
}
