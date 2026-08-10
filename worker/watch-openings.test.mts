/**
 * "What is open on this watch right now?" — answered from the poller's own records.
 *
 * The value of these is mostly in what they FORBID. The obvious implementation of this
 * feature asks the provider on page load, which duplicates the poller, adds seconds to
 * the watches list, and spends the per-IP rec.gov budget that keeps detection at 15s.
 * `watch_site_alerts.last_seen_open_at` already carries the answer for free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPEN_WINDOW_MS } from '../src/lib/watch-openings';

const src = readFileSync('src/lib/watch-openings.ts', 'utf8');

test('nothing is fetched from a provider to answer this', () => {
  // THE RULE. A live grid fetch here would put provider latency and the rec.gov budget on
  // the critical path of the page a user opens most, to re-derive something the poller
  // wrote seconds ago.
  assert.ok(!/fetch\(|fetchGrid|getAvailability|findRC/.test(src),
    'this must read the poller\'s records, never call a reservation provider');
});

test('the window survives the slowest poll cadence a watch can be on', () => {
  // Since the cadence split, a far-out watch may only be checked every 5 minutes. A window
  // shorter than that would blink the badge off and on for a site that never closed —
  // reporting our polling schedule as if it were the campground's availability.
  const SLOWEST_POLL_MS = 5 * 60_000;
  assert.ok(OPEN_WINDOW_MS >= SLOWEST_POLL_MS * 2,
    'must cover at least two of the slowest cycles, or the badge flickers on a stable site');
  // And not so long that it outlives the truth: a site taken 20 minutes ago should not
  // still be advertised as open.
  assert.ok(OPEN_WINDOW_MS <= 30 * 60_000, 'a very old sighting is not "open now"');
});

test('the no-site-id sentinel is never counted as a site', () => {
  // ReserveAmerica, GoingToCamp and TN/SC have no per-site id and collapse onto '*'
  // (see worker/claim.ts). Counting that row would render "1 site open" from a record
  // that only ever meant "something on this campground" — a number we made up.
  assert.match(src, /site_key <> '\*'/, "the '*' sentinel must be excluded from the count");
});

test('a batch, not a query per watch', () => {
  // The watches list renders every watch at once. Per-watch round trips would be N
  // queries on the page a user opens most.
  assert.match(src, /watch_id = ANY\(\$1\)/, 'openings are looked up for all watches in one go');
});

test('every held unit is offered, not just the first one found', () => {
  // A campground with four sites releasing at 08:00 used to offer exactly one — whichever
  // was first in RC's grid — and the other three were invisible. On a contested morning
  // that is the difference between a choice and a lottery ticket.
  const avail = readFileSync('src/lib/availability/reservecalifornia.ts', 'utf8');
  assert.match(avail, /export async function findRCHeldUnits/, 'the plural finder exists');
  assert.match(avail, /const MAX_HELD_UNITS = \d+/,
    'and is capped — every surfaced hold is a site the bot would take off the market');
  const poller = readFileSync('worker/poller.ts', 'utf8');
  assert.match(poller, /findRCHeldUnits\(/, 'the poller records all of them');
});

test('extra holds are offered but NOT separately alerted', () => {
  // One text per releasing site on a four-cancellation morning is the notification flood
  // migration 039 exists to prevent. The extra offers are one tap away in the app, and
  // claimHoldNotification still dedupes the alert on the release time.
  const poller = readFileSync('worker/poller.ts', 'utf8');
  const loop = poller.slice(poller.indexOf('for (const extra of heldUnits.slice(1))'));
  assert.ok(loop.length > 0, 'the extras are recorded in their own loop');
  const body = loop.slice(0, loop.indexOf('const held = heldUnits[0];'));
  assert.ok(!/dispatchNotifications/.test(body), 'and that loop must not send notifications');
  assert.match(body, /offerHold\(/, 'it records offers only');
  assert.match(body, /hasAutocartEntitlement/, 'gated by the same entitlement as the primary offer');
});

test('a hold the user already asked for is never re-offered a button', () => {
  // A button offering to do the thing they already asked for reads as though the first
  // tap failed — and a second tap on a `requested` hold does nothing, so it would be a
  // control that lies twice.
  const src = readFileSync('src/lib/watch-openings.ts', 'utf8');
  assert.match(src, /h\.status === 'offered'\s*\?/, 'only offered holds get a link');
});

test('only holds that are still ahead, and only before they are carted', () => {
  // A carted hold has its own screen and its own clock; a badge on the list would be a
  // second, staler place to learn about it — and the claim flow is where the ~15-minute
  // cart window is actually explained.
  assert.match(src, /status IN \('offered', 'requested'\)/, 'offered/requested only');
  assert.match(src, /release_at >= to_char\(NOW\(\) AT TIME ZONE 'America\/Los_Angeles'/,
    "release times are zone-less Pacific wall-clock and must be compared in Pacific");
});

test('the card prefers the measurement over the inference', () => {
  // `state === "hit"` was "alerted within the last hour", which decayed into a wrong
  // answer once alerting became transition-based (migration 039): a site that stays open
  // stops re-alerting, so the card reverted to "Watching" while the site sat there open.
  const card = readFileSync('src/components/v2/WatchCard.tsx', 'utf8');
  const state = card.slice(card.indexOf('export function watchState'), card.indexOf('export default function WatchCard'));
  // MATCH THE STATEMENTS, NOT THE WORDS. The first version compared indexOf on bare
  // identifiers and failed against correct code, because the comment ABOVE the check
  // mentions `notification_sent_at` while explaining why it is now second. A test that a
  // comment can flip is not testing the code.
  const measured = state.indexOf('if (w.open_sites?.length) return "hit";');
  const inferred = state.indexOf('const alerted = w.notification_sent_at');
  assert.ok(measured >= 0, 'the seen-open check must exist');
  assert.ok(inferred >= 0, 'the alerted-recently guess must still exist as the fallback');
  assert.ok(measured < inferred, 'seen-open must be checked BEFORE the alerted-recently guess');
});

test('"In your cart" is read from the cart record, never inferred', () => {
  // IT WAS INFERRED, AND WRONG THREE WAYS. `auto_cart && alerted recently` asserted a
  // cart nobody had checked for; it fired on ReserveCalifornia watches where
  // isAutocartLane only matches `ridb`, so an availability cart cannot happen at all; and
  // once the badge keyed off seen-open it fired for any open site. Someone sent to an
  // empty recreation.gov cart at 8am loses the site while they look for it.
  const card = readFileSync('src/components/v2/WatchCard.tsx', 'utf8');
  assert.match(card, /watch\.carted_sites\?\.length \? \(/, 'the badge renders from the record');
  assert.ok(
    !/state === "hit" && watch\.auto_cart && !sessionExpired/.test(card),
    'the inferred condition must be gone — it claimed a cart that had not happened',
  );

  // And the record is the bot's own, so the badge and the one-cart-per-site rule read the
  // same table and cannot disagree about whether a site was taken.
  assert.match(src, /FROM autocart_jobs/, 'carts come from autocart_jobs');
  assert.match(src, /resolution = 'carted' OR cart_outcome = 'carted'/,
    'same predicate as alreadyCartedForWatch');
});

test('a cart badge expires with the cart it describes', () => {
  // rec.gov holds a cart about 15 minutes. A badge that outlived it would send someone to
  // an empty cart — the same class of false promise as the RC hold copy.
  assert.match(src, /INTERVAL '30 minutes'/, 'the carted window is bounded');
});

test('the reconnecting badge is limited to the source that can actually cart', () => {
  // 'Not carted — reconnecting' is about the rec.gov session. On an RC watch there is no
  // availability cart to have missed, so it would name a fault that does not exist.
  const card = readFileSync('src/components/v2/WatchCard.tsx', 'utf8');
  const badge = card.slice(card.indexOf('Not carted — reconnecting') - 400, card.indexOf('Not carted — reconnecting'));
  assert.match(badge, /campground_source === "ridb"/, 'gated to rec.gov watches');
});

test('a book link is as specific as the provider allows, and no more', () => {
  // HOW DEEP THE LINK GOES IS NOT UP TO US, and the row names a site — so promising a
  // site page where only a loop exists spends the window hunting. booking-url already
  // encodes the per-source ceiling; this just checks we route through it rather than
  // assembling URLs here, which is how `/Web/#!park/...` got invented twice.
  const src2 = readFileSync('src/lib/watch-openings.ts', 'utf8');
  assert.match(src2, /await import\('@\/lib\/booking-url'\)/, 'links come from booking-url');
  assert.ok(
    !/https:\/\/www\.(recreation|reservecalifornia)/.test(src2),
    'no hand-assembled provider URLs — lib/booking-url is the only place that builds them',
  );

  // And the copy must tell the user which they got.
  const ui = readFileSync('src/components/v2/ManageWatch.tsx', 'utf8');
  assert.match(ui, /Book goes straight to the site page/, 'rec.gov: per-campsite');
  assert.match(ui, /Book opens the loop on the provider/, 'everything else: loop, say so');
});

test('booking-url really is per-campsite for rec.gov and loop-level for RC', async () => {
  // Pinning the ceiling itself, so the copy above cannot quietly become a lie if
  // booking-url changes.
  const { bookingLink } = await import('../src/lib/booking-url');
  assert.equal(
    bookingLink({ source: 'ridb', reservationsUrl: null, campsiteId: '45741', campgroundId: 'rec-1' }),
    'https://www.recreation.gov/camping/campsites/45741',
  );
  assert.equal(
    bookingLink({
      source: 'reservecalifornia',
      reservationsUrl: 'https://www.reservecalifornia.com/park/720',
      campsiteId: '45741',
      campgroundId: 'rc-715',
    }),
    'https://www.reservecalifornia.com/park/720/715',
    'RC stops at the loop — there is no per-site URL, and the campsiteId is ignored',
  );
});
