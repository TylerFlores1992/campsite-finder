/**
 * The push guard: refuse a `git push` that lands on master.
 *
 * WHY THE FIRST TEST IS THE FALSE POSITIVE. The naive version of this guard searches the
 * whole command for "master" and blocks `git commit -m "merge master" && git push` — a
 * CORRECT action on a feature branch. That version passes review, because it blocks
 * everything it is supposed to block; what it also does is make the override reflexive, and
 * a guard people route around by habit is not a guard. So the case that must never regress
 * is the one where the guard has to stay quiet, and it is asserted first.
 *
 * The second property is the one this repo has been bitten by most: FAILING OPEN. A guard
 * that cannot tell what branch it is on must allow the push, not block it — same posture as
 * `hasAvailabilityInRange` returning null rather than a fabricated empty, and `unknown`
 * never being reported as a dead RC session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decidePush } from '../.claude/hooks/push-guard.mjs';

const FEATURE = 'claude/foo';

test('a quoted "master" in a NON-push segment is not a push to master', () => {
  // The false positive. `git commit` is not `git push`, and the quoted string is one token.
  const d = decidePush({ command: 'git commit -m "merge master" && git push', branch: FEATURE });
  assert.equal(d.blocked, false,
    'blocked a correct commit-then-push on a feature branch — the substring-match bug');
});

test('a bare push on a feature branch is allowed', () => {
  assert.equal(decidePush({ command: 'git push', branch: FEATURE }).blocked, false);
  assert.equal(decidePush({ command: 'git push -u origin claude/foo', branch: FEATURE }).blocked, false);
});

test('a bare push while HEAD is master is blocked', () => {
  // No refspec, so git pushes the current branch — which is master.
  const d = decidePush({ command: 'git push', branch: 'master' });
  assert.equal(d.blocked, true);
  assert.match(d.reason ?? '', /master/);
});

test('master named as a ref is blocked regardless of the current branch', () => {
  for (const command of [
    'git push -u origin master',
    'git push origin HEAD:master',
    'git push --force origin master',
    'git push --force-with-lease origin master',
    'git push origin refs/heads/master',
    'git push origin :master', // a delete is still landing on master
  ]) {
    const d = decidePush({ command, branch: FEATURE });
    assert.equal(d.blocked, true, `should have blocked: ${command}`);
  }
});

test('pushing local master to a DIFFERENT branch is allowed', () => {
  // `master:experiment` never touches origin/master. Blocking it would be the substring bug
  // wearing a refspec.
  assert.equal(decidePush({ command: 'git push origin master:experiment', branch: 'master' }).blocked, false);
});

test('the override clears an explicit master target', () => {
  const d = decidePush({ command: 'CH_ALLOW_MASTER_PUSH=1 git push origin master', branch: FEATURE });
  assert.equal(d.blocked, false, 'the escape hatch must work, or it gets deleted along with the guard');
});

test('the override is per-SEGMENT, not per-command', () => {
  // Excusing one push must not excuse a second one chained after it.
  const d = decidePush({
    command: 'CH_ALLOW_MASTER_PUSH=1 git push origin master && git push origin HEAD:master',
    branch: FEATURE,
  });
  assert.equal(d.blocked, true, 'the override leaked from the segment it was attached to');
});

test('an undeterminable branch fails OPEN when no master is named', () => {
  for (const branch of [null, undefined, '']) {
    assert.equal(decidePush({ command: 'git push', branch }).blocked, false,
      'a guard that cannot read the branch must not block');
  }
});

test('an undeterminable branch still blocks an EXPLICIT master target', () => {
  // Failing open is about what we cannot know; the refspec is right there in the command.
  assert.equal(decidePush({ command: 'git push origin master', branch: null }).blocked, true);
});

test('git global flags that take a value do not hide the subcommand', () => {
  // `-C <dir>`: skipping the flag without skipping its value reads the DIRECTORY as the
  // subcommand, and every push through it sails past the guard.
  assert.equal(decidePush({ command: 'git -C /repo push origin master', branch: FEATURE }).blocked, true);
  assert.equal(decidePush({ command: 'git -c user.name=x push', branch: 'master' }).blocked, true);
});

test('non-push git commands are ignored even when they name master', () => {
  for (const command of [
    'git checkout master',
    'git rebase origin/master',
    'git fetch origin master && git rebase origin/master',
    'git log --oneline master..HEAD',
  ]) {
    assert.equal(decidePush({ command, branch: FEATURE }).blocked, false, `should ignore: ${command}`);
  }
});

test('a push buried in a chain is still inspected', () => {
  const d = decidePush({
    command: 'npm run typecheck && git add -A; git commit -m wip && git push origin master',
    branch: FEATURE,
  });
  assert.equal(d.blocked, true, 'only the first segment was inspected');
});

test('a malformed command does not throw', () => {
  for (const command of ['', '   ', undefined as unknown as string, null as unknown as string]) {
    assert.doesNotThrow(() => decidePush({ command, branch: FEATURE }));
  }
});

test('the hook is registered on PreToolUse for Bash', () => {
  // The guard existing and the guard RUNNING are different facts, and this repo has shipped
  // the first without the second (`6006428` changed only the copy; the `--claimed` fix was
  // present but inert). A hook nothing invokes is a file.
  const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
  const entries = settings?.hooks?.PreToolUse ?? [];
  const matched = entries.filter((e: { matcher?: string }) => e.matcher === 'Bash');
  assert.ok(matched.length > 0, 'no PreToolUse hook matching Bash');
  const commands = matched.flatMap((e: { hooks?: { command?: string }[] }) =>
    (e.hooks ?? []).map((h) => h.command ?? ''));
  assert.ok(commands.some((c: string) => c.includes('push-guard.mjs')),
    'push-guard.mjs is not wired into settings.json');
});
