// A tiny HTTP surface on the poller, for ONE job: answering GoingToCamp
// availability for the website's search page.
//
// Why this exists: the Camis WAF 403s Vercel's IPs but not Fly's, so the search
// route (on Vercel) cannot ask Camis directly and was rendering every GoingToCamp
// campground as "unknown". Fly can reach Camis, so Vercel asks Fly.
//
// Deliberately minimal: one path, POST only, shared-secret header, no database
// access, and it can only ever return booleans about campsite availability.

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import {
  hasGoingToCampAvailabilityInRange,
  isGoingToCampCampgroundId,
} from '../src/lib/availability/goingtocamp';

const PORT = Number(process.env.PORT ?? 8080);
const MAX_ITEMS = 60;

/**
 * Short-lived cache. The Camis WAF challenges bursty traffic, and a search page
 * can ask about dozens of campgrounds at once — repeatedly, as a user pans the
 * map. Caching by campground+range keeps us well under the burst threshold and
 * makes repeat searches instant. 90s is short enough that a freed site still
 * shows up promptly in search; alerts don't depend on this path at all.
 */
const TTL_MS = 90_000;
const cache = new Map<string, { at: number; value: boolean | null }>();

function cacheGet(key: string): boolean | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: boolean | null): void {
  // Bounded so a long-running worker can't grow this without limit.
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

interface Item {
  campgroundId: string;
  startDate: string;
  endDate: string;
  minNights?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Unauthenticated liveness check — carries no data.
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true });
  }

  if (url.pathname !== '/gtc/availability') return json(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  const secret = process.env.SYNC_SECRET;
  if (!secret || req.headers['x-sync-secret'] !== secret) {
    return json(res, 401, { error: 'unauthorized' });
  }

  let items: Item[];
  try {
    const parsed = JSON.parse(await readBody(req));
    items = Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return json(res, 400, { error: 'bad json' });
  }
  if (items.length === 0) return json(res, 200, { results: [] });
  if (items.length > MAX_ITEMS) return json(res, 400, { error: `too many items (max ${MAX_ITEMS})` });

  // `null` means "couldn't determine" — the caller must render that as unknown,
  // never as unavailable. Same reasoning as the search-path adapter throwing.
  const results = await pMap(
    items,
    async (item) => {
      const { campgroundId, startDate, endDate } = item ?? ({} as Item);
      if (
        typeof campgroundId !== 'string' ||
        !isGoingToCampCampgroundId(campgroundId) ||
        !ISO_DATE.test(String(startDate)) ||
        !ISO_DATE.test(String(endDate))
      ) {
        return { campgroundId: String(campgroundId ?? ''), available: null };
      }
      const minNights = Number.isFinite(item.minNights) ? Number(item.minNights) : 1;
      const key = `${campgroundId}|${startDate}|${endDate}|${minNights}`;

      const cached = cacheGet(key);
      if (cached !== undefined) return { campgroundId, available: cached };

      let value: boolean | null;
      try {
        value = await hasGoingToCampAvailabilityInRange(campgroundId, startDate, endDate, minNights);
      } catch {
        value = null; // transport/WAF failure — unknown, not "unavailable"
      }
      cacheSet(key, value);
      return { campgroundId, available: value };
    },
    4
  );

  return json(res, 200, { results });
}

export function startHttpServer(): void {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { error: 'internal' }));
  });
  server.on('error', (err) => {
    // Never let an HTTP problem take down the poller — alerting matters more.
    console.error('[http] server error (poller continues):', (err as Error).message);
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[http] GoingToCamp availability endpoint listening on :${PORT}`);
  });
}
