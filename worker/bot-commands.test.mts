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
import { readFileSync } from 'node:fs';
import { rejectReason, BOT_COMMAND_KINDS, MAX_PENDING, COMMAND_TTL_MS } from '../src/lib/bot-commands.js';
import { COMMANDS, KINDS, LOGS, scrub, runCommand, MAX_OUTPUT } from '../scripts/auto-cart-bot/bot-commands.mjs';

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
  const listing = botFile.slice(botFile.indexOf("'list-processes'"), botFile.indexOf("'git-status'"));
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
