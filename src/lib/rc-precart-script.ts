import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginScript } from './rc-login-script';

/**
 * Serves the ReserveCalifornia precart script, for injection into a mobile in-app webview.
 *
 * ## Why a route and not a copy of the logic
 *
 * `extension/content-rc.js` is 332 lines of behaviour that cost real time to get right:
 * RC's two-step load-then-submit precart, the `extraValues` contract it answers HTTP 200
 * with `IsSuccess: false` if you omit, and unit-specific defaults captured from a live
 * add-to-cart. Writing a second version for the phone would create two implementations of
 * one wire contract, which this codebase has a standing rule against — `rc-cart.mjs` is
 * shared between the probe and the runner for exactly this reason, and RC has already
 * changed the payload once (2026-08-06).
 *
 * So the extension file IS the source, and this hands the same bytes to the phone. The
 * extension keeps using its own copy directly, because MV3 forbids remote code — one file,
 * two consumers, no drift possible.
 *
 * ## The property that makes this worth a route rather than bundling into the app
 *
 * The script updates with a WEB deploy. If it were bundled into the binary, every RC
 * schema change would need an app release and a review — and RC changes things without
 * telling anyone. This way a broken precart is a push to master, exactly like the rest of
 * the alerting stack.
 *
 * ## What is added on top, and why each piece is needed
 *
 * The extension script assumes two things a bare injection does not provide:
 *
 *   1. `chrome.storage.local` — it reads the user's opt-in before carting. There is no
 *      `chrome` in a webview, and the consent question is already answered: the user tapped
 *      "claim" thirty seconds ago, which is a stronger opt-in than a checkbox set once.
 *      Shimmed to yes rather than removed, so the extension file needs no edit.
 *   2. `rc-inject.js` — the MAIN-world script that captures the live `accesstoken` off RC's
 *      own requests, because the localStorage copy is AES-encrypted and unusable (see
 *      rc-token.mjs, and the day lost to reading it anyway). `content-rc.js` waits for its
 *      postMessage. Injected code runs in the page world already, so shipping both in
 *      order gives the same arrangement the extension has.
 *
 * ## Not a secret
 *
 * This is the source of a published browser extension. Serving it publicly gives away
 * nothing that `chrome-extension://` inspection does not, and it carries no credential —
 * the token it uses is the user's own, read in their own session, and never leaves the
 * device. Public so the webview can fetch it without an auth dance at 08:00:00.
 */

/**
 * The report channel — how we find out what happened INSIDE the webview.
 *
 * ## Why this exists
 *
 * Everything else about the injection is unobservable from the app. `executeScript` takes
 * code and returns nothing useful; a script that threw on line 1, a script that ran and
 * found no hold, and a script that carted successfully are the same silence. That is the
 * shape of failure this codebase keeps getting caught by — `notifications.status = 'sent'`
 * meaning only "Twilio returned 2xx", `IsSuccess: true` on a cart that held nothing, the
 * hold runner reporting a healthy session because *a* token existed. So the injection gets
 * a way to say what it did before it is trusted at 08:00:00.
 *
 * ## The transport
 *
 * `cordova_iab` is an `addJavascriptInterface` binding installed when the webview is
 * created, so it is present from the first script evaluation. `window.webkit.messageHandlers
 * .cordova_iab` is the iOS-native form, which the Android plugin also aliases — but it
 * aliases it in `onPageFinished`, via an async `evaluateJavascript`, which races our
 * `loadstop` injection. **Prefer the raw global and fall back to the webkit shape**, or
 * roughly the first report of every run is silently dropped on Android.
 *
 * ## What may and may not be reported
 *
 * Reports cross from RC's origin into our app. They carry stage names, RC's own user-facing
 * status text, and BOOLEANS about the token — never the token, never the cart key, never a
 * password. The RC access token is full account access and does not travel, the same rule
 * that keeps it out of alert links. `scrub()` is a second line of defence, not the first:
 * nothing here is supposed to contain a JWT in the first place.
 *
 * **URLs are reported as origin + pathname, never with the query.** Okta signs in inside
 * this webview, so mid-flow `location.href` is `/login/callback?code=…&state=…` — an OAuth
 * authorization code, exchangeable for the session. The first run of this diagnostic put one
 * on screen (2026-08-09). A `scrub()` that only knew JWT shapes did not save it, which is
 * the argument for not collecting the field at all rather than filtering it afterwards.
 */
export function reporter(): string {
  return [
    '(function () {',
    '  // Re-injected on every loadstop (RC is an SPA and the adopt path reloads). Install',
    '  // once: a second pass would re-wrap console.log around the already-wrapped copy.',
    '  if (window.__camphawkRc) { window.__camphawkRc.send("reinjected", { href: window.__camphawkRc.href() }); return; }',
    '  var bridge = null;',
    '  try {',
    '    bridge = (typeof cordova_iab !== "undefined" && cordova_iab && cordova_iab.postMessage)',
    '      ? cordova_iab',
    '      : ((window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cordova_iab) || null);',
    '  } catch (e) { bridge = null; }',
    '  var n = 0;',
    '  // Belt and braces — see the route header. Also caps length: RC error bodies are HTML.',
    // DROP WEBKIT'S SOURCE QUOTE BEFORE ANYTHING ELSE.
    //
    // Safari formats a TypeError as `X is not a function. (In 'SOURCE', 'X' is undefined)` —
    // and SOURCE is the failing expression, verbatim. On 2026-08-16 that expression was the
    // sign-in invocation, so a user's real ReserveCalifornia password was reported through
    // this function and stored in `client_reports`. This regex knew JWT shapes and went
    // straight past it, exactly as it went past an OAuth authorization code on 2026-08-09.
    //
    // The real fix is upstream — `loginInvocation` binds credentials to locals so no call
    // expression can contain one (see its header). This is the second layer, and it is here
    // because the first layer only protects the one call site anybody thought about: ANY
    // future expression that touches a secret gets quoted the same way, and the leak would
    // again look like an ordinary error message.
    //
    // The half that carries the diagnosis ("X is not a function") is kept. The source quote
    // never carried any, which is why dropping it costs nothing.
    '  function scrub(s) {',
    '    return String(s == null ? "" : s)',
    '      .replace(/\\s*\\(In \'[\\s\\S]*$/, "")',
    '      .replace(/eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*/g, "<token>")',
    '      .slice(0, 300);',
    '  }',
    '  // ORIGIN + PATH ONLY, NEVER THE QUERY. RC signs in through Okta inside this webview,',
    '  // so mid-flow the URL is `/login/callback?code=…&state=…` — an OAuth authorization',
    '  // code, which is exchangeable for the session itself. Reporting `location.href` put',
    '  // one on screen the first time this ran (2026-08-09). The path alone still says which',
    '  // step we are on, which is the whole diagnostic value; the query never was.',
    '  function href() { try { return location.origin + location.pathname; } catch (e) { return "?"; } }',
    '  function post(stage, detail) {',
    '    if (!bridge || !bridge.postMessage) return;',
    '    try {',
    '      bridge.postMessage(JSON.stringify({',
    '        camphawk: "rc-precart", n: ++n, stage: String(stage), detail: detail || null,',
    '      }));',
    '    } catch (e) {}',
    '  }',
    '  // COLLAPSE CONSECUTIVE DUPLICATES. rc-inject.js rebroadcasts the token on every RC API',
    '  // call, which is dozens of identical lines in a quiet minute — and at 08:00:00 that',
    '  // would bury the one line anybody needs, which is what the cart did. The count is kept',
    '  // and emitted rather than dropped: "token seen 31 times" and "token seen once" are',
    '  // different facts about whether the session is being used.',
    // ...AND CONSECUTIVE WAS NOT ENOUGH. Read off two real hand-offs on 2026-08-13, and it
    // is the failure this collapse was written to prevent, arriving through the one door it
    // left open: rc-inject.js broadcasts the token AND the cart key on every RC call, so the
    // stream is `token, cartkey, token, cartkey, …` and **no two neighbours are ever
    // identical**. Nothing collapsed. Both runs stored forty reports of which thirty-nine
    // were that pair, `recordClientReports` keeps the TAIL, and the `✓ Added to cart` line —
    // the entire point of the channel, on the two holds that settled the question — was
    // trimmed off the front. The proof survived in a screenshot and not in the instrument.
    //
    // So the mechanical rebroadcasts are deduped against everything already sent this run,
    // not merely against the previous line. Scoped to `token` and `cartkey` deliberately: a
    // repeated `status` may be real news (RC's own text can go A → B → A), and swallowing
    // one of those would cost exactly what this is trying to save.
    '  var NOISY = { token: 1, cartkey: 1 };',
    '  var lastKey = null, lastStage = null, dupes = 0, sent = {};',
    '  function flush() { if (dupes) { post("repeated", { of: lastStage, times: dupes }); dupes = 0; } }',
    '  function send(stage, detail) {',
    '    var key;',
    '    try { key = stage + "|" + JSON.stringify(detail || null); } catch (e) { key = stage + "|?"; }',
    '    if (key === lastKey) { dupes++; return; }',
    '    if (NOISY[stage] && sent[key]) { lastStage = stage; dupes++; return; }',
    '    flush();',
    '    lastKey = key; lastStage = stage; sent[key] = 1;',
    '    post(stage, detail);',
    '  }',
    '  function hasStash() { try { return !!sessionStorage.getItem("camphawk_rc"); } catch (e) { return false; } }',
    // WHAT THE TOKEN SAYS ABOUT ITSELF — never what it is.
    //
    // `captured: true` was PRESENCE, and presence is the exact conflation that produced a
    // false green over a dead session on 2026-08-09: the hold runner announced a healthy
    // session because *a* token existed, six minutes after it had expired. `exp` is the
    // liveness the report is entitled to claim, and `iat` is what separates "the session
    // was already working" from "RC just minted this one" — the whole open question about
    // whether the app can renew silently.
    //
    // Decoded LOCALLY, exactly like the bot's `tokenSecondsLeft`, and only the two numbers
    // travel. A network probe would be the wrong instrument anyway: at 08:00:00 nothing may
    // go in front of the precart.
    '  function jwtFacts(t) {',
    '    var out = { decodable: false, expiresInSec: null, ageSec: null };',
    '    try {',
    '      var p = String(t).split(".")[1];',
    '      if (!p) return out;',
    '      var b = p.replace(/-/g, "+").replace(/_/g, "/");',
    '      while (b.length % 4) b += "=";',
    '      var j = JSON.parse(atob(b));',
    '      out.decodable = true;',
    '      if (typeof j.exp === "number") out.expiresInSec = Math.round(j.exp - Date.now() / 1000);',
    '      if (typeof j.iat === "number") out.ageSec = Math.round(Date.now() / 1000 - j.iat);',
    '    } catch (e) {}',
    '    return out;',
    '  }',
    // HAS THIS WEBVIEW GOT A SESSION? — the fact the sign-in needs, and the one nothing
    // was providing.
    //
    // `rc-login-script.ts` asked `window.__camphawkRcToken` in three places: the
    // already-signed-in short-circuit, the no-password-step exit, and the loop that decides
    // a submitted password WORKED. **Nothing in this bundle has ever set that global.** It
    // belongs to `rc-token.mjs`'s Playwright capture, which runs on the BOT's box; in a
    // webview `rc-inject.js` broadcasts a postMessage instead and no one assigns it. So all
    // three reads were permanently false, and the third one is the expensive half: a sign-in
    // that succeeded ran its 120-second poll to the end and then reported
    // `login-result {ok:false, reason:"signed in but no session appeared"}` — a FAILURE over
    // a working session, on the screen a user is standing on at 08:00. That is the
    // 2026-08-09 banner trap for the fourth time, and it was written from memory rather than
    // read, which is the mistake this file's own `chSay` comment already records.
    //
    // The reporter is the right owner because it is already the one thing watching the token
    // broadcast. It keeps FACTS, never the token: whether one has been seen, and when the
    // one we could decode runs out.
    //
    // EXPIRY IS PART OF THE ANSWER, deliberately matching what the claim screen does with
    // the same event. A token whose `exp` has passed cannot cart, and treating it as a
    // session is what let a release happen against a 23-hour-dead one on 2026-08-21. An
    // UNDECODABLE token counts as live — that is "we could not tell", and refusing on it
    // would make a webview we cannot read into a webview we refuse to sign in, which is the
    // wrong direction. Same three-valued rule as `sessionAcceptable`.
    '  var tokenSeen = false, tokenDeadlineMs = null;',
    '  function noteToken(f) {',
    '    tokenSeen = true;',
    '    if (f && typeof f.expiresInSec === "number") tokenDeadlineMs = Date.now() + f.expiresInSec * 1000;',
    '  }',
    '  function signedIn() {',
    '    if (!tokenSeen) return false;',
    '    return tokenDeadlineMs === null || tokenDeadlineMs > Date.now();',
    '  }',
    '  window.__camphawkRc = { send: send, scrub: scrub, hasStash: hasStash, href: href, jwtFacts: jwtFacts, onToken: null, signedIn: signedIn, bridged: !!bridge };',
    '  // A run that ends on a repeat would otherwise lose the tail of the count.',
    '  window.addEventListener("pagehide", flush);',
    '  window.addEventListener("error", function (e) { send("error", { message: scrub(e && e.message) }); });',
    '  // rc-inject.js broadcasts the live access token to the content script. Reporting that',
    '  // it was CAPTURED — never its value — proves the hardest link in the chain (we can read',
    '  // an authenticated RC session inside this webview) without carting anything, which',
    '  // would lock a real unit and take it off the market.',
    // THE TIMING FACTS RIDE ONLY THE FIRST SIGHTING OF EACH DISTINCT TOKEN, and that is not
    // tidiness. `expiresInSec` counts down, so putting it on every rebroadcast would make
    // each of rc-inject's ~20 replays a DIFFERENT payload — defeating the duplicate collapse
    // directly above and burying the cart's own status under a flood at 08:00:00, which is
    // the failure that collapse was added for. A repeat reports presence only and folds.
    //
    // Keyed on the token's VALUE, so a genuine mid-session renewal reports its facts again
    // rather than being swallowed as a repeat — that event is the measurement, not noise.
    '  var seenToken = null;',
    '  window.addEventListener("message", function (e) {',
    '    if (e.source !== window || !e.data) return;',
    '    if (e.data.__camphawk_token) {',
    '      var t = String(e.data.__camphawk_token);',
    '      if (t !== seenToken) {',
    '        seenToken = t;',
    '        var f = jwtFacts(t);',
    '        noteToken(f);',
    '        try { if (window.__camphawkRc && window.__camphawkRc.onToken) window.__camphawkRc.onToken(f); } catch (err) {}',
    '        send("token", { captured: true, length: t.length, decodable: f.decodable, expiresInSec: f.expiresInSec, ageSec: f.ageSec });',
    '      } else {',
    '        send("token", { captured: true, length: t.length });',
    '      }',
    '    }',
    '    if (e.data.__camphawk_cartkey) send("cartkey", { captured: true });',
    '  });',
    '  var log = console.log;',
    '  console.log = function () {',
    '    try {',
    '      var m = Array.prototype.map.call(arguments, String).join(" ");',
    '      if (m.indexOf("[CampHawk RC]") === 0) send("log", { message: scrub(m) });',
    '    } catch (e) {}',
    '    return log.apply(console, arguments);',
    '  };',
    '  send("injected", { href: href(), job: /camphawk-rc=/.test(location.hash) || hasStash() });',
    '})();',
  ].join('\n');
}

/**
 * Watches the precart's own status line and forwards it verbatim.
 *
 * `#camphawk-rc-status` is where `setStatus()` writes, and EVERY outcome in content-rc.js
 * goes through it — "Reading your session…", "Adding to your cart…", "✓ Added to cart",
 * "RC declined (…)". Observing the DOM rather than reimplementing the logic means the
 * diagnostic and the user's own screen cannot disagree, and content-rc.js needs no edit,
 * so the extension's copy stays byte-identical.
 */
export function epilogue(): string {
  return [
    '(function () {',
    '  var R = window.__camphawkRc; if (!R) return;',
    '  setTimeout(function () {',
    '    var el = document.getElementById("camphawk-rc-status");',
    '    if (!el) {',
    '      // TWO DIFFERENT FACTS, deliberately not one sentence. "Nothing to do" and "there',
    '      // was a job and it bailed anyway" have different fixes.',
    '      var job = /camphawk-rc=/.test(location.hash) || R.hasStash();',
    '      R.send("idle", job',
    '        ? { reason: "a hold was in the link but no banner rendered — the script exited early" }',
    '        : { reason: "no hold in this link — the script ran and had nothing to cart" });',
    '      return;',
    '    }',
    '    R.send("banner", { status: R.scrub(el.textContent || "(empty)") });',
    '    try {',
    '      new MutationObserver(function () { R.send("status", { status: R.scrub(el.textContent || "") }); })',
    '        .observe(el, { childList: true, characterData: true, subtree: true });',
    '    } catch (e) { R.send("error", { message: "status observer failed: " + R.scrub(e && e.message) }); }',
    '  }, 0);',
    '})();',
  ].join('\n');
}

/**
 * THE SESSION PROBE — what state did we ARRIVE in, and what does that prove?
 *
 * ## The question
 *
 * The mobile claim flow needs a live RC session inside this webview's data store, and the
 * owner has had to sign in again on every claim — once, on 2026-08-12, INSIDE the 08:00
 * window this whole design exists to protect. "Sign in once and it persists" was
 * over-claimed: the 2026-08-09 tests measured persistence across closing the webview and
 * force-closing the app, on the SAME DAY. Nothing measured days, and RC's own lifetimes
 * (~1h access token, ~12h Okta session) apply inside the app exactly as they do to the bot.
 *
 * Three states look identical from outside — the user is asked to sign in, and that is all
 * anybody sees:
 *
 *   1. the access token expired, but the Okta session cookie is alive → the SPA can
 *      re-mint silently, so signing in is about once every 12 hours, not once per claim;
 *   2. the Okta session expired too → a credential is genuinely required;
 *   3. the webview's storage was PURGED (iOS ITP caps script-writable storage at ~7 days
 *      without interaction) → also a credential, but nothing about renewal is wrong and
 *      no amount of renewing fixes it.
 *
 * Building a renewal before those can be told apart is how you ship a fix for the wrong
 * one. So this measures, and it is deliberately non-destructive: nothing is cleared,
 * nothing is carted.
 *
 * ## Why a marker, and why the PREVIOUS open's token is the primary evidence
 *
 * Injection happens at `loadstop`, by which time RC's SPA has already booted — so a token
 * found in storage NOW may be one the SDK minted seconds ago, and reading it proves
 * nothing about what we arrived to. That is the same shape as `renewByReload` measuring
 * the renewal against the very token it meant to replace (found 2026-08-12), and it would
 * be an easy mistake to repeat here.
 *
 * The marker fixes it by writing down the token's expiry AT THE END OF EACH OPEN. On the
 * next open we therefore know what the storage held before RC touched anything. If that
 * recorded expiry is already in the past and a live token nonetheless turns up, the SPA
 * re-minted it from the Okta session cookie with no credential typed — which is the answer
 * to the open question, obtained without clearing anybody's storage.
 *
 * The marker's ABSENCE is the second measurement, and it is the only way to see an ITP
 * purge at all: a wipe takes RC's tokens and our marker together, so "no marker" means the
 * data store was emptied, while "marker, no token" means storage survived and the session
 * merely ran out. Those two need different fixes and were previously the same event.
 *
 * ## What it writes, and what it may say
 *
 * `camphawk_rc_probe` in RC's own localStorage, inside our isolated webview store: a
 * version, two timestamps, a counter, and the token's expiry as a NUMBER. **Never a token,
 * never a cart key, never a URL query.** Everything reported is a fact — the verdict is
 * computed on the server (lib/rc-session-verdict), where it can be tested; a script that
 * both gathers evidence and reaches a conclusion is one that cannot be checked.
 *
 * The marker is evidence about SCRIPT-WRITABLE storage, not about the HttpOnly Okta
 * cookies, which nothing on this origin can see. A purge takes both together, so it is a
 * good proxy — but it is a proxy, and the verdict says so rather than claiming to have
 * read a cookie it cannot read.
 */
export function sessionProbe(): string {
  return [
    '(function () {',
    '  var R = window.__camphawkRc; if (!R) return;',
    // Once per document. `loadstop` fires again on every navigation inside the webview, and
    // a second pass would count another "open" seconds after the first — turning the gap
    // between opens, which is the whole days-long measurement, into zero.
    '  if (window.__camphawkRcProbed) return;',
    '  window.__camphawkRcProbed = true;',
    '  var KEY = "camphawk_rc_probe";',
    '  var now = Date.now();',
    '  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }',
    '  var prev = null;',
    '  try { var raw = get(KEY); prev = raw ? JSON.parse(raw) : null; } catch (e) { prev = null; }',
    '  if (prev && prev.v !== 1) prev = null;',
    '  function save(tokenExp) {',
    '    try {',
    '      localStorage.setItem(KEY, JSON.stringify({',
    '        v: 1,',
    '        first: (prev && prev.first) || now,',
    '        last: now,',
    '        opens: ((prev && prev.opens) || 0) + 1,',
    '        tokenExp: typeof tokenExp === "number" ? tokenExp : (prev ? prev.tokenExp : null),',
    '      }));',
    '    } catch (e) {}',
    '  }',
    // WRITTEN BEFORE ANY TOKEN ARRIVES, so an open that finds nothing still records that it
    // happened. Without that, a run of signed-out opens would be invisible and the next
    // successful one would compare itself against a stale expiry from days earlier.
    '  save(null);',
    // The stored copy is the WEAKER evidence — see the header — but "there was nothing here
    // at all" is still worth having: it agrees with an expired marker and disagrees with a
    // silent re-mint that beat us to the injection.
    '  var stored = get("ssoAccessToken") || get("accessToken");',
    '  var sf = stored ? R.jwtFacts(stored) : null;',
    // THE STORE THAT ACTUALLY DECIDES WHETHER RC LOOKS SIGNED IN.
    //
    // `ssoAccessToken` and `accessToken` above are RC's OWN copies. okta-auth-js keeps its
    // own under the `okta-` prefix and decides login state from THAT on boot — which is
    // exactly why `dropStoredToken` had to be widened past those two keys on 2026-08-15,
    // after a clear that touched only them "never asked RC anything".
    //
    // So every reading this probe has ever taken was blind to the one store that matters,
    // and that is the gap under investigation: on 2026-08-30 a hand-off reported
    // `storedToken: "jwt"` with 3,534 seconds on it while RC's own page asked the user to
    // log in. Those two facts are only contradictory if you assume one store.
    //
    // WHAT SPLITS THE SPACE: `okta-` holding no live token beside a live `ssoAccessToken`
    // means the SDK never finished its half, and the fix is in the sign-in completion.
    // `okta-` populated means the SPA has everything it needs and the problem is elsewhere
    // — the free-floating cart (`CustomerId: 0`, 2026-08-06). Different investigations.
    //
    // NAMES, COUNT AND SHAPE. NEVER A VALUE. Every value in this store is or contains the
    // session, and this repo has published a credential twice by collecting a field it then
    // had to filter — an OAuth code on 2026-08-09, a password on 08-16. A key name is
    // structural (`okta-token-storage`, `okta-cache-storage`), a count is a count, and a
    // locally-decoded `exp` identifies a corpse without being replayable. The token itself
    // is never read out, only matched against and measured.
    //
    // AND THE COUNT ALONE WOULD MISLEAD, which is why the shape is reported beside it. The
    // 08-15 sweep found exactly one `okta-` key and it was `okta-original-uri-storage`, a
    // redirect breadcrumb with no token in it. "One key" and "a session" are not the same
    // reading, and a probe that reported only the number would have said they were.
    '  var oktaNames = [], oktaTok = "none", oktaExp = null, oktaN = 0;',
    '  try {',
    '    for (var oi = 0; oi < localStorage.length; oi++) {',
    '      var ok = localStorage.key(oi);',
    '      if (!ok || String(ok).slice(0, 5).toLowerCase() !== "okta-") continue;',
    '      oktaN++;',
    // Bounded on both axes: eight names, forty characters each. okta-auth-js uses a handful
    // of fixed names, so anything past that is not this library and is not worth the room.
    '      if (oktaNames.length < 8) oktaNames.push(String(ok).slice(0, 40));',
    '      if (oktaTok === "jwt") continue;',
    '      var oraw = get(ok) || "";',
    // The token sits INSIDE a JSON envelope (`okta-token-storage` holds accessToken and
    // idToken objects), so the entry is matched rather than parsed — a shape that cannot
    // break on a structure change we have never actually looked at.
    '      var om = oraw.match(/eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*/);',
    // A NON-MATCHING ENTRY LEAVES THIS `none`, and that is the 08-15 finding encoded.
    // `okta-original-uri-storage` holds a redirect URL; calling that "opaque" would report
    // a token we could not read where there is no token at all, and those are the two
    // readings this field exists to separate. `opaque` is reserved for something genuinely
    // JWT-shaped that will not decode.
    '      if (!om) continue;',
    '      var of2 = R.jwtFacts(om[0]);',
    '      if (of2 && of2.decodable) { oktaTok = "jwt"; oktaExp = of2.expiresInSec; }',
    '      else oktaTok = "opaque";',
    '    }',
    '  } catch (e) {}',
    '  var secs = function (ms) { return Math.round(ms / 1000); };',
    '  R.send("session", {',
    '    marker: prev ? "present" : "absent",',
    '    opens: (prev && prev.opens) || 0,',
    '    lastOpenAgoSec: prev && prev.last ? secs(now - prev.last) : null,',
    '    firstOpenAgoSec: prev && prev.first ? secs(now - prev.first) : null,',
    '    prevTokenExpiresInSec: prev && typeof prev.tokenExp === "number" ? Math.round(prev.tokenExp - now / 1000) : null,',
    '    storedToken: !stored ? "none" : (sf && sf.decodable ? "jwt" : "opaque"),',
    '    storedExpiresInSec: sf ? sf.expiresInSec : null,',
    // PRESENCE IS NOT LIVENESS, restated for the SDK store. An `okta-` entry holding a token
    // that expired yesterday is a different finding from one holding a live token, and
    // reporting only the shape would merge them — the failure `status = 'sent'` is the
    // house example of.
    '    oktaKeys: oktaN,',
    '    oktaNames: oktaNames.join(","),',
    '    oktaToken: oktaTok,',
    '    oktaExpiresInSec: oktaExp,',
    '  });',
    // The LIVE token is the one RC actually sends, caught off its own requests by
    // rc-inject.js. Recording its expiry — never the token — is what gives the NEXT open
    // something true to compare against; the localStorage copy is the one the bot has twice
    // been misled by (rc-token.mjs).
    '  R.onToken = function (f) {',
    '    if (f && typeof f.expiresInSec === "number") save(Math.round(Date.now() / 1000 + f.expiresInSec));',
    '  };',
    '})();',
  ].join('\n');
}

/**
 * READ THE CART BACK, from the cart page we just landed on.
 *
 * ## Why this is an upgrade to the proof rather than a threat to it
 *
 * `✓ Added to cart` in `client_reports` has been the evidence that the two RC cart POSTs
 * fired since 2026-08-13. It is a string WE wrote, judged on the submit's own `IsSuccess`
 * — and `content-rc.js` says so itself: "one step weaker than `rc-cart.mjs`, which re-reads
 * the cart." The owner's question when asked to navigate on success was whether moving
 * would lose that proof. It would, if we moved first.
 *
 * We do not. The status is written and flushed before `goToCart()` fires (see
 * `CART_NAV_DELAY_MS`), and the bundle is re-injected on every `loadstop` — so on the cart
 * page this runs and asks RC what is actually in the cart. That is the step
 * `rc-cart.mjs` takes and the injected precart never could, because until now it was never
 * on a page where the answer was worth asking for.
 *
 * ## It reports facts and reaches no conclusion
 *
 * `entries: 0` is a real and alarming reading — RC accepted a submit and holds nothing —
 * and it must arrive as itself rather than being folded into a failure. Equally, "RC did
 * not answer" is not "the cart is empty". The verdict belongs where it can be tested, which
 * is the readout; the same rule `sessionProbe` states at length.
 *
 * ## It matches nothing, on purpose
 *
 * No unit id, no site name. RC's cart entries **carry no unit field at all** — a matcher
 * looking for one reported an empty cart for a full one twice, and the second time left six
 * real campsites locked because the release was driven off the match. The honest question
 * here is how many entries the cart we wrote into holds.
 *
 * ## Endpoint and shape are the bot's
 *
 * `webaccesscustomer/load/shoppingcart`, `Result.CartEntry.$values` — copied from
 * `listCartEntries` rather than derived, and deliberately NEVER `empty/shoppingcart`, which
 * would destroy a cart rather than read it.
 */
export function cartVerifier(): string {
  return [
    '(function () {',
    '  var R = window.__camphawkRc; if (!R) return;',
    // Once per document. Every `loadstop` re-injects, including RC's own SPA transitions.
    '  if (window.__camphawkRcVerifying) return;',
    '  var mark = null;',
    '  try { mark = JSON.parse(sessionStorage.getItem("camphawk_rc_done") || "null"); } catch (e) { mark = null; }',
    // NOTHING TO VERIFY unless this session carted, and nowhere to verify it but the cart
    // page. Both halves matter: on the park page RC would answer about a cart we have not
    // written to yet, which is a reading that means nothing and would look like one that did.
    '  if (!mark) return;',
    '  if (!/\\/customers\\/shoppingcart/i.test(location.pathname)) return;',
    '  window.__camphawkRcVerifying = true;',
    // The adopted key first: `content-rc.js` writes RC's own answer there, which is the key
    // the SPA is showing. The marker is the fallback for a cart RC minted on the submit.
    // WHERE THE KEY CAME FROM IS THE DISCRIMINATOR, and it was being computed and thrown
    // away. `localStorage` is what RC's own SPA reads to decide which cart it is showing;
    // the marker is ours. So a read-back that succeeded on the MARKER means RC is holding a
    // reservation the page in front of the user cannot see — which is exactly the state
    // reported on 2026-08-29, where `cart read back: 1 entry` sat beside a cart UI asking a
    // signed-in user to log in. Reporting only `entries` cannot tell those apart.
    '  var key = "", keySource = "none";',
    '  try { key = localStorage.getItem("shoppingCartKey") || ""; } catch (e) {}',
    '  if (key) keySource = "localStorage";',
    '  if (!key) { key = mark.cartKey || ""; if (key) keySource = "marker"; }',
    '  if (!key) { R.send("cart-unverified", { reason: "no cart key was recorded, so there is nothing to read back" }); return; }',
    '  var CART_LOAD = "https://rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart";',
    '  var asked = false;',
    '  function ask(token) {',
    '    if (asked) return;',
    '    asked = true;',
    '    fetch(CART_LOAD, {',
    '      method: "POST",',
    '      credentials: "include",',
    '      headers: {',
    '        "Content-Type": "application/json", accesstoken: token,',
    '        authorization: "Bearer " + token, installationsidentity: "cali", storeid: "111",',
    '      },',
    '      body: JSON.stringify({ shoppingCartKey: key }),',
    '    }).then(function (r) {',
    '      return r.text().then(function (t) { return { text: t, status: r.status }; });',
    '    }).then(function (o) {',
    '      var n = null;',
    '      try {',
    '        var res = JSON.parse(o.text);',
    '        res = res && res.Result ? res.Result : res;',
    '        var list = res && res.CartEntry ? (res.CartEntry.$values || res.CartEntry) : null;',
    '        if (Array.isArray(list)) n = list.length;',
    '      } catch (e) {}',
    // A SHAPE WE DO NOT RECOGNISE IS NOT AN EMPTY CART. `listCartEntries` defaults to `[]`
    // here, which is right for cleanup and wrong for evidence: it would report "RC holds
    // nothing" for an answer we simply could not read.
    // IS THE CART ATTACHED TO THE ACCOUNT? RC's carts are free-floating GUID objects and an
    // unclaimed one carries `CustomerId: 0` — which is a candidate explanation for a cart
    // the owner cannot reach, and it is already sitting in the payload being parsed.
    // A BOOLEAN, never the id: a customer id is not a credential, but the standing rule is
    // not to collect a value you would then have to filter, and `attached` answers the
    // question the id was wanted for. `null` means RC did not tell us, never `false`.
    '      var attached = null;',
    '      try {',
    '        var res2 = JSON.parse(o.text); res2 = res2 && res2.Result ? res2.Result : res2;',
    '        if (res2 && typeof res2.CustomerId === "number") attached = res2.CustomerId > 0;',
    '      } catch (e) {}',
    '      if (n === null) R.send("cart-unverified", { reason: "RC answered, but not with a cart we could read", status: o.status, keySource: keySource });',
    '      else R.send("cart-verified", { entries: n, status: o.status, keySource: keySource, attached: attached });',
    '    }).catch(function () {',
    '      R.send("cart-unverified", { reason: "the cart read-back could not be sent" });',
    '    });',
    '  }',
    // The token comes off RC's own traffic, exactly as the precart gets it. rc-inject.js
    // replays the last one it saw on a timer, so listening late still hears it.
    '  window.addEventListener("message", function (e) {',
    '    if (e.source !== window || !e.data || !e.data.__camphawk_token) return;',
    '    ask(String(e.data.__camphawk_token));',
    '  });',
    // SILENCE IS THE ONE ANSWER THIS MUST NOT GIVE. Without this, a cart page that never
    // produced a token reports nothing, and "we could not check" would be indistinguishable
    // from "this build has no verifier" — the family of failure the whole channel exists
    // to end.
    '  setTimeout(function () {',
    '    if (asked) return;',
    '    asked = true;',
    '    R.send("cart-unverified", { reason: "no RC session appeared in this webview to read the cart back with" });',
    '  }, 12000);',
    '})();',
  ].join('\n');
}

/**
 * PUT RC'S PAGE BACK AT THE TOP — where its Sign In control is.
 *
 * Reported from two real hand-offs (2026-08-13): "tapping Start hand-off scrolls you down
 * to the calendar; it should stay at the top so the RC sign-in button is easy to find."
 *
 * The cause is RC's own SPA. `/park/<place>/<facility>` boots, then scrolls its availability
 * grid into view — which is the right thing to do for somebody browsing and the wrong thing
 * for somebody we have just sent to sign in, because RC's account control lives in the
 * header, now off screen. The first step of the claim is the sign-in, so the first thing on
 * screen has to be the way to do it.
 *
 * ## Why a short repeating nudge and not one scrollTo
 *
 * We are injected at `loadstop`, and RC scrolls AFTER that — asynchronously, from its own
 * framework, at a time nothing here can observe. A single `scrollTo(0, 0)` at injection is
 * therefore a race we lose most of the time, and the failure is silent.
 *
 * ## AND WHY IT STOPS THE INSTANT THE USER TOUCHES IT
 *
 * Fighting a user for the scroll position is worse than the problem: someone who has
 * deliberately scrolled down to check their dates and gets yanked back to the top twice will
 * not trust the next thing this screen tells them. Any real gesture — a touch, a wheel, a
 * key — ends it immediately and permanently, and it gives up on its own after 1.8s whatever
 * happens. `scrollTo` is called with no smooth behaviour so it cannot itself look like a
 * gesture, and a page already at the top is left alone entirely.
 */
export function scrollToTop(): string {
  return [
    '(function () {',
    '  try {',
    '    var until = Date.now() + 1800, stop = false;',
    '    function done() { stop = true; }',
    // `passive` so listening can never delay RC's own scrolling, and capture so a gesture
    // handled inside RC's grid still reaches us.
    '    ["touchstart", "wheel", "keydown", "pointerdown"].forEach(function (k) {',
    '      try { window.addEventListener(k, done, { passive: true, capture: true, once: true }); } catch (e) {}',
    '    });',
    '    var t = setInterval(function () {',
    '      if (stop || Date.now() > until) { clearInterval(t); return; }',
    '      try { if ((window.scrollY || 0) > 4) window.scrollTo(0, 0); } catch (e) {}',
    '    }, 200);',
    '  } catch (e) {}',
    '})();',
  ].join('\n');
}

export function buildPrecartScript(): string {
  const dir = join(process.cwd(), 'extension');
  const inject = readFileSync(join(dir, 'rc-inject.js'), 'utf8');
  const content = readFileSync(join(dir, 'content-rc.js'), 'utf8');

  // ORDER MATTERS: the capture has to be installed before the page script that waits on
  // it, or the token arrives before anyone is listening. Same reasoning as
  // installTokenCapture running before the first navigation on the bot side.
  return [
    '/* CampHawk RC precart — served from extension/, injected into the in-app webview. */',
    // FIRST, so an exception anywhere below is still reported. The reporter is also what
    // turns "nothing happened" into a fact — see its header.
    reporter(),
    // IMMEDIATELY AFTER THE REPORTER, and before anything else runs. It reads the state we
    // ARRIVED in, and every line below it is a chance for RC's SPA to change that state.
    // It needs the reporter's channel and JWT decoder, so it cannot go first.
    sessionProbe(),
    // Before the precart, because RC's scroll happens on its own clock and the nudge is a
    // 1.8s window that starts here. It touches nothing the cart depends on.
    scrollToTop(),
    '(function () {',
    '  // The user tapped claim; that is the opt-in. See the route for why this is shimmed',
    '  // rather than the extension file being edited.',
    '  if (typeof chrome === "undefined" || !chrome.storage) {',
    '    window.chrome = Object.assign(window.chrome || {}, {',
    '      storage: { local: { get: function (d, cb) { cb({ accepted: true, enabled: true }); } } },',
    '    });',
    '  }',
    '})();',
    inject,
    content,
    // AFTER the precart, because it reads the marker that a successful cart writes and the
    // key that same path adopts. On the page where it matters this is a fresh document and
    // the ordering is moot; on the park page it returns immediately either way.
    cartVerifier(),
    // THE SIGN-IN, AFTER THE REPORTER IT USES AND BEFORE THE EPILOGUE. It only DEFINES
    // `window.__chRcLogin`; the claim screen calls it in a separate one-off injection with
    // the user's credentials, which is what keeps this served bundle identical for everyone.
    //
    // IT WAS MISSING ENTIRELY ON THE FIRST RUN (2026-08-15). The module, the wiring and the
    // call site all existed and the function was never served, so the invocation hit an
    // undefined name and threw inside a try — the exact "fix present but inert" shape that
    // has cost this repo four commits. The guard that should have caught it asserted the
    // ORDER of the two injections without checking the first defines what the second calls.
    loginScript(),
    epilogue(),
  ].join('\n');
}

