/**
 * THE CART POSTS MUST ACTUALLY FIRE — the failure this file exists for.
 *
 * On 2026-08-13 a real hold produced a complete `client_reports` trace with a live,
 * decodable, 56-minute RC access token and then **no `load`, no `submit` and no error**.
 * The two cart POSTs were not failing; `content-rc.js` refused to attempt them, because it
 * treated a `shoppingCartKey` caught off RC's own traffic as a precondition and a fresh
 * session never has one. The user was told to "click the 🛒 cart icon once", which spends
 * the ~2.5s hand-off window the whole design exists to protect.
 *
 * The bot has never had a cart key either — `rc-hold-runner` passes `existing || NO_CART`
 * and `precartInPage` adopts what `load` returns. The step this refused to reach IS the
 * step that mints the key.
 *
 * ## Why this runs the real bytes instead of asserting on source text
 *
 * A regex over `content-rc.js` would pass against a file that throws on line 1, and the
 * whole point here is that an injection which runs nothing is indistinguishable from a
 * webview that refused us. So the test executes `buildPrecartScript()` — the exact bundle
 * `/api/rc-precart` serves to the phone — inside a stub page, feeds it a token the way
 * `rc-inject.js` would, and looks at what came out of `fetch`.
 *
 * It is also the first test that exercises the precart logic at all rather than
 * syntax-checking it, which is why the DOM stub below is worth its length.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildPrecartScript } from '../src/lib/rc-precart-script';

const LOAD = 'https://rdapi.reservecalifornia.com/api/webaccessfacility/load/precartdataforbookingmodify';
/** The cart READ-BACK, which is `rc-cart.mjs`'s `listCartEntries` endpoint verbatim. */
const CART_LOAD = 'https://rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart';
const CART_URL = 'https://www.reservecalifornia.com/Customers/ShoppingCart';
const CART_PATH = '/Customers/ShoppingCart';
const SUBMIT = 'https://rdapi.reservecalifornia.com/api/webaccessfacility/submit/precartdataforbookingmodify';
/** RC's own sentinel for "I have no cart". Must match extension/content-rc.js. */
const NO_CART = '00000000-0000-0000-0000-000000000000';
/** What RC hands back from `load`. Shaped like a GUID; never a real cart. */
const MINTED = '11111111-2222-3333-4444-555555555555';

type Call = { url: string; body: Record<string, unknown> };

/**
 * Enough of a browser to run the injected bundle.
 *
 * Deliberately minimal and deliberately NOT jsdom: the bundle touches a handful of APIs and
 * a whole DOM implementation would hide which ones. Anything it reaches for that is missing
 * throws, which is the behaviour we want — a silent stub is how this family of bug survives.
 */
function makePage(opts: {
  hash: string;
  storedCartKey?: string | null;
  /** What `submit` answers. Defaults to RC accepting. */
  submitBody?: string;
  submitStatus?: number;
  /** Where this document is. The cart page is a different job from the park page. */
  pathname?: string;
  /** A `camphawk_rc_done` marker already in the session, i.e. this run carted earlier. */
  carted?: { cartKey: string; unitId?: number };
  /** What the cart read-back answers. Defaults to RC reporting one entry. */
  cartBody?: string;
}) {
  const calls: Call[] = [];
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  /** Every `location.assign`, with the status line as it read at that instant. */
  const navigated: { to: string; statusWas: string }[] = [];
  const reports: { stage: string; detail: Record<string, unknown> | null }[] = [];
  if (opts.storedCartKey) local.set('shoppingCartKey', opts.storedCartKey);
  if (opts.carted) session.set('camphawk_rc_done', JSON.stringify(opts.carted));

  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const status = { textContent: '' };

  const el = () => {
    const node: Record<string, unknown> = {
      style: { cssText: '' },
      innerHTML: '',
      textContent: '',
      href: '',
      appendChild() {},
      remove() {},
      // The banner reads back exactly one node, by id, to hold its status line.
      querySelector: (sel: string) => (sel === '#camphawk-rc-status' ? status : null),
    };
    return node;
  };

  const body = (payload: string) => ({
    ok: (opts.submitStatus ?? 200) < 400,
    status: opts.submitStatus ?? 200,
    text: async () => payload,
    clone() { return this; },
  });

  const fetchStub = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url === CART_LOAD) {
      return {
        ok: true, status: 200, clone() { return this; },
        text: async () => opts.cartBody ?? JSON.stringify({
          Result: { CartEntry: { $values: [{ CartEntryKey: 'abc' }] } },
        }),
      };
    }
    if (url === LOAD) {
      return {
        ok: true, status: 200, clone() { return this; },
        text: async () => JSON.stringify({
          Result: {
            // The one field that makes a cartless session able to cart.
            ShoppingCartKey: MINTED,
            UnitDetail: { Extras: { $values: [] } },
          },
        }),
      };
    }
    return body(opts.submitBody ?? JSON.stringify({ Result: { IsSuccess: true, ShoppingCartKey: MINTED } }));
  };

  function XHR(this: unknown) {}
  XHR.prototype.open = function () {};
  XHR.prototype.setRequestHeader = function () {};
  XHR.prototype.send = function () {};

  const sandbox: Record<string, unknown> = {
    console: { log() {} },
    location: {
      hash: opts.hash,
      pathname: opts.pathname ?? '/park/720/715',
      search: '',
      origin: 'https://www.reservecalifornia.com',
      href: `https://www.reservecalifornia.com${opts.pathname ?? '/park/720/715'}${opts.hash}`,
      reload() {},
      // CAPTURED WITH THE STATUS AS IT READ AT THAT INSTANT. "It navigated" and "it
      // navigated only after the proof was written" are different facts, and the ordering
      // is the whole risk in landing the user in their cart — see CART_NAV_DELAY_MS.
      assign(to: string) { navigated.push({ to, statusWas: status.textContent }); },
    },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => { local.set(k, v); },
      removeItem: (k: string) => { local.delete(k); },
    },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => { session.set(k, v); },
      removeItem: (k: string) => { session.delete(k); },
    },
    document: { createElement: el, body: { appendChild() {} }, getElementById: () => status },
    addEventListener: (k: string, fn: (e: unknown) => void) => { (listeners[k] ??= []).push(fn); },
    removeEventListener: () => {},
    // Real timers, but COMPRESSED. `waitFor` and the epilogue both need one to actually
    // fire, and `getToken` waits 12 seconds for a token that will never come — which is
    // correct in a browser and absurd in a test. Only the DURATIONS are faked; the ordering
    // every assertion here depends on is untouched.
    setTimeout: (fn: () => void, ms = 0) => setTimeout(fn, Math.min(ms, 20)),
    clearTimeout,
    // NOT real: rc-inject.js rebroadcasts on a 1500ms interval 20 times, which would hold
    // the test open for half a minute to observe nothing.
    setInterval: () => 0,
    clearInterval: () => {},
    XMLHttpRequest: XHR,
    // The report channel, as the webview provides it. The extension has none, which is why
    // everything below has to work without one too.
    cordova_iab: {
      postMessage(raw: string) {
        try {
          const m = JSON.parse(raw);
          reports.push({ stage: String(m.stage), detail: m.detail ?? null });
        } catch { /* not ours */ }
      },
    },
    fetch: fetchStub,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  return {
    calls, local, session, status, sandbox, navigated, reports,
    run() { new vm.Script(buildPrecartScript()).runInContext(sandbox); },
    /** What `rc-inject.js` does when it catches a token off one of RC's own requests. */
    sendToken(t = `eyJ${'x'.repeat(936)}`) {
      const w = vm.runInContext('window', sandbox);
      const evt = { source: w, data: { __camphawk_token: t } };
      (listeners.message ?? []).forEach((fn) => fn(evt));
    },
    /** Let the async chain — getToken → load → submit — drain. */
    async settle() { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5)); },
  };
}

const JOB = '#camphawk-rc=45725_2026-09-13_2_';
/** The unit `JOB` names. Derived rather than repeated, so the two cannot drift apart. */
const JOB_UNIT = Number(JOB.match(/camphawk-rc=(\d+)/)![1]);

test('a session with NO cart key still reaches both cart POSTs', async () => {
  // THE REGRESSION. Before this fix the script bailed here with "Click the 🛒 cart icon
  // once (to start your cart)" and `calls` stayed empty — exactly the 08-13 trace.
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken();
  await page.settle();

  const urls = page.calls.map((c) => c.url);
  assert.deepEqual(urls, [LOAD, SUBMIT], 'load then submit, in that order, with no cart key to start from');

  // `load` is asked with RC's sentinel, never an empty string — an empty one fails .NET
  // model validation on `shoppingCartKey`, which the probe once read as a CAPTCHA.
  assert.equal(page.calls[0].body.shoppingCartKey, NO_CART);

  // ...and the submit uses the key `load` handed back. Sending NO_CART again would ask RC
  // to cart into the cart that does not exist, which is the same dead end one step later.
  assert.equal(page.calls[1].body.shoppingCartKey, MINTED);

  assert.match(page.status.textContent, /Added to cart/);
});

test('the cart we just made is adopted, or RC shows an empty one', async () => {
  // The submit happens over HTTP and RC's SPA never hears about it. Its sole source of
  // truth for "which cart am I" is localStorage["shoppingCartKey"] (verified by reading
  // RC's bundle), so a successful cart that skips this write shows the user an EMPTY cart
  // — a working hand-off that reads as a failed one.
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken();
  await page.settle();

  assert.equal(page.local.get('shoppingCartKey'), MINTED);
});

test("a session that already has a cart uses ITS key, not a new one", async () => {
  // RC caps a cart at 2 reservations (measured 2026-08-13), and a second cart would be
  // invisible to the user's own UI. If the session has a cart, add to that one.
  const EXISTING = '99999999-8888-7777-6666-555555555555';
  const page = makePage({ hash: JOB, storedCartKey: EXISTING });
  page.run();
  page.sendToken();
  await page.settle();

  assert.equal(page.calls[0].body.shoppingCartKey, EXISTING, 'load must be asked about the cart they have');
});

test('no token means no POST — the one precondition that survives', async () => {
  // Carting needs the user's own RC session. Without a token the POSTs would 401, and
  // "sign in" is the honest instruction. This is the case the old cart-key gate was
  // imitating, and the only one it was right about.
  const page = makePage({ hash: JOB });
  page.run();
  await page.settle();

  assert.equal(page.calls.length, 0);
  assert.match(page.status.textContent, /sign in/i);
});

test("RC's refusal is reported in RC's own words, never as success", async () => {
  // HTTP 200 WITH IsSuccess:false is RC's way of declining. Reading the status code alone
  // reports a cart that holds nothing as "✓ Added to cart" — the promise auto-cart exists
  // to make. This path also now shares one body read with the success path, so a mistake
  // there would surface as a consumed-stream throw rather than a wrong message.
  const page = makePage({
    hash: JOB,
    submitBody: JSON.stringify({
      Result: { IsSuccess: false, ErrorMessage: "Maximum Reservations in Cart is '2'." },
    }),
  });
  page.run();
  page.sendToken();
  await page.settle();

  assert.equal(page.calls.length, 2, 'it still tried');
  assert.match(page.status.textContent, /RC declined/);
  assert.match(page.status.textContent, /Maximum Reservations in Cart/);
  assert.ok(!/Added to cart/.test(page.status.textContent));
  assert.equal(page.local.get('shoppingCartKey'), undefined, 'a declined cart is not adopted');
});

test('no job in the link means nothing is carted', async () => {
  // STEP ONE OF THE CLAIM depends on this. `ClaimFlow.prepareRc` opens the webview with no
  // `unitId` precisely so the script can capture a token without being able to cart — and
  // an invented or leftover unit id would lock a real site and take it off the market.
  const page = makePage({ hash: '' });
  page.run();
  page.sendToken();
  await page.settle();

  assert.equal(page.calls.length, 0);
});

// ── LANDING IN THE CART, AND VERIFYING IT THERE (2026-08-23) ───────────────────────────
//
// The status line used to end "tap the cart icon at the top of this page to check out" —
// an instruction to go and navigate a page we had just put the user on. The owner asked for
// the obvious thing after a hold that worked: just take them there.
//
// The risk is entirely in the ORDERING. `✓ Added to cart` reaching `client_reports` is the
// evidence the two cart POSTs fired, and navigating destroys the context that reports it.
// So: write the proof, let it out, then go — and once we are there, ask RC what is actually
// in the cart, which is stronger evidence than a string we wrote ourselves.

test('a successful cart takes the user to their cart', async () => {
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken();
  await page.settle();

  assert.deepEqual(page.navigated.map((n) => n.to), [CART_URL],
    'exactly one navigation, to RC’s own cart, with the casing RC serves');
});

test('the proof is written BEFORE the navigation, never after', async () => {
  // THE OWNER'S OWN QUESTION, AND THE ONLY REASON THIS COULD GO WRONG. `#camphawk-rc-status`
  // is what `lib/rc-precart-script`'s epilogue observes and forwards; its observer callback
  // is a microtask, so a navigation started in the same turn is a race against the one line
  // two synthetic holds were run to produce. If we ever navigate first, this fails.
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken();
  await page.settle();

  assert.equal(page.navigated.length, 1);
  assert.match(page.navigated[0].statusWas, /Added to cart/,
    'the status must already say it before we leave the page that can report it');
});

test('the carted marker is durable, because the module flag is not', async () => {
  // `carted` is a module variable: fine for an SPA transition, nothing at all across a real
  // navigation. Both consumers of content-rc.js run again on the cart page — the extension
  // matches `www.reservecalifornia.com/*`, the webview re-injects on every `loadstop`.
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(page.session.get('camphawk_rc_done'), 'a successful cart must record itself');
});

test('a re-injection on the cart page does NOT submit again', async () => {
  // THE BUG THIS WOULD OTHERWISE INTRODUCE. A second submit on a site we already hold comes
  // back "cart is already added" — a REJECTION, which would overwrite a true success with a
  // failure message on the very screen the user is reading. That is the failure the
  // `carting || carted` guard exists for, arriving through the one door it cannot close.
  const page = makePage({ hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT } });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(!page.calls.some((c) => c.url === SUBMIT),
    'the cart is already made; submitting again can only turn a success into a refusal');
  assert.equal(page.navigated.length, 0, 'and there is nowhere left to navigate to');
  assert.match(page.status.textContent, /Added to cart/,
    'the screen must still say it worked — this is the page it worked on');
});

test('the cart is READ BACK on the cart page, which the status string never was', async () => {
  // `✓ Added to cart` is judged on the submit's own `IsSuccess` — our word for what we think
  // happened, and `content-rc.js` calls it "one step weaker than rc-cart.mjs, which re-reads
  // the cart". Landing there is exactly where that gap closes.
  const page = makePage({ hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT } });
  page.run();
  page.sendToken();
  await page.settle();

  const read = page.calls.find((c) => c.url === CART_LOAD);
  assert.ok(read, 'RC must be asked what is actually in the cart');
  assert.equal(read.body.shoppingCartKey, MINTED, 'and asked about the cart we wrote into');

  const verified = page.reports.find((r) => r.stage === 'cart-verified');
  assert.ok(verified, 'the answer must reach the report channel');
  assert.equal(verified.detail?.entries, 1);
});

test('an answer we cannot read is NEVER reported as an empty cart', async () => {
  // `listCartEntries` defaults to `[]` here, which is right for cleanup and wrong for
  // evidence: it would report "RC holds nothing" for an answer we simply could not parse.
  // `entries: 0` is a real and alarming reading and must stay distinguishable from silence.
  const page = makePage({
    hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT },
    // PARSES, BUT IS NOT A CART. The discriminating input: an unparseable body never
    // reaches the shape test at all, so it cannot tell a careful reader from a careless
    // one. RC answering 200 with something else entirely is the case that can.
    cartBody: JSON.stringify({ Result: { Message: 'no cart for that key' } }),
  });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(!page.reports.some((r) => r.stage === 'cart-verified'),
    'a shape we did not recognise is not a verdict about the cart');
  const un = page.reports.find((r) => r.stage === 'cart-unverified');
  assert.ok(un, 'and "we could not check" has to be said out loud, not left as silence');
});

test('an unparseable answer is not a cart either', async () => {
  const page = makePage({
    hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT },
    cartBody: '<html>Access Denied</html>',
  });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(!page.reports.some((r) => r.stage === 'cart-verified'));
  assert.ok(page.reports.some((r) => r.stage === 'cart-unverified'));
});

test('an EMPTY cart is reported as itself — the reading that matters most', async () => {
  const page = makePage({
    hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT },
    cartBody: JSON.stringify({ Result: { CartEntry: { $values: [] } } }),
  });
  page.run();
  page.sendToken();
  await page.settle();

  const verified = page.reports.find((r) => r.stage === 'cart-verified');
  assert.ok(verified, 'RC answered with a cart; that is a verified reading whatever it holds');
  assert.equal(verified.detail?.entries, 0,
    'RC accepted a submit and holds nothing — this must never round to a success');
});

test('a cart RC declined neither records itself nor navigates', async () => {
  // The marker and the navigation both hang off the success branch. If either ever moved
  // out of it, a refused cart would strand the user on RC's cart page looking at nothing,
  // and the durable flag would stop the retry that could still have worked.
  const page = makePage({
    hash: JOB,
    submitBody: JSON.stringify({ Result: { IsSuccess: false, ErrorMessage: 'nope' } }),
  });
  page.run();
  page.sendToken();
  await page.settle();

  assert.equal(page.navigated.length, 0, 'there is no cart to land in');
  assert.equal(page.session.get('camphawk_rc_done'), undefined, 'and nothing to remember');
});

test('nothing is read back before this session has carted', async () => {
  // Asking RC about the cart before we have written to it produces a reading that looks
  // exactly like one that counts.
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(!page.calls.some((c) => c.url === CART_LOAD),
    'with no marker there is nothing this run put in a cart to read back');
});

test('nothing is read back on the park page, even after carting', async () => {
  // THE SECOND GATE, AND IT IS ITS OWN. The marker alone would let this fire on the park
  // page — an extra POST on the one path where latency is the product, for an answer we
  // are about to get somewhere it means more. Both halves are checked separately because a
  // test that only ever exercises one cannot tell you the other was deleted.
  const page = makePage({ hash: JOB, carted: { cartKey: MINTED, unitId: JOB_UNIT } });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(!page.calls.some((c) => c.url === CART_LOAD),
    'the read-back belongs on the cart page and nowhere else');
});

test('carting while already on the cart page does not navigate to it again', async () => {
  // `goToCart` has to know where it is. Without that test it would assign the URL of the
  // page under the user's thumb, which on a real browser is a reload — and a reload
  // re-injects, which is how a loop starts on the one screen that must stay still.
  const page = makePage({ hash: JOB, pathname: CART_PATH });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(page.calls.some((c) => c.url === SUBMIT), 'it still carts');
  assert.equal(page.navigated.length, 0, 'and goes nowhere, because it is already there');
});

// ── "HAVE WE GOT A SESSION?" — the signal the sign-in reads ────────────────────────────
//
// These live here rather than beside the sign-in tests because this is the file that runs
// the REAL bundle. `rc-login-script.ts` can ask the question perfectly while the reporter
// never answers it, which is precisely the state the code was in until 2026-08-23: the
// sign-in asked `window.__camphawkRcToken`, a global belonging to the bot's Playwright
// capture that nothing in a webview has ever set. Stubbing the answer in a sign-in test
// would reproduce the bug and pass.

/** A token that says something about itself. `sign` is not checked by anything here. */
const jwt = (exp: number) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;

test('the reporter answers whether this webview has a session', () => {
  const page = makePage({ hash: JOB });
  page.run();
  const R = () => vm.runInContext('window.__camphawkRc', page.sandbox) as { signedIn?: () => boolean };

  assert.equal(typeof R().signedIn, 'function',
    'the sign-in reads this; a bundle that does not expose it puts the check back to always-false');
  assert.equal(R().signedIn!(), false, 'nothing has been captured yet');

  page.sendToken();
  assert.equal(R().signedIn!(), true, 'a token off RC’s own traffic is the session');
});

test('an EXPIRED token is not a session', () => {
  // The same rule the claim screen applies to the same event. Treating a dead token as a
  // session is what let a release happen against a 23-hour-dead one on 2026-08-21 — and
  // here it would additionally report a sign-in as unnecessary and skip it.
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken(jwt(Math.floor(Date.now() / 1000) - 3600));

  const R = vm.runInContext('window.__camphawkRc', page.sandbox) as { signedIn: () => boolean };
  assert.equal(R.signedIn(), false);
});

test('a token we cannot decode still counts — "we could not tell" is not "signed out"', () => {
  // The three-valued rule, and the failure direction is deliberate: refusing on an opaque
  // token would turn a webview we cannot read into one we refuse to sign in.
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken('not-a-jwt-at-all-but-long-enough');

  const R = vm.runInContext('window.__camphawkRc', page.sandbox) as { signedIn: () => boolean };
  assert.equal(R.signedIn(), true);
});

// ---------------------------------------------------------------------------
// A CART RC HOLDS IS NOT A CART THE OWNER CAN REACH (2026-08-29).
//
// The first Android hand-off reported `✓ Added to cart` and `cart read back: 1 entry`, and
// was written up as a success on the strength of those two lines. The owner, looking at
// that same page, saw an empty cart and a prompt to log in — while RC's own account menu
// offered "Log out". RC's inventory settled who was right: the unit vanished from the
// bookable list and the count dropped 39 -> 38, so the reservation was real and the page
// could not show it.
//
// `entries` alone cannot express that, and the readout was calling it "RC's own answer, not
// our status string" — true, and it is RC's answer to OUR question, asked with OUR key.
// Two fields already present in the response and in local state close the gap:
//
//   * `keySource` — `localStorage` is what RC's SPA reads to decide which cart it shows.
//     A read-back that only worked from our own `marker` means the page cannot see it.
//   * `attached`  — RC carts are free-floating GUIDs and an unclaimed one carries
//     `CustomerId: 0`. A cart with no account on it is a candidate for the same symptom.
//
// Guarded because the failure is SILENT and reads as a success: the run that produced it
// would have been filed as "Android proven" if the owner had not been holding the phone.
// ---------------------------------------------------------------------------

test('the read-back says WHERE the key came from — localStorage is what RC\'s page reads', async () => {
  // `storedCartKey` is the whole fixture. Without it `makePage` leaves localStorage empty
  // and the key falls through to the marker — so this test and the next one would stage the
  // SAME state and both pass while measuring nothing.
  const page = makePage({
    hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT }, storedCartKey: MINTED,
  });
  page.run();
  page.sendToken();
  await page.settle();

  const verified = page.reports.find((r) => r.stage === 'cart-verified');
  assert.ok(verified, 'the read-back must still report');
  assert.equal(verified.detail?.keySource, 'localStorage',
    'the submit writes localStorage, so a healthy run reads its key back from there — and '
    + 'saying so is the only way a run that DID NOT can be told apart');
});

test('a key that came only from OUR marker is reported as such', async () => {
  // The reachability failure, staged: RC holds the cart, our marker knows the key, and
  // `localStorage` does not — so RC's own SPA has no idea this cart exists. `entries: 1`
  // is still true and still the wrong thing to report on its own.
  // No `storedCartKey`: localStorage is empty and only our marker knows the key.
  const page = makePage({ hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT } });
  page.run();
  page.sendToken();
  await page.settle();

  const verified = page.reports.find((r) => r.stage === 'cart-verified');
  assert.ok(verified, 'it must still read the cart back — the marker is a legitimate source');
  assert.equal(verified.detail?.keySource, 'marker',
    'and it must SAY the key did not come from localStorage, or a cart the owner cannot '
    + 'see is indistinguishable from one they can');
  assert.equal(verified.detail?.entries, 1, 'the entry count is unchanged and still true');
});

test('CustomerId 0 is reported as NOT attached, and a missing field as null', async () => {
  const anon = makePage({
    hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT },
    cartBody: JSON.stringify({
      Result: { CustomerId: 0, CartEntry: { $values: [{ CartEntryKey: 'abc' }] } },
    }),
  });
  anon.run();
  anon.sendToken();
  await anon.settle();
  assert.equal(anon.reports.find((r) => r.stage === 'cart-verified')?.detail?.attached, false,
    'a free-floating cart with no account on it must say so');

  // NULL, NEVER FALSE, when RC does not tell us. "We could not tell" and "it is not
  // attached" have different fixes, and the second would send somebody chasing a customer
  // association that was never in question. Same rule as `unknown` never rounding to
  // `signed-out`.
  const quiet = makePage({ hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT } });
  quiet.run();
  quiet.sendToken();
  await quiet.settle();
  assert.equal(quiet.reports.find((r) => r.stage === 'cart-verified')?.detail?.attached, null,
    'RC said nothing about CustomerId, so neither may we');
});

test('the banner never claims the page in front of the user shows the cart', async () => {
  // "this is your cart. Check the dates and check out." was a claim ABOUT THE PAGE, and on
  // 2026-08-29 it was false while every other signal said success. `✓ Added to cart` stays —
  // client_reports is read for it and ClaimFlow matches on it — but the tail must not assert
  // something we have watched be wrong.
  const page = makePage({ hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT } });
  page.run();
  page.sendToken();
  await page.settle();

  assert.match(page.status.textContent, /✓ Added to cart/,
    'the leading token is load-bearing and must survive any rewording of the tail');
  assert.doesNotMatch(page.status.textContent, /this is your cart/i,
    'the cart can be real and unreachable — asserting the page shows it leaves somebody '
    + 'staring at an empty screen being told to check out');
});

// ---------------------------------------------------------------------------
// THE CARTED MARKER MUST NAME ITS SITE (2026-08-29).
//
// The second Android test of the day carted nothing and said `✓ Added to cart` anyway. The
// marker is `sessionStorage`, which outlives a hand-off: the webview was 59 minutes and 20
// opens old, still holding the FIRST hand-off's marker, so `alreadyCarted()` short-circuited
// for a completely different site. A success message over an uncarted site is the worst
// output this screen has — the user stops watching a site nobody is holding.
// ---------------------------------------------------------------------------

test('a NEW claim link retires the previous run\'s marker', async () => {
  // The first of the two defences, on the path where a fresh fragment arrives.
  const page = makePage({
    hash: JOB, pathname: CART_PATH,
    // A different unit entirely — the morning's hand-off, still in this webview session.
    carted: { cartKey: MINTED, unitId: 999999 },
  });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(page.calls.some((c) => c.url === SUBMIT),
    'a marker for unit 999999 says nothing about this job and must not stop it carting — '
    + 'that is exactly how the 08-29 retest reported success for a site it never touched');
});

test('the clear is pinned DIRECTLY, because the unit check hides it', async () => {
  // Asserting the clear through its EFFECT (a submit happening) cannot see it: the unit
  // check produces the same outcome, so deleting the clear passes. Verified by mutation.
  // Two overlapping defences are worth having and each needs its own observation, or one of
  // them silently stops existing.
  // THE SUBMIT MUST FAIL, or this cannot see the clear at all: a successful cart calls
  // `rememberCarted` and overwrites the marker with THIS unit, which looks identical to the
  // clear having worked. Found by mutation — the first version passed with the clear
  // deleted. A declined submit leaves nothing written, so what remains is exactly what the
  // clear did or did not do.
  const page = makePage({
    hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: 999999 },
    submitBody: JSON.stringify({ Result: { IsSuccess: false, ErrorMessage: 'nope' } }),
  });
  page.run();
  page.sendToken();
  await page.settle();

  assert.equal(page.session.get('camphawk_rc_done'), undefined,
    "a new claim link must retire the previous run's marker at the SOURCE. The stale one is "
    + 'for unit 999999; leaving it means every later check has to keep out-arguing it.');
});

test('and WITHOUT a fresh fragment, the unit check alone still catches it', async () => {
  // THE ISOLATING FIXTURE, and writing it is what exposed a hole in the two tests above.
  // Both originally staged a fragment, so `readFragment`'s clear removed the stale marker
  // before `alreadyCarted` was ever consulted — the scoping check could be deleted outright
  // and both still passed. Verified by mutation, which is the only way this is ever found.
  //
  // The cart page reached by any other route (a reload, a back-navigation, the re-injection
  // on `loadstop`) has NO fragment: the job comes from the stash. That is the path where the
  // unit comparison is the only thing standing between us and a success message over a site
  // nobody carted.
  const page = makePage({
    hash: '', pathname: CART_PATH, carted: { cartKey: MINTED, unitId: 999999 },
  });
  page.session.set('camphawk_rc', JSON.stringify({
    unitId: JOB_UNIT, arrivalDate: '2026-09-13', nights: 2, sleepingUnitId: null,
  }));
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(page.calls.some((c) => c.url === SUBMIT),
    'with no fragment to trigger the clear, `alreadyCarted` must compare units itself');
});

test('a marker for THIS site still suppresses the re-submit', async () => {
  // The property the marker exists for, and it must survive the scoping. A second submit on
  // a site we already hold comes back "cart is already added" — a rejection that would
  // overwrite a true success on the screen the user is reading.
  const page = makePage({
    hash: JOB, pathname: CART_PATH, carted: { cartKey: MINTED, unitId: JOB_UNIT },
  });
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(!page.calls.some((c) => c.url === SUBMIT),
    'the same site must not be submitted twice');
  assert.match(page.status.textContent, /Added to cart/);
});

test('a marker that cannot name its unit ACTS rather than claiming a cart', async () => {
  // Written by an older bundle. The two failure directions are not symmetric: wrongly
  // "carted" claims a site we do not hold and the user stops watching; wrongly "not carted"
  // re-submits and costs a checkout affordance. Absence of evidence about WHICH unit is not
  // evidence it was this one.
  // NO FRAGMENT, for the same reason as the test above: with one, the clear fires and the
  // legacy marker never reaches the unit check.
  const page = makePage({ hash: '', pathname: CART_PATH, carted: { cartKey: MINTED } });
  page.session.set('camphawk_rc', JSON.stringify({
    unitId: JOB_UNIT, arrivalDate: '2026-09-13', nights: 2, sleepingUnitId: null,
  }));
  page.run();
  page.sendToken();
  await page.settle();

  assert.ok(page.calls.some((c) => c.url === SUBMIT),
    'a legacy marker must not be trusted to mean THIS site is held');
});

test('the marker records which unit it carted', async () => {
  const page = makePage({ hash: JOB });
  page.run();
  page.sendToken();
  await page.settle();

  const mark = JSON.parse(page.session.get('camphawk_rc_done') ?? 'null');
  assert.ok(mark, 'a successful cart must still leave a durable marker');
  assert.equal(mark.unitId, JOB_UNIT,
    'without the unit the marker cannot be scoped, and the next hand-off in this webview '
    + 'inherits it');
});
