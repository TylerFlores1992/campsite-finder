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
export type PlugVendor = 'shelly' | 'switchbot';

const shellySet = () =>
  Boolean(process.env.SHELLY_AUTH_KEY && process.env.SHELLY_DEVICE_ID && process.env.SHELLY_SERVER);
const switchbotSet = () =>
  Boolean(process.env.SWITCHBOT_TOKEN && process.env.SWITCHBOT_SECRET && process.env.SWITCHBOT_DEVICE_ID);

/**
 * Which plug we drive, decided by which credentials are present.
 *
 * TWO VENDORS BECAUSE THE HARDWARE IS BOUGHT BY A PERSON, under whatever delivery date they
 * can get. Tying the recovery lever to one brand means an outage waits on a courier. Both
 * have PUBLISHED APIs, which is the actual requirement — Kasa, Meross and Wyze were rejected
 * for having only reverse-engineered ones, and a lever you reach for at 07:50 must not depend
 * on an endpoint that can change without notice.
 *
 * BOTH CONFIGURED IS A REFUSAL, NOT A PREFERENCE. Picking one of two plugs by an ordering
 * rule nobody remembers means cutting power to whatever is plugged into the other — and the
 * whole point of this module is that the act is irreversible from here. Ambiguity about
 * WHICH physical thing loses power is the one input that must never be resolved silently.
 */
export function plugVendor(): PlugVendor | null | 'ambiguous' {
  if (shellySet() && switchbotSet()) return 'ambiguous';
  if (shellySet()) return 'shelly';
  if (switchbotSet()) return 'switchbot';
  return null;
}

export function powerPlugConfigured(): boolean {
  return plugVendor() === 'shelly' || plugVendor() === 'switchbot';
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
  const vendor = plugVendor();
  if (vendor === 'ambiguous') {
    return 'BOTH a Shelly and a SwitchBot are configured, so we cannot tell which physical ' +
      'plug to cut. Refusing: unplugging the wrong thing is not undoable from here. Clear one set.';
  }
  if (!vendor) {
    return 'no smart plug configured — set either SHELLY_SERVER/SHELLY_DEVICE_ID/SHELLY_AUTH_KEY ' +
      'or SWITCHBOT_TOKEN/SWITCHBOT_SECRET/SWITCHBOT_DEVICE_ID.';
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

/**
 * One Shelly cloud call. Kept tiny and separate so the sequencing above can be tested
 * without touching the network.
 *
 * THE v2 ENDPOINT, NOT `/device/relay/control`. The first version of this used the legacy
 * one, and that was a defect found by the owner asking a question I should have asked
 * myself: Shelly's own documentation says that API "is **deprecated** and will be removed in
 * the near future", and it documents Gen1 and Gen2 only — no mention of Gen3 or Gen4. So it
 * would have failed on any current plug, and eventually on every plug.
 *
 * `POST /v2/devices/api/set/switch` is documented to work for "all types and generations of
 * relays and plugs", which is the property that matters here: the hardware is bought once,
 * by a person, and a lever that only works with a discontinued generation is a lever that
 * quietly stops existing. JSON body, `auth_key` in the query string, 200 with no body on
 * success.
 */
/**
 * SwitchBot Plug Mini, via the official Open API v1.1.
 *
 * NO HUB. That was checked rather than assumed: SwitchBot's own README requires a Hub "for
 * BLE-based devices such as Bot and Curtain", and the Plug Mini is WiFi, so the requirement
 * does not reach it. The Amazon listing says the same thing, but a listing is marketing copy
 * about the APP and this is a question about the API — different claims, and only one of them
 * decides whether this code can work.
 *
 * THE SIGNATURE IS PLAIN BASE64, NOT UPPERCASED, AND THAT IS DELIBERATE. SwitchBot's prose
 * says "convert the signature to upper case" while their own JavaScript example does not, and
 * their PHP and Go examples do. Base64 is case-sensitive, so those cannot all be right. This
 * follows the JS sample verbatim, which is the language we are in and what the working Node
 * clients do. **If auth ever fails with a signature error, try uppercasing before suspecting
 * anything else** — and do not "tidy" this by adding .toUpperCase() on the strength of the
 * prose alone.
 */
/**
 * The v1.1 auth headers, and there is exactly ONE of these on purpose.
 *
 * `plugStatus` exists to prove these credentials work BEFORE the night we need the cut. That
 * proof is only worth having if the status read signs identically to the command — give the
 * two their own copies and a green status check stops saying anything about whether the cut
 * can authenticate, which is the one question it was added to answer. The test pins both
 * callers onto this function for that reason.
 */
async function switchbotAuth(): Promise<Record<string, string>> {
  const { createHmac, randomUUID } = await import('node:crypto');
  const token = String(process.env.SWITCHBOT_TOKEN);
  const secret = String(process.env.SWITCHBOT_SECRET);
  const t = Date.now();
  const nonce = randomUUID();
  const sign = createHmac('sha256', secret).update(token + t + nonce).digest('base64');
  return { Authorization: token, sign, nonce, t: String(t), 'Content-Type': 'application/json' };
}

async function switchbot(turn: 'on' | 'off'): Promise<{ ok: boolean; detail: string }> {
  const headers = await switchbotAuth();
  const id = encodeURIComponent(String(process.env.SWITCHBOT_DEVICE_ID));
  try {
    const r = await fetch(`https://api.switch-bot.com/v1.1/devices/${id}/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ command: turn === 'on' ? 'turnOn' : 'turnOff', parameter: 'default', commandType: 'command' }),
      signal: AbortSignal.timeout(15_000),
    });
    // SwitchBot answers 200 with a JSON body carrying its OWN statusCode, so an HTTP 200 is
    // not success — the same trap as RC returning 200 with IsSuccess:false, and as
    // `notifications.status = 'sent'` meaning only "Twilio returned 2xx". Read the payload.
    const text = (await r.text().catch(() => '')).slice(0, 300);
    let inner: number | null = null;
    try { inner = JSON.parse(text)?.statusCode ?? null; } catch { /* keep the raw text */ }
    return { ok: r.ok && inner === 100, detail: `${turn}: HTTP ${r.status} ${text}` };
  } catch (e) {
    return { ok: false, detail: `${turn}: request failed — ${(e as Error).message}` };
  }
}

/** Dispatch to whichever plug is configured. `powerCycleRefusal` has already rejected the
 *  unconfigured and ambiguous cases, so reaching here with neither set is a bug, not input. */
async function switchPlug(turn: 'on' | 'off'): Promise<{ ok: boolean; detail: string }> {
  const vendor = plugVendor();
  if (vendor === 'switchbot') return switchbot(turn);
  if (vendor === 'shelly') return shelly(turn);
  return { ok: false, detail: `${turn}: no plug configured` };
}

async function shelly(turn: 'on' | 'off'): Promise<{ ok: boolean; detail: string }> {
  const server = String(process.env.SHELLY_SERVER).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const key = encodeURIComponent(String(process.env.SHELLY_AUTH_KEY));
  try {
    const r = await fetch(`https://${server}/v2/devices/api/set/switch?auth_key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(process.env.SHELLY_DEVICE_ID), on: turn === 'on', channel: 0 }),
      signal: AbortSignal.timeout(15_000),
    });
    // Success is a bare 200 with no body, so the status IS the answer — but an error returns
    // a readable message and throwing it away would leave "the plug said no" indistinguishable
    // from "the plug did not answer".
    const text = (await r.text().catch(() => '')).slice(0, 300);
    return { ok: r.ok, detail: `${turn}: HTTP ${r.status}${text ? ` ${text}` : ''}` };
  } catch (e) {
    // NAMED, not swallowed. "The plug did not answer" and "the plug said no" need different
    // responses, and a cut we merely THINK we made is the worst outcome — the rate limit
    // spends its budget and the box is still dark.
    return { ok: false, detail: `${turn}: request failed — ${(e as Error).message}` };
  }
}

export interface PlugStatus {
  ok: boolean;
  detail: string;
  /** SwitchBot's own reading: 'on' | 'off', or null when we could not tell. */
  power?: string | null;
}

/**
 * Ask the plug how it is, WITHOUT touching it.
 *
 * ## Why this is not redundant with `powerPlugConfigured()`
 *
 * That function checks three environment variables are non-empty. It makes no network call,
 * so it answers "are the credentials present", never "do the credentials WORK". Those came
 * apart on 2026-08-19: the plug was configured, the admin route reported `configured: true`,
 * and the credentials had never once been exercised from production — the device id had been
 * obtained on a laptop, and whether the strings pasted into Vercel were byte-identical was
 * unknown. Presence is not liveness, the same way `notifications.status = 'sent'` only ever
 * meant "Twilio returned 2xx".
 *
 * Without this, the FIRST time the production credentials are tested is the night the box is
 * dark and somebody is deciding whether to drive to it. That is the worst available moment to
 * discover a trailing space — and a trailing space is the specific failure, because nothing
 * here trims and this repo has already lost a day to a leading space on a Twilio credential
 * producing an error that read as "wrong username".
 *
 * ## It cannot switch anything, and that is the point
 *
 * GET, to `/status`, with no command body. `powerCycle` splits GET-preview from POST-act
 * because a GET can be fired by a link preview with nobody involved; that reasoning is what
 * makes a read-only status call safe to expose as a GET rather than an argument against it.
 */
export async function plugStatus(): Promise<PlugStatus> {
  const vendor = plugVendor();
  if (vendor === 'ambiguous') {
    return { ok: false, detail: 'BOTH a Shelly and a SwitchBot are configured, so we cannot tell which plug to ask. Clear one set.' };
  }
  if (!vendor) {
    return { ok: false, detail: 'no smart plug configured — nothing to ask.' };
  }
  // SHELLY IS REFUSED RATHER THAN GUESSED. This file has already shipped a DEPRECATED Shelly
  // endpoint written from memory, and the owner caught it. Their status API is a different
  // shape from the switch call and is not verified here, so an unverified request would turn
  // "the plug is fine" into a sentence nobody may rely on. An honest refusal beats a reading
  // whose provenance is a guess.
  if (vendor === 'shelly') {
    return {
      ok: false,
      detail: 'the status read is implemented for SwitchBot only. Shelly\'s status endpoint has '
        + 'deliberately not been written from memory — see the note above `shelly()`. The cut '
        + 'itself still works; only this pre-flight is unavailable.',
    };
  }

  const headers = await switchbotAuth();
  const id = encodeURIComponent(String(process.env.SWITCHBOT_DEVICE_ID));
  try {
    const r = await fetch(`https://api.switch-bot.com/v1.1/devices/${id}/status`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    // SAME TRAP AS THE COMMAND PATH: SwitchBot answers HTTP 200 carrying its own statusCode,
    // so the transport says nothing. 100 is success; 171 is "device offline", which is a real
    // answer and must not read as a broken credential.
    const text = (await r.text().catch(() => '')).slice(0, 300);
    let inner: number | null = null;
    let power: string | null = null;
    try {
      const j = JSON.parse(text);
      inner = j?.statusCode ?? null;
      power = typeof j?.body?.power === 'string' ? j.body.power : null;
    } catch { /* keep the raw text */ }
    return { ok: r.ok && inner === 100, detail: `status: HTTP ${r.status} ${text}`, power };
  } catch (e) {
    // NAMED, never swallowed. "The plug said no" and "the plug did not answer" send a person
    // to two different places, and this endpoint exists to be read by somebody deciding.
    return { ok: false, detail: `status: request failed — ${(e as Error).message}` };
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

  const off = await switchPlug('off');
  await new Promise((r) => setTimeout(r, POWER_OFF_SECONDS * 1000));
  const on = await switchPlug('on');
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
