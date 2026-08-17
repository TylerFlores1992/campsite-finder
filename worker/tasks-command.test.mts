// The `tasks` diagnostic — are the Windows Scheduled Tasks firing, and is anyone logged on?
//
// Both mini-PC Scheduled Tasks went silent at ~05:31 PT on 2026-08-17 and the watchdog that
// fires every five minutes said nothing for 2h32m. **The one fact nobody could obtain
// remotely was whether Windows had run them at all.** The two levers that would have
// answered it are both on the box — RustDesk (which failed the same day with "No displays")
// and physically sitting at it — so the diagnosis waited on a human for the second time.
//
// `bot_task_heartbeat` (migration 060) answers "did it fire?" for firings after the box
// updates. It cannot say WHY one stopped, and it says nothing about a session. This does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOT_COMMAND_KINDS } from '../src/lib/bot-commands.ts';

const BOX = readFileSync('scripts/auto-cart-bot/bot-commands.mjs', 'utf8');
const boxCode = BOX.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('both halves of the channel know the command', () => {
  // The server allowlist and the box implementation are separate files that deploy by
  // DIFFERENT ROUTES — Vercel on push, the box on update.bat or a quiet window. A kind in
  // one and not the other is the two-halves trap, and here it fails as "unknown kind".
  assert.ok(Object.keys(BOT_COMMAND_KINDS).includes('tasks'), 'server allowlist');
  assert.match(boxCode, /^\s{2}tasks: async \(\) =>/m, 'box implementation');
});

test('it reports the four fields the handover asks a human to read', () => {
  // docs/NEXT-SESSION.md tells the owner to run schtasks /Query and look at exactly these.
  // A diagnostic that returns less than the manual step it replaces has not replaced it.
  for (const field of ['Scheduled Task State', 'Last Run Time', 'Last Result', 'Logon Mode']) {
    assert.ok(boxCode.includes(field), `must surface "${field}"`);
  }
  for (const task of ['CampHawk watchdog', 'CampHawk auto-update']) {
    assert.ok(boxCode.includes(task), `must query "${task}"`);
  }
});

test('it reports the SESSION, which is the other half', () => {
  // `install-watchdog.bat` registers with no /RU — "run only when the user is logged on" —
  // so "the session went away" and "Windows disabled the task" are different faults that
  // look identical from the server. A logoff also kills the payloads, so this plus
  // list-processes pins it down: processes alive with no Active session means DISCONNECTED,
  // which is survivable; no session at all means the tasks cannot run by construction.
  assert.match(boxCode, /quser/, 'the session list is required, not optional');
  assert.match(boxCode, /quser unavailable - Active session state unknown/,
    'an absent quser must report UNKNOWN, never an empty session list read as "nobody"');
});

test('a task that is not registered is an ANSWER, not an error', () => {
  // Letting schtasks write to stderr for a missing task would bury the OTHER task's output,
  // and "not registered" is precisely one of the states worth distinguishing.
  assert.match(boxCode, /NOT REGISTERED/);
  assert.match(boxCode, /2>\$null/, 'stderr must be suppressed per query');
  assert.match(boxCode, /if \(-not \$r\) \{/, 'and the empty result handled explicitly');
});

test('it is READ-ONLY', () => {
  // Re-registering or enabling a task should be a decision, never a side effect of asking a
  // question — and a diagnostic that changes what it measures is how "did the update land?"
  // became unanswerable. Scoped to this command's body so the file's other commands, which
  // legitimately kill and restart, are not caught.
  const body = boxCode.slice(boxCode.indexOf('  tasks: async () =>'));
  const end = body.indexOf('};');
  const cmd = body.slice(0, end > -1 ? end : body.length);
  for (const verb of ['/Change', '/Create', '/Run', '/Delete', 'Register-ScheduledTask']) {
    assert.ok(!cmd.includes(verb), `must not ${verb} — this only queries`);
  }
});
