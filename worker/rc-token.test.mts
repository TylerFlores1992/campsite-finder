// The silent-auth clock. Pure — the browser half needs a browser, but the DECISION
// ("is this token close enough to expiry to renew?") is arithmetic and is the part that
// has to be right, because getting it wrong either hammers RC every minute or lets the
// session lapse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenSecondsLeft } from '../scripts/auto-cart-bot/rc-token.mjs';

/** A JWT with the given exp. Only the payload matters — nothing verifies the signature. */
function jwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSeconds })}.sig`;
}

test('reads seconds remaining from a real JWT exp', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(tokenSecondsLeft(jwt(now + 3600))! - 3600) <= 2);
  assert.ok(tokenSecondsLeft(jwt(now - 600))! < 0, 'an expired token reads negative, not null');
});

test('an undecodable token is NULL, never zero', () => {
  // This distinction is load-bearing. `0` would mean "expired — renew now", and the
  // renewal loop would then reload RC every single minute on any page where we have not
  // captured a token: a signed-out page, or a tab that has not made an API call yet.
  // That is a request storm from a residential address RC's WAF has 403'd before.
  for (const bad of ['', 'not-a-jwt', 'a.b', 'aaa.###.bbb']) {
    assert.equal(tokenSecondsLeft(bad), null, `must be null: ${JSON.stringify(bad)}`);
  }
  // An opaque (non-JWT) token is the realistic case — it is a credential we can use but
  // cannot read an expiry from, and guessing one would be worse than admitting we cannot.
  assert.equal(tokenSecondsLeft('00ABCdefGHIjklMNOpqrSTUvwx'), null);
});

test('a JWT with no exp claim is NULL — present is not the same as readable', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(tokenSecondsLeft(`${b64({ alg: 'RS256' })}.${b64({ sub: 'x' })}.sig`), null);
});
