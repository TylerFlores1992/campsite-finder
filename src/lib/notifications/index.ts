import { query, mutate } from '@/lib/db/client';
import { sendEmail } from './email';
import { sendSms } from './sms';
import { sendPush } from './push';
import { actionUrlFor } from './actions';
import { formatStayDates } from './dates';
import { smsBody } from './sms-body';
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
  /** The one-tap CampHawk URL for this alert: "hold it for me" on a 'coming_soon',
   *  "claim it" on a 'carted' RC hold. Present only when we can actually act on it — a
   *  specific RC unit with a known release time, for an entitled subscriber.
   *
   *  EMAIL AND PUSH, NEVER SMS. It is a camphawk.app link and those are filtered from
   *  texts (30007, measured 10 for 10 — see sendSms, which throws on our own domain).
   *  Push has no such limit and is the channel most likely to be seen, since these land
   *  overnight for an 8am release. The SMS says what happened and points at the two
   *  channels that can carry the action. */
  holdUrl?: string | null;
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
      subject: carted && payload.holdUrl
        ? `🔒 Held for you: ${payload.campgroundName} — claim it`
        : carted
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
  try {
    // Every body is built by `smsBody` in sms-body.ts — pure, no DB, no network — so
    // `scripts/a2p-samples.mts` can print exactly what we send. That script exists
    // because the A2P campaign's registered samples and this code silently drifted
    // apart once already, and every alert was filtered for it.
    const body = smsBody({
      kind: payload.kind,
      campgroundName: payload.campgroundName,
      campsiteName: payload.campsiteName,
      availableDates: payload.availableDates,
      bookingUrl: payload.bookingUrl,
      availableAt: payload.availableAt,
      holdUrl: payload.holdUrl,
      formatReleaseTime,
    });
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
  if (payload.kind === 'carted' && payload.holdUrl) {
    title = `🔒 Held for you: ${name}`;
    body = `${name}${site} is held. Tap to claim it — we let go the moment you do.`;
  } else if (payload.kind === 'carted') {
    title = `✅ In your cart: ${name}`;
    body = `${name}${site} is in your cart — check out now (held ~15 min).`;
  } else if (payload.kind === 'coming_soon' && payload.holdUrl) {
    // THE OFFER BELONGS HERE, not only in the email. SMS genuinely cannot carry it — a
    // camphawk.app link is filtered (30007, 10 for 10) — but push has no such limit, and
    // it is the channel most likely to be seen, since these alerts land overnight for an
    // 8am release. Leaving it out meant an offer with a deadline sat unread in an inbox.
    title = `⏳ Opening soon: ${name}`;
    body = `${name}${site} releases ${formatReleaseTime(payload.availableAt, true)}. Tap to have us hold it for you.`;
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
  // A hold URL WINS over the booking URL: when there is an action of ours to take —
  // "hold it for me", or "claim it" — sending the tap to the provider instead is sending
  // it to the one place that cannot do the thing the notification just offered.
  const data: Record<string, string> = {
    watchId: payload.watchId,
    campgroundId: payload.campgroundId,
    kind: payload.kind ?? 'available',
    url: (payload.holdUrl ?? payload.bookingUrl).split('#')[0],
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
  // An RC HOLD: the site is in CampHawk's cart, not theirs, and the whole email is one
  // button. The swap is the risky moment (~2.5s exposed), so the copy says so rather
  // than pretending it is instant — and says we only let go when they press.
  if (payload.kind === 'carted' && payload.holdUrl) {
    return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="color:#166534;margin-bottom:4px">🔒 We're holding it for you</h2>
  <p style="margin-top:0;color:#555">You asked us to grab this one at release time. It's held in CampHawk's cart — nobody else can take it while we have it.</p>

  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:20px 0">
    <h3 style="margin:0 0 8px">${payload.campgroundName}${siteSuffix}</h3>
    <p style="margin:0;color:#555"><strong>${payload.startDate}</strong> → <strong>${payload.endDate}</strong></p>
  </div>

  <!-- "Sign in FIRST" is the whole ballgame: the swap opens a ~2.5s window in which the
       site belongs to nobody, and a signed-out user spends it on RC's login form while
       someone else takes the site. The claim page makes them tick a box to confirm it
       before the button works; this says the same thing, so the instruction is not new
       information arriving at the riskiest moment. -->
  <p style="color:#555"><strong>Sign in to ReserveCalifornia first</strong> — the page will ask you to confirm you have. Then tap below: we let go and you take it. The swap takes a couple of seconds and the site is open to anyone during it, so only tap when you're ready to finish.</p>

  <a href="${payload.holdUrl}"
     style="display:inline-block;background:#166534;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">
    Claim it now →
  </a>

  <p style="margin-top:16px;font-size:13px;color:#666">If you don't claim it, we release it automatically so another camper can have it.</p>
</body>
</html>`;
  }

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

  ${/* NO UPSELL IN THE `else` BRANCH, deliberately. holdUrl is absent for several
       reasons — not on the Auto-Cart plan, no specific unit, or the offer simply
       failed to record — and this template cannot tell them apart. Keying a "upgrade
       to hold it" pitch on a missing link would show it to paying Auto-Cart
       subscribers whenever an offer hiccuped, which is the same failure as telling a
       subscriber to subscribe: `unknown` must mean "don't nag", never "not
       subscribed". The upgrade path lives in Settings, where the answer is known. */ ''}
  ${payload.holdUrl ? `
  <p style="color:#555">Cancelled sites get snapped up within seconds of release. We can be waiting for this one — tap below and CampHawk will put it in a cart the moment it opens, then hand it to you.</p>

  <a href="${payload.holdUrl}"
     style="display:inline-block;background:#166534;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">
    Hold it for me →
  </a>
  <p style="margin-top:10px;font-size:12px;color:#999">Only if you tap. We never hold a site nobody asked for — that would take it off the market for another camper.</p>

  <p style="margin-top:20px;color:#555">Prefer to do it yourself? <a href="${payload.bookingUrl}" style="color:#d97706">See it on ${provider}</a> and be ready at ${releaseAt}.</p>
  ` : `
  <p style="color:#555">We'll email and text you the moment it's actually available. Cancelled sites get snapped up fast at release time, so be ready.</p>

  <a href="${payload.bookingUrl}"
     style="display:inline-block;background:#d97706;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">
    See it on ${provider} →
  </a>
  `}

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
