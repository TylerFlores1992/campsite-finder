import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * THE `tail-log` WINDOW IS A LINE COUNT, AND THREE FILES HAVE TO AGREE ABOUT IT.
 *
 * `bot-commands.mjs` (on the BOX) slices `DEFAULT_TAIL = 80` lines and clamps a caller's `:n`
 * with `Math.min(400, …)`. `src/lib/bot-commands.ts` (on VERCEL) decides whether the request is
 * even accepted, with `argPattern`'s `(:\d{1,3})?`. Neither file mentions the other, the halves
 * deploy by different routes, and a mismatch is silent in the direction that matters: raise the
 * box's cap past 999 and the server refuses the very argument the box now accepts, with a
 * `refused:` that reads as a typo.
 *
 * It is the same shape `worker/bot-commands.test.mts` already guards for log NAMES — a list the
 * box holds and this file omits is unreachable from the admin UI — one field over.
 *
 * AND THE HINT IS PART OF THE CONTRACT, not decoration. It read `a log name, optionally :lines`
 * for a month: true, and it named no number. Every log reading in CLAUDE.md was taken at the
 * 80-line default while the file recorded the constraint as "the last 16,000 characters" — which
 * is `MAX_OUTPUT`, a SECOND cap applied after the slice. Measured 2026-09-17 on one log in one
 * minute: the default reached back 38 minutes, `:400` reached back 89. The lever was always
 * there; the only worked example in the repo asked for `:40`, which NARROWS.
 *
 * Under `src/`, which is in neither of `worker-deploy.yml`'s `paths:` lists — read, not
 * remembered — so this fires no worker deploy and bounces no poller.
 */

const box = readFileSync(new URL('../../scripts/auto-cart-bot/bot-commands.mjs', import.meta.url), 'utf8');
const server = readFileSync(new URL('./bot-commands.ts', import.meta.url), 'utf8');

const boxDefault = Number(/export const DEFAULT_TAIL = (\d+)/.exec(box)?.[1]);
const boxMax = Number(/const n = Math\.min\((\d+),/.exec(box)?.[1]);
const tailLogKind = server.slice(server.indexOf("'tail-log': {"), server.indexOf("'list-processes'"));

test('the box exports a line default and a line ceiling this test can read', () => {
  assert.ok(Number.isFinite(boxDefault) && boxDefault > 0,
    'DEFAULT_TAIL no longer parses — this guard is measuring nothing, fix the anchor');
  assert.ok(Number.isFinite(boxMax) && boxMax > boxDefault,
    "the handler's Math.min ceiling no longer parses, or is not above the default");
  assert.ok(tailLogKind.length > 100, "the 'tail-log' kind block no longer parses");
});

test('the server accepts every :n the box would honour — a narrower pattern is a silent refusal', () => {
  const digits = Number(/argPattern:[\s\S]*?\(:\\d\{1,(\d+)\}\)\?/.exec(tailLogKind)?.[1]);
  assert.ok(Number.isFinite(digits), 'the :n clause is gone from argPattern, or its shape changed');
  const serverMax = 10 ** digits - 1;
  assert.ok(serverMax >= boxMax,
    `argPattern admits at most :${serverMax} while the box honours :${boxMax} — ` +
    'raise the digit count, or the server refuses an argument the box accepts');
});

test('the hint names both numbers, so it cannot go stale in silence', () => {
  const hint = /argHint: '([^']*)'/.exec(tailLogKind)?.[1] ?? '';
  assert.ok(hint.includes(String(boxDefault)),
    `the hint does not name the ${boxDefault}-line default: ${JSON.stringify(hint)}`);
  assert.ok(hint.includes(String(boxMax)),
    `the hint does not name the ${boxMax}-line ceiling: ${JSON.stringify(hint)}`);
});

test('the CLI worked example asks for MORE than the default, not less', () => {
  // The one example in the repo used to be `rc-holds:40`. A reader learnt the syntax and the
  // wrong thing about what it is for, which is worse than no example.
  const cli = readFileSync(new URL('../../scripts/bot-ask.mts', import.meta.url), 'utf8');
  const examples = [...cli.matchAll(/tail-log [a-z-]+:(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(examples.length > 0, 'no `tail-log <name>:<n>` example left in bot-ask.mts');
  assert.ok(examples.every((n) => n > boxDefault),
    `an example asks for :${examples.find((n) => n <= boxDefault)}, at or under the ${boxDefault}-line default`);
});
