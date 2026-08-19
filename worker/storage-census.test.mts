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
  censusInPage, idbCensusInPage, takeStorageCensus, takeIdbCensus,
  describeCensus, describeIdb, MAX_KEYS,
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
  // redirection — not an all-clear. This is the reading the box actually produced on
  // 2026-08-19: `local 6 key(s), session 1 key(s) — NO token-shaped value in either store`.
  const said = describeCensus(runCensus([['theme', 'dark']]), { nowSec: NOW });
  assert.match(said, /NO token-shaped value/);
  assert.match(said, /coming from somewhere else/);
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

test('the web-store body stays SYNCHRONOUS — IndexedDB is a separate evaluate', () => {
  // The two readings must be independent. `idbCensusInPage` is async and talks to a subsystem
  // that can block; the web-store census is the one that has already produced a finding, and a
  // hung database must not be able to take it down with it. One evaluate for both would make
  // exactly that possible.
  const c = runCensus([['a', 'b']]);
  assert.ok(!('idb' in c), 'the synchronous body must not claim coverage it does not have');
  const sync = code.slice(code.indexOf('export function censusInPage'), code.indexOf('export function idbCensusInPage'));
  assert.ok(!/indexedDB/.test(sync), 'and it must not touch IndexedDB at all');
  assert.match(KEEPWARM, /takeStorageCensus\(evaluate\)[\s\S]{0,600}takeIdbCensus\(evaluate\)/,
    'the caller must make two separate evaluates');
});

test('NO IndexedDB VALUE IS EVER FETCHED — names and counts only', () => {
  // `getAll()` pulls every row into the page. On a renderer already suspected of allocating
  // gigabytes that is the cure arriving as part of the disease — the same mistake as
  // `response.body()` in the network trace, and as writing a multi-GB heap snapshot at the
  // moment the box cannot spawn. `count()` answers the only question that has to be answered:
  // which store is holding something.
  const idb = code.slice(code.indexOf('export function idbCensusInPage'));
  assert.ok(!/getAll|\.get\(|openCursor/.test(idb), 'no row may be read out of a store');
  assert.match(idb, /\.count\(\)/, 'the count is the whole reading');
});

test('an IndexedDB reading that did not happen is NOT an empty one', () => {
  // The distinction the web-store census earned its finding with, applied to the store it
  // pointed at. Three states, three sentences.
  assert.match(describeIdb(undefined), /was not checked/);
  assert.match(describeIdb(null), /could NOT be read/);
  assert.match(describeIdb(null), /not ruled out/);
  assert.match(describeIdb([]), /no databases at all/);
  assert.ok(!/not ruled out/.test(describeIdb([])),
    'an enumerated-and-empty IndexedDB genuinely does rule itself out');
});

test('a store holding rows is called out as the lead', () => {
  const said = describeIdb([
    { db: 'okta-token-storage', store: 'tokens', rows: 1 },
    { db: 'firebase-heartbeat-db', store: 'heartbeats', rows: 0 },
  ]);
  assert.match(said, /HOLDS DATA/);
  assert.match(said, /okta-token-storage\/tokens=1/);
  assert.ok(!/heartbeats/.test(said), 'the empty stores must not bury the full one');
  assert.match(said, /the clear has never reached these/);
});

test('an unreadable store is reported as unreadable, never as zero', () => {
  const said = describeIdb([{ db: 'locked', store: 'x', rows: null }]);
  assert.match(said, /locked\/x=unreadable/);
  assert.ok(!/HOLDS DATA/.test(said), 'an unreadable count is not evidence of contents');
});

test('takeIdbCensus never throws, and a non-array reads as no reading', async () => {
  assert.equal(await takeIdbCensus(async () => { throw new Error('page gone'); }), null);
  assert.equal(await takeIdbCensus(async () => null), null);
  assert.equal(await takeIdbCensus(async () => ({ nonsense: true })), null);
  assert.deepEqual(await takeIdbCensus(async () => []), [], 'but a real empty enumeration survives');
});

test('the IndexedDB body is self-bounded INSIDE the caller\'s bound', async () => {
  // `evaluateWithin` caps the whole evaluate, but a single `open()` that never fires an event
  // would spend that entire budget and return nothing at all. Bounding per-request means a
  // hung database costs one database, not the reading.
  const idb = code.slice(code.indexOf('export function idbCensusInPage'));
  assert.match(idb, /const deadline = Date\.now\(\) \+ BUDGET_MS/);
  assert.match(idb, /Date\.now\(\) > deadline/, 'and the loop must check it');
  assert.match(idb, /onblocked/, 'a blocked open is an answer, not a hang');

  // And it really does resolve when the subsystem never answers.
  const g = globalThis as Record<string, unknown>;
  const saved = g.indexedDB;
  g.indexedDB = {
    databases: async () => [{ name: 'never-opens' }],
    open: () => ({}),   // no event ever fires
  };
  try {
    const out = await idbCensusInPage(MAX_KEYS);
    assert.deepEqual(out, [{ db: 'never-opens', store: null, rows: null }],
      'a database that never answers is reported unreadable, not waited on for ever');
  } finally { g.indexedDB = saved; }
});

test('an absent IndexedDB API reads as "could not look", not as empty', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g.indexedDB;
  g.indexedDB = {};   // no databases()
  try {
    assert.equal(await idbCensusInPage(MAX_KEYS), null,
      'no enumeration API means no reading — an empty array would claim we had looked');
  } finally { g.indexedDB = saved; }
});

test('the token SOURCE is reported, because it splits the hunt in two', () => {
  // `live` means RC's SPA held the corpse in memory and put it on an outbound Authorization
  // header — restored from somewhere the clear cannot see. `localStorage` would mean the
  // census simply ran too late and the store is the answer after all. `primeToken` has always
  // computed this and `renewSession` threw it away.
  const TOKEN = readFileSync('scripts/auto-cart-bot/rc-token.mjs', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(TOKEN, /source: afterSource \} = await primeToken\([\s\S]{0,120}notToken: previous \}\)\);/,
    'the post-click prime must keep the source — that is the one that finds the corpse');
  assert.match(TOKEN, /return \{ renewed, stage, before, after, afterSource,/,
    'and it must be returned');
  assert.match(KEEPWARM, /the expired token was found via: \$\{r\.afterSource/,
    'and logged on the pathology');
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

  // ANCHORED ON THE BEHAVIOUR, NOT THE EXPRESSION. This guard used to pin the inline
  // `takeStorageCensus((fn, arg) => evaluateWithin(…))`, and hoisting that arrow into a
  // `const evaluate` — a change that alters nothing — broke it. Same shape as the guard that
  // pinned `await renewSession(` and went red when the call was wrapped in a network trace.
  // What has to be true is that BOTH censuses run through the bounded evaluate, because this
  // page is already suspected of hanging; how the caller spells that is not the rule.
  const at = KEEPWARM.indexOf('const evaluate = (fn, arg) => evaluateWithin(');
  assert.ok(at > -1, 'the bounded evaluate must be defined');
  assert.match(KEEPWARM.slice(at, at + 600), /takeStorageCensus\(evaluate\)/,
    'the web-store census must use it');
  assert.match(KEEPWARM.slice(at, at + 600), /takeIdbCensus\(evaluate\)/,
    'and so must the IndexedDB one — it is the body most able to block');
});
