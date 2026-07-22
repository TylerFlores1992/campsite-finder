// Alert-health canary — runs inside the Fly poller (the real production vantage
// point, so it exercises the same proxy paths as live alerting) and stamps the
// `alert_canary` table (migration 016). /api/health/status reads those rows and a
// cron pages on staleness/failure.
//
// Two layers, both deliberately using the THROWING fetch functions — never the
// error-swallowing find*Open helpers, which return null on a transport failure and
// would let a dead source path pass the canary:
//   1. detect:<source> — a real availability/catalog fetch per source succeeded.
//   2. delivery:email / delivery:sms — Resend/Twilio actually accepted a synthetic
//      send to a dedicated canary address (proves the last mile, not just detection).
import { query, mutate } from '../src/lib/db/client';
import { getAvailabilityFromRecGov } from '../src/lib/availability/recgov';
import { hasReserveAmericaAvailabilityInRange } from '../src/lib/availability/reserveamerica';
import { fetchUnitTypes } from '../src/lib/sources/reservecalifornia/client';
import { fetchLocations } from '../src/lib/sources/goingtocamp/client';
import { fetchAvailabilityBatch } from '../src/lib/sources/tnsc/client';
import { USEDIRECT_PROVIDERS } from '../src/lib/sources/reservecalifornia/providers';
import { GOINGTOCAMP_PROVIDERS } from '../src/lib/sources/goingtocamp/providers';
import { TNSC_PROVIDERS } from '../src/lib/sources/tnsc/providers';
import { sendEmail } from '../src/lib/notifications/email';
import { sendSms } from '../src/lib/notifications/sms';

const PROBE_TIMEOUT_MS = 25_000;

/** ISO date `n` days from now (UTC). */
function isoInDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Fail a hung probe rather than let it stall the canary (most fetches also self-abort). */
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label}: timed out after ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS)
    ),
  ]);
}

/** Upsert one canary row, tracking a consecutive-failure streak for paging. */
async function record(key: string, ok: boolean, latencyMs: number, detail: string): Promise<void> {
  await mutate(
    `INSERT INTO alert_canary (key, ok, last_run_at, last_success_at, last_latency_ms, consecutive_failures, detail)
     VALUES ($1, $2, NOW(), CASE WHEN $2 THEN NOW() ELSE NULL END, $3, CASE WHEN $2 THEN 0 ELSE 1 END, $4)
     ON CONFLICT (key) DO UPDATE SET
       ok = EXCLUDED.ok,
       last_run_at = NOW(),
       last_success_at = CASE WHEN EXCLUDED.ok THEN NOW() ELSE alert_canary.last_success_at END,
       last_latency_ms = EXCLUDED.last_latency_ms,
       consecutive_failures = CASE WHEN EXCLUDED.ok THEN 0 ELSE alert_canary.consecutive_failures + 1 END,
       detail = EXCLUDED.detail`,
    [key, ok, latencyMs, detail.slice(0, 500)]
  ).catch((err) => console.error(`[canary] record ${key} failed:`, (err as Error).message));
}

/** Run one probe, time it, and stamp its row. Never throws (best-effort). */
async function probe(key: string, run: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await withTimeout(run(), key);
    await record(key, true, Date.now() - t0, detail);
  } catch (err) {
    await record(key, false, Date.now() - t0, (err as Error).message);
    console.warn(`[canary] ${key} FAILED: ${(err as Error).message}`);
  }
}

/**
 * Detection canary: one real, throwing fetch per source. For sources whose probe
 * needs a facility id (ridb, reserveamerica) we pick one from the catalog at
 * runtime (self-healing if the catalog changes); registry-based sources probe
 * their catalog/availability endpoint directly. A throw = that source's detection
 * path is down, which is exactly the silent failure this guards against.
 */
export async function runDetectionCanary(): Promise<void> {
  const from = isoInDays(45);
  const to = isoInDays(47);
  const month = from.slice(0, 7);

  const probes: Array<[string, () => Promise<string>]> = [];

  probes.push(['detect:ridb', async () => {
    // getAvailabilityFromRecGov SWALLOWS transport errors (returns empty), so a
    // throw can't signal an outage — assert real site data came back instead. But a
    // single campground routinely returns 0 sites (seasonal / outside booking
    // window / day-use facility), so that alone isn't "API down". Try the last
    // campground that worked (cheap steady state), then a random sample, and pass if
    // ANY returns campsite rows; fail only if the whole batch comes back empty — the
    // real signature of a rec.gov outage.
    const prior = await query<{ detail: string | null }>(
      `SELECT detail FROM alert_canary WHERE key = 'detect:ridb'`
    ).catch(() => [] as { detail: string | null }[]);
    const lastGood = prior[0]?.detail?.match(/id=(\S+)/)?.[1];
    const sample = await query<{ id: string }>(
      `SELECT id FROM campgrounds WHERE source = 'ridb' ORDER BY random() LIMIT 15`
    ).catch(() => [] as { id: string }[]);
    const candidates = [...(lastGood ? [lastGood] : []), ...sample.map((r) => r.id)];
    for (const id of candidates) {
      const a = await getAvailabilityFromRecGov(id, month);
      if (a.campsites.length > 0) {
        return `recgov reachable id=${id} ${month}: ${a.campsites.length} sites, ${a.availableCount} available`;
      }
    }
    throw new Error(`recgov: 0 campsites across ${candidates.length} campgrounds — API likely down`);
  }]);

  probes.push(['detect:reserveamerica', async () => {
    // RA's availability check THROWS on a transport failure, so a single real park
    // is a valid probe. Picks the lowest-id RA park (deterministic).
    const [ra] = await query<{ id: string }>(
      `SELECT id FROM campgrounds WHERE source = 'reserveamerica' ORDER BY id LIMIT 1`
    ).catch(() => [] as { id: string }[]);
    if (!ra) throw new Error('no reserveamerica campgrounds in catalog');
    const open = await hasReserveAmericaAvailabilityInRange(ra.id, from, to, 1);
    return `RA ${ra.id} ${from}: reachable (open=${open})`;
  }]);

  probes.push(['detect:reservecalifornia', async () => {
    const types = await fetchUnitTypes(USEDIRECT_PROVIDERS[0]);
    return `UseDirect ${USEDIRECT_PROVIDERS[0].source}: ${types.length} unit types`;
  }]);

  probes.push(['detect:goingtocamp', async () => {
    const locs = await fetchLocations(GOINGTOCAMP_PROVIDERS[0]);
    return `GTC ${GOINGTOCAMP_PROVIDERS[0].state}: ${locs.length} locations`;
  }]);

  probes.push(['detect:tnsc', async () => {
    const batch = await fetchAvailabilityBatch(TNSC_PROVIDERS[0], from, to);
    return `TNSC ${TNSC_PROVIDERS[0].state}: ${batch.size} parks (via ${process.env.TNSC_AVAILABILITY_URL ? 'proxy' : 'direct'})`;
  }]);

  await Promise.all(probes.map(([key, run]) => probe(key, run)));
}

/**
 * Delivery canary: prove Resend + Twilio actually ACCEPT a send, end to end,
 * without spamming a real user. Targets a dedicated `CANARY_EMAIL` / `CANARY_PHONE`
 * (skipped, and recorded as such, when unset). Runs on a slow cadence — this is the
 * only canary that sends, so keep it well below any provider rate concern.
 */
export async function runDeliveryCanary(): Promise<void> {
  const stamp = new Date().toISOString();
  const canaryEmail = process.env.CANARY_EMAIL;
  const canaryPhone = process.env.CANARY_PHONE;

  // Throttle to at most one real send per interval, ACROSS restarts. The poller calls
  // this once on every boot (so it fires soon after first setup), but without this
  // guard every deploy/restart would send a real SMS — which cost the operator a burst
  // of texts. We key off the last real delivery attempt recorded in the DB (skips don't
  // count), so N reboots inside one interval still send only once. The scheduled
  // interval tick is naturally older than the interval, so it always proceeds.
  const intervalMs = Number(process.env.CANARY_DELIVERY_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  const [last] = await query<{ last_run_at: string | null }>(
    `SELECT max(last_run_at)::text AS last_run_at FROM alert_canary
     WHERE key IN ('delivery:email', 'delivery:sms') AND detail NOT LIKE 'skipped%'`
  ).catch(() => [{ last_run_at: null }] as { last_run_at: string | null }[]);
  if (last?.last_run_at && Date.now() - Date.parse(last.last_run_at) < intervalMs * 0.9) {
    return; // a real delivery probe already ran this interval — don't re-send on reboot
  }

  if (canaryEmail) {
    await probe('delivery:email', async () => {
      await sendEmail({
        to: canaryEmail,
        subject: 'CampHawk canary — delivery OK',
        html: `<p>Synthetic alert-delivery canary. If you can page on this being MISSING, alerting's last mile is healthy.</p><p>${stamp}</p>`,
      });
      return `Resend accepted → ${canaryEmail} @ ${stamp}`;
    });
  } else {
    await record('delivery:email', false, 0, 'skipped: CANARY_EMAIL not set');
  }

  if (canaryPhone) {
    await probe('delivery:sms', async () => {
      await sendSms({ to: canaryPhone, body: `CampHawk canary — SMS delivery OK ${stamp}` });
      return `Twilio accepted → ${canaryPhone} @ ${stamp}`;
    });
  } else {
    await record('delivery:sms', false, 0, 'skipped: CANARY_PHONE not set');
  }
}
