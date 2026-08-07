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
export function loadEnv(fromUrl) {
  const dir = path.dirname(fileURLToPath(fromUrl));
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
