// THE RENEWAL CLEARS AT THE WRONG MOMENT — and the two log lines that prove it.
//
// From the box, 2026-08-19:
//
//     ✗ no fresher token (none → -316679s), got as far as: none
//       cleared 0 storage key(s): (none — nothing was there to drop)
//       the expired token was found via: localStorage
//
// Storage is EMPTY when `dropStoredToken` runs — okta-auth-js deletes the corpse itself after
// its silent renew fails — and a token three days dead is back in localStorage moments later.
// So the SPA restores it DURING the reload, from somewhere that is neither web store nor
// IndexedDB (all three measured clean the same night).
//
// WHY THAT IS THE WHOLE FAILURE. CLAUDE.md's 2x2 is unambiguous about which cell works: a
// click from a genuinely token-less profile mints a full hour (`none → 3580s`, repeatedly
// observed), and a click with a token present has never once succeeded. By restoring the
// corpse the reload puts every renewal in the cell that cannot work.
//
// So the fix is a second clear, AFTER the restore and BEFORE the click. These are source
// assertions because `renewSession` needs a real Playwright page; the decodable half
// (`jwtExpOf`) is exercised directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jwtExpOf } from '../scripts/auto-cart-bot/rc-token.mjs';

const TOKEN = readFileSync('scripts/auto-cart-bot/rc-token.mjs', 'utf8');
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const T = code(TOKEN);
const KEEPWARM = code(readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8'));

/** The slice of renewSession between the post-reload prime and the sign-in click. */
function betweenPrimeAndClick(): string {
  const prime = T.indexOf('let { token, source: afterSource } = await primeToken(');
  const click = T.indexOf('if (clickSignIn && !isRenewal(');
  assert.ok(prime > -1 && click > prime, 'the renewal must still prime, then click');
  return T.slice(prime, click);
}

test('ONLY AN EXPIRED TOKEN IS DROPPED — a live session must never be touched', () => {
  // The distinction that separates this from the near-expiry renewal this file stood down
  // from, which destroyed live sessions and leaked gigabytes doing it.
  const arm = betweenPrimeAndClick();
  assert.match(arm, /secondsNow != null && secondsNow <= 0/,
    'the re-clear must be gated on an already-expired token');
  assert.ok(!/secondsNow < RENEW/.test(arm) && !/secondsNow <= \d{2,}/.test(arm),
    'never on a threshold — that is the cell that leaks and has never worked');
});

test('the re-clear happens BEFORE the click, or it changes nothing', () => {
  const arm = betweenPrimeAndClick();
  assert.match(arm, /await dropStoredToken\(page\)/,
    'the restored corpse must actually be dropped');
  assert.match(arm, /renew:reclear-restored-token/,
    'and the breadcrumb must name the step, so a stall here is attributable');
});

test('NO RELOAD AFTER THE RE-CLEAR — a reload is what let it be restored', () => {
  // Going round again would undo the clear we just made, which is the whole bug.
  const arm = betweenPrimeAndClick();
  assert.ok(!/page\.goto\(/.test(arm), 'the re-clear arm must not navigate');
  assert.ok(!/page\.reload\(/.test(arm), 'nor reload');
  assert.match(arm, /await readLiveToken\(page\)/,
    'it re-reads in place instead');
});

test('ONE extra round, never a loop', () => {
  // If the corpse comes straight back the source restores it on every load and clearing can
  // never win — that is a finding to report, not something to retry against.
  const arm = betweenPrimeAndClick();
  assert.ok(!/while\s*\(/.test(arm), 'no loop');
  assert.ok(!/for\s*\(/.test(arm), 'no loop');
});

test('the caller is told which happened', () => {
  const arm = betweenPrimeAndClick();
  assert.match(arm, /reclearedExpired = true/);
  assert.match(T, /return \{ renewed, stage, before, after, afterSource, reclearedExpired,/,
    'the successful return must carry it');
  assert.match(T, /skipped: 'no Okta session to renew against'/);
  const skip = T.slice(T.indexOf("stage: 'skipped'"), T.indexOf("skipped: 'no Okta session"));
  assert.match(skip, /reclearedExpired: false/,
    'the early skip must carry it too, or the caller reads undefined');
});

test('both sweeps are reported, not just the second', () => {
  // `cleared 0` was the line that exposed this. If the re-clear replaced the array rather
  // than adding to it, the diagnostic that found the bug would stop working.
  const arm = betweenPrimeAndClick();
  assert.match(arm, /cleared\.push\(\.\.\.again\.cleared\)/,
    'the second sweep merges into the reported list');
  assert.ok(!/cleared = /.test(arm), 'and never replaces it');
});

// ── THE COOKIE HALF: is the corpse in this profile at all? ────────────────────────────────

test('jwtExpOf decodes an expiry and refuses anything that is not a JWT', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(jwtExpOf(`eyJhbGciOiJSUzI1NiJ9.${b64({ exp: 1_700_000_000 })}.sig`), 1_700_000_000);
  assert.equal(jwtExpOf('68928f9e-1234-4321-9999-abcdefabcdef'), null, 'a GUID is not a JWT');
  assert.equal(jwtExpOf('DT=abc'), null);
  assert.equal(jwtExpOf(null as never), null);
  assert.equal(jwtExpOf(''), null);
  // A JWT with no exp claim decodes but has nothing to report.
  assert.equal(jwtExpOf(`eyJhbGciOiJSUzI1NiJ9.${b64({ sub: 'x' })}.sig`), null);

  // ── THE CASE THAT ACTUALLY EXERCISES THE SHAPE CHECK ────────────────────────────────
  // Every negative above has NO DOTS, so `split('.')[1]` is undefined and the decode throws
  // its way to null whether or not the `^ey…` guard exists. Deleting that guard passed this
  // whole suite (mutation M6) — the test was proving null for the wrong reason.
  //
  // A dotted value whose middle segment happens to be base64 JSON with an `exp` is the
  // discriminator: without the shape check it is reported as a token-shaped cookie, and a
  // false positive here sends the next reader hunting for a corpse in an ordinary cookie.
  assert.equal(jwtExpOf(`x.${b64({ exp: 1_700_000_000 })}.y`), null,
    'a dotted non-JWT must be refused by SHAPE, not by the decode happening to throw');
});

test('THE COOKIE VALUE IS NEVER RETURNED — only a length and a decoded expiry', () => {
  // Every cookie value here is potentially the session. This repo has published a credential
  // twice by collecting a field it then had to filter — an OAuth code on 2026-08-09 and a
  // password on 08-16 — so the value is read inside `authCookieSummary` and never escapes.
  const fn = T.slice(T.indexOf('export async function authCookieSummary'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /chars: typeof c\.value === 'string' \? c\.value\.length : 0/,
    'the length is the safe proxy');
  assert.match(body, /jwtExp: jwtExpOf\(c\.value\)/, 'and the expiry is decoded locally');
  assert.ok(!/\bvalue: c\.value\b/.test(body), 'the value itself must never be returned');
  assert.ok(!/value: /.test(body), 'nor under any other field name');
});

test('a clean cookie jar points at the SERVER rather than declaring victory', () => {
  // The corpse comes from somewhere. Web stores and IndexedDB are measured clean, so if no
  // cookie is token-shaped either, the remaining candidate is the server — a different
  // investigation, and not one a clear can ever fix.
  assert.match(KEEPWARM, /NONE token-shaped/, 'the negative must be stated');
  assert.match(KEEPWARM, /coming from the server, not from this profile/,
    'and it must name what that leaves');
  assert.match(KEEPWARM, /TOKEN-SHAPED COOKIE\(S\) — the corpse may live here/,
    'and the positive must be unmissable — it would be the answer');
});

test('the cookie census fires on the pathology only, beside the storage census', () => {
  const at = KEEPWARM.indexOf('const cookies = await authCookieSummary(ctx)');
  assert.ok(at > -1, 'the cookie census must be wired in');
  const before = KEEPWARM.slice(Math.max(0, at - 900), at);
  assert.match(before, /!r\.renewed && r\.after != null && r\.after < 0/,
    'gated on the same pathology as the storage census — this is not a per-cycle log');
});
