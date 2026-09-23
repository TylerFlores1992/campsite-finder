// Recreation.gov add-to-cart. Runs in YOUR logged-in browser (persistent, HEADED
// Playwright context) so the site lands in your own cart on your own IP, and the
// real headed browser passes rec.gov's anti-bot gate. Stops at the cart.
//
// Uses Playwright's REAL mouse clicks (trusted events) — react-aria's range
// calendar ignores synthetic dispatched events for the check-out hover, so the
// range only forms with genuine pointer input.
//
// ── ONE ATTEMPT WAS NOT ENOUGH (2026-09-23) ──────────────────────────────────────────
// This file used to make a single attempt and give up. On job 7c0c524f the add did not
// confirm, the poller re-checked the site 200ms later, found it STILL OPEN, and sent the
// "book it yourself" alert — the paid feature having tried exactly once. `attemptCart`
// below is that single attempt, unchanged in what it does; `cartRecGov` now runs it under
// the bounded ladder in `cart-retry.mjs`, which owns every rule about whether a second
// attempt is allowed and what it may do. All of it is under a 25-second budget that keeps
// the ladder finishing BEFORE the poller's independent 35-second fallback deadline, so the
// retry and the alert can never run at the same time.
//
// Outcome strings (the ladder classifies each one; see cart-retry.mjs):
//   'carted'                      → success, VERIFIED present in the cart
//   'add-not-confirmed(empty)'    → rec.gov says the cart is empty; the add did not take
//   'add-not-confirmed(unknown)'  → no definitive signal — we do NOT know. Never re-added
//                                   blind; the retry re-READS the cart instead.
//   'range-not-formed(sel=N)'     → couldn't select a multi-day range (N cells stuck)
//   'already-booked'|'dates-not-found'|'cta-not-ready'|'calendar-not-loaded' → page issue
//   'session-expired'             → not signed in / cart bounced to sign-in
//   'error'                       → navigation/exception
// Anything but 'carted' makes the server re-verify and send a normal alert.
import { runCartLadder, cartOutcomeForDb, CARTED } from './cart-retry.mjs';

/**
 * ONE attempt: load the page, form the range, click Add to Cart, verify the cart.
 *
 * Returns `{outcome, clicked, note}`. `clicked` is the fact the ladder needs most — it is
 * what decides whether the NEXT round must re-read the cart before it is allowed to add
 * again. It is set the instant the CTA is pressed, before anything that can throw, because
 * a click followed by an exception is exactly the case where the cart is in doubt.
 */
async function attemptCart(context, job, log) {
  const url = job.bookingUrl.split('#')[0];
  const page = await context.newPage();
  // Capture the reservation/cart API calls so a silent failure tells us WHY (a 4xx
  // rule violation, an anti-bot ok:false, etc.) rather than just "cart empty". Only
  // booking calls — analytics is noise, and the request body is trimmed to keep the
  // useful dates/night_map without the giant gate_a anti-bot token.
  const netlog = [];
  const isBooking = (u) => /reservation|\/cart|checkout/i.test(u);
  page.on('request', (req) => {
    try {
      if (req.method() === 'GET' || !isBooking(req.url())) return;
      const p = (req.postData() || '').replace(/"gate_a".*$/, '"gate_a":<omitted>}').replace(/\s+/g, ' ').slice(0, 400);
      netlog.push(`→ ${req.method()} ${req.url().replace(/^https?:\/\/[^/]+/, '')}${p ? ` body=${p}` : ''}`);
    } catch { /* ignore */ }
  });
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (req.method() === 'GET' || !isBooking(res.url())) return;
      let body = '';
      try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 400); } catch { /* ignore */ }
      netlog.push(`← ${res.status()} ${req.method()} ${res.url().replace(/^https?:\/\/[^/]+/, '')}${body ? ` | ${body}` : ''}`);
    } catch { /* ignore */ }
  });
  // WHAT rec.gov ITSELF SAID, carried out of this function.
  //
  // The netlog has been printed to the box console since it was written, and the box
  // console rolls in about eighty-nine minutes — so on 2026-09-23 "why did the add not
  // take?" had no answer ten hours later, about the paid feature. The last write response
  // is the decisive line (an anti-bot `ok:false`, a 4xx rule violation, a 403), and it
  // rides back with the outcome into `bot_events`.
  const lastWriteResponse = () => {
    for (let i = netlog.length - 1; i >= 0; i--) if (netlog[i].startsWith('←')) return netlog[i].slice(0, 240);
    return null;
  };
  let clicked = false;
  const done = (outcome, note = null) => ({ outcome, clicked, note: note ?? (clicked ? lastWriteResponse() : null) });

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
      // NO DATE CELLS AT ALL IS A DIFFERENT FACT FROM "THESE DATES ARE NOT IN THE
      // CALENDAR", and until 2026-09-23 both returned 'not-found' → `dates-not-found`.
      // With nothing painted, `min`/`max` stay ±Infinity, neither arrow branch fires,
      // `moved` stays false, and the loop returned on the FIRST pass without ever
      // waiting — a calendar that had not finished rendering reported as a campground
      // that does not offer these nights. One is a transient worth a fresh page load and
      // the other is terminal; collapsing them is why the retryable case looked terminal.
      if (!Number.isFinite(min) && !Number.isFinite(max)) return 'unpainted';
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
      if (!painted) return done('calendar-not-loaded');
    }

    // Select the date range with REAL mouse clicks; retry until it forms.
    let formed = false, sel = 0;
    for (let attempt = 0; attempt < 4 && !formed; attempt++) {
      const ci = await clickDate(job.startDate);
      if (ci === 'unpainted') return done('calendar-not-loaded');
      if (ci === 'not-found') return done('dates-not-found');
      if (ci === 'booked') return done('already-booked');
      await page.waitForTimeout(700);
      await clickDate(job.endDate);
      await page.waitForTimeout(800);
      sel = await selCount();
      formed = sel >= 2 && !!(await ctaInfo());
      if (!formed) await page.waitForTimeout(600);
    }
    log(`  · rec.gov: ${job.campgroundName} — range sel=${sel}`);
    if (!formed) return done(`range-not-formed(sel=${sel})`);

    const cta = await ctaInfo();
    if (!cta || cta.disabled || !cta.ok) return done('cta-not-ready');
    await page.mouse.move(cta.x, cta.y);
    await page.waitForTimeout(150);
    // SET BEFORE THE CLICK, NOT AFTER. Everything below here can throw, and a click
    // followed by an exception is the single case where the cart is most in doubt — the
    // one where the next round must read before it adds. Setting it afterwards would
    // clear that doubt by losing it.
    clicked = true;
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
      return done(CARTED);
    }
    if (v === 'signin') {
      log(`  ✗ ${job.campgroundName} — rec.gov session has expired; reconnect needed.`);
      return done('session-expired');
    }
    // `v` RIDES OUT WITH THE OUTCOME. It used to be printed here and thrown away, and it
    // is the difference between "rec.gov says the cart is empty, a re-add is safe" and
    // "we could not tell, so re-adding might book this campsite twice".
    log(`  ✗ ${job.campgroundName} — clicked Add to Cart but the cart is still empty (${v}) — add didn't take`);
    if (netlog.length) { log(`  ⓘ write API calls during add:`); for (const n of netlog.slice(-12)) log(`      ${n}`); }
    return done(`add-not-confirmed(${v})`);
  } catch (err) {
    log(`  ✗ rec.gov error for ${job.campgroundName}: ${err.message}`);
    return done('error', String(err.message ?? err).slice(0, 240));
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * The whole cart attempt for one job: the bounded ladder over `attemptCart`.
 *
 * Returns `{outcome, detail}` — `outcome` is what goes in `autocart_jobs.cart_outcome`
 * (EXACTLY `'carted'` on success; see cart-retry.mjs) and `detail` is the per-round trail
 * for `bot_events`.
 *
 * IT DOES NOT THROW. A throw here would skip `reportResult` entirely and leave the user's
 * alert waiting out the poller's full 35-second deadline, so every ending — including a
 * bug in this file — comes back as an outcome string.
 */
export async function cartRecGov(context, job, log, io = {}) {
  try {
    const r = await runCartLadder({
      addOnce: () => attemptCart(context, job, log),
      // THE RETRY'S CART RE-READ IS BOUNDED AND THE ONE INSIDE AN ATTEMPT IS NOT, on purpose.
      // `verifyCart`'s default 30s navigation is fine at the END of an attempt — the ladder
      // has already decided nothing more will start — but BETWEEN rounds it sits inside the
      // 25s budget, and one hung cart page would push the whole ladder past the poller's 35s
      // deadline and make the retry and the fallback alert run at the same time. Bounded to
      // ~10s worst case, and a timeout answers 'unknown', which means NOT re-adding.
      readCart: () => verifyCart(context, log, { gotoTimeoutMs: 6_000, polls: 8 }),
      wait: (ms) => new Promise((res) => setTimeout(res, ms)),
      log,
      ...io,
    });
    return {
      outcome: cartOutcomeForDb(r),
      detail: {
        campground: job.campgroundName,
        campsiteId: job.campsiteId ?? null,
        stay: `${job.startDate}→${job.endDate}`,
        outcome: r.outcome,
        rounds: r.rounds,
        elapsedMs: r.elapsedMs,
        trail: r.trail,
      },
    };
  } catch (err) {
    log(`  ✗ rec.gov cart ladder failed for ${job.campgroundName}: ${err.message}`);
    return { outcome: 'error', detail: { ladderError: String(err.message ?? err).slice(0, 240) } };
  }
}

// Confirm the site really landed in the cart. Polls the cart page for a definitive
// signal so we never report 'carted' on a silent add failure. Returns:
//   'ok'      → cart has an item (checkout affordance present)
//   'empty'   → cart page loaded and says it's empty (add didn't take)
//   'signin'  → cart bounced to sign-in (the rec.gov session has expired)
//   'unknown' → no definitive signal in time (treat as not-carted; fail closed)
//
// 'empty' AND 'unknown' ARE NOT THE SAME ANSWER and the caller must never merge them
// again: 'empty' is rec.gov stating a fact, 'unknown' is us failing to read one. The
// retry may re-add on the first and may only re-READ on the second.
async function verifyCart(context, log, { gotoTimeoutMs = 30000, polls = 14 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto('https://www.recreation.gov/cart', { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
    for (let i = 0; i < polls; i++) {
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
