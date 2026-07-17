import { query, mutate } from '@/lib/db/client';
import { sendEmail } from './email';
import { sendSms } from './sms';
import type { CampflareWebhookPayload } from '@/lib/campflare/types';

export interface NotificationPayload {
  userId: string;
  watchId: string;
  campgroundId: string;
  campgroundName: string;
  availableDates: string[];
  bookingUrl: string;
  /** Specific site name/number, when the detection path knows which site is open. */
  campsiteName?: string | null;
  startDate: string;
  endDate: string;
  /** 'available' = bookable now (default). 'coming_soon' = ReserveCalifornia held
   *  a cancelled site that releases at `availableAt` — a heads-up before it's live. */
  kind?: 'available' | 'coming_soon';
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
export async function dispatchNotifications(payload: NotificationPayload): Promise<void> {
  console.log(
    `[notifications] Dispatching for watch ${payload.watchId}: ${payload.availableDates.length} dates open at ${payload.campgroundName}`
  );

  const [emailResult, smsResult] = await Promise.allSettled([
    dispatchEmail(payload),
    dispatchSms(payload),
  ]);

  if (emailResult.status === 'rejected') {
    console.error('[notifications] Email failed:', emailResult.reason);
  }
  if (smsResult.status === 'rejected') {
    console.error('[notifications] SMS failed:', smsResult.reason);
  }
}

async function dispatchEmail(payload: NotificationPayload): Promise<void> {
  const email = await getUserEmail(payload.userId);
  if (!email) return; // no email on file yet (v1 anonymous users)

  const comingSoon = payload.kind === 'coming_soon';
  try {
    await sendEmail({
      to: email,
      subject: comingSoon
        ? `⏳ Opening soon: ${payload.campgroundName}`
        : `⛺ Campsite available: ${payload.campgroundName}`,
      html: buildEmailHtml(payload),
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

  try {
    const site = payload.campsiteName ? ` — Site ${payload.campsiteName}` : '';
    let body: string;
    if (payload.kind === 'coming_soon') {
      // ReserveCalifornia held a cancellation — heads-up before it's bookable.
      body = `CampHawk: ⏳ ${payload.campgroundName}${site} was just cancelled and opens up ${formatReleaseTime(payload.availableAt, true)}. We'll text you when it's bookable. Reply STOP to opt out.`;
    } else {
      const dates = payload.availableDates.slice(0, 3).join(', ');
      const more = payload.availableDates.length > 3 ? ` +${payload.availableDates.length - 3} more` : '';
      body = `CampHawk: ⛺ ${payload.campgroundName}${site} has availability: ${dates}${more}. Book now: ${payload.bookingUrl}. Reply STOP to opt out.`;
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
  const isRC = payload.bookingUrl.includes('reservecalifornia');
  const provider = isRC ? 'ReserveCalifornia' : 'Recreation.gov';
  const siteSuffix = payload.campsiteName ? ` — Site ${payload.campsiteName}` : '';
  const comingSoon = payload.kind === 'coming_soon';

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
