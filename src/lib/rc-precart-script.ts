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

/** Cache for the process's life. The files cannot change without a redeploy. */
let cached: string | null = null;

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
    '  var lastKey = null, lastStage = null, dupes = 0;',
    '  function flush() { if (dupes) { post("repeated", { of: lastStage, times: dupes }); dupes = 0; } }',
    '  function send(stage, detail) {',
    '    var key;',
    '    try { key = stage + "|" + JSON.stringify(detail || null); } catch (e) { key = stage + "|?"; }',
    '    if (key === lastKey) { dupes++; return; }',
    '    flush();',
    '    lastKey = key; lastStage = stage;',
    '    post(stage, detail);',
    '  }',
    '  function hasStash() { try { return !!sessionStorage.getItem("camphawk_rc"); } catch (e) { return false; } }',
    '  window.__camphawkRc = { send: send, scrub: scrub, hasStash: hasStash, href: href, bridged: !!bridge };',
    '  // A run that ends on a repeat would otherwise lose the tail of the count.',
    '  window.addEventListener("pagehide", flush);',
    '  window.addEventListener("error", function (e) { send("error", { message: scrub(e && e.message) }); });',
    '  // rc-inject.js broadcasts the live access token to the content script. Reporting that',
    '  // it was CAPTURED — never its value — proves the hardest link in the chain (we can read',
    '  // an authenticated RC session inside this webview) without carting anything, which',
    '  // would lock a real unit and take it off the market.',
    '  window.addEventListener("message", function (e) {',
    '    if (e.source !== window || !e.data) return;',
    '    if (e.data.__camphawk_token) send("token", { captured: true, length: String(e.data.__camphawk_token).length });',
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

