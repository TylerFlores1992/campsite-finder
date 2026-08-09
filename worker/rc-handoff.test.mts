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
