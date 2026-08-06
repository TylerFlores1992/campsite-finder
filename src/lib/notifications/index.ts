import { query, mutate } from '@/lib/db/client';
import { sendEmail } from './email';
import { sendSms } from './sms';
import { sendPush } from './push';
import { actionUrlFor } from './actions';
import { fitOneSegment } from './sms-fit';
import { formatStayDates } from './dates';
import type { CampflareWebhookPayload } from '@/lib/campflare/types';
import { USEDIRECT_PROVIDERS } from '@/lib/sources/reservecalifornia/providers';
import { GOINGTOCAMP_PROVIDERS } from '@/lib/sources/goingtocamp/providers';
import { TNSC_PROVIDERS } from '@/lib/sources/tnsc/providers';

/** Human label for the booking provider, from the booking URL (registry-driven). */
function providerLabel(bookingUrl: string): string {
  if (bookingUrl.includes('recreation.gov')) return 'Recreation.gov';
  if (bookingUrl.includes('reserveamerica')) return 'ReserveAmerica';
  const gtc = GOINGTOCAMP_PROVIDERS.find((pr) => bookingUrl.includes(pr.host));
  if (gtc) return gtc.name;
  const tnsc = TNSC_PROVIDERS.find((pr) => bookingUrl.includes(pr.host));
  if (tnsc) return tnsc.name;
  const p = USEDIRECT_PROVIDERS.find((pr) => {
    try {
      return bookingUrl.includes(new URL(pr.parkUrl(0)).host);
    } catch {
      return false;
    }
  });
  return p?.name ?? 'the reservation site';
}

export interface NotificationPayload {
  userId: string;
  watchId: string;
  campgroundId: string;
  campgroundName: string;
  availableDates: string[];
  bookingUrl: string;
  /** Specific site name/number, when the detection path knows which site is open. */
  campsiteName?: string | null;
  /** Specific site id (rec.gov campsiteId / RC unitId) — the mute target + poller key.
   *  Present only for site-level sources; null for count-only (GoingToCamp, TN/SC). */
  campsiteId?: string | null;
  startDate: string;
  endDate: string;
  /** 'available' = bookable now (default). 'coming_soon' = ReserveCalifornia held
   *  a cancelled site that releases at `availableAt` — a heads-up before it's live.
   *  'carted' = the auto-cart bot already added this exact site to the user's
   *  recreation.gov cart — they just need to check out.
   *  'still_open' = the ONE follow-up, six hours after an alert, for a site that never
   *  closed. Same opening, not a new one — and it must SAY so. Worded like a fresh
   *  alert it is indistinguishable from the hourly-repeat bug it replaces, and the
   *  user cannot tell "it opened again" from "it never closed". */
  kind?: 'available' | 'coming_soon' | 'carted' | 'still_open';
  /** For 'coming_soon': ISO-local release time (e.g. "2026-07-18T08:00:00"). */
  availableAt?: string | null;
}

/** Format an RC release timestamp (ISO local, no TZ) as e.g. "Sat, Jul 18, 8:00 AM PT".
 *  Parsed as literal wall-clock (RC times are Pacific) so the server's TZ never shifts it. */
function formatReleaseTime(iso?: string | null, short = false): string {
  const m = iso?.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return 'soon';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const opts: Intl.DateTimeFormatOptions = short
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' };
  return `${d.toLocaleString('en-US', opts)} PT`;
}

async function logNotification(
  payload: NotificationPayload,
  channel: string,
  status: 'sent' | 'failed',
  error?: string,
  /** Provider message id — the Twilio SID for SMS. This is the join key the delivery
   *  callback arrives with, so a row logged without it can never learn whether the
   *  text landed: the receipt comes back and matches nothing. */
  providerId?: string | null
): Promise<void> {
  await mutate(
    `INSERT INTO notifications (user_id, watch_id, campground_id, channel, status, payload, error, provider_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      payload.userId,
      payload.watchId,
      payload.campgroundId,
      channel,
      status,
      JSON.stringify(payload),
      error ?? null,
      providerId ?? null,
    ]
  ).catch((err) => console.error('[notifications] Failed to log:', err));
}

/** Get the user's email from the DB (stored as the user id for v1 anonymous users,
 *  or as a real email once proper auth is added).
 *
 *  Returns null when the user has opted OUT of email alerts (migration 034 — the
 *  choice is offered at sign-up). The column defaults to true and every pre-034
 *  account was backfilled true, so this can only suppress an address whose owner
 *  deliberately unticked the box. Canary and transactional mail do not come through
 *  here, so an opt-out cannot blind the alert-health canary. */
async function getUserEmail(userId: string): Promise<string | null> {
  const rows = await query<{ email: string; email_alerts_opt_in: boolean }>(
    'SELECT email, email_alerts_opt_in FROM users WHERE id = $1',
    [userId]
  );
  const email = rows[0]?.email;
  // Skip anonymous IDs (UUIDs stored as email placeholder in v1)
  if (!email || email === userId) return null;
  if (rows[0]?.email_alerts_opt_in === false) return null;
  return email;
}

/** Get the user's phone (E.164) from the DB, or null if not on file. */
async function getUserPhone(userId: string): Promise<string | null> {
  const rows = await query<{ phone: string | null }>(
    'SELECT phone FROM users WHERE id = $1',
    [userId]
  );
  return rows[0]?.phone ?? null;
}

/** Fire all applicable notification channels for a campflare availability event. */
/** One-tap action links for an alert: always Stop; Mute-site when we know the site. */
interface ActionLinks {
  stopUrl: string | null;
  muteUrl: string | null;
  siteName: string | null;
}

async function mintActionLinks(payload: NotificationPayload): Promise<ActionLinks> {
  const [stopUrl, muteUrl] = await Promise.all([
    actionUrlFor(payload.watchId, 'stop'),
    payload.campsiteId ? actionUrlFor(payload.watchId, 'mute_site', payload.campsiteId) : Promise.resolve(null),
  ]);
  return { stopUrl, muteUrl, siteName: payload.campsiteName ?? payload.campsiteId ?? null };
}

export async function dispatchNotifications(payload: NotificationPayload): Promise<void> {
  console.log(
    `[notifications] Dispatching for watch ${payload.watchId}: ${payload.availableDates.length} dates open at ${payload.campgroundName}`
  );

  const links = await mintActionLinks(payload);

  const [emailResult, smsResult, pushResult] = await Promise.allSettled([
    dispatchEmail(payload, links),
    dispatchSms(payload),
    dispatchPush(payload),
  ]);

  if (emailResult.status === 'rejected') {
    console.error('[notifications] Email failed:', emailResult.reason);
  }
  if (smsResult.status === 'rejected') {
    console.error('[notifications] SMS failed:', smsResult.reason);
  }
  if (pushResult.status === 'rejected') {
    console.error('[notifications] Push failed:', pushResult.reason);
  }
}

/** Small "manage this watch" footer appended to every alert email. */
function actionFooterHtml(links: ActionLinks): string {
  const parts: string[] = [];
  if (links.muteUrl && links.siteName) {
    parts.push(`<a href="${links.muteUrl}" style="color:#6b7280">Mute site ${links.siteName}</a> (keep hearing about other sites)`);
  }
  if (links.stopUrl) {
    parts.push(`<a href="${links.stopUrl}" style="color:#6b7280">Stop watching this campground</a>`);
  }
  if (parts.length === 0) return '';
  return `<p style="margin-top:24px;font-size:12px;color:#9ca3af;border-top:1px solid #eee;padding-top:12px">${parts.join(' &nbsp;·&nbsp; ')}</p>`;
}

async function dispatchEmail(payload: NotificationPayload, links: ActionLinks): Promise<void> {
  const email = await getUserEmail(payload.userId);
  if (!email) return; // no email on file yet (v1 anonymous users)

  const comingSoon = payload.kind === 'coming_soon';
  const carted = payload.kind === 'carted';
  try {
    await sendEmail({
      to: email,
      subject: carted
        ? `✅ In your cart: ${payload.campgroundName} — check out now`
        : comingSoon
          ? `⏳ Opening soon: ${payload.campgroundName}`
          : payload.kind === 'still_open'
            // Distinct subject on purpose: in a mailbox, an identical one six hours
            // later just looks like we sent the same alert twice.
            ? `⛺ Still available: ${payload.campgroundName}`
            : `⛺ Campsite available: ${payload.campgroundName}`,
      html: buildEmailHtml(payload).replace('</body>', `${actionFooterHtml(links)}</body>`),
    });
    await logNotification(payload, 'email', 'sent');
  } catch (err) {
    await logNotification(payload, 'email', 'failed', (err as Error).message);
    throw err;
  }
}

async function dispatchSms(payload: NotificationPayload): Promise<void> {
  if (!process.env.TWILIO_ACCOUNT_SID) return;

  const phone = await getUserPhone(payload.userId);
  if (!phone) return; // no phone on file — email-only user

  // URLs keep their `https://` scheme so every SMS client renders them as tappable
  // links. We previously stripped the scheme to save 8 chars/link and stay in one
  // segment, relying on clients to auto-linkify the bare domain — but that's
  // unreliable (a bare `camphawk.app/…` with a path is NOT linkified on many
  // Android/RCS clients), so alerts arrived with dead links. Clickability wins; the
  // extra scheme may spill a link-heavy alert into a second segment, which is a fine
  // trade for a working CTA. The long booking URL is still routed through a short
  // camphawk.app/b/<token> redirect. The per-message "Reply STOP" is dropped — the
  // Twilio Messaging Service's Advanced Opt-Out handles STOP/HELP.
  //
  // THE "Manage:" LINK IS GONE FROM SMS (2026-08-05), and it is not a tidy-up.
  //
  // It used to be here because collapsing the old Mute/Stop pair into one manage link
  // read better and did more. Then delivery receipts (migration 038) showed what it
  // actually cost: with both a Book: and a Manage: link an alert ran ~186 characters —
  // TWO segments — and in Twilio's log every 2-segment message to our subscribers came
  // back Undelivered with error 30007, while every 1-segment one was Delivered. The
  // auto-cart texts kept arriving precisely because they carry one short
  // recreation.gov link and nothing else. Dropping this line takes an alert to ~131
  // characters and one segment.
  //
  // The link is not lost: the email footer still carries it, and the app has the same
  // page. A manage link in a text nobody receives is worth less than no manage link in
  // a text that arrives.
  //
  // See sms-fit.ts for the confound this does NOT resolve — every 2-segment message
  // also happens to carry a camphawk.app link, so if alerts still don't arrive after
  // this, the cause is the link DOMAIN and the fix is on the A2P 10DLC campaign.
  //
  // URLs keep their `https://` scheme so every SMS client renders them as tappable
  // links. We previously stripped the scheme to save 8 chars/link, relying on clients
  // to auto-linkify the bare domain — but that's unreliable (a bare `camphawk.app/…`
  // with a path is NOT linkified on many Android/RCS clients), so alerts arrived with
  // dead links. Clickability wins. The per-message "Reply STOP" is dropped too — the
  // Twilio Messaging Service's Advanced Opt-Out handles STOP/HELP.
  const site = payload.campsiteName ? ` Site ${payload.campsiteName}` : '';
  const name = payload.campgroundName.replace(/\s+(campground|cg)\.?$/i, '');

  try {
    let body: string;
    if (payload.kind === 'carted') {
      // Already one segment and already arriving. Left exactly as it was — this is the
      // control in the experiment, and changing it would throw that away.
      body = `CampHawk: ${name}${site} is in your cart — check out now, held ~15 min: https://www.recreation.gov/cart`;
    } else if (payload.kind === 'coming_soon') {
      const when = formatReleaseTime(payload.availableAt, true);
      body = fitOneSegment(
        (n) => `CampHawk: ${n}${site} was just cancelled, opens ${when}. We'll text when it's bookable.`,
        name
      );
    } else {
      // "Sep 4-6", not "2026-09-04, 2026-09-05, 2026-09-06". Three ISO dates in a row
      // read as timestamps, cost ~24 characters of a 160-character budget, and — in the
      // same thread as a "coming soon" text that says "opens Aug 6, 8:15 AM PT" — made
      // the owner read stay nights as a release date. See notifications/dates.ts.
      const dates = formatStayDates(payload.availableDates);
      // THE PROVIDER'S OWN URL, NOT OUR `camphawk.app/b/<token>` SHORTLINK (2026-08-05).
      //
      // OBSERVED, on one handset, same segment count: a `recreation.gov` link →
      // Delivered. No link at all → Delivered. `camphawk.app/b/<token>` → Undelivered
      // with 30007 ("message filtered"), 10 for 10. Our A2P 10DLC campaign's registered
      // sample messages — written 7/7/2026, never changed — link to
      // `recreation.gov/camping/campgrounds/[ID]` and `reservecalifornia.com/park/[ID]`;
      // the shortlink went into the code later and appears in no sample.
      //
      // WHY the carrier dislikes it is INFERENCE, not documentation, and the two
      // candidates matter differently:
      //   - T-Mobile's Code of Conduct has sections "4.8 URL Redirects/Forwarding" and
      //     "3.3 Use One Recognizable Domain Name", and Twilio's campaign-troubleshooting
      //     page requires "a dedicated, branded short domain that belongs to your
      //     business". `/b/<token>` is a redirect that hides its destination, which fits.
      //   - That a short opaque PATH on a legitimately-owned domain is itself a trigger
      //     is NOT documented anywhere. Don't repeat it as fact.
      // There is also no "declared link domain" to have gotten wrong: Twilio's campaign
      // API exposes only the boolean `HasEmbeddedLinks` (ours is correctly true) and
      // `MessageSamples`. So "undeclared domain" is not the mechanism either.
      //
      // Either way this line sidesteps the question: the provider's own URL is a
      // well-known destination with no redirect, and it is what the samples show. It
      // costs almost nothing — a real booking URL is 45-49 characters against the
      // shortlink's ~39 — and the fragment is stripped because the #camphawk extension
      // hint does nothing on a phone.
      //
      // `/b/<token>` STAYS ALIVE for links already sent; we simply stop minting new
      // ones for SMS, which was their only consumer. Email uses the full URL already.
      //
      // Do not "improve" this back into a tracked shortlink. The campaign's samples and
      // HasEmbeddedLinks are NOT editable after approval — matching a new link shape
      // would mean registering a NEW campaign — and the tracking is worth less than the
      // message arriving.
      const bookTxt = payload.bookingUrl.split('#')[0];
      // A long campground name plus three dates can still clear 160 on its own, and an
      // alert that quietly goes back to two segments would look like the fix failing.
      // "STILL open" is the whole point of the follow-up: six hours on, a text worded
      // like the first one reads as a duplicate, which is the complaint that produced
      // this feature in the first place.
      // "open FOR Sep 4-6" — the preposition is doing real work. "open Sep 4-6" was
      // read as "opens on Sep 4", because the neighbouring coming-soon text uses
      // "opens <date>" to mean exactly that.
      const lead = payload.kind === 'still_open' ? 'STILL open for' : 'open for';
      body = fitOneSegment(
        (n) => `CampHawk: ${n}${site} ${lead} ${dates}. Book: ${bookTxt}`,
        name
      );
    }
    // `sent` here still means only "Twilio accepted it" — the row is completed later
    // by /api/webhooks/twilio, matched on this SID. Without the SID the receipt has
    // nothing to write to, so this is the one place the whole feature hinges on.
    const { sid } = await sendSms({ to: phone, body });
    await logNotification(payload, 'sms', 'sent', undefined, sid);
  } catch (err) {
    await logNotification(payload, 'sms', 'failed', (err as Error).message);
  }
}

/** Fetch a user's registered push tokens (native app devices). */
async function getUserPushTokens(userId: string): Promise<string[]> {
  const rows = await query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1',
    [userId]
  );
  return rows.map((r) => r.token);
}

async function dispatchPush(payload: NotificationPayload): Promise<void> {
  const tokens = await getUserPushTokens(payload.userId);
  if (tokens.length === 0) return; // no app installs for this user

  const name = payload.campgroundName.replace(/\s+(campground|cg)\.?$/i, '');
  const site = payload.campsiteName ? ` — Site ${payload.campsiteName}` : '';

  let title: string;
  let body: string;
  if (payload.kind === 'carted') {
    title = `✅ In your cart: ${name}`;
    body = `${name}${site} is in your cart — check out now (held ~15 min).`;
  } else if (payload.kind === 'coming_soon') {
    title = `⏳ Opening soon: ${name}`;
    body = `${name}${site} was just cancelled — we'll alert you when it's bookable.`;
  } else if (payload.kind === 'still_open') {
    const dates = formatStayDates(payload.availableDates);
    title = `⛺ Still available: ${name}`;
    body = `${name}${site} is still open for ${dates}. Tap to book.`;
  } else {
    const dates = formatStayDates(payload.availableDates);
    title = `⛺ Available: ${name}`;
    body = `${name}${site} open for ${dates}. Tap to book.`;
  }

  // Deep-link the app to the watch/campground; strip the extension-only #camphawk hint.
  const data: Record<string, string> = {
    watchId: payload.watchId,
    campgroundId: payload.campgroundId,
    kind: payload.kind ?? 'available',
    url: payload.bookingUrl.split('#')[0],
  };

  try {
    const result = await sendPush({ tokens, title, body, data });
    // RECORD WHAT ACTUALLY HAPPENED. This logged 'sent' unconditionally, ignoring
    // result.sent — so an unconfigured FCM (sendPush returns {sent:0} and logs a
    // line nobody reads) or a batch where every token was dead both went into the
    // table as a successful send. On 2026-08-01 that cost a real debugging session:
    // the notifications table said push was delivered while a device sat there with
    // nothing on its lock screen, and the one place that could have said otherwise
    // was asserting success. Same family as the unsigned-APK green build.
    const status = result.sent > 0 ? 'sent' : 'failed';
    const detail =
      result.sent > 0
        ? undefined
        : `FCM accepted 0 of ${tokens.length} token(s)` +
          (result.deadTokens.length ? ` (${result.deadTokens.length} dead)` : '');
    console.log(
      `[push] ${payload.campgroundName}: ${result.sent}/${tokens.length} token(s) accepted` +
        (result.deadTokens.length ? `, ${result.deadTokens.length} dead` : '')
    );
    await logNotification(payload, 'push', status, detail);
    // Prune tokens FCM reported as permanently dead, so we stop delivering to them.
    if (result.deadTokens.length > 0) {
      await mutate(
        'DELETE FROM push_tokens WHERE token = ANY($1)',
        [result.deadTokens]
      ).catch((err) => console.error('[push] failed to prune dead tokens:', err));
    }
  } catch (err) {
    await logNotification(payload, 'push', 'failed', (err as Error).message);
    throw err;
  }
}

function buildEmailHtml(payload: NotificationPayload): string {
  const dateList = payload.availableDates
    .map((d) => `<li style="margin:4px 0">${d}</li>`)
    .join('');
  const provider = providerLabel(payload.bookingUrl);
  const siteSuffix = payload.campsiteName ? ` — Site ${payload.campsiteName}` : '';
  const comingSoon = payload.kind === 'coming_soon';

  // Auto-cart success: we already added this exact site to the user's rec.gov
  // cart — the only thing left is to check out before the ~15-minute hold lapses.
  if (payload.kind === 'carted') {
    return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="color:#16a34a;margin-bottom:4px">✅ It's in your cart — check out now</h2>
  <p style="margin-top:0;color:#555">CampHawk caught a cancellation and added it straight to your recreation.gov cart. Recreation.gov only holds a cart for about <strong>15 minutes</strong>, so finish checkout right away.</p>

  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 8px">${payload.campgroundName}${siteSuffix}</h3>
    <p style="margin:0;color:#555">
      <strong>${payload.startDate}</strong> → <strong>${payload.endDate}</strong>
    </p>
  </div>

  <a href="https://www.recreation.gov/cart"
     style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">
    Check out on Recreation.gov →
  </a>

  <p style="margin-top:16px;color:#555">Signed in on your phone? The cart is tied to your account, so it's already waiting there too.</p>

  <p style="margin-top:32px;font-size:12px;color:#999">
    You're receiving this because you set up a watch on CampHawk with auto-cart on.
    <br>To stop watching this campground, visit your watches in the app.
  </p>
</body>
</html>`;
  }

  // Coming-soon (ReserveCalifornia held cancellation): heads-up, not "book now".
  if (comingSoon) {
    const releaseAt = formatReleaseTime(payload.availableAt);
    return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="color:#d97706;margin-bottom:4px">⏳ A site is opening up soon</h2>
  <p style="margin-top:0;color:#555">A site you're watching was just cancelled. ReserveCalifornia holds cancelled sites for a bit before releasing them — this one becomes bookable soon.</p>

  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 8px">${payload.campgroundName}${siteSuffix}</h3>
    <p style="margin:0 0 12px;color:#555">
      Your watch: <strong>${payload.startDate}</strong> → <strong>${payload.endDate}</strong>
    </p>
    <p style="margin:0;font-size:18px;font-weight:700;color:#b45309">
      Becomes bookable: ${releaseAt}
    </p>
  </div>

  <p style="color:#555">We'll email and text you the moment it's actually available. Cancelled sites get snapped up fast at release time, so be ready.</p>

  <a href="${payload.bookingUrl}"
     style="display:inline-block;background:#d97706;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">
    See it on ${provider} →
  </a>

  <p style="margin-top:32px;font-size:12px;color:#999">
    You're receiving this because you set up a watch on CampHawk.
    <br>To stop watching this campground, visit your watches in the app.
  </p>
</body>
</html>`;
  }

  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="color:#16a34a;margin-bottom:4px">${payload.kind === 'still_open' ? '⛺ Still available' : '⛺ Campsite Available!'}</h2>
  <p style="margin-top:0;color:#555">${
    payload.kind === 'still_open'
      // Say plainly that this is a follow-up and that there will be no more. Otherwise
      // the reader's question is "why am I getting this again?", and the honest answer
      // — "in case you missed the first one" — is worth one sentence.
      ? "We told you about this one a few hours ago and it's <strong>still open</strong> — sending once more in case that alert didn't reach you. This is the only reminder you'll get for this opening."
      : "A cancellation opened up at a campground you're watching."
  }</p>

  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 8px">${payload.campgroundName}${siteSuffix}</h3>
    <p style="margin:0 0 12px;color:#555">
      Your watch: <strong>${payload.startDate}</strong> → <strong>${payload.endDate}</strong>
    </p>
    <p style="margin:0 0 8px;font-weight:600">Available dates:</p>
    <ul style="margin:0;padding-left:20px">${dateList}</ul>
  </div>

  <p style="color:#ef4444;font-weight:600">⏱ Cancellations go fast — book as soon as you can before someone else grabs it.</p>

  <a href="${payload.bookingUrl}"
     style="display:inline-block;background:#16a34a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">
    ${payload.campsiteName ? 'View Site & Book →' : `Book Now on ${provider} →`}
  </a>

  <p style="margin-top:32px;font-size:12px;color:#999">
    You're receiving this because you set up a watch on CampHawk.
    <br>To stop watching this campground, visit your watches in the app.
  </p>
</body>
</html>`;
}

/** Build a NotificationPayload from a Campflare webhook event + DB watch record. */
export async function buildPayloadFromWebhook(
  event: CampflareWebhookPayload,
  watch: {
    id: string;
    user_id: string;
    campground_id: string;
    start_date: string;
    end_date: string;
  }
): Promise<NotificationPayload> {
  const startingDate = event.date_range.starting_date;
  const dates = Array.from({ length: event.date_range.nights }, (_, i) => {
    const d = new Date(startingDate);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  return {
    userId: watch.user_id,
    watchId: watch.id,
    campgroundId: watch.campground_id,
    campgroundName: event.campground_name,
    availableDates: dates,
    bookingUrl:
      event.reservation_url || `https://www.recreation.gov/camping/campgrounds/${watch.campground_id}`,
    campsiteName: event.campsite_name || null,
    startDate: watch.start_date,
    endDate: watch.end_date,
  };
}
