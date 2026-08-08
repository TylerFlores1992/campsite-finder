/**
 * The LIVE ReserveCalifornia access token — caught off RC's own requests.
 *
 * ## Why localStorage is the wrong place to look
 *
 * From `extension/rc-inject.js`, which has said so since it was written: *"RC's auth token
 * is stored AES-encrypted by Okta and only decrypted in the page's JS memory."* The
 * `ssoAccessToken` / `accessToken` keys are not the credential the app is actually
 * sending. They can be stale, and on a long-lived page they routinely are.
 *
 * The browser extension exists in the shape it does entirely because of this: it has to
 * run a MAIN-world script at `document_start` and wrap `fetch`/`XHR` to catch the
 * `accesstoken` header off RC's own API calls as they go past. An isolated-world content
 * script — or a `page.evaluate` reading localStorage — cannot see the real one.
 *
 * ## What that cost us
 *
 * Both `rc-keepwarm.mjs` and `rc-hold-runner.mjs` read localStorage. So:
 *   • the keep-warm's liveness probe POSTed a STALE token to `load/shoppingcart`, got a
 *     401, and reported **"RC REJECTED the session — a human must sign in"** — about a
 *     session that may have been perfectly healthy. Observed 2026-08-08: a session
 *     reported dead 13 minutes after sign-in, with the localStorage token's own `exp`
 *     already 3 hours in the past AT the moment we called it alive. A token that was
 *     expired when we said "warm" is not the token the app was using.
 *   • the hold runner precarts with the same value, so a stale one turns a cart into a
 *     401 at 08:00:00.
 *
 * It also means every conclusion drawn from that probe is suspect — the "1h20m session
 * lifetime", the "keep-warm never renews anything". Those may have been measurements of
 * our own stale read rather than of RC. Do not treat them as established.
 *
 * ## How this works
 *
 * `page.addInitScript` runs in the page's own world before any page script, which is the
 * same position the extension buys with `world: MAIN`. It wraps `fetch` and
 * `XMLHttpRequest.setRequestHeader`, stashes the newest `accesstoken`/`authorization`
 * value on `window.__camphawkRcToken`, and never sends it anywhere — we read it back with
 * `page.evaluate`.
 *
 * MUST be installed BEFORE the first navigation, or the calls that carry the token have
 * already gone past.
 */

/**
 * Wrap fetch/XHR in every page of this context. Call right after launching it.
 *
 * ONLY RESERVECALIFORNIA'S OWN REQUESTS COUNT. The first version captured
 * `authorization` off ANY request the page made, which is a page full of third parties —
 * analytics, maps, Okta itself — each with its own bearer. The symptom was immediate and
 * confusing: a token that captured as `src=live`, would not decode as a JWT (`token exp
 * unknown`), and got a 401 from `load/shoppingcart`, which reads exactly like a dead
 * session. It was somebody else's credential.
 *
 * `accesstoken` is preferred over `authorization` for the same reason — it is RC's own
 * bespoke header, so it cannot be confused with anyone else's scheme.
 */
export async function installTokenCapture(ctx) {
  await ctx.addInitScript(() => {
    try {
      const isRC = (url) => {
        try { return /(^|\.)reservecalifornia\.com/i.test(new URL(String(url), location.href).hostname); }
        catch { return false; }
      };
      const keep = (v) => {
        if (!v) return;
        const t = String(v).replace(/^Bearer\s+/i, '').trim();
        // A short value is a header we mis-read, not a token.
        if (t.length > 20) window.__camphawkRcToken = t;
      };
      const readHeaders = (h) => {
        try {
          if (!h) return;
          // accesstoken FIRST — RC's own header, unambiguous.
          if (typeof h.get === 'function') { keep(h.get('accesstoken') || h.get('authorization')); return; }
          let auth = null;
          for (const k of Object.keys(h)) {
            if (/^accesstoken$/i.test(k)) { keep(h[k]); return; }
            if (/^authorization$/i.test(k)) auth = h[k];
          }
          keep(auth);
        } catch { /* never break the page */ }
      };
      const of = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = input && typeof input === 'object' && input.url ? input.url : input;
          if (isRC(url)) {
            readHeaders(init && init.headers);
            if (input && typeof input === 'object' && input.headers) readHeaders(input.headers);
          }
        } catch { /* ignore */ }
        return of.apply(this, arguments);
      };
      const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__chRC = isRC(url); } catch { this.__chRC = false; }
        return oo.apply(this, arguments);
      };
      const os = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          // setRequestHeader does not know the URL, so `open` records it on the instance.
          if (this.__chRC && /^accesstoken$/i.test(name)) keep(value);
          else if (this.__chRC && /^authorization$/i.test(name)) keep(value);
        } catch { /* ignore */ }
        return os.apply(this, arguments);
      };
    } catch { /* a capture failure must never stop the page loading */ }
  });
}

/**
 * The live token if RC has made a call we caught, else the localStorage copy.
 *
 * Returns `{ token, source }` — the SOURCE matters. A `localStorage` answer is a guess
 * that has already produced a false "session is dead" once, so anything acting on it
 * should say which it used rather than presenting both as the same fact.
 */
export async function readLiveToken(page) {
  return page.evaluate(() => {
    try {
      if (window.__camphawkRcToken) return { token: window.__camphawkRcToken, source: 'live' };
      const ls = localStorage.getItem('ssoAccessToken') || localStorage.getItem('accessToken');
      return ls ? { token: ls, source: 'localStorage' } : { token: null, source: 'none' };
    } catch {
      return { token: null, source: 'none' };
    }
  });
}

/**
 * Nudge RC into making an authenticated call, so there is something to capture.
 *
 * A page that has finished loading and is sitting idle makes no requests, so a freshly
 * opened tab can genuinely have nothing to catch yet. Reloading is the cheap, honest way
 * to produce traffic — it is what the app does on any navigation anyway.
 */
export async function primeToken(page, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { token, source } = await readLiveToken(page);
    if (source === 'live') return { token, source };
    if (Date.now() >= deadline) return { token, source };
    await page.waitForTimeout(500);
  }
}
