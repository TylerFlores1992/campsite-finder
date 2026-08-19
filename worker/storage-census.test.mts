// WHERE IS THE STALE TOKEN HIDING?
//
// Four consecutive renewals on 2026-08-19 produced the same impossible pair:
//
//     ✗ no fresher token (none → -267960s), got as far as: none
//         cleared 0 storage key(s): (none — nothing was there to drop)
//
// No token BEFORE, a 74-hour-dead one AFTER, and the negative growing ~700s per run — one
// fixed ancient expiry receding, i.e. the SAME corpse returning. Something restores it during
// the navigation from a store `dropStoredToken` does not cover: it sweeps localStorage only,
// and within it only `ssoAccessToken`, `accessToken` and keys starting `okta-`.
//
// THE RULE THAT SHAPES THIS FILE: values are never reported. Every value here is potentially
// the session itself, and this repo has published a credential twice by collecting a field it
// then had to filter — an OAuth code on 2026-08-09 and a user's password on 08-16. A key name,
// a character count, and a locally-decoded expiry are enough to identify the corpse, and none
// of them can be replayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  censusInPage, takeStorageCensus, describeCensus, MAX_KEYS,
} from '../scripts/auto-cart-bot/storage-census.mjs';

const SRC = readFileSync('scripts/auto-cart-bot/storage-census.mjs', 'utf8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const KEEPWARM = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const NOW = 1_700_000_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (exp: number) => `eyJhbGciOiJSUzI1NiJ9.${b64({ exp })}.sig`;

/** A stand-in for a Storage, so `censusInPage` can be run without a browser. */
function fakeStore(pairs: [string, string][]) {
  return {
    length: pairs.length,
    key: (i: number) => pairs[i]?.[0] ?? null,
    getItem: (k: string) => pairs.find((p) => p[0] === k)?.[1] ?? null,
  };
}

/** Run the injected body with globals it expects, exactly as the page would. */
function runCensus(local: [string, string][], session: [string, string][] = []) {
  const g = globalThis as Record<string, unknown>;
  const saved = [g.localStorage, g.sessionStorage];
  g.localStorage = fakeStore(local);
  g.sessionStorage = fakeStore(session);
  try { return censusInPage(MAX_KEYS); } finally { [g.localStorage, g.sessionStorage] = saved; }
}

test('NO VALUE IS EVER RETURNED — only a name, a length and an expiry', () => {
  const secret = jwt(NOW - 60);
  const c = runCensus([['accessToken', secret]]);
  const serialised = JSON.stringify(c);
  assert.ok(!serialised.includes(secret), 'the token must not appear in the census at all');
  assert.ok(!serialised.includes('sig'), 'nor any segment of it');
  assert.equal(c.local[0].key, 'accessToken');
  assert.equal(c.local[0].len, secret.length, 'the length is the safe proxy for the value');
  assert.equal(c.local[0].exp, NOW - 60, 'and the expiry is what identifies the corpse');
});

test('the expiry is decoded locally, and a non-JWT is left entirely alone', () => {
  const c = runCensus([
    ['shoppingCartKey', '68928f9e-1234-4321-9999-abcdefabcdef'],
    ['theme', 'dark'],
  ]);
  assert.deepEqual(c.local.map((e: { exp: number | null }) => e.exp), [null, null],
    'a value that is not a JWT must not be parsed or reported on');
});

test('a corpse under a name the clear does not cover is FLAGGED', () => {
  // The whole point. `dropStoredToken` sweeps `ssoAccessToken`, `accessToken` and `okta-*` —
  // a token under any other name survives every clear we have ever run.
  const said = describeCensus(runCensus([['rcUserSession', jwt(NOW - 74 * 3600)]]), { nowSec: NOW });
  assert.match(said, /rcUserSession/);
  assert.match(said, /EXPIRED 74h ago/);
  assert.match(said, /SURVIVES the clear/);
});

test('sessionStorage always survives, whatever the key is called', () => {
  // `dropStoredToken` never touches sessionStorage at all, so even a key it WOULD sweep in
  // localStorage is untouched there. That is a property of the store, not of the name.
  const said = describeCensus(runCensus([], [['accessToken', jwt(NOW - 3600)]]), { nowSec: NOW });
  assert.match(said, /session:accessToken/);
  assert.match(said, /SURVIVES the clear/,
    'a name the clear covers is still safe from it when it lives in the wrong store');
});

test('a key the clear DOES cover is not flagged as surviving', () => {
  // Or the flag means nothing — everything would carry it.
  const said = describeCensus(runCensus([['okta-token-storage', jwt(NOW + 3000)]]), { nowSec: NOW });
  assert.match(said, /okta-token-storage/);
  assert.ok(!/SURVIVES/.test(said), 'the clear reaches okta-* in localStorage');
});

test('clean stores point ELSEWHERE rather than declaring the profile innocent', () => {
  // The corpse has to come from somewhere. If neither web store holds one, that is a
  // redirection to IndexedDB, a cookie or the server — not an all-clear.
  const said = describeCensus(runCensus([['theme', 'dark']]), { nowSec: NOW });
  assert.match(said, /NO token-shaped value/);
  assert.match(said, /IndexedDB, a cookie, or the server/);
});

test('a failed read is "no reading", never an empty profile', () => {
  // The house rule, and the one this file would be most tempting to get wrong: a page that
  // will not evaluate and a profile with no keys are different facts, and only one is a lead.
  assert.match(describeCensus(null), /could not read the page/);
  assert.match(describeCensus(null), /not an empty profile/);
});

test('takeStorageCensus never throws, and rejects a malformed reading', async () => {
  assert.equal(await takeStorageCensus(async () => { throw new Error('page gone'); }), null);
  assert.equal(await takeStorageCensus(async () => null), null);
  assert.equal(await takeStorageCensus(async () => ({ nonsense: true })), null,
    'a shape that is not a census must read as no reading, not as empty stores');
});

test('there is no always-empty idb field to be misread as "we looked"', () => {
  // An `idb: []` returned by a synchronous body that never enumerates IndexedDB would read as
  // "we looked and found none" — the zero-for-an-absent-reading mistake this repo has made
  // twice. IndexedDB is simply not covered, and the clean-stores message says so.
  const c = runCensus([['a', 'b']]);
  assert.ok(!('idb' in c), 'no field may claim coverage the census does not have');
  assert.ok(!/indexedDB/.test(code), 'and the injected body must stay synchronous');
});

test('the census fires ONLY on the pathology, not on every renewal', () => {
  // It reads every key name in both stores. Doing that on every renewal would be noise on the
  // one log a human reads at 07:30, and the signature is specific: the renewal failed AND
  // handed back a token that is already expired.
  const at = KEEPWARM.indexOf('takeStorageCensus(');
  assert.ok(at > -1, 'the census must be wired in');
  const before = KEEPWARM.slice(Math.max(0, at - 400), at);
  assert.match(before, /!r\.renewed && r\.after != null && r\.after < 0/,
    'gated on a failed renewal that returned an ALREADY-EXPIRED token');
});

test('the census is bounded and time-limited', () => {
  assert.ok(MAX_KEYS > 0 && MAX_KEYS <= 100, 'a profile with hundreds of keys must not bury it');
  assert.match(code, /out\.length < limit/, 'the scan must stop at the cap');
  assert.match(KEEPWARM, /takeStorageCensus\(\s*\(fn, arg\) => evaluateWithin\(/,
    'and run through the bounded evaluate — this page is already suspected of hanging');
});
