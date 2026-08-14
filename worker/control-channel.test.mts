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
/**
 * THE KILL MOVED TO stop-rc.ps1 (2026-08-14), so these guards follow it there.
 *
 * They were asserted against restart-rc.ps1's own body, and extracting the kill left them
 * watching an empty room — every one of them would have passed on a file that no longer
 * killed anything at all. That is the failure mode the extraction itself was fixing, one
 * level up: a step that looks present and does nothing. The properties are unchanged; only
 * the file that has to hold them has.
 *
 * `restartBody` is BOTH files concatenated on purpose. A property that must not appear
 * (the rec.gov bot in a kill pattern) must not appear in either, and a property that must
 * appear may legitimately live in whichever of the two owns it.
 */
const stopRcPs = readFileSync('scripts/auto-cart-bot/mini-pc/stop-rc.ps1', 'utf8');
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
  const body = code(restartPs) + '\n' + code(stopRcPs);
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
  const body = code(restartPs) + '\n' + code(stopRcPs);
  // The re-check lives in stop-rc now, and restart-rc must ABORT on its verdict rather than
  // ignoring it — an extracted check whose caller drops the exit code is no check at all.
  assert.match(code(restartPs), /LASTEXITCODE -ne 0[\s\S]{0,200}?exit 1/,
    'restart-rc must abort when the stop reported survivors');
  // Two Chromium on one user-data-dir corrupt the session this exists to protect, so a kill
  // that did not take must ABORT rather than launch on top of a survivor.
  assert.match(body, /STILL RUNNING/, 'it re-checks rather than trusting the kill');
  assert.match(body, /exit 1/, 'and refuses to launch when something survived');
  // Unsupervised relaunch quietly downgrades the two processes it is fixing: the keep-warm's
  // wedge watchdog exits on purpose EXPECTING a restart, and without a supervisor that is
  // the 2026-08-10 ten-hour silence.
  //
  // ASSERTED BY NAME, NOT BY COUNTING THE STRING `supervise.ps1` (2026-08-14). The count was
  // two because the launch was written out twice; once both went through one helper it fell
  // to one and this failed, over a file that had just been made MORE correct. A test that
  // counts occurrences is measuring how the code is spelled, not what it does - and the
  // duplication it was quietly requiring is what let restart-rc carry a broken -Command in
  // both copies at once. What matters is that each process is relaunched under the
  // supervisor; worker/supervised-launch.test.mts pins the argument quoting.
  assert.match(code(restartPs), /supervise\.ps1/, 'the relaunch goes through the supervisor');
  for (const name of ['rc-keepwarm', 'rc-hold-runner']) {
    assert.match(code(restartPs), new RegExp(`Start-Supervised\\s+"${name}"`), `${name} is relaunched`);
  }
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


test('the flag is informational; the claim happens at the point of USE', () => {
  // THE BUG THIS EXISTS FOR, found while about to rely on it (2026-08-11). The first version
  // granted the update on READ, inside botControlFor. The roster feed is polled every TWO
  // SECONDS by the rec.gov bot, and a box on code older than the control channel ignores the
  // block entirely — so that box consumed the grant instantly and the Windows scheduled task,
  // the only thing that can update a stale checkout, read `false`. The lever disarmed itself
  // on precisely the boxes that needed it.
  const control = readFileSync('src/lib/bot-control.ts', 'utf8');
  assert.ok(!/claimBotUpdate/.test(code(control)),
    'reading the feed must not consume the grant');
  assert.match(control, /botUpdateState/, 'the flag is read, not claimed');

  // And the claim is a separate, explicit act by the process that will spawn the updater.
  const route = readFileSync('src/app/api/auto-cart/rc-holds/route.ts', 'utf8');
  assert.match(route, /body\?\.updateClaim/, 'there must be a claim endpoint');
  assert.match(route, /claimBotUpdate\(body\.updateClaim\)/);

  const channel = readFileSync('scripts/auto-cart-bot/control-channel.mjs', 'utf8');
  const claim = channel.indexOf('updateClaim');
  const spawn = channel.indexOf("spawn('powershell'");
  assert.ok(claim !== -1 && spawn !== -1 && claim < spawn, 'the box claims before it spawns');
  // A claim it cannot reach is a NO. An update is never urgent enough to risk two of them,
  // and the flag stays pending for the next poll.
  assert.match(channel, /\.catch\(\(\) => false\)/, 'an unreachable claim must not read as granted');
});

test('a box on OLD code is unaffected by the claim', () => {
  // THE FLAG STAYS INFORMATIONAL ON THE FEED. That is the compatibility the grant-on-read
  // version silently broke, and it is what lets a stale checkout - running a guard that
  // predates the claim entirely - still be told an update is wanted. The scheduled task is
  // the ONLY way such a box can ever update itself.
  const guard = readFileSync('scripts/auto-cart-bot/update-guard.mjs', 'utf8');
  assert.match(guard, /j\?\.updateRequested === true/, 'the guard reads the flag directly');

  // The current guard DOES claim, deliberately (2026-08-11) - it was the last path that
  // spawned the updater without one. This assertion used to read "must not claim anything",
  // which encoded the old design; it is REPLACED rather than deleted, because the property
  // worth protecting was never "nobody claims", it was "the GET alone still tells you".
  const server = readFileSync('src/lib/bot-control.ts', 'utf8');
  assert.ok(!/claimBotUpdate/.test(code(server)),
    'serving the flag must never consume the grant - an old box would get nothing');
});
