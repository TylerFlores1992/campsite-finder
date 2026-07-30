import { NextRequest, NextResponse } from 'next/server';
import {
  USEDIRECT_ALLOWED_HOSTS,
  USEDIRECT_PROVIDERS,
  rdrRequestHeaders,
} from '@/lib/sources/reservecalifornia/providers';

// UseDirect RDR WAFs block datacenter IPs (GitHub Actions, Fly.io) but allow
// Vercel — so the Fly worker routes its RDR API calls (ReserveCalifornia, Arizona,
// …) through here. Locked down: shared-secret header + host allowlist + path
// allowlist. The caller passes the resolved `base` so we forward to the right state.
//
// TAKES A BATCH. This forwarded ONE request per invocation, and it sits on the hot
// path of a 15-second poller — 11 RC fetches per cycle was ~63,000 Vercel function
// invocations a day for 16 watches, the largest single line in the usage bill and
// almost all of the 1.44M invocations on the Jul-25 cycle. `/api/tnsc-availability`
// next door already batched for a different reason; this now does too, so one cycle
// costs one invocation instead of eleven.
//
// UPSTREAM LOAD IS UNCHANGED — the same N requests still leave Vercel, just from
// inside one function rather than N. That is the point: the WAFs care about request
// rate from an IP, Vercel bills per invocation, and only the second number moves.

const DEFAULT_BASE = USEDIRECT_PROVIDERS[0].fallbackBase; // ReserveCalifornia
const ALLOWED_PATHS = [/^\/fd\/[a-z]+$/, /^\/search\/grid$/];

/** Bound on one batch, so a bad caller can't turn one invocation into a flood. */
const MAX_BATCH = 40;
/**
 * How many of a batch's requests are in flight at once.
 *
 * Deliberately small and deliberately NOT "all of them". These WAFs throttle bursts
 * from one IP — Virginia answered 403 to 83 of 276 grid calls in a single sync when
 * the caller ran 5 wide. Batching must not become a way to hit them harder.
 */
const FANOUT = 2;

export const dynamic = 'force-dynamic';

interface ProxyRequest {
  path: string;
  method?: string;
  body?: unknown;
}
interface ProxyResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  upstreamStatus?: number;
  detail?: string;
}

/** Forward one RDR request. Never throws — a failure is a result, so one bad item
 *  in a batch cannot fail the other N-1. */
async function forward(base: string, host: string, req: ProxyRequest): Promise<ProxyResult> {
  if (typeof req?.path !== 'string' || !ALLOWED_PATHS.some((re) => re.test(req.path))) {
    return { ok: false, status: 400, error: 'path not allowed' };
  }
  try {
    const res = await fetch(`${base}${req.path}`, {
      method: req.method ?? 'GET',
      // Shared with the direct (non-proxied) path so the two cannot drift — the
      // proxy was the one sending the self-identifying CampsiteFinder/1.0 UA.
      headers: rdrRequestHeaders(base, Boolean(req.body)),
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    });

    if (!res.ok) {
      // Carry a slice of the upstream body, not just its status. A WAF challenge, a
      // rate-limit notice and a genuine 5xx all arrive as "not ok" and are otherwise
      // indistinguishable to the caller — which is precisely the position we were in
      // when every RC fetch started 502ing on 2026-07-30 while RC itself answered 200
      // to a direct request. `console.error` also puts it in Vercel's runtime logs,
      // where the caller's own logs cannot reach.
      const detail = await res.text().then((t) => t.slice(0, 300), () => '');
      console.error(`[rc-proxy] upstream ${res.status} for ${host}${req.path}: ${detail}`);
      return {
        ok: false,
        status: 502,
        error: `upstream ${res.status}`,
        upstreamStatus: res.status,
        detail,
      };
    }
    return { ok: true, status: 200, data: await res.json() };
  } catch (err) {
    // A transport failure is this item's result, not the batch's.
    const message = (err as Error).message.slice(0, 200);
    console.error(`[rc-proxy] fetch failed for ${host}${req.path}: ${message}`);
    return { ok: false, status: 502, error: `fetch failed: ${message}` };
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.SYNC_SECRET;
  if (!secret || req.headers.get('x-sync-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const payload = await req.json().catch(() => null);
  if (!payload) return NextResponse.json({ error: 'bad json' }, { status: 400 });

  const base = String(payload.base ?? DEFAULT_BASE).replace(/\/+$/, '');
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

  // BATCH shape. Results come back in request order so the caller can zip them up.
  if (Array.isArray(payload.requests)) {
    const requests = payload.requests as ProxyRequest[];
    if (requests.length === 0) return NextResponse.json({ results: [] });
    if (requests.length > MAX_BATCH) {
      return NextResponse.json({ error: `too many requests (max ${MAX_BATCH})` }, { status: 400 });
    }

    const results = new Array<ProxyResult>(requests.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(FANOUT, requests.length) }, async () => {
        for (let i = next++; i < requests.length; i = next++) {
          results[i] = await forward(base, host, requests[i]);
        }
      })
    );
    // 200 even when items failed — the per-item status is in each result. A 502 here
    // would tell the caller nothing about WHICH of the N failed.
    return NextResponse.json({ results });
  }

  // SINGLE shape, kept for compatibility: an older worker image mid-deploy still
  // sends it, and removing it would break alerting for the minutes between the
  // Vercel deploy and the Fly deploy.
  const single = await forward(base, host, {
    path: payload.path,
    method: payload.method,
    body: payload.body,
  });
  if (single.ok) return NextResponse.json(single.data);
  return NextResponse.json(
    { error: single.error, upstreamStatus: single.upstreamStatus, detail: single.detail },
    { status: single.status }
  );
}
