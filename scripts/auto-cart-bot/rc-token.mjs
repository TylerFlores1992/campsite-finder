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
      /**
       * WHAT KIND OF AUTH DOES RC ACTUALLY USE? — recorded during a sign-in, so the next
       * move is chosen from fact.
       *
       * Measured 2026-08-08: the access token lives ~40-60 min, is never renewed, and a
       * reload returns the same cached value; when it expires the app holds nothing. So
       * "keep the session warm" is finished, and exactly one of these is true:
       *   • the app asked for `offline_access` and a REFRESH TOKEN is sitting in this
       *     profile — then `/oauth2/v1/token` mints new access tokens with no password,
       *     no CAPTCHA and no cookie, and the problem is solved outright;
       *   • it did not, and the only silent path is `authorize?prompt=none` against a
       *     persistent Okta session cookie;
       *   • neither, and a human sign-in per hold morning is the honest answer.
       *
       * All three are distinguishable from what crosses the wire at sign-in. Recorded on
       * `window` for the keep-warm to log LOCALLY; the token endpoint's response is
       * summarised to booleans and lifetimes — never the credential itself, which must
       * not travel anywhere.
       */
      const noteTokenCall = (url, init, res) => {
        try {
          if (!/\/oauth2\/[^/]*\/?v1\/token/i.test(String(url))) return;
          const body = String((init && init.body) || '');
          const params = new URLSearchParams(body);
          const summary = {
            grantType: params.get('grant_type'),
            clientId: params.get('client_id'),
            redirectUri: params.get('redirect_uri'),
            scope: params.get('scope'),
            usedPkce: params.has('code_verifier'),
          };
          window.__camphawkRcTokenCall = summary;
          if (res && typeof res.clone === 'function') {
            res.clone().json().then((j) => {
              window.__camphawkRcTokenGrant = {
                hasRefreshToken: Boolean(j && j.refresh_token),
                expiresIn: j && j.expires_in,
                scope: j && j.scope,
              };
            }).catch(() => {});
          }
        } catch { /* never break the page */ }
      };

      // LEARN THE APP'S OWN OIDC CALL, in case we ever have to make it ourselves.
      // RC is on Okta's org auth server with PKCE/S256, so a hand-built
      // `authorize?prompt=none` needs the real client_id, redirect_uri and a code
      // verifier — three things worth capturing from the app rather than guessing in the
      // one code path that has to work at 08:00. Recorded, never sent anywhere.
      const noteAuthorize = (url) => {
        try {
          const u = String(url);
          if (/\/oauth2\/[^/]*\/?v1\/authorize/i.test(u)) window.__camphawkRcAuthorize = u;
        } catch { /* ignore */ }
      };
      try {
        const op = window.open;
        window.open = function (u) { noteAuthorize(u); return op.apply(this, arguments); };
        // The silent flow is classically a hidden iframe; catch it as it is attached.
        const setSrc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
        if (setSrc && setSrc.set) {
          Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
            ...setSrc,
            set(v) { noteAuthorize(v); return setSrc.set.call(this, v); },
          });
        }
      } catch { /* ignore */ }

      const of = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = input && typeof input === 'object' && input.url ? input.url : input;
          noteAuthorize(url);
          if (isRC(url)) {
            readHeaders(init && init.headers);
            if (input && typeof input === 'object' && input.headers) readHeaders(input.headers);
          }
          const u = url;
          return of.apply(this, arguments).then((res) => { noteTokenCall(u, init, res); return res; });
        } catch { /* ignore */ }
        return of.apply(this, arguments);
      };
      const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { noteAuthorize(url); this.__chRC = isRC(url); } catch { this.__chRC = false; }
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
 * Everything we learned about RC's auth during this page's life. Diagnostics only —
 * logged locally on the mini-PC, never reported to the server. See noteTokenCall for why
 * this decides the next move.
 */
export async function readAuthFacts(page) {
  return page.evaluate(() => {
    try {
      return {
        authorizeUrl: window.__camphawkRcAuthorize ?? null,
        tokenCall: window.__camphawkRcTokenCall ?? null,
        grant: window.__camphawkRcTokenGrant ?? null,
      };
    } catch {
      return { authorizeUrl: null, tokenCall: null, grant: null };
    }
  });
}

/** The `/authorize` URL the app used, if we caught one. Diagnostics only. */
export async function readAuthorizeUrl(page) {
  return page.evaluate(() => {
    try { return window.__camphawkRcAuthorize ?? null; } catch { return null; }
  });
}

/**
 * Seconds of life left in a token, or null if it will not decode.
 *
 * Shared so the keep-warm and anything else agree on what "about to expire" means.
 */
export function tokenSecondsLeft(token) {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof json.exp === 'number' ? Math.round(json.exp - Date.now() / 1000) : null;
  } catch {
    return null;
  }
}

/**
 * RENEW THE SESSION THE WAY THE APP DOES — by re-bootstrapping it.
 *
 * This is the "silent auth" path, in the only form worth running. The textbook version is
 * to build `authorize?prompt=none` ourselves against the persistent "Keep me signed in"
 * cookie. RC is on Okta's ORG authorization server with PKCE/S256 (confirmed from
 * `signin.reservecalifornia.com/.well-known/openid-configuration`), so doing that by hand
 * means supplying the right `client_id`, the registered `redirect_uri`, and a code
 * verifier — three values we would be guessing, in the one code path that has to work at
 * 08:00:00 on the morning somebody is counting on it.
 *
 * A RELOAD runs exactly that exchange using the app's own code, which already holds all
 * three and stays correct when RC changes them. It is what a user pressing F5 does, it
 * needs no credential, and it never shows a CAPTCHA — the challenge lives on the password
 * form, not on a cookie exchange.
 *
 * The important difference from the old keep-warm is WHEN. That reloaded every 20 minutes
 * regardless, which is not the same as reloading BECAUSE the token is nearly out; and the
 * resident tab never reloads at all, so if the app's in-page renewal timer does not fire
 * the token simply runs down. This watches the clock and acts on it.
 *
 * Returns `{ renewed, before, after }` in seconds — `after > before` is the proof.
 */
export async function renewByReload(page, url) {
  const before = tokenSecondsLeft((await readLiveToken(page)).token);
  await page.evaluate(() => { try { delete window.__camphawkRcToken; } catch { /* ignore */ } });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const { token } = await primeToken(page, { timeoutMs: 20_000 });
  const after = tokenSecondsLeft(token);
  return { renewed: after != null && (before == null || after > before), before, after };
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


/**
 * Does an OKTA SESSION still exist in this profile?
 *
 * THIS IS THE QUESTION THE WHOLE DESIGN TURNS ON, and it is not the same question as
 * "is the access token valid".
 *
 * RC bundles **okta-auth-js** (its source is in the app's Route chunk). That SDK's
 * tokenManager has `autoRenew` ON by default and renews through `getWithoutPrompt` — a
 * hidden-iframe `authorize?prompt=none` against the Okta session cookie. When that renew
 * FAILS, the SDK removes the tokens from storage. Which is precisely the shape of what we
 * measured on 2026-08-08: the token was never renewed, and the moment it expired the app
 * held nothing at all.
 *
 * So the app is already attempting silent auth, unprompted, and failing. Reloading could
 * never have helped — we were trying to trigger something that was already running.
 *
 * What decides whether ANY unattended fix is possible:
 *   • session ACTIVE while the access token is dead → the cookie outlives the token, the
 *     silent exchange is being defeated by something local (iframe/cookie policy,
 *     third-party blocking), and driving `prompt=none` ourselves — or fixing the browser
 *     flags — is a real fix;
 *   • session GONE at the same moment → Okta is ending the org session on the same clock,
 *     nothing silent can work, and a human sign-in per hold morning is the honest answer.
 *
 * `/api/v1/sessions/me` is Okta's own endpoint for exactly this, answered from cookies
 * alone. 404/401 means no session. Returns `null` when we could not tell — never `false`,
 * which would be a verdict.
 */
export async function oktaSessionAlive(ctx) {
  try {
    // ctx.request, NOT page.fetch. From RC's page this is a CROSS-ORIGIN call to
    // signin.reservecalifornia.com, so the browser applies CORS and Okta — which only
    // allows configured trusted origins — makes it throw. The first version did exactly
    // that and reported `okta=unknown` on a perfectly healthy session: a measurement
    // defeated by the browser rather than by the answer.
    //
    // Playwright's request context is a Node-side fetch that shares the browser's COOKIE
    // JAR and is not subject to CORS, which is the same reason `sessionLive` uses it to
    // call RC's API. Cookies are what this question is about, so sharing the jar is the
    // only property that matters.
    const r = await ctx.request.get(
      'https://signin.reservecalifornia.com/api/v1/sessions/me',
      { headers: { accept: 'application/json' }, timeout: 20_000, failOnStatusCode: false },
    );
    const status = r.status();
    if (status === 404 || status === 401) return { alive: false, status, expiresAt: null };
    if (!r.ok()) return { alive: null, status, expiresAt: null };
    const j = await r.json().catch(() => null);
    return { alive: true, status, expiresAt: (j && j.expiresAt) || null };
  } catch (e) {
    return { alive: null, status: 0, expiresAt: null, why: String(e && e.message).slice(0, 120) };
  }
}
