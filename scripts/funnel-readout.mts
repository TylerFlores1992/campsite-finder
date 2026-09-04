/**
 * "Where did our users come from, and what did they do?" — the acquisition funnel, in one
 * place.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/funnel-readout.mts
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/funnel-readout.mts --weeks=12
 *
 * WHY IT EXISTS, AND WHY IT IS THE HALF THAT MATTERS. Migration 072 added
 * `users.signup_source`. A column nobody queries is not a measurement — it is a column, and
 * the reason the previous instrument (Vercel Analytics, mounted since launch) never answered
 * anything is that nothing ever joined it to an account. This script is the join.
 *
 * THREE EXCLUSIONS, AND EACH ONE INVERTS A CONCLUSION IF IT IS SKIPPED:
 *
 *   1. NON-CLERK IDS. Real accounts carry a Clerk `user_` id; the other rows are fixtures
 *      from the real-DB test suites, and at this population size five of them move every
 *      rate by more than ten points.
 *
 *   2. BETA TESTERS. `hasActiveSubscription` returns true for `is_beta` BEFORE it reads the
 *      subscriptions table, so a beta account never meets a paywall. Counting them in a
 *      signup→subscribe rate measures a journey they were never shown. They are reported
 *      separately rather than deleted, because they DO belong in a signup→watch rate.
 *
 *   3. BURST DAYS. A day carrying `BURST_MIN` or more signups is not organic at this volume
 *      — an ordinary day is 0 to 2. The known instance is the paid Play closed-test tester
 *      cohort, 10 accounts across 2026-08-08/09, every one of which created zero watches and
 *      zero subscriptions. Left in, they drag the conversion rate down by a quarter and
 *      describe a population that was paid to install and leave.
 *
 *      A RULE, NOT A HARDCODED DATE RANGE, deliberately. Naming those two days would be
 *      correct exactly once and silently wrong the next time a tester batch or a launch
 *      arrives — and it would be wrong in the direction that looks fine. Bursts are printed
 *      with their dates so the reader can see what was set aside and disagree.
 *
 * IT REFUSES TO RANK CHANNELS IT CANNOT SEE. Attribution starts the day migration 072 landed,
 * so every account before it reads NULL. That is reported as "not instrumented", never as
 * "direct" — an absent reading is not a negative one, which is the mistake this repo has
 * made in six different instruments. Do not read the source table as a share of ALL signups
 * until the NULL count reaches zero.
 */
import { query } from '../src/lib/db/client';

const weeks = Number(process.argv.find((a) => a.startsWith('--weeks='))?.split('=')[1] ?? 8);
if (!Number.isFinite(weeks) || weeks < 1) {
  console.error('--weeks must be a positive number');
  process.exit(1);
}

/** A day at or above this many signups is a batch, not a week's organic traffic. */
const BURST_MIN = 4;

type Row = {
  id: string;
  day: string;
  week: string;
  is_beta: boolean;
  onboarded: boolean;
  watches: number;
  subs: number;
  source: Record<string, unknown> | null;
};

const rows = await query<Row>(
  `SELECT u.id,
          to_char(u.created_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')            AS day,
          to_char(date_trunc('week', u.created_at AT TIME ZONE 'America/Los_Angeles'), 'YYYY-MM-DD') AS week,
          u.is_beta,
          (u.onboarded_at IS NOT NULL)                                                       AS onboarded,
          (SELECT count(*) FROM watches w       WHERE w.user_id = u.id)::int                 AS watches,
          (SELECT count(*) FROM subscriptions s WHERE s.user_id = u.id)::int                 AS subs,
          u.signup_source                                                                    AS source
     FROM users u
    WHERE u.id LIKE 'user\\_%'
      AND u.created_at > NOW() - ($1 || ' weeks')::interval
    ORDER BY u.created_at`,
  [String(weeks)],
);

if (rows.length === 0) {
  console.log(`No Clerk accounts created in the last ${weeks} week(s).`);
  process.exit(0);
}

// ── which days were batches ───────────────────────────────────────────────────────────────
const perDay = new Map<string, number>();
for (const r of rows) perDay.set(r.day, (perDay.get(r.day) ?? 0) + 1);
const burstDays = new Set([...perDay].filter(([, n]) => n >= BURST_MIN).map(([d]) => d));

const organic = rows.filter((r) => !burstDays.has(r.day) && !r.is_beta);
const beta = rows.filter((r) => r.is_beta);
const burst = rows.filter((r) => burstDays.has(r.day) && !r.is_beta);

const pct = (n: number, d: number) => (d === 0 ? '  — ' : `${Math.round((n / d) * 100)}%`.padStart(4));
const step = (set: Row[], f: (r: Row) => boolean) => set.filter(f).length;

function funnel(label: string, set: Row[]) {
  const n = set.length;
  const on = step(set, (r) => r.onboarded);
  const w = step(set, (r) => r.watches > 0);
  const s = step(set, (r) => r.subs > 0);
  console.log(
    `  ${label.padEnd(22)} ${String(n).padStart(4)} signups` +
      ` │ ${String(on).padStart(4)} onboarded ${pct(on, n)}` +
      ` │ ${String(w).padStart(4)} watched ${pct(w, n)}` +
      ` │ ${String(s).padStart(4)} subscribed ${pct(s, n)}`,
  );
}

console.log(`\nCampHawk acquisition funnel — last ${weeks} week(s), Pacific\n`);
console.log('POPULATIONS');
funnel('organic', organic);
funnel('beta testers', beta);
funnel('burst days', burst);
console.log(
  `\n  Beta accounts never meet a paywall (hasActiveSubscription short-circuits on is_beta),\n` +
    `  so their "subscribed" column measures a journey they were never shown.`,
);
if (burstDays.size > 0) {
  console.log(
    `\n  Burst days set aside (>= ${BURST_MIN} signups, not organic at this volume):\n` +
      [...burstDays].sort().map((d) => `    ${d}  ${perDay.get(d)} signups`).join('\n'),
  );
}

// ── the organic cohort, week by week ──────────────────────────────────────────────────────
console.log('\nORGANIC BY WEEK (week beginning)');
const byWeek = new Map<string, Row[]>();
for (const r of organic) byWeek.set(r.week, [...(byWeek.get(r.week) ?? []), r]);
if (byWeek.size === 0) console.log('  (none)');
for (const [w, set] of [...byWeek].sort()) funnel(w, set);

// ── where they came from ──────────────────────────────────────────────────────────────────
console.log('\nSOURCE (first touch, migration 072)');
const instrumented = rows.filter((r) => r.source !== null);
const nulls = rows.length - instrumented.length;

if (instrumented.length === 0) {
  console.log(
    `  Nothing recorded yet. All ${rows.length} account(s) in this window predate migration 072\n` +
      `  or never reached /welcome. This is NOT "everyone arrived direct" — it is no reading at all.`,
  );
} else {
  const by = new Map<string, { n: number; watched: number }>();
  for (const r of instrumented) {
    const s = r.source ?? {};
    const utm = (s.utm ?? {}) as Record<string, string>;
    // The campaign wins when there is one: a utm-tagged link is a channel we CHOSE, and it is
    // the thing an outreach email or a directory listing is judged on. The referrer is the
    // fallback, and "direct" only when there is genuinely neither.
    const key = utm.campaign ?? utm.source ?? (s.ref as string | undefined) ?? 'direct';
    const label = `${key}${s.path ? `  ${s.path}` : ''}`;
    const cur = by.get(label) ?? { n: 0, watched: 0 };
    by.set(label, { n: cur.n + 1, watched: cur.watched + (r.watches > 0 ? 1 : 0) });
  }
  for (const [label, v] of [...by].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(v.n).padStart(3)} signups  ${String(v.watched).padStart(3)} watched  ${label}`);
  }
  if (nulls > 0) {
    console.log(
      `\n  ${nulls} account(s) carry NO source — created before migration 072, or never reached\n` +
        `  /welcome. Not instrumented. Do not read the table above as a share of all signups\n` +
        `  until this reaches zero.`,
    );
  }
}

console.log('');
process.exit(0);
