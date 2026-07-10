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
 * NOTE (maintainers): a couple of payload fields (extraValues, customerClassificationId,
 * sleepingUnit.name) are unit/customer-specific. We send best-effort defaults captured
 * from a real add-to-cart; if RC rejects them the banner reports the error and the
 * user books manually. Re-capture a live payload if RC changes its schema.
 */

(function () {
  const STASH = 'camphawk_rc';
  const ENDPOINT = 'https://rdapi.reservecalifornia.com/api/webaccessfacility/submit/precartdataforbookingmodify';

  function readFragment() {
    const m = location.hash.match(/camphawk-rc=(\d+)_(\d{4}-\d{2}-\d{2})_(\d+)_(\d*)/);
    if (!m) return null;
    const data = { unitId: +m[1], arrivalDate: m[2], nights: +m[3], sleepingUnitId: m[4] ? +m[4] : null };
    try { sessionStorage.setItem(STASH, JSON.stringify(data)); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return data;
  }
  function stashed() { try { return JSON.parse(sessionStorage.getItem(STASH) || 'null'); } catch { return null; } }

  const job = readFragment() || stashed();
  if (!job) return;

  const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

  // The page-world grabber (rc-inject.js) posts the live token here. RC's token
  // is Okta-encrypted in localStorage, so this capture is the only way to read it.
  let capturedToken = null, capturedCartKey = null;
  const tokenWaiters = [], cartKeyWaiters = [];
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__camphawk_token) {
      capturedToken = e.data.__camphawk_token;
      tokenWaiters.splice(0).forEach((fn) => fn(capturedToken));
    }
    if (e.data.__camphawk_cartkey) {
      capturedCartKey = e.data.__camphawk_cartkey;
      cartKeyWaiters.splice(0).forEach((fn) => fn(capturedCartKey));
    }
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
  const getCartKey = (ms = 12000) => waitFor(() => capturedCartKey, cartKeyWaiters, ms);

  function occupantName() {
    const direct = ls('customerName') || ls('ssoCustomerName');
    if (direct) return direct;
    try {
      const d = JSON.parse(ls('customerDetail') || '{}');
      return [d.FirstName, d.LastName].filter(Boolean).join(' ') || d.Name || '';
    } catch { return ''; }
  }

  let _cartKey = '';
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
      extraValues: [],
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

  async function addToCart() {
    setStatus('Reading your session…');
    const [token, cartKey] = await Promise.all([getToken(), getCartKey()]);
    if (!token) { setStatus('Couldn’t read your RC login — make sure you’re signed in, then click Add to cart.'); return; }
    if (!cartKey) { setStatus('Couldn’t read your cart — click the cart icon once, then Add to cart.'); return; }
    _cartKey = cartKey;
    setStatus('Adding to your cart…');
    try {
      // RC's rdApi wants the same token in BOTH accesstoken and authorization,
      // plus two constant headers (installationsidentity=cali, storeid=111).
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          accesstoken: token,
          authorization: 'Bearer ' + token,
          installationsidentity: 'cali',
          storeid: '111',
        },
        body: JSON.stringify(buildPayload()),
      });
      if (res.ok) {
        setStatus('✓ Added to cart — review & check out on ReserveCalifornia.');
      } else {
        let detail = '';
        try {
          const raw = await res.text();
          console.log('[CampHawk RC] full error body:', raw);
          const j = JSON.parse(raw);
          detail = j.errors ? Object.keys(j.errors).join(', ') : (j.title || raw.slice(0, 160));
        } catch {}
        setStatus(`RC declined (${res.status}) — fields: ${detail || 'see console'}`);
      }
    } catch (e) {
      setStatus('Couldn’t reach RC — book manually.');
    }
  }

  // --- banner ----------------------------------------------------------------
  let statusEl;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  function banner() {
    const bar = document.createElement('div');
    bar.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;bottom:20px;transform:translateX(-50%);' +
      'background:#1F3D2E;color:#FAF7F2;font:14px system-ui,sans-serif;padding:12px 16px;border-radius:14px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.28);display:flex;align-items:center;gap:12px;max-width:92vw';
    bar.innerHTML =
      '<span style="font-size:18px">🦅</span>' +
      `<span><strong>CampHawk</strong> · CA State Parks · ${job.arrivalDate} (${job.nights} night${job.nights > 1 ? 's' : ''})<br>` +
      '<span id="camphawk-rc-status" style="opacity:.85"></span></span>';
    const btn = document.createElement('button');
    btn.textContent = 'Add to cart';
    btn.style.cssText = 'background:#E8873A;color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer;white-space:nowrap';
    btn.onclick = addToCart;
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:transparent;color:#FAF7F2;border:0;font-size:16px;cursor:pointer;opacity:.7';
    close.onclick = () => { try { sessionStorage.removeItem(STASH); } catch {} bar.remove(); };
    bar.appendChild(btn); bar.appendChild(close);
    document.body.appendChild(bar);
    statusEl = bar.querySelector('#camphawk-rc-status');
  }
  banner();

  chrome.storage.local.get({ accepted: false, enabled: false }, ({ accepted, enabled }) => {
    if (accepted && enabled) addToCart();
    else setStatus('Auto-cart off — use the button, or enable it in the CampHawk extension.');
  });
})();
