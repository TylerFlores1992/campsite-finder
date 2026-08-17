/**
 * Cut power to the mini-PC and bring it back, from off the box.
 *
 * ## Why this exists
 *
 * On 2026-08-17 the box ran ZERO processes for over an hour and nothing could reach it.
 * Every remote lever rides a process on that machine — `bot_commands` needs `bot.mjs`, the
 * watchdog needs Task Scheduler, `restart-rc` needs a poller — so with nothing running there
 * is nothing to receive an instruction. That is structural: no software installed on a
 * machine can fix "the machine is running nothing".
 *
 * The lever therefore lives out here, on a cloud smart plug. Same argument that moved
 * `expire-holds` off the hold feed and onto Fly, one step further out: a watchdog must not
 * ride the thing it watches, and a power switch must not ride the thing it power-cycles.
 *
 * ## This is the most destructive thing the system can do
 *
 * It can interrupt a cart mid-flight, and it can corrupt the Chromium profile that holds
 * RC's `DT` device cookie — the thing that lets Okta skip the email step and is why
 * unattended login works at all. Losing that profile has previously cost a 12-hour block on
 * the household IP. So every gate below fails CLOSED, and the whole thing is a button rather
 * than an automation: an automatic hard cut on a misread is worse than the outage it treats.
 *
 * ## The precondition nobody can check from here
 *
 * The BIOS must be set to power on after AC loss. If it is not, cutting power turns a
 * dark-but-running box into a powered-OFF box and this lever has made things strictly worse.
 * Nothing in software can verify that, which is why `docs/CONTEXT.md` records it beside the
 * plug's setup rather than leaving it to be discovered at 07:50.
 */

import 'server-only';
import { query, mutate } from '@/lib/db/client';

/** How long the box must have been silent before a cut is even considered. A power cycle on
 *  a healthy box is vandalism, and the whole justification is "nothing is running". */
export const POWER_CYCLE_MIN_SILENT_MS = Number(process.env.POWER_CYCLE_MIN_SILENT_MS ?? 10 * 60_000);

/** Never more than one cut in this window. A reboot loop is strictly worse than a dark box:
 *  a dark box is one trip to fix, whereas a box cut every ten minutes may never finish
 *  booting — and every cycle is another chance to corrupt the profile. */
export const POWER_CYCLE_COOLDOWN_MS = Number(process.env.POWER_CYCLE_COOLDOWN_MS ?? 2 * 60 * 60_000);

/** Seconds the power stays off. Long enough for the PSU to drain and the board to see a real
 *  loss; short enough that a watching human does not assume it failed. */
export const POWER_OFF_SECONDS = Number(process.env.POWER_OFF_SECONDS ?? 10);

export interface PowerCycleResult {
  ok: boolean;
  detail: string;
}

/** Is the plug configured at all? Deliberately separate from doing anything, so the admin
 *  page can hide or explain the control instead of offering a button that 503s. */
export function powerPlugConfigured(): boolean {
  return Boolean(process.env.SHELLY_AUTH_KEY && process.env.SHELLY_DEVICE_ID && process.env.SHELLY_SERVER);
}

/**
 * Seconds since anything on the box last spoke, or null if we cannot tell.
 *
 * NULL IS A REFUSAL, NEVER A REASON. An unreadable heartbeat means "we could not tell", and
 * cutting power on that is the same class of error as reporting a live RC session dead — the
 * difference being that this one is not recoverable by waiting. Same rule as `unknown` never
 * rounding to `signed-out`.
 *
 * Reads the RUNNER's beat rather than a union of every signal: it is the process that carts,
 * it polls every 15s, and `beatIsFromRunner` already keeps other callers from stamping it.
 */
export async function boxSilentMs(): Promise<number | null> {
  const rows = await query<{ age_ms: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - beat_at)) * 1000 AS age_ms
       FROM rc_runner_heartbeat WHERE id = 1`,
  ).catch(() => []);
  const age = rows[0]?.age_ms;
  return typeof age === 'number' && Number.isFinite(age) ? age : null;
}

/**
 * Why we must NOT cut power right now, or null if it is allowed.
 *
 * Every branch returns a sentence a human can act on, because this refusal is read at 07:50
 * by somebody deciding whether to drive to the machine.
 */
export async function powerCycleRefusal(silentMs: number | null): Promise<string | null> {
  if (!powerPlugConfigured()) {
    return 'no smart plug configured — set SHELLY_SERVER, SHELLY_DEVICE_ID and SHELLY_AUTH_KEY.';
  }
  if (silentMs == null) {
    return 'could not read the runner heartbeat, so we cannot tell whether the box is dead. ' +
      'Refusing: cutting power on an unknown is not recoverable by waiting.';
  }
  if (silentMs < POWER_CYCLE_MIN_SILENT_MS) {
    return `the box spoke ${Math.round(silentMs / 1000)}s ago — it is alive. A power cut is for ` +
      `a box running nothing, not a slow one. Try restart-rc or the update path first.`;
  }

  // A CART IN FLIGHT OUTRANKS EVERYTHING. `carted`/`claiming` means we are holding a real
  // campsite in a real cart for someone who is mid-hand-off; cutting power there loses the
  // site AND the evidence. A dark box costs a morning, this costs somebody their booking.
  const holds = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM rc_hold_requests WHERE status IN ('carted','claiming')`,
  ).catch(() => null);
  if (holds == null) {
    return 'could not read the hold table, so we cannot tell whether a cart is in flight. Refusing.';
  }
  if ((holds[0]?.n ?? 0) > 0) {
    return `${holds[0].n} hold(s) are carted or being claimed right now — a power cut would drop ` +
      'a site somebody is in the middle of taking. Refusing.';
  }

  // THE RATE LIMIT IS READ FROM THE TABLE, not from memory. This runs in a request handler
  // that may be a fresh lambda every time, so in-process state would bound nothing at all.
  const recent = await query<{ at: string }>(
    `SELECT requested_at::text AS at FROM power_cycles
      WHERE requested_at > NOW() - ($1 || ' milliseconds')::interval
      ORDER BY requested_at DESC LIMIT 1`,
    [String(POWER_CYCLE_COOLDOWN_MS)],
  ).catch(() => null);
  if (recent == null) {
    return 'could not read the power-cycle log, so the rate limit cannot be enforced. Refusing.';
  }
  if (recent.length) {
    const mins = Math.round(POWER_CYCLE_COOLDOWN_MS / 60_000);
    return `power was already cut at ${recent[0].at} — one cut per ${mins} min. If that one did ` +
      'not bring it back, another will not either: it needs a human at the machine.';
  }
  return null;
}

/** One Shelly cloud call. Kept tiny and separate so the sequencing above can be tested
 *  without touching the network. */
async function shelly(turn: 'on' | 'off'): Promise<{ ok: boolean; detail: string }> {
  const server = String(process.env.SHELLY_SERVER).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const body = new URLSearchParams({
    id: String(process.env.SHELLY_DEVICE_ID),
    auth_key: String(process.env.SHELLY_AUTH_KEY),
    channel: '0',
    turn,
  });
  try {
    const r = await fetch(`https://${server}/device/relay/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await r.text()).slice(0, 300);
    return { ok: r.ok, detail: `${turn}: HTTP ${r.status} ${text}` };
  } catch (e) {
    // NAMED, not swallowed. "The plug did not answer" and "the plug said no" need different
    // responses, and a cut we merely THINK we made is the worst outcome — the rate limit
    // spends its budget and the box is still dark.
    return { ok: false, detail: `${turn}: request failed — ${(e as Error).message}` };
  }
}

/**
 * Cut power, wait, restore it. Logs whatever happened, including a refusal.
 *
 * THE POWER IS ALWAYS TURNED BACK ON, even if the OFF call reported failure. A plug left off
 * is the one outcome strictly worse than the outage: the box cannot boot, and the next lever
 * after this one is a car journey.
 */
export async function powerCycle(by: string): Promise<PowerCycleResult> {
  const silentMs = await boxSilentMs();
  const refusal = await powerCycleRefusal(silentMs);
  if (refusal) return { ok: false, detail: refusal };

  const off = await shelly('off');
  await new Promise((r) => setTimeout(r, POWER_OFF_SECONDS * 1000));
  const on = await shelly('on');
  const ok = off.ok && on.ok;
  const detail = `${off.detail} | waited ${POWER_OFF_SECONDS}s | ${on.detail}`;

  await mutate(
    `INSERT INTO power_cycles (requested_by, reason, silent_s, ok, detail) VALUES ($1,$2,$3,$4,$5)`,
    [
      by.slice(0, 80),
      `runner silent for ${Math.round((silentMs ?? 0) / 1000)}s`,
      Math.round((silentMs ?? 0) / 1000),
      ok,
      detail.slice(0, 500),
    ],
  ).catch((e) => console.error('[power-cycle] could not log:', (e as Error).message));

  return { ok, detail };
}
