/**
 * WHICH LINK SHAPES ACTUALLY SURVIVE THE CARRIER? — measured, not argued.
 *
 *   npx tsx scripts/sms-link-test.mts                    # DRY RUN: prints what it would send
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/sms-link-test.mts --send
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/sms-link-test.mts --read   # receipts from the last run
 *
 * ## Why this exists
 *
 * We removed `camphawk.app` from every SMS on 2026-08-05 to stop losing texts, and it
 * worked: 27 sent / 13 undelivered that day, then 71 sent / 71 delivered over the next
 * week. But that was a STOPGAP. The alerts need to link back to our own site — managing a
 * watch, stopping alerts and claiming a hold only exist there — so the question is not
 * "does our domain get filtered" but **"which SHAPE of our link gets filtered"**, and that
 * has never been measured.
 *
 * ## The gap in the existing evidence, which is the whole point of this script
 *
 * Every filtered message carried `camphawk.app/b/<token>` — and `/b/` is a **302 redirect**.
 * T-Mobile's Code of Conduct §4.8 is literally "URL Redirects/Forwarding" and §3.3 is "Use
 * One Recognizable Domain Name". A destination-hiding redirect is the only DOCUMENTED
 * violation anywhere in this picture; "the carrier dislikes our domain" is inference.
 *
 * The discriminating experiment on 08-05 dropped the `Manage:` link and kept the `/b/` one
 * — still filtered — which is what proved it was not message length. It did NOT test a
 * plain, non-redirecting URL on our domain. **`camphawk.app/manage/<token>` may deliver
 * today with no campaign edit at all**, and that is a cheap thing to find out before
 * spending an A2P edit that re-triggers vetting on a campaign currently delivering 100%.
 *
 * ## Two deliberate departures from the production path
 *
 * 1. **It posts to Twilio directly instead of calling `sendSms`.** `sendSms` REFUSES any
 *    body containing an APP_HOST link — that guard is the regression detector that keeps
 *    anyone from quietly reintroducing the 08-05 bug, and it must stay absolute. Weakening
 *    it with a test flag would put a hole in the one thing standing between us and silently
 *    losing texts again. So the test carries its own send, and says so.
 *
 * 2. **Rows are written with `channel = 'sms_test'`, never `'sms'`.** The admin "Did the
 *    texts arrive?" panel counts `channel = 'sms'`, and this script deliberately sends
 *    messages we EXPECT some of to be filtered. Logging them as ordinary SMS would turn the
 *    regression detector red by running the experiment — an instrument that breaks when you
 *    use it. The Twilio webhook matches on `provider_id` with no channel filter, so the
 *    receipts still land and `--read` can see them.
 */
import { randomUUID } from 'node:crypto';
import { query, mutate } from '../src/lib/db/client.js';

const args = new Set(process.argv.slice(2));
const SEND = args.has('--send');
const READ = args.has('--read');
const WITH_REDIRECT = args.has('--with-redirect');

const APP = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');
/** The owner's handset — the same number the daily delivery canary already texts. */
const TO = process.env.SMS_TEST_TO || process.env.AUTOCART_ALARM_PHONE || '+18058235957';

type Variant = { key: string; note: string; body: (link: string | null) => string; link: string | null };

/**
 * A REAL manage link, minted by the production function, because a link scanner may FETCH
 * the URL and a 404 is not the thing we are trying to measure — a dead link could plausibly
 * be scored worse than a live one, which would contaminate the result.
 *
 * The `'manage'` action is used deliberately: it resolves to the watch's management PAGE.
 * State-changing actions (`stop`, `mute_site`) are NOT tested — a scanner following one of
 * those would stop or mute a real watch, and losing a user's alerts to measure a link shape
 * is not a trade worth making.
 */
async function manageLink(): Promise<string | null> {
  const rows = await query(`SELECT id FROM watches WHERE active = true ORDER BY created_at DESC LIMIT 1`);
  const id = (rows as { id: string }[])[0]?.id;
  if (!id) return null;
  // `manageUrlFor`, NOT `actionUrlFor`. The latter returns `/w/<token>` — the ONE-TAP
  // ACTION link — and a scanner following one of those acts on the watch. `manageUrlFor`
  // returns `/manage/<token>`, the page. Getting this backwards would have made the test
  // both dangerous and wrong: `/w/` is short and opaque, which is a third link shape, not
  // the plain-page shape this experiment exists to isolate.
  const { manageUrlFor } = await import('../src/lib/notifications/actions.js');
  return manageUrlFor(id);
}

function variants(link: string | null): Variant[] {
  const dates = 'Aug 16-18';
  const v: Variant[] = [
    {
      key: 'control-provider',
      note: 'provider link only — the shape we send today, known to deliver',
      link: 'https://www.recreation.gov/camping/campgrounds/232447',
      body: (l) => `CampHawk: Kirk Creek site 12 is open for ${dates}. Book: ${l}`,
    },
    {
      key: 'camphawk-root',
      note: 'bare domain, no path — isolates the DOMAIN from the path shape',
      link: APP,
      body: (l) => `CampHawk: Kirk Creek site 12 is open for ${dates}. Details: ${l}`,
    },
  ];
  if (link) {
    v.push({
      key: 'camphawk-page',
      note: 'THE UNTESTED ONE — a real page on our domain, no redirect',
      link,
      body: (l) => `CampHawk: Kirk Creek site 12 is open for ${dates}. Manage: ${l}`,
    });
  }
  if (WITH_REDIRECT) {
    v.push({
      key: 'camphawk-redirect',
      note: 'POSITIVE CONTROL — the 302 shape that WAS filtered 13/13 on 08-05',
      link: `${APP}/b/${randomUUID().replace(/-/g, '').slice(0, 22)}`,
      body: (l) => `CampHawk: Kirk Creek site 12 is open for ${dates}. Book: ${l}`,
    });
  }
  return v;
}

/** Same call `sendSms` makes internally — see the header for why this is not `sendSms`. */
async function twilioSend(body: string): Promise<{ sid: string | null; status: string | null; error?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const svc = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!accountSid || !authToken || (!from && !svc)) return { sid: null, status: null, error: 'Twilio not configured' };

  const form = new URLSearchParams({ To: TO, Body: body });
  if (svc) form.set('MessagingServiceSid', svc);
  else form.set('From', from!);
  // The receipt is the entire measurement — without the callback every row sits `queued`
  // forever and this script would report nothing rather than a result.
  form.set('StatusCallback', `${APP}/api/webhooks/twilio`);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const j = (await res.json().catch(() => null)) as { sid?: string; status?: string; message?: string } | null;
  if (!res.ok) return { sid: null, status: null, error: j?.message ?? `HTTP ${res.status}` };
  return { sid: j?.sid ?? null, status: j?.status ?? null };
}

async function readResults() {
  const rows = await query(
    `SELECT payload AS p, provider_id AS sid, delivery_status AS ds, delivery_error AS de, created_at AS at
       FROM notifications WHERE channel = 'sms_test' ORDER BY created_at DESC LIMIT 20`,
  );
  const list = rows as { p: unknown; sid: string; ds: string | null; de: string | null; at: string }[];
  if (!list.length) return console.log('No sms_test rows yet. Run with --send first.');
  console.log(`\n${'variant'.padEnd(20)} ${'sent'.padEnd(20)} ${'delivery'.padEnd(14)} error`);
  console.log('-'.repeat(72));
  for (const r of list) {
    const key = (r.p as { variant?: string })?.variant ?? '?';
    // `queued`/`accepted` is NOT delivery — the whole reason migration 038 exists.
    const ds = r.ds ?? 'no receipt yet';
    console.log(`${key.padEnd(20)} ${String(r.at).slice(0, 19).padEnd(20)} ${ds.padEnd(14)} ${r.de ?? ''}`);
  }
  console.log(
    '\nRead `undelivered` + 30007 as filtered. `delivered` is the carrier confirming receipt.\n' +
    '`no receipt yet` means the callback has not landed — wait a minute, it is not a result.\n',
  );
}

async function main() {
  if (READ) return readResults();

  const link = await manageLink().catch(() => null);
  const vs = variants(link);
  if (!link) console.log('! No active watch with a manage token — skipping the camphawk-page variant,\n  which is the one worth measuring.\n');

  console.log(`To: ${TO}`);
  console.log(`${vs.length} variant(s)${WITH_REDIRECT ? '' : '  (add --with-redirect for the known-bad positive control)'}\n`);
  for (const v of vs) {
    const body = v.body(v.link);
    console.log(`  ${v.key}  (${body.length} chars)`);
    console.log(`    ${v.note}`);
    console.log(`    ${body}\n`);
  }

  // CHECKED BEFORE ANYTHING IS PROMISED. The first version discovered the missing
  // credentials one variant at a time, after printing four messages it was about to send —
  // and then still printed "Sent." at the end. See the counter below for why that matters.
  const hasAuth = !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;
  const svcSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (SEND && !hasAuth) {
    console.log('*** CANNOT SEND: no Twilio credentials in this environment. ***');
    console.log('    Needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
    console.log('    Nothing was sent. Run this where those are set.');
    process.exitCode = 1;
    return;
  }

  // THE MESSAGING SERVICE IS NOT OPTIONAL FOR THIS EXPERIMENT, even though `sendSms` will
  // fall back to a bare From number. The A2P campaign — the registration whose samples this
  // whole question is about — hangs off the Messaging Service. Sending from a bare number
  // routes under different campaign context, so a "delivered" would say nothing about
  // whether our link shape survives the campaign we actually send under. An uninterpretable
  // result is worse than no result: it would be quoted later as evidence.
  if (SEND && !svcSid) {
    console.log('*** REFUSING: TWILIO_MESSAGING_SERVICE_SID is not set. ***');
    console.log('    A bare From number sends under different A2P campaign context, so the');
    console.log('    result would not be comparable to production and could not settle');
    console.log('    anything. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  if (!SEND) {
    console.log('DRY RUN — nothing sent. Re-run with --send to send these for real.');
    console.log('Each is one real SMS to the number above, and some are EXPECTED to be filtered.');
    return;
  }

  let sent = 0;
  for (const v of vs) {
    const body = v.body(v.link);
    const r = await twilioSend(body);
    if (r.error) { console.log(`  ✗ ${v.key}: ${r.error}`); continue; }
    await mutate(
      `INSERT INTO notifications (channel, status, provider_id, payload) VALUES ('sms_test', $1, $2, $3::jsonb)`,
      [r.sid ? 'sent' : 'failed', r.sid, JSON.stringify({ variant: v.key, body, link: v.link })],
    ).catch((e) => console.log(`  (row insert failed: ${(e as Error).message})`));
    sent++;
    console.log(`  → ${v.key}: ${r.sid ?? 'no sid'} (${r.status ?? '?'})`);
    // Spaced so a burst is not itself the variable being measured.
    await new Promise((s) => setTimeout(s, 4000));
  }
  // NEVER "Sent." UNCONDITIONALLY. The first version printed it after all four sends had
  // failed — the same defect as `rc-hold-runner --once` claiming "token accepted" above an
  // early return, and as `notifications.status = 'sent'` meaning only that Twilio returned
  // 2xx. A summary line must be a fact about what happened, not about what was attempted.
  if (sent === 0) {
    console.log(`\n*** NOTHING WAS SENT (0 of ${vs.length}). There is no result to read. ***`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nSent ${sent} of ${vs.length}. Twilio's status is \`queued\`/\`accepted\` — NOT delivery.`);
  if (sent < vs.length) console.log(`${vs.length - sent} variant(s) failed to send; those are missing from the comparison.`);
  console.log('Wait ~1 minute, then:  NODE_USE_ENV_PROXY=1 npx tsx scripts/sms-link-test.mts --read');
}

await main();
