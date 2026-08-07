// `node rc-hold-runner.mjs --once` must run exactly ONE pass and terminate.
//
// TWO BUGS, ONE LINE, both found on 2026-08-07 and both invisible to `node --check`:
//
//  1. `process.exit(0)` after a pass killed the loop mid-teardown and Windows libuv
//     asserted (`UV_HANDLE_CLOSING`, async.c:94). A run that fully succeeded ended in a
//     crash message, which the person reading it cannot tell from the work failing.
//  2. Replacing it with `exitWhenDrained` — which sets the exit code and lets the loop
//     DRAIN — turned the `if (ONCE)` block into a fall-through, so a smoke test would
//     have carried straight on into the forever loop and never returned.
//
// The second was introduced while fixing the first, and the file still parsed. Only
// running it catches either. Playwright is not installed next to the bot scripts, so the
// import is stubbed — no browser is launched on this path anyway (the feed is
// unreachable, so the pass returns before `withRC`).
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BOT = path.resolve(import.meta.dirname, '../scripts/auto-cart-bot');

/** A copy of the bot scripts with a stub `playwright`, runnable from this repo. */
function stagedBot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-bot-'));
  for (const f of fs.readdirSync(BOT).filter((f) => f.endsWith('.mjs'))) {
    fs.copyFileSync(path.join(BOT, f), path.join(dir, f));
  }
  const pw = path.join(dir, 'node_modules/playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), JSON.stringify({ name: 'playwright', version: '0.0.0', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(pw, 'index.js'), 'export const chromium = { launchPersistentContext: async () => { throw new Error("stub browser"); } };\n');
  fs.mkdirSync(path.join(dir, '.rc-bot-profile'), { recursive: true });
  return dir;
}

test('--once runs one pass and exits, instead of looping or crashing', async () => {
  const dir = stagedBot();
  const started = Date.now();
  // Port 9 (discard) is closed, so the feed fetch fails fast. The pass logs the error and
  // returns — which is exactly the shape of a real pass with nothing to do.
  const { stdout, stderr } = await run(process.execPath, ['rc-hold-runner.mjs', '--once'], {
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, CAMPHAWK_URL: 'http://127.0.0.1:9', AUTOCART_TOKEN: 'test-token', RC_HOLD_POLL_MS: '200' },
  });
  const out = stdout + stderr;

  assert.match(out, /single pass done\./, 'the pass must announce it finished — silence reads as a crash');
  // The forever loop polls every RC_HOLD_POLL_MS. If --once fell through into it, the
  // process would have run to the 60s timeout instead of returning.
  assert.ok(Date.now() - started < 45_000, 'it fell through into the polling loop');
  assert.doesNotMatch(out, /forcing exit/, 'it should drain naturally, not need the hard-exit fallback');
  // The libuv assertion goes to stderr and is what made a successful run look broken.
  assert.doesNotMatch(out, /Assertion failed/, 'exited mid-teardown');
});

test('a pasted placeholder is refused, and it says the shell is why', async () => {
  // The exact value from the setup instructions, left in a PowerShell session. It is
  // truthy, so the "is it set?" check passes; and the shell beats .env by design, so the
  // symptom is a 401 while the file on disk is perfectly correct. That cost two rounds.
  const dir = stagedBot();
  const err = await run(process.execPath, ['rc-hold-runner.mjs', '--once'], {
    cwd: dir, timeout: 30_000,
    env: { ...process.env, AUTOCART_TOKEN: '<same token the rec.gov bot uses>' },
  }).then(() => null, (e: { code?: number; stderr?: string }) => e);
  assert.equal(err?.code, 2, 'it must refuse to run, not fail later as a 401');
  assert.match(err?.stderr ?? '', /placeholder/);
  assert.match(err?.stderr ?? '', /Remove-Item Env:AUTOCART_TOKEN/, 'must name the actual fix');
});

test('a rejected token names WHERE the token came from', async () => {
  // `feed 401` alone says the token is wrong and nothing about which one is in use — so
  // the one you go and check is not the one that failed.
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(401); res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const { stdout, stderr } = await run(process.execPath, ['rc-hold-runner.mjs', '--once'], {
      cwd: stagedBot(), timeout: 30_000,
      env: { ...process.env, AUTOCART_TOKEN: 'looks-real-but-wrong', CAMPHAWK_URL: `http://127.0.0.1:${port}` },
    });
    const out = stdout + stderr;
    assert.match(out, /feed 401/);
    assert.match(out, /from the shell/, 'the source is the fact that makes a 401 actionable');
    assert.match(out, /Remove-Item Env:AUTOCART_TOKEN/);
  } finally {
    server.close();
  }
});

test('a nonzero verdict still reaches the shell', async () => {
  // rc-keepwarm --once exits 1 for a dead session, and start-all/cron read that. Setting
  // process.exitCode instead of calling process.exit() must not lose it.
  const dir = stagedBot();
  fs.rmSync(path.join(dir, '.rc-bot-profile'), { recursive: true, force: true });
  const err = await run(process.execPath, ['rc-keepwarm.mjs', '--once'], { cwd: dir, timeout: 60_000 })
    .then(() => null, (e: { code?: number }) => e);
  assert.equal(err?.code, 2, 'no profile must exit 2, not 0');
});
