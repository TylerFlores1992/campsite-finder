/**
 * The control channel, and the two things that make it safe to have two readers.
 *
 * WHY IT MOVED (2026-08-11). The update flag and the diagnostics queue were read only by
 * `rc-hold-runner.mjs`. That process died at 09:36 PT and took every remote lever with it —
 * no update, no diagnostics, no way to ask the box a single question — while `bot.mjs`
 * polled the roster feed every two seconds throughout, healthy the whole time. "The box is
 * unreachable" and "the RC runner is down" were the same event; they are different problems,
 * and the second is the one you most want a lever for, because it carts campsites.
 *
 * Two readers introduce two risks, and both are asserted here: two processes spawning the
 * updater over one git checkout, and a `restart-rc` that can be used to flap the RC session
 * from a leaked token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rejectReason, BOT_COMMAND_KINDS, RESTART_RC_BLACKOUT_MIN } from '../src/lib/bot-commands.js';
import { COMMANDS, RESTART_MIN_GAP_MS } from '../scripts/auto-cart-bot/bot-commands.mjs';
import { UPDATE_CLAIM_TTL_MS } from '../src/lib/bot-update.js';
import { UPDATE_RETRY_MS } from '../scripts/auto-cart-bot/control-channel.mjs';

const code = (s: string) => s.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*|REM\b)/i.test(l)).join('\n');
const botUpdate = readFileSync('src/lib/bot-update.ts', 'utf8');
const restartPs = readFileSync('scripts/auto-cart-bot/mini-pc/restart-rc.ps1', 'utf8');
const botCommands = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');

test('exactly one poller is granted an update', () => {
  // Both feeds serve the flag now, so two processes see it on the same tick. Two updaters
  // racing one checkout is worse than a slow update — the rule predates this change; the
  // claim is what keeps it true now that there are two readers.
  //
  // ONE conditional UPDATE, never read-then-write: a read-then-write lets both callers read
  // "unclaimed" and both proceed. Same shape as the alerting claim and the shard lease.
  assert.match(botUpdate, /export async function claimBotUpdate/);
  const fn = botUpdate.match(/export async function claimBotUpdate[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(fn, /UPDATE bot_update_requests[\s\S]*RETURNING id/, 'the claim must be one statement');
  assert.match(fn, /claimed_at IS NULL OR claimed_at </, 'and it must expire');
});

test('the claim expires, but never before the box would retry', () => {
  // A process that claims and then dies before spawning must not block updates for ever —
  // that is the wedge a claim with no TTL creates. But an expiry SHORTER than the box's own
  // retry window would hand a second process the grant while the first is still updating,
  // which is the race the claim exists to prevent, arriving through the other door.
  assert.ok(UPDATE_CLAIM_TTL_MS >= UPDATE_RETRY_MS,
    `the claim (${UPDATE_CLAIM_TTL_MS}ms) must outlast the box's retry window (${UPDATE_RETRY_MS}ms)`);
  assert.ok(UPDATE_CLAIM_TTL_MS <= 60 * 60_000, 'and must not wedge updates for an hour');
});

test('a fresh request is always claimable', () => {
  // Otherwise a claim left by a process that has since died would make the NEXT request
  // unwinnable too — the button would go dead permanently rather than for one TTL.
  const fn = botUpdate.match(/export async function requestBotUpdate[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(fn, /claimed_at = NULL/, 'requesting an update clears any stale claim');
});

test('restart-rc is guarded on BOTH sides, and neither guard trusts the other', () => {
  // This is the first command that changes something, so the blast radius of a leaked
  // AUTOCART_TOKEN changes with it: repeated restarts drop the RC access token, and enough
  // of them near a release costs a hold. The server refuses to QUEUE near a release (it has
  // the hold table); the box refuses to RUN too often (it is the security boundary, and must
  // hold even if the server is lying).
  assert.ok('restart-rc' in BOT_COMMAND_KINDS, 'the server can ask for it');
  assert.equal(typeof COMMANDS['restart-rc'], 'function', 'and the box implements it');

  // The box's rate limit is a FILE, not a variable: this process is restarted by its own
  // supervisor, so an in-memory timestamp would reset with it and a crash loop would lift
  // the limit exactly when it matters most.
  const impl = code(botCommands.match(/'restart-rc': async[\s\S]*?\n  \},/)?.[0] ?? '');
  assert.ok(impl, 'could not find the restart-rc implementation');
  assert.match(impl, /RESTART_MIN_GAP_MS/, 'the box enforces its own floor');
  assert.match(impl, /fs\.(existsSync|readFileSync)\(marker/, 'and it survives a restart of this process');
  assert.ok(RESTART_MIN_GAP_MS >= 5 * 60_000, 'a restart must not be free to repeat');

  // And the server's half must be tied to a real release, not a clock.
  assert.ok(RESTART_RC_BLACKOUT_MIN >= 60,
    'the blackout must exceed the auto-login lead, or a restart could strand a hold with no session');
});

test('restart-rc never kills the process that asked for it', () => {
  // The rec.gov bot is usually the caller — that is the entire point of moving the channel.
  // stop-all.ps1 would kill it mid-command and the reply would never be sent: an operation
  // that destroys the channel that requested it can never report whether it worked.
  const body = code(restartPs);
  // `bot\.mjs` with the backslash, because every pattern in that file is regex-escaped —
  // asserting on the unescaped spelling looked right and matched nothing, so the mutation
  // that added the rec.gov bot to the kill list passed cleanly.
  assert.ok(!/\bbot\\?\.mjs\b/.test(body), 'the rec.gov bot must not be in the kill pattern');
  assert.ok(!/broker\\?\.mjs|cloudflared/.test(body), 'nor the broker or the tunnel');
  assert.match(body, /rc-keepwarm\\\.mjs\|rc-hold-runner\\\.mjs/, 'only the RC pair');
  // Never by image name: taskkill /IM node.exe takes the rec.gov bot with it, and
  // /IM chrome.exe closes the browser of whoever is sitting at the machine.
  assert.ok(!/\/IM\s/i.test(body), 'must not kill by image name');
});

test('restart-rc re-checks, and relaunches supervised', () => {
  const body = code(restartPs);
  // Two Chromium on one user-data-dir corrupt the session this exists to protect, so a kill
  // that did not take must ABORT rather than launch on top of a survivor.
  assert.match(body, /STILL RUNNING/, 'it re-checks rather than trusting the kill');
  assert.match(body, /exit 1/, 'and refuses to launch when something survived');
  // Unsupervised relaunch quietly downgrades the two processes it is fixing: the keep-warm's
  // wedge watchdog exits on purpose EXPECTING a restart, and without a supervisor that is
  // the 2026-08-10 ten-hour silence.
  assert.equal((body.match(/supervise\.ps1/g) ?? []).length >= 2, true, 'both are relaunched supervised');
  // The lock file survives a force kill and would otherwise read as another process holding
  // the profile — for ever.
  assert.match(body, /camphawk-profile-lock/, 'the stale profile lock is cleared');
});

test('the server refuses to queue a restart near a release', () => {
  const lib = readFileSync('src/lib/bot-commands.ts', 'utf8');
  const fn = lib.match(/export async function requestBotCommand[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(fn, /restart-rc/, 'requestBotCommand must special-case it');
  assert.match(fn, /RESTART_RC_BLACKOUT_MIN/);
  // Zone-less Pacific wall-clock, compared in Pacific. `new Date(release_at)` reads it as
  // the SERVER's local time, which on Vercel is UTC — seven hours wrong, in the direction
  // that says "no hold is near" when one is.
  //
  // `code()`, because the comment in the source that warns against this names the very
  // pattern being forbidden. Fourth time in this repo that an absence assertion has matched
  // its own rationale.
  assert.ok(!/new Date\((next|releaseAt)\)/.test(code(lib)),
    'never parse a zone-less release string directly');
  assert.match(lib, /America\/Los_Angeles/);
});

test('a restart request that is refused is refused BEFORE it is queued', () => {
  // A command that reaches the box and is declined there has already spent a claim and a
  // round trip, and reads on the admin page as "ran, did nothing". Rejecting at the point of
  // asking is what makes the reason visible to the person asking.
  const lib = readFileSync('src/lib/bot-commands.ts', 'utf8');
  const fn = lib.match(/export async function requestBotCommand[\s\S]*?\n}/)?.[0] ?? '';
  const guard = fn.indexOf('RESTART_RC_BLACKOUT_MIN');
  const insert = fn.indexOf('INSERT INTO bot_commands');
  assert.ok(guard !== -1 && insert !== -1 && guard < insert, 'the guard must precede the insert');
});

test('an unknown kind is still refused on both sides', () => {
  // Adding a write command must not have loosened the allowlist itself.
  assert.match(rejectReason('restart-everything', null) ?? '', /unknown kind/);
  assert.equal(rejectReason('restart-rc', null), null);
  assert.match(rejectReason('restart-rc', 'now') ?? '', /takes no argument/);
});
