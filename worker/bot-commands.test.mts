/**
 * The mini-PC diagnostics channel.
 *
 * WHAT IT IS FOR. On 2026-08-11 a broken on-demand update took six round-trips to diagnose,
 * and every one was "please type `type logs\something.log` and paste the result". The box
 * has no inbound path, so the answer rides the hold runner's existing authenticated poll.
 *
 * WHAT THESE TESTS ARE PROTECTING. Not the feature — the boundary. That machine holds the
 * live ReserveCalifornia session, the DPAPI credential store, and a residential IP two
 * providers have already blocked. Anyone holding AUTOCART_TOKEN can talk to this table, so
 * the difference between "a fixed list of read-only diagnostics" and "a shell on someone's
 * home network" is exactly what is asserted below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectReason, BOT_COMMAND_KINDS, MAX_PENDING, COMMAND_TTL_MS } from '../src/lib/bot-commands.js';
import { COMMANDS, KINDS, LOGS, scrub, runCommand, readTextFile, MAX_OUTPUT } from '../scripts/auto-cart-bot/bot-commands.mjs';

const botFile = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');
const runner = readFileSync('scripts/auto-cart-bot/rc-hold-runner.mjs', 'utf8');

test('the box implements exactly the kinds the server can ask for', () => {
  // Two allowlists, and they must not drift. The box's is authoritative — it implements
  // each kind itself — but a server that can name a kind nobody implements just produces
  // confusing failures.
  assert.deepEqual([...KINDS].sort(), Object.keys(BOT_COMMAND_KINDS).sort());
});

test('an unknown kind is refused on BOTH sides', async () => {
  // The server check is a convenience so a typo fails at the point of asking. The box's
  // check is the security boundary, and it must stand alone — assume the server is lying.
  assert.match(rejectReason('rm -rf', null) ?? '', /unknown kind/);
  const r = await runCommand('powershell -c whoami', null);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /this box only runs/);
});

test('the box never executes anything the server sends', () => {
  // THE WHOLE DESIGN. `kind` selects a function; `arg` is data that each handler validates.
  // If an argument ever reaches a command line, this stops being an allowlist.
  // COMMENTS STRIPPED FIRST. This is an ABSENCE assertion, and an absence assertion that
  // reads comments fails on the note explaining the rule — so the only way to document why
  // a handler must not interpolate is to not mention the thing it must not do. That trap is
  // already recorded for the .ps1 tests ("must not kill by image name" failing on the comment
  // saying not to); this test had the same hole and `kill-chrome` was the first handler whose
  // comment tripped it.
  const listing = botFile
    .slice(botFile.indexOf("'list-processes'"), botFile.indexOf("'git-status'"))
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.ok(!/\$\{arg\}/.test(listing), 'no interpolation of arg into the PowerShell script');
  // execFile, never exec/shell: no shell means no metacharacters to escape.
  assert.match(botFile, /execFile/);
  assert.ok(!/\bchild_process'\)?\.exec\b|[^F]exec\(/.test(botFile), 'no shell execution');
});

test('tail-log takes a NAME, never a path', async () => {
  // A path parameter is a directory traversal waiting to happen, and `.env` and the profile
  // directories are precisely what an attacker would ask for.
  for (const bad of ['../.env', '..\\..\\.env', '/etc/passwd', '.rc-bot-profile', 'rc-holds/../.env']) {
    assert.ok(rejectReason('tail-log', bad), `server must refuse ${bad}`);
    const r = await runCommand('tail-log', bad);
    assert.equal(r.ok, false, `box must refuse ${bad}`);
  }
  assert.equal(rejectReason('tail-log', 'auto-update'), null);
  assert.equal(rejectReason('tail-log', 'rc-holds:40'), null);
  // And the named set contains no secrets.
  for (const rel of Object.values(LOGS)) {
    assert.match(rel as string, /^logs\//, 'only files under logs/ are readable');
  }
});

test('output is scrubbed before it leaves the machine', () => {
  // A field you have to filter is better not collected — but a log line is inherently
  // mixed, so it is filtered where "not sent" is still true. The 2026-08-09 precart leak
  // shipped an OAuth authorization code past a scrubber that knew JWT shapes, which is why
  // the whole query string goes rather than a list of dangerous parameter names.
  const s = scrub([
    'authorization: Bearer abc123def456ghi789',
    // No scheme word. The `bearer` rule cannot see this one, so it is what actually pins
    // the authorization rule — without it, deleting that rule left every assertion green.
    'authorization: k9x2mq7t',
    'GET https://signin.reservecalifornia.com/login/callback?code=SECRET&state=xyz',
    'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'user tylerflores1992@gmail.com enrolled',
    'cartKey 0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  ].join('\n'));
  assert.ok(!/abc123def456ghi789/.test(s), 'bearer token gone');
  assert.ok(!/k9x2mq7t/.test(s), 'a schemeless authorization value goes too');
  assert.ok(!/SECRET/.test(s) && !/state=xyz/.test(s), 'the whole query string goes');
  assert.ok(!/dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk/.test(s), 'jwt gone');
  assert.ok(!/tylerflores1992@/.test(s) && /@gmail\.com/.test(s), 'email masked but still tellable apart');
  assert.ok(!/0f1e2d3c4b5a69788796a5b4c3d2e1f0/.test(s), 'opaque hex gone');
  // The host and path survive — that is the diagnostic value, and it is not the secret.
  assert.match(s, /signin\.reservecalifornia\.com\/login\/callback/);
});

test('a diagnostic can neither throw nor flood', async () => {
  // This runs inside the process that carts campsites. A diagnostic that can take the
  // runner down, or return a 200MB log, is worse than no diagnostic.
  const r = await runCommand('tail-log', 'auto-update');
  assert.equal(typeof r.ok, 'boolean', 'never throws');
  assert.ok(MAX_OUTPUT <= 32_000, 'the cap is a cap');
  assert.match(botFile, /out\.slice\(-MAX_OUTPUT\)/, 'and it keeps the TAIL — the recent end is the useful end');
});

test('a missing file is an ANSWER, not an error', async () => {
  // "logs\\auto-update.log does not exist" is what finally proved the update script never
  // ran. Reporting that as a failure would have thrown away the finding.
  const r = await runCommand('tail-log', 'update-spawn');
  assert.equal(r.ok, true);
  assert.match(r.output, /does not exist|\S/);
});

test('UTF-16 logs are decoded, not mojibake', () => {
  // PowerShell 5.1's Tee-Object wrote these as UTF-16LE for months — the reason `findstr`
  // answered "input file is in Unicode format" mid-diagnosis. Older files on the box still
  // are, so decoding by BOM rather than assuming UTF-8 is the difference between a readable
  // answer and garbage.
  assert.match(botFile, /0xff && buf\[1\] === 0xfe/, 'UTF-16LE BOM handled');
  assert.match(botFile, /utf16le/);
});

test('the queue is bounded and expires', () => {
  // A diagnostic answers a question somebody is asking NOW. One that surfaces an hour later
  // answers a question about a machine that no longer exists, and runs at a moment nobody
  // chose — after a restart, say.
  assert.ok(MAX_PENDING <= 10, 'no unbounded backlog');
  assert.ok(COMMAND_TTL_MS <= 30 * 60_000, 'stale commands are abandoned');
  assert.ok(COMMAND_TTL_MS > 60_000, 'but comfortably longer than the 15s poll');
});

test('diagnostics never delay a cart', () => {
  // At 08:00:00 nothing may go in front of the precart. Fire-and-forget, not awaited.
  // In control-channel.mjs now, shared by the hold runner and the rec.gov bot — see the
  // header there for why the channel stopped riding one process.
  const channel = readFileSync('scripts/auto-cart-bot/control-channel.mjs', 'utf8');
  const block = channel.slice(channel.indexOf('for (const c of commands)'), channel.indexOf('for (const c of commands)') + 600);
  assert.match(block, /void \(async \(\) => \{/, 'launched, not awaited');
  assert.ok(!/await runCommand/.test(block.split('void (async')[0]), 'nothing awaits a diagnostic inline');
});

test('every kind is implemented', () => {
  for (const k of Object.keys(BOT_COMMAND_KINDS)) {
    assert.equal(typeof (COMMANDS as Record<string, unknown>)[k], 'function', `${k} must be implemented on the box`);
  }
});

test('the argument options match the logs the box will actually read', () => {
  // The admin dropdown is built from `argOptions`. If a log is added to the box's LOGS
  // table and not here, it is unreachable from the UI; if one is listed here and not there,
  // the box refuses it and the option looks broken. Neither is visible by reading either
  // file alone.
  const opts = BOT_COMMAND_KINDS['tail-log'].argOptions as readonly string[];
  assert.deepEqual([...opts].sort(), Object.keys(LOGS).sort());
  // And every option must satisfy the pattern that guards the endpoint, or the UI offers
  // choices the server rejects.
  for (const o of opts) assert.equal(rejectReason('tail-log', o), null, `${o} must be accepted`);
});

test('a BOM-less UTF-16 log is decoded, not turned into NULs', () => {
  // WHAT ACTUALLY BROKE tail-log (2026-08-11). Redirected PowerShell output is UTF-16 with
  // NO BOM, so every BOM branch missed it, the file was decoded as UTF-8, and every second
  // byte became a NUL. Postgres text cannot hold one - so the answer was unstorable, nothing
  // was written, and the command sat at "picked up, never finished". Twice, identically,
  // while `list-processes` in the same batch came back fine.
  const dir = mkdtempSync(join(tmpdir(), 'ch-log-'));
  const f = join(dir, 'utf16-no-bom.log');
  writeFileSync(f, Buffer.from('hello from powershell\r\nsecond line\r\n', 'utf16le'));
  const text = readTextFile(f);
  assert.ok(!text.includes('\u0000'), 'no NULs may survive the decode');
  assert.match(text, /hello from powershell/);
  assert.match(text, /second line/);

  // And ordinary UTF-8 must not be mistaken for it.
  const g = join(dir, 'utf8.log');
  writeFileSync(g, 'plain ascii log line\nanother\n');
  assert.match(readTextFile(g), /plain ascii log line/);
  assert.ok(!readTextFile(g).includes('\u0000'));
});

test('a NUL can never leave the machine, whatever produced it', () => {
  // Belt as well as braces: the decoder above should stop producing them, but a single stray
  // byte from any source makes the whole answer unwritable - an invisible failure, which is
  // strictly worse than a garbled line.
  assert.equal(scrub('before\u0000after'), 'beforeafter');
});

test('a report that cannot be stored still closes the row', () => {
  // Otherwise `finished_at` stays NULL for ever and the admin page reads "picked up, no
  // answer yet" - the same silence as a wedged command. Retrying WITHOUT the output is the
  // point: the payload is the only part that can be unstorable.
  const channel = readFileSync('scripts/auto-cart-bot/control-channel.mjs', 'utf8');
  const block = channel.match(/for \(const c of commands\)[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.ok(block, 'could not find the diagnostics loop');
  assert.match(block, /catch \(e\)/, 'a failed report must be caught, not left to reject');
  assert.match(block, /output: null/, 'and retried without the payload');
  assert.match(block, /could not be stored/);
});

test('a MIXED-encoding log decodes the end, which is the only part tail-log returns', () => {
  /**
   * THE REAL auto-update.log, 2026-08-14. These logs are append-only and have outlived an
   * encoding change: PowerShell 5.1's Tee-Object wrote UTF-16LE for months, and everything
   * appended after supervise.ps1 started setting [Console]::OutputEncoding is UTF-8. So one
   * file holds BOTH.
   *
   * The BOM-less heuristic sampled the HEAD, so it chose UTF-16LE for the whole file and
   * mis-decoded the UTF-8 back - and the back is the only part `tail-log` ever returns.
   * Asked for `auto-update` while diagnosing a stuck update, it came back as solid CJK
   * mojibake, every line of it, which reads as a corrupted log rather than an encoding bug.
   */
  const dir = mkdtempSync(join(tmpdir(), 'ch-mixed-'));
  const f = join(dir, 'auto-update.log');
  writeFileSync(f, Buffer.concat([
    Buffer.from('2026-08-11 02:01:02 [auto-update] old line\r\n'.repeat(24), 'utf16le'),
    // The em dash is deliberate: that is the byte sequence which becomes CJK when UTF-8 is
    // read as UTF-16LE, and the real log is full of them.
    Buffer.from('2026-08-14 13:46:02 [update-guard] SKIP - a hold releases in 5.9h — too close\r\n', 'utf8'),
  ]));

  const text = readTextFile(f);
  assert.match(text, /update-guard\] SKIP - a hold releases in 5\.9h/,
    'the most recent lines are the ones being asked for and must be readable');
  assert.ok(!text.includes('\u0000'), 'no NULs may survive the decode');
});

test('a wholly UTF-16LE log of ODD byte length still decodes', () => {
  // ALIGNMENT. UTF-16LE code units are two bytes, so "NUL on an odd offset" has to mean odd
  // relative to the START OF THE FILE. Sampling from an arbitrary tail offset inverts that
  // parity on a file whose length is odd, and the check then reads the high bytes instead of
  // the NULs - reporting genuine UTF-16LE as UTF-8, which is the original bug wearing a hat.
  const dir = mkdtempSync(join(tmpdir(), 'ch-odd-'));
  const f = join(dir, 'odd.log');
  const body = Buffer.from('supervisor restarted rc-keepwarm\r\n'.repeat(30), 'utf16le');
  // One trailing byte makes the total length odd, as a truncated write would.
  writeFileSync(f, Buffer.concat([body, Buffer.from([0x0a])]));

  const text = readTextFile(f);
  assert.match(text, /supervisor restarted rc-keepwarm/);
  assert.ok(!text.includes('\u0000'), 'no NULs may survive the decode');
});
