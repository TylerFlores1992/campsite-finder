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

  // --- 2. React-safe field setter -------------------------------------------
  // Setting input.value directly doesn't notify React. Use the native setter
  // then dispatch a bubbling input event.
  function setReactValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fmt(iso) {
    // rec.gov's date fields render MM/DD/YYYY
    const [y, mo, d] = iso.split('-');
    return `${mo}/${d}/${y}`;
  }

  // --- 3. best-effort autofill + add-to-cart --------------------------------
  function fillDates() {
    let filled = 0;
    const inputs = Array.from(document.querySelectorAll('input'));
    const checkin = inputs.find((i) =>
      /check.?in|arriv|start/i.test((i.getAttribute('aria-label') || '') + (i.id || '') + (i.name || ''))
    );
    const checkout = inputs.find((i) =>
      /check.?out|depart|end/i.test((i.getAttribute('aria-label') || '') + (i.id || '') + (i.name || ''))
    );
    if (checkin) { setReactValue(checkin, fmt(dates.checkin)); filled++; }
    if (checkout) { setReactValue(checkout, fmt(dates.checkout)); filled++; }
    return filled;
  }

  function clickAddToCart() {
    const btn = Array.from(document.querySelectorAll('button, a')).find((b) =>
      /add to cart|book (this )?site|reserve/i.test(b.textContent || '')
    );
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  }

  async function run(auto) {
    setStatus('Filling your dates…');
    const filled = fillDates();
    if (auto) {
      // Give rec.gov's grid a moment to react to the date change before booking.
      await new Promise((r) => setTimeout(r, 1200));
      const clicked = clickAddToCart();
      setStatus(
        clicked
          ? '✓ Added to cart — finish checkout on the page.'
          : filled
            ? 'Dates filled. Click “Add to cart” on the page.'
            : 'Couldn’t auto-fill — book manually below.'
      );
    } else {
      setStatus(filled ? 'Dates filled — review and add to cart.' : 'Couldn’t find the date fields on this page.');
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
