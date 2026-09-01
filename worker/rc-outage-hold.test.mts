/**
 * DO NOT RELEASE A CAMPSITE WHILE THE USER CANNOT TAKE IT.
 *
 * RC's WEB tier fails while its DATA API stays healthy — measured twice, 2026-08-30 and
 * 2026-09-01, both times with `detect:reservecalifornia` green and reading live availability
 * while the owner could not load RC on a phone, a PC, or through a VPN. `expireStaleHolds(45)`
 * releases on a timer regardless, so it hands the site back at the exact moment nobody can
 * claim it.
 *
 * The three rules are each a way this could do HARM, and they are what these guard:
 *   1. bounded      — an unbounded hold is the 08-13 leak with a justification attached
 *   2. fresh        — stale evidence holds a site nobody is coming for
 *   3. unknown releases — "RC was down" and "the user went to work" are indistinguishable
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rcOutageHoldReason, RC_OUTAGE_GRACE_MIN, RC_OUTAGE_HOLD_NOTE,
} from '../src/lib/rc-outage-hold';

const HOLD_MIN = 45;
const NOW = new Date('2026-09-01T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const outage = [{ stage: 'close', detail: { reason: 'never-loaded' } }];

/** Carted just past the sweep window, client reported the failure a moment ago. */
function base(over: Partial<Parameters<typeof rcOutageHoldReason>[0]> = {}) {
  return rcOutageHoldReason({
    reports: outage,
    clientReportedAt: ago(1),
    cartedAt: ago(HOLD_MIN + 1),
    holdMinutes: HOLD_MIN,
    now: NOW,
    ...over,
  });
}

test('a fresh web-tier failure holds the site', () => {
  assert.equal(base(), RC_OUTAGE_HOLD_NOTE);
});

test('both outage reasons count', () => {
  for (const reason of ['never-loaded', 'load-error']) {
    assert.equal(base({ reports: [{ stage: 'close', detail: { reason } }] }), RC_OUTAGE_HOLD_NOTE, reason);
  }
});

test('an ORDINARY close does not hold — the hand-off worked, the user just did not finish', () => {
  // `token`, `settled` and `timeout` all mean RC came up. Treating those as an outage would
  // hold a site for every user who opened the link and changed their mind.
  for (const reason of ['token', 'settled', 'timeout']) {
    assert.equal(base({ reports: [{ stage: 'close', detail: { reason } }] }), null, reason);
  }
});

test('RULE 3 — unknown releases', () => {
  // Every one of these is "we could not tell", and only one of "RC was down" / "they went to
  // work" deserves the campsite.
  assert.equal(base({ reports: [] }), null, 'no reports at all');
  assert.equal(base({ reports: null }), null, 'null reports');
  assert.equal(base({ reports: 'not an array' }), null, 'unreadable reports');
  assert.equal(base({ clientReportedAt: null }), null, 'never reported');
  assert.equal(base({ cartedAt: null }), null, 'no carted time');
  assert.equal(base({ cartedAt: 'not a date' }), null, 'unparseable carted time');
  assert.equal(base({ reports: [{ stage: 'close', detail: null }] }), null, 'close with no reason');
  assert.equal(base({ reports: [{ stage: 'banner', detail: { reason: 'never-loaded' } }] }), null,
    'the reason must be on a CLOSE — a banner quoting it is not the same event');
});

test('RULE 2 — stale evidence releases', () => {
  // Reported inside the grace window: hold. Reported outside it: RC may well be back, and
  // holding on that is exactly "a site nobody is coming for".
  assert.equal(base({ clientReportedAt: ago(RC_OUTAGE_GRACE_MIN - 1) }), RC_OUTAGE_HOLD_NOTE);
  assert.equal(base({ clientReportedAt: ago(RC_OUTAGE_GRACE_MIN + 1) }), null);
});

test('RULE 1 — bounded: one grace period past the window and no more', () => {
  // A phone retrying every minute keeps the evidence fresh for ever. The bound is measured
  // from carted_at so no amount of client chatter can extend it.
  const justInside = ago(HOLD_MIN + RC_OUTAGE_GRACE_MIN - 1);
  const justPast = ago(HOLD_MIN + RC_OUTAGE_GRACE_MIN + 1);
  assert.equal(base({ cartedAt: justInside }), RC_OUTAGE_HOLD_NOTE, 'inside the bound');
  assert.equal(base({ cartedAt: justPast }), null, 'past the bound — release regardless');
});

test('the bound follows the caller\'s own holdMinutes, not a second copy of 45', () => {
  // If the sweep window ever changes, the extension must move with it rather than silently
  // becoming a different total.
  const carted = ago(70);
  assert.equal(base({ cartedAt: carted, holdMinutes: 60 }), RC_OUTAGE_HOLD_NOTE, '60+30 > 70');
  assert.equal(base({ cartedAt: carted, holdMinutes: 20 }), null, '20+30 < 70');
});

test('the note is stable, not a countdown', () => {
  // A stored "holding N more minutes" is wrong the moment it is written — last_attempt_note
  // is a column, not a live reading, and this repo has been misled by exactly that before.
  // The note DOES contain a number — RC_OUTAGE_GRACE_MIN, the bound — and that is fine
  // because it is a constant. What must not vary is the sentence itself, so the test is
  // identity across inputs that would move a countdown, not a regex hunting for digits.
  // (My first version asserted "no digits" and failed on the bound: the guard was wrong,
  // not the code.)
  const a = base();
  const b = base({ cartedAt: ago(HOLD_MIN + 10), clientReportedAt: ago(RC_OUTAGE_GRACE_MIN - 2) });
  assert.equal(a, b, 'the same sentence regardless of how long is left');
  assert.equal(a, RC_OUTAGE_HOLD_NOTE, 'it is the shared constant, not built per call');
});

test('the grace period is bounded at both ends', () => {
  assert.ok(RC_OUTAGE_GRACE_MIN >= 5, 'too short to outlast an outage worth holding through');
  // RC was still holding a cart at 45 min on 2026-08-25 and its real lapse is UNMEASURED.
  // Past that, the extension buys nothing — RC has let the site go and we would be holding an
  // empty cart while telling a user otherwise.
  assert.ok(RC_OUTAGE_GRACE_MIN <= 45, 'past what RC has ever been observed to honour');
});

test('the sweep actually consults it — the fix must not be inert', async () => {
  // The pure function can be perfect while expireStaleHolds ignores it, and every test above
  // still passes. That shape has shipped in this repo more than once.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/lib/rc-holds.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /rcOutageHoldReason\(\{/, 'expireStaleHolds must call the shared rule');
  assert.match(src, /if \(reason\) heldIds\.push/, 'and a held hold must not reach toRelease');
});
