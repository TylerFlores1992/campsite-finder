// Opening RC auto-hold to beta testers, and labelling it.
//
// THE ENTITLEMENT WAS NEVER THE GATE. `hasAutocartEntitlement` has been
// `is_beta OR (a live autocart/grandfathered subscription)` since migration 032, and the
// poller's hold offer uses that definition — so every beta tester with an RC watch has been
// eligible the whole time. Nothing had to be unlocked. Two things were actually missing.
//
// 1. NOTHING SAID BETA. A tester met a button promising to take a real campsite off the
//    market, in a feature whose full path has completed on one real morning (2026-08-16)
//    plus synthetic runs. The cost of a miss is not the failed cart — it is that a user who
//    believes the site is handled STOPS WATCHING, which is the rule the claim copy has been
//    governed by since 2026-08-09.
//
// 2. IT WAS UNDISCOVERABLE. Reported by the owner on 2026-08-17 — "no sign of auto cart" on
//    a Carpinteria watch. Correct behaviour and a real gap: `supportsAutoCart` is
//    recreation.gov only, because the watch-level toggle drives the rec.gov lane. An RC hold
//    is not a watch setting at all, so there was nothing on /new to find.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTOCART_BETA_LABEL, AUTOCART_BETA_NOTE, AUTOCART_BETA_NOTE_SHORT } from '../src/lib/autocart-beta.ts';
import { supportsRcHold, isUseDirectSource } from '../src/lib/sources/reservecalifornia/providers.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');

test('the note names the remedy, not just the risk', () => {
  // A caveat with no instruction reads as legal throat-clearing and changes nobody's
  // morning. The whole point is that the user still sets an alarm.
  assert.match(AUTOCART_BETA_NOTE, /\balarm\b/i);
  assert.match(AUTOCART_BETA_NOTE_SHORT, /\balarm\b/i);
  assert.match(AUTOCART_BETA_NOTE, /beta/i);
});

test('the beta label never enters an SMS', () => {
  // The coming-soon offer text is 154 chars against a 160-char one-segment budget, already
  // after fitOneSegment trims the campground name. Any beta wording spends more than that
  // margin and tips it into TWO segments — the exact shape that was Undelivered/30007
  // thirteen times on 2026-08-05. A label nobody receives, on an alert nobody receives, is
  // strictly worse than no label. The text already points at email and the app.
  const sms = strip(read('src/lib/notifications/sms-body.ts'));
  assert.ok(!/AUTOCART_BETA/.test(sms), 'sms-body must not import or render the beta copy');
  assert.ok(!/\bbeta\b/i.test(sms), 'and must not hand-roll its own');
});

test('the offer surfaces a user decides on all carry the label', () => {
  // The confirm screen is where somebody chooses to rely on the bot instead of an alarm,
  // and the email is where the offer arrives. Both must say it BEFORE the commitment.
  const confirmFile = read('src/components/v2/HoldConfirm.tsx');
  assert.match(confirmFile, /AUTOCART_BETA_LABEL/);
  assert.match(confirmFile, /AUTOCART_BETA_NOTE/);
  // MEASURED IN THE JSX, NOT THE FILE. The first version compared raw indexes and matched
  // the IMPORT line — which is above everything, so the assertion was true whatever the
  // markup did, and a mutation that moved the caveat below the promise passed. An ordering
  // guard has to exclude the declarations that are always first.
  const confirm = confirmFile.slice(confirmFile.indexOf('export default function'));
  const caveat = confirm.indexOf('AUTOCART_BETA_NOTE');
  const promise = confirm.indexOf('our bot carts this exact site');
  assert.ok(caveat > -1 && promise > -1, 'both must be present in the component body');
  assert.ok(caveat < promise,
    'the caveat must precede the promise — underneath it, it is read after the decision');

  const notif = read('src/lib/notifications/index.ts');
  assert.match(notif, /AUTOCART_BETA_LABEL/, 'the coming-soon email must carry it');
  // The push body takes the SHORT note: a lock screen truncates the tail, which would drop
  // the caveat and keep the promise — the exact inversion this label exists to prevent.
  assert.match(notif, /Tap to have us hold it\. \$\{AUTOCART_BETA_NOTE_SHORT\}/);
});

test('/new tells an RC watcher the capability exists', () => {
  const nw = read('src/components/v2/NewWatch.tsx');
  assert.match(nw, /canRcHold = campgroundSource \? supportsRcHold\(campgroundSource\) : false/);
  assert.match(nw, /\{canRcHold && \(/, 'the panel must be gated on the hold-capable source');
  assert.match(nw, /AUTOCART_BETA_LABEL/);
  // NO TOGGLE. An RC hold is offered per release and only a tap authorises it; a switch
  // here would imply a standing consent this product deliberately does not take.
  const panel = nw.slice(nw.indexOf('{canRcHold && ('), nw.indexOf('NOTHING IS SAID HERE'));
  assert.ok(!/setRcHold|aria-pressed/.test(panel), 'the panel must not offer a toggle');
});

test('the hold offer is narrower than UseDirect detection, and that is the point', () => {
  // findRCHeldUnits reads UseDirect's generic `Lock` field and works for all ten portals.
  // The bot signs in to ONE ReserveCalifornia account and rc-cart.mjs posts to
  // reservecalifornia.com — so an Ohio watch could be offered a hold nothing can perform.
  // Never fired (every live watch is reservecalifornia or ridb, checked 2026-08-17), and
  // guarded now BECAUSE opening this to testers is what would make it fire.
  assert.ok(supportsRcHold('reservecalifornia'));
  for (const s of ['ohiostateparks', 'virginiastateparks', 'arizonastateparks', 'floridastateparks']) {
    assert.ok(isUseDirectSource(s), `${s} must still be detected as UseDirect`);
    assert.ok(!supportsRcHold(s), `${s} must NOT be offered a hold — the bot has no account there`);
  }
});

test('the poller enforces it, not only the UI', () => {
  // Same rule as every other auto-cart gate: checked where it would be spent. A UI that
  // merely declines to advertise still leaves the poller free to send the button.
  const poller = strip(read('worker/poller.ts'));
  assert.match(poller, /const holdablePortal = supportsRcHold\(w\.campground_source\)/);
  assert.match(poller, /mayHold =[\s\S]{0,200}holdablePortal/,
    'holdablePortal must be one of the conjuncts that decide mayHold');
});
