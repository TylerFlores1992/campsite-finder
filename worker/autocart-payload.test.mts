/**
 * Every alert the auto-cart lane produces is REPLAYED from one stored payload — and that
 * payload was missing the two fields the alert is built out of.
 *
 * ── WHAT WAS WRONG (2026-08-11) ────────────────────────────────────────────────────────
 * `autocartPayload()` never included `campsiteId`, and the reconciler's fallback dispatched
 * the payload bare, so `kind` was undefined too. Silver Lake site 044 sent three texts in a
 * day — 08:08, 13:08, 15:13 — every one of them:
 *   - linking to the whole CAMPGROUND rather than the site, because the booking URL falls
 *     back when there is no id, so three alerts read as three identical texts;
 *   - carrying NO MUTE LINK, since `campsiteId` is the mute target — the one control that
 *     would have stopped the noise was absent from exactly the alerts that caused it;
 *   - and unattributable to a site afterwards, which is why "am I getting duplicates?"
 *     could not be answered from the notifications table at all.
 *
 * The job row has carried `campsite_id` in its own column the whole time. Only the payload
 * lost it — which is the tell that this was an omission, not a decision.
 *
 * ── WHY A SOURCE TEST ──────────────────────────────────────────────────────────────────
 * `autocartPayload` is module-private in poller.ts, and importing the poller STARTS it —
 * the same reason `claim.ts` was split out. So this asserts on the source, like the other
 * poller invariants in this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const poller = readFileSync('worker/poller.ts', 'utf8');
/** Comments stripped — an absence assertion must not match the note explaining it. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function autocartPayloadBody(): string {
  const i = poller.indexOf('function autocartPayload');
  assert.ok(i > 0, 'autocartPayload must exist');
  const end = poller.indexOf('\n}', i);
  assert.ok(end > i);
  return poller.slice(i, end);
}

test('the auto-cart payload carries the site id', () => {
  // Not "a site id somewhere" — the one the detection actually found. `result.campsiteId` is
  // what the main lane passes and what the job row stores; anything else would be a second
  // source of truth for the same fact.
  const body = code(autocartPayloadBody());
  assert.match(body, /campsiteId:\s*result\.campsiteId/,
    'without this every lane alert loses its site link AND its mute link');
});

test('the payload carries everything an alert is built from', () => {
  // The failure was an omission in an object literal, which no type caught because every
  // field on NotificationPayload that matters here is optional. Pin the set.
  const body = code(autocartPayloadBody());
  for (const field of [
    'userId', 'watchId', 'campgroundId', 'campgroundName',
    'availableDates', 'bookingUrl', 'campsiteName', 'campsiteId', 'startDate', 'endDate',
  ]) {
    assert.match(body, new RegExp(`\\b${field}:`), `autocartPayload must carry ${field}`);
  }
});

test('the fallback alert states its kind', () => {
  // Dispatching the bare payload left `kind` undefined, and every wording branch in
  // lib/notifications keys off it — so the alert that arrives LATE, because the bot could
  // not cart, got the least specific text of any alert we send.
  const i = poller.indexOf('autocart fallback dispatch failed');
  assert.ok(i > 0, 'the fallback dispatch must exist');
  const line = poller.slice(poller.lastIndexOf('\n', poller.lastIndexOf('dispatchNotifications', i)), i);
  assert.match(line, /kind: 'available'/, 'the fallback must say what kind of alert it is');
  assert.ok(!/dispatchNotifications\(p\)/.test(code(poller)),
    'the bare payload must never be dispatched without a kind');
});

test('a site id lost here cannot be recovered downstream', () => {
  // The reason this is worth a test rather than care: the mute link is built ONLY from
  // payload.campsiteId, and the alert is sent from a replay of the stored payload — so a
  // field dropped at write time is gone for every consumer, days later, with nothing to
  // reconstruct it from.
  const notif = readFileSync('src/lib/notifications/index.ts', 'utf8');
  assert.match(notif, /payload\.campsiteId \? actionUrlFor\(payload\.watchId, 'mute_site'/,
    'mute is built from campsiteId alone — that is why the payload must carry it');
});
