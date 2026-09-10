/**
 * `code-bytes` adds a LEVER to the box, so these guard the reasons it is safe to have added
 * one — not that it works, which `pe-rva.test.mts` covers.
 *
 * `scripts/auto-cart-bot/bot-commands.mjs`'s own header refuses a free-form channel because
 * that machine holds the live RC session, the DPAPI credential store and a residential IP both
 * providers have blocked. Levers get added BY NAME, one at a time, and each one has to carry
 * its own argument that cannot be turned into something else. This is that argument for this
 * lever, made mechanical.
 *
 * Under `src/lib/`, not `worker/` — `worker/**` is the first entry in `worker-deploy.yml`'s
 * `paths:`, so a guard over two bot-side files there would restart all three pollers for
 * nothing. Read from the workflow, not remembered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOT_COMMAND_KINDS } from './bot-commands';

const BOX = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');
const PARSER = readFileSync('scripts/auto-cart-bot/pe-rva.mjs', 'utf8');

/** Comments quote the very patterns being forbidden in order to explain them, so a scan that
 *  did not strip them would fail on its own documentation — and get "fixed" by deleting it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The handler body, so a mutation elsewhere in the file cannot satisfy these by accident. */
function handler(): string {
  const c = code(BOX);
  const i = c.indexOf("'code-bytes': async (arg) => {");
  assert.ok(i > -1, 'the code-bytes handler is missing');
  const j = c.indexOf('\n  },', i);
  assert.ok(j > i, 'could not bound the code-bytes handler');
  return c.slice(i, j);
}

test('the ARGUMENT can only ever be hex — a path cannot be smuggled through it', () => {
  const pat = BOT_COMMAND_KINDS['code-bytes'].argPattern!;
  for (const ok of ['18096c6', '0x18096c6', 'DEADBEEF', '1']) {
    assert.ok(pat.test(ok), `${ok} should be accepted`);
  }
  // Every one of these is a file read on the box if the pattern ever widens.
  for (const bad of [
    'C:\\Windows\\System32\\config\\SAM', '../../.env', '.env', '/etc/passwd',
    'chrome.dll', 'a b', '18096c6;whoami', '18096c6 .env', '', '123456789',
  ]) {
    assert.ok(!pat.test(bad), `${JSON.stringify(bad)} must be refused`);
  }
});

test('the box re-validates the argument itself and does not trust the server', () => {
  // The two allowlists are deliberately separate — a leaked AUTOCART_TOKEN reaches the feed,
  // not this repo, so the box's own check is the load-bearing one. Same split as restart-rc's
  // rate limit living on the box rather than only on the server.
  const h = handler();
  assert.match(h, /\/\^\[0-9a-f\]\{1,8\}\$\//, 'the box must re-check the hex shape');
  assert.match(h, /throw new Error\(`expected an RVA in hex/, 'and refuse loudly when it fails');
});

test('it resolves through the SAME package the keep-warm launches with', () => {
  // Only useful if it names the binary actually being run. `rc-keepwarm.mjs` imports
  // `playwright`; the probes in that directory import `playwright-core` on purpose so they run
  // in the dev sandbox, and copying that habit into this command would mean disassembling bytes
  // from a build the box may not be launching — plausible, silent and wrong.
  const keepwarm = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
  const pkg = code(keepwarm).match(/import \{ chromium \} from '(playwright(?:-core)?)'/)?.[1];
  assert.equal(pkg, 'playwright', 'the keep-warm launch import moved — re-check this command');
  assert.ok(handler().includes(`await import('${pkg}')`),
    'code-bytes must resolve through the same package the keep-warm launches with');
});

test('the path is DERIVED from Playwright and the argument never reaches it', () => {
  const h = handler();
  assert.match(h, /chromium\.executablePath\(\)/, 'the path must come from Playwright itself');
  // THE MUTATION THIS EXISTS FOR: `path.join(..., arg)` or a template using `arg`/`hex` in a
  // filename. Anything that puts caller input into the path makes this an arbitrary file read.
  const pathLines = h.split('\n').filter((l) => /dll\s*=|path\.join|openSync|readFileSync|existsSync/.test(l));
  assert.ok(pathLines.length > 0, 'expected to find the path construction');
  for (const l of pathLines) {
    assert.ok(!/\barg\b|\bhex\b/.test(l), `caller input reaches a path: ${l.trim()}`);
  }
  assert.match(h, /'chrome\.dll'/, 'the filename is a literal, not built from input');
});

test('it reads a FILE and never a process — the standing ban is untouched', () => {
  // The ReadProcessMemory/minidump ban is about a renderer's pages being RC session material.
  // Nothing here goes near a process, and that has to stay true as this file grows.
  for (const src of [code(PARSER), handler()]) {
    for (const banned of ['ReadProcessMemory', 'MiniDumpWriteDump', 'OpenProcess', 'createMinidump']) {
      assert.ok(!src.includes(banned), `${banned} must not appear`);
    }
  }
  assert.match(handler(), /readCodeWindow\(/, 'the read goes through the tested reader');
});

test('the file is read at POSITIONS, never loaded whole', () => {
  // chrome.dll is ~200 MB and the process running this is the one that carts campsites. A
  // readFileSync here is a multi-hundred-megabyte allocation on the hot path, which is the
  // "the cure arrives as part of the disease" mistake this repo has recorded three times.
  const c = code(PARSER);
  assert.ok(!/readFileSync\(/.test(c), 'pe-rva must not read whole files');
  assert.match(c, /fs\.readSync\(fd,/, 'positioned reads only');
  assert.match(c, /finally \{\s*fs\.closeSync\(fd\);/, 'the descriptor must be closed on every path');
});

test('a missing chrome.dll is an ANSWER, not a throw', () => {
  // "the file is not there" and "the bytes are wrong" need different responses, and an ENOENT
  // bubbling out as a generic error reads as neither. The box is the only place this can be
  // observed, so it is pinned structurally.
  assert.match(handler(), /if \(!fs\.existsSync\(dll\)\) return /, 'absence must return, not throw');
});
