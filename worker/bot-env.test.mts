// Every process the mini-PC launches on boot must read scripts/auto-cart-bot/.env.
//
// THE BUG THIS EXISTS TO STOP. The .env loader was copy-pasted privately inside bot.mjs
// and broker.mjs, so a NEW process started life unable to read the config. rc-hold-runner
// shipped that way on 2026-08-07 and answered `feed 401` — indistinguishable from a wrong
// token, and start-all.bat passes no environment of its own, so it would have failed that
// way on every boot, silently, all night.
//
// Deploying to that box is a human running update.bat, so a broken boot script is not a
// thing we can notice from here. This test is the only place that can.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../scripts/auto-cart-bot/load-env.mjs';

const BOT = path.resolve(import.meta.dirname, '../scripts/auto-cart-bot');
const bat = fs.readFileSync(path.join(BOT, 'mini-pc/start-all.bat'), 'utf8');

/** npm script name → the file it runs, from the bot's own package.json. */
const npmScripts: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(BOT, 'package.json'), 'utf8'),
).scripts;

/** Every .mjs start-all.bat launches, whether directly or through an npm script. */
function launchedScripts(): string[] {
  const out = new Set<string>();
  for (const m of bat.matchAll(/node\s+([\w.-]+\.mjs)/g)) out.add(m[1]);
  for (const m of bat.matchAll(/npm\s+(?:run\s+)?(\w+)/g)) {
    const cmd = npmScripts[m[1] === 'start' ? 'start' : m[1]];
    const f = cmd?.match(/([\w.-]+\.mjs)/)?.[1];
    if (f) out.add(f);
  }
  return [...out];
}

test('start-all.bat launches the processes we think it does', () => {
  const found = launchedScripts();
  // A sanity check on the parser itself: if the .bat is reformatted into a shape the
  // regexes miss, every assertion below would pass vacuously over an empty list.
  assert.ok(found.length >= 4, `expected 4+ launched scripts, parsed: ${found.join(', ') || '(none)'}`);
  for (const f of ['bot.mjs', 'broker.mjs', 'rc-keepwarm.mjs', 'rc-hold-runner.mjs']) {
    assert.ok(found.includes(f), `${f} is no longer launched at boot — intentional?`);
  }
});

test('every boot process reads .env', () => {
  for (const file of launchedScripts()) {
    const src = fs.readFileSync(path.join(BOT, file), 'utf8');
    assert.match(
      src,
      // Anchored to the start of a line so a COMMENTED-OUT call does not satisfy it —
      // the first draft of this test passed happily against `// loadEnv(...)`.
      /^loadEnv\(import\.meta\.url\);/m,
      `${file} runs at boot with no environment of its own and never calls loadEnv() — ` +
        `AUTOCART_TOKEN and every other setting will be undefined, and the symptom will ` +
        `be whatever a missing value does downstream (a 401, not a "missing .env")`,
    );
  }
});

test('there is ONE loader, not a copy per process', () => {
  // The private copies are what let a new process be written without one.
  for (const file of fs.readdirSync(BOT).filter((f) => f.endsWith('.mjs') && f !== 'load-env.mjs')) {
    const src = fs.readFileSync(path.join(BOT, file), 'utf8');
    assert.doesNotMatch(
      src, /function loadEnv\s*\(/,
      `${file} defines its own loadEnv — import it from ./load-env.mjs instead`,
    );
  }
});

test('the loader reads values, and an exported variable still wins', () => {
  // Run the real loader against a real file, rather than asserting on its source — the
  // point is what it DOES. `AUTOCART_TOKEN=... node rc-hold-runner.mjs` is how you point
  // one run at staging or test a rotated token, and if the file overwrote it the
  // override would look like it worked while the old value was in force.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-env-'));
  fs.writeFileSync(
    path.join(dir, '.env'),
    ['CH_TEST_FROM_FILE="file-value"', "CH_TEST_OVERRIDDEN='file-value'", '# a comment', ''].join('\n'),
  );
  process.env.CH_TEST_OVERRIDDEN = 'shell-value';
  delete process.env.CH_TEST_FROM_FILE;

  loadEnv(pathToFileURL(path.join(dir, 'anything.mjs')).href);

  assert.equal(process.env.CH_TEST_FROM_FILE, 'file-value', 'quotes stripped, value loaded');
  assert.equal(process.env.CH_TEST_OVERRIDDEN, 'shell-value', 'the shell must win');
  delete process.env.CH_TEST_FROM_FILE;
  delete process.env.CH_TEST_OVERRIDDEN;
});

test('a missing .env is not an error — it is the normal case off the mini-PC', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-env-'));
  assert.doesNotThrow(() => loadEnv(pathToFileURL(path.join(dir, 'anything.mjs')).href));
});
