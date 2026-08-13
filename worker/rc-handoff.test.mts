/**
 * The RC hand-off seam — the last two seconds of the auto-cart design.
 *
 * These pin the two things that are easy to break silently: the fragment the desktop
 * extension reads, and the promise that the web layer never assumes a native capability
 * the installed binary might not have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rcFragment, rcHandoffUrl } from '../src/lib/native/rc-handoff';
import { handoffCopy } from '../src/lib/claim-copy';

test('the fragment matches what the extension actually parses', () => {
  // extension/content-rc.js is the consumer. If the shape here drifts from the regex
  // there, the desktop auto-cart silently stops and nothing reports it — the user just
  // lands on RC and books by hand, which looks like the phone experience.
  const ext = readFileSync('extension/content-rc.js', 'utf8');
  assert.match(ext, /camphawk-rc=/, 'the extension must still read this fragment');

  const frag = rcFragment({ url: 'x', unitId: '45725', arrivalDate: '2026-09-13', nights: 2 });
  assert.equal(frag, '#camphawk-rc=45725_2026-09-13_2_');

  // Four underscore-separated fields, the last empty: unit, arrival, nights,
  // sleepingUnitId. We never have the fourth; the extension defaults it.
  const body = frag.replace('#camphawk-rc=', '');
  assert.equal(body.split('_').length, 4);
  assert.equal(body.split('_')[3], '', 'sleepingUnitId is intentionally blank');
});

test('no unit means no fragment, and never a bare hash', () => {
  // A trailing "#" would be harmless on RC but is emitted into email and push links, and
  // "…/park/720/715#" in a text message reads like a broken URL.
  assert.equal(rcFragment({ url: 'x' }), '');
  assert.equal(rcHandoffUrl({ url: 'https://rc.example/park/720/715' }), 'https://rc.example/park/720/715');
});

test('an existing fragment is replaced, never doubled', () => {
  const out = rcHandoffUrl({
    url: 'https://rc.example/park/720/715#camphawk-rc=old_x_1_',
    unitId: '9', arrivalDate: '2026-01-02', nights: 1,
  });
  assert.equal(out, 'https://rc.example/park/720/715#camphawk-rc=9_2026-01-02_1_');
  assert.equal(out.split('#').length, 2, 'exactly one fragment');
});

test('no native plugin is imported at module scope', () => {
  // THE RULE THAT KEEPS THIS SHIPPABLE. The web layer deploys continuously to apps that
  // are ALREADY INSTALLED, so a static import of a plugin that a shipped binary does not
  // contain breaks the claim screen for everyone on the old build — at the one moment
  // that screen matters. Every capability must be probed at runtime and fall back.
  const src = readFileSync('src/lib/native/rc-handoff.ts', 'utf8');
  const staticImports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  for (const spec of staticImports) {
    assert.ok(
      !/^@capacitor\/|^@capgo\/|^cordova-/.test(spec),
      `native plugin '${spec}' must be imported dynamically, inside a capability check`,
    );
  }
  assert.match(src, /await import\('@capacitor\/browser'\)/, 'the fallback stays dynamic');
});

test('injection is not claimed until it can actually be done', () => {
  // `openRcHandoff` reports 'injected' to its caller, and the claim screen will tell the
  // user "we're carting it for you" on that basis. Returning it while the precart source
  // is still a stub would promise an automatic booking that never happens — worse than
  // the manual flow, because the user stops watching.
  const src = readFileSync('src/lib/native/rc-handoff.ts', 'utf8');
  const stub = /async function rcInjectedPrecart\(\): Promise<string \| null> \{\s*return null;\s*\}/.test(src);
  if (stub) {
    assert.match(
      src, /const code = await rcInjectedPrecart\(\);\s*if \(code\) \{/,
      'while the precart is a stub, the injected path must be guarded by it',
    );
  }
});

test('the served precart is the extension file, and the REAL bytes parse', async () => {
  // ONE IMPLEMENTATION, TWO CONSUMERS. The extension keeps using its own copy (MV3 forbids
  // remote code); the phone fetches the same bytes. If this ever grew its own copy of the
  // precart, RC's next schema change would fix one and leave the other broken — exactly
  // what rc-cart.mjs exists to prevent between the probe and the runner.
  const mod = readFileSync('src/lib/rc-precart-script.ts', 'utf8');
  assert.match(mod, /extension/, 'must read from extension/, not embed a copy');
  assert.ok(
    !/submit\/precartdataforbookingmodify'/.test(mod),
    'must not contain precart logic of its own — serve the file',
  );

  // THE REAL BUILDER, not a hand-rebuilt approximation. This test used to reassemble the
  // bundle itself, which meant the reporter and epilogue — added later — were covered by
  // nothing. A syntax error in either injects NOTHING, and an injection that runs nothing
  // is indistinguishable from a webview that refused us, which is the single failure this
  // whole diagnostic exists to rule out.
  const { buildPrecartScript } = await import('../src/lib/rc-precart-script');
  const script = buildPrecartScript();
  new (await import('node:vm')).Script(script); // throws on a syntax error

  // The one string the handoff sanity-checks the response body for.
  assert.match(script, /precartdataforbookingmodify/);
});

test('the reporter announces itself, and survives having no bridge', async () => {
  // The FIRST report is the whole point: it is the only evidence that separates "the script
  // threw on line 1" from "the script ran and had nothing to cart". Both are silence.
  const { buildPrecartScript } = await import('../src/lib/rc-precart-script');
  const script = buildPrecartScript();
  assert.match(script, /"injected"/, 'must announce execution before doing anything else');

  // The reporter runs on RC's page in a plain browser too (the extension's users), where
  // there is no cordova_iab. It must degrade to a no-op rather than throwing — a throw here
  // would take the precart down with it on desktop, breaking a path that works today.
  const vm = await import('node:vm');
  const { reporter } = await import('../src/lib/rc-precart-script');
  const code = reporter();

  const world = (extra: Record<string, unknown> = {}) => {
    const s: Record<string, unknown> = {
      console: { log() {} },
      location: { href: 'https://www.reservecalifornia.com/', hash: '', pathname: '/', search: '' },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener: () => {},
      ...extra,
    };
    s.window = s;
    return vm.createContext(s);
  };

  assert.doesNotThrow(() => new vm.Script(code).runInContext(world()), 'no bridge must be a no-op');

  // With a bridge it must actually post — and post parseable JSON, because the Android side
  // does `new JSONObject(data)` and silently drops anything else (see InAppBrowser.java).
  const posted: string[] = [];
  new vm.Script(code).runInContext(world({ cordova_iab: { postMessage: (s: string) => posted.push(s) } }));
  assert.ok(posted.length > 0, 'must post once the bridge exists');
  const first = JSON.parse(posted[0]);
  assert.equal(first.camphawk, 'rc-precart');
  assert.equal(first.stage, 'injected');
  assert.equal(first.n, 1, 'the page numbers its own reports from 1 — 0 is reserved for host events');
});

test('a reported URL never carries its query string', async () => {
  // OKTA SIGNS IN INSIDE THIS WEBVIEW, so mid-flow the URL is `/login/callback?code=…` —
  // an OAuth authorization code, exchangeable for the session. The first run of this
  // diagnostic printed one (2026-08-09). scrub() knew JWT shapes and did not catch it,
  // which is why the field is not collected rather than filtered.
  const vm = await import('node:vm');
  const { reporter } = await import('../src/lib/rc-precart-script');
  const posted: string[] = [];
  const s: Record<string, unknown> = {
    console: { log() {} },
    location: {
      origin: 'https://signin.reservecalifornia.com',
      pathname: '/login/callback',
      href: 'https://signin.reservecalifornia.com/login/callback?code=AE8sNHc8w2BC54&state=cpphZ',
      hash: '',
      search: '?code=AE8sNHc8w2BC54&state=cpphZ',
    },
    sessionStorage: { getItem: () => null },
    addEventListener: () => {},
    cordova_iab: { postMessage: (m: string) => posted.push(m) },
  };
  s.window = s;
  new vm.Script(reporter()).runInContext(vm.createContext(s));

  const all = posted.join(' ');
  assert.ok(!all.includes('code='), 'an OAuth authorization code must never be reported');
  assert.ok(!all.includes('state='), 'nor the state parameter');
  assert.match(JSON.parse(posted[0]).detail.href, /^https:\/\/signin\.reservecalifornia\.com\/login\/callback$/);
});

test('identical reports collapse instead of flooding', async () => {
  // rc-inject.js rebroadcasts the token on EVERY RC API call. The first live run produced
  // ~40 identical "token captured" lines, which is exactly the noise that would bury the
  // cart's own status at 08:00:00 — the one line the whole channel exists to carry.
  const vm = await import('node:vm');
  const { reporter } = await import('../src/lib/rc-precart-script');
  const posted: string[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const s: Record<string, unknown> = {
    console: { log() {} },
    location: { origin: 'https://www.reservecalifornia.com', pathname: '/', href: 'https://www.reservecalifornia.com/', hash: '' },
    sessionStorage: { getItem: () => null },
    addEventListener: (k: string, fn: (e: unknown) => void) => { (listeners[k] ??= []).push(fn); },
    cordova_iab: { postMessage: (m: string) => posted.push(m) },
  };
  s.window = s;
  vm.createContext(s);
  new vm.Script(reporter()).runInContext(s);

  const before = posted.length;
  // `window` INSIDE the context is not the same reference as the sandbox object outside it,
  // and the reporter's `e.source !== window` guard is real (it rejects messages posted by RC's
  // own frames). Ask the context for its own window so the event looks like a genuine one.
  const ctxWindow = vm.runInContext('window', s);
  const evt = { source: ctxWindow, data: { __camphawk_token: 'x'.repeat(939) } };
  for (let i = 0; i < 20; i++) listeners.message.forEach((fn) => fn(evt));

  // TWO, AND IT STAYS TWO. This asserted a literal 1 until the session probe gave the first
  // sighting of each distinct token its clock (`expiresInSec`, `ageSec`) — a countdown, so
  // it cannot ride the repeats without making every replay a different payload and undoing
  // this collapse entirely. The first capture therefore posts its timings, the second posts
  // presence only, and every one after that folds into the count.
  //
  // The property worth pinning was never the constant: it is that a flood of N captures
  // costs O(1) reports. Asserting that at 20 AND at 200 says so, where a magic number only
  // says what today's code happens to do.
  const posts20 = posted.length - before;
  assert.equal(posts20, 2, 'the first capture carries its clock, the rest collapse');
  for (let i = 0; i < 200; i++) listeners.message.forEach((fn) => fn(evt));
  assert.equal(posted.length - before, posts20, '200 more identical captures cost nothing further');

  // The count is KEPT, not dropped: "seen 220 times" and "seen once" say different things
  // about whether the session is actually being used.
  listeners.pagehide.forEach((fn) => fn(undefined));
  const last = JSON.parse(posted[posted.length - 1]);
  assert.equal(last.stage, 'repeated');
  assert.deepEqual(last.detail, { of: 'token', times: 218 });
});

test('a report can never carry the RC access token', () => {
  // THE STANDING RULE: the RC token is full account access. It does not travel in an alert
  // link and it must not travel in a diagnostic either. The token path reports a BOOLEAN and
  // a length; scrub() is the second line of defence, not the first.
  const mod = readFileSync('src/lib/rc-precart-script.ts', 'utf8');
  assert.match(mod, /captured: true, length:/, 'the token is reported as presence + length only');
  assert.ok(
    !/__camphawk_token: *e\.data\.__camphawk_token|token: *String\(e\.data\.__camphawk_token\)(?!\.length)/.test(mod),
    'the token value must never be placed in a report',
  );
  assert.match(mod, /function scrub/, 'a JWT-shaped string is redacted wherever text is forwarded');
});

test('no invented ReserveCalifornia URL shape anywhere in the app', () => {
  // `/Web/#!park/<place>/<facility>` LOOKS like a UseDirect URL and is not one. It has now
  // been written from memory twice and both times RC answered with its own branded 404 —
  // once in production copy, once in the admin webview test, where it burned a live
  // sign-in experiment that needed a human, an emulator and a fresh build to set up.
  //
  // RC's real deep link is `/park/<placeId>/<facilityId>`, and the ONE place allowed to
  // build it is lib/booking-url, which is host-gated and tested. Anything else hardcoding
  // an RC path is a URL nothing keeps honest.
  for (const f of ['src/components/admin/AdminTabs.tsx', 'src/lib/native/rc-handoff.ts']) {
    const src = readFileSync(f, 'utf8');
    const bad = [...src.matchAll(/^(?!\s*(?:\*|\/\/)).*reservecalifornia\.com\/Web\//gm)];
    assert.equal(bad.length, 0, `${f}: '/Web/#!park/…' is not a real RC URL — use lib/booking-url`);
  }
});

test('the precart route is reachable without a CampHawk session', () => {
  // Clerk's auth.protect() returns 404, not 401, for a route that is not public — so this
  // would fail as "not found" in a webview at 08:00:00 and read like a deploy problem.
  const mw = readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /'\/api\/rc-precart'/, 'must be in isPublicRoute');
});

test('extension/ is included in the deployment', () => {
  // readFileSync paths are invisible to Next's file tracing, so without this the route
  // works in dev and 500s in production — the worst shape of deploy bug.
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /outputFileTracingIncludes/);
  assert.match(cfg, /extension\/content-rc\.js/);
});

/**
 * "We are putting it in your cart" — the sentence this whole family of tests is about.
 *
 * A first-person subject and the word `cart` inside ONE sentence. Bounded on `.!?` so it
 * cannot join two clauses that are separately harmless, which is what keeps the honest
 * forms legal: "Check your cart", "tap the cart icon", "ReserveCalifornia holds a cart
 * about 15 minutes" are all statements about the reader or about RC, with no promise by us.
 *
 * DELIBERATELY BROADER THAN THE ONE IT REPLACES. That one demanded the literal shapes
 * `add …cart` or `cart it`, and I found by mutation that **"We're putting it in your cart"
 * sailed straight through it** — a sentence three words from the one it was written for.
 * The first version of the guard was defeated by a `<strong>` tag; the second by a synonym.
 * The property is "we, and a cart, in the same breath", so that is what it now matches.
 */
const CART_PROMISE = /\bwe(?:'|’)?(?:re|ll|\s+are|\s+will)?\b[^.!?]{0,60}?\bcart\b/i;

/** Fields the user reads only AFTER the release, when the cart either happened or did not. */
const POST_RELEASE = new Set(['afterBody', 'afterCta']);

test('the plain-browser claim copy never promises a cart', () => {
  // THE STANDING RULE, AND THIS IS THE HALF OF IT THAT NEVER EXPIRES. `docs`/CLAUDE.md have
  // said since 2026-08-09 that the claim copy must not say "we're carting it for you"
  // unless it is true, because a user who believes the site is handled STOPS WATCHING and
  // the ~2.5s exposure window is then spent by nobody. A manual flow somebody follows beats
  // an automatic one that does not run.
  //
  // With no injectable webview there is no precart, on any of these clients, ever. A
  // desktop user with the CampHawk extension WILL be carted for automatically and still
  // gets this copy: we cannot detect the extension from the page, so the promise would be a
  // guess, and a pleasant surprise is a far better failure than a broken one.
  const copy = handoffCopy(false) as unknown as Record<string, string>;
  for (const [field, text] of Object.entries(copy)) {
    assert.ok(
      !CART_PROMISE.test(text),
      `claim-copy.handoffCopy(false).${field} promises a cart that cannot happen: ${text}`,
    );
  }
});

test('the injected claim copy may promise a cart — but only after the release', () => {
  // WHAT EARNED THIS, and it is the only thing that could have. Two synthetic holds on
  // 2026-08-13 (12:31 and 12:47 PT) reported `✓ Added to cart` through the client report
  // channel, and the first was confirmed by eye on ReserveCalifornia's own cart page — the
  // right unit, the right dates. Before that the promise was a hypothesis, and the 08-12
  // hold is what a hypothesis looks like when it is wrong: a 939-char token captured, and
  // no cart outcome at all.
  //
  // BRANCHED ON CAPABILITY, NOT ON PLATFORM. `canInject` is a runtime probe for a Cordova
  // InAppBrowser with `executeScript`, which is the same capability that carries the
  // precart. The cart POSTs are measured on iOS and NOT on Android, so a platform-shaped
  // promise would be half unearned; a capability-shaped one is exactly as true as the
  // mechanism is.
  const copy = handoffCopy(true) as unknown as Record<string, string>;

  // Everything the user reads BEFORE pressing the release button is still a prediction, and
  // a prediction is the thing that changes what they do. The exclusion list is a denylist on
  // purpose: a field added later is covered by default, and has to be argued into
  // POST_RELEASE rather than out of it.
  for (const [field, text] of Object.entries(copy)) {
    if (POST_RELEASE.has(field)) continue;
    assert.ok(
      !CART_PROMISE.test(text),
      `claim-copy.handoffCopy(true).${field} is read before the release — it may not promise a cart: ${text}`,
    );
  }

  // OWNER NOTE 6, pinned as behaviour rather than as wording. "Once carted, say plainly that
  // it is carted and to tap the cart icon to check out." The old copy — "review & check out
  // on ReserveCalifornia" — describes a place the reader is already standing in; what they
  // need is the ONE control that gets them to checkout, named.
  assert.match(
    copy.afterBody, /cart icon/i,
    'after the release the copy must name the control that reaches checkout',
  );
});

test('no cart promise is written inline into the claim screen', () => {
  // The copy module is the sanctioned place, and this is what stops the next edit routing
  // around it. Without this the two tests above are satisfied by a `handoffCopy` nobody
  // renders.
  //
  // READ THE RENDERED SENTENCE, NOT THE SOURCE LINE. The first version of this matched raw
  // JSX with a character class that excluded `<`, so `We let go and add <strong>{site}
  // </strong> to your cart.` — the precise string that prompted it — passed, because the tag
  // interrupts the phrase. Strip the markup, then read the prose the user actually sees.
  const prose = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join('\n')
    .replace(/<[^>]*>/g, '')      // JSX tags
    .replace(/\{[^{}]*\}/g, ' '); // interpolations: {site} is a name, not a claim

  const promises = [...prose.matchAll(new RegExp(CART_PROMISE.source, 'gi'))];
  assert.deepEqual(
    promises.map((m) => m[0].trim()),
    [],
    'route claim copy through lib/claim-copy, where the capability branch is enforced',
  );
});
