/**
 * "3 sites just opened at Morro Bay" — one message, not three.
 *
 * WHAT PRODUCES THREE. Since migration 070 one watch covers a whole park and the poller
 * runs one row per (watch, campground). At an 08:00 ReserveCalifornia release every held
 * site in the park frees at once, so a three-division park watch finds an opening in each
 * division IN THE SAME CYCLE — and sent three texts, three emails and three pushes for
 * what the reader experienced as one event at one campground.
 *
 * THE CLAIM IS UNTOUCHED, and that is the property to protect. Every site still wins or
 * loses its own `(watch, campground::site)` claim before any grouping happens. The
 * 26-texts-in-an-hour storm of 2026-08-24 was caused by changing what a claim key means,
 * in a change that was also trying to reduce alerts — so a batcher that merged claims
 * would be that mistake again, inside the feature meant to prevent it.
 *
 * Pure throughout: grouping, and the three renderers. The SMS budget is the sharp edge
 * and is asserted in characters, not by eye.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupByWatch, alsoSitesFrom } from './alert-batch';
import { smsBody } from '../src/lib/notifications/sms-body';
import { pushBody, buildEmailHtml, type NotificationPayload } from '../src/lib/notifications';
import { SMS_ONE_SEGMENT } from '../src/lib/notifications/sms-fit';

const fmt = () => 'Tue 8:00 AM';

const sms = (over: Partial<Parameters<typeof smsBody>[0]> = {}) =>
  smsBody({
    kind: 'available',
    campgroundName: 'Morro Bay SP — Upper Section (sites 86-140)',
    campsiteName: '#96',
    availableDates: ['2026-09-04', '2026-09-05', '2026-09-06'],
    bookingUrl: 'https://www.reservecalifornia.com/park/680/583',
    formatReleaseTime: fmt,
    ...over,
  });

const also = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    campgroundName: `Morro Bay SP — Division ${i}`,
    campsiteName: `#${20 + i}`,
    campsiteId: String(400 + i),
    bookingUrl: `https://www.reservecalifornia.com/park/680/58${i}`,
  }));

const payload = (over: Partial<NotificationPayload> = {}): NotificationPayload => ({
  userId: 'u1',
  watchId: 'w1',
  campgroundId: 'rc-583',
  campgroundName: 'Morro Bay SP — Upper Section',
  availableDates: ['2026-09-04', '2026-09-05'],
  bookingUrl: 'https://www.reservecalifornia.com/park/680/583',
  campsiteName: '#96',
  campsiteId: '43191',
  startDate: '2026-09-04',
  endDate: '2026-09-06',
  kind: 'available',
  ...over,
});

// ---------------------------------------------------------------- grouping

test('openings for one watch group together; two watches stay apart', () => {
  const groups = groupByWatch([
    { watchId: 'a', n: 1 }, { watchId: 'b', n: 2 }, { watchId: 'a', n: 3 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((g) => g.n), [1, 3]);
  assert.deepEqual(groups[1].map((g) => g.n), [2]);
});

test('the first opening found leads the message', () => {
  // The lead supplies the dates and the deep link, so preserving insertion order is what
  // keeps a batched alert identical to the un-batched one it replaces.
  const [group] = groupByWatch([{ watchId: 'a', n: 1 }, { watchId: 'a', n: 2 }]);
  assert.equal(group[0].n, 1);
});

test('one opening is one group — the ordinary case is not a batch', () => {
  const groups = groupByWatch([{ watchId: 'a', n: 1 }]);
  assert.deepEqual(groups.map((g) => g.length), [1]);
});

test('every site in a batch keeps its OWN deep link', () => {
  // A deep link is per site AND per division — `bookingLink` turns /park/680 into
  // /park/680/583 — so handing the lead's link to a sibling sends the reader to a loop the
  // site is not in. That is the 2026-08-16 report ("says site A012 but took me to 35-102")
  // by a third route, and inline in the poller it was invisible to every test.
  const out = alsoSitesFrom([
    { campgroundName: 'Morro Lottery', campsiteName: '#33', campsiteId: '1', bookingUrl: 'https://x/park/680/2185' },
    { campgroundName: 'Lower Section', campsiteName: '#12', campsiteId: '2', bookingUrl: 'https://x/park/680/582' },
  ]);
  assert.deepEqual(out.map((o) => o.bookingUrl), ['https://x/park/680/2185', 'https://x/park/680/582']);
  assert.deepEqual(out.map((o) => o.campgroundName), ['Morro Lottery', 'Lower Section'],
    'and its own division name — the whole point is that they are different places');
});

test('a missing site name becomes null, never the string "undefined"', () => {
  const [out] = alsoSitesFrom([{ campgroundName: 'X', bookingUrl: 'https://x' }]);
  assert.equal(out.campsiteName, null);
  assert.equal(out.campsiteId, null);
});

// ---------------------------------------------------------------- SMS, the tight channel

test('a single opening is worded exactly as it always was', () => {
  const body = sms();
  assert.match(body, /Site #96 open for/);
  // ANCHORED ON THE BATCH PHRASE, not the bare word: the real campground name is
  // "Morro Bay SP — Upper Section (sites 86-140)", so `/sites/` matched the fixture's own
  // name and the assertion was about nothing.
  assert.ok(!/\d+ sites open/.test(body), 'no batch wording may leak into the single case');
});

test('a batch names the count and the sites, in one segment', () => {
  const body = sms({ alsoSites: [{ campsiteName: '#33' }, { campsiteName: '#12' }] });
  assert.match(body, /3 sites open for/);
  assert.match(body, /#96, #33, #12/);
  assert.ok(body.length <= SMS_ONE_SEGMENT, `${body.length} chars — a second segment is not delivered`);
});

test('when the names will not fit, the COUNT survives and the names go', () => {
  // The names are the part that grows without bound. A two-segment alert is the shape
  // that was Undelivered/30007 thirteen times on 2026-08-05, so delivery wins.
  const body = sms({ alsoSites: also(12) });
  assert.ok(body.length <= SMS_ONE_SEGMENT, `${body.length} chars`);
  assert.match(body, /13 sites open for/);
  assert.match(body, /Book: https:/, 'the link is never what gets cut');
});

test('NO batch, however big, is allowed to reach two segments', () => {
  for (let n = 1; n <= 40; n++) {
    const body = sms({ alsoSites: also(n) });
    assert.ok(body.length <= SMS_ONE_SEGMENT, `${n} extra sites produced ${body.length} chars`);
  }
});

test('the site list is all of them or none — never a partial list read as complete', () => {
  // A reader checks the numbers against the map. Three sites listed as two means they
  // book one and never learn the third was free.
  const body = sms({ alsoSites: [{ campsiteName: '#33' }, { campsiteName: null }] });
  assert.match(body, /3 sites open for/);
  assert.ok(!/#33/.test(body), 'a list missing an unnamed site must not be printed at all');
});

test('the six-hour follow-up keeps its own wording when batched', () => {
  // Worded like a fresh alert, the nudge is indistinguishable from the hourly-repeat bug
  // it replaces.
  const body = sms({ kind: 'still_open', alsoSites: [{ campsiteName: '#33' }] });
  assert.match(body, /2 sites STILL open for/);
});

// ---------------------------------------------------------------- push and email

test('push leads with the count, and never names one site while hiding the rest', () => {
  const one = pushBody(payload());
  assert.match(one.body, /#96/);

  const many = pushBody(payload({ alsoSites: also(2) }));
  assert.match(many.body, /3 sites open for/);
  assert.ok(!/#96/.test(many.body),
    'naming one site on a lock screen and dropping the others is worse than naming none');
});

test('a batched push still says STILL for the follow-up', () => {
  const p = pushBody(payload({ kind: 'still_open', alsoSites: also(1) }));
  assert.match(p.body, /2 sites still open/);
});

test('the email lists every site WITH ITS OWN LINK', () => {
  // This is the channel with room, and it is why the SMS can honestly fall back to a
  // count. A deep link is per site and per division; reusing the lead's would send the
  // reader to the wrong loop.
  const html = buildEmailHtml(payload({ alsoSites: also(2) }));
  assert.match(html, /Also open right now/);
  for (const a of also(2)) {
    assert.ok(html.includes(a.bookingUrl), `missing the link for ${a.campsiteName}`);
    assert.ok(html.includes(String(a.campsiteName)), `missing ${a.campsiteName}`);
  }
});

test('a single-site email is unchanged — no empty batch block', () => {
  const html = buildEmailHtml(payload());
  assert.ok(!/Also open right now/.test(html));
});

// ---------------------------------------------------------------- the poller wiring

const poller = readFileSync('worker/poller.ts', 'utf8');
const code = poller.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the claim still runs per row, before anything is grouped', () => {
  // THE PROPERTY THAT MATTERS MOST. `claimNotification` doubles as the "still open"
  // observation and must be called on every cycle a site is open — a skipped call looks
  // exactly like the site vanishing, which re-alerts. Grouping must never gate it.
  const loop = code.slice(code.indexOf('for (const watch of mainWatches)'), code.indexOf('groupByWatch('));
  assert.match(loop, /await claimNotification\(/, 'the claim must still be inside the row loop');
  assert.ok(!/dispatchNotifications\(/.test(loop),
    'the row loop must QUEUE, not send — otherwise nothing is batched');
});

test('the held marker is cleared for EVERY member of a batch, not just the lead', () => {
  // Clearing only the lead leaves the other divisions' held markers set for ever, so a
  // later cancellation of those sites would never announce — a silent alerting hole
  // created by the fix for a noisy one.
  const after = code.slice(code.indexOf('groupByWatch('));
  const release = after.indexOf('releaseHoldClaims(');
  assert.ok(release > -1, 'the anchor has rotted — releaseHoldClaims moved');
  const around = after.slice(Math.max(0, release - 300), release + 120);
  assert.match(around, /for \(const member of group\)/,
    'releaseHoldClaims must run over the whole group');
});

test('exactly one dispatch per group', () => {
  // BOUNDED TO THE BATCH BLOCK. Slicing to the end of the file also swept up the
  // coming-soon loop's own `dispatchNotifications`, so the count was two and the
  // assertion was measuring the wrong thing entirely.
  const start = code.indexOf('groupByWatch(');
  const end = code.indexOf('for (const w of rcWatches)', start);
  assert.ok(start > -1 && end > start, 'the anchors have rotted');
  const block = code.slice(start, end);
  const sends = block.match(/await dispatchNotifications\(/g) ?? [];
  assert.equal(sends.length, 1, 'a second send would restore the per-division alerts');
});
