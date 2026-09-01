// THE WORKER DEPLOYS ON A HAND-WRITTEN PATH LIST, AND THE LIST HAD DRIFTED.
//
// `worker-deploy.yml` fires on a push to master touching "code the worker actually
// imports", and its own header says why that matters: a push without a worker deploy
// leaves the change live on the website and absent from the poller. The two halves then
// disagree, silently, with nothing red anywhere — the deploy-by-different-routes trap that
// opened the T-30/T-25 alarm hole on 2026-08-11 and has cost this repo several evenings.
//
// The list names five directories and one file. It does NOT name `src/lib/limits.ts`,
// which `worker/poller.ts` imports for `RC_HOLD_CAPACITY`, nor `src/lib/auth.ts`, which
// carries `hasAutocartEntitlement` — one definition with six enforcers, two of them inside
// the poller. So raising the hold ceiling, or changing who is entitled to auto-cart, ships
// to Vercel and not to Fly: the website would withhold the "Hold it for me" button at a
// ceiling the poller has never heard of, or the poller would keep offering auto-cart to
// somebody the website has already stopped treating as entitled.
//
// IT HAS NEVER BITTEN, AND THAT IS LUCK RATHER THAN DESIGN. Every previous change to those
// files (#86, #89, #91, #125, #138) also landed a `worker/*.test.mts`, which matches
// `worker/**` and fired the deploy as a side effect. What has been covering this gap is the
// house habit of shipping a mutation-verified guard beside every change — a habit, not a
// mechanism. The first push to escape it was #145 on 2026-08-20, a COMMENT-ONLY edit to
// `limits.ts` with no worker file beside it. Harmless because it changed no behaviour, and
// exactly the shape that would not be.
//
// So the list is derived here rather than maintained: this test walks the imports the
// worker really compiles in, TRANSITIVELY, and fails if any of them can be changed without
// triggering a deploy. A direct-only scan would have passed while `src/lib/notifications`
// pulled in half the tree behind it, which is the "guard that inspects a third of what it
// claims" shape recorded a dozen times in CLAUDE.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const WORKFLOW = '.github/workflows/worker-deploy.yml';

/**
 * The `paths:` block of the `push:` trigger.
 *
 * Parsed from the `push:` section specifically, not from the first `paths:` in the file:
 * `workflow_dispatch` comes first and a future `paths-ignore` or a second trigger would
 * otherwise be read as the answer.
 */
function triggerPaths(): string[] {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const push = yml.indexOf('\n  push:');
  assert.ok(push > -1, 'the workflow must still have a push trigger — otherwise NOTHING auto-deploys');
  const at = yml.indexOf('paths:', push);
  assert.ok(at > -1, 'the push trigger must still carry a paths list');
  const out: string[] = [];
  for (const line of yml.slice(yml.indexOf('\n', at) + 1).split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const m = /^\s+- '([^']+)'\s*$/.exec(line);
    if (!m) break;          // the list ends at the first line that is not an entry
    out.push(m[1]);
  }
  assert.ok(out.length >= 5, 'the parse found almost nothing, so it would approve almost anything');
  return out;
}

/** Does any glob in the list cover this repo-relative file? */
function covered(file: string, globs: string[]): boolean {
  return globs.some((g) => {
    if (g === file) return true;
    if (g.endsWith('/**')) return file.startsWith(g.slice(0, -2));
    return false;
  });
}

/**
 * Resolve an import specifier to a repo-relative `.ts`/`.mts` file, or null if it is a
 * package rather than one of ours.
 *
 * `.js` specifiers resolve to their TypeScript source — `db/client.js` is written that way
 * in several files and is `src/lib/db/client.ts` on disk.
 */
function resolveImport(fromFile: string, spec: string): string | null {
  // `@/…` IS THE ALIAS EVERYTHING UNDER src/ USES, AND IGNORING IT MADE THIS WALK
  // DIRECT-ONLY (found 2026-09-01). tsconfig maps `@/*` to `./src/*`. Worker files reach
  // into src with RELATIVE paths, so those resolved and the closure looked healthy — but
  // every file under `src/lib` imports its siblings as `@/lib/…`, so the walk stopped dead
  // at the first hop and saw nothing transitively.
  //
  // The cost was exactly what this test exists to prevent: `src/lib/rc-outage-hold.ts`,
  // imported by `rc-holds.ts` (which IS a trigger path), was invisible — so a change to it
  // alone would ship to Vercel and NOT to Fly, and the site and the poller would disagree
  // with nothing red anywhere. #146's own write-up calls this walk transitive "because a
  // direct-only walk passes today"; it had been direct-only in practice from the start.
  const spec2 = spec.startsWith('@/') ? `./src/${spec.slice(2)}` : spec;
  if (!spec2.startsWith('.')) return null;
  const base = spec.startsWith('@/')
    ? spec2.replace(/^\.\//, '')
    : path.join(path.dirname(fromFile), spec2).replace(/\\/g, '/');
  const stem = base.replace(/\.(js|mjs)$/, '');
  for (const cand of [`${stem}.ts`, `${stem}.mts`, `${stem}/index.ts`, `${stem}.tsx`]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

const IMPORT = /\bfrom\s+'([^']+)'/g;

/**
 * Every file under `src/` that the worker's runtime entry points reach, transitively.
 *
 * Test files are excluded from the ROOTS — `npm test` never runs on Fly, so a test's
 * imports are not "code the worker compiles in" — but they are not excluded from the walk,
 * because nothing under `src/lib` is a test.
 */
function workerImportClosure(): { files: Set<string>; roots: number } {
  const roots = readdirSync('worker')
    .filter((f) => /\.(ts|mts)$/.test(f) && !f.includes('.test.'))
    .map((f) => `worker/${f}`);

  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift()!;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const target = resolveImport(file, m[1]);
      if (!target || !target.startsWith('src/')) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return { files: seen, roots: roots.length };
}

test('every file the worker compiles in also triggers a worker deploy', () => {
  const globs = triggerPaths();
  const { files, roots } = workerImportClosure();

  // A scan that inspects nothing is indistinguishable from one that approves. Both floors
  // are well under today's numbers (16 roots, ~40 reached files) so ordinary growth does
  // not trip them, and a resolver that silently stops resolving does.
  assert.ok(roots >= 10, `only ${roots} worker entry files found — the scan is broken, not the list`);
  assert.ok(files.size >= 20, `only ${files.size} imports reached — the resolver is broken, not the list`);

  const missing = [...files].filter((f) => !covered(f, globs)).sort();
  assert.deepEqual(missing, [],
    'these are compiled into the poller but can be changed without deploying it:\n  ' +
    missing.join('\n  ') +
    `\nAdd them to ${WORKFLOW}'s push.paths, or the website and the poller will disagree ` +
    'about them with nothing red anywhere.');
});

test('the closure really is transitive, or it guards a fraction of what it claims', () => {
  // A direct-only walk would still pass the test above today, because the direct imports
  // happen to be the interesting ones. It would stop covering the moment a worker file
  // reaches something through a re-export — which `src/lib/notifications/index.ts` already
  // does. Pin the property rather than trusting the shape of the loop.
  const { files } = workerImportClosure();

  const direct = new Set<string>();
  for (const f of readdirSync('worker').filter((x) => /\.(ts|mts)$/.test(x) && !x.includes('.test.'))) {
    for (const m of readFileSync(`worker/${f}`, 'utf8').matchAll(IMPORT)) {
      const t = resolveImport(`worker/${f}`, m[1]);
      if (t?.startsWith('src/')) direct.add(t);
    }
  }
  assert.ok(files.size > direct.size,
    `the walk reached ${files.size} files and the direct imports alone are ${direct.size} — ` +
    'it is not following imports through, so it is not the guard this file claims to be');
});

test('the paths list still covers the workflow itself', () => {
  // Deliberate, and load-bearing in the other direction: a change to the deploy workflow
  // must be exercised by the next run rather than sitting untested until something else
  // happens to touch worker/. It is also why merging a change to this list restarts both
  // poller machines — which is correct, and is a reason to land it away from a release.
  assert.ok(covered(WORKFLOW, triggerPaths()),
    'the workflow must trigger on changes to itself');
});
