#!/usr/bin/env tsx
/**
 * Print the exact SMS bodies CampHawk sends, for the A2P 10DLC campaign registration.
 *
 * WHY. Our campaign's registered message samples were written 7/7/2026 and never touched
 * again while the code kept moving. By 2026-08-05 live alerts carried a
 * `camphawk.app/b/<token>` link that appears in NO sample, and every one was filtered
 * (30007, ten for ten) while auto-cart texts — still matching a sample — arrived fine.
 * The registration had not broken; **the code drifted away from it**, and nothing could
 * notice. This makes the drift visible: run it, diff against the campaign, see it.
 *
 *   npx tsx scripts/a2p-samples.mts             # what we send today, ready to paste
 *   npx tsx scripts/a2p-samples.mts --proposed  # + the camphawk.app shapes to register
 *   npx tsx scripts/a2p-samples.mts --check     # exit 1 if any body is over one segment
 *
 * No credentials and no network: the bodies are built by the same pure `smsBody()` the
 * dispatcher uses. It CANNOT read the live campaign — Twilio's keys are Vercel
 * "sensitive" vars, which the API never returns — so comparing against what is
 * registered is a human step in the Console.
 */
import { smsBody, type SmsBodyInput } from '../src/lib/notifications/sms-body';
import { fitOneSegment, SMS_ONE_SEGMENT } from '../src/lib/notifications/sms-fit';

/** The same formatter the dispatcher injects (kept local so this needs no server deps). */
function formatReleaseTime(iso?: string | null, short = false): string {
  const m = iso?.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return 'soon';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const opts: Intl.DateTimeFormatOptions = short
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' };
  return `${d.toLocaleString('en-US', opts)} PT`;
}

/**
 * REAL campgrounds and REAL URLs, not placeholders.
 *
 * TCR reviewers read samples as representative traffic, and a sample containing
 * `[CAMPGROUND]` or `example.com` is both less convincing and — the part that bit us —
 * impossible to compare against a live message. Leo Carrillo is deliberately the longest
 * real name we watch, so if IT fits one segment, they all do.
 */
const LONGEST_REAL_NAME = 'Leo Carrillo SP — Canyon Campground (sites 1-24, 78-133)';

const CASES: Array<{ label: string; note?: string; input: SmsBodyInput }> = [
  {
    label: 'Availability alert (rec.gov)',
    note: 'The most common message by far. Transactional: the user asked us to watch this campground.',
    input: {
      kind: 'available',
      campgroundName: 'Kirk Creek Campground',
      campsiteName: '019',
      availableDates: ['2026-09-04', '2026-09-05', '2026-09-06'],
      bookingUrl: 'https://www.recreation.gov/camping/campgrounds/233116',
      formatReleaseTime,
    },
  },
  {
    label: 'Availability alert (ReserveCalifornia, longest real name)',
    note: 'Proves the one-segment budget survives the worst-case campground name.',
    input: {
      kind: 'available',
      campgroundName: LONGEST_REAL_NAME,
      campsiteName: '#L108',
      availableDates: ['2026-09-04'],
      bookingUrl: 'https://www.reservecalifornia.com/park/665/539',
      formatReleaseTime,
    },
  },
  {
    label: 'Still-open follow-up (once, 6h later)',
    note: 'Deliberately worded so it cannot be mistaken for a second opening.',
    input: {
      kind: 'still_open',
      campgroundName: 'Silver Lake Campground June Lake (CA)',
      campsiteName: '018',
      availableDates: ['2026-10-09', '2026-10-10'],
      bookingUrl: 'https://www.recreation.gov/camping/campgrounds/232279',
      formatReleaseTime,
    },
  },
  {
    label: 'Coming soon (a cancelled site with a known release time)',
    input: {
      kind: 'coming_soon',
      campgroundName: LONGEST_REAL_NAME,
      campsiteName: '#L108',
      availableDates: ['2026-09-04'],
      bookingUrl: 'https://www.reservecalifornia.com/park/665/539',
      availableAt: '2026-08-07T08:00:00',
      formatReleaseTime,
    },
  },
  {
    label: 'Coming soon, hold offered (Auto-Cart plan)',
    note: 'Carries no link: the offer lives on camphawk.app, which we keep out of SMS.',
    input: {
      kind: 'coming_soon',
      campgroundName: LONGEST_REAL_NAME,
      campsiteName: '#L108',
      availableDates: ['2026-09-04'],
      bookingUrl: 'https://www.reservecalifornia.com/park/665/539',
      availableAt: '2026-08-07T08:00:00',
      holdUrl: 'https://camphawk.app/claim/x',
      formatReleaseTime,
    },
  },
  {
    label: 'Auto-cart success (rec.gov)',
    note: 'The CONTROL in the delivery experiment — this shape has always been delivered.',
    input: {
      kind: 'carted',
      campgroundName: 'Silver Lake Campground June Lake (CA)',
      campsiteName: '018',
      availableDates: ['2026-10-09'],
      bookingUrl: 'https://www.recreation.gov/camping/campgrounds/232279',
      formatReleaseTime,
    },
  },
  {
    label: 'RC hold secured, waiting to be claimed',
    input: {
      kind: 'carted',
      campgroundName: LONGEST_REAL_NAME,
      campsiteName: '#L108',
      availableDates: ['2026-09-04'],
      bookingUrl: 'https://www.reservecalifornia.com/park/665/539',
      holdUrl: 'https://camphawk.app/claim/x',
      formatReleaseTime,
    },
  },
];

/**
 * PROPOSED bodies — what we want to send ONCE camphawk.app is in the registered samples.
 *
 * Not what we send today, and deliberately not wired into `smsBody`. The order is the
 * whole lesson of 2026-08-05: **register first, then send.** Sending a shape that is not
 * in the samples is exactly how every alert got filtered while the campaign sat healthy
 * and Approved.
 *
 * The two messages that gain something are the ones where the next action is on OUR site
 * and the user is racing a clock. Today they read "open your email or the app", which is
 * an extra hop at the precise moment speed matters — the site is held, or about to be.
 *
 * NOTE ON LENGTH: no URL shortening is needed. Measured with the real `fitOneSegment`,
 * the live 74-character `/claim/<uuid>?t=<token>` link still lands at 155 characters —
 * one segment. Shortening would buy back the campground name that gets trimmed, which is
 * cosmetic. It is NOT a precondition, and reaching for a short opaque path would edge
 * back toward `/b/<token>`, whose REDIRECT behaviour (T-Mobile CoC §4.8) is the
 * documented suspicion. `/claim/...` renders a real page; it does not forward.
 */
const CLAIM_URL = 'https://camphawk.app/claim/fb538861-3c2f-4b1e-9a77-2e0d5c8a91b4?t=aB3xY9zQ';
const PROPOSED: Array<{ label: string; note?: string; build: (n: string) => string }> = [
  {
    label: 'RC hold secured — claim link (PROPOSED)',
    note: 'Replaces "open your email or the app to claim it".',
    build: (n) => `CampHawk: ${n} Site #L108 is HELD for you. Claim: ${CLAIM_URL}`,
  },
  {
    label: 'Coming soon, hold offered — one-tap opt in (PROPOSED)',
    note: 'Replaces "open your email or the app to have us hold it".',
    build: (n) => `CampHawk: ${n} Site #L108 opens Aug 7, 8:00 AM PT. Have us hold it: ${CLAIM_URL}`,
  },
];

const check = process.argv.includes('--check');
const proposed = process.argv.includes('--proposed');
let over = 0;
const domains = new Set<string>();

for (const c of CASES) {
  const body = smsBody(c.input);
  const segs = body.length <= SMS_ONE_SEGMENT ? 1 : Math.ceil(body.length / 153);
  if (segs > 1) over++;
  for (const m of body.matchAll(/https?:\/\/([^/\s]+)/g)) domains.add(m[1]);
  if (!check) {
    console.log(`\n── ${c.label}`);
    if (c.note) console.log(`   ${c.note}`);
    console.log(`   ${body.length} chars, ${segs} segment${segs === 1 ? '' : 's'}`);
    console.log(`\n${body}\n`);
  }
}

if (proposed) {
  console.log('\n\n════ PROPOSED — register these BEFORE sending them ════');
  for (const p of PROPOSED) {
    const body = fitOneSegment(p.build, LONGEST_REAL_NAME);
    const segs = body.length <= SMS_ONE_SEGMENT ? 1 : Math.ceil(body.length / 153);
    console.log(`\n── ${p.label}`);
    if (p.note) console.log(`   ${p.note}`);
    console.log(`   ${body.length} chars, ${segs} segment${segs === 1 ? '' : 's'}  (worst-case campground name)`);
    console.log(`\n${body}\n`);
    if (segs > 1) over++;
  }
  console.log('These are NOT sent today. sendSms throws on a camphawk.app link, and that');
  console.log('guard stays until the campaign samples above are updated and re-approved.');
}

console.log('\n=== Link domains that appear in live SMS ===');
for (const d of [...domains].sort()) console.log(`  ${d}`);
console.log(
  '\nEVERY domain above must appear in the campaign\'s registered samples. That is the\n' +
  'whole failure mode: a domain we send but never registered is the one that gets\n' +
  'filtered, and the campaign looks healthy the entire time.',
);
if (domains.has('camphawk.app')) {
  console.error('\n!! camphawk.app is in a LIVE SMS body. sendSms throws on our own domain — see sms.ts.');
  process.exit(1);
}

if (over > 0) {
  console.error(`\n!! ${over} message(s) exceed one segment. Two-segment alerts were undelivered.`);
  process.exit(1);
}
if (check) console.log('\nAll message bodies fit one segment.');
