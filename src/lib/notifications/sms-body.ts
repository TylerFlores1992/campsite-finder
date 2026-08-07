// The exact text of every SMS CampHawk sends.
//
// WHY THIS IS ITS OWN PURE FUNCTION. Our A2P 10DLC campaign's registered **message
// samples** were written 7/7/2026 and never touched again, while the code kept moving.
// By 2026-08-05 live traffic carried a `camphawk.app/b/<token>` link that appears in NO
// sample, and every alert was being filtered (30007, measured 10 for 10) while auto-cart
// texts — whose shape still matched a sample — arrived fine. The registration had not
// broken; **the code had drifted away from it**, and nothing in the repo could notice.
//
// Bodies are built HERE, by a function that needs no database, no Twilio and no network,
// so `scripts/a2p-samples.mts` can print exactly what we send. Re-registering then means
// pasting real output rather than reconstructing messages from memory — and a drift
// between what we send and what is registered becomes something you can diff.
//
// The rules these bodies obey, each bought with a real incident:
//   • ONE segment. Two-segment alerts were undelivered; `fitOneSegment` trims the
//     campground NAME and never the dates or the link.
//   • NEVER a camphawk.app link (see sendSms, which throws on our own domain).
//   • Provider URLs only, fragment stripped — a well-known destination, no redirect.

import { fitOneSegment } from '@/lib/notifications/sms-fit';
import { formatStayDates } from '@/lib/notifications/dates';
import type { NotificationPayload } from '@/lib/notifications';

export interface SmsBodyInput {
  /** Derived from the payload rather than re-typed: a second copy of this union drifts,
   *  and the compiler only catches it when a new kind happens to reach here. */
  kind?: NotificationPayload['kind'];
  campgroundName: string;
  campsiteName?: string | null;
  availableDates: string[];
  bookingUrl: string;
  availableAt?: string | null;
  /** Presence flips two kinds to their ReserveCalifornia meaning — see below. */
  holdUrl?: string | null;
  /** Injected so this stays pure; `dispatchSms` passes its own formatter. */
  formatReleaseTime: (iso?: string | null, short?: boolean) => string;
}

export function smsBody(p: SmsBodyInput): string {
  const site = p.campsiteName ? ` Site ${p.campsiteName}` : '';
  // Trailing "Campground"/"CG" is noise in a 160-character budget — the name still reads.
  const name = p.campgroundName.replace(/\s+(campground|cg)\.?$/i, '');

  if (p.kind === 'carted' && p.holdUrl) {
    // An RC HOLD, not a rec.gov cart: the site is in CAMPHAWK's cart, not theirs, and
    // claiming it needs our page — which cannot go in a text. So the text says what
    // happened and points at a channel that works. A text that arrives beats a link
    // that doesn't.
    return fitOneSegment(
      (n) => `CampHawk: ${n}${site} is HELD for you. Open your email or the CampHawk app to claim it.`,
      name,
    );
  }

  if (p.kind === 'carted') {
    // Already one segment and already arriving. Left exactly as it was — this is the
    // CONTROL in the delivery experiment, and changing it would throw that away.
    return `CampHawk: ${name}${site} is in your cart — check out now, held ~15 min: https://www.recreation.gov/cart`;
  }

  if (p.kind === 'coming_soon' && p.holdUrl) {
    // The offer lives on camphawk.app and cannot ride in a text, so this points at the
    // channels that CAN carry it. Saying only "we'll text when it's bookable" would
    // promise LESS than what is actually on offer.
    const when = p.formatReleaseTime(p.availableAt, true);
    return fitOneSegment(
      (n) => `CampHawk: ${n}${site} opens ${when}. Open your email or the app to have us hold it.`,
      name,
    );
  }

  if (p.kind === 'hold_missed') {
    // Says the thing plainly and then points at what still works. "Sorry" without a next
    // step wastes the one segment we get; the site really may still be free, and the
    // provider link is the same one an ordinary alert would have carried.
    const bookTxt = p.bookingUrl.split('#')[0];
    return fitOneSegment(
      (n) => `CampHawk: we could NOT hold ${n}${site} — our bot missed the release. It may still be free: ${bookTxt}`,
      name,
    );
  }

  if (p.kind === 'coming_soon') {
    const when = p.formatReleaseTime(p.availableAt, true);
    return fitOneSegment(
      (n) => `CampHawk: ${n}${site} was just cancelled, opens ${when}. We'll text when it's bookable.`,
      name,
    );
  }

  // "Sep 4-6", not three ISO dates: they read as timestamps, cost ~24 characters, and —
  // beside a coming-soon text saying "opens Aug 6, 8:15 AM PT" — were read as a release
  // date rather than the nights of the stay.
  const dates = formatStayDates(p.availableDates);
  // THE PROVIDER'S OWN URL, never our `/b/<token>` shortlink. Measured on one handset,
  // same segment count: recreation.gov link → Delivered; no link → Delivered;
  // camphawk.app/b/<token> → Undelivered 30007, ten for ten.
  const bookTxt = p.bookingUrl.split('#')[0];
  // "open FOR Sep 4-6" — the preposition does real work. "open Sep 4-6" was read as
  // "opens on Sep 4", because the neighbouring coming-soon text uses "opens <date>" to
  // mean exactly that. And "STILL open" is the whole point of the 6h follow-up: worded
  // like the first alert it reads as a duplicate, which is the complaint that produced
  // the feature.
  const lead = p.kind === 'still_open' ? 'STILL open for' : 'open for';
  return fitOneSegment((n) => `CampHawk: ${n}${site} ${lead} ${dates}. Book: ${bookTxt}`, name);
}
