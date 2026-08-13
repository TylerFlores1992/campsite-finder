/**
 * "Does the app's ReserveCalifornia session survive, and does it renew itself?"
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-app-session-readout.mts
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-app-session-readout.mts --days=30
 *
 * WHY IT EXISTS. The probe (Admin → System Health → "Open ReserveCalifornia", from inside
 * the app) records one row per run. One row answers "right now"; the question is a shape
 * over days — does the session last one, or seven, and does RC re-mint a token from the
 * Okta cookie without a credential. This is the thing that reads the shape.
 *
 * IT REFUSES A VERDICT IT HAS NOT EARNED, and that is the point rather than a nicety. The
 * two most expensive wrong turns in this project were both one observation promoted to a
 * measurement — the "~8 hour session cap" (which was really "when we happened to look") and
 * "the keep-warm renews the session" (which was measured against the token it meant to
 * replace). So the gate below counts only the probes that actually TESTED renewal, not the
 * probes that happened to find a healthy session and therefore asked RC nothing.
 *
 * A GAP IN THE SERIES IS ITSELF A FINDING and is printed as one. The days-axis is the whole
 * measurement, so a week of probes taken every twenty minutes says nothing about a week.
 */
import { query } from '../src/lib/db/client';

const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 30);

/**
 * How many renewal-TESTING probes before the readout will say anything about renewal.
 *
 * Two, not one, because one is the number this file has been burned by twice. Two
 * independent arrivals-with-a-dead-token that both came back live is not proof either, and
 * the wording below stays hedged accordingly — but it is the point at which the pattern is
 * worth acting on rather than worth noting.
 */
const MIN_RENEWAL_TESTS = 2;

interface Probe {
  probe_id: string;
  verdict: string;
  detail: string | null;
  proves_renewal: boolean;
  marker: string | null;
  opens: number | null;
  last_open_ago_sec: number | null;
  first_open_ago_sec: number | null;
  prev_token_expires_in_sec: number | null;
  live_token_expires_in_sec: number | null;
  platform: string | null;
  app_build: string | null;
  device_key: string | null;
  created_at: string;
  age_h: number;
}

const probes = await query<Probe>(
  `SELECT probe_id, verdict, detail, proves_renewal, marker, opens, last_open_ago_sec,
          first_open_ago_sec, prev_token_expires_in_sec, live_token_expires_in_sec,
          platform, app_build, device_key, created_at,
          EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS age_h
     FROM rc_app_session_probes
    WHERE created_at > NOW() - ($1 || ' days')::interval
    ORDER BY created_at DESC`,
  [String(days)],
);

function dur(sec: number | null): string {
  if (sec === null) return '—';
  const s = Math.abs(Math.round(sec));
  const sign = sec < 0 ? '-' : '';
  if (s < 90) return `${sign}${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${sign}${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${sign}${h}h${m % 60}m` : `${sign}${h}h`;
  return `${sign}${(h / 24).toFixed(1)}d`;
}

console.log(`\nRC APP SESSION — ${probes.length} probe(s) in the last ${days} days\n`);

if (!probes.length) {
  // TWO CAUSES, NAMED. "Nobody has run it" and "it ran and could not write" produce the
  // same empty table, and only the first is ordinary.
  console.log('  No probes recorded.');
  console.log('  Either nobody has run it yet, or the write is failing — the panel says');
  console.log('  "this reading was NOT recorded" in the second case.');
  console.log('\n  Run it: Admin → System Health → Alerting → "Open ReserveCalifornia",');
  console.log('  FROM INSIDE THE APP. From a browser there is no injectable webview and it');
  console.log('  measures nothing.\n');
  process.exit(0);
}

// ── The series ───────────────────────────────────────────────────────────────────────
console.log('  when                      verdict      away    token left  platform');
for (const p of probes) {
  const when = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short', hour12: false,
  }).format(new Date(p.created_at));
  const mark = p.proves_renewal ? '*' : ' ';
  console.log(
    `  ${when.padEnd(20)} ${mark} ${p.verdict.padEnd(11)} ` +
    `${dur(p.last_open_ago_sec).padStart(6)}  ${dur(p.live_token_expires_in_sec).padStart(10)}  ${p.platform ?? '—'}`,
  );
}
console.log('\n  * = this probe actually tested renewal (it arrived with no usable token).\n');

// ── What the series supports ─────────────────────────────────────────────────────────
const byVerdict = new Map<string, number>();
for (const p of probes) byVerdict.set(p.verdict, (byVerdict.get(p.verdict) ?? 0) + 1);
console.log('  ' + [...byVerdict].map(([v, n]) => `${v}: ${n}`).join(' · '));

// A probe TESTS renewal only when it arrived with nothing usable. One that found a healthy
// session asked RC nothing, and counting it here is exactly how a working system gets
// mistaken for a self-renewing one.
const tested = probes.filter((p) => p.verdict === 'renewed' || p.verdict === 'signed-out' || p.verdict === 'expired');
const renewed = probes.filter((p) => p.proves_renewal);
const purged = probes.filter((p) => p.verdict === 'purged');

// The longest gap the session has been observed to survive — the days question, answered
// only by probes that came back alive after being away.
const survived = probes
  .filter((p) => (p.verdict === 'live' || p.verdict === 'renewed') && p.last_open_ago_sec !== null)
  .map((p) => p.last_open_ago_sec!);
const longest = survived.length ? Math.max(...survived) : null;

console.log('');
if (longest !== null) {
  console.log(`  LONGEST GAP SURVIVED: ${dur(longest)} — a probe that far from the previous one`);
  console.log('    still found a working session (renewed or already live).');
} else {
  console.log('  LONGEST GAP SURVIVED: nothing yet — no probe has come back alive after a gap.');
}

console.log('');
if (tested.length < MIN_RENEWAL_TESTS) {
  // THE HONEST GATE. Same posture as recgov-429-profile refusing a verdict until all 24
  // hours have data: a readout that guesses is worse than one that says it cannot tell,
  // because the guess gets quoted later as if it were measured.
  console.log(`  RENEWAL: NOT ENOUGH DATA — ${tested.length} of ${MIN_RENEWAL_TESTS} probes have`);
  console.log('    arrived with a dead or missing token, which is the only situation that');
  console.log('    tests whether RC re-mints silently. Probes that find a live session prove');
  console.log('    the session persisted and nothing at all about renewal.');
  console.log('    Keep probing after LONG gaps — a probe taken 20 minutes after the last');
  console.log('    one can never test this.');
} else if (renewed.length === tested.length) {
  console.log(`  RENEWAL: ${renewed.length}/${tested.length} — every probe that arrived without a usable`);
  console.log('    token got a fresh one anyway, with no credential typed. That is the Okta');
  console.log('    session cookie doing the work, and it means the sign-in is roughly once');
  console.log('    per Okta session (~12h), not once per claim.');
} else if (renewed.length === 0) {
  console.log(`  RENEWAL: 0/${tested.length} — no probe that arrived without a usable token ever`);
  console.log('    got one back. The app does not renew silently; assume a sign-in shortly');
  console.log('    before each release, exactly as the bot does.');
} else {
  console.log(`  RENEWAL: ${renewed.length}/${tested.length} — MIXED, which is the interesting answer.`);
  console.log('    Something distinguishes the two groups; the gap length is the first thing');
  console.log('    to look at (an Okta session is ~12h, so gaps either side of that should');
  console.log('    split cleanly).');
}

if (purged.length) {
  console.log('');
  console.log(`  PURGED ${purged.length}× — the webview's storage was emptied, not merely expired.`);
  console.log('    iOS caps script-writable storage at ~7 days without interaction. Renewing');
  console.log('    cannot fix this: the user signs in again, and opening the app regularly is');
  console.log('    the only thing that prevents it.');
}

// ── Is the series still being fed? ───────────────────────────────────────────────────
const newest = probes[0];
console.log('');
if (newest.age_h > 36) {
  console.log(`  ⚠ NO PROBE FOR ${dur(newest.age_h * 3600)}. The series has a hole in it.`);
  console.log('    A gap is not neutral — it is the axis the whole question is asked along.');
} else {
  console.log(`  Last probe ${dur(newest.age_h * 3600)} ago: ${newest.verdict}.`);
}
console.log('');
