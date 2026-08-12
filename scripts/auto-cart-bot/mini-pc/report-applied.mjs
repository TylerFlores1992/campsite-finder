/**
 * Tell the server what commit this box is actually on, after a MANUAL update.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────
 * `auto-update.ps1` reports through `Report-Applied`, so the unattended path keeps
 * `bot_update_requests.applied_sha` honest. `update.bat` — the manual path, and the one a
 * human reaches for when something is wrong — never did. So on 2026-08-11 the admin panel
 * read `applied_sha = 37e1527, "REFUSED - processes would not stop"` while the box was
 * really running `d1ab782` and perfectly healthy.
 *
 * That is not cosmetic. It misled me twice in one evening, and the second time I had a
 * `git-status` answer in front of me contradicting it. A record that is confidently wrong is
 * worse than no record: it is the field you check when you are trying to work out whether a
 * fix reached the machine.
 *
 * ── WHY A NODE SCRIPT AND NOT A CURL IN THE .BAT ───────────────────────────────────────
 * The token lives in `scripts/auto-cart-bot/.env`, not in the machine environment — the
 * trap that made every `auto-update.ps1` report 401 for hours. `loadEnv` already solves it
 * and is already the rule for every other bot script; a hand-rolled read in a batch file
 * would be the fourth place that has to remember.
 *
 * Failure here must never fail the update: the box is already on the new code by the time
 * this runs. It says so and exits 0.
 */
import { execFileSync } from 'node:child_process';
import { loadEnv } from '../load-env.mjs';

loadEnv(import.meta.url);

const url = (process.env.CAMPHAWK_URL || 'https://camphawk.app').replace(/\/$/, '');
const token = process.env.AUTOCART_TOKEN || '';
const note = process.argv[2] || 'manual update.bat';

/** The commit the box is on RIGHT NOW — read from git, never passed in by the caller. */
function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

const sha = headSha();
if (!sha) {
  console.log('[report-applied] could not read HEAD - not reporting a commit we cannot name');
  process.exit(0);
}

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 15_000);
try {
  const r = await fetch(`${url}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ updateApplied: sha, note }),
    signal: ac.signal,
  });
  if (r.ok) {
    await r.body?.cancel?.().catch(() => {});
    console.log(`[report-applied] recorded ${sha.slice(0, 7)} - ${note}`);
  } else {
    await r.body?.cancel?.().catch(() => {});
    // NAME THE STATUS. A bare "could not report" is what let 401 hide as "nothing ran".
    console.log(`[report-applied] server said ${r.status} - the admin page will still show the OLD commit`);
  }
} catch (e) {
  console.log(`[report-applied] could not reach ${url}: ${e.message}`);
} finally {
  clearTimeout(timer);
}
process.exit(0);
