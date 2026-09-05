/**
 * COUNT THE RESIDENT PAGE'S REQUESTS — paths only, never a body, never a query.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 * On 2026-09-04 22:19 the ramp-scan named the ~35 GB that appears at every ramp onset, to a
 * class: committed, UNTOUCHED, non-private memory (pagefile 7 MB in use against 40 GB
 * charged, kernel pools under 750 MB) held by a renderer with 18,705 handles against ~250
 * for a healthy one. That is the signature of pagefile-backed shared-memory SECTIONS, and
 * ~18,700 regions of ~2 MB is roughly the gap. What CREATES them is not named. A per-request
 * data pipe in a request loop fits the shape — and nothing has ever counted the resident
 * page's requests. The alloc trail said the same evening that the ramping renderer was the
 * RESIDENT page's, not the throwaway tab's, and the renewal logged the token going
 * live → none in the 63 seconds before the onset — which is the SPA's own `prompt=none`
 * autoRenew failing and deleting the tokens, the 2026-08-09 finding.
 *
 * So: a loop is a RATE. Lifetime-of-browser counts say what the page does at all; a rolling
 * two-minute count says what it is doing NOW, and the top ten by that count at the moment a
 * bail fires is the one line that says whether the 18.7k handles are a request loop and,
 * if so, against which endpoint.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────────────────────
 * • The key is `origin + pathname`, through the SAME `safeUrl` the net trace uses. Okta's
 *   callback carries `code=` in the query and this repo published one on 2026-08-09; a
 *   TypeError published a password on 08-16. Do not collect a field you would then have to
 *   filter — so the query is never read, no header is read, and `response.body()` is never
 *   called (buffering a payload into this process on a page suspected of moving gigabytes is
 *   the cure arriving as the disease).
 * • Distinct paths are CAPPED. A path with an id baked into it would grow the map for ever;
 *   past the cap everything new counts under `<other>`.
 * • The rolling window is bounded in ENTRIES as well as time, and says so when it overflowed:
 *   a loop hot enough to overflow it is exactly the case this exists for, and the two-minute
 *   figure is then a lower bound, which is printed as one rather than as a count.
 * • Subframes ride the same `page.on('request')` event in Playwright, and that is
 *   load-bearing: okta-auth-js's `prompt=none` renewal runs in a hidden iframe.
 *
 * A pure module for the reason `tab-close.mjs` and `renewal-schedule.mjs` are: importing
 * `rc-keepwarm.mjs` starts the keep-warm loop, and this has arms that only run during a ramp.
 */
import { safeUrl } from './okta-net-trace.mjs';

/** The rolling window. Matches the bail's stall bar so "now" means the same thing in both. */
export const REQUEST_WINDOW_MS = Number(process.env.RC_REQUEST_WINDOW_MS || 120_000);
/** Distinct keys kept before new ones fold into `<other>`. */
export const REQUEST_MAX_PATHS = Number(process.env.RC_REQUEST_MAX_PATHS || 200);
/** Entries the rolling window may hold before the oldest are dropped. */
export const REQUEST_WINDOW_CAP = Number(process.env.RC_REQUEST_WINDOW_CAP || 50_000);
export const OTHER_KEY = '<other>';
export const TOP_N = 10;

/**
 * @param {{ now?: () => number, windowMs?: number, maxPaths?: number, windowCap?: number }} [opts]
 */
export function createRequestCounter({
  now = () => Date.now(), windowMs = REQUEST_WINDOW_MS,
  maxPaths = REQUEST_MAX_PATHS, windowCap = REQUEST_WINDOW_CAP,
} = {}) {
  const startedAt = now();
  /** @type {Map<string, number>} */
  const lifetime = new Map();
  /** @type {{ at: number, key: string }[]} the rolling window, oldest first */
  let recent = [];
  let overflowed = false;
  let total = 0;

  const keyFor = (url) => {
    const k = safeUrl(url);
    if (lifetime.has(k) || lifetime.size < maxPaths) return k;
    return OTHER_KEY;
  };

  const prune = (t) => {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < recent.length && recent[i].at < cutoff) i += 1;
    if (i > 0) recent = recent.slice(i);
  };

  /** Record one request by URL. Cheap, synchronous, never throws. */
  function record(url) {
    const t = now();
    const key = keyFor(url);
    lifetime.set(key, (lifetime.get(key) ?? 0) + 1);
    total += 1;
    recent.push({ at: t, key });
    if (recent.length > windowCap) {
      overflowed = true;
      recent = recent.slice(recent.length - windowCap);
    }
    // Prune on the way in, occasionally, so a quiet page never accumulates a stale window.
    if ((total & 63) === 0) prune(t);
  }

  /**
   * Attach to a Playwright page. The handler is a plain function so a page that is already
   * gone (a closed context throws on `.on`) costs a log line and not the loop.
   * @returns {() => void} detach
   */
  function attach(page) {
    const handler = (req) => {
      try { record(typeof req?.url === 'function' ? req.url() : String(req)); } catch { /* never throw into Playwright */ }
    };
    page.on('request', handler);
    return () => { try { page.off('request', handler); } catch { /* gone */ } };
  }

  /** Top keys by ROLLING count, then lifetime. `recent` is a lower bound when overflowed. */
  function top(n = TOP_N) {
    const t = now();
    prune(t);
    const rolling = new Map();
    for (const e of recent) rolling.set(e.key, (rolling.get(e.key) ?? 0) + 1);
    const rows = [...lifetime.entries()].map(([key, life]) => ({ key, recent: rolling.get(key) ?? 0, lifetime: life }));
    rows.sort((a, b) => (b.recent - a.recent) || (b.lifetime - a.lifetime) || a.key.localeCompare(b.key));
    return rows.slice(0, n);
  }

  /** The bot-event detail: small, structured, and never a URL with a query in it. */
  function snapshot({ reason = null, n = TOP_N } = {}) {
    const t = now();
    const rows = top(n);
    prune(t);
    return {
      reason,
      windowMs,
      sinceAt: new Date(startedAt).toISOString(),
      ageMs: t - startedAt,
      lifetimeTotal: total,
      recentTotal: recent.length,
      distinct: lifetime.size,
      capped: lifetime.has(OTHER_KEY),
      windowOverflowed: overflowed,
      top: rows,
    };
  }

  return { record, attach, top, snapshot, get windowMs() { return windowMs; } };
}

/**
 * Lines for the log. The first line is the totals; one line per path after it. `compact`
 * puts the top few on ONE line, for the teardown that fires on every reopen — many times an
 * hour, into a `tail-log` that returns 16,000 characters, where eleven lines per reopen would
 * bury the bail they exist beside.
 */
export function describeRequestCounts(counter, { n = TOP_N, compact = false } = {}) {
  const s = counter.snapshot({ n });
  const win = Math.round(s.windowMs / 1000);
  const lower = s.windowOverflowed ? '≥' : '';
  const head = `request counts (resident page, ${Math.round(s.ageMs / 1000)}s old): `
    + `${lower}${s.recentTotal} in the last ${win}s, ${s.lifetimeTotal} lifetime, `
    + `${s.distinct} distinct path(s)${s.capped ? ` (capped at ${REQUEST_MAX_PATHS}, rest under ${OTHER_KEY})` : ''}`;
  if (s.top.length === 0) return `${head} — none recorded`;
  if (compact) {
    const few = s.top.slice(0, 5).map((r) => `${r.key} ×${r.recent}/${r.lifetime}`).join(' · ');
    return `${head} — top: ${few}`;
  }
  const lines = [head];
  for (const r of s.top) {
    lines.push(`    ${String(r.recent).padStart(6)} in ${win}s  ${String(r.lifetime).padStart(7)} lifetime  ${r.key}`);
  }
  return lines.join('\n');
}
