import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    '  function scrub(s) {',
    '    return String(s == null ? "" : s)',
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
    '  window.__camphawkRc = { send: send, scrub: scrub, hasStash: hasStash, href: href, jwtFacts: jwtFacts, onToken: null, bridged: !!bridge };',
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
    '  var secs = function (ms) { return Math.round(ms / 1000); };',
    '  R.send("session", {',
    '    marker: prev ? "present" : "absent",',
    '    opens: (prev && prev.opens) || 0,',
    '    lastOpenAgoSec: prev && prev.last ? secs(now - prev.last) : null,',
    '    firstOpenAgoSec: prev && prev.first ? secs(now - prev.first) : null,',
    '    prevTokenExpiresInSec: prev && typeof prev.tokenExp === "number" ? Math.round(prev.tokenExp - now / 1000) : null,',
    '    storedToken: !stored ? "none" : (sf && sf.decodable ? "jwt" : "opaque"),',
    '    storedExpiresInSec: sf ? sf.expiresInSec : null,',
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
    epilogue(),
  ].join('\n');
}

