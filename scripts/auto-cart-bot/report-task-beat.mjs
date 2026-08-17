/**
 * "This Windows Scheduled Task just fired." One line, from a `.ps1`, to the server.
 *
 *   node report-task-beat.mjs watchdog "healthy"
 *   node report-task-beat.mjs auto-update "SKIP - outside the quiet window"
 *
 * ── WHY (2026-08-17) ───────────────────────────────────────────────────────────────────
 * The hold runner crashed at 05:36:31 PT and stayed dead for two and a half hours. The
 * watchdog fires every five minutes for precisely that and never spoke — because it was
 * never invoked. `auto-update.log`, a separate task on the same cadence, stops dead at
 * 05:31:03 in the same way, and two independent tasks going silent together is the layer
 * underneath them rather than either task.
 *
 * None of that was visible anywhere. `watchdog.ps1` is deliberately SILENT when the box is
 * healthy, so "the watchdog ran and found nothing wrong" and "the watchdog never ran" write
 * the identical thing to `restarts.log`: nothing. The only reason the outage was diagnosed
 * at all is that the OTHER task happens to log on every run.
 *
 * So the task reports for itself, exactly as `rc-keepwarm` posts its own session verdict
 * instead of having a watcher infer it. The process that knows is the process that reports.
 *
 * ── IT MUST NEVER BE THE REASON A TASK FAILS ───────────────────────────────────────────
 * This is a diagnostic bolted to the front of the supervisor of last resort. Every failure
 * path here — no token, no network, a 500, a timeout — prints one line and exits ZERO. A
 * beat that cannot be delivered is worth nothing; a watchdog that does not run because its
 * telemetry threw is worth less than nothing, and would be a self-inflicted version of the
 * outage this exists to report.
 *
 * `exitWhenDrained` rather than `process.exit`, for the reason `exit-clean.mjs` documents at
 * length: a hard exit with an undici keep-alive socket still closing trips
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on Windows, which is noise a
 * reader cannot tell from a real failure — and `auto-update.log` is full of exactly that
 * line today.
 */
import { loadEnv } from './load-env.mjs';
import { exitWhenDrained } from './exit-clean.mjs';

loadEnv(import.meta.url);

const [task, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ').trim() || null;

const BASE = process.env.CAMPHAWK_URL || 'https://camphawk.app';
const TOKEN = process.env.AUTOCART_TOKEN;

if (!task) {
  console.error('[task-beat] no task name given - nothing reported');
  exitWhenDrained(0);
} else if (!TOKEN) {
  // A WINDOWS SCHEDULED TASK HAS NO PARENT ENVIRONMENT TO INHERIT FROM, which is why
  // `loadEnv` is called above and why this case is named rather than left to produce a 401.
  // `auto-update.ps1` reported every run and was answered 401 for weeks for exactly this,
  // and the symptom was indistinguishable from the task never having been registered.
  console.error('[task-beat] AUTOCART_TOKEN missing (checked the shell and .env) - nothing reported');
  exitWhenDrained(0);
} else {
  try {
    const r = await fetch(`${BASE}/api/auto-cart/task-beat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task, note }),
      // Short: this runs in front of the watchdog's real work, and a slow network must not
      // delay a restart. The beat is the cheap half of the bargain.
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[task-beat] ${task} -> HTTP ${r.status}${r.ok ? '' : ` ${(await r.text().catch(() => '')).slice(0, 200)}`}`);
  } catch (err) {
    console.error(`[task-beat] ${task} -> could not report: ${err.message}`);
  }
  exitWhenDrained(0);
}
