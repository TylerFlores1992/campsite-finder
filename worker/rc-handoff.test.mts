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
import { rcHandoffStep } from '../src/lib/claim-gate';

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

test('an INTERLEAVED token/cartkey flood collapses too', async () => {
  // THE DOOR THE CONSECUTIVE COLLAPSE LEFT OPEN, and it cost the proof of the thing this
  // whole channel exists to prove. `rc-inject.js` rebroadcasts the token AND the cart key on
  // every RC API call, so the real stream is `token, cartkey, token, cartkey, …` — no two
  // NEIGHBOURS are ever identical, so nothing collapsed at all.
  //
  // Measured on the two hand-offs of 2026-08-13 that settled the cart POSTs: both stored
  // forty reports, thirty-nine of them that pair, and because `recordClientReports` keeps
  // the TAIL the `✓ Added to cart` line was trimmed off the front of both. The readout then
  // reported the LAST thing said — `RC declined (200) — cart is already added`, which is a
  // re-injection submitting over an entry we already hold, i.e. evidence the cart SURVIVED —
  // as though it were the verdict. The success lived on in a screenshot and nowhere else.
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
  const ctxWindow = vm.runInContext('window', s);

  const before = posted.length;
  const token = { source: ctxWindow, data: { __camphawk_token: 'x'.repeat(939) } };
  const cartkey = { source: ctxWindow, data: { __camphawk_cartkey: 'k' } };
  const flood = (n: number) => {
    for (let i = 0; i < n; i++) {
      listeners.message.forEach((fn) => fn(token));
      listeners.message.forEach((fn) => fn(cartkey));
    }
  };

  // THREE, AND IT STAYS THREE. The first sighting of a distinct token carries its clock and
  // the second reports presence only, so the token legitimately costs two payloads; the cart
  // key costs one. Everything after that is the same key again and folds.
  //
  // The property pinned is O(1), not the constant: 100 pairs and 1,100 pairs cost the same.
  // A magic number only says what today's code happens to do, and this is a bound the stored
  // report cap (40, tail-kept) has to live inside — at three, a hand-off's own status lines
  // and the cart's verdict all fit with room to spare.
  flood(100);
  const emitted = posted.slice(before).map((p) => JSON.parse(p).stage);
  assert.deepEqual(emitted, ['token', 'cartkey', 'token'], 'an interleaved flood must cost 3 reports');
  flood(1000);
  assert.equal(
    posted.slice(before).length, emitted.length,
    '1,000 further pairs must cost nothing — the collapse cannot be consecutive-only',
  );

  // AND A REAL STATUS STILL GETS THROUGH — including one that repeats a value seen earlier.
  // RC's own text can go A → B → A, and suppressing that would spend the fix on the thing it
  // is meant to protect. This is why the global dedupe is scoped to the mechanical stages.
  const R = vm.runInContext('window.__camphawkRc', s);
  R.send('status', { status: 'Adding to your cart…' });
  R.send('status', { status: '✓ Added to cart' });
  R.send('status', { status: 'Adding to your cart…' });
  const stages = posted.slice(before).map((p) => JSON.parse(p));
  const statuses = stages.filter((x) => x.stage === 'status').map((x) => x.detail.status);
  assert.deepEqual(statuses, ['Adding to your cart…', '✓ Added to cart', 'Adding to your cart…']);

  // AND THE COUNT SURVIVES THE SUPPRESSION. Folding a flood is only acceptable because the
  // number is kept: "the token was seen 2,199 times" says the session is being used hard,
  // "seen once" says something opened a page. Dropping it would trade one silent fact for
  // another, which is the trade this codebase keeps losing.
  const repeated = stages.filter((x) => x.stage === 'repeated');
  assert.ok(repeated.length > 0, 'the suppressed repeats must still be counted, not discarded');
  assert.ok(
    repeated.reduce((n, x) => n + x.detail.times, 0) > 2000,
    'the count must cover the whole flood, not just the consecutive part',
  );
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

test('the precart is never run before a session exists in the webview', () => {
  // THE REVISIT BUG. `prepareRc` — the in-webview RC sign-in — was wired into the
  // PRE-RELEASE screen only, which is invisible in the 08:00 flow (sign in, then release,
  // then redirect) and wrong the moment "Open the hand-off again" made the RELEASED screen
  // reachable on its own. A user landing there has never signed in inside this webview, so
  // the precart spends its twelve-second token wait on "Reading your session…" and can only
  // end by asking them to sign in on RC's own page — with the release already spent.
  assert.equal(rcHandoffStep(true, 'idle'), 'sign-in', 'a fresh mount must sign in first');
  assert.equal(rcHandoffStep(true, 'opening'), 'waiting');
  assert.equal(rcHandoffStep(true, 'verified'), 'finish', 'the ordinary flow is unchanged');

  // UNCONFIRMED IS NOT A REFUSAL, and this is the edge an inline copy of the rule would get
  // wrong. The webview closed without announcing a token, which may mean no session or may
  // mean we never got to look; only the first would justify standing between a user and a
  // site that is already free for anyone. Same rule as `unknown` never being reported as a
  // dead RC session.
  assert.equal(rcHandoffStep(true, 'unconfirmed'), 'finish', 'unknown must not become a blocker');

  // NOTHING TO ESTABLISH WITHOUT AN INJECTABLE WEBVIEW. The hand-off then opens the SYSTEM
  // browser, which already carries the user's own RC session — and a "sign in" button there
  // would navigate away from this screen and report nothing back, so the gate could never
  // lift. Every rcCheck must go straight through.
  for (const check of ['idle', 'opening', 'verified', 'unconfirmed'] as const) {
    assert.equal(rcHandoffStep(false, check), 'finish', `plain browser must never be gated (${check})`);
  }
});

test('the released screen actually uses the gate', () => {
  // THE FIX PRESENT BUT INERT is the shape that has cost this codebase two commits (6006428
  // claiming to fix an RC URL while only touching the copy; the poller not passing
  // `--claimed`). A gate nothing calls passes the test above and changes nothing on a phone,
  // so read the branch that had the bug and require both halves of the way through it.
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const released = src.slice(src.indexOf("state.status === 'released'"));
  assert.ok(released.length > 0, "the released branch must still exist");
  assert.match(released, /rcHandoffStep\(canInject, rcCheck\)/, 'the released screen must consult the gate');
  assert.match(released, /onClick=\{prepareRc\}/, 'and must offer the sign-in that lifts it');
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

/**
 * THE PLAIN-BROWSER "OPEN RC" CONTROL MUST BE A REAL LINK, NOT A BUTTON.
 *
 * Reported from a phone on 2026-08-16: "Clicking Open RC in another tab does not open in
 * another tab, it opens in this tab." The control was a button routed through
 * `openRcHandoff`, whose web branch is `window.location.href = url` — same tab, by its own
 * comment. That destroys the claim screen, which is where the site number, the dates and
 * the release button live, and the only way back is Back.
 *
 * `window.open` inside `prepareRc` is the fix that does NOT work: it is async and awaits
 * `injectableWebView()` before reaching the web branch, so the user-gesture window has
 * closed and Safari blocks the popup. That version looks right in review and fails on the
 * device it was written for. An anchor cannot be blocked.
 *
 * The button must SURVIVE for the injectable path — there is no tab to open there, and
 * `prepareRc` is what drives the InAppBrowser and makes the sign-in observable. Pinned both
 * ways, because deleting either branch is a silent regression on one platform.
 */
test('the browser opens RC in a new tab, and the app still uses the webview', () => {
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const body = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

  assert.match(body, /target="_blank"/, 'the browser control must genuinely open a new tab');
  assert.match(body, /rel="noopener noreferrer"/, 'a new tab must not get window.opener');

  // THE ANCHOR BELONGS TO THE NON-INJECTABLE ARM, and the injectable arm to whatever can
  // actually drive the webview.
  //
  // This used to pin `onClick={prepareRc}` as the injectable control. That was right until
  // the in-app sign-in re-landed and the arm became `<RcSignInForm>` — the rule was
  // unchanged, the thing implementing it moved, and a guard naming the implementation went
  // red over correct code. Pinned on the PROPERTY now: the injectable arm must not be the
  // plain-browser link, and the browser arm must be exactly that.
  const ternary = body.slice(body.indexOf('{canInject ? ('), body.indexOf('</>', body.indexOf('{canInject ? (')));
  assert.ok(ternary.length > 0, 'the two paths must be chosen by canInject');
  const elseAt = ternary.indexOf(') : (');
  assert.ok(elseAt > 0, 'the ternary must have both arms');
  const injectable = ternary.slice(0, elseAt);
  const browser = ternary.slice(elseAt);

  assert.ok(!/target="_blank"/.test(injectable),
    'the injectable arm must not be the new-tab link — there is no tab in a webview');
  assert.match(browser, /target="_blank"/, 'the browser arm must open a real new tab');
  assert.match(injectable, /RcSignInForm|onClick=\{prepareRc\}/,
    'the injectable arm must drive the webview — the sign-in form or prepareRc');
  assert.ok(!/RcSignInForm/.test(browser),
    'a sign-in form on the browser path is a promise nothing there can honour');
});

test('the browser copy no longer promises a tab it does not open', () => {
  // The old CTA said "Open ReserveCalifornia in another tab" while navigating in this one.
  // Whatever the wording becomes, it must not describe a tab unless the control opens one —
  // and the body should say the claim screen survives, which is the reason to care.
  const browser = handoffCopy(false);
  assert.match(browser.prepareBody, /stays open/i,
    'the user must be told this page survives, because they have to come back to it');
  const app = handoffCopy(true);
  assert.ok(!/another tab|your .*tab/i.test(app.prepareCta + app.prepareBody),
    'the app has no tabs — that wording has already been fixed there once');
});

/**
 * THE CLAIM CARD MUST NAME THE PARK, NOT ONLY THE SITE.
 *
 * 2026-08-16, from the browser walkthrough: "says site A012 but took me to 35-102 — there
 * are two sets of north end sites and we landed on the wrong one."
 *
 * The URL was RIGHT. A hold records the division that actually had the opening (loadWatches
 * selects `c.id AS campground_id` off the CROSS JOIN LATERAL expansion, not the watch's
 * representative), so `bookingUrlFor` sends the user to the correct facility. What was
 * missing was any way to CHECK that: the payload carried the site, the dates and the URL,
 * and never the campground, so the card could not say where "right" was.
 *
 * Since migration 070 one watch can span divisions of a park, and parks like South Carlsbad
 * have several similarly-named ones — the division name is the only thing distinguishing
 * them. A screen that cannot be verified is one nobody trusts at 08:00.
 */
test('the claim payload carries the campground, from the same row as the URL', () => {
  const src = readFileSync('src/app/api/rc-holds/claim/route.ts', 'utf8');
  const body = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  assert.match(body, /campgroundName: park\.name/, 'the payload must name the campground');
  // ONE QUERY, so the name and the URL cannot describe different divisions. Two lookups
  // would be two chances to drift, and the drift would tell the user to verify against the
  // wrong page — worse than not naming it.
  assert.match(body, /SELECT reservations_url, source, name FROM campgrounds WHERE id = \$1/,
    'the name must come from the same row as the booking URL');
  assert.ok(!/bookingUrlFor/.test(body), 'the old single-purpose helper must be gone, not shadowed');
});

test('every claim state renders the place', () => {
  const src = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8');
  const cards = src.match(/<SiteCard/g) ?? [];
  const places = src.match(/place=\{state\.campgroundName\}/g) ?? [];
  assert.ok(cards.length >= 3, 'expected the carted, released and terminal cards');
  assert.equal(places.length, cards.length,
    'every SiteCard must get the place — a user can be checking RC in any of these states');
  // Optional on the way in: an older cached payload has no campgroundName, and a missing
  // line is better than a wrong one.
  assert.match(src, /place\?: string \| null;/, 'the prop must tolerate an older payload');
});

/**
 * THE APP FAILED SILENTLY AND A REAL CAMPSITE WAS LOST — 2026-08-29.
 *
 * The bot's half was flawless: unit 43189 (`#94`, Morro Bay Upper Section) was carted at
 * T+6s and held for five minutes. The phone never signed in and never carted, and the owner
 * lost the site.
 *
 * The cause was a binary with no Cordova InAppBrowser — `appBuild: "1.0 (1)"`, which is
 * Capacitor's DEFAULT versionCode and therefore a local debug build, not a Codemagic one
 * (that workflow sets versionCode from PROJECT_BUILD_NUMBER and asserts the plugin). With no
 * plugin `canInject` is false, and the claim screen rendered the plain-browser copy — the
 * RIGHT copy for a browser, and inside the app indistinguishable from a working hand-off.
 *
 * Two defects, and the second is the expensive one:
 *   1. `notePlatform` computed the capability and threw it away, so the whole record of that
 *      morning was a version number that had to be decoded three files away.
 *   2. Nothing told the user. The screen that exists to say what is happening said nothing
 *      about the one thing that was not happening.
 */
test('the platform report carries the CAPABILITY, not just the platform', () => {
  // `appBuild` alone cannot answer "can this binary inject?" — it is a proxy that needs a
  // reader who knows Capacitor's default versionCode. `inAppBrowser` IS the answer, it is
  // already computed by the same `rcHandoffDiagnostics()` call, and it was being discarded.
  const body = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

  const report = body.slice(body.indexOf("stage: 'platform'"));
  assert.ok(report.length > 0, "the platform report must exist to be guarded");
  const detail = report.slice(0, report.indexOf('},'));

  assert.match(detail, /inAppBrowser: d\.inAppBrowser/, 'the capability itself must be reported');
  assert.match(detail, /iabModule: d\.iabModule/,
    'separates "absent from this binary" from "present but not yet clobbered"');
  // `canInject` is exactly this comparison, so the report and the gate cannot disagree.
  assert.match(body, /d\.inAppBrowser === 'present'/, 'the gate reads the same field it reports');
});

test('a native shell that cannot inject is DETECTED, and a browser is not', () => {
  const body = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

  // BOTH HALVES, PINNED AS ONE EXPRESSION. Either alone is a different, wrong feature: the
  // shell test alone warns every app user including the ones whose app works, and the
  // capability test alone warns every desktop browser — where the manual path is correct and
  // the warning is pure noise. A warning that cries wolf is a warning somebody deletes.
  assert.match(
    body,
    /setStaleShell\(\s*d\.nativeShell === 'true' && d\.inAppBrowser !== 'present'\s*\)/,
    'the notice must require BOTH a native shell and a missing plugin',
  );

  // A PROBE THAT HAS NOT ANSWERED, OR THREW, MUST NOT ACCUSE THE APP. `useState(false)` is
  // what makes "we could not tell" render as nothing rather than as "your app is broken" —
  // the same rule that stops `unknown` rounding to `signed-out`.
  assert.match(body, /const \[staleShell, setStaleShell\] = useState\(false\)/,
    'it must default to false, so a slow or failed probe shows no warning');
});

test('the stale-app warning is rendered, and ABOVE the instruction it corrects', () => {
  const body = readFileSync('src/components/v2/ClaimFlow.tsx', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

  // SCOPED TO THE `carted` BRANCH, measured inside it rather than across the file. A guard
  // that anchors on the first match anywhere reads the import list or a sibling branch and
  // passes whatever the markup does — the failure this repo has now recorded ~25 times.
  const start = body.indexOf("state.status === 'carted'");
  assert.ok(start > -1, 'the carted branch must exist to be guarded');
  const branch = body.slice(start, body.indexOf("state.status === 'claiming'"));
  assert.ok(branch.length > 0, 'the carted branch must be bounded by the next branch');

  const notice = branch.indexOf('staleShell &&');
  const instruction = branch.indexOf('When you tap the green button');
  assert.ok(notice > -1, 'a build that cannot cart must SAY SO on the screen that promises it');
  assert.ok(instruction > -1, 'the instruction paragraph must exist to be ordered against');
  assert.ok(
    notice < instruction,
    'the correction must precede the instruction it corrects, or it is read second or not at all',
  );

  // IT MUST NAME THE REMEDY. A caveat with no instruction changes nobody's morning — the
  // rule the auto-hold beta label already follows by naming an alarm clock.
  const rendered = branch.slice(notice, instruction).replace(/<[^>]*>/g, '');
  assert.match(rendered, /update CampHawk/i, 'say what to do about it, not just that it is broken');
  assert.match(rendered, /ReserveCalifornia now/i, 'and what to do RIGHT NOW, while the site is still held');
});
