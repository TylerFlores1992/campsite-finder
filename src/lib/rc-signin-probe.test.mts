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
  storedToken?: string;
  oktaKeys?: number;
  oktaNames?: string;
  oktaToken?: string;
  oktaExpiresInSec?: number | null;
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
