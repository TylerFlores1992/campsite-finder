/**
 * BOT EVENTS — rare, structured observations from the mini-PC (migration 075).
 *
 * Two kinds today, and the reason for each is in the migration's header:
 *
 *   `ramp-scan`   bot.mjs took the full `memory` scan by itself, the first time the periodic
 *                 sample saw the rc Chromium family past RAMP_SCAN_MB. `detail` carries the
 *                 trigger values; `text` carries the scan. It answers the one question the
 *                 memory series cannot: where the ~35 GB of commit that appears at every ramp
 *                 onset — and that chrome.exe private bytes do not account for — actually is.
 *
 *   `tab-close`   rc-keepwarm closed a throwaway tab (renewal / auto-login / warmup) and is
 *                 reporting how long the trip took and how long the close took, and whether
 *                 the close had to be given up on. A renewal body that takes ten minutes and a
 *                 `tab.close()` that hangs for ten minutes look identical in the memory
 *                 series; this is the number that separates them.
 *
 *   `request-counts`  rc-keepwarm's count of the RESIDENT page's requests — `origin +
 *                 pathname` keys, lifetime and rolling two-minute counts, top ten — taken at a
 *                 bail, at the teardown and on a hung close. The 09-04 ramp scan put ~35 GB of
 *                 untouched shared-section commit on a renderer holding 18,705 handles; if
 *                 that is a request loop, the top path here names the endpoint. `reason`
 *                 says which of the three took it. Never a query, never a body.
 *
 * THE RULES ARE THE SAME AS `native-alloc.ts`, ONE TABLE OVER: the kind is allow-listed so a
 * caller with the token cannot put arbitrary text on an admin readout; the detail is capped;
 * the text is capped and stripped of control characters, because Postgres text cannot hold a
 * NUL and an unstorable answer is how `tail-log` went silent on 2026-08-11; and the JSON is
 * stringified HERE, because `sqlit` interpolates rather than binds and hands a plain object to
 * `String()` — the `[object Object]` that switched the memory series off for ten minutes.
 */
import { mutate, query } from '@/lib/db/client';

export const BOT_EVENT_KINDS = ['ramp-scan', 'tab-close', 'request-counts'] as const;
export type BotEventKind = (typeof BOT_EVENT_KINDS)[number];
const KINDS = new Set<string>(BOT_EVENT_KINDS);

/** Detail is small structured facts, never a dump — 8 KB is many times what either kind needs. */
export const MAX_DETAIL_CHARS = 8_000;
/** A full `memory` scan is ~3-6 KB; 64 KB leaves room for a box with many processes. */
export const MAX_TEXT_CHARS = 64_000;

export interface BotEventInput {
  kind?: unknown;
  detail?: unknown;
  text?: unknown;
}

export interface BotEventRow {
  id: number;
  at: string;
  source: string | null;
  kind: string | null;
  detail: Record<string, unknown> | null;
  text: string | null;
}

/**
 * Strip what Postgres text cannot hold and what a readout should never print: every control
 * character except newline and tab. A NUL is the one that throws; the rest are the ones a
 * PowerShell console encoding can leave behind.
 */
export function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  if (!t) return null;
  return t.length > MAX_TEXT_CHARS
    ? `${t.slice(0, MAX_TEXT_CHARS)}\n(truncated at ${MAX_TEXT_CHARS} chars)`
    : t;
}

/** A plain object, JSON-serialisable, under the cap — or null. Never a string, never an array. */
export function cleanDetail(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let s: string;
  try { s = JSON.stringify(raw); } catch { return null; }
  if (!s || s === '{}' || s.length > MAX_DETAIL_CHARS) return null;
  return s;
}

export function eventKind(raw: unknown): BotEventKind | null {
  return typeof raw === 'string' && KINDS.has(raw) ? (raw as BotEventKind) : null;
}

export async function recordBotEvent(input: BotEventInput, source: string | null): Promise<void> {
  await mutate(
    `INSERT INTO bot_events (source, kind, detail, text) VALUES ($1, $2, $3::jsonb, $4)`,
    [
      source ? source.slice(0, 40) : null,
      eventKind(input.kind),
      cleanDetail(input.detail),
      cleanText(input.text),
    ],
  ).catch((e) => console.error('[bot-events] recordBotEvent failed:', (e as Error).message));
}

export async function recentBotEvents(
  kind: BotEventKind, hours: number, limit = 50,
): Promise<BotEventRow[]> {
  return await query<BotEventRow>(
    `SELECT id, at::text, source, kind, detail, text
       FROM bot_events
      WHERE kind = $1 AND at > NOW() - ($2 || ' hours')::interval
      ORDER BY at DESC
      LIMIT $3`,
    [kind, String(Math.max(1, Math.floor(hours))), limit],
  );
}
