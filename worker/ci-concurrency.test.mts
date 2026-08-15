/**
 * The verify workflow must not run TWICE on one commit.
 *
 * WHY (measured on PR #44, 2026-08-15). `npm test` hits the REAL database on
 * purpose — the alerting claim's correctness lives inside one
 * `INSERT .. ON CONFLICT .. WHERE`, and a mock would test a fake. The workflow
 * already serialises the suites WITHIN a run (`--test-concurrency=1`) because nine
 * files share fixture rows.
 *
 * The same reasoning had not been applied ACROSS runs. The concurrency group was
 * keyed on `github.ref`, which is `refs/heads/claude/…` for the `push` event and
 * `refs/pull/<n>/merge` for the `pull_request` event on the SAME commit — two
 * strings, two groups, two simultaneous runs. They started 18 seconds apart; one
 * passed and one failed in `worker/ridb-photos.test.mts`, asserting a row it had
 * queried was empty (`undefined !== 0`) while the sibling run rewrote that fixture.
 *
 * A flake indistinguishable from a regression is worse than a slow queue: it
 * teaches people to re-run CI without reading it, which is how a real failure gets
 * waved through. This is guarded mechanically because the defect is one
 * interpolation in one YAML line and is invisible by reading it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = readFileSync('.github/workflows/verify.yml', 'utf8');

test('verify is serialised per BRANCH, so a PR does not race its own push', () => {
  const m = /^concurrency:\s*\n\s*group:\s*(.+)$/m.exec(wf);
  assert.ok(m, 'verify.yml must declare a concurrency group');
  const group = m![1].trim();

  // The fix: fall back to github.ref, but prefer the PR's HEAD BRANCH so the
  // pull_request run lands in the same group as the push run for that branch.
  assert.match(
    group,
    /github\.event\.pull_request\.head\.ref/,
    'the group must key on the PR head branch, or a pull_request run gets its own ' +
    'group and executes alongside the push run for the identical commit — two ' +
    'suites at once against the production DB',
  );
  assert.ok(
    !/^verify-\$\{\{\s*github\.ref\s*\}\}$/.test(group),
    'keying on github.ref ALONE is the bug: it differs between push and pull_request',
  );
});

test('verify still cancels superseded runs, and still runs its tests serially', () => {
  // cancel-in-progress is deliberately the OPPOSITE of worker-deploy.yml: a
  // half-finished verify changes nothing, a half-finished deploy leaves the poller
  // stopped and alerting dead.
  assert.match(wf, /cancel-in-progress:\s*true/,
    'a superseded verify must be cancelled, not queued behind the new one');
  // The within-run guard this test generalises. If it ever goes, the across-run
  // fix above is treating a symptom.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.test, /--test-concurrency=1/,
    'the suites share fixture rows; node:test parallelises FILES by default');
});
