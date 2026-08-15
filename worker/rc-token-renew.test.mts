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
 * `renewByReload` — now `renewSession` — deleted only `window.__camphawkRcToken`. The copy
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
  const i = src.indexOf('export async function renewSession');
  assert.ok(i > 0, 'renewSession must exist');
  const end = src.indexOf('\n}', src.indexOf('return { renewed, stage, before, after', i));
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
  // this now pins BOTH HALVES. Asserting only the helper would pass on a `renewSession` that
  // had stopped calling it, and asserting only the call would pass on a helper that cleared
  // nothing — the extraction trap that made `control-channel.test.mts` green against a
  // `restart-rc.ps1` which no longer killed anything.
  // WIDENED 2026-08-15, and the widening IS the fix. Clearing RC's two copies left
  // okta-auth-js holding the same token in its own `okta-` store, which it handed straight
  // back — so `renewSession` measured a survivor and reported "RC will not renew" for days.
  // A token came back 26 seconds older than the one dropped (578s -> 552s), which can only
  // happen if a persisted copy was missed.
  const i = src.indexOf('export async function dropStoredToken');
  assert.ok(i > 0, 'dropStoredToken must exist');
  const helper = code(src.slice(i, src.indexOf('\n}\n', i)));
  assert.match(helper, /rcKeys\.includes\(k\)/, "RC's own copies must still go");
  assert.match(helper, /k\.startsWith\(prefix\)/,
    "okta-auth-js's own storage must go too, or the SDK returns the same token");
  assert.ok(/delete window\.__camphawkRcToken/.test(helper),
    'our own captured copy still has to go, or the next read returns it');
  // The prefix and RC's keys are named constants, not inline strings, so the two callers
  // cannot drift apart the way the rehearsal's third inline copy did.
  assert.match(code(src), /OKTA_STORAGE_PREFIX = 'okta-'/);
  assert.match(code(src), /RC_TOKEN_KEYS = \['ssoAccessToken', 'accessToken'\]/);

  assert.match(renewBody(), /await dropStoredToken\(page\)/,
    'renewSession must still do the clearing, or the bootstrap never happens');
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
  //
  // AND IT MUST RESTORE THE WHOLE SNAPSHOT. Now that the clear spans okta-auth-js's storage,
  // putting back only `ssoAccessToken`/`accessToken` would leave the app holding a token its
  // own SDK no longer knows about — strictly worse than never having tried, which is the one
  // outcome this guard exists to prevent.
  const body = renewBody();
  assert.match(body, /if \(!renewed && Object\.keys\(snapshot\)\.length\)/,
    'the restore must be conditional on the renewal having failed');
  assert.match(body, /await restoreStoredToken\(page, snapshot\)/,
    'restore exactly what dropStoredToken took, not a guessed subset');
  const helper = code(src.slice(src.indexOf('export async function restoreStoredToken')));
  assert.match(helper, /Object\.entries\(s\)/, 'the restore must replay the whole snapshot');
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

test('the rehearsal clears through the shared helper, not a third inline copy', () => {
  // IT WAS A THIRD COPY, AND THE COPY IS WHAT MAKES THIS DANGEROUS. `runLoginRehearsal` had
  // its own hand-rolled `removeItem('ssoAccessToken')` pair. When the real clear widened to
  // cover okta-auth-js's storage, that copy would have been left behind — still clearing two
  // keys of a blob that carries the whole session, and still reporting "RC re-authenticated
  // with no credential typed" about a token that had never actually gone.
  //
  // That appearance is precisely what the renewal question has been resting on since 08-11,
  // so a stale copy here does not merely duplicate code: it manufactures the evidence.
  const kw = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
  const body = kw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const rehearsal = body.slice(body.indexOf('async function runLoginRehearsal'));
  const fn = rehearsal.slice(0, rehearsal.indexOf('\n}\n'));
  assert.match(fn, /await dropStoredToken\(page\)/,
    'the rehearsal must clear through the shared helper');
  assert.ok(!/removeItem\('ssoAccessToken'\)/.test(fn),
    'no inline copy of the clear — it will be the one that goes stale');
});

test('the keys actually emptied are reported, never their values', () => {
  // The renewal has now failed twice for reasons invisible from its own log line. `cleared`
  // is what turns the next failure into a fact: only RC's two keys listed means the SDK's
  // storage is somewhere the `okta-` prefix does not reach.
  //
  // NAMES ONLY. A token is a credential, and the rule here is not to collect a field you then
  // have to filter — the first mobile report leaked an OAuth authorization code exactly that
  // way, and the scrub that guarded it sailed straight past.
  assert.match(renewBody(), /cleared/, 'renewSession must return which keys it emptied');
  const helper = code(src.slice(src.indexOf('export async function dropStoredToken')));
  assert.match(helper, /cleared: Object\.keys\(snapshot\)/,
    'report the key NAMES, which is what Object.keys gives');
  const kw = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
  // MATCHED ON THE `log(` CALL, NOT THE STRING. The first version of this assertion checked
  // only that the sentence existed, and a mutation swapping `log(` for `void (` kept the text
  // and passed — the inert-fix shape, inside the guard written to catch it.
  assert.match(kw, /log\(`\s*cleared \$\{r\.cleared\?\.length \?\? 0\} storage key\(s\)/,
    'and the caller must actually LOG them, or the diagnostic is dead code');
});

/**
 * ── THE AUTHORIZE STAGE (added 2026-08-15) ─────────────────────────────────────────────
 *
 * With the clear finally covering okta-auth-js's own store, the reload asked an honest
 * question and the answer was still no — twice, an hour apart, the token coming back older.
 * That reads as "RC will not renew" and it is not what happened: **nothing was asking it to.**
 *
 * The same evening's log carries the discriminating pair, both halves reproduced:
 *   NEGATIVE  a plain load from a token-less profile, Okta ALIVE, produces nothing — twice,
 *             the first of them sitting dead through two twenty-minute checks.
 *   POSITIVE  a click on RC's own sign-in control produces a FULL 59-minute token with no
 *             credential typed — twice, each ~19s after the click.
 *
 * A full hour is the discriminator: a restored stale copy carries its old expiry, which is
 * exactly what the failing reloads showed (565s → 540s).
 */

test('the renewal clicks the sign-in control when a plain reload produced nothing', () => {
  // THE FIX, as a source assertion. Without the click the function is the thing that has
  // measured four consecutive failures and cannot do anything else.
  const body = renewBody();
  assert.match(body, /await clickSignIn\(page\)/,
    'a plain reload has never re-minted a token — the click is what starts the flow');
  assert.match(body, /stage = 'authorize'/, 'and the result must say which stage produced the token');
});

test('the click is the SECOND stage, so a working reload still wins', () => {
  // Ordering is the whole reason both stages stay. `reload` succeeding would mean the SDK's
  // own bootstrap has started working and this can be simplified back down; running the
  // click unconditionally would hide that the day it happens, which is the standing
  // measurement being thrown away to save one navigation.
  const body = renewBody();
  assert.match(
    body,
    /if \(clickSignIn && !isRenewal\(\{ previous, next: token, before, after: tokenSecondsLeft\(token\) \}\)\)/,
    'stage two must be gated on stage one having failed, judged by isRenewal and not by presence',
  );
});

test('a click that found no control is its own outcome, not a silent failure', () => {
  // 2026-08-15 18:22: the clear did not sign the SPA out — it went on rendering its
  // signed-in banner — so no "Log in" anchor existed, a different control matched, and the
  // flow was never started. "We asked and Okta refused" needs a human; "we never got as far
  // as asking" does not, and collapsing them is the `status = 'sent'` family of lie.
  const body = renewBody();
  assert.match(body, /stage = 'no-signin-control'/,
    'not finding the control must be distinguishable from Okta refusing us');
});

test('a failed click does not leave the resident tab parked on a sign-in page', () => {
  // The signed-out case clears nothing, so the restore branch does not run — and the click
  // navigates. Without this the headful keep-warm would sit on Okta's form on somebody's
  // desktop, and every later readLiveToken would be reading the wrong page.
  assert.match(renewBody(), /\} else if \(!renewed && stage !== 'reload'\) \{/,
    'the non-restore failure path must navigate back to RC');
});

test('the renewal path is STRUCTURALLY incapable of submitting a credential', () => {
  // THE PROPERTY THAT LETS THIS BE RATIONED ON ITS OWN TERMS. A re-mint does not spend the
  // one-attempt-per-release login budget — the budget that exists because repeated logins
  // from this address cost twelve hours of IP block on 2026-08-06 — and that is only
  // defensible while it cannot type anything. The click is INJECTED as a callback; owning a
  // selector list here would be one import away from owning a password field too.
  assert.ok(!/from '\.\/rc-autologin\.mjs'/.test(src),
    'rc-token.mjs must not import the login module, or the boundary is decoration');
  const body = renewBody();
  for (const forbidden of [/password/i, /credential/i, /\.fill\(/]) {
    assert.ok(!forbidden.test(body),
      `the renewal must never reach a credential (matched ${forbidden})`);
  }
});

test('the sign-in click is ONE definition, and attemptLogin still goes through it', () => {
  // THE EXTRACTION TRAP, which has now cost six guards in this repo. Asserting only that
  // `clickSignInControl` exists would pass against an `attemptLogin` that had gone back to
  // its own inline copy — and the forgotten copy is by definition the one running when it
  // matters. Both halves, always.
  const auto = readFileSync('scripts/auto-cart-bot/rc-autologin.mjs', 'utf8');
  const bare = code(auto);
  assert.match(bare, /export async function clickSignInControl\(page/,
    'the click must be an exported definition the renewal can inject');
  const helper = bare.slice(bare.indexOf('export async function clickSignInControl'));
  assert.match(helper.slice(0, helper.indexOf('\n}\n')), /findIn\(page, SIGNIN_LINK_SELECTORS/,
    'and it must be the one that uses the shared selector list');

  const attempt = bare.slice(bare.indexOf('export async function attemptLogin'));
  assert.match(attempt, /await clickSignInControl\(page\)/,
    'attemptLogin must call it, not keep a second copy of the same act');
  assert.ok(!/const link = await findIn\(page, SIGNIN_LINK_SELECTORS/.test(attempt),
    'the inline copy inside attemptLogin must be gone, or the two will drift');
});
