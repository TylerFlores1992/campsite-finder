/**
 * EVERY BODY STAYS IN ONE SEGMENT, AND THE RC SHAPES CARRY THE STAY DATES.
 *
 * Two properties, and the first outranks the second.
 *
 * **One segment.** A 2-segment alert is the shape that was Undelivered/30007 thirteen times
 * on 2026-08-05. `fitOneSegment` trims the campground NAME to get there and, when it runs
 * out of name, returns the full body rather than a truncated one — so a shape that grows
 * past the budget fails SILENTLY into two segments. That is exactly what adding dates to
 * `hold_missed` did (157 -> 191), and it is why that shape deliberately has none.
 *
 * **The dates.** Reported by the owner 2026-08-24: the RC texts named a campground, a site
 * and a RELEASE time, and never said which nights — so "opens Tue 8:00 AM" was the only
 * date in the message and read as the stay. `availableDates` was already in scope; the
 * availability alert had printed it since 08-06 and the RC shapes never did.
 *
 * These run against the REAL `smsBody`, with the long names and gapped dates that are the
 * cases the budget actually fails on — a fixture with a short name would pass whatever the
 * body said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smsBody } from './sms-body';
import { SMS_ONE_SEGMENT } from './sms-fit';

const NORMAL = 'Morro Bay SP — Upper Section (sites 86-140)';
// 69 chars. NOT the longest in the catalog — measured 2026-08-24, real names reach 100
// (rec.gov "Sandy Bottoms Recreation Area Campground (Clayton, GA)", Minnesota's
// "Lake Vermilion-Soudan Underground Mine State Park — Pyrite Campground…"). It is long
// enough to exhaust the trim on every fitted shape, which is what these assertions need.
const XLONG = 'Pfeiffer Big Sur State Park — South Camp Loop (sites 1-78, riverside)';
const RC_URL = 'https://www.reservecalifornia.com/park/680/583';

const base = (cg: string, dates: string[]) => ({
  campgroundName: cg,
  campsiteName: '#96',
  availableDates: dates,
  bookingUrl: RC_URL,
  availableAt: '2026-08-25T15:00:00Z',
  formatReleaseTime: () => 'Tue 8:00 AM',
});

const TWO_NIGHTS = ['2026-09-04', '2026-09-05'];
// A gap must stay visible — a range would promise a night that is not free.
const GAPPED = ['2026-09-04', '2026-09-05', '2026-09-07'];

// Everything that goes through `fitOneSegment`, i.e. everything whose length we control.
// The rec.gov `carted` body is NOT here — it is a plain template with no trim, by design
// (it is the control in the 08-05 delivery experiment). Its real budget is asserted
// separately below rather than quietly excluded.
const FITTED = [
  { kind: 'coming_soon', holdUrl: 'x' },
  { kind: 'coming_soon' },
  { kind: 'carted', holdUrl: 'x' },
  { kind: 'hold_missed' },
  { kind: 'available' },
  { kind: 'still_open' },
] as const;

const KINDS = [...FITTED, { kind: 'carted' }] as const;

test('EVERY body stays in one segment, on long names and gapped dates', () => {
  for (const cg of [NORMAL, XLONG]) {
    for (const dates of [TWO_NIGHTS, GAPPED, []]) {
      for (const k of FITTED) {
        const body = smsBody({ ...base(cg, dates), ...k } as never);
        assert.ok(
          body.length <= SMS_ONE_SEGMENT,
          `${k.kind}${'holdUrl' in k ? '+hold' : ''} on "${cg.slice(0, 20)}…" with `
          + `${dates.length} night(s) is ${body.length} chars — over ${SMS_ONE_SEGMENT}, so it `
          + `sends as TWO segments:\n${body}`,
        );
      }
    }
  }
});

test('the RC shapes name the nights, not just the release time', () => {
  // The owner's complaint, as an assertion: an RC text must say WHICH nights.
  for (const k of [{ kind: 'coming_soon', holdUrl: 'x' }, { kind: 'carted', holdUrl: 'x' }] as const) {
    const body = smsBody({ ...base(NORMAL, TWO_NIGHTS), ...k } as never);
    assert.match(body, /Sep 4-5/, `${k.kind} must carry the stay dates:\n${body}`);
  }
});

test('a gap in the nights survives into the text', () => {
  // "Sep 4-7" would promise Sep 6, which is not free.
  const body = smsBody({ ...base(NORMAL, GAPPED), kind: 'coming_soon', holdUrl: 'x' } as never);
  assert.match(body, /Sep 4-5, Sep 7/, `a gap must not collapse into a range:\n${body}`);
  assert.doesNotMatch(body, /Sep 4-7/);
});

test('no dates is not a crash and not an empty "for"', () => {
  // A held unit with no matched nights is possible; the body must simply omit them.
  const body = smsBody({ ...base(NORMAL, []), kind: 'coming_soon', holdUrl: 'x' } as never);
  // THE GENERAL PROPERTY, not a literal. The first version of this asserted
  // `/ for opens/` and MISSED its own regression: dropping the length guard yields
  // "Site #96 for  opens" with TWO spaces, so a one-space pattern sails past. Any empty
  // interpolation shows up as doubled whitespace, so that is what to test.
  assert.doesNotMatch(body, /\s{2,}/, `no doubled whitespace — an empty insert leaks:\n${body}`);
  assert.doesNotMatch(body, /\bfor\b(?!\s+\w+\s+\d)/,
    `a dangling "for" with no dates after it:\n${body}`);
  assert.ok(body.length <= SMS_ONE_SEGMENT);
});

test('hold_missed deliberately carries NO dates — it is the tightest shape', () => {
  // Adding them took it 157 -> 191 and out to two segments, because it already carries the
  // provider URL. If this ever starts matching, re-measure before "fixing" the test.
  const body = smsBody({ ...base(NORMAL, TWO_NIGHTS), kind: 'hold_missed' } as never);
  assert.doesNotMatch(body, /for Sep 4-5/,
    'hold_missed must not carry stay dates — it goes to two segments and gets filtered');
  assert.ok(body.length <= SMS_ONE_SEGMENT);
});

test('RECORDED, NOT FIXED: the rec.gov carted control OVERFLOWS on long names', () => {
  // Found 2026-08-24 while adding the stay dates. This body does not go through
  // `fitOneSegment`, so its length is whatever the campground name makes it — and
  // **19 real rec.gov campgrounds have names over 57 characters** (the longest is 100),
  // measured against the live catalog. For those, the auto-cart text ALREADY sends as two
  // segments today. Pre-existing and nothing to do with the dates change.
  //
  // NOT fixed here because this shape is the control in the 08-05 delivery experiment and
  // CLAUDE.md says so in as many words; trimming it is a deliberate decision about the
  // auto-cart path, not a side effect of a copy change. This test PINS the fact so it
  // cannot be rediscovered from scratch, and fails if somebody "fixes" it silently.
  const short = smsBody({ ...base('Kirk Creek', TWO_NIGHTS), kind: 'carted' } as never);
  assert.ok(short.length <= SMS_ONE_SEGMENT, 'an ordinary name still fits');
  const long = smsBody({ ...base(XLONG, TWO_NIGHTS), kind: 'carted' } as never);
  assert.ok(long.length > SMS_ONE_SEGMENT,
    'if this now FITS, the control was changed — re-read CLAUDE.md on the delivery control '
    + 'before updating this test');
});

test('the rec.gov carted body is otherwise UNCHANGED — it is the delivery control', () => {
  // CLAUDE.md: this shape is the control in the 08-05 delivery experiment. Changing it
  // throws that away.
  const body = smsBody({ ...base(NORMAL, TWO_NIGHTS), kind: 'carted' } as never);
  assert.match(body, /is in your cart — check out now, held ~15 min: https:\/\/www\.recreation\.gov\/cart$/);
  assert.doesNotMatch(body, /Sep 4-5/);
});

test('no camphawk.app link in any body — the domain was filtered 13 for 13', () => {
  for (const k of KINDS) {
    const body = smsBody({ ...base(NORMAL, TWO_NIGHTS), ...k } as never);
    assert.doesNotMatch(body, /camphawk\.app/, `${k.kind} must not link to our own domain`);
  }
});
