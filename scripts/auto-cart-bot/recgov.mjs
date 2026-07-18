// Recreation.gov add-to-cart, ported from the proven CampHawk extension content
// script. Runs in YOUR logged-in browser (persistent Playwright context), so the
// site lands in your own cart on your own IP. Stops at the cart — you review and pay.
//
// Returns the outcome string so the bot can report it to CampHawk:
//   'carted'                                        → success (in the cart)
//   'already-booked' | 'dates-not-found'            → the site was gone by the time we tried
//   'calendar-not-loaded' | 'cta-not-ready'         → page/selector problem
//   'error'                                         → navigation/exception
export async function cartRecGov(context, job, log) {
  const url = job.bookingUrl.split('#')[0];
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const result = await page.evaluate(
      async ({ checkin, checkout }) => {
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
        if (cta && cta.getAttribute('aria-disabled') !== 'true' && !cta.disabled) {
          press(cta);
          await sleep(2800); // let the add-to-cart request reach the server before we close
          return 'carted';
        }
        return 'cta-not-ready';
      },
      { checkin: job.startDate, checkout: job.endDate }
    );

    if (result === 'carted') {
      log(`  ✓ ADDED TO CART: ${job.campgroundName} (${job.startDate}→${job.endDate}) — it's in the account cart; finish on your phone`);
      return 'carted'; // caller closes the browser; the cart is server-side and syncs to the phone
    }
    log(`  ✗ rec.gov: ${job.campgroundName} — ${result}`);
    return result; // the failure reason (already-booked / dates-not-found / calendar-not-loaded / cta-not-ready)
  } catch (err) {
    log(`  ✗ rec.gov error for ${job.campgroundName}: ${err.message}`);
    return 'error';
  } finally {
    await page.close().catch(() => {});
  }
}
