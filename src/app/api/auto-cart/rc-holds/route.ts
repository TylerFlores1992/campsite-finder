import { NextRequest, NextResponse } from 'next/server';
import { dueHolds, markCarted, markFailed, expireStaleHolds, type HoldRequest } from '@/lib/rc-holds';

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

  // Lead time on purpose: the bot should be mid-request when the site frees, not
  // starting to think about it a second late. RC releases on the exact minute.
  const lead = Math.min(600, Math.max(0, Number(req.nextUrl.searchParams.get('leadSeconds') ?? 90)));
  const [cart, stale] = await Promise.all([dueHolds(lead), expireStaleHolds()]);

  return NextResponse.json({
    cart: cart.map(forBot),
    release: stale.toRelease.map(forBot),
    expired: stale.expired,
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
  if (typeof id !== 'string' || !id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  if (released === true) {
    // The bot let go. Not 'claimed' — nobody took it; it went back on the market.
    await markFailed(id, 'released unclaimed');
    return NextResponse.json({ ok: true, state: 'released' });
  }

  if (ok === true) {
    if (typeof cartKey !== 'string' || !cartKey) {
      return NextResponse.json({ error: 'cartKey required on success' }, { status: 400 });
    }
    await markCarted(id, cartKey, typeof cartEntryKey === 'string' ? cartEntryKey : null);
    return NextResponse.json({ ok: true, state: 'carted' });
  }

  await markFailed(id, typeof error === 'string' ? error : 'unknown error');
  return NextResponse.json({ ok: true, state: 'failed' });
}
