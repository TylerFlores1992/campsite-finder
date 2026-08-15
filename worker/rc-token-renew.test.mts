/**
 * THE KEEP-WARM'S RENEWAL WAS MEASURING ITSELF (found 2026-08-12, from the box's own log).
 *
 *     00:06:09 token has 10m left (src=live) — renewing by reload
 *     00:06:10   ✗ reload did NOT mint a fresher token (575s → 575s)
 *
 * One second, and `before === after` to the second. A navigation plus an SPA bootstrap plus
 * an OIDC round trip cannot happen in a second, and a genuine failure does not hand back the
 * identical number — that was the same token being read straight out of localStorage.
 *
 * `renewByReload` deleted only `window.__camphawkRcToken`, the page-scoped copy. The copy
 * okta-auth-js decides from is **localStorage**, and with a still-valid token there the SDK
 * has no reason to issue `/authorize` at all. So the reload that was supposed to exercise
 * the bootstrap path never triggered it, and this was reported for three days as RC
 * refusing to renew.
 *
 * The counter-evidence was in the same log: the login rehearsal clears
 * `ssoAccessToken`/`accessToken` and reloads, and RC re-minted a token from the live Okta
 * session with no credential typed. The bootstrap path works. Clearing storage is what
 * chooses it.
 *
 * ── WHY THESE ASSERTIONS ───────────────────────────────────────────────────────────────
 * The verdict is pure and gets a real test. The rest is a source scan for the same reason
 * `autocart-payload.test.mts` is: this code drives a live browser against RC, so there is
 * nothing to exercise here without a session, and the defect was an omission that reads
 * perfectly well at the call site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRenewal } from '../scripts/auto-cart-bot/rc-token.mjs';

const src = readFileSync('scripts/auto-cart-bot/rc-token.mjs', 'utf8');
/** Comments stripped — every one of these strings appears in the note explaining it. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function renewBody(): string {
  const i = src.indexOf('export async function renewByReload');
  assert.ok(i > 0, 'renewByReload must exist');
  const end = src.indexOf('\n}', src.indexOf('return { renewed, before, after', i));
  assert.ok(end > i);
  return code(src.slice(i, end));
}

test('the same token is never a renewal, however much life it claims', () => {
  // THE BUG, as a value. The old code compared seconds alone, so reading the identical
  // token back gave after === before and was reported as "RC would not renew" — when what
  // actually happened is that nothing was asked of RC at all.
  const t = 'eyJhbGc.SAME.sig';
  assert.equal(isRenewal({ previous: t, next: t, before: 575, after: 575 }), false);
  assert.equal(isRenewal({ previous: t, next: t, before: 575, after: 3600 }), false,
    'a longer clock on the SAME string is a decode difference, not a new token');
});

test('a different token with more life left IS a renewal', () => {
  assert.equal(
    isRenewal({ previous: 'eyJ.OLD.sig', next: 'eyJ.NEW.sig', before: 575, after: 3590 }),
    true,
  );
});

test('a different token that is NOT fresher is not a renewal either', () => {
  // The app can replay an older cached token during a bootstrap. Accepting it would report
  // success and leave the session dying on schedule.
  assert.equal(
    isRenewal({ previous: 'eyJ.OLD.sig', next: 'eyJ.OLDER.sig', before: 575, after: 120 }),
    false,
  );
});

test('no token, or one that will not decode, is never a renewal', () => {
  assert.equal(isRenewal({ previous: 'eyJ.OLD.sig', next: null, before: 575, after: null }), false);
  assert.equal(isRenewal({ previous: 'eyJ.OLD.sig', next: 'not-a-jwt', before: 575, after: null }), false,
    'an undecodable token proves nothing and must not be counted as success');
});

test('having had nothing before, any decodable token is a renewal', () => {
  assert.equal(isRenewal({ previous: null, next: 'eyJ.NEW.sig', before: null, after: 3600 }), true);
});

test('the reload clears the token the APP decides from, not just our own copy', () => {
  // The whole bug in one assertion: `delete window.__camphawkRcToken` alone leaves
  // okta-auth-js holding a valid token, so the bootstrap issues no /authorize.
  //
  // THE CLEARING MOVED INTO `dropStoredToken` (2026-08-15), shared with `attemptLogin`, so
  // this now pins BOTH HALVES. Asserting only the helper would pass on a `renewByReload` that
  // had stopped calling it, and asserting only the call would pass on a helper that cleared
  // nothing — the extraction trap that made `control-channel.test.mts` green against a
  // `restart-rc.ps1` which no longer killed anything.
  const i = src.indexOf('export async function dropStoredToken');
  assert.ok(i > 0, 'dropStoredToken must exist');
  const helper = code(src.slice(i, src.indexOf('\n}', i)));
  assert.match(helper, /removeItem\('ssoAccessToken'\)/, 'must clear the key the SDK reads');
  assert.match(helper, /removeItem\('accessToken'\)/, 'must clear the fallback key too');
  assert.ok(/delete window\.__camphawkRcToken/.test(helper),
    'our own captured copy still has to go, or the next read returns it');

  assert.match(renewBody(), /await dropStoredToken\(page\)/,
    'renewByReload must still do the clearing, or the bootstrap never happens');
});

test('it waits for a token that is not the one it dropped', () => {
  // Without notToken, "wait for a fresh token" and "wait for a token" are the same call —
  // which is precisely how the renewal came to be measured against itself.
  assert.match(renewBody(), /notToken:\s*previous/,
    'primeToken must be told which token does not count');
});

test('a failed renewal puts the old token back', () => {
  // The clear is destructive: it trades a token with minutes left for a bootstrap that may
  // find no Okta session. Restoring is what makes the worst case no worse than doing
  // nothing — and it must restore the exact keys that were emptied, not a guessed one.
  const body = renewBody();
  assert.match(body, /if \(!renewed && \(stored\.sso \|\| stored\.acc\)\)/,
    'the restore must be conditional on the renewal having failed');
  assert.match(body, /setItem\('ssoAccessToken', s\.sso\)/);
  assert.match(body, /setItem\('accessToken', s\.acc\)/);
});

test('an unknown Okta verdict does not switch renewal off', () => {
  // `alive: null` means the probe could not tell — a timeout, a 5xx, a network blip. Only
  // an explicit false refuses. Refusing on unknown would disable renewal permanently the
  // first time Okta hiccuped, which is the "unknown is not dead" rule applied to the code
  // that ACTS rather than to the code that reports.
  assert.match(renewBody(), /oktaAlive === false/,
    'only an explicit false may skip; null must fall through and attempt');
});

test('the failure line no longer blames a cookie that is demonstrably present', () => {
  // It printed "the Okta cookie may be gone" for three days with `okta=ALIVE` on the
  // adjacent line, and `idx` — Okta Identity Engine's session cookie — sitting in the
  // profile. A diagnosis contradicted by the field next to it is worse than none.
  const keepwarm = code(readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8'));
  assert.ok(!/Okta cookie may be gone/.test(keepwarm),
    'the renewal failure must not assert a cause it has not checked');
});
