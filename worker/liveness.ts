// Shared in-process liveness signal for the Fly machine self-heal.
//
// Why this exists: on 2026-07-22 a Fly machine's networking wedged while the
// process stayed "started" — every outbound fetch (rec.gov, and even Supabase)
// timed out, so the poller couldn't write a heartbeat, canaries went stale, and
// alerting was silently dead for ~30 min until a human restarted the machine.
// A plain process-liveness check (the old unconditional `/health` → {ok:true})
// cannot catch this: the process is up, it just can't do its job.
//
// The fix: `markAlive()` is called ONLY after a heartbeat row is successfully
// written to the DB — proof the poller is both cycling AND has working egress.
// Two consumers read the staleness:
//   1. worker/http-server.ts `/health` reports 503 once stale (for the Fly HTTP
//      check, the load balancer, and the external uptime monitor).
//   2. worker/poller.ts runs a watchdog that `process.exit(1)`s on a sustained
//      wedge, so Fly reboots the microVM (re-establishing networking, exactly
//      like a manual `flyctl machine restart`) with no human in the loop.
//
// Tied to a successful DB write rather than "a cycle ran" on purpose: a wedge
// makes the write throw, so liveness correctly goes stale.
//
// SECOND signal — external egress (issue #14, the "timeout cascade"). The heartbeat
// above only proves Supabase egress works. In the cascade, rec.gov degrades to slow
// timeouts that starve the socket pool so EVERY provider fetch times out, yet the
// Supabase heartbeat write still succeeds — so `msSinceAlive()` stays fresh and the
// heartbeat watchdog never fires while alerting is silently dead. An external outcome
// is recorded whenever a provider fetch resolves (via the detection canary, which
// probes all sources every ~2 min). It stays healthy as long as sources are reachable —
// so a rec.gov-only throttle does NOT trip it (a reboot wouldn't clear an IP throttle
// anyway), but the all-sources-down cascade/wedge does.
//
// TWO external signals, because "zero successes for X min" alone misses a FLAPPING
// wedge — observed 2026-07-24, when the sjc machine's egress degraded so ~all detects
// timed out, but an occasional source succeeding kept resetting the zero-success timer,
// so the watchdog never fired and a human had to restart:
//   (a) staleness — `msSinceExternalFetchOk()`: catches a hard wedge / the canary
//       stopping entirely (no successes at all for a long stretch).
//   (b) failure-rate — `externalFetchWedged()`: over a rolling window, if there were
//       enough attempts and MOST failed, the machine is wedged even though the odd
//       success keeps (a) from tripping. This is what catches the flapping case.

let lastAliveAt = Date.now();
let lastExternalOkAt = Date.now();

/** Rolling record of recent external fetch outcomes (detection-canary probes). */
const externalOutcomes: Array<{ t: number; ok: boolean }> = [];
const OUTCOMES_CAP = 200; // ~5 sources × plenty of rounds; bounded regardless of window

/** Record that the poller just successfully wrote a heartbeat to the DB. */
export function markAlive(): void {
  lastAliveAt = Date.now();
}

/** Milliseconds since the last successful heartbeat write. */
export function msSinceAlive(): number {
  return Date.now() - lastAliveAt;
}

/** Record the outcome of one external provider fetch (detection-canary probe). */
export function markExternalFetchResult(ok: boolean): void {
  const now = Date.now();
  if (ok) lastExternalOkAt = now;
  externalOutcomes.push({ t: now, ok });
  if (externalOutcomes.length > OUTCOMES_CAP) externalOutcomes.shift();
}

/** Milliseconds since the last successful external provider fetch. */
export function msSinceExternalFetchOk(): number {
  return Date.now() - lastExternalOkAt;
}

/** True when, over the last `windowMs`, there were at least `minAttempts` external
 *  fetches and the failure ratio was >= `maxFailRatio` — i.e. egress is mostly dead
 *  even if the occasional success keeps `msSinceExternalFetchOk` from going stale.
 *  Returns false until enough attempts accrue, so it can't trip on a quiet window. */
export function externalFetchWedged(
  windowMs: number,
  minAttempts: number,
  maxFailRatio: number
): boolean {
  const cutoff = Date.now() - windowMs;
  let attempts = 0;
  let failures = 0;
  for (const o of externalOutcomes) {
    if (o.t < cutoff) continue;
    attempts++;
    if (!o.ok) failures++;
  }
  if (attempts < minAttempts) return false;
  return failures / attempts >= maxFailRatio;
}
