import { NextRequest, NextResponse } from 'next/server';
import { currentUserEmail, isAdminEmail } from '@/lib/admin';
import { query, mutate } from '@/lib/db/client';
import {
  classifyRcAppSession,
  factsFromReports,
  type RcAppSessionReading,
} from '@/lib/rc-session-verdict';

export const dynamic = 'force-dynamic';

/**
 * The RC app-session probe — record one observation, and read the series back.
 *
 * ## Why this is a route and not just a panel
 *
 * The probe already existed in everything but name: `openRcHandoff` with no unitId opens RC
 * in the injectable webview, injects, captures a token if there is one, and carts nothing.
 * What it could not do is ANSWER anything, because the question is a shape over days — does
 * the session survive one? seven? — and the reports lived in a React state variable that
 * died with the panel.
 *
 * That gap is the one migration 050 closed for the hold hand-off, and the one migration 047
 * closed for the bot's session lifetime, where the first real reading falsified a confident
 * hypothesis within hours. The standing rule here is that one observation is not a
 * measurement; this is what turns a button press into a series.
 *
 * ## Authorisation
 *
 * Admin only, 404 like the rest of the admin surface. Deliberately NOT the hold-token
 * scheme used by `/api/rc-holds/report`: that one has to work on a stranger's phone at 8am
 * from an email link, whereas this is a diagnostic run by the owner from inside the app,
 * and the weaker check would exist only to save a sign-in nobody needs to skip.
 *
 * The claim screen keeps reporting through `/api/rc-holds/report` unchanged — the `session`
 * stage rides along in `client_reports` for free, so a real 8am hold records the same facts
 * against the hold they belong to.
 *
 * ## What may be stored
 *
 * Whatever the reporter emits: stage names, counters, RC's own user-facing status text, and
 * token EXPIRIES as numbers. Never a token, never a cart key, never a URL query string —
 * Okta signs in inside that webview, so `?code=` is an exchangeable authorization code.
 * Enforced at the source (lib/rc-precart-script), guarded by worker/rc-session-verdict.test.mts;
 * the cap and truncation below are the second line, not the first.
 */

/** One run cannot be allowed to write unboundedly. The client already collapses duplicates. */
const MAX_REPORTS = 80;
/** Enough history to see a shape, few enough to render without paging. */
const HISTORY = 20;

interface ProbeRow {
  probe_id: string;
  verdict: string;
  detail: string | null;
  proves_renewal: boolean;
  marker: string | null;
  opens: number | null;
  last_open_ago_sec: number | null;
  prev_token_expires_in_sec: number | null;
  live_token_expires_in_sec: number | null;
  platform: string | null;
  app_build: string | null;
  created_at: string;
}

function clean(raw: unknown): Array<{ n: number; stage: string; detail: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_REPORTS).flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const { n, stage, detail } = r as Record<string, unknown>;
    if (typeof stage !== 'string' || !stage) return [];
    const out: Record<string, unknown> = {};
    if (detail && typeof detail === 'object') {
      for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
        // TWELVE, BECAUSE THE `session` REPORT IS NOW ELEVEN AND SILENT TRUNCATION OF A
        // DIAGNOSTIC IS THE FAILURE THIS WHOLE INVESTIGATION KEEPS PAYING FOR. Object key
        // order is insertion order, so the four `okta*` fields added on 2026-08-31 sit at
        // the END — under the old ceiling they were exactly what got dropped, and the
        // instrument would have reported nothing while looking like it had run. Bounded
        // still: each value is truncated to 300 characters and the report count is capped
        // above, so this is a slightly wider bound, not an open one.
        if (Object.keys(out).length >= 12) break;
        if (typeof v === 'string') out[k] = v.slice(0, 300);
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
      }
    }
    return [{ n: Number.isFinite(n) ? Number(n) : 0, stage: stage.slice(0, 40), detail: out }];
  });
}

/**
 * The series, newest first — for this device when we know it, else everything.
 *
 * Unlike the prior-probe COUNT, falling back to every device is right here: this is a
 * readout for a human, and showing one row too many costs nothing. The count decides a
 * verdict, so it refuses to guess. Different jobs, deliberately different fallbacks.
 */
async function history(deviceKey: string | null): Promise<ProbeRow[]> {
  return query<ProbeRow>(
    `SELECT probe_id, verdict, detail, proves_renewal, marker, opens, last_open_ago_sec,
            prev_token_expires_in_sec, live_token_expires_in_sec, platform, app_build, created_at
       FROM rc_app_session_probes
      WHERE ($1::text IS NULL OR device_key = $1)
      ORDER BY created_at DESC
      LIMIT ${HISTORY}`,
    [deviceKey],
  ).catch(() => []);
}

export async function GET(req: NextRequest) {
  if (!isAdminEmail(await currentUserEmail())) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const deviceKey = req.nextUrl.searchParams.get('device');
  return NextResponse.json({ probes: await history(deviceKey || null) });
}

export async function POST(req: NextRequest) {
  const email = await currentUserEmail();
  if (!isAdminEmail(email)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const probeId = String(body?.probeId ?? '').slice(0, 64);
  if (!probeId) return NextResponse.json({ error: 'probeId required' }, { status: 400 });
  const deviceKey = body?.deviceKey ? String(body.deviceKey).slice(0, 64) : null;
  const platform = body?.platform ? String(body.platform).slice(0, 40) : null;
  const appBuild = body?.appBuild ? String(body.appBuild).slice(0, 60) : null;

  const reports = clean(body?.reports);
  const facts = factsFromReports(reports);

  // PRIOR PROBES ARE WHAT SEPARATE A PURGE FROM A FIRST RUN, and two things must be true
  // for the count to mean that.
  //
  // It must EXCLUDE THIS RUN: the client re-sends the whole run as it goes, so the row
  // written two seconds ago would otherwise count itself as history and turn every genuine
  // first open into "purged".
  //
  // And it must be THIS DEVICE's history, never everyone's. With no `device_key` we cannot
  // attribute anything, so the answer is zero rather than a global count — a probe from a
  // second phone would otherwise inherit the first phone's history and report a purge that
  // never happened. Unattributable degrades to `first-open`, which is the conservative
  // direction: never claim a purge you cannot prove.
  const [{ n: priorProbes } = { n: 0 }] = deviceKey
    ? await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM rc_app_session_probes
          WHERE probe_id <> $1 AND device_key = $2`,
        [probeId, deviceKey],
      ).catch(() => [{ n: 0 }])
    : [{ n: 0 }];

  const reading: RcAppSessionReading = classifyRcAppSession(facts, { priorProbes });

  // UPSERT, because a run reports several times as it progresses and each POST carries the
  // whole run so far. Last write wins and is by construction the most complete — no merge,
  // and a webview closed early still leaves the reading it had reached.
  const stored = await mutate(
    `INSERT INTO rc_app_session_probes (
        probe_id, user_email, device_key, platform, app_build,
        verdict, detail, proves_renewal,
        marker, opens, last_open_ago_sec, first_open_ago_sec,
        prev_token_expires_in_sec, stored_token,
        live_token_expires_in_sec, live_token_age_sec, reports, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb, NOW())
     ON CONFLICT (probe_id) DO UPDATE SET
        verdict = EXCLUDED.verdict,
        detail = EXCLUDED.detail,
        proves_renewal = EXCLUDED.proves_renewal,
        marker = EXCLUDED.marker,
        opens = EXCLUDED.opens,
        last_open_ago_sec = EXCLUDED.last_open_ago_sec,
        first_open_ago_sec = EXCLUDED.first_open_ago_sec,
        prev_token_expires_in_sec = EXCLUDED.prev_token_expires_in_sec,
        stored_token = EXCLUDED.stored_token,
        live_token_expires_in_sec = EXCLUDED.live_token_expires_in_sec,
        live_token_age_sec = EXCLUDED.live_token_age_sec,
        reports = EXCLUDED.reports,
        updated_at = NOW()`,
    [
      probeId, email, deviceKey, platform, appBuild,
      reading.verdict, reading.detail, reading.provesRenewal,
      facts?.marker ?? null, facts?.opens ?? null, facts?.lastOpenAgoSec ?? null,
      facts?.firstOpenAgoSec ?? null, facts?.prevTokenExpiresInSec ?? null,
      facts?.storedToken ?? null, facts?.liveTokenExpiresInSec ?? null,
      facts?.liveTokenAgeSec ?? null, JSON.stringify(reports),
    ],
    // NOTE: `mutate`, never `query`. `query()` goes to the `exec_select` RPC, which refuses
    // anything data-modifying — an UPSERT handed to it throws every time, forever, and the
    // two calls are indistinguishable at the call site. worker/sql-routing.test.mts scans
    // for exactly this.
  ).then(
    () => ({ stored: true, storeError: null as string | null }),
    // REPORTED, NOT SWALLOWED. A bare `.catch(() => {})` would make "the probe found
    // nothing" and "we could not write it down" the same quiet panel — the pair that hid
    // the `query()` routing bug for a day. The reading is still returned: the observation
    // was real even if the record of it was not.
    (e: Error) => {
      console.error('[rc-session-probe] write failed:', e.message);
      return { stored: false, storeError: e.message.slice(0, 200) };
    },
  );

  return NextResponse.json({
    ...reading,
    ...stored,
    priorProbes,
    probes: await history(deviceKey),
  });
}
