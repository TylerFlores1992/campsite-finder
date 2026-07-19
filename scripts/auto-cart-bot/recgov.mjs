// Recreation.gov add-to-cart, ported from the proven CampHawk extension content
// script. Runs in YOUR logged-in browser (persistent Playwright context), so the
// site lands in your own cart on your own IP. Stops at the cart — you review and pay.
//
// Returns the outcome string so the bot can report it to CampHawk:
//   'carted'                                        → success, VERIFIED present in the cart
//   'add-not-confirmed'                             → clicked Add to Cart but the cart stayed
//                                                     empty (expired session / extra step)
//   'already-booked' | 'dates-not-found'            → the site was gone by the time we tried
//   'calendar-not-loaded' | 'cta-not-ready'         → page/selector problem
//   'error'                                         → navigation/exception
// Anything other than 'carted' makes the server re-verify availability and send a
// normal "still open — book it" alert (if it's genuinely still open) instead of a
// false "it's in your cart".
export async function cartRecGov(context, job, log) {
  const url = job.bookingUrl.split('#')[0];
  const page = await context.newPage();
  // Capture the write API calls the SPA makes when we click Add to Cart, so a
  // silent failure tells us WHY (e.g. a 4xx demanding equipment/occupants) rather
  // than just "cart empty". Only non-GET recreation.gov calls — a booking makes few.
  const netlog = [];
  page.on('request', (req) => {
    try {
      if (req.method() === 'GET' || !/recreation\.gov/.test(req.url())) return;
      const p = (req.postData() || '').replace(/\s+/g, ' ').slice(0, 300);
      netlog.push(`→ ${req.method()} ${req.url().replace(/^https?:\/\/[^/]+/, '')}${p ? ` body=${p}` : ''}`);
    } catch { /* ignore */ }
  });
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (req.method() === 'GET' || !/recreation\.gov/.test(res.url())) return;
      let body = '';
      if (res.status() >= 400) { try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200); } catch { /* ignore */ } }
      netlog.push(`← ${res.status()} ${req.method()} ${res.url().replace(/^https?:\/\/[^/]+/, '')}${body ? ` | ${body}` : ''}`);
    } catch { /* ignore */ }
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const result = await page.evaluate(
      async ({ checkin, checkout }) => {
        // Bail early if this browser isn't actually signed in — rec.gov shows a
        // "Sign Up or Log In" header button only when logged out. It must be
        // VISIBLE: the SPA keeps a hidden copy in the DOM even when logged in, and
        // matching that hidden node was falsely reporting logged-out.
        const loginRe = /^(log\s?in|sign\s?in|sign\s?up or log\s?in|log\s?in or sign\s?up|sign\s?up \/ log\s?in)$/i;
        const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        if (Array.from(document.querySelectorAll('button, a')).some((e) => loginRe.test((e.textContent || '').trim()) && visible(e))) {
          return 'logged-out';
        }
        const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const ariaDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const labeled = () => Array.from(document.querySelectorAll('[aria-label]'));
        const dateButton = (iso) => { const n = ariaDate(iso); return labeled().find((b) => (b.getAttribute('aria-label') || '').includes(n)); };

        // react-aria's usePress needs real pointer events, not a bare .click().
        const press = (el) => {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
          el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
          el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: o.clientX, clientY: o.clientY }));
        };
        const arrow = (word) => labeled().find((b) => (b.getAttribute('aria-label') || '').trim().toLowerCase() === word);
        const ym = (iso) => { const [y, m] = iso.split('-').map(Number); return y * 100 + m; };
        const displayedRange = () => {
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
        };
        const locate = async (iso) => {
          const target = ym(iso);
          for (let i = 0; i < 16; i++) {
            const b = dateButton(iso);
            if (b) return b;
            const { min, max } = displayedRange();
            let btn = null;
            if (target > max && Number.isFinite(max)) btn = arrow('next');
            else if (target < min && Number.isFinite(min)) btn = arrow('previous');
            else return null;
            if (!btn || btn.getAttribute('aria-disabled') === 'true') return null;
            press(btn);
            await sleep(550);
          }
          return null;
        };
        const isBooked = (el) => {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          return el.getAttribute('aria-disabled') === 'true' || /reserved|current reservation|not available|not yet released|walk-up|walk up/.test(label);
        };
        const ctaButton = () => Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => /add to cart|book now|reserve/i.test((b.textContent || '').trim()));
        const waitForCalendar = async () => {
          for (let i = 0; i < 40; i++) {
            const painted = labeled().some((b) => /, 20\d\d\b.*-\s*(available|checkout|current reservation|reserved|not yet released)/i.test(b.getAttribute('aria-label') || ''));
            if (painted) return true;
            await sleep(300);
          }
          return Number.isFinite(displayedRange().max);
        };

        if (!(await waitForCalendar())) return 'calendar-not-loaded';
        await sleep(400);
        let ci = await locate(checkin);
        if (ci && isBooked(ci)) { await sleep(1000); ci = await locate(checkin); }
        if (!ci) return 'dates-not-found';
        if (isBooked(ci)) return 'already-booked';
        press(ci);
        await sleep(500);
        const co = await locate(checkout);
        if (co && !isBooked(co)) { press(co); await sleep(700); }
        await sleep(600);
        const cta = ctaButton();
        if (!cta || cta.getAttribute('aria-disabled') === 'true' || cta.disabled) return 'cta-not-ready';
        press(cta);
        await sleep(1800);
        // Some sites pop a confirmation dialog (equipment / occupancy / need-to-know)
        // with a final add/confirm button. Best-effort: click it if present.
        const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
        let handledDialog = false;
        if (dialog) {
          const confirm = Array.from(dialog.querySelectorAll('button, [role="button"]'))
            .find((b) => /add to cart|reserve|confirm|continue|acknowledge|agree|^yes\b|^save\b/i.test((b.textContent || '').trim()));
          if (confirm && confirm.getAttribute('aria-disabled') !== 'true' && !confirm.disabled) {
            press(confirm);
            handledDialog = true;
            await sleep(1800);
          }
        }
        return handledDialog ? 'cta-pressed+dialog' : 'cta-pressed';
      },
      { checkin: job.startDate, checkout: job.endDate }
    );

    log(`  · rec.gov: ${job.campgroundName} — page step: ${result}`);
    if (result === 'logged-out') {
      log(`  ✗ ${job.campgroundName} — this browser is NOT signed in to rec.gov; can't cart. Reconnect needed.`);
      return 'session-expired';
    }
    if (result === 'cta-pressed' || result === 'cta-pressed+dialog') {
      // Never claim success blind: verify the item actually landed in the cart.
      const v = await verifyCart(context, log);
      if (v === 'ok') {
        log(`  ✓ ADDED TO CART: ${job.campgroundName} (${job.startDate}→${job.endDate}) — confirmed in the account cart`);
        return 'carted';
      }
      if (v === 'signin') {
        log(`  ✗ ${job.campgroundName} — rec.gov session has expired; the add didn't take. This user needs to reconnect.`);
        return 'session-expired';
      }
      log(`  ✗ ${job.campgroundName} — clicked Add to Cart but the cart is still empty (${v}) — add didn't take`);
      if (netlog.length) { log(`  ⓘ write API calls during add:`); for (const n of netlog.slice(-12)) log(`      ${n}`); }
      else log(`  ⓘ NO write (non-GET) API call fired on click — the Add-to-Cart click isn't triggering a request`);
      return 'add-not-confirmed';
    }
    return result; // the failure reason (already-booked / dates-not-found / calendar-not-loaded / cta-not-ready)
  } catch (err) {
    log(`  ✗ rec.gov error for ${job.campgroundName}: ${err.message}`);
    return 'error';
  } finally {
    await page.close().catch(() => {});
  }
}

// Confirm the site really landed in the cart. Polls the cart page for a definitive
// signal so we never report 'carted' on a silent add failure. Returns:
//   'ok'      → cart has an item (checkout affordance present)
//   'empty'   → cart page loaded and says it's empty (add didn't take)
//   'signin'  → cart bounced to sign-in (the rec.gov session has expired)
//   'unknown' → no definitive signal in time (treat as not-carted; fail closed)
async function verifyCart(context, log) {
  const page = await context.newPage();
  try {
    await page.goto('https://www.recreation.gov/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i = 0; i < 14; i++) {
      const url = (page.url() || '').toLowerCase();
      if (/sign-?in|\/login/.test(url)) return 'signin';
      const txt = (await page.evaluate(() => document.body.innerText || '')).toLowerCase();
      if (txt.includes('your cart is empty')) return 'empty';
      if (/checkout|order summary|remove item|reservation details|proceed to/i.test(txt)) return 'ok';
      await new Promise((r) => setTimeout(r, 500));
    }
    return 'unknown';
  } catch (e) {
    log(`  cart verify error: ${e.message}`);
    return 'unknown';
  } finally {
    await page.close().catch(() => {});
  }
}
