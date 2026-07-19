// Recreation.gov add-to-cart. Runs in YOUR logged-in browser (persistent, HEADED
// Playwright context) so the site lands in your own cart on your own IP, and the
// real headed browser passes rec.gov's anti-bot gate. Stops at the cart.
//
// Uses Playwright's REAL mouse clicks (trusted events) — react-aria's range
// calendar ignores synthetic dispatched events for the check-out hover, so the
// range only forms with genuine pointer input.
//
// Returns the outcome string the bot reports to CampHawk:
//   'carted'                      → success, VERIFIED present in the cart
//   'add-not-confirmed'           → clicked Add to Cart but cart stayed empty
//   'range-not-formed(sel=N)'     → couldn't select a multi-day range (N cells stuck)
//   'already-booked'|'dates-not-found'|'cta-not-ready'|'calendar-not-loaded' → page issue
//   'session-expired'             → not signed in / cart bounced to sign-in
//   'error'                       → navigation/exception
// Anything but 'carted' makes the server re-verify and send a normal alert.
export async function cartRecGov(context, job, log) {
  const url = job.bookingUrl.split('#')[0];
  const page = await context.newPage();
  // Capture the write API calls the SPA makes on Add to Cart, so a silent failure
  // tells us WHY (e.g. a 4xx / anti-bot ok:false) rather than just "cart empty".
  const netlog = [];
  const isBooking = (u) => /reservation|\/cart|checkout/i.test(u);
  page.on('request', (req) => {
    try {
      if (req.method() === 'GET' || !/recreation\.gov/.test(req.url())) return;
      const cap = isBooking(req.url()) ? 1500 : 200;
      const p = (req.postData() || '').replace(/\s+/g, ' ').slice(0, cap);
      netlog.push(`→ ${req.method()} ${req.url().replace(/^https?:\/\/[^/]+/, '')}${p ? ` body=${p}` : ''}`);
    } catch { /* ignore */ }
  });
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (req.method() === 'GET' || !/recreation\.gov/.test(res.url())) return;
      let body = '';
      if (res.status() >= 400 || isBooking(res.url())) {
        try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 600); } catch { /* ignore */ }
      }
      netlog.push(`← ${res.status()} ${req.method()} ${res.url().replace(/^https?:\/\/[^/]+/, '')}${body ? ` | ${body}` : ''}`);
    } catch { /* ignore */ }
  });

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const ariaDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
  const ymOf = (iso) => { const [y, m] = iso.split('-').map(Number); return y * 100 + m; };

  // Displayed month span + the target date cell's viewport-center coords / booked
  // flag. Date cells are react-aria role=button DIVs, not <button>s — match any
  // [aria-label] that looks like a date.
  const probe = (label) => page.evaluate((lbl) => {
    const cells = Array.from(document.querySelectorAll('[aria-label]'))
      .filter((b) => /,\s*20\d\d/.test(b.getAttribute('aria-label') || ''));
    const MO = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    let min = Infinity, max = -Infinity;
    for (const b of cells) {
      const m = (b.getAttribute('aria-label') || '').match(/(\w+) \d{1,2}, (\d{4})/);
      if (!m) continue; const mi = MO.indexOf(m[1]); if (mi < 0) continue;
      const v = Number(m[2]) * 100 + (mi + 1); if (v < min) min = v; if (v > max) max = v;
    }
    const el = cells.find((b) => (b.getAttribute('aria-label') || '').includes(lbl));
    let cell = null;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const lab = (el.getAttribute('aria-label') || '').toLowerCase();
      const booked = el.getAttribute('aria-disabled') === 'true' || /reserved|current reservation|not available|not yet released|walk.?up/.test(lab);
      cell = { x: r.left + r.width / 2, y: r.top + r.height / 2, booked, ok: r.width > 0 && r.height > 0 };
    }
    return { cell, min, max };
  }, label);

  // The calendar's own month arrows have accessible name exactly "Next"/"Previous"
  // (the slideshow's are "Next image"/"Previous image"). getByRole matches whether
  // they're <button>s or role=button divs.
  const clickArrow = async (word) => {
    const loc = page.getByRole('button', { name: word, exact: true });
    if (await loc.count()) { await loc.first().click({ timeout: 3000 }).catch(() => {}); return true; }
    return false;
  };

  // Real mouse click on a date, navigating months into view first.
  const clickDate = async (iso) => {
    const label = ariaDate(iso), target = ymOf(iso);
    for (let i = 0; i < 16; i++) {
      const { cell, min, max } = await probe(label);
      if (cell && cell.ok) {
        if (cell.booked) return 'booked';
        await page.mouse.move(cell.x, cell.y);
        await page.waitForTimeout(150);
        await page.mouse.click(cell.x, cell.y);
        return 'clicked';
      }
      let moved = false;
      if (Number.isFinite(max) && target > max) moved = await clickArrow('Next');
      else if (Number.isFinite(min) && target < min) moved = await clickArrow('Previous');
      if (!moved) return 'not-found';
      await page.waitForTimeout(500);
    }
    return 'not-found';
  };

  const selCount = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label]')).filter((b) => /\bselected\b/i.test(b.getAttribute('aria-label') || '')).length);

  const ctaInfo = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find((x) => /add to cart|book now|reserve/i.test((x.textContent || '').trim()));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { text: (b.textContent || '').trim().slice(0, 24), x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled, ok: r.width > 0 };
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the calendar to paint availability.
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('[aria-label]')).some((b) => /,\s*20\d\d.*-\s*(available|checkout|reserved|current reservation|not yet released)/i.test(b.getAttribute('aria-label') || '')),
      { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(800);
    if ((await selCount()) === 0 && !(await ctaInfo())) {
      // sanity: is the calendar even here?
      const painted = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-label]')).some((b) => /,\s*20\d\d/.test(b.getAttribute('aria-label') || '')));
      if (!painted) return 'calendar-not-loaded';
    }

    // Select the date range with REAL mouse clicks; retry until it forms.
    let formed = false, sel = 0;
    for (let attempt = 0; attempt < 4 && !formed; attempt++) {
      const ci = await clickDate(job.startDate);
      if (ci === 'not-found') return 'dates-not-found';
      if (ci === 'booked') return 'already-booked';
      await page.waitForTimeout(700);
      await clickDate(job.endDate);
      await page.waitForTimeout(800);
      sel = await selCount();
      formed = sel >= 2 && !!(await ctaInfo());
      if (!formed) await page.waitForTimeout(600);
    }
    log(`  · rec.gov: ${job.campgroundName} — range sel=${sel}`);
    if (!formed) return `range-not-formed(sel=${sel})`;

    const cta = await ctaInfo();
    if (!cta || cta.disabled || !cta.ok) return 'cta-not-ready';
    await page.mouse.move(cta.x, cta.y);
    await page.waitForTimeout(150);
    await page.mouse.click(cta.x, cta.y);
    await page.waitForTimeout(2000);

    // Best-effort confirmation dialog (equipment / occupancy / need-to-know).
    const dlgBox = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"], [aria-modal="true"]');
      if (!d) return null;
      const b = Array.from(d.querySelectorAll('button, [role="button"]'))
        .find((x) => /add to cart|reserve|confirm|continue|acknowledge|agree|^yes\b|^save\b/i.test((x.textContent || '').trim()) && x.getAttribute('aria-disabled') !== 'true' && !x.disabled);
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (dlgBox) { await page.mouse.click(dlgBox.x, dlgBox.y); await page.waitForTimeout(1800); }
    log(`  · rec.gov: ${job.campgroundName} — clicked Add to Cart${dlgBox ? '+dialog' : ''}`);

    // Verify the item actually landed in the cart.
    const v = await verifyCart(context, log);
    if (v === 'ok') {
      log(`  ✓ ADDED TO CART: ${job.campgroundName} (${job.startDate}→${job.endDate}) — confirmed in the account cart`);
      return 'carted';
    }
    if (v === 'signin') {
      log(`  ✗ ${job.campgroundName} — rec.gov session has expired; reconnect needed.`);
      return 'session-expired';
    }
    log(`  ✗ ${job.campgroundName} — clicked Add to Cart but the cart is still empty (${v}) — add didn't take`);
    if (netlog.length) { log(`  ⓘ write API calls during add:`); for (const n of netlog.slice(-12)) log(`      ${n}`); }
    return 'add-not-confirmed';
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
