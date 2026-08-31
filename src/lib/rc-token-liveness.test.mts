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
const liveness = readFileSync(new URL('./rc-token-liveness.ts', import.meta.url), 'utf8');

// RE-ANCHORED 2026-08-31, NOT RELAXED. These pinned the close condition by its exact
// EXPRESSION — `closeOnToken && r.stage === 'token' && mayCloseOnToken(r.detail)` — and the
// import line naming `mayCloseOnToken` specifically. The deferred-close fix moved that
// decision into `rcCloseAction`, which calls `mayCloseOnToken` itself, so the property both
// tests exist for is INTACT and both anchors were invalidated by a change that preserved it.
// Twenty-sixth time a guard here has anchored on the wrong thing.
//
// The property is "the close goes through the shared liveness rule and rc-handoff does not
// reimplement it", so that is what is asserted now: the handler delegates, the decision
// consults the rule, and rc-handoff still reads no `captured` of its own.
test('the close goes through the shared rule, not rc-handoff\'s own captured check', () => {
  assert.match(handoff, /rcCloseAction\(\{/,
    'the message handler must delegate the close decision');
  assert.match(liveness, /export function rcCloseAction[\s\S]{0,600}mayCloseOnToken\(detail\)/,
    'rcCloseAction must consult the shared liveness rule');
  // The regression, stated as the thing that must NOT be there: a bare captured test
  // gating the close. Comments quoting the old form are stripped first so the guard is
  // never "fixed" by deleting the explanation of why it exists.
  const code = handoff.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /closeOnToken &&[^)]*\{ captured\?: boolean \}/,
    'closeOnToken must not read `captured` directly again');
  assert.doesNotMatch(code, /r\.detail[\s\S]{0,40}captured/,
    'rc-handoff must not judge a token itself — that is the shared module\'s job');
});

test('rc-handoff imports the shared module rather than copying the comparison', () => {
  // Named imports, not the whole line: the SET grows (isMidSignIn arrived with the deferred
  // close) and pinning the literal import statement is what broke this guard once already.
  assert.match(handoff, /import \{[^}]*\brcCloseAction\b[^}]*\} from '@\/lib\/rc-token-liveness'/);
  assert.match(handoff, /import \{[^}]*\bisMidSignIn\b[^}]*\} from '@\/lib\/rc-token-liveness'/);
});

test('the GATE is deliberately not routed through this module — it has a different policy', () => {
  // The gate verifies on `unknown` as well as `live`, guarded by claim-release-truth. If a
  // future change routes it through `mayCloseOnToken`, older bundles lose the fast path.
  const claim = readFileSync(new URL('../components/v2/ClaimFlow.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(claim, /mayCloseOnToken/,
    'the gate must not adopt the close policy — see claim-release-truth.test.mts');
});
