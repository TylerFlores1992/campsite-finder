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
 *   npx tsx scripts/a2p-samples.mts            # the samples, ready to paste
 *   npx tsx scripts/a2p-samples.mts --check    # exit 1 if any body is over one segment
 *
 * No credentials and no network: the bodies are built by the same pure `smsBody()` the
 * dispatcher uses. It CANNOT read the live campaign — Twilio's keys are Vercel
 * "sensitive" vars, which the API never returns — so comparing against what is
 * registered is a human step in the Console.
 */
import { smsBody, type SmsBodyInput } from '../src/lib/notifications/sms-body';
import { SMS_ONE_SEGMENT } from '../src/lib/notifications/sms-fit';

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

const check = process.argv.includes('--check');
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

console.log('\n=== Link domains that appear in live SMS ===');
for (const d of [...domains].sort()) console.log(`  ${d}`);
console.log(
  '\nEVERY domain above must appear in the campaign\'s registered samples. That is the\n' +
  'whole failure mode: a domain we send but never registered is the one that gets\n' +
  'filtered, and the campaign looks healthy the entire time.',
);
if (domains.has('camphawk.app')) {
  console.error('\n!! camphawk.app is in an SMS body. sendSms throws on our own domain — see sms.ts.');
  process.exit(1);
}

if (over > 0) {
  console.error(`\n!! ${over} message(s) exceed one segment. Two-segment alerts were undelivered.`);
  process.exit(1);
}
if (check) console.log('\nAll message bodies fit one segment.');
