// RING THE PHONE WHEN NOTHING IS GOING TO CART THE HOLD.
//
// ── WHY THIS FILE EXISTS (2026-08-17) ──────────────────────────────────────────────────
// A test hold released at 08:00 PT and was never carted. The RC session was fine, the login
// rehearsal had passed the night before, the renewal had re-minted a token unattended, and
// `bot.mjs` answered diagnostics throughout. The hold runner had simply hard-crashed at
// 05:36:31 with exit code -1073740791 — the Windows fast-fail `abort()` produces — and
// NOTHING BROUGHT IT BACK for two and a half hours.
//
// The watchdog that fires every five minutes for exactly this never spoke, because it was
// never invoked: `auto-update.log`, a separate Scheduled Task on the same cadence, stops
// dead at 05:31:03 too. Two independent tasks silent together is the scheduler underneath
// them, not either task.
//
// The owner found out by setting an alarm clock, and the alarm that DID ring that morning
// was about the session — which was healthy — and its printed remedy would have killed it.
//
// ── WHY IT IS HERE AND NOT IN THE HOLD FEED ────────────────────────────────────────────
// `alarmIfSessionUnusable` lives in `GET /api/auto-cart/rc-holds`, i.e. it runs when the
// runner polls. That is fine for a dead SESSION, which is reported by a live keep-warm. It
// cannot work for a dead RUNNER: the poll is the thing that has stopped, so the alarm is
// wired to the fault it is meant to announce. Fourth time in this codebase — see the header
// of `expire-holds.ts`, which was moved here for the identical reason and is the precedent
// this file follows deliberately.
//
// The Fly worker is always up, is on different hardware in a different city, and has no
// dependency whatsoever on the mini-PC. That is the entire qualification for the job.

import { query } from '../src/lib/db/client';
import { holdAtRisk } from '../src/lib/rc-holds';
import { alarmCall, type Scheduler } from '../src/lib/notifications/voice';

/** Cheap: two indexed reads. Five minutes would also do; two keeps the worst case tight. */
export const RUNNER_WATCH_INTERVAL_MS = Number(process.env.RUNNER_WATCH_INTERVAL_MS ?? 2 * 60 * 1000);

/**
 * How long the runner must be silent before we call it DEAD rather than restarting.
 *
 * IT IS NOT `RC_RUNNER_STALE_MS` (3 min), and the difference is the whole design. That
 * number decides whether to show amber on a dashboard and whether to OFFER a hold; this one
 * decides whether to wake a human. It has to clear every way the box legitimately goes quiet
 * for a few minutes:
 *
 *   - `supervise.ps1` backs off exponentially to a 300s cap, so a crash-and-restart can
 *     legitimately cost five minutes of silence and fix itself with nobody involved.
 *   - `restart-rc`, `kill-chrome` and `rc-login.bat` all stop the runner briefly.
 *
 * Fifteen minutes is three times the supervisor's worst backoff, so a beat this old means
 * the restart is not coming. AN UPDATE CANNOT EXPLAIN IT EITHER: the update guard refuses
 * within six hours of a release, and this only ever fires inside `ALARM_LEAD_MIN` of one, so
 * the two windows cannot overlap. That is why there is no update stand-down here — not
 * because it was forgotten.
 */
export const RUNNER_DEAD_MS = Number(process.env.RUNNER_DEAD_MS ?? 15 * 60 * 1000);

/**
 * How close the release has to be. Shared with the session alarm's `AUTOCART_ALARM_LEAD_MIN`
 * on purpose — the phone is ringing for the same reason (a hold is about to be lost) at the
 * same distance, and two different leads for one concept is how the T−30/T−25 gap opened on
 * 2026-08-11.
 *
 * A WIDER LEAD IS TEMPTING AND WRONG. Unlike a dead session there is no automated repair to
 * wait for, so waiting buys nothing — except not ringing at 03:00 for an 08:00 release, and
 * holds are routinely tapped the evening before. That is the only thing the lead is doing
 * here, and it is worth stating because the obvious "no repair is coming, so ring at once"
 * argument leads straight to a 3am call about a problem that keeps until seven.
 */
export const ALARM_LEAD_MIN = Number(process.env.AUTOCART_ALARM_LEAD_MIN || 45);

export interface RunnerWatchResult {
  /** What happened, for the log and for the tests. Never thrown. */
  outcome: 'no-hold' | 'runner-alive' | 'no-beat' | 'alarmed' | 'not-called' | 'read-failed';
  detail: string;
}

/**
 * Decide whether the phone should ring, and ring it.
 *
 * `now`, `deps` and `schedule` are injected so the decision is testable without a database,
 * a Twilio account or a fifteen-minute wait. The two decisions that have been wrong in
 * production before — how stale is dead, and how close is close — are pure arithmetic here
 * rather than buried in a call chain, which is the same reasoning that pulled
 * `session-coverage.mjs` and `relogin-retry.mjs` out of their loops.
 */
export async function checkRunner(deps?: {
  beatAt?: () => Promise<string | null>;
  atRisk?: typeof holdAtRisk;
  call?: typeof alarmCall;
  now?: number;
  schedule?: Scheduler;
}): Promise<RunnerWatchResult> {
  const now = deps?.now ?? Date.now();
  const atRisk = deps?.atRisk ?? holdAtRisk;
  const call = deps?.call ?? alarmCall;

  // THE HOLD IS ASKED ABOUT FIRST, AND THAT ORDERING IS DELIBERATE. The runner is
  // legitimately silent whenever the box is off, being updated, or simply between releases,
  // and staleness alone must never ring — that is the cry-wolf rule every alarm in this
  // codebase has had to learn once. No hold, no question.
  let at: Awaited<ReturnType<typeof holdAtRisk>>;
  try {
    at = await atRisk(ALARM_LEAD_MIN);
  } catch (err) {
    return { outcome: 'read-failed', detail: `hold lookup failed: ${(err as Error).message}` };
  }
  if (!at) return { outcome: 'no-hold', detail: 'no hold within the lead — nothing to lose' };

  let beat: string | null;
  try {
    beat = deps?.beatAt ? await deps.beatAt() : await readBeat();
  } catch (err) {
    // A FAILED READ IS NOT EVIDENCE OF A DEAD RUNNER. Ringing on it would turn every
    // database blip into a phone call, and this alarm's whole value is that it is believed.
    // Same rule as `hasAvailabilityInRange` returning null and `oktaSessionAlive`'s unknown
    // never being reported as dead.
    return { outcome: 'read-failed', detail: `heartbeat read failed: ${(err as Error).message}` };
  }

  const ageMs = beat ? now - new Date(beat).getTime() : null;
  if (ageMs !== null && ageMs <= RUNNER_DEAD_MS) {
    return {
      outcome: 'runner-alive',
      detail: `runner beat ${Math.round(ageMs / 60_000)}m ago, hold ${at.hold.id} in ${Math.round(at.minutesAway)}m`,
    };
  }

  // NO ROW AT ALL is treated as dead only because a hold is in range: the table is seeded
  // with one row by migration 045, so an empty read means something is wrong, and with a
  // release inside the lead the safe direction is to ring.
  const staleFor = ageMs === null ? 'never' : `${Math.round(ageMs / 60_000)}m`;

  const where = at.campground ?? 'a campground';
  const site = at.hold.unit_name ? ` site ${at.hold.unit_name}` : '';
  const time = at.hold.release_at.slice(11, 16);
  // NAME THE RIGHT FAULT AND THE RIGHT REMEDY. On 2026-08-17 the phone rang about a healthy
  // session and told the owner to run `rc-login.bat`, which force-kills the Chromium the
  // access token lives in — the remedy would have destroyed the thing it was complaining
  // about. This fault is different: the session may be perfectly fine and the process that
  // uses it is gone, so the instruction is to restart the runner, not to sign in.
  //
  // Written for someone who was asleep four seconds ago: what is wrong, what is at stake,
  // what to do, instruction last so it is what is still in their ear when it repeats.
  const spoken =
    `CampHawk alert. The Reserve California hold runner has stopped, and ${where}${site} ` +
    `releases at ${time}. Nothing is going to cart it. ` +
    `Go to the mini P C and run start all dot bat.`;

  const to = process.env.AUTOCART_ALARM_PHONE || at.phone;
  // Keyed on the HOLD and prefixed distinctly from the session alarm. A per-attempt key
  // would hand every two-minute tick its own budget and turn one dead runner into a call
  // every two minutes all night, which is the exact defect `voice.ts` records against its
  // own rate limit.
  const r = await call(to, spoken, `rc-runner:${at.hold.id}`, deps?.schedule);
  const detail =
    `runner silent for ${staleFor}, hold ${at.hold.id} releases in ${Math.round(at.minutesAway)}m: ` +
    `${r.placed ? 'CALLING' : `not called — ${r.error}`}`;
  return { outcome: r.placed ? 'alarmed' : 'not-called', detail };
}

async function readBeat(): Promise<string | null> {
  const rows = await query<{ beat_at: string | null }>(
    `SELECT beat_at::text AS beat_at FROM rc_runner_heartbeat WHERE id = 1`,
  );
  return rows[0]?.beat_at ?? null;
}
