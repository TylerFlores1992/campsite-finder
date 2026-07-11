/*
 * CampHawk Quick Cart — content script (Recreation.gov).
 *
 * Flow:
 *  1. A CampHawk alert link looks like
 *       https://www.recreation.gov/camping/campsites/{id}#camphawk=2026-07-10_2026-07-12
 *     The #fragment is never sent to rec.gov's servers — we read it here.
 *  2. We stash the dates (they survive rec.gov's in-app navigation), then show a
 *     small CampHawk banner with a "Fill dates & add to cart" button.
 *  3. If the user has turned the toggle ON *and* accepted the risk, we also try
 *     to do it automatically.
 *
 * Everything runs in the user's own logged-in session, in their own browser, on
 * their own IP. CampHawk servers never see their Recreation.gov credentials.
 *
 * IMPORTANT (for maintainers): rec.gov is a React SPA and ships no stable public
 * DOM contract. The selectors below are best-effort with fallbacks and MUST be
 * re-verified against the live site; when they miss, the banner button is the
 * manual fallback and nothing on the page breaks.
 */

(function () {
  const STASH_KEY = 'camphawk_dates';

  // --- 1. capture dates from the alert fragment ------------------------------
  function readFragmentDates() {
    const m = location.hash.match(/camphawk=(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
    if (!m) return null;
    const dates = { checkin: m[1], checkout: m[2] };
    try { sessionStorage.setItem(STASH_KEY, JSON.stringify(dates)); } catch {}
    // Strip the fragment so a manual refresh/share doesn't re-trigger.
    history.replaceState(null, '', location.pathname + location.search);
    return dates;
  }

  function stashedDates() {
    try { return JSON.parse(sessionStorage.getItem(STASH_KEY) || 'null'); } catch { return null; }
  }

  const dates = readFragmentDates() || stashedDates();
  if (!dates) return; // not a CampHawk-originated visit — do nothing

  // --- 2. calendar helpers ---------------------------------------------------
  // rec.gov renders availability as a grid of <button> elements whose
  // aria-label looks like "Friday, August 14, 2026 - Available" (or
  // "- Current Reservation" when booked). We match by the date portion.
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  function ariaDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // rec.gov's calendar day cells are React-aria pressable <div role="button">
  // (NOT <button>), named via aria-label. Arrows are real <button>s. So we
  // query on aria-label across all elements.
  function labeled() {
    return Array.from(document.querySelectorAll('[aria-label]'));
  }

  function dateButton(iso) {
    const needle = ariaDate(iso);
    return labeled().find((b) => (b.getAttribute('aria-label') || '').includes(needle));
  }

  // React-aria's usePress listens for pointer events, not synthetic clicks — a
  // bare .click() is ignored. Dispatch a full pointerdown→pointerup→click press.
  function press(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: o.clientX, clientY: o.clientY }));
  }

  // Calendar arrows are labeled exactly "Next"/"Previous" — must NOT match the
  // photo slideshow's "Next image" button.
  function arrow(word) {
    // Exact "next"/"previous" — excludes the slideshow's "Next image" button.
    return labeled().find((b) => (b.getAttribute('aria-label') || '').trim().toLowerCase() === word);
  }

  function ym(iso) {
    const [y, m] = iso.split('-').map(Number);
    return y * 100 + m;
  }

  // Min/max year-month currently rendered in the calendar (from date aria-labels).
  function displayedRange() {
    let min = Infinity, max = -Infinity;
    for (const b of labeled()) {
      const m = (b.getAttribute('aria-label') || '').match(/(\w+) \d{1,2}, (\d{4})/);
      if (!m) continue;
      const mi = MONTHS.indexOf(m[1]);
      if (mi < 0) continue;
      const v = Number(m[2]) * 100 + (mi + 1);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  // Find a date button, paging the calendar toward it (forward OR back).
  async function locate(iso) {
    const target = ym(iso);
    for (let i = 0; i < 16; i++) {
      const b = dateButton(iso);
      if (b) return b;
      const { min, max } = displayedRange();
      let btn = null;
      if (target > max && Number.isFinite(max)) btn = arrow('next');
      else if (target < min && Number.isFinite(min)) btn = arrow('previous');
      else return null; // target month is displayed but the day isn't a button
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return null;
      press(btn);
      await sleep(550);
    }
    return null;
  }

  function isBooked(el) {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    return (
      el.getAttribute('aria-disabled') === 'true' ||
      /reserved|current reservation|not available|not yet released|walk-up|walk up/.test(label)
    );
  }

  // The primary CTA near the price relabels itself as dates are chosen:
  // "Enter Dates" → "Add to Cart".
  function ctaButton() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
      /add to cart|book now|reserve/i.test((b.textContent || '').trim())
    );
  }

  // rec.gov fetches availability after page load and cells briefly render
  // disabled while the data paints. Wait until at least one cell shows a real
  // status ("- Available"/"- Checkout"/"- Current Reservation"), not just any
  // date — otherwise we misread a still-loading cell as booked.
  async function waitForCalendar() {
    for (let i = 0; i < 40; i++) {
      const painted = labeled().some((b) =>
        /, 20\d\d\b.*-\s*(available|checkout|current reservation|reserved|not yet released)/i.test(
          b.getAttribute('aria-label') || ''
        )
      );
      if (painted) return true;
      await sleep(300);
    }
    return Number.isFinite(displayedRange().max); // fall back to "any cell exists"
  }

  // --- 3. select dates + add to cart (honest reporting) ---------------------
  async function run(auto) {
    setStatus('Loading availability…');
    if (!(await waitForCalendar())) return setStatus('Availability calendar didn’t load — book manually.');
    await sleep(400); // small settle so every cell's status is final

    setStatus('Finding your dates…');
    let checkinBtn = await locate(dates.checkin);
    // One retry: a cell can still be transitioning from disabled → available.
    if (checkinBtn && isBooked(checkinBtn)) {
      await sleep(1000);
      checkinBtn = await locate(dates.checkin);
    }
    if (!checkinBtn) return setStatus('Couldn’t find these dates on the calendar — book manually.');
    if (isBooked(checkinBtn)) return setStatus('This site looks booked for those dates now.');

    press(checkinBtn);
    await sleep(500);
    // rec.gov's range picker wants the checkout day itself, which our fragment carries.
    const checkoutBtn = await locate(dates.checkout);
    if (checkoutBtn && !isBooked(checkoutBtn)) { press(checkoutBtn); await sleep(700); }

    if (!auto) return setStatus('Dates selected — review and add to cart on the page.');

    // Auto path: only press the CTA once it has become a real booking action.
    await sleep(600);
    const cta = ctaButton();
    if (cta && cta.getAttribute('aria-disabled') !== 'true' && !cta.disabled) {
      press(cta);
      setStatus('✓ Sent to cart — finish checkout on the page.');
    } else {
      setStatus('Dates selected. Use the booking button on the page to finish.');
    }
  }

  // --- 4. on-page CampHawk banner (feedback + manual fallback) ---------------
  let statusEl;
  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  function banner() {
    const bar = document.createElement('div');
    bar.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;bottom:20px;transform:translateX(-50%);' +
      'background:#1F3D2E;color:#FAF7F2;font:14px system-ui,sans-serif;padding:12px 16px;' +
      'border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.28);display:flex;align-items:center;gap:12px;max-width:92vw';
    bar.innerHTML =
      '<span style="font-size:18px">🦅</span>' +
      `<span><strong>CampHawk</strong> · ${dates.checkin} → ${dates.checkout}<br>` +
      '<span id="camphawk-status" style="opacity:.85"></span></span>';

    const btn = document.createElement('button');
    btn.textContent = 'Fill dates & add to cart';
    btn.style.cssText =
      'background:#E8873A;color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer;white-space:nowrap';
    btn.onclick = () => run(true);

    const close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'background:transparent;color:#FAF7F2;border:0;font-size:16px;cursor:pointer;opacity:.7';
    close.onclick = () => { try { sessionStorage.removeItem(STASH_KEY); } catch {} bar.remove(); };

    bar.appendChild(btn);
    bar.appendChild(close);
    document.body.appendChild(bar);
    statusEl = bar.querySelector('#camphawk-status');
  }

  banner();

  // --- 5. auto-run only if enabled AND risk accepted -------------------------
  chrome.storage.local.get({ accepted: false, enabled: false }, ({ accepted, enabled }) => {
    if (accepted && enabled) run(true);
    else setStatus('Auto-cart is off — use the button, or enable it in the CampHawk extension.');
  });
})();
