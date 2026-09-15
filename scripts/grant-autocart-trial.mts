/**
 * Comp somebody the auto-cart lane until a date, then have it lapse by itself.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/grant-autocart-trial.mts --email=x@y.com --until=2026-09-28
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/grant-autocart-trial.mts --email=x@y.com --revoke
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/grant-autocart-trial.mts --email=x@y.com          # read only
 *
 * A SCRIPT AND NOT AN ADMIN BUTTON, deliberately. This hands out a paid capability, it will
 * be used a handful of times a year, and a button is a thing that gets clicked by accident on
 * a phone. A command that has to be typed with an explicit date is the right amount of
 * friction for something nobody should do casually.
 *
 * ## IT TAKES A DATE, NEVER A NUMBER OF DAYS
 *
 * The obvious interface is `--days=7`, and the first real case is exactly why it is not: a
 * seven-day comp granted on 2026-09-15 expires on the 22nd, and the trip it was meant to
 * prove the product on was the 24th to the 27th. The gift would have run out two days before
 * the weekend it existed for, and a duration hides that. A date makes the caller look at a
 * calendar and at the user's own watch dates.
 *
 * ## WHAT IT DOES NOT TOUCH
 *
 * Stripe, the tier, the trial end, `is_beta`, and `hasActiveSubscription`. This grants the
 * auto-cart LANE and nothing else — so it cannot change what anybody is billed, and revoking
 * is one statement that returns the account to exactly what it was. It also does NOT grant
 * the right to create watches: the comp is a demonstration, not a free plan.
 *
 * ## IT PRINTS WHAT THE GRANT WILL AND WILL NOT DO
 *
 * Auto-cart on Recreation.gov needs the user to have connected their rec.gov account, and
 * that is a step only they can take. Granting the entitlement to somebody with
 * `autocart_connected = false` gives them a switch that does nothing until they do — so the
 * script says so, rather than reporting a success that is not yet one. Same rule as every
 * other readout here: a thing that could not act must not read as a thing that acted.
 */
import { query, mutate } from '../src/lib/db/client';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const has = (n: string) => process.argv.includes(`--${n}`);

const email = arg('email');
const until = arg('until');
const revoke = has('revoke');

if (!email) {
  console.error('--email=<address> is required');
  process.exit(1);
}

const [user] = await query<{
  id: string; email: string; autocart_trial_until: string | null;
  autocart_connected: boolean; autocart_enabled: boolean; is_beta: boolean;
}>(
  `SELECT id, email, autocart_trial_until::text, autocart_connected, autocart_enabled, is_beta
     FROM users WHERE lower(email) = lower($1)`,
  [email],
);

if (!user) {
  console.error(`No account with that email. Nothing was changed.`);
  process.exit(1);
}

console.log(`\n${user.email}  (${user.id})`);
console.log(`  auto-cart grant : ${user.autocart_trial_until ?? 'none'}`);
console.log(`  rec.gov linked  : ${user.autocart_connected ? 'yes' : 'NO'}`);
console.log(`  their switch    : ${user.autocart_enabled ? 'on' : 'off'}`);

if (revoke) {
  await mutate(`UPDATE users SET autocart_trial_until = NULL, updated_at = NOW() WHERE id = $1`, [user.id]);
  console.log(`\nRevoked. The account is exactly as it was — nothing about billing changed.\n`);
  process.exit(0);
}

if (!until) {
  console.log(`\nRead-only. Pass --until=YYYY-MM-DD to grant, or --revoke to take it back.\n`);
  process.exit(0);
}

// A DATE, VALIDATED BY ROUND TRIP. `Date.parse` accepts 2026-02-31 and silently rolls it to
// March 3rd — a grant that quietly runs to a different day than the one that was typed. The
// same check `lib/watch-dates` uses, and for the same reason.
if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
  console.error(`--until must be YYYY-MM-DD. Nothing was changed.`);
  process.exit(1);
}
// End of that day in Pacific, which is how anybody reading it will mean it. 07:00Z the
// following morning is 00:00 PDT; the point is that "until the 28th" includes the 28th
// rather than expiring at midnight as it begins.
const expires = new Date(`${until}T23:59:59-07:00`);
if (expires.toISOString().slice(0, 10) < until) {
  console.error(`${until} is not a real date. Nothing was changed.`);
  process.exit(1);
}
if (expires.getTime() <= Date.now()) {
  console.error(`${until} is in the past, so the grant would be inert. Nothing was changed.`);
  process.exit(1);
}

await mutate(
  `UPDATE users SET autocart_trial_until = $1::timestamptz, updated_at = NOW() WHERE id = $2`,
  [expires.toISOString(), user.id],
);

const [after] = await query<{ autocart_trial_until: string; entitled: boolean }>(
  `SELECT u.autocart_trial_until::text,
          (u.autocart_trial_until > NOW()) AS entitled
     FROM users u WHERE u.id = $1`,
  [user.id],
);

console.log(`\nGranted until ${after.autocart_trial_until}  (entitled now: ${after.entitled})`);
console.log(`It lapses on its own — there is nothing to run afterwards, and billing is untouched.`);

// THE HONEST CAVEAT, PRINTED EVERY TIME IT APPLIES. Auto-cart on Recreation.gov cannot do
// anything for an account that has not linked rec.gov, and only the user can do that. Saying
// "granted" without this would report a success that has not happened yet.
if (!user.autocart_connected) {
  console.log(
    `\n⚠ THIS ACCOUNT HAS NOT LINKED RECREATION.GOV, so the grant gives them a switch that\n` +
      `  does nothing until they do. Auto-cart signs into THEIR rec.gov account; nobody else\n` +
      `  can complete that step. Tell them, or the comp expires without ever having run.`,
  );
}
if (!user.autocart_enabled) {
  console.log(`\n  Their own auto-cart switch is also off — Settings → Auto-cart → Turn on.`);
}
console.log('');
process.exit(0);
