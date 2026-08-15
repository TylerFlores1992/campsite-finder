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

  // BOTH SIDES MUST YIELD THE BARE BRANCH NAME, or they are still two strings and
  // therefore still two groups. The first attempt at this fix used
  // `github.event.pull_request.head.ref || github.ref` and CI still ran twice:
  // those give `claude/foo` and `refs/heads/claude/foo`. The expression got longer
  // and the bug did not move.
  //
  // `github.head_ref` is set ONLY on pull_request events and is already bare;
  // `github.ref_name` is the bare name on a push. Only that pair collides.
  assert.match(group, /github\.head_ref/,
    'the group must use github.head_ref, which is the BARE branch on a pull_request');
  assert.match(group, /github\.ref_name/,
    'and github.ref_name, which is the BARE branch on a push');
  assert.ok(
    !/github\.ref\s*\}\}/.test(group),
    'github.ref is refs/heads/<branch> on a push and refs/pull/<n>/merge on a ' +
    'pull_request — it can never collide with the PR side, which is the whole bug',
  );
  assert.ok(
    !/pull_request\.head\.ref/.test(group),
    'pull_request.head.ref is bare while github.ref is not; pairing them looks ' +
    'like a fix and still produces two groups',
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
