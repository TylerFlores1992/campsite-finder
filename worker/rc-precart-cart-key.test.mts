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
}) {
  const calls: Call[] = [];
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  if (opts.storedCartKey) local.set('shoppingCartKey', opts.storedCartKey);

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
      pathname: '/park/720/715',
      search: '',
      origin: 'https://www.reservecalifornia.com',
      href: `https://www.reservecalifornia.com/park/720/715${opts.hash}`,
      reload() {},
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
    fetch: fetchStub,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  return {
    calls, local, status, sandbox,
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
