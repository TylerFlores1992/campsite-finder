import { query, mutate } from '@/lib/db/client';
import { sendEmail } from './email';
import { sendSms } from './sms';
import { actionUrlFor, mintBookingToken, bookLink, manageUrlFor } from './actions';
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
   *  recreation.gov cart — they just need to check out. */
  kind?: 'available' | 'coming_soon' | 'carted';
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
  error?: string
): Promise<void> {
  await mutate(
    `INSERT INTO notifications (user_id, watch_id, campground_id, channel, status, payload, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      payload.userId,
      payload.watchId,
      payload.campgroundId,
      channel,
      status,
      JSON.stringify(payload),
      error ?? null,
    ]
  ).catch((err) => console.error('[notifications] Failed to log:', err));
}

/** Get the user's email from the DB (stored as the user id for v1 anonymous users,
 *  or as a real email once proper auth is added). */
async function getUserEmail(userId: string): Promise<string | null> {
  const rows = await query<{ email: string }>(
    'SELECT email FROM users WHERE id = $1',
    [userId]
  );
  const email = rows[0]?.email;
  // Skip anonymous IDs (UUIDs stored as email placeholder in v1)
  if (!email || email === userId) return null;
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

  const [emailResult, smsResult] = await Promise.allSettled([
    dispatchEmail(payload, links),
    dispatchSms(payload),
  ]);

  if (emailResult.status === 'rejected') {
    console.error('[notifications] Email failed:', emailResult.reason);
  }
  if (smsResult.status === 'rejected') {
    console.error('[notifications] SMS failed:', smsResult.reason);
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
  // The separate Mute/Stop links are collapsed into ONE "Manage" link to the per-watch
  // manage page (pause/resume, alert history, per-site mute) — cleaner in the text and
  // more capable than two one-tap links. `links` still feeds the richer email footer.
  const site = payload.campsiteName ? ` Site ${payload.campsiteName}` : '';
  const name = payload.campgroundName.replace(/\s+(campground|cg)\.?$/i, '');
  const manageUrl = await manageUrlFor(payload.watchId);
  const manageTxt = manageUrl ? ` Manage: ${manageUrl}` : '';

  try {
    let body: string;
    if (payload.kind === 'carted') {
      body = `CampHawk: ${name}${site} is in your cart — check out now, held ~15 min: https://www.recreation.gov/cart`;
    } else if (payload.kind === 'coming_soon') {
      body = `CampHawk: ${name}${site} was just cancelled, opens ${formatReleaseTime(payload.availableAt, true)}. We'll text when it's bookable.${manageTxt}`;
    } else {
      const dates = payload.availableDates.slice(0, 3).join(', ');
      const more = payload.availableDates.length > 3 ? ` +${payload.availableDates.length - 3}` : '';
      // Short-link the booking URL (fragment stripped — the #camphawk extension hint
      // does nothing on a phone). Falls back to the full URL if minting fails.
      const full = payload.bookingUrl.split('#')[0];
      const tok = await mintBookingToken(payload.watchId, full, payload.campsiteId ?? null);
      const bookTxt = tok ? bookLink(tok) : full;
      body = `CampHawk: ${name}${site} open ${dates}${more}. Book: ${bookTxt}${manageTxt}`;
    }
    await sendSms({ to: phone, body });
    await logNotification(payload, 'sms', 'sent');
  } catch (err) {
    await logNotification(payload, 'sms', 'failed', (err as Error).message);
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
  <h2 style="color:#16a34a;margin-bottom:4px">⛺ Campsite Available!</h2>
  <p style="margin-top:0;color:#555">A cancellation opened up at a campground you're watching.</p>

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
