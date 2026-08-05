// One-segment fitting for alert texts.
//
// Run: npm test   (pure — no network, no DB)
//
// Worth testing because the failure is invisible from inside the app: a body that
// creeps to 161 characters looks identical in the logs, in the database and in our own
// dashboard, and the only symptom is Twilio marking it Undelivered hours later. That is
// exactly how the alerts went missing in the first place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitOneSegment, SMS_ONE_SEGMENT } from './sms-fit';

/** The real shape of an `available` alert, so the numbers here mean something. */
const alert = (n: string) =>
  `CampHawk: ${n} Site 008 open 2026-09-04, 2026-09-05. Book: https://camphawk.app/b/aB3xY9kQ2mNp`;

test('a short name is left completely alone', () => {
  const out = fitOneSegment(alert, 'Silver Lake');
  assert.equal(out, alert('Silver Lake'));
  assert.ok(out.length <= SMS_ONE_SEGMENT);
});

test('the real Silver Lake alert now fits one segment', () => {
  // The message this replaced was ~186 characters — two segments, and every one of
  // those came back Undelivered.
  const out = fitOneSegment(alert, 'Silver Lake Campground June Lake (CA)');
  assert.ok(out.length <= SMS_ONE_SEGMENT, `was ${out.length}`);
  assert.ok(out.includes('Silver Lake Campground June Lake (CA)'), 'nothing needed cutting');
});

test('a long name is trimmed until the whole body fits', () => {
  // Leo Carrillo's catalog name is 56 characters and pushes the body over on its own.
  const out = fitOneSegment(alert, 'Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133)');
  assert.ok(out.length <= SMS_ONE_SEGMENT, `was ${out.length}`);
  assert.ok(out.startsWith('CampHawk: Leo Carrillo'), 'the identifying part survives');
  assert.ok(out.includes('Book: https://camphawk.app/b/'), 'the link is never what gets cut');
  assert.ok(out.includes('2026-09-04'), 'the dates are never what gets cut');
});

test('the trim marker is a plain full stop, never an ellipsis character', () => {
  // '…' is outside GSM-7. It would either cost three characters after Smart Encoding or
  // tip the entire message into UCS-2, where the budget is 70 — turning the fix into
  // the bug.
  const out = fitOneSegment(alert, 'A'.repeat(120));
  assert.ok(!out.includes('…'));
  assert.match(out, /A+\. Site 008/);
});

test('everything in the fitted body is GSM-7-safe apart from what the caller passed in', () => {
  const out = fitOneSegment(alert, 'B'.repeat(120));
  assert.ok(out.length <= SMS_ONE_SEGMENT);
  // No stray non-ASCII introduced by the trimming itself.
  assert.ok(!/[^\x20-\x7E]/.test(out.replace(/[—’]/g, '')));
});

test('an unfittable body is returned WHOLE, not mangled', () => {
  // If the fixed parts alone blow the budget there is no name short enough to save it.
  // Two segments that say something beat one segment that says nothing.
  const huge = (n: string) => `${'x'.repeat(200)} ${n}`;
  const out = fitOneSegment(huge, 'Silver Lake');
  assert.equal(out, huge('Silver Lake'), 'must not truncate the caller’s wording');
});

test('never returns something longer than what it was given', () => {
  for (const n of ['', 'a', 'Yosemite', 'Z'.repeat(300)]) {
    assert.ok(fitOneSegment(alert, n).length <= alert(n).length);
  }
});

test('the coming_soon shape fits too, with the longest real name', () => {
  const soon = (n: string) =>
    `CampHawk: ${n} was just cancelled, opens Aug 6, 8:00 AM. We'll text when it's bookable.`;
  const out = fitOneSegment(soon, 'Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133)');
  assert.ok(out.length <= SMS_ONE_SEGMENT, `was ${out.length}`);
});
