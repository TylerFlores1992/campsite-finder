// The full-day rec.gov 429 profile (2026-08-01).
//
// WHY. The 15/min budget in recgov-scheduler.ts was measured almost entirely in
// quiet hours, and every rate decision this project has made from a partial window
// has been wrong at least once (the sjc "IP reputation" theory, the time-of-day 429
// claim, both revised). Before a sub-15s hot lane is promised to paying Auto-Cart
// subscribers, this recorder captures what rec.gov actually does to this machine's
// traffic across a whole day — per 5-minute bucket, split into what REC.GOV did
// (ok / 429 / timeout / error) versus what OUR OWN machinery did (budget denials,
// breaker skips). A clean day at full budget = headroom for a faster lane; 429
// clusters at specific hours = the budget must flex by hour instead.
//
// Deliberately dumb: in-memory counters, one accumulating upsert per flush, counters
// restored on a failed flush so a DB blip loses nothing. Registered by the poller at
// boot; the observer in recgov.ts is null everywhere else (Vercel records nothing).
//
// Readout: NODE_USE_ENV_PROXY=1 npx tsx scripts/recgov-429-profile.mts

import { mutate } from '../src/lib/db/client';
import { setRecgovFetchObserver } from '../src/lib/availability/recgov';

export type RateEvent = 'ok' | '429' | 'timeout' | 'error' | 'denied' | 'breaker_skipped';

const FLUSH_MS = Number(process.env.RECGOV_PROFILE_FLUSH_MS ?? 5 * 60_000);
const RETENTION_DAYS = Number(process.env.RECGOV_PROFILE_RETENTION_DAYS ?? 14);
const MACHINE_ID = process.env.FLY_MACHINE_ID ?? `local-${process.pid}`;

const zero = () => ({ ok: 0, '429': 0, timeout: 0, error: 0, denied: 0, breaker_skipped: 0 });
let counts: Record<RateEvent, number> = zero();
let lastPruneAt = 0;

/** Cheap enough to call from the scheduler's hot path — a map increment. */
export function recordRateEvent(e: RateEvent): void {
  counts[e]++;
}

async function flush(now = Date.now()): Promise<void> {
  const snapshot = counts;
  if (Object.values(snapshot).every((n) => n === 0)) return;
  counts = zero();
  const bucket = new Date(Math.floor(now / FLUSH_MS) * FLUSH_MS).toISOString();
  try {
    await mutate(
      `INSERT INTO recgov_rate_profile
         (bucket_start, machine_id, ok, throttled_429, timeout, error, denied, breaker_skipped)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (bucket_start, machine_id) DO UPDATE SET
         ok              = recgov_rate_profile.ok              + EXCLUDED.ok,
         throttled_429   = recgov_rate_profile.throttled_429   + EXCLUDED.throttled_429,
         timeout         = recgov_rate_profile.timeout         + EXCLUDED.timeout,
         error           = recgov_rate_profile.error           + EXCLUDED.error,
         denied          = recgov_rate_profile.denied          + EXCLUDED.denied,
         breaker_skipped = recgov_rate_profile.breaker_skipped + EXCLUDED.breaker_skipped,
         updated_at      = NOW()`,
      [bucket, MACHINE_ID, snapshot.ok, snapshot['429'], snapshot.timeout, snapshot.error,
       snapshot.denied, snapshot.breaker_skipped]
    );
  } catch (err) {
    // Put the counts back — a DB blip must not erase five minutes of profile. The
    // next flush lands them in its own bucket; slight bucket skew beats a hole.
    for (const k of Object.keys(snapshot) as RateEvent[]) counts[k] += snapshot[k];
    console.error('[rate-profile] flush failed (counts retained):', (err as Error).message);
    return;
  }
  if (now - lastPruneAt > 24 * 60 * 60 * 1000) {
    lastPruneAt = now;
    await mutate(
      `DELETE FROM recgov_rate_profile WHERE bucket_start < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    ).catch((err) => console.error('[rate-profile] prune failed:', (err as Error).message));
  }
}

/** Called once by the poller at boot. Idempotent-enough: a second call just
 *  re-registers the same observer and adds a timer, which boot code never does. */
export function startRateProfile(): void {
  setRecgovFetchObserver((outcome) => recordRateEvent(outcome));
  setInterval(() => void flush(), FLUSH_MS);
  console.log(
    `[rate-profile] recording rec.gov outcomes per ${FLUSH_MS / 1000}s bucket (machine ${MACHINE_ID}, retention ${RETENTION_DAYS}d)`
  );
}

/** Tests only. */
export function __rateProfileCounts(): Record<RateEvent, number> {
  return { ...counts };
}
export function __rateProfileFlush(now?: number): Promise<void> {
  return flush(now);
}
