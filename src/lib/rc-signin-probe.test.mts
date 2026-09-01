/**
 * THE TWO INSTRUMENTS THE 2026-08-31 HAND-OFF QUESTION NEEDS, AND WHY THEY ARE GUARDED.
 *
 * The open bug: the bot carts, releases, the user's own session re-carts, RC confirms it
 * holds the reservation — and RC's page then shows no name in the corner and asks the owner
 * to log in. A real campsite locked, and the person told it is theirs cannot reach it.
 *
 * Two things had to become measurable, and both were built to answer it in ONE press:
 *
 *  1. The deferred close (#240) could only be reached through a live 8am hold, which means
 *     locking a real campsite and shutting the box's update window. The admin probe already
 *     exercises the same `openRcHandoff` seam with no hold; it just never passed
 *     `closeOnToken`. Now there are two buttons and they differ in exactly that.
 *
 *  2. `sessionProbe` read `ssoAccessToken`/`accessToken` — RC's OWN copies. okta-auth-js
 *     decides login state from its own `okta-` store, which is why `dropStoredToken` had to
 *     be widened past those two keys on 08-15. So every reading ever taken was blind to the
 *     store that drives the header name and the cart page's login prompt.
 *
 * UNDER `src/`, NOT `worker/`, for the reason the sibling file states: `npm test` globs
 * both, but `worker/**` is the FIRST entry in `worker-deploy.yml`'s `paths:`, and a guard
 * over two web modules has no business restarting both poller machines. Checked against the
 * workflow rather than remembered — "no rebuild" and "no worker deploy" are different
 * claims, and this repo has recorded getting that wrong twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sessionProbe } from './rc-precart-script';
import { closeReasonReading } from './rc-token-liveness';

const admin = readFileSync(new URL('../components/admin/AdminTabs.tsx', import.meta.url), 'utf8');

/** Comments quote the very shapes these tests forbid, so they are stripped first. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// 1. The probe that exercises the deferred close without locking a campsite.
// ---------------------------------------------------------------------------

test('the RC probe runs BOTH close behaviours, and the control is still there', () => {
  const src = code(admin);
  assert.match(src, /async function run\(closeOnToken: boolean\)/,
    'run() must take the one variable under test');
  assert.match(src, /openRcHandoff\(\s*\{ url: 'https:\/\/www\.reservecalifornia\.com\/' \},\s*\{ onReport, closeOnToken \},/,
    'THE FIX-PRESENT-BUT-INERT SHAPE: run() can take the flag and never pass it on, in which'
    + ' case both buttons are the same probe and the panel lies about offering a comparison');
  assert.match(src, /onClick=\{\(\) => void run\(false\)\}/,
    'the CONTROL must survive — its open window is what bisected this on 08-31, and a'
    + ' comparison with no control is how a repair gets credited to the wrong mechanism');
  assert.match(src, /onClick=\{\(\) => void run\(true\)\}/,
    'and the variant is the claim screen behaviour, reachable with no hold');
});

test('neither probe button hands React the MouseEvent as closeOnToken', () => {
  // `onClick={run}` passes React's synthetic event to the first parameter. It is TRUTHY, so
  // the control button would silently run the variant and the two would be one probe wearing
  // two labels — a broken experiment that reports as a working one, which is the exact class
  // of silent defect this file exists for.
  assert.doesNotMatch(code(admin), /onClick=\{run\}/,
    'bind the argument explicitly; a bare handler reference makes the control run the variant');
});

// ---------------------------------------------------------------------------
// 2. The okta store census. Behavioural — the bundle is a STRING, and a regex over it
//    would assert the shape of the source rather than what the browser does with it.
// ---------------------------------------------------------------------------

function jwt(expDeltaSec: number): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.round(Date.now() / 1000);
  return `${b({ alg: 'RS256' })}.${b({ exp: now + expDeltaSec, iat: now })}.sig`;
}

interface SessionDetail {
  at?: string;
  storedToken?: string;
  oktaKeys?: number;
  oktaNames?: string;
  oktaToken?: string;
  oktaExpiresInSec?: number | null;
  ssoToken?: string;
  rcToken?: string;
  rcLoggedIn?: boolean;
}

/** Run the REAL emitted bundle against a stub localStorage and return its `session` report. */
function probe(store: Record<string, string>): { detail: SessionDetail; wire: string } {
  const sent: Array<[string, Record<string, unknown>]> = [];
  const data: Record<string, string> = { ...store };
  const ls = {
    get length() { return Object.keys(data).length; },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
  };
  const ctx: Record<string, unknown> = {
    localStorage: ls,
    atob: (x: string) => Buffer.from(x, 'base64').toString('binary'),
    JSON, Date, Math, String, Object, Array,
  };
  ctx.window = ctx;
  ctx.__camphawkRc = {
    send: (stage: string, d: Record<string, unknown>) => sent.push([stage, d]),
    href: () => 'https://www.reservecalifornia.com/park/690/612',
    jwtFacts(t: string) {
      const out: { decodable: boolean; expiresInSec: number | null } =
        { decodable: false, expiresInSec: null };
      try {
        const p = String(t).split('.')[1];
        if (!p) return out;
        let b = p.replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        const j = JSON.parse(Buffer.from(b, 'base64').toString()) as { exp?: number };
        out.decodable = true;
        if (typeof j.exp === 'number') out.expiresInSec = Math.round(j.exp - Date.now() / 1000);
      } catch { /* an undecodable token is a real reading */ }
      return out;
    },
    onToken: null,
  };
  vm.createContext(ctx);
  vm.runInContext(sessionProbe(), ctx);
  const detail = (sent.find(([s]) => s === 'session')?.[1] ?? {}) as SessionDetail;
  return { detail, wire: JSON.stringify(sent) };
}

test('THE SPLIT: an empty okta store beside a live RC copy is reported as such', () => {
  // The hypothesis-confirming shape. RC's own copy is healthy and the SDK store — the one
  // that decides whether the page renders a name — holds nothing.
  const { detail } = probe({ ssoAccessToken: jwt(3500) });
  assert.equal(detail.storedToken, 'jwt');
  assert.equal(detail.oktaToken, 'none');
  assert.equal(detail.oktaKeys, 0);
});

test('THE OTHER BRANCH: a populated okta store is reported with its expiry', () => {
  const live = jwt(3500);
  const { detail } = probe({
    ssoAccessToken: live,
    'okta-token-storage': JSON.stringify({ accessToken: { accessToken: live, expiresAt: 1 } }),
    'okta-cache-storage': '{}',
  });
  assert.equal(detail.oktaToken, 'jwt');
  assert.equal(detail.oktaKeys, 2);
  assert.match(detail.oktaNames ?? '', /okta-token-storage/);
  assert.ok((detail.oktaExpiresInSec ?? 0) > 3000, 'a live SDK token must report its life');
});

test('THE 08-15 BREADCRUMB IS NOT A TOKEN STORE', () => {
  // `okta-original-uri-storage` is a redirect breadcrumb. The 08-15 sweep found exactly this
  // one key, and reading "one okta- key" as "a session" is the misreading this pair of
  // fields exists to prevent: the COUNT is 1 and the token is none, and both are printed.
  const { detail } = probe({
    ssoAccessToken: jwt(3500),
    'okta-original-uri-storage': 'https://www.reservecalifornia.com/',
  });
  assert.equal(detail.oktaKeys, 1);
  assert.equal(detail.oktaToken, 'none',
    'a non-token entry must not be reported as a token we merely could not decode');
});

test('PRESENCE IS NOT LIVENESS: an expired SDK token reports a negative expiry', () => {
  const { detail } = probe({
    'okta-token-storage': JSON.stringify({ accessToken: { accessToken: jwt(-9000) } }),
  });
  assert.equal(detail.oktaToken, 'jwt');
  assert.ok((detail.oktaExpiresInSec ?? 0) < 0,
    'reporting only the shape would merge a dead token with a live one');
});

test('NO VALUE EVER LEAVES THE STORE', () => {
  // This repo has published a credential twice by collecting a field it then had to filter —
  // an OAuth authorization code on 2026-08-09 and a password on 08-16. Every value in the
  // okta store is or contains the session, so the rule is that the token is matched against
  // and measured, never carried. Asserted against the WHOLE wire payload, not the fields we
  // remembered to check.
  const secret = jwt(3500);
  const { wire } = probe({
    ssoAccessToken: secret,
    'okta-token-storage': JSON.stringify({ accessToken: { accessToken: secret } }),
  });
  assert.ok(!wire.includes(secret), 'the token itself must never be reported');
  assert.ok(!wire.includes(secret.split('.')[1]), 'nor its payload segment');
});

test('a store that cannot be read reports nothing rather than a zero', () => {
  // "We could not look" and "we looked and found none" are different facts — the rule
  // `hasAvailabilityInRange` returning null already encodes. A throwing localStorage must
  // not manufacture an all-clear that reads as evidence.
  const sent: Array<[string, Record<string, unknown>]> = [];
  const ctx: Record<string, unknown> = {
    localStorage: {
      get length(): number { throw new Error('SecurityError'); },
      key: () => null,
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
    },
    atob: (x: string) => Buffer.from(x, 'base64').toString('binary'),
    JSON, Date, Math, String, Object, Array,
  };
  ctx.window = ctx;
  ctx.__camphawkRc = {
    send: (stage: string, d: Record<string, unknown>) => sent.push([stage, d]),
    // `href` is installed by `reporter()` alongside `send`, so a partially-built R is not a
    // real state — but the stub has to model the whole shape or it tests a different object.
    href: () => 'https://www.reservecalifornia.com/',
    jwtFacts: () => ({ decodable: false, expiresInSec: null }),
    onToken: null,
  };
  vm.createContext(ctx);
  // The whole point is that it does not throw out of the injected script and take the rest
  // of the bundle's reporting with it.
  assert.doesNotThrow(() => vm.runInContext(sessionProbe(), ctx));
  assert.ok(sent.some(([s]) => s === 'session'), 'it must still report that it ran');
});

// ---------------------------------------------------------------------------
// 3. The caps, derived — not a number somebody has to remember to raise.
// ---------------------------------------------------------------------------

test('both report routes accept every field the session probe sends', () => {
  // THE SILENT-TRUNCATION SHAPE, and it very nearly happened here. Object key order is
  // insertion order, so the four `okta*` fields sit at the END of the `session` detail —
  // under the old ceilings (8 on the hold path, 10 on the admin path) they were exactly
  // what got dropped, and the instrument would have reported nothing while looking like it
  // had run. Derived from what the probe ACTUALLY sends, so the next field added fails here
  // rather than disappearing in production.
  const { detail } = probe({ ssoAccessToken: jwt(3500), 'okta-token-storage': '{}' });
  const fields = Object.keys(detail).length;
  assert.ok(fields >= 11, `the session report should be wide; saw ${fields}`);

  for (const rel of ['../app/api/rc-holds/report/route.ts', '../app/api/admin/rc-session-probe/route.ts']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const m = src.match(/Object\.keys\(out\)\.length >= (\d+)/);
    assert.ok(m, `${rel} must still cap detail keys at all — the bound is not optional`);
    assert.ok(Number(m![1]) >= fields,
      `${rel} caps detail at ${m![1]} but the session probe sends ${fields} fields, so`
      + ' the last ones are dropped in silence');
  }
});

// ---------------------------------------------------------------------------
// 4. Reading the close reason. Since #249 there is one ordinary reason, `session`; every
//    other reason is a pre-#249 host and is named as the race it was.
// ---------------------------------------------------------------------------

test('`session` is the ordinary close and reads as such', () => {
  for (const signedIn of [true, false]) {
    const r = closeReasonReading('session', signedIn);
    assert.equal(r.level, 'info');
    assert.match(r.text, /customerId/, 'it must name the signal RC actually decides on');
  }
});

test('`timeout` and `settled` are pre-#249 hosts racing step two, and say so', () => {
  // These were read as "the backstop fired" / "the fix working" until 09-01. Both were the
  // race: `settled` could never fire (RC's post-login navigation is client-side) and
  // `timeout` fired on both platforms every time. A cached old host can still send them,
  // and reading one as a new bug would send the next person hunting a defect that is the
  // one already fixed.
  for (const reason of ['timeout', 'settled']) {
    const r = closeReasonReading(reason, true);
    assert.equal(r.level, 'warn', reason);
    assert.match(r.text, /pre-#249|step two/, reason);
  }
});

test('`token` AFTER a real sign-in cut step two off — a pre-#240 host', () => {
  const r = closeReasonReading('token', true);
  assert.equal(r.level, 'warn', 'this is the one case that must stand out');
  assert.match(r.text, /step two|cut off/);
});

test('but `token` with NO sign-in is the already-signed-in path and is fine', () => {
  // Reporting this as a warning would put a red line on every ordinary hand-off by a user
  // whose session was already live — far and away the common case — and a warning that
  // fires on the normal path is one nobody reads on the morning it is true.
  const r = closeReasonReading('token', false);
  assert.equal(r.level, 'info');
  assert.match(r.text, /already-signed-in/);
});

test('an unrecognised reason is reported as itself, never folded into a known one', () => {
  // A host may one day send a fifth reason. Guessing which known case it resembles is how
  // an absent reading becomes a negative.
  const r = closeReasonReading('something-new', true);
  assert.equal(r.level, 'info');
  assert.doesNotMatch(r.text, /customerId|step two|pre-#249/,
    'an unknown reason must not borrow another reading\'s verdict');
});

test('the readout ROUTES through the shared reading rather than keeping its own copy', () => {
  // THE FIX-PRESENT-BUT-INERT SHAPE. `closeReasonReading` can be perfect while the readout
  // keeps the ternary it was extracted from, and every test above would still pass — which
  // is how `closeOnToken` shipped guarded-but-wrong in #126.
  const src = code(readFileSync(new URL('../../scripts/rc-holds-readout.mts', import.meta.url), 'utf8'));
  // ANCHORED ON THE IMPORTED NAME, NOT THE WHOLE LINE (re-anchored 2026-09-01). This pinned
  // the import statement verbatim, so adding a SECOND reading to the same import failed the
  // guard over behaviour that had not changed — the twenty-somethingth instance of a guard
  // anchoring on the wrong thing. What matters is that the name comes from the shared
  // module, which is exactly what a bare `const closeReasonReading = ...` copy would not.
  assert.match(src, /import \{[^}]*\bcloseReasonReading\b[^}]*\} from '\.\.\/src\/lib\/rc-token-liveness'/);
  assert.match(src, /closeReasonReading\(closeReason, signedInHere\)/,
    'the readout must ASK, not decide');
  assert.match(src, /reading\.level === 'warn'/,
    'and it must take the severity from the reading, or the one case that matters is unmarked');
  // The signed-in flag must come from the STAGES. Deriving it from the reason would make the
  // discriminator circular and the warn branch unreachable.
  assert.match(src, /stage === 'password'|stage === 'submitted'|stage === 'signin-open'/);
});

// ---------------------------------------------------------------------------
// 5. The reading is only interpretable if you know WHICH store it came from, and
//    WHEN. Both were got wrong on the first pass and both are caught by real data.
// ---------------------------------------------------------------------------

test('the census says which ORIGIN it was taken on', () => {
  // localStorage is per-origin and a sign-in walks across two — RC's SPA on
  // www.reservecalifornia.com, Okta's form on signin.reservecalifornia.com. One real
  // hand-off (hold 43832) produced ELEVEN session reports from both. Without this field a
  // census taken on the signin origin reads as the SPA's store being empty, which is a FALSE
  // CONFIRMATION of the leading hypothesis.
  const { detail } = probe({ ssoAccessToken: jwt(3500) });
  assert.equal(typeof detail.at, 'string');
  assert.match(detail.at!, /^https:\/\/www\.reservecalifornia\.com/);
});

test('and never with the query string, because the callback carries an OAuth code', () => {
  // `R.href()` is origin + pathname by construction. Pinned here because this report is the
  // one taken ON the callback document, where `?code=` is exchangeable for the session —
  // published once already, on 2026-08-09, by reporting location.href.
  const { detail } = probe({});
  assert.ok(!(detail.at ?? '').includes('?'), 'no query string may reach the report');
});

test('the readout scores the LAST session on RC OWN origin, not the first', () => {
  // THE FIRST is the park page before anyone has signed in, where an empty okta store is the
  // correct and uninteresting answer — so scoring it would report the bug on every healthy
  // hand-off. Reading the first is also the exact mistake that cost a diagnosis on 08-29, in
  // this same block, which is why `cart-verified` beside it already uses findLast.
  const src = code(readFileSync(new URL('../../scripts/rc-holds-readout.mts', import.meta.url), 'utf8'));
  const i = src.indexOf('const sessions =');
  assert.ok(i > -1, 'the readout must still gather the session reports');
  const block = src.slice(i, i + 700);
  assert.match(block, /findLast/, 'the newest reading is the one that answers the question');
  assert.doesNotMatch(block, /sessions\.find\(/,
    'the FIRST session report is pre-sign-in and would report the bug on every healthy run');
  assert.match(block, /www\.reservecalifornia\.com/,
    'and it must be scoped to RC own origin, or it scores the wrong localStorage');
});

// ---------------------------------------------------------------------------
// 5. THE CENSUS READS THE KEYS RC ACTUALLY DECIDES ON (2026-09-01, #249).
//
//    Read out of RC's bundle: `isLoggedIn: !!localStorage.getItem("customerId")`; the Okta
//    JWT is `ssoAccessToken` (step one) and RC's own token is `accessToken` (step two, beside
//    `customerId`); and okta-auth-js's store is wrapped by secure-ls under `@secure.s.`, so a
//    prefix test on `okta-` never saw it. Every reading before this change was blind to all
//    three, which is how two hand-offs with opposite outcomes produced identical censuses.
// ---------------------------------------------------------------------------

test('rcLoggedIn is customerId, as a boolean, and nothing else', () => {
  const signedIn = probe({ ssoAccessToken: jwt(3500), accessToken: jwt(3500), customerId: 'MTIzNDU=' });
  assert.equal(signedIn.detail.rcLoggedIn, true);
  assert.ok(!signedIn.wire.includes('MTIzNDU='), 'the customer id VALUE must never cross the wire');

  // THE 09-01 STATE: Okta's token present, RC's absent, customerId absent. This is the
  // state that renders signed out over a locked campsite, and `storedToken: "jwt"` alone
  // called it signed in.
  const cutOff = probe({ ssoAccessToken: jwt(3500) });
  assert.equal(cutOff.detail.rcLoggedIn, false);
  assert.equal(cutOff.detail.storedToken, 'jwt', 'the old field still reads jwt — which is why it could not discriminate');
});

test('the two tokens are reported separately — step one and step two are different facts', () => {
  const cutOff = probe({ ssoAccessToken: jwt(3500) });
  assert.equal(cutOff.detail.ssoToken, 'jwt');
  assert.equal(cutOff.detail.rcToken, 'none');

  const full = probe({ ssoAccessToken: jwt(3500), accessToken: jwt(3400), customerId: '1' });
  assert.equal(full.detail.ssoToken, 'jwt');
  assert.equal(full.detail.rcToken, 'jwt');

  const out = probe({});
  assert.equal(out.detail.ssoToken, 'none');
  assert.equal(out.detail.rcToken, 'none');
  assert.equal(out.detail.rcLoggedIn, false);
});

test("RC's real okta store is under `@secure.s.` and is COUNTED, not skipped", () => {
  // `customerLogOut` in RC's bundle removes `@secure.s.okta-token-storage` and
  // `@secure.s.okta-cache-storage`. A prefix test saw neither.
  const { detail } = probe({
    ssoAccessToken: jwt(3500),
    'okta-original-uri-storage': '{"uri":"/park/690/612"}',
    '@secure.s.okta-token-storage': 'U2FsdGVkX1+' + 'x'.repeat(200),
    '@secure.s.okta-cache-storage': 'U2FsdGVkX1+' + 'y'.repeat(60),
  });
  assert.equal(detail.oktaKeys, 3, 'all three okta keys must be counted, wherever the prefix sits');
  assert.match(detail.oktaNames ?? '', /@secure\.s\.okta-token-storage/);
});

test('an ENCODED token store is a third shape — present and unreadable, never `none`', () => {
  // secure-ls encodes its values, so the JWT regex cannot match. Reporting that as `none`
  // is the breadcrumb reading applied to the wrong key: it printed "the SDK never finished
  // its half" over a store that was populated. `encoded` says what it is.
  const { detail } = probe({
    ssoAccessToken: jwt(3500),
    '@secure.s.okta-token-storage': 'U2FsdGVkX1+' + 'x'.repeat(200),
  });
  assert.equal(detail.oktaToken, 'encoded');

  // But the breadcrumb alone is still `none` — one key and no token store is not a session.
  const crumb = probe({ ssoAccessToken: jwt(3500), 'okta-original-uri-storage': '/park/1/2' });
  assert.equal(crumb.detail.oktaToken, 'none');
  assert.equal(crumb.detail.oktaKeys, 1);
});

test('a readable JWT in the store still wins over `encoded`', () => {
  const live = jwt(3500);
  const { detail } = probe({
    'okta-token-storage': JSON.stringify({ accessToken: { accessToken: live } }),
    '@secure.s.okta-cache-storage': 'U2FsdGVkX1+' + 'z'.repeat(100),
  });
  assert.equal(detail.oktaToken, 'jwt', 'a decodable token is the stronger reading');
});

// ---------------------------------------------------------------------------
// 6. THE REPORTER WATCHES customerId AND REPORTS IT — the signal the host closes on.
//    Behavioural: the real emitted reporter runs in a sandbox with a fake clock, and the
//    assertions are on what it SENDS, not on the text of the source.
// ---------------------------------------------------------------------------

import { reporter } from './rc-precart-script';
import { mock } from 'node:test';

function reporterPage(store: Record<string, string>) {
  const sent: Array<{ stage: string; detail: Record<string, unknown> | null }> = [];
  const data: Record<string, string> = { ...store };
  const ls = {
    get length() { return Object.keys(data).length; },
    key: (i: number) => Object.keys(data)[i] ?? null,
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
  };
  const created: Record<string, unknown>[] = [];
  const byId: Record<string, Record<string, unknown>> = {};
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const ctx: Record<string, unknown> = {
    localStorage: ls,
    sessionStorage: { getItem: () => null },
    location: { origin: 'https://www.reservecalifornia.com', pathname: '/park/690/612', hash: '' },
    document: {
      getElementById: (id: string) => byId[id] ?? null,
      createElement: () => {
        const el: Record<string, unknown> = {
          setAttribute(_k: string, _v: string) {}, remove() { delete byId[String(el.id)]; },
        };
        created.push(el); return el;
      },
      body: { appendChild: (el: Record<string, unknown>) => { byId[String(el.id)] = el; } },
      documentElement: {},
    },
    console: { log: () => {}, error: () => {} },
    // The bridge: the real reporter posts JSON strings through it.
    cordova_iab: { postMessage: (s: string) => { const r = JSON.parse(s); sent.push({ stage: r.stage, detail: r.detail }); } },
    // UNREF'D, or the reporter's 500ms poll keeps the test process alive for ever — a run
    // that never exits is not a failing test, it is a hung suite.
    setInterval: (fn: () => void, ms: number) => {
      const h = setInterval(fn, ms) as unknown as { unref?: () => void };
      h.unref?.();
      return h;
    },
    clearInterval, setTimeout, clearTimeout,
    atob: (x: string) => Buffer.from(x, 'base64').toString('binary'),
    JSON, Date, Math, String, Object, Array, Number,
    addEventListener: (e: string, cb: (x: unknown) => void) => { (listeners[e] ??= []).push(cb); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(reporter(), ctx);
  const fire = (e: string, ev: unknown) => (listeners[e] ?? []).forEach((cb) => cb(ev));
  // `window` INSIDE the context is vm's contextified proxy, not the raw sandbox object — so
  // a message whose `source` is the raw `ctx` fails the reporter's `e.source !== window`
  // guard, exactly as a cross-frame message should. Found by running it: the token report
  // never arrived and the listener was provably registered. Fire with the inner window.
  const win = vm.runInContext('window', ctx) as unknown;
  return { sent, data, fire, byId, win };
}

test('rc-session is reported on install, from customerId, as a boolean', () => {
  const out = reporterPage({ ssoAccessToken: 'x' });
  const first = out.sent.find((r) => r.stage === 'rc-session');
  assert.ok(first, 'the host closes on this report — it must be sent without being asked');
  assert.equal(first!.detail?.loggedIn, false);

  const signed = reporterPage({ customerId: 'MTIz' });
  const s = signed.sent.find((r) => r.stage === 'rc-session');
  assert.equal(s?.detail?.loggedIn, true, 'a page that boots signed in must say so at once — the 08-12 stranded case');
  assert.ok(!JSON.stringify(signed.sent).includes('MTIz'), 'the id value never crosses the wire');
});

test('rc-session is re-reported when customerId APPEARS — once, not every tick', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const out = reporterPage({ ssoAccessToken: 'x' });
  assert.equal(out.sent.filter((r) => r.stage === 'rc-session').length, 1);

  mock.timers.tick(2_000);
  assert.equal(out.sent.filter((r) => r.stage === 'rc-session').length, 1, 'no change, no report');

  // Step two lands: RC writes customerId.
  out.data.customerId = 'MTIz';
  mock.timers.tick(1_000);
  const rc = out.sent.filter((r) => r.stage === 'rc-session');
  assert.equal(rc.length, 2, 'the flip must be reported exactly once');
  assert.equal(rc[1].detail?.loggedIn, true);

  mock.timers.tick(30_000);
  assert.equal(out.sent.filter((r) => r.stage === 'rc-session').length, 2, 'and never again while unchanged');
});

test('a token with no customerId for 30s shows the hold notice and reports it — and never closes', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const out = reporterPage({ ssoAccessToken: 'x' });
  // rc-inject broadcasts the captured token as a window message.
  out.fire('message', { source: out.win, data: { __camphawk_token: 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig' } });
  assert.ok(out.sent.some((r) => r.stage === 'token'), 'the token must have been seen');

  mock.timers.tick(20_000);
  assert.ok(!out.sent.some((r) => r.stage === 'settle-timeout'), 'too early for a notice');
  assert.ok(!out.byId['camphawk-rc-hold'], 'no notice yet');

  mock.timers.tick(12_000);
  const st = out.sent.find((r) => r.stage === 'settle-timeout');
  assert.ok(st, 'the stalled sign-in must be reported');
  assert.equal(st!.detail?.held, true, 'HELD — the window is not closed, the user is told');
  assert.ok(out.byId['camphawk-rc-hold'], 'the notice must be on the page, where the user is looking');
  assert.equal(out.sent.filter((r) => r.stage === 'settle-timeout').length, 1);

  // Step two finally lands: the notice goes and the session is reported.
  out.data.customerId = 'MTIz';
  mock.timers.tick(1_000);
  assert.ok(!out.byId['camphawk-rc-hold'], 'the notice must be removed once RC finishes');
  assert.equal(out.sent.filter((r) => r.stage === 'rc-session' && r.detail?.loggedIn === true).length, 1);
});

test('no token, no notice — a signed-out page that nobody is signing into is not "stalled"', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const out = reporterPage({});
  mock.timers.tick(120_000);
  assert.ok(!out.sent.some((r) => r.stage === 'settle-timeout'));
  assert.ok(!out.byId['camphawk-rc-hold']);
});
