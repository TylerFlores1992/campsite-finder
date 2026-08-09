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

test('the served precart is the extension file, and it parses', async () => {
  // ONE IMPLEMENTATION, TWO CONSUMERS. The extension keeps using its own copy (MV3 forbids
  // remote code); the phone fetches the same bytes. If this route ever grew its own copy
  // of the precart, RC's next schema change would fix one and leave the other broken —
  // exactly what rc-cart.mjs exists to prevent between the probe and the runner.
  const route = readFileSync('src/app/api/rc-precart/route.ts', 'utf8');
  assert.match(route, /extension/, 'the route must read from extension/, not embed a copy');
  assert.ok(
    !/precartdataforbookingmodify/.test(route),
    'the route must not contain precart logic of its own — serve the file',
  );

  // Build the same string the route builds and check it is valid JS. A syntax error here
  // injects nothing, and an injection that runs nothing is indistinguishable from a cart
  // that failed silently.
  const inject = readFileSync('extension/rc-inject.js', 'utf8');
  const content = readFileSync('extension/content-rc.js', 'utf8');
  const shim = 'if (typeof chrome === "undefined") { var chrome = { storage: { local: { get: function (d, cb) { cb({}); } } } }; }';
  const script = [shim, inject, content].join('\n');
  new (await import('node:vm')).Script(script); // throws on a syntax error

  // The one string the handoff sanity-checks the response body for.
  assert.match(script, /precartdataforbookingmodify/);
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
