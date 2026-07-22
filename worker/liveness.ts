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

let lastAliveAt = Date.now();

/** Record that the poller just successfully wrote a heartbeat to the DB. */
export function markAlive(): void {
  lastAliveAt = Date.now();
}

/** Milliseconds since the last successful heartbeat write. */
export function msSinceAlive(): number {
  return Date.now() - lastAliveAt;
}
