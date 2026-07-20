import { NextRequest, NextResponse } from 'next/server';
import { tnscProviderByState } from '@/lib/sources/tnsc/providers';
import { fetchAvailabilityBatchAsProxyRows } from '@/lib/sources/tnsc/client';

// The TN/SC ColdFusion portal's WAF blocks datacenter IPs — the Fly worker gets
// `403 on landing`, while Vercel is allowed (measured 2026-07-20; the reverse of
// GoingToCamp). So the worker routes its TN availability check through here: this
// runs the whole CSRF handshake + batched POST from a Vercel IP and returns the
// already-parsed rows. Locked down with the shared SYNC_SECRET header.
//
// (Unlike /api/rc-proxy, which forwards individual requests, this does the whole
// batch — the portal's CSRF token + cookie are session-bound to one IP, so the
// GET-landing and the POST must happen together on the same allowed host.)

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const secret = process.env.SYNC_SECRET;
  if (!secret || req.headers.get('x-sync-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let payload: { state?: string; fromDate?: string; toDate?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const { state, fromDate, toDate } = payload;
  const provider = typeof state === 'string' ? tnscProviderByState(state) : undefined;
  if (!provider) {
    return NextResponse.json({ error: 'unknown state' }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(toDate ?? '')) {
    return NextResponse.json({ error: 'bad dates' }, { status: 400 });
  }

  try {
    const rows = await fetchAvailabilityBatchAsProxyRows(provider, fromDate!, toDate!);
    return NextResponse.json(rows);
  } catch (err) {
    return NextResponse.json({ error: `upstream: ${(err as Error).message}` }, { status: 502 });
  }
}
