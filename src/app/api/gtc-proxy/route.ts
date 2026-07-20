import { NextRequest, NextResponse } from 'next/server';
import { GOINGTOCAMP_ALLOWED_HOSTS } from '@/lib/sources/goingtocamp/providers';

// GoingToCamp tenants sit behind an Azure WAF that 403s datacenter IPs with an
// HTML challenge page. Verified from Fly: both washington.goingtocamp.com and
// midnrreservations.com return 403 + HTML, so the Fly worker cannot reach Camis
// directly and would silently report "no availability" forever. It routes GTC
// calls through here instead, same shape as /api/rc-proxy.
//
// Locked down: shared-secret header + host allowlist + path allowlist. GET only —
// nothing here should ever mutate a reservation.

const ALLOWED_PATHS = [
  /^\/api\/resourcelocation$/,
  /^\/api\/resourcecategory$/,
  /^\/api\/equipment$/,
  /^\/api\/availability\/resourcelocation$/,
];

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const secret = process.env.SYNC_SECRET;
  if (!secret || req.headers.get('x-sync-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { host, path, query } = await req.json();

  if (typeof host !== 'string' || !GOINGTOCAMP_ALLOWED_HOSTS.includes(host)) {
    return NextResponse.json({ error: 'host not allowed' }, { status: 400 });
  }
  if (typeof path !== 'string' || !ALLOWED_PATHS.some((re) => re.test(path))) {
    return NextResponse.json({ error: 'path not allowed' }, { status: 400 });
  }

  // Rebuild the query string here rather than accepting a raw one, so the proxy
  // can't be pointed at arbitrary upstream parameters.
  const qs = new URLSearchParams();
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (/^[A-Za-z]+$/.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        qs.set(k, String(v));
      }
    }
  }
  const url = `https://${host}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: `https://${host}/`,
    },
  });

  const text = await res.text();
  if (!res.ok || text.includes('Azure WAF') || text.includes('.azwaf')) {
    return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
  }
  try {
    return NextResponse.json(JSON.parse(text));
  } catch {
    return NextResponse.json({ error: 'upstream non-JSON' }, { status: 502 });
  }
}
