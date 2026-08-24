/**
 * THE GUARD THAT DID NOT EXIST.
 *
 * `closeOnToken` closed the RC sign-in webview on `captured` alone from the day it was
 * written (#126, 2026-08-18) until 2026-08-24. The claim gate learned the same lesson on
 * 08-21 (#152) — AFTER `closeOnToken` shipped — and nothing carried it next door, because
 * nothing tested either one. Six days later it cost a live hand-off test: the window closed
 * in under a second on a stale token, which read as a successful auto-login, and the site
 * was handed over against no session.
 *
 * Lives under `src/` rather than `worker/` ON PURPOSE. `npm test` globs
 * `src/**\/*.test.mts` as well, so it runs either way — but `worker/**` is a
 * `worker-deploy.yml` trigger path, and a docs-adjacent guard for a WEB module has no
 * business restarting both poller machines. The worker imports neither file under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rcTokenLiveness, mayCloseOnToken } from './rc-token-liveness';

// ---------------------------------------------------------------------------
// The rule itself.
// ---------------------------------------------------------------------------

test('a decodable token with time left is live', () => {
  assert.equal(rcTokenLiveness({ captured: true, decodable: true, expiresInSec: 3580 }), 'live');
  assert.equal(mayCloseOnToken({ captured: true, decodable: true, expiresInSec: 3580 }), true);
});

test('THE 08-21 REPORT: a token that expired 23 hours ago is expired, not live', () => {
  // The exact payload from the incident, quoted in ClaimFlow's own header.
  const d = { captured: true, decodable: true, expiresInSec: -82599 };
  assert.equal(rcTokenLiveness(d), 'expired');
  assert.equal(mayCloseOnToken(d), false, 'an expired token must NOT close the sign-in window');
});

test('THE 08-24 FAILURE: a stale token must not close the sign-in window', () => {
  // A session dead for a week — the state CLAUDE.md records as ordinary, since the stale
  // token comes from the server and no local clear reaches it.
  assert.equal(mayCloseOnToken({ captured: true, decodable: true, expiresInSec: -603732 }), false);
});

test('expiresInSec === 0 is EXPIRED, not unknown — 0 is falsy and must not read as absent', () => {
  assert.equal(rcTokenLiveness({ captured: true, expiresInSec: 0 }), 'expired');
  assert.equal(mayCloseOnToken({ captured: true, expiresInSec: 0 }), false);
});

test('a REBROADCAST carries no expiresInSec and is unknown — it must not close the window', () => {
  // `rc-precart-script` puts the timing facts on the first sighting of each distinct token
  // only; rc-inject replays it on every RC API call carrying { captured, length }.
  const repeat = { captured: true, length: 939 };
  assert.equal(rcTokenLiveness(repeat), 'unknown');
  assert.equal(mayCloseOnToken(repeat), false,
    'closing on a replay is how a first sighting of EXPIRED still closed the window');
});

test('undecodable, absent, null and non-finite all read unknown — never a verdict', () => {
  for (const d of [
    { captured: true, decodable: false },
    { captured: true, expiresInSec: null },
    { captured: true, expiresInSec: 'soon' },
    { captured: true, expiresInSec: Number.NaN },
    { captured: false, expiresInSec: 3600 },
    null,
    undefined,
    {},
  ]) {
    assert.equal(rcTokenLiveness(d), 'unknown', `expected unknown for ${JSON.stringify(d)}`);
    assert.equal(mayCloseOnToken(d), false, `expected no close for ${JSON.stringify(d)}`);
  }
});

test('only `live` may close — the close agrees with the gate by construction', () => {
  // If this ever diverges, the window is asserting something the gate would not.
  const cases: Array<[unknown, boolean]> = [
    [{ captured: true, expiresInSec: 1 }, true],
    [{ captured: true, expiresInSec: -1 }, false],
    [{ captured: true }, false],
  ];
  for (const [d, expected] of cases) {
    assert.equal(mayCloseOnToken(d), expected);
    assert.equal(mayCloseOnToken(d), rcTokenLiveness(d) === 'live');
  }
});

// ---------------------------------------------------------------------------
// STRUCTURAL: the rule can be perfect and still not be USED. Both defects were exactly
// that — a correct comparison existing in one file while the sibling made its own.
// ---------------------------------------------------------------------------

const handoff = readFileSync(new URL('./native/rc-handoff.ts', import.meta.url), 'utf8');
const claimFlow = readFileSync(
  new URL('../components/v2/ClaimFlow.tsx', import.meta.url), 'utf8');

test('closeOnToken goes through the shared rule, not its own captured check', () => {
  assert.match(handoff, /closeOnToken && r\.stage === 'token' && mayCloseOnToken\(r\.detail\)/,
    'the close condition must call mayCloseOnToken');
  // The regression, stated as the thing that must NOT be there: a bare captured test
  // gating the close. Comments quoting the old form are stripped first so the guard is
  // never "fixed" by deleting the explanation of why it exists.
  const code = handoff.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /closeOnToken &&[^)]*\{ captured\?: boolean \}/,
    'closeOnToken must not read `captured` directly again');
});

test('the claim gate goes through the SAME rule', () => {
  assert.match(claimFlow, /const liveness = rcTokenLiveness\(r\.detail\)/);
  assert.match(claimFlow, /liveness === 'expired'/);
  assert.match(claimFlow, /liveness === 'live'/,
    'verified must require live — a bare else sends unknown to verified');
});

test('an unknown does NOT grant verified — the bare else is the regression', () => {
  // Scoped to the token block: `} else {` occurs all over a React component, so an
  // unscoped search would pass on any of them.
  const start = claimFlow.indexOf("const liveness = rcTokenLiveness(r.detail)");
  assert.ok(start > -1, 'anchor missing — re-anchor this guard, do not delete it');
  const block = claimFlow.slice(start, start + 2600);
  assert.doesNotMatch(block, /}\s*else\s*\{\s*\n\s*setRcCheck\('verified'\)/,
    "an unqualified else after the expired arm sends `unknown` straight to verified, which "
    + 'mayRelease reads as permission for an irreversible act');
});

test('both consumers import the shared module rather than copying the comparison', () => {
  assert.match(handoff, /import \{ mayCloseOnToken \} from '@\/lib\/rc-token-liveness'/);
  assert.match(claimFlow, /import \{ rcTokenLiveness \} from '@\/lib\/rc-token-liveness'/);
});
