/**
 * WHICH OF THE THREE DEPLOY ROUTES DOES THIS CHANGE NEED?
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/deploy-scope.mts            # working tree vs HEAD
 *   npx tsx scripts/deploy-scope.mts origin/master..HEAD             # a range
 *   npx tsx scripts/deploy-scope.mts <sha>                           # one commit
 *
 * This project deploys by THREE independent routes and that is the most expensive recurring
 * failure in its log:
 *
 *   web      -> Vercel, automatically on a push to master. Instant.
 *   worker   -> Fly, via the worker-deploy Action on paths it watches. Minutes.
 *   mini-PC  -> a quiet-window self-update or a human running update.bat. HOURS, and it is
 *               refused within six hours of a release.
 *
 * So a single commit touching web and mini-PC code is LIVE ON ONE HALF AND NOT THE OTHER
 * for hours. On 2026-08-11 that shipped `AUTOCART_ALARM_AFTER_MIN` to Vercel while
 * `RC_AUTOLOGIN_LEAD_MIN` waited for a human — the alarm then fired at T-30 while the login
 * still waited for T-15, which is the 2026-08-09 cry-wolf bug exactly.
 *
 * ── INFORMATIONAL ON PURPOSE. IT NEVER FAILS. ─────────────────────────────────────────
 * The obvious design is a `Deploy-Targets:` commit trailer enforced in CI. It was considered
 * and rejected: a trailer is a process gate a human has to remember, and it will be
 * forgotten in precisely the rushed commit that needs it — while adding a step to every
 * commit that does not. `autocart.bot_version` already catches the drift MECHANICALLY,
 * after the fact but reliably and without anyone remembering anything. This script exists
 * to answer the question BEFORE the push, cheaply, for whoever thinks to ask.
 *
 * Exit code is always 0. A tool that can fail a build teaches people to route around it.
 */
import { execFileSync } from 'node:child_process';

const git = (...a: string[]) => {
  try {
    return execFileSync('git', a, { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return '';
  }
};

/**
 * Path -> route. Ordered most specific first; a path matches at most one route here, but a
 * CHANGE routinely matches several, which is the whole point.
 *
 * `worker` mirrors the paths worker-deploy.yml actually watches — if that workflow's trigger
 * changes and this does not, this file starts lying, which is worse than not existing.
 */
const ROUTES: Array<{ route: string; how: string; test: (p: string) => boolean }> = [
  {
    route: 'mini-PC',
    how: 'quiet window 02:00-05:00 PT, "Update now", or a human running update.bat — HOURS, and refused within 6h of a release',
    test: (p) => p.startsWith('scripts/auto-cart-bot/'),
  },
  {
    route: 'Fly worker',
    how: 'worker-deploy.yml on a master push touching worker/** or the src/lib dirs it imports — minutes',
    test: (p) => p.startsWith('worker/') && !p.endsWith('.test.mts'),
  },
  {
    route: 'Vercel web',
    how: 'automatic on a push to master — instant',
    test: (p) => p.startsWith('src/') || p === 'next.config.ts' || p === 'middleware.ts' || p === 'vercel.json',
  },
  {
    route: 'database',
    how: 'a migration is applied BY HAND and Vercel deploys before it is — order matters',
    test: (p) => p.startsWith('src/lib/db/migrations/'),
  },
  {
    route: 'native app',
    how: 'npm install && npx cap sync && a REBUILD + store review — DAYS. A web deploy does not deliver it',
    test: (p) => p.startsWith('ios/') || p.startsWith('android/') || p === 'capacitor.config.ts' || p === 'codemagic.yaml',
  },
];

const arg = process.argv[2];
const files = (arg ? git('diff', '--name-only', arg) : git('diff', '--name-only', 'HEAD'))
  .split('\n')
  .filter(Boolean);

if (files.length === 0) {
  console.log('No changes to scope' + (arg ? ` in ${arg}` : ' in the working tree') + '.');
  process.exit(0);
}

const hit = new Map<string, string[]>();
for (const f of files) {
  for (const r of ROUTES) {
    if (!r.test(f)) continue;
    if (!hit.has(r.route)) hit.set(r.route, []);
    hit.get(r.route)!.push(f);
  }
}

console.log(`\n${files.length} changed file(s)${arg ? ` in ${arg}` : ''} reach ${hit.size} deploy route(s):\n`);
for (const r of ROUTES) {
  const fs = hit.get(r.route);
  if (!fs) continue;
  console.log(`  ${r.route.toUpperCase()}  (${fs.length} file${fs.length > 1 ? 's' : ''})`);
  console.log(`    ${r.how}`);
  for (const f of fs.slice(0, 6)) console.log(`      ${f}`);
  if (fs.length > 6) console.log(`      … and ${fs.length - 6} more`);
  console.log('');
}

// THE WARNING THIS EXISTS FOR. Web is instant and the mini-PC is hours; a change split
// across both is live on one half and not the other for the whole gap. That is not a
// mistake in itself — it is often unavoidable — but it has to be a DECISION.
if (hit.has('Vercel web') && hit.has('mini-PC')) {
  console.log('  !! WEB + MINI-PC IN ONE CHANGE.');
  console.log('     Vercel is live in seconds; the box may be hours behind, and the update');
  console.log('     guard refuses within 6h of a release. If the two halves must agree to be');
  console.log('     correct, they will DISAGREE for that whole window.');
  console.log('     2026-08-11: AUTOCART_ALARM_AFTER_MIN shipped instantly while');
  console.log('     RC_AUTOLOGIN_LEAD_MIN waited — the alarm fired 15 minutes before the');
  console.log('     repair that fixes it. Land them together, or make each half safe alone.');
  console.log('');
}
if (hit.has('database')) {
  console.log('  !! MIGRATION IN THIS CHANGE. Vercel deploys before a migration is applied by');
  console.log('     hand, so the new code must tolerate the old schema for that window.');
  console.log('');
}

process.exit(0);
