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

  function dateButton(iso) {
    const needle = ariaDate(iso);
    return Array.from(document.querySelectorAll('button[aria-label]')).find((b) =>
      (b.getAttribute('aria-label') || '').includes(needle)
    );
  }

  function nextMonthButton() {
    const btns = Array.from(document.querySelectorAll('button[aria-label]'));
    // The calendar arrow is labeled exactly "Next" — must NOT match the photo
    // slideshow's "Next image" button, which appears earlier in the DOM.
    return (
      btns.find((b) => (b.getAttribute('aria-label') || '').trim().toLowerCase() === 'next') ||
      btns.find((b) => /next month|forward/i.test(b.getAttribute('aria-label') || ''))
    );
  }

  // Find a date button, paging the calendar forward if it's not rendered yet.
  async function locate(iso) {
    for (let i = 0; i < 6; i++) {
      const b = dateButton(iso);
      if (b) return b;
      const next = nextMonthButton();
      if (!next || next.disabled) break;
      next.click();
      await sleep(350);
    }
    return null;
  }

  function isBooked(btn) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    return btn.disabled || /reserved|current reservation|not available|walk-up/.test(label);
  }

  // The primary CTA near the price relabels itself as dates are chosen:
  // "Enter Dates" → "Add to Cart" / "Book Now".
  function ctaButton() {
    return Array.from(document.querySelectorAll('button')).find((b) =>
      /add to cart|book now|reserve|enter dates/i.test((b.textContent || '').trim())
    );
  }

  // --- 3. select dates + add to cart (honest reporting) ---------------------
  async function run(auto) {
    setStatus('Finding your dates…');

    const checkinBtn = await locate(dates.checkin);
    if (!checkinBtn) return setStatus('Couldn’t find these dates on the calendar — book manually.');
    if (isBooked(checkinBtn)) return setStatus('This site looks booked for those dates now.');

    checkinBtn.click();
    await sleep(500);
    // checkout uses the night AFTER the last night; rec.gov's range picker wants
    // the checkout day itself, which our fragment already carries.
    const checkoutBtn = await locate(dates.checkout);
    if (checkoutBtn && !isBooked(checkoutBtn)) { checkoutBtn.click(); await sleep(600); }

    setStatus('Dates selected.');
    if (!auto) return setStatus('Dates selected — review and add to cart on the page.');

    // Auto path: only click the CTA if it has actually become a booking action.
    await sleep(700);
    const cta = ctaButton();
    const label = (cta?.textContent || '').trim().toLowerCase();
    if (cta && !cta.disabled && /add to cart|book now|reserve/.test(label)) {
      cta.click();
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
