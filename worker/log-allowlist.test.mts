// EVERY LOG THE BOT WRITES MUST BE READABLE FROM HERE.
//
// `tail-log` takes a NAME from a fixed allowlist, never a path — that is deliberate and must
// stay: a path parameter is a directory traversal waiting to happen, and `.env` and the
// Chromium profile directories are exactly what an attacker holding AUTOCART_TOKEN would ask
// for. The cost of that design is drift: a new log gets written and nobody adds it, and the
// gap is invisible until the day somebody needs that file.
//
// WHICH IS WHAT HAPPENED. `rc-test-login.bat` failed on 2026-08-19 19:46 printing no reason
// line, no rewrite count and no stack — the console stopped dead after "Signing in with the
// stored password". The only record that could say why is Tee'd to `rc-test-login.log`, and
// it was the single bot log NOT in the allowlist. Diagnosing a remote box then needed a human
// to copy a file off it by hand, which is precisely backwards: the runs worth reading remotely
// are the ones nobody is sitting in front of afterwards.
//
// This test does not widen the mechanism. It just refuses to let the list fall behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LOGS } from '../scripts/auto-cart-bot/bot-commands.mjs';

const DIRS = ['scripts/auto-cart-bot', 'scripts/auto-cart-bot/mini-pc'];

/** Every `logs/<name>.log` mentioned anywhere the bot or the mini-PC scripts write. */
function logsWritten(): Set<string> {
  const out = new Set<string>();
  for (const dir of DIRS) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const src = readFileSync(`${dir}/${e.name}`, 'utf8');
      // Both separators: the .mjs files use `/`, the .bat and .ps1 files use `\`.
      for (const m of src.matchAll(/logs[\\/]([A-Za-z0-9._-]+\.log)/g)) out.add(m[1]);
    }
  }
  return out;
}

const basenames = new Set(Object.values(LOGS).map((p) => String(p).split('/').pop()));

test('no log is written that tail-log cannot fetch', () => {
  const written = logsWritten();
  assert.ok(written.size >= 7, 'the scan must actually find logs, or it approves nothing');
  const missing = [...written].filter((w) => !basenames.has(w)).sort();
  assert.deepEqual(missing, [],
    `these logs are written but not reachable via tail-log: ${missing.join(', ')}`);
});

test('the allowlist has no entry pointing at a file nothing writes', () => {
  // The other direction. A stale entry is harmless but it is also a lie about what exists,
  // and somebody will eventually ask for it and read "not found" as "the box is broken".
  const written = logsWritten();
  const dead = [...basenames].filter((b) => b && !written.has(b)).sort();
  assert.deepEqual(dead, [], `allowlisted but never written: ${dead.join(', ')}`);
});

test('it is still a NAME allowlist, never a path parameter', () => {
  // The security property this whole design exists for. `.env` and the profile directories
  // must stay unreachable, and the only thing keeping them unreachable is that the caller
  // cannot express a path at all.
  const SRC = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const handler = code.slice(code.indexOf("'tail-log': async (arg)"), code.indexOf("'tail-log': async (arg)") + 800);
  assert.match(handler, /LOGS\[/, 'the requested name must be resolved through the map');
  assert.ok(!/path\.join\(HERE, arg/.test(handler) && !/readTextFile\(arg/.test(handler),
    'the argument must never be used as a path');
  for (const p of Object.values(LOGS)) {
    assert.match(String(p), /^logs\/[A-Za-z0-9._-]+\.log$/,
      'every entry stays inside logs/ with no traversal');
  }
});
