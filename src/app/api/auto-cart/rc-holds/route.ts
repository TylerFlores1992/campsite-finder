import { NextRequest, NextResponse } from 'next/server';
import { dueHolds, markCarted, markFailed, markReleased, expireStaleHolds, pendingClaims, getHold, noteAttempt, recordSessionHealth, reportCartFailure, type HoldRequest } from '@/lib/rc-holds';
import { query, mutate } from '@/lib/db/client';
import { manageTokenFor } from '@/lib/notifications/actions';
import { dispatchNotifications } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

/**
 * The RC hold feed for the mini-PC bot.
 *
 * Same master-token model as /api/auto-cart/roster: the bot holds no database
 * credentials, so everything it needs arrives over an authorised HTTP call. That is a
 * deliberate property of the existing design, not an accident — the box sits on a
 * residential connection and has already been blocked by a WAF once.
 *
 * ONE call returns both halves of the job, because they are the same pass:
 *   cart[]    — requested holds whose 8am release is due. `requested` only; an
 *               `offered` row is a question nobody answered (see lib/rc-holds).
 *   release[] — holds we carted that nobody claimed. The bot must LET GO. Sitting on
 *               a site the user never came for is the inventory-grabbing this whole
 *               design exists to avoid, so it is not a tidy-up task, it is the job.
 */
function unauthorized(req: NextRequest): NextResponse | null {
  const token = process.env.AUTOCART_TOKEN;
  if (!token) return NextResponse.json({ error: 'auto-cart not configured' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

const forBot = (h: HoldRequest) => ({
  id: h.id,
  unitId: h.unit_id,
  unitName: h.unit_name,
  arrivalDate: h.arrival_date,
  nights: h.nights,
  releaseAt: h.release_at,
  campgroundId: h.campground_id,
  cartKey: h.cart_key,
  cartEntryKey: h.cart_entry_key,
});

export async function GET(req: NextRequest) {
  const bad = unauthorized(req);
  if (bad) return bad;

  // LIVENESS, stamped on the authorized poll itself (same pattern as the rec.gov roster,
  // migration 015). The runner's death was undetectable until a user's hold silently
  // failed — and `autocart.bot` stayed green throughout, because that is a DIFFERENT
  // process which was genuinely fine. Fire-and-forget: a heartbeat write must never be
  // able to fail the request that carts a site.
  mutate(`UPDATE rc_runner_heartbeat SET beat_at = NOW() WHERE id = 1`).catch(() => {});

  // Lead time on purpose: the bot should be mid-request when the site frees, not
  // starting to think about it a second late. RC releases on the exact minute.
  const lead = Math.min(600, Math.max(0, Number(req.nextUrl.searchParams.get('leadSeconds') ?? 90)));
  const [cart, stale, claims] = await Promise.all([dueHolds(lead), expireStaleHolds(), pendingClaims()]);

  // `claim` is separated from `release` on purpose. A stale release is merely overdue;
  // a claim has a person watching a spinner, and every second before the bot lets go is
  // a second they cannot take the site. `pollMs` tells the runner to come back fast
  // while anything is claimable — on its lazy cadence the exposure would be the poll
  // interval, not the ~2.5s the release probe measured.
  return NextResponse.json({
    claim: claims.map(forBot),
    cart: cart.map(forBot),
    release: stale.toRelease.map(forBot),
    expired: stale.expired,
    pollMs: claims.length ? 1000 : null,
  });
}

/**
 * The bot reporting back.
 *
 * `ok: true` must carry the cart AND entry keys — without the entry key the only way
 * to release later is emptying the whole cart, which would drop every other user's
 * hold with it. A success that cannot be undone is not a success we want recorded.
 */
export async function POST(req: NextRequest) {
  const bad = unauthorized(req);
  if (bad) return bad;

  const body = await req.json().catch(() => ({}));
  const { id, ok, cartKey, cartEntryKey, released, error } = body ?? {};

  // SESSION LIVENESS — no hold id, because it is about the bot, not about one hold.
  // `rc-keepwarm.mjs` posts this every pass; the runner posts it whenever it opens the
  // profile and finds out the hard way. See migration 046: a runner that polls this feed
  // happily and cannot drive RC is the exact failure 045's heartbeat cannot see.
  if (body?.session && typeof body.session.live === 'boolean') {
    await recordSessionHealth(
      body.session.live,
      typeof body.session.why === 'string' ? body.session.why : null,
      typeof body.source === 'string' ? body.source : 'unknown',
    );
    return NextResponse.json({ ok: true, state: 'session-recorded' });
  }

  // A PASS THAT COULD NOT ACT. Records why against the holds it was about to touch and
  // leaves their status alone — they must retry. Marking them failed here would close
  // holds that are still live and fire the missed-hold alert for nothing.
  if (body?.skipped === true) {
    const ids = Array.isArray(body.ids) ? body.ids.filter((v: unknown) => typeof v === 'string') : [];
    await noteAttempt(ids, typeof body.reason === 'string' ? body.reason : 'runner skipped');
    return NextResponse.json({ ok: true, state: 'skip-recorded', noted: ids.length });
  }

  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  if (released === true) {
    // TWO different releases, and conflating them loses the only fact worth keeping.
    // `forClaim` means a user asked for it and is about to take it — the handshake
    // working. A bare release is the timeout sweep: nobody came, and the site went back
    // on the market. Recording both as 'failed' would make a successful hand-off
    // indistinguishable from an abandoned hold.
    if (body.forClaim === true) {
      await markReleased(id);
      return NextResponse.json({ ok: true, state: 'released' });
    }
    await markFailed(id, 'released unclaimed — nobody came for it');
    return NextResponse.json({ ok: true, state: 'released' });
  }

  if (ok === true) {
    if (typeof cartKey !== 'string' || !cartKey) {
      return NextResponse.json({ error: 'cartKey required on success' }, { status: 400 });
    }
    const firstTime = await markCarted(id, cartKey, typeof cartEntryKey === 'string' ? cartEntryKey : null);
    // Tell the user ONLY on the transition. The runner re-reads its feed every pass and
    // a hold it already carted must not text them a second time — the same lesson as
    // alerting on the transition rather than the state (migration 039).
    if (firstTime) await notifyHeld(id).catch((e) => console.error('[rc-holds] held alert failed:', e));
    return NextResponse.json({ ok: true, state: 'carted' });
  }

  // NOT `markFailed`. A cart that fails while the release window is still open is an
  // attempt, not an outcome — see reportCartFailure. The feed's 90-second lead means the
  // FIRST attempt is always before the release, so treating it as final guaranteed every
  // hold failed exactly once, too early, forever.
  const outcome = await reportCartFailure(id, typeof error === 'string' ? error : 'unknown error');
  return NextResponse.json({ ok: true, state: outcome });
}

/**
 * "We're holding it — come and get it."
 *
 * Goes out the moment the bot actually has the site, not when we asked it to. The claim
 * URL carries the hold id and the watch's manage token; possession of both is the
 * authorisation, which is what lets the user act from a phone at 8am without signing in.
 *
 * EMAIL AND PUSH ONLY. The link is on camphawk.app and sendSms rejects those — carriers
 * filter them (30007, measured 10 for 10). The SMS still goes, it just says the site is
 * held and to check email, which is better than a text that never arrives.
 */
async function notifyHeld(id: string): Promise<void> {
  const hold = await getHold(id);
  if (!hold) return;
  const [w] = await query<{ start_date: string; end_date: string; name: string; reservations_url: string | null }>(
    `SELECT wt.start_date::text, wt.end_date::text, c.name, c.reservations_url
       FROM watches wt JOIN campgrounds c ON c.id = wt.campground_id WHERE wt.id = $1`,
    [hold.watch_id],
  );
  if (!w) return;
  const token = await manageTokenFor(hold.watch_id);
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app').replace(/\/$/, '');
  const claimUrl = token ? `${base}/claim/${hold.id}?t=${token}` : null;

  await dispatchNotifications({
    userId: hold.user_id,
    watchId: hold.watch_id,
    campgroundId: hold.campground_id,
    campgroundName: w.name,
    availableDates: [hold.arrival_date],
    bookingUrl: w.reservations_url ?? 'https://www.reservecalifornia.com/',
    campsiteName: hold.unit_name,
    campsiteId: hold.unit_id,
    startDate: w.start_date,
    endDate: w.end_date,
    kind: 'carted',
    holdUrl: claimUrl,
  });
}
