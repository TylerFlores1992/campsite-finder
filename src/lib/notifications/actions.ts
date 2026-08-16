// One-tap alert actions (feature D). A short opaque token → an action on a watch,
// so alert links stay SMS-sized. Minted where alerts are built (poller, dead-man
// cron) and resolved by the public /w/<token> route.
import { randomBytes } from 'crypto';
import { query, mutate } from '@/lib/db/client';
import { sendEmail } from './email';
import { sendSms } from './sms';
import { twilioAccountSid } from './twilio-env';

export type WatchAction = 'stop' | 'reopen' | 'mute_site' | 'keep' | 'cancel' | 'book' | 'manage' | 'hold';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');

/**
 * ~8-char opaque token (48 bits). Short enough for SMS, wide enough to not collide.
 *
 * NEVER ENDS IN `-` OR `_`, AND THAT IS NOT COSMETIC.
 *
 * base64url's alphabet includes both, so 2 of 64 characters can land last — and a URL ending
 * in one is the classic linkification casualty. Chat clients, mail clients and SMS previewers
 * treat trailing punctuation as sentence punctuation rather than part of the link, so the
 * final character is silently dropped from the href while the visible text still looks right.
 * The token then fails to resolve and the user is told the link is no longer valid.
 *
 * Observed live on 2026-08-16: a claim link with `?t=HaPUjQd_` opened as `?t=HaPUjQd` and the
 * claim screen said "This link is no longer valid." Reproduced against production — the full
 * token answers 200 and the truncated one 404s — and measured across the table: 4 of 97 live
 * tokens ended in one of these, which is ~1 in 32 alert links arriving dead.
 *
 * That is worse than it sounds because of WHERE these travel. `manage`, `mute_site`, `stop`
 * and `cancel` ride the alert email; a `hold` claim link is tapped at 08:00 with a campsite on
 * a fifteen-minute fuse. A dead link there is indistinguishable to the user from the hold
 * having expired.
 *
 * Rejecting the ~3% of draws that end badly is cheaper than every alternative: it needs no
 * migration, no change to the resolvers, and **existing tokens keep working** — the ones
 * already in somebody's inbox are unaffected. Entropy is unchanged; this rejects a suffix,
 * not a character, so all 48 bits are still in play.
 *
 * EXPORTED FOR THE GUARD. The rule is a property of the OUTPUT, so the test drives this
 * function rather than a reconstruction of it — a rebuilt copy would assert the copy, and
 * the regex could be present and inverted while a diff still looked right.
 */
export function genToken(): string {
  for (;;) {
    const t = randomBytes(6).toString('base64url');
    if (!/[-_]$/.test(t)) return t;
  }
}

/** Full one-tap action URL for a token. */
export function actionLink(token: string): string {
  return `${APP_URL}/w/${token}`;
}

/** Full booking short-link for a token (302-redirects to the real booking URL). */
export function bookLink(token: string): string {
  return `${APP_URL}/b/${token}`;
}

/** Full per-watch manage-page URL for a token (resolved by the public /manage/<token> route). */
export function manageLink(token: string): string {
  return `${APP_URL}/manage/${token}`;
}

/** Get (or create) the stable manage token for a watch, and return its full URL. */
export async function manageUrlFor(watchId: string): Promise<string | null> {
  const t = await mintActionToken(watchId, 'manage');
  return t ? manageLink(t) : null;
}

/** The bare manage token. The redesign builds its own in-app path from this
 *  rather than following manage_url, which points at the old /manage page —
 *  a Manage button that drops you into the previous design is a dead end. */
export async function manageTokenFor(watchId: string): Promise<string | null> {
  return mintActionToken(watchId, 'manage');
}

/** Resolve a live `manage` token to its watch id (or null if invalid/expired). */
export async function resolveManageToken(token: string): Promise<string | null> {
  const [row] = await query<{ watch_id: string }>(
    `SELECT watch_id FROM action_tokens WHERE token = $1 AND action = 'manage' AND expires_at > NOW()`,
    [token]
  );
  return row?.watch_id ?? null;
}

/**
 * Mint (or reuse) a booking short-link: a `book` token whose redirect_url is the full
 * booking URL. Keyed per (watch, site) so it's stable. Returns the token, or null on
 * failure (caller falls back to the full URL).
 */
export async function mintBookingToken(watchId: string, url: string, siteId?: string | null): Promise<string | null> {
  const token = genToken();
  try {
    const rows = await mutate<{ token: string }>(
      `INSERT INTO action_tokens (token, watch_id, action, site_id, redirect_url)
       VALUES ($1, $2, 'book', $3, $4)
       ON CONFLICT (watch_id, action, COALESCE(site_id, '')) DO UPDATE SET redirect_url = EXCLUDED.redirect_url
       RETURNING token`,
      [token, watchId, siteId ?? null, url]
    );
    return rows[0]?.token ?? token;
  } catch (err) {
    console.error(`[actions] mint booking link for ${watchId} failed:`, (err as Error).message);
    return null;
  }
}

/** Resolve a booking short-link token to its destination URL (or null). */
export async function resolveBooking(token: string): Promise<string | null> {
  const [row] = await query<{ redirect_url: string | null }>(
    `SELECT redirect_url FROM action_tokens WHERE token = $1 AND action = 'book' AND expires_at > NOW()`,
    [token]
  );
  return row?.redirect_url ?? null;
}

/**
 * Get (or create) the stable token for (watch, action, site). Reused across alerts
 * so links don't churn and the table stays bounded. Returns null on failure — a
 * missing action link must never block the alert itself.
 */
export async function mintActionToken(
  watchId: string,
  action: WatchAction,
  siteId?: string | null
): Promise<string | null> {
  const token = genToken();
  try {
    const rows = await mutate<{ token: string }>(
      `INSERT INTO action_tokens (token, watch_id, action, site_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (watch_id, action, COALESCE(site_id, '')) DO UPDATE SET token = action_tokens.token
       RETURNING token`,
      [token, watchId, action, siteId ?? null]
    );
    return rows[0]?.token ?? token;
  } catch (err) {
    console.error(`[actions] mint ${action} for ${watchId} failed:`, (err as Error).message);
    return null;
  }
}

/** Convenience: mint a token and return its full URL (or null). */
export async function actionUrlFor(
  watchId: string,
  action: WatchAction,
  siteId?: string | null
): Promise<string | null> {
  const t = await mintActionToken(watchId, action, siteId);
  return t ? actionLink(t) : null;
}

export interface ActionResult {
  ok: boolean;
  action?: WatchAction;
  /** Whether this call actually changed state (vs. a repeat tap / prefetch). */
  changed?: boolean;
  campgroundName?: string;
  siteId?: string | null;
  /** A one-tap URL for the inverse action, to render on the confirmation page. */
  inverseUrl?: string | null;
  message?: string;
}

/**
 * Resolve a token and perform its action. Idempotent: a repeat tap (or an email
 * client prefetch) sees the state already changed and does nothing further. On a
 * fresh `stop` it also fires the "stopped — tap to reopen" confirmation message,
 * which is why stop doubles as snooze.
 */
/**
 * What a `hold` token WOULD do, without doing it.
 *
 * WHY THIS EXISTS. `/w/<token>` performs its action on page load, under a comment saying
 * every action is reversible so an accidental prefetch is harmless. That is true of
 * stop/reopen/keep/mute — and **false of `hold`**, which is the one action that commits
 * the bot to taking a real site off the market at 08:00. Tapping the push notification
 * therefore booked the hold before the user had seen which site it was; and an email
 * scanner or link preview could have done the same thing unasked.
 *
 * So `hold` gets a confirm step, and this is the read half: everything needed to show
 * WHICH site, WHICH nights and WHEN it releases, plus a link to look at it on the
 * provider first. Returns null for any other action, or if there is no live offer —
 * the caller falls back to performing, which keeps every reversible action one tap.
 */
export interface HoldPreview {
  token: string;
  campgroundName: string | null;
  unitLabel: string;
  arrivalDate: string;
  nights: number;
  releaseAt: string;
  bookingUrl: string | null;
  alreadyRequested: boolean;
}

export async function previewHold(token: string): Promise<HoldPreview | null> {
  const [row] = await query<{ watch_id: string; action: WatchAction; site_id: string | null }>(
    `SELECT watch_id, action, site_id FROM action_tokens WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  if (!row || row.action !== 'hold' || !row.site_id) return null;

  const [h] = await query<{
    unit_id: string; unit_name: string | null; arrival_date: string; nights: number;
    release_at: string; status: string; name: string; source: string; reservations_url: string | null;
    campground_id: string;
  }>(
    `SELECT r.unit_id, r.unit_name, r.arrival_date::text AS arrival_date, r.nights, r.release_at,
            r.status, c.name, c.source, c.reservations_url, c.id AS campground_id
       FROM rc_hold_requests r JOIN campgrounds c ON c.id = r.campground_id
      WHERE r.watch_id = $1 AND r.unit_id = $2
        AND r.status IN ('offered', 'requested')
        AND r.release_at > to_char(NOW() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS')
      ORDER BY r.release_at ASC LIMIT 1`,
    [row.watch_id, row.site_id]
  );
  if (!h) return null;

  const { bookingLink } = await import('@/lib/booking-url');
  return {
    token,
    campgroundName: h.name,
    unitLabel: h.unit_name ?? h.unit_id,
    arrivalDate: h.arrival_date,
    nights: h.nights,
    releaseAt: h.release_at,
    // The LOOP, not the park — same helper the claim hand-off uses, so "go and look at
    // it" lands on the page the site is actually on.
    bookingUrl: bookingLink({
      source: h.source, reservationsUrl: h.reservations_url, campgroundId: h.campground_id,
    }) ?? h.reservations_url,
    alreadyRequested: h.status === 'requested',
  };
}

export async function performAction(token: string): Promise<ActionResult> {
  const [row] = await query<{ watch_id: string; action: WatchAction; site_id: string | null }>(
    `SELECT watch_id, action, site_id FROM action_tokens WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  if (!row) return { ok: false, message: 'This link is invalid or has expired.' };
  const { watch_id: watchId, action, site_id: siteId } = row;

  // Campground name for friendly copy.
  const [w] = await query<{ name: string }>(
    `SELECT c.name FROM watches wt JOIN campgrounds c ON c.id = wt.campground_id WHERE wt.id = $1`,
    [watchId]
  );
  const campgroundName = w?.name;

  switch (action) {
    case 'stop':
    case 'cancel': {
      const changedRows = await mutate<{ id: string }>(
        `UPDATE watches SET active = false WHERE id = $1 AND active = true RETURNING id`,
        [watchId]
      );
      const changed = changedRows.length > 0;
      const reopenUrl = await actionUrlFor(watchId, 'reopen');
      if (changed && action === 'stop') await sendStopConfirmation(watchId, campgroundName, reopenUrl);
      return { ok: true, action, changed, campgroundName, inverseUrl: reopenUrl,
        message: changed ? `Stopped watching ${campgroundName ?? 'this campground'}.` : `Already stopped.` };
    }
    case 'reopen': {
      const changedRows = await mutate<{ id: string }>(
        `UPDATE watches SET active = true, deadman_prompted_at = NULL WHERE id = $1 AND active = false RETURNING id`,
        [watchId]
      );
      const stopUrl = await actionUrlFor(watchId, 'stop');
      return { ok: true, action, changed: changedRows.length > 0, campgroundName, inverseUrl: stopUrl,
        message: `Watching ${campgroundName ?? 'this campground'} again.` };
    }
    case 'keep': {
      await mutate(`UPDATE watches SET deadman_prompted_at = NULL WHERE id = $1`, [watchId]);
      const stopUrl = await actionUrlFor(watchId, 'stop');
      return { ok: true, action, changed: true, campgroundName, inverseUrl: stopUrl,
        message: `Kept ${campgroundName ?? 'this watch'} active.` };
    }
    // "Hold it for me" on a coming-soon alert. The booking details are NOT in this
    // token — the poller wrote an `offered` row when it sent the alert, and this only
    // flips it to `requested`. A token that carried unit/dates/release would outlive
    // them and could not be corrected if the grid changed before 8am.
    case 'hold': {
      // SECOND ENFORCER, not a duplicate. The offer is gated when the alert is built,
      // but an email link is durable: a lapsed Auto-Cart subscriber can tap one sent
      // while they were paying, weeks later. Entitlement is checked at the moment it
      // would be spent, using the same lib/auth definition as everywhere else.
      const [owner] = await query<{ user_id: string }>(
        `SELECT user_id FROM watches WHERE id = $1`, [watchId]
      );
      const { hasAutocartEntitlement } = await import('@/lib/auth');
      if (!owner || !(await hasAutocartEntitlement(owner.user_id))) {
        return {
          ok: false,
          message: 'Holding a site at release time is part of the Auto-Cart plan. Your alerts carry on as normal — you can still book it yourself the moment it opens.',
        };
      }
      const { requestHold, rcBotUsable } = await import('@/lib/rc-holds');
      const req = siteId ? await requestHold(watchId, siteId) : null;
      if (!req) {
        return {
          ok: false,
          message: 'That hold is no longer available — the site may have already been released, or the request expired.',
        };
      }
      const when = req.release_at.replace('T', ' ').slice(0, 16);
      const site = `site ${req.unit_name ?? req.unit_id} at ${campgroundName ?? 'this campground'}`;

      // CAPACITY, checked here as well as at the offer — and this one is not a duplicate,
      // for the usual reason: a link is durable. The button was gated against a window that
      // had room when the alert was built, and two other people can have tapped since.
      //
      // IT DOES NOT REFUSE. A full window can empty — on 2026-08-13 the third hold went in
      // on a later pass once one of the other two was claimed — so declining outright would
      // throw away a hold that may well come good. What it must not do is repeat the flat
      // promise, because a user who believes the site is handled stops watching, and that
      // is how a recoverable morning becomes a lost one. Same call as the offline-bot branch
      // below, and the same wording discipline.
      const { holdWindowLoad } = await import('@/lib/rc-holds');
      const { RC_HOLD_CAPACITY } = await import('@/lib/limits');
      const load = await holdWindowLoad(req.release_at, {
        watchId, unitId: String(req.unit_id), arrivalDate: req.arrival_date,
      }).catch(() => 0);
      if (load >= RC_HOLD_CAPACITY) {
        return {
          ok: true, action, changed: true, campgroundName, siteId,
          message:
            `Noted — but ${load} other site${load === 1 ? ' is' : 's are'} already queued for ${when} PT and we ` +
            `can hold ${RC_HOLD_CAPACITY} at once, so ${site} is next in line rather than secured. ` +
            `We'll take it if a slot frees. Plan to book it yourself the moment it opens — ` +
            `you'll get the usual alert the second it does.`,
        };
      }

      // THE THIRD ENFORCER, and the one that was missing on 2026-08-11. The offer is gated
      // when the alert is built and the entitlement again here — but nothing asked whether
      // there was a bot alive to do the carting, and for two hours that day there was not.
      // A link is durable: this one may have been sent while the runner was healthy and
      // tapped after it died.
      //
      // IT DOES NOT REFUSE, deliberately. A hold tapped the evening before an 08:00 release
      // has all night to come good, and declining it over a runner that is down right now
      // would throw away a hold that would probably have worked — the same mistake as the
      // alarm that rang at T-45 about a session `maybeAutoLogin` was about to repair. What
      // it must not do is repeat the flat promise, because a user who believes the site is
      // handled stops watching, and that is how a recoverable morning becomes a lost one.
      const bot = await rcBotUsable().catch(() => ({ ok: false, beatAgeMs: null }));
      if (!bot.ok) {
        return {
          ok: true, action, changed: true, campgroundName, siteId,
          message:
            `Noted — we'll try for ${site} at ${when} PT. But our booking bot is offline right now, ` +
            `so please plan to book it yourself the moment it opens. We'll text you either way, and ` +
            `you'll get the usual alert the second the site frees up.`,
        };
      }
      return {
        ok: true, action, changed: true, campgroundName, siteId,
        message: `We'll grab ${site} the moment it opens (${when} PT). You'll get a text when it's in the cart.`,
      };
    }
    case 'mute_site': {
      // array_append only if not already present, so a repeat tap is a no-op.
      const changedRows = await mutate<{ id: string }>(
        `UPDATE watches SET muted_site_ids = array_append(muted_site_ids, $2)
         WHERE id = $1 AND NOT ($2 = ANY(muted_site_ids)) RETURNING id`,
        [watchId, siteId]
      );
      return { ok: true, action, changed: changedRows.length > 0, campgroundName, siteId,
        message: `Muted site ${siteId} at ${campgroundName ?? 'this campground'}. You'll still hear about other sites.` };
    }
    default:
      return { ok: false, message: 'Unknown action.' };
  }
}

/** "Stopped — tap to reopen" follow-up, on both channels the user has. */
async function sendStopConfirmation(watchId: string, campgroundName: string | undefined, reopenUrl: string | null): Promise<void> {
  const [u] = await query<{ email: string | null; phone: string | null }>(
    `SELECT u.email, u.phone FROM watches wt JOIN users u ON u.id = wt.user_id WHERE wt.id = $1`,
    [watchId]
  );
  if (!u) return;
  const name = campgroundName ?? 'this campground';
  const link = reopenUrl ?? APP_URL;
  await Promise.allSettled([
    u.email
      ? sendEmail({
          to: u.email,
          subject: `Stopped watching ${name}`,
          html: `<p>You've stopped watching <b>${name}</b> — no more alerts for it.</p><p>Changed your mind? <a href="${link}">Reopen this watch</a>.</p>`,
        })
      : Promise.resolve(),
    // No link: a camphawk.app URL in an SMS is filtered by the carrier and the text
    // never arrives (see sendSms). The reopen link lives in the email above, which is
    // where it always worked.
    u.phone && twilioAccountSid()
      ? sendSms({ to: u.phone, body: `CampHawk: stopped watching ${name}. Check your email to reopen it.` })
      : Promise.resolve(),
  ]);
}
