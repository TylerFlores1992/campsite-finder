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
/**
 * `page.evaluate` WITH A DEADLINE, because it has none of its own.
 *
 * ── WHY (2026-08-17) ─────────────────────────────────────────────────────────────────────
 * The keep-warm wedged FOUR times in one day, each time entering the near-expiry renewal
 * (`src=live`, ~10m left) and never coming out:
 *
 *     15:42:58 renewing the session - the token has 10m left (src=live)
 *     15:55:58 x WEDGED - the keep-warm loop has not advanced in 13m.
 *
 * Every await inside `renewSession` carries an explicit timeout - 45s gotos, 25s and 30s
 * primes, a 10s control hunt - and they sum to about four minutes. It hung for thirteen. The
 * only unbounded awaits on that path were these three, and `readLiveToken` is the FIRST line
 * of `renewSession`.
 *
 * Playwright's `page.evaluate` waits forever: it needs an execution context, and a page whose
 * main thread is blocked or whose context is being replaced by a navigation simply never
 * provides one. Almost every other Playwright call takes `timeout`; this one does not, which
 * is exactly why it is the one that got written without a bound.
 *
 * ── WHAT IS PROVEN AND WHAT IS NOT ───────────────────────────────────────────────────────
 * PROVEN: these were unbounded, they are on the hanging path, and the declared timeouts
 * cannot account for the observed 13 minutes. NOT PROVEN: that this is what hung - nothing
 * recorded which await it was, and it could be a Playwright call failing to honour its own
 * timeout against an unresponsive browser. Do not write the cause into CLAUDE.md as fact.
 *
 * The bound is worth having either way. An unbounded await inside a loop whose only backstop
 * is a 12-minute wedge detector is a latent hang by construction, and the cost is not the
 * wedge itself: a wedged keep-warm HOLDS THE CHROMIUM PROFILE, the hold runner's preemption
 * is cooperative and needs the loop to notice the flag, so a wedge at 07:50 is an 08:00 cart
 * that cannot happen. That is 2026-08-10 exactly, when the same shape cost a campsite.
 *
 * A TIMEOUT HERE IS NOT A FAILURE, IT IS AN ABSENT READING. `readLiveToken` returning "no
 * token" because the page would not answer is the same shape as `hasAvailabilityInRange`
 * returning null - the callers already treat a missing token as "we could not tell" rather
 * than as "signed out", so the safe value falls out of the existing contract. The dangling
 * evaluate is deliberately abandoned rather than awaited: it cannot be cancelled, and the
 * point is to let the LOOP advance.
 */
const EVAL_TIMEOUT_MS = Number(process.env.RC_EVAL_TIMEOUT_MS || 20_000);

export function evaluateWithin(page, fn, arg, { timeoutMs = EVAL_TIMEOUT_MS, fallback = null } = {}) {
  let timer;
  return Promise.race([
    page.evaluate(fn, arg),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export async function readLiveToken(page) {
  // A page that will not answer is "we could not tell", which `source: 'none'` already means
  // to every caller — see evaluateWithin.
  return evaluateWithin(page, () => {
    try {
      if (window.__camphawkRcToken) return { token: window.__camphawkRcToken, source: 'live' };
      const ls = localStorage.getItem('ssoAccessToken') || localStorage.getItem('accessToken');
      return ls ? { token: ls, source: 'localStorage' } : { token: null, source: 'none' };
    } catch {
      return { token: null, source: 'none' };
    }
  }, undefined, { fallback: { token: null, source: 'none' } });
}

/** The origin RC keeps its tokens on. Okta's is a DIFFERENT one — that is the whole point. */
export const RC_TOKEN_ORIGIN = 'https://www.reservecalifornia.com';

/**
 * The token, WHATEVER PAGE WE HAPPEN TO BE PARKED ON.
 *
 * ── WHY (2026-08-18) ─────────────────────────────────────────────────────────────────────
 * `readLiveToken` reads the CURRENT page: `window.__camphawkRcToken` (set by the capture
 * hook, and wiped by any cross-origin navigation) or `localStorage` — which is
 * per-ORIGIN. RC's tokens live on `www.reservecalifornia.com`. Okta's sign-in lives on
 * `signin.reservecalifornia.com`. Those are two different storage areas.
 *
 * So during a sign-in, the success detector was reading the WRONG ORIGIN'S localStorage.
 * `sessionLive` starts with "no token in localStorage" and returns false WITHOUT ASKING
 * RC ANYTHING — so `attemptLogin`'s 90-second `isLive()` poll could not observe a success
 * while the page sat on Okta, no matter how well the sign-in had gone.
 *
 * Measured, 2026-08-18. Three sign-ins reported failure — 14:30, 14:39, 14:54 UTC — each
 * with the identical shape: password field found, password entered and submitted, then 90
 * seconds of `waiting for the session…`, then a verdict. Every one ended with the page at
 * `signin.reservecalifornia.com/oauth2/v1/authorize`, which the log printed itself. And
 * they had WORKED: Okta was `GONE (404)` at 13:44 and `ALIVE (exp +12h)` at 15:00, and
 * only a credential submission creates an Okta session. The 14:58 restart came up
 * `token source: live` and the 08:00 cart went in at T+1s.
 *
 * `context.storageState()` reads every origin's storage without navigating, so it cannot
 * be fooled by where the redirect chain happens to have stopped.
 *
 * THIS CAN ONLY TURN "no token" INTO "a token", NEVER THE REVERSE — the page is asked
 * first and its answer wins. And finding a token is not the same as being signed in: the
 * caller still POSTs it to RC and a stale one comes back 401. Presence is not liveness,
 * and that discipline is unchanged.
 */
export async function readTokenAnyOrigin(ctx, page) {
  const fromPage = await readLiveToken(page);
  if (fromPage.token) return fromPage;
  if (!ctx?.storageState) return fromPage;
  // Bounded like every other await on the sign-in path: an unanswerable browser must
  // degrade to "we could not tell", never to a hang. See evaluateWithin.
  const state = await Promise.race([
    ctx.storageState(),
    new Promise((resolve) => setTimeout(() => resolve(null), EVAL_TIMEOUT_MS)),
  ]).catch(() => null);
  const origin = state?.origins?.find((o) => o.origin === RC_TOKEN_ORIGIN);
  const items = origin?.localStorage ?? [];
  const pick = (name) => items.find((i) => i.name === name)?.value;
  const ls = pick('ssoAccessToken') || pick('accessToken');
  return ls ? { token: ls, source: 'storageState' } : fromPage;
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
 * ## IT NEVER RENEWED ANYTHING, AND THE LOG SAID SO FOR THREE DAYS (found 2026-08-12)
 *
 *     00:06:09 token has 10m left (src=live) — renewing by reload
 *     00:06:10   ✗ reload did NOT mint a fresher token (575s → 575s)
 *
 * **One second, and `before === after` to the second.** A navigation plus an SPA bootstrap
 * plus an OIDC round trip cannot happen in a second, and a failed renewal does not return
 * the identical number — that is the same token being read straight back.
 *
 * The first version deleted `window.__camphawkRcToken` — the page-scoped copy this file
 * captures — and left **`localStorage`** alone. That is the copy okta-auth-js decides from:
 * finding a still-valid token in storage at bootstrap, the SDK has nothing to do, so no
 * `/authorize` is ever issued. The app then makes its first API call with that same token,
 * the capture hook records it as `source: 'live'`, and `primeToken` returns it instantly.
 * **The renewal was measured against the very token it was supposed to replace.**
 *
 * The counter-evidence was in the same night's log. The login rehearsal clears
 * `ssoAccessToken`/`accessToken` from localStorage and reloads — and RC re-minted a token
 * from the live Okta session within seconds, with no credential typed. So the BOOTSTRAP
 * path works; it is the SDK's background `autoRenew` that does not. Clearing storage is
 * what makes a reload take the working path instead of the broken one.
 *
 * (The old failure line blamed "the Okta cookie may be gone" while `okta=ALIVE` sat on the
 * adjacent line, and `idx` — Okta Identity Engine's session cookie — is present in the
 * profile. Both facts contradicted the diagnosis being printed.)
 *
 * ## AND THE CORRECTED CLEAR STILL DID NOT RENEW — BECAUSE A PLAIN LOAD IS NOT THE
 *    BOOTSTRAP (measured 2026-08-15, and this is what the second stage is for)
 *
 * With the `okta-` store included in the clear, the reload was finally asking an honest
 * question, and the answer was no — twice, an hour apart, the token coming back older:
 *
 *     20:08:53 token has 9m left (src=live) — renewing by reload
 *     20:09:19   ✗ no fresher token after the reload (565s → 540s) — the previous token was put back
 *
 * **RC does not refuse to re-mint. Nothing was asking it to.** The same evening's log carries
 * the discriminating pair, and both halves are reproduced:
 *
 *   NEGATIVE — a plain load, from a genuinely token-less profile, with Okta ALIVE, produces
 *   nothing. Twice (18:46:50 and 22:22:37 `RC loaded and STAYING OPEN — token source: none`),
 *   the first of them sitting dead through two twenty-minute checks.
 *
 *   POSITIVE — a CLICK on RC's own sign-in control re-mints a FULL-LIFETIME token with no
 *   credential typed. Twice (19:18:38 and 22:26:05 `clicked a:has-text("Log in")`, each
 *   answered ~19s later by `token now 59m`).
 *
 * Fifty-nine minutes is the discriminator that separates this from the 2026-08-11 confound:
 * a restored stale copy carries its OLD expiry, which is exactly what the 540s line above
 * shows. A fresh hour can only have been minted.
 *
 * The mechanism follows: with no token in storage the SPA renders signed-out and simply
 * sits there — it issues no `/authorize` of its own. The sign-in control is what starts the
 * authorization-code flow, Okta answers it from the live `idx` cookie without showing a
 * form, and RC exchanges the code for a new hour. So the reload was necessary and never
 * sufficient, and every "RC will not renew" reading was a question nobody asked.
 *
 * **Both stages therefore run, and the result says WHICH produced the token.** Keeping the
 * reload stage is not sentiment: it is the standing measurement of whether the SDK's own
 * bootstrap ever starts working, and collapsing the two into one verdict is how "we did X"
 * and "X worked" became the same sentence twice already in this file.
 *
 * ## The clear is destructive, so the failure path must put it back
 *
 * Dropping the token to force a bootstrap risks a session that had ten minutes left. Three
 * rules make the worst case no worse than doing nothing:
 *   - **Never without a live Okta session.** No `idx`, no chance, and the clear is pure loss.
 *   - **Judge on a DIFFERENT token**, not merely on a live one, or this reintroduces the bug.
 *   - **Restore the exact keys** we emptied and reload, so the app ends up signed in on the
 *     old token rather than sitting on a signed-out page.
 *
 * ## NO CREDENTIAL IS EVER SUBMITTED HERE, AND THAT IS A PROPERTY, NOT A HABIT
 *
 * This module cannot sign in: it imports nothing from `rc-autologin.mjs`, and the click is
 * INJECTED by the caller as a callback. That is what lets the schedule ration this on its
 * own terms rather than borrowing the login's one-attempt-per-release budget — the ration
 * that exists because repeated logins from this address cost twelve hours of IP block on
 * 2026-08-06. A CAPTCHA lives on the password form, which this never reaches.
 * `worker/rc-token-renew.test.mts` asserts the property rather than trusting it.
 *
 * Returns `{ renewed, stage, before, after, restored, cleared, skipped }` — seconds, and a
 * token that is both NEW and further from expiry is the only thing counted as a renewal.
 */
/**
 * Empty the two keys okta-auth-js decides from, plus our own captured copy.
 *
 * ONE DEFINITION, TWO CALLERS, and that is deliberate. `renewSession` clears these to force
 * a bootstrap; `attemptLogin` clears them to force a signed-out state it can then sign into.
 * A second hand-rolled copy is how `renewByReload` came to delete `window.__camphawkRcToken`
 * and leave localStorage alone — which made it measure the renewal against the very token it
 * meant to replace, and report "RC will not renew" for weeks on no evidence at all.
 *
 * COOKIES ARE NEVER TOUCHED. `DT` is the device identity that stops a sign-in looking like a
 * fresh profile, and losing it is what cost twelve hours of IP block on 2026-08-06. Clearing
 * the token is the sanctioned way to get to a signed-out state; RC's own sign-out menu is not.
 */
/**
 * okta-auth-js namespaces ALL of its own storage under `okta-`.
 *
 * `ssoAccessToken`/`accessToken` are RC's OWN copies, which its app writes for its own use.
 * The SDK keeps a separate store (`okta-token-storage` and friends) and that is what it
 * decides from on boot — so clearing only RC's two copies leaves the SDK holding the same
 * token, which it hands straight back. Documented default keys are `okta-token-storage`,
 * `okta-cache-storage`, `okta-transaction-storage`, `okta-original-uri-storage`; matching the
 * PREFIX rather than a list means an SDK upgrade that adds a fifth cannot silently reopen
 * this. The reported key names (below) are how we find out if that assumption is wrong.
 */
const OKTA_STORAGE_PREFIX = 'okta-';
/** RC's own copies of the access token. */
const RC_TOKEN_KEYS = ['ssoAccessToken', 'accessToken'];

/**
 * Empty every persisted copy of the session token, and say exactly what was emptied.
 *
 * THE CLEAR WAS INCOMPLETE, AND THAT IS WHY THE RENEWAL NEVER WORKED (2026-08-15).
 * `renewByReload` cleared these two RC keys, reloaded, and got back a token 26 seconds older
 * than the one it dropped (`578s → 552s`). A page navigation wipes JS memory and
 * `window.__camphawkRcToken` was deleted, so **that token can only have come from another
 * PERSISTED copy** — the measurement forces it. `rc-probe.mjs` had already recorded the same
 * thing from the other end: "the whole session lives in localStorage, and copying that blob
 * DOES carry the login".
 *
 * SO THE 08-11 "RC RE-MINTED FROM THE OKTA SESSION" OBSERVATION IS CONFOUNDED. An incomplete
 * clear produces exactly that appearance — the app comes back signed in, with no credential
 * typed, because the token was never really gone. Nobody recorded whether that token had a
 * FRESH expiry, so it cannot be told apart from a survivor after the fact. This is the
 * "measuring the renewal against the token it meant to replace" bug in a second costume, and
 * it is why the fix here is to clear properly and MEASURE AGAIN rather than to conclude.
 *
 * Returns `{ snapshot, cleared }`. The snapshot is for an EXACT restore — the clear is
 * destructive and a failed renewal must leave the profile no worse than doing nothing, which
 * means putting back precisely what was taken, not a guessed subset.
 *
 * KEY NAMES ARE REPORTED, VALUES NEVER. A token is a credential and the rule here is not to
 * collect a field you then have to filter — the first version of the mobile report leaked an
 * OAuth authorization code exactly that way.
 */
export async function dropStoredToken(page) {
  // A timeout here reports NOTHING CLEARED, which is true and is the safe direction: the
  // caller then has an empty snapshot to restore and has not been told it emptied storage it
  // did not touch.
  return evaluateWithin(page, ({ prefix, rcKeys }) => {
    const snapshot = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (rcKeys.includes(k) || k.startsWith(prefix)) snapshot[k] = localStorage.getItem(k);
      }
      for (const k of Object.keys(snapshot)) localStorage.removeItem(k);
      delete window.__camphawkRcToken;
    } catch { /* ignore */ }
    return { snapshot, cleared: Object.keys(snapshot) };
  }, { prefix: OKTA_STORAGE_PREFIX, rcKeys: RC_TOKEN_KEYS },
     { fallback: { snapshot: {}, cleared: [] } }).catch(() => ({ snapshot: {}, cleared: [] }));
}

/** Put back exactly what `dropStoredToken` took. */
export async function restoreStoredToken(page, snapshot) {
  await evaluateWithin(page, (s) => {
    try { for (const [k, v] of Object.entries(s)) if (v != null) localStorage.setItem(k, v); }
    catch { /* ignore */ }
  }, snapshot).catch(() => {});
}

/**
 * @param onStep called with a short label as each stage begins. The caller uses it to name
 *   which await the loop stalled in — see `warmResident`'s watchdog. Deliberately a callback
 *   rather than a logger: this module has no business owning log formatting, and a no-op
 *   default keeps every other caller unchanged.
 *
 *   WHY IT EXISTS. Four wedges were recorded on 2026-08-17, each beginning at `renewing the
 *   session` and ending twelve minutes later at `the loop has not advanced` — and nothing
 *   recorded WHICH of the six awaits below was the one that never returned. That left the
 *   diagnosis at "somewhere inside renewSession", which is where it stayed for a day. Every
 *   step here is a plausible suspect and they need different fixes.
 */
export async function renewSession(
  page, url, { oktaAlive = null, clickSignIn = null, onStep = () => {} } = {},
) {
  onStep('renew:read-token');
  const previous = (await readLiveToken(page)).token;
  const before = tokenSecondsLeft(previous);

  // An explicit NO from the caller only. `null` means nobody asked, and refusing on an
  // unknown would switch this off permanently the first time the probe errored — the
  // "unknown is not dead" rule, applied to the thing that acts rather than the report.
  if (oktaAlive === false) {
    return { renewed: false, stage: 'skipped', before, after: before, restored: false, cleared: [],
      skipped: 'no Okta session to renew against', visitedOkta: false };
  }

  // WIDER THAN IT WAS, AND THE SNAPSHOT IS WHAT MAKES THAT SAFE. Clearing only RC's two
  // copies left okta-auth-js holding the same token in its own store, which is why every
  // renewal since this shipped measured a survivor rather than a re-mint.
  //
  // On a profile that already holds no token this takes nothing and restores nothing, so the
  // signed-out case — the one that cost ninety dead minutes on 2026-08-15 — costs no risk at
  // all. It is a pure click.
  onStep('renew:drop-stored-token');
  const { snapshot, cleared } = await dropStoredToken(page);

  onStep('renew:reload');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  onStep('renew:prime-after-reload');
  let { token } = await primeToken(page, { timeoutMs: 25_000, notToken: previous });
  let stage = 'reload';
  let visitedOkta = false;

  // STAGE TWO — THE ONE THAT HAS ACTUALLY BEEN OBSERVED TO WORK. See the header: a plain
  // load leaves the SPA sitting signed-out and issuing no `/authorize`, so the reload alone
  // has never re-minted anything. Clicking RC's own sign-in control starts the
  // authorization-code flow, which Okta answers from the `idx` cookie with no form.
  //
  // Guarded on the reload having failed, so the cheaper path still wins when it can, and on
  // the caller having supplied a click — this module deliberately cannot find that control
  // itself, because owning a selector list here is one import away from owning a password
  // field too.
  if (clickSignIn && !isRenewal({ previous, next: token, before, after: tokenSecondsLeft(token) })) {
    stage = 'authorize';
    onStep('renew:click-sign-in');
    const clicked = await clickSignIn(page).catch(() => false);
    // THE FACT THE CALLER NEEDS, REPORTED BY THE FUNCTION THAT KNOWS IT. A click here
    // navigates to `signin.reservecalifornia.com`, and on 2026-08-18 three token-less
    // renewals ten minutes apart separated cleanly on exactly this: the one that clicked
    // allocated 2.3 GB, the two that reached `no-signin-control` allocated nothing. The
    // caller recycles the browser on it, so it must be the click itself and never a guess
    // from `stage` — `none` and `authorize` both mean clicked, `no-signin-control` does not,
    // and that is three strings to keep in step across two files instead of one boolean.
    visitedOkta = clicked === true;
    if (!clicked) {
      // A REAL AND DISTINCT OUTCOME, not a shrug. On 2026-08-15 18:22 the clear did not sign
      // the SPA out — it went on rendering its signed-in banner — so no "Log in" anchor
      // existed, a different control matched, and nothing was started. Naming that keeps it
      // apart from "we asked and Okta said no", which needs a human and this does not.
      stage = 'no-signin-control';
    } else {
      onStep('renew:prime-after-click');
      ({ token } = await primeToken(page, { timeoutMs: 30_000, notToken: previous }));
    }
  }

  const after = tokenSecondsLeft(token);
  const renewed = isRenewal({ previous, next: token, before, after });
  if (!renewed && stage === 'authorize') stage = 'none';

  let restored = false;
  if (!renewed && Object.keys(snapshot).length) {
    // EXACTLY WHAT WAS TAKEN. The clear now spans the SDK's own storage as well, so a restore
    // that only put back `ssoAccessToken`/`accessToken` would leave the app holding a token
    // its SDK no longer knows about — strictly worse than never having tried, which is the
    // one outcome this guard exists to prevent.
    onStep('renew:restore-token');
    await restoreStoredToken(page, snapshot);
    // The bootstrap above decided this profile was signed out. Load once more so the app
    // reads the restored token and comes back up signed in, instead of leaving the resident
    // tab on a logged-out page with a perfectly good token sitting beside it.
    onStep('renew:reload-after-restore');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    restored = true;
  } else if (!renewed && stage !== 'reload') {
    // THE CLICK NAVIGATES, AND A FAILED ONE LANDS ON OKTA'S FORM. There was nothing to
    // restore here — this is the signed-out case, where the clear took nothing — so the
    // branch above does not run and without this the resident tab would be left parked on
    // `signin.reservecalifornia.com`. It is headful and sits on somebody's desktop: a
    // keep-warm displaying a login form invites exactly the hand sign-in that `rc-login.bat`
    // exists to do properly, and every later `readLiveToken` would be reading the wrong page.
    onStep('renew:reload-off-signin');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  }

  // `cleared` is the diagnostic that answers the next question. If a renewal still fails with
  // only the two RC keys listed here, the SDK's storage is somewhere else and the prefix
  // assumption is wrong — which is a fact worth having rather than another round of guessing.
  //
  // `stage` is the other one, and it is the reason both stages run rather than only the one
  // that works: `reload` would mean the SDK's own bootstrap has started working and this can
  // be simplified, `authorize` is the expected success, and `none` versus `no-signin-control`
  // separates "Okta refused" from "we never got as far as asking".
  return { renewed, stage, before, after, restored, cleared, skipped: null, visitedOkta };
}

/**
 * Is this actually a renewal? Pure, because the bug it guards was a wrong answer to exactly
 * this question and nothing else about the reload was wrong.
 *
 * **A token identical to the one we started with is never a renewal, whatever its clock
 * says.** That is the case the old code got wrong: it compared only the seconds remaining,
 * and reading the same token back gives `after === before`, which is not `>` — so it
 * reported failure rather than reporting that it had not looked properly. The distinction
 * matters because those two produce different next moves.
 */
export function isRenewal({ previous, next, before, after }) {
  if (!next) return false;
  if (previous != null && next === previous) return false;
  if (after == null) return false;
  // A TOKEN THAT HAS ALREADY EXPIRED IS NOT A RENEWAL, WHATEVER ELSE IS TRUE OF IT.
  //
  // Observed on the box 2026-08-17, from a token-less profile:
  //
  //     renewing the session — the app holds no usable token (src=none)
  //       ✓ renewed by authorize: none → -157885s
  //     … RC rejected a localStorage token (401)
  //
  // -157885s is a token that died ~44 hours earlier, and this function called it a success
  // because `before` was null and the final clause returns true for ANY token in that case.
  // Compare the genuine article from 2026-08-16: `none → 3580s`, a full fresh hour.
  //
  // Presence is not liveness — the same family as `notifications.status = 'sent'` meaning
  // only "Twilio returned 2xx", and as `attemptLogin` short-circuiting on `isLive()` when
  // the question was whether the session would still be alive at the release. Here the cost
  // is specific: a dead session reports itself REPAIRED, the renewal ration is spent on a
  // no-op, and the next thing to discover the truth is RC returning 401 — or 08:00.
  //
  // `> 0` rather than a comfortable margin, deliberately. The bar is "usable at all"; a
  // stricter floor would start rejecting genuine renewals that happen to arrive late, and
  // `requiredTokenSeconds` already owns the question of whether a live token is long enough.
  if (after <= 0) return false;
  return before == null || after > before;
}

/**
 * Nudge RC into making an authenticated call, so there is something to capture.
 *
 * A page that has finished loading and is sitting idle makes no requests, so a freshly
 * opened tab can genuinely have nothing to catch yet. Reloading is the cheap, honest way
 * to produce traffic — it is what the app does on any navigation anyway.
 *
 * `notToken` is for the renewal path: after clearing storage we are waiting for a token
 * that is not the one we just dropped, and accepting any live token would accept the old
 * one back if the app happens to replay it. Without this, "wait for a fresh token" and
 * "wait for a token" are the same call — which is how the renewal came to be measured
 * against itself.
 */
export async function primeToken(page, { timeoutMs = 15_000, notToken = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { token, source } = await readLiveToken(page);
    if (source === 'live' && (notToken == null || token !== notToken)) return { token, source };
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


/**
 * Which auth cookies exist in this profile — NAMES ONLY, never values.
 *
 * DISTINGUISHES THE TWO READINGS OF A 404. Okta answers `/api/v1/sessions/me` with 404
 * both when there is genuinely no session and when the request carried no session cookie,
 * and those mean opposite things:
 *   • a persistent Okta cookie present, far-future expiry → the session should exist and
 *     OUR request is wrong; the silent renew is fixable and no human is needed;
 *   • no cookie, or only a browser-session cookie that dies with the tab → RC never
 *     established a persistent session, the access token IS the whole session, and no
 *     amount of cleverness renews it. A human signs in per hold morning, full stop.
 *
 * That distinction decides whether unattended RC auto-cart is possible AT ALL, so it is
 * worth one extra call rather than one more confident guess.
 *
 * Values are deliberately not read. A session cookie is the credential itself — logging
 * it would put full account access in a plain-text file on the mini-PC, which is exactly
 * the property the whole "no credentials on the box" design protects.
 */
export async function authCookieSummary(ctx) {
  try {
    const all = await ctx.cookies(['https://signin.reservecalifornia.com', 'https://www.reservecalifornia.com']);
    return all.map((c) => ({
      name: c.name,
      domain: c.domain,
      httpOnly: c.httpOnly,
      // -1 (or absent) is a browser-SESSION cookie: it dies with the browser and can
      // never outlive a restart, which is the whole question here.
      persistent: typeof c.expires === 'number' && c.expires > 0,
      expiresInMin: typeof c.expires === 'number' && c.expires > 0
        ? Math.round((c.expires * 1000 - Date.now()) / 60000)
        : null,
    }));
  } catch {
    return [];
  }
}
