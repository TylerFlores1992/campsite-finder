import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read `scripts/auto-cart-bot/.env` into process.env.
 *
 * WHY IT IS SHARED. This was copy-pasted privately inside bot.mjs and broker.mjs, so
 * every NEW process on the mini-PC started life unable to read the config — and the
 * symptom is not "no .env found", it is whatever a missing variable does downstream.
 * `rc-hold-runner.mjs` shipped on 2026-08-07 without it and answered `feed 401`, which
 * reads exactly like a wrong token. `start-all.bat` launches it on boot with no
 * environment of its own, so it would have failed that way every single night.
 *
 * Existing environment WINS. A value exported in the shell is a deliberate override for
 * that run (a staging URL, a one-off token); silently replacing it from a file on disk
 * would make the override look like it worked while the old value was in force.
 */
const fromFile = new Set();

/**
 * THE CALLER'S DIRECTORY, THEN THIS FILE'S — and the fallback is the whole point.
 *
 * `fromUrl` resolves relative to whoever calls, which was right while every caller was a
 * sibling of the `.env`. `mini-pc/report-applied.mjs` is not: it looked for
 * `mini-pc/.env`, found nothing, and RETURNED SILENTLY — so `AUTOCART_TOKEN` was absent,
 * its POST was answered 401, and it printed "server said 401", which reads exactly like a
 * wrong token. `applied_sha` therefore stopped moving on 2026-08-19 and still read
 * `746cd5a` through two manual updates on 08-20, which is a stale field somebody then
 * reasons from.
 *
 * That is verbatim the failure this file's own header describes — `rc-hold-runner.mjs`
 * answering `feed 401` for want of an environment — reappearing one directory deeper,
 * inside the fix for it. The doc above says this reads `scripts/auto-cart-bot/.env`, so
 * it now does that whoever calls it, while still preferring a `.env` beside the caller if
 * one is ever put there deliberately.
 *
 * @returns {string | null} the file actually read, so a caller can SAY it found nothing.
 */
export function loadEnv(fromUrl) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.dirname(fileURLToPath(fromUrl));
  // The caller's own directory wins; this module's is the canonical fallback. Bounded to
  // exactly these two — walking up arbitrarily would eventually find an unrelated `.env`
  // at the repo root and load it silently, which is a worse failure than the one fixed.
  const p = [path.join(dir, '.env'), path.join(here, '.env')].find((c) => fs.existsSync(c));
  if (!p) return null;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) {
      process.env[m[1]] = v;
      fromFile.add(m[1]);
    }
  }
  return p;
}

/**
 * Where a value actually came from: 'shell' | 'file' | 'missing'.
 *
 * The override rule is right, and it is also invisible — which makes it expensive. A
 * placeholder left in a PowerShell session (`$env:AUTOCART_TOKEN = "<paste it here>"`)
 * silently beats a perfectly good .env, and every downstream symptom says "wrong token"
 * while the file on disk is correct. That cost two rounds on 2026-08-07. Anything that
 * reports an auth failure should say which of the two it was using.
 */
export function envSource(key) {
  if (!(key in process.env)) return 'missing';
  return fromFile.has(key) ? 'file' : 'shell';
}

/**
 * Does this look like documentation someone pasted rather than a real value?
 *
 * Deliberately narrow — angle brackets or whitespace, which no token contains and every
 * copied placeholder does. A broad "looks suspicious" heuristic would eventually reject
 * a real credential at 8am, which is far worse than the confusion it saves.
 */
export function looksLikePlaceholder(value) {
  return typeof value === 'string' && (/[<>]/.test(value) || /\s/.test(value.trim()));
}
