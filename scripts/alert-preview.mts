/**
 * See what an alert actually says, without sending one.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/alert-preview.mts               # coming_soon
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/alert-preview.mts --kind=carted
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/alert-preview.mts --out=/tmp/alert.html
 *
 * WHY. Alert copy has been wrong in production repeatedly and each time it was only
 * discovered by receiving one: a mid-token cut ("(si."), a stay date rendered a day early,
 * "opens 8:15" meaning a cart hold rather than a release. The three channels also say
 * DIFFERENT things on purpose — SMS carries no camphawk.app link because carriers filter
 * it, push carries the hold offer because it is the channel most likely to be seen
 * overnight — so "read the email" does not tell you what the text said.
 *
 * Builds all three from the REAL dispatcher functions, so this cannot drift from what
 * ships. Nothing is sent and no database row is written.
 */
import { writeFileSync } from 'node:fs';
import {
  buildEmailHtml, pushBody, formatReleaseTime, type NotificationPayload,
} from '../src/lib/notifications';
import { smsBody } from '../src/lib/notifications/sms-body';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const kind = (arg('kind') ?? 'coming_soon') as NonNullable<NotificationPayload['kind']>;
const out = arg('out') ?? '/tmp/alert-preview.html';

// A real offer, matching the live one for 2026-08-09.
const payload: NotificationPayload = {
  userId: 'preview',
  watchId: 'preview',
  campgroundId: 'rc-611',
  campgroundName: 'Pfeiffer Big Sur SP — South Camp (sites 1-78)',
  availableDates: ['2026-09-04'],
  bookingUrl: 'https://www.reservecalifornia.com/park/690/611',
  campsiteName: '#SC29',
  campsiteId: '43745',
  startDate: '2026-09-04',
  endDate: '2026-09-05',
  kind,
  availableAt: '2026-08-09T08:00:00',
  holdUrl: 'https://camphawk.app/w/Jp4XhBaz',
};

const push = pushBody(payload);
const sms = smsBody({
  campgroundName: payload.campgroundName,
  campsiteName: payload.campsiteName,
  availableDates: payload.availableDates,
  bookingUrl: payload.bookingUrl,
  availableAt: payload.availableAt,
  kind,
  holdUrl: payload.holdUrl,
  formatReleaseTime,
});

console.log(`\n=== PUSH (kind=${kind}) ===`);
console.log(`  title: ${push.title}`);
console.log(`  body : ${push.body}`);
console.log(`\n=== SMS ===`);
console.log(`  ${sms}`);
console.log(`  ${sms.length} chars — ${sms.length <= 160 ? 'ONE segment' : 'TWO segments (over 160)'}`);

writeFileSync(out, buildEmailHtml(payload));
console.log(`\n=== EMAIL ===\n  written to ${out}\n`);
