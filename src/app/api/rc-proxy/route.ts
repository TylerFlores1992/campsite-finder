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
    // Carry a slice of the upstream body, not just its status. A WAF challenge, a
    // rate-limit notice and a genuine 5xx all arrive as "not ok" and are otherwise
    // indistinguishable to the caller — which is precisely the position we were in
    // when every RC fetch started 502ing on 2026-07-30 while RC itself answered 200
    // to a direct request. `console.error` also puts it in Vercel's runtime logs,
    // where the caller's own logs cannot reach.
    const detail = await res.text().then((t) => t.slice(0, 300), () => '');
    console.error(`[rc-proxy] upstream ${res.status} for ${host}${path}: ${detail}`);
    return NextResponse.json(
      { error: `upstream ${res.status}`, upstreamStatus: res.status, detail },
      { status: 502 }
    );
  }
  return NextResponse.json(await res.json());
}
