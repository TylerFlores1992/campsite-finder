import { NextRequest, NextResponse } from 'next/server';

// ReserveCalifornia's WAF blocks datacenter IPs (GitHub Actions, Fly.io) but
// allows Vercel — so the Fly worker routes its RDR API calls through here.
// Locked down: shared-secret header + strict path allowlist.

const RDR_BASE = 'https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr';

const ALLOWED_PATHS = [/^\/fd\/[a-z]+$/, /^\/search\/grid$/];

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const secret = process.env.SYNC_SECRET;
  if (!secret || req.headers.get('x-sync-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { path, method = 'GET', body } = await req.json();
  if (typeof path !== 'string' || !ALLOWED_PATHS.some((re) => re.test(path))) {
    return NextResponse.json({ error: 'path not allowed' }, { status: 400 });
  }

  const res = await fetch(`${RDR_BASE}${path}`, {
    method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CampsiteFinder/1.0)',
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
  }
  return NextResponse.json(await res.json());
}
