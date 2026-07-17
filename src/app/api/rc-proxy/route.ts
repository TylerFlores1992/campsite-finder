import { NextRequest, NextResponse } from 'next/server';
import { USEDIRECT_ALLOWED_HOSTS, USEDIRECT_PROVIDERS } from '@/lib/sources/reservecalifornia/providers';

// UseDirect RDR WAFs block datacenter IPs (GitHub Actions, Fly.io) but allow
// Vercel — so the Fly worker routes its RDR API calls (ReserveCalifornia, Arizona,
// …) through here. Locked down: shared-secret header + host allowlist + path
// allowlist. The caller passes the resolved `base` so we forward to the right state.

const DEFAULT_BASE = USEDIRECT_PROVIDERS[0].fallbackBase; // ReserveCalifornia
const ALLOWED_PATHS = [/^\/fd\/[a-z]+$/, /^\/search\/grid$/];

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const secret = process.env.SYNC_SECRET;
  if (!secret || req.headers.get('x-sync-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { base = DEFAULT_BASE, path, method = 'GET', body } = await req.json();
  if (typeof path !== 'string' || !ALLOWED_PATHS.some((re) => re.test(path))) {
    return NextResponse.json({ error: 'path not allowed' }, { status: 400 });
  }
  // Only forward to known UseDirect RDR hosts.
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return NextResponse.json({ error: 'bad base' }, { status: 400 });
  }
  if (!USEDIRECT_ALLOWED_HOSTS.includes(host)) {
    return NextResponse.json({ error: 'host not allowed' }, { status: 400 });
  }

  const res = await fetch(`${String(base).replace(/\/+$/, '')}${path}`, {
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
