/**
 * The dead-man's switch is GONE, and this is what stops it coming back.
 *
 * ## What it was
 *
 * `scripts/deadman-sweep.mts`, on a daily GitHub Actions cron, did two things to every
 * watch that had gone quiet for three weeks:
 *
 *   1. emailed and TEXTED the owner "Still watching <campground>?" with keep / stop links,
 *   2. and if nobody answered within seven days, **switched the watch off**.
 *
 * ## Why it is gone (owner's call, 2026-09-04)
 *
 * *"We send text and emails asking if users are still interested in a site if it is
 * inactive, I'd like to stop doing that. Just keep the watch for the duration."*
 *
 * A watch already has an end: `end_date`. `worker/expire-watches.ts` closes it the hour it
 * passes, and the poller's own filter is `end_date > CURRENT_DATE` — so a watch has never
 * been able to run past the trip it was created for. The sweep was not bounding anything
 * that was not already bounded; it was **cancelling watches their owners still wanted**,
 * and asking a question by SMS that a camper watching a September weekend in August has no
 * reason to answer.
 *
 * It had done that in production: on 2026-09-04, six watches sat `active = false` carrying
 * a `deadman_prompted_at`, and a seventh (Carpinteria SB — Santa Rosa, end date November)
 * had been prompted two days earlier and was five days from being switched off.
 *
 * ## What is deliberately KEPT, and why this test is bidirectional
 *
 * The `keep` / `cancel` / `reopen` action handlers stay. **An emailed link is durable** —
 * the same rule that makes the RC hold action check entitlement a second time — so a
 * prompt sent last week is still in somebody's inbox and its links must still resolve.
 * They cost nothing now that nothing sends new ones.
 *
 * `watches.deadman_prompted_at` stays too, unread. It is the ONLY record of which watches
 * this paused, and nothing distinguishes a row it switched off from one where the owner
 * genuinely tapped "No, stop" — `cancel` never cleared the column. Dropping it would
 * destroy the evidence for a decision (resume them? which ones?) that is the owner's.
 *
 * ## The sharp assertion
 *
 * `deadman_prompted_at = NOW()` is the write that ARMS the auto-pause: phase 1 only ever
 * touched rows carrying one. Setting it to NULL is a clear and stays legal. So the guard
 * is on the arming expression, not on the column — a resurrected sweep has to write that
 * to work, and a test that merely checked for a missing file would pass against the same
 * logic pasted into a different one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/** Every file we are willing to scan, with comments stripped — a guard must not fail on
 *  the prose explaining it, which is how three guards in this repo have had to be redone. */
function code(path: string): string {
  return readFileSync(join(root, path), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('#'))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.next')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mts|mjs|yml|yaml)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('the sweep script is gone', () => {
  assert.equal(
    existsSync(join(root, 'scripts/deadman-sweep.mts')),
    false,
    'scripts/deadman-sweep.mts is back. It prompts "still watching?" by email AND SMS and ' +
      'switches the watch off if nobody answers. The owner asked for it gone — a watch runs ' +
      'for its duration and expire-watches.ts closes it at end_date.',
  );
});

test('nothing is scheduled to run it', () => {
  assert.equal(
    existsSync(join(root, '.github/workflows/deadman.yml')),
    false,
    '.github/workflows/deadman.yml is back.',
  );
  for (const f of walk('.github/workflows')) {
    assert.ok(
      !code(f).includes('deadman-sweep'),
      `${f} runs the dead-man's sweep. Nothing may schedule it.`,
    );
  }
});

test('NOTHING arms the auto-pause — the guard is the write, not the file', () => {
  // `= NULL` is a CLEAR and stays legal: `keep` and `reopen` both do it, and they are the
  // durable emailed links this change deliberately keeps working. Only `= NOW()` arms.
  const arming = /deadman_prompted_at\s*=\s*NOW\s*\(/i;
  const offenders: string[] = [];
  for (const dir of ['src', 'worker', 'scripts']) {
    for (const f of walk(dir)) {
      if (f.endsWith('no-deadman-sweep.test.mts')) continue;
      if (arming.test(code(f))) offenders.push(f);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Something writes `deadman_prompted_at = NOW()`, which is the write that arms the ' +
      'auto-pause: the sweep only ever switched off watches carrying one. Setting it to ' +
      'NULL is fine and is what `keep`/`reopen` do.',
  );
});

test('the one-tap links a sent prompt still carries KEEP WORKING', () => {
  // A prompt emailed before this change is still in somebody's inbox, and its /w/ tokens
  // outlive the thing that minted them. Removing these resolvers would 404 a link we sent.
  const actions = code('src/lib/notifications/actions.ts');
  for (const action of ["'keep'", "'cancel'", "'reopen'"]) {
    assert.ok(
      actions.includes(`case ${action}:`),
      `The ${action} action resolver is gone. Prompts already sent carry that link, and an ` +
        'emailed link is durable — the same reason the hold action re-checks entitlement.',
    );
  }
  assert.ok(
    /export type WatchAction[^\n]*'keep'/.test(actions),
    "'keep' left the WatchAction union, so an already-sent link cannot resolve.",
  );
});
