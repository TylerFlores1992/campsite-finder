// One-tap alert actions (feature D). A short opaque token → an action on a watch,
// so alert links stay SMS-sized. Minted where alerts are built (poller, dead-man
// cron) and resolved by the public /w/<token> route.
import { randomBytes } from 'crypto';
import { query, mutate } from '@/lib/db/client';
import { sendEmail } from './email';
import { sendSms } from './sms';

export type WatchAction = 'stop' | 'reopen' | 'mute_site' | 'keep' | 'cancel';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');

/** Full one-tap URL for a token. */
export function actionLink(token: string): string {
  return `${APP_URL}/w/${token}`;
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
  const token = randomBytes(8).toString('base64url'); // ~11 chars
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
    u.phone && process.env.TWILIO_ACCOUNT_SID
      ? sendSms({ to: u.phone, body: `CampHawk: stopped watching ${name}. Reopen: ${link}` })
      : Promise.resolve(),
  ]);
}
