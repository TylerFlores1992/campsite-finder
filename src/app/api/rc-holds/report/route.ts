import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import { getHold, recordClientReports, type ClientReport } from '@/lib/rc-holds';

export const dynamic = 'force-dynamic';

/**
 * What the user's own device reported during the hand-off.
 *
 * ## Why a durable record and not just the on-screen panel
 *
 * The reports already exist and are proven on both platforms — but they live in the claim
 * screen's memory and vanish with it. Nobody is reading a diagnostic panel at 08:00:00,
 * and the one hold a month where this matters is precisely the one where the user is
 * busy. Without this, a hold that ends `released` is byte-identical whether the injected
 * precart carted the site, threw on line 1, or never ran — and the two RC cart POSTs are
 * still the one link in the chain nothing has measured.
 *
 * ## Authorisation
 *
 * Hold id + the watch's `manage` token, exactly as the claim endpoint — no login, because
 * this fires on a phone at 8am from an email link and a sign-in would spend the seconds
 * the hold exists to save. Possession of both is the authorisation.
 *
 * IT MUST BE NO WEAKER THAN THE CLAIM, and it deliberately shares the same check: a
 * report can only ever be written against a hold whose manage token the caller already
 * holds, which is the same thing that authorises releasing the site. Anything looser
 * would let a stranger write diagnostic text onto someone else's hold.
 *
 * ## What may be posted
 *
 * Stage names, RC's own user-facing status text, and booleans about the token. The
 * reporter never emits a token, a cart key, or a URL query string — Okta signs in inside
 * that webview, so `?code=` is an exchangeable authorization code. That is enforced at the
 * source (lib/rc-precart-script) and guarded by worker/rc-handoff.test.mts; the cap and
 * the string truncation here are the second line, not the first.
 */

/** Bound the request. A device that loops would otherwise write unboundedly to a row the
 *  cart path also writes. The client already collapses consecutive duplicates. */
const MAX_REPORTS = 60;

function clean(raw: unknown): ClientReport[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_REPORTS).flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const { n, stage, detail } = r as Record<string, unknown>;
    if (typeof stage !== 'string' || !stage) return [];
    // Detail is re-serialised through a whitelist of primitives rather than stored
    // verbatim: this is attacker-controllable in the sense that anything with the token
    // can post it, and a nested blob on a hot row is a cost we get nothing for.
    const out: Record<string, unknown> = {};
    if (detail && typeof detail === 'object') {
      for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
        // TWELVE, BECAUSE THE `session` REPORT IS NOW ELEVEN AND SILENT TRUNCATION OF A
        // DIAGNOSTIC IS THE FAILURE THIS WHOLE INVESTIGATION KEEPS PAYING FOR. Object key
        // order is insertion order, so the four `okta*` fields added on 2026-08-31 sit at
        // the END — under the old ceiling they were exactly what got dropped, and the
        // instrument would have reported nothing while looking like it had run. Bounded
        // still: each value is truncated to 300 characters and the report count is capped
        // above, so this is a slightly wider bound, not an open one.
        if (Object.keys(out).length >= 14) break;
        if (typeof v === 'string') out[k] = v.slice(0, 300);
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
      }
    }
    return [{ n: Number.isFinite(n) ? Number(n) : 0, stage: stage.slice(0, 40), detail: out }];
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id ?? '');
  const token = String(body?.token ?? '');
  if (!id || !token) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const hold = await getHold(id);
  if (!hold) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const [row] = await query<{ watch_id: string }>(
    `SELECT watch_id FROM action_tokens
      WHERE token = $1 AND action = 'manage' AND watch_id = $2 AND expires_at > NOW()`,
    [token, hold.watch_id],
  ).catch(() => []);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await recordClientReports(hold.id, clean(body?.reports));
  // No body worth sending back. This is fired with `keepalive` from a page whose user is
  // mid-claim; the one thing it must never do is make them wait.
  return new NextResponse(null, { status: 204 });
}
