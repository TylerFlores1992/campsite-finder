import { mutate } from '@/lib/db/client';

/**
 * WHERE A SAMPLER READING GOES SO IT CANNOT AGE OUT.
 *
 * See migration 066. The short version: two nine-gigabyte ramps happened on 2026-08-22/23
 * with the native sampler running for both, and BOTH attributions were lost — its only
 * output is `logs\rc-keepwarm.log`, and `tail-log` returns the last 16,000 characters.
 * `chromium_memory_samples` survived the same two events because it is in Postgres.
 *
 * This is deliberately the smaller, rarer sibling of that table: the series says a ramp
 * happened and how big, this says what was allocating while it did.
 *
 * NO `import 'server-only'`, DELIBERATELY — the same call `lib/stripe-client.ts` records.
 * It resolves to a throwing stub outside a server bundle, `node:test` included, which would
 * make this module's own behaviour untestable and force a test against a COPY of the rules.
 * `chromium-memory.ts` and `rc-holds.ts`, its two closest siblings, both omit it for the
 * same reason. The property is asserted mechanically instead.
 */

/** One aggregated allocation site, as the bot's `summarise()` already produces them. */
export interface AllocSite {
  site: string;
  bytes: number;
}

export interface NativeAllocInput {
  context?: unknown;
  ramDeltaMb?: unknown;
  rendererBytes?: unknown;
  sites?: unknown;
}

/**
 * Which trip produced the reading. Allow-listed on the way in, like `max_type` in 062:
 * this crosses the network from the box and is rendered on an admin page, and an
 * unrecognised value is a bug worth seeing as NULL rather than storing verbatim.
 */
const CONTEXTS = new Set(['renewal', 'auto-login', 'rehearsal', 'warmup']);

/** Nothing over this is stored. A 9 GB ramp aggregates to a handful of rows; a hundred is
 *  already a sampler behaving unexpectedly, and the tail is noise at these magnitudes. */
const MAX_SITES = 40;

/** Site strings are `module+offset <- module+offset`; anything longer is not one. */
const MAX_SITE_CHARS = 200;

/**
 * Keep only what is shaped like a site list.
 *
 * RETURNS NULL, NEVER `[]`, WHEN THERE IS NOTHING. An empty reading and a missing one are
 * different facts — the rule migration 062 needed and `[object Object]` broke. A caller that
 * stores `[]` for "the browser would not answer" has destroyed the distinction the sampler's
 * own `readNativeProfile` is careful to preserve by returning null.
 */
export function cleanSites(raw: unknown): AllocSite[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AllocSite[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const site = (s as { site?: unknown }).site;
    const bytes = (s as { bytes?: unknown }).bytes;
    if (typeof site !== 'string' || !site) continue;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) continue;
    out.push({ site: site.slice(0, MAX_SITE_CHARS), bytes: Math.round(bytes) });
    if (out.length >= MAX_SITES) break;
  }
  return out.length ? out : null;
}

/** A finite integer, or null. Anything else reaching a numeric column is a thrown INSERT. */
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Store one reading.
 *
 * NEVER THROWS INTO THE CALLER. This rides the hold feed's POST, and a diagnostic that can
 * fail a request the cart depends on is not worth having — the same rule `recordMemorySample`
 * follows, and the reason `sqlit` refusing a plain object matters: a rejected INSERT here must
 * be visible in the logs, not in a 500 on the feed.
 */
export async function recordNativeAlloc(input: NativeAllocInput): Promise<void> {
  const ctx = typeof input.context === 'string' && CONTEXTS.has(input.context)
    ? input.context : null;
  const sites = cleanSites(input.sites);
  await mutate(
    `INSERT INTO native_alloc_readings (context, ram_delta_mb, renderer_bytes, sites)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      ctx,
      int(input.ramDeltaMb),
      int(input.rendererBytes),
      // STRINGIFIED AT THE CALL SITE, because `sqlit` interpolates rather than binds and
      // hands a plain object to `String()` — which is how `[object Object]` switched off the
      // memory series for ten minutes on 2026-08-18. NULL, not '{}', when there is nothing.
      sites ? JSON.stringify(sites) : null,
    ],
  ).catch((e) => console.error('[native-alloc] recordNativeAlloc failed:', (e as Error).message));
}
