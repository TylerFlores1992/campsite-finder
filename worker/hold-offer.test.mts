/**
 * THE OFFER MUST BE ATTEMPTED ON EVERY HELD CHECK, NOT ONCE PER RELEASE.
 *
 * `offerHold` for the primary held unit used to sit BELOW `claimHoldNotification`, which is
 * once per (watch, release, unit) — so it got one attempt, and since the call is wrapped in
 * `.catch(() => null)` a transient throw lost the offer for that release for ever while the
 * alert still went out. Leo Carrillo #L034, 2026-09-04 01:11 UTC: the row had to be
 * inserted by hand ten hours before the release.
 *
 * THE STRUCTURAL GUARDS BELOW ARE THE ONES THAT CATCH THAT, and they are the reason this
 * file exists. No behavioural test can see WHERE a call sits, and the bug is entirely a
 * question of placement — the function itself was always correct. This is the 2026-08-28
 * `rankHoldLine` finding one call site along, and that one needed exactly the same kind of
 * guard for exactly the same reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { holdOfferDecision, describeHoldBlocker, type HoldOfferFacts } from './hold-offer';

/** Strip comments — a guard must never pass or fail on the prose explaining it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}
const POLLER = () => code('worker/poller.ts');

const OK: HoldOfferFacts = {
  hasUnit: true, entitled: true, botOk: true, roomToHold: true, portalOk: true,
};

// ── the decision ────────────────────────────────────────────────────────────────────

test('all five facts good is the only way to may-offer', () => {
  assert.deepEqual(holdOfferDecision(OK), { mayOffer: true, blockedBy: null });
});

test('each missing fact blocks, and names ITSELF as the reason', () => {
  // The reason is LOGGED, so a wrong one sends a human to fix the wrong thing — an Ohio
  // watch reporting "the RC runner is absent" would have somebody restarting a healthy bot.
  assert.deepEqual(holdOfferDecision({ ...OK, hasUnit: false }).blockedBy, 'no-unit');
  assert.deepEqual(holdOfferDecision({ ...OK, portalOk: false }).blockedBy, 'portal-unsupported');
  assert.deepEqual(holdOfferDecision({ ...OK, entitled: false }).blockedBy, 'not-entitled');
  assert.deepEqual(holdOfferDecision({ ...OK, botOk: false }).blockedBy, 'bot-absent');
  assert.deepEqual(holdOfferDecision({ ...OK, roomToHold: false }).blockedBy, 'no-room');
});

test('mayOffer false always carries a reason, and true never does', () => {
  // Totality: a blocked offer with a null reason is a silent withholding, which is the
  // shape this whole file exists to stop.
  for (const key of ['hasUnit', 'entitled', 'botOk', 'roomToHold', 'portalOk'] as const) {
    const d = holdOfferDecision({ ...OK, [key]: false });
    assert.equal(d.mayOffer, false, `${key} false must block`);
    assert.ok(d.blockedBy, `${key} false must name a reason`);
  }
  assert.equal(holdOfferDecision(OK).blockedBy, null);
});

test('a structural blocker outranks a transient one', () => {
  // Both wrong at once: the portal is a property of the watch and cannot change, the bot
  // being down is our problem and will pass. Reporting the transient one first would send
  // somebody to restart a bot that was never going to help this watch.
  const d = holdOfferDecision({ ...OK, portalOk: false, botOk: false, roomToHold: false });
  assert.equal(d.blockedBy, 'portal-unsupported');
});

// ── the log lines ───────────────────────────────────────────────────────────────────

const CTX = { source: 'ohio', botBeatAgeMs: 90_000, load: 20, capacity: 20 };

test('the three actionable blockers speak and the two ordinary ones stay silent', () => {
  // `not-entitled` is the ordinary state of most users and `no-unit` of every lock with no
  // unit id. A line each per held check buries the three that mean something in a log
  // `tail-log` truncates to 16,000 characters.
  assert.ok(describeHoldBlocker('portal-unsupported', CTX)?.includes('ReserveCalifornia account'));
  assert.ok(describeHoldBlocker('bot-absent', CTX)?.includes('RC runner is absent'));
  assert.ok(describeHoldBlocker('no-room', CTX)?.includes('20'));
  assert.equal(describeHoldBlocker('not-entitled', CTX), null);
  assert.equal(describeHoldBlocker('no-unit', CTX), null);
});

test('a bot that has NEVER beaten is not reported as having beaten at 0s ago', () => {
  // `null` is "no heartbeat row at all"; rendering it as a number would read as a bot that
  // beat this instant, which is the opposite of what it means.
  const line = describeHoldBlocker('bot-absent', { ...CTX, botBeatAgeMs: null });
  assert.ok(line?.includes('never beat'), line ?? '(null)');
  assert.ok(!/\b0s ago\b/.test(line ?? ''));
});

// ── placement: the whole bug ────────────────────────────────────────────────────────

test('THE FIX: the primary offer runs BEFORE the notification claim', () => {
  const src = POLLER();
  const offer = src.indexOf('const primaryOffer = await offerFor(held)');
  const claim = src.indexOf('await claimHoldNotification(w.id');
  assert.ok(offer > -1, 'the primary offer call is gone or renamed — re-anchor this guard');
  assert.ok(claim > -1, 'the claim gate is gone or renamed — re-anchor this guard');
  assert.ok(
    offer < claim,
    'offerHold for the PRIMARY held unit is back below claimHoldNotification. That claim is ' +
    'once per (watch, release, unit), so the offer gets ONE attempt and a transient throw — ' +
    'it is wrapped in .catch(() => null) — loses the hold button for that release for ever, ' +
    'silently, with the alert still going out. Leo Carrillo #L034, 2026-09-04.',
  );
});

test('the claim-winning block does not offer, it only builds the link', () => {
  // The regression that looks like a merge artifact: an `offerHold(` reappearing below the
  // gate. Everything after the claim runs once per release by construction.
  const src = POLLER();
  const claim = src.indexOf('await claimHoldNotification(w.id');
  const after = src.slice(claim);
  assert.ok(
    !after.includes('offerHold('),
    'an offerHold call has appeared below the claim gate — that is the one-attempt-per-release bug',
  );
});

test('ONE decision for both paths — the extras loop and the primary', () => {
  // They were two hand-rolled copies and had already drifted: the extras loop checked only
  // entitlement, so it could offer a hold with the RC runner dead (2026-08-11), past
  // RC_HOLD_CAPACITY (2026-08-13), or on a portal the bot has no account for (2026-08-17).
  const src = POLLER();
  assert.equal(
    (src.match(/holdOfferDecision\(/g) ?? []).length, 1,
    'holdOfferDecision must be called exactly once — a second call site means the two ' +
    'paths have grown separate gates again',
  );
  assert.equal(
    (src.match(/await offerHold\(/g) ?? []).length, 1,
    'offerHold must have exactly one call site in the poller (inside offerFor); a second ' +
    'is a hand-rolled copy of the path that already drifted once',
  );
  for (const call of ['await offerFor(extra)', 'await offerFor(held)']) {
    assert.ok(src.includes(call), `${call} is gone — both paths must share offerFor`);
  }
});

test('the gates are not re-derived after the claim', () => {
  // Re-reading them below the gate is how the copies drifted the first time, and it would
  // let the alert path disagree with the row that was actually written.
  const src = POLLER();
  const after = src.slice(src.indexOf('await claimHoldNotification(w.id'));
  for (const fn of ['rcBotUsable(', 'holdWindowLoad(', 'supportsRcHold(', 'hasAutocartEntitlement(']) {
    assert.ok(!after.includes(fn), `${fn} is being re-derived after the claim gate`);
  }
});

test('the bot heartbeat is read once per pass, not once per watch', () => {
  // `rcBotUsable()` takes no arguments, and the offer now runs on every held check rather
  // than once per release — so a per-watch read would multiply a query that has one answer.
  const src = POLLER();
  assert.equal((src.match(/await rcBotUsable\(\)/g) ?? []).length, 1);
  const read = src.indexOf('const bot = await rcBotUsable()');
  const loop = src.indexOf('for (const w of rcWatches)');
  assert.ok(read > -1 && loop > -1, 're-anchor: one of these moved');
  assert.ok(read < loop, 'rcBotUsable must be read outside the rcWatches loop');
});
