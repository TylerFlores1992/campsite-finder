#!/usr/bin/env node
// Refuse a `git push` that would land on master.
//
// WHY THIS ONE BLOCKS AND `stop-typecheck.sh` DOES NOT. That hook gates a TURN ENDING and
// can undo nothing — the edits are already on disk, so refusing to let the turn finish buys
// no safety and would eventually stand between a person and their keyboard during an
// incident. This one gates an act that DEPLOYS: a push to master auto-deploys Vercel, and
// `worker-deploy.yml` fires on `worker/**` and the `src/lib` dirs the worker imports. With
// two sessions in the repo it also means one lane can be curl-verifying camphawk.app while
// the other lane's code is what answers. That is worth an exit 2 for.
//
// WHY NODE AND NOT BASH. The decision is a pure exported function with a test
// (`worker/push-guard.test.mts`) — the same split as `update-guard.mjs` +
// `worker/update-guard.test.mts`, for the same reason: the part that can lose work is the
// part that must be testable, and shell is the part nothing can test. A guard that silently
// allows everything is this repo's most-recorded failure shape, so this one is
// mutation-tested against the bugs it is written to prevent.
//
// FAIL OPEN, ALWAYS, on anything it cannot read: unparseable payload, no command, or a
// branch it cannot determine. A guard that misfires gets deleted, and is then gone on the
// ordinary days too.

import { execFileSync } from 'node:child_process'

// The escape hatch. Read from the COMMAND, never from `process.env` — that is the whole
// point of it being per-command. A hook's environment is Claude Code's own process
// environment, so an env-var override could be set once in settings or the container and
// left on for ever, which is exactly the "disabled task" failure this avoids. Written as a
// prefix on the one command it applies to, it expires when that command does, and it is
// visible in the transcript next to the push it excused.
const OVERRIDE = 'CH_ALLOW_MASTER_PUSH=1'

// `git -C <dir>` and `git -c k=v` take a value; skipping the flag without skipping its value
// would read that value as the subcommand.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])

/**
 * Split a shell command into segments on the operators that separate whole commands.
 *
 * WHY SEGMENTS AND NOT A SEARCH FOR "master". `git commit -m "merge master" && git push` is
 * a CORRECT action on a feature branch, and a naive substring match blocks it. A guard whose
 * first victim is correct work is worse than no guard: it teaches people to reach for the
 * override reflexively, and then it is not a guard at all.
 */
export function splitSegments(command) {
  return command.split(/&&|\|\||[;\n]/).map((s) => s.trim()).filter(Boolean)
}

/**
 * Tokenize, treating a quoted run as ONE token.
 *
 * This is the second layer of false-positive protection: in `-m "merge master"` the word
 * master never becomes a token of its own. The first layer is that we only inspect segments
 * whose git subcommand is actually `push`.
 */
export function tokenize(segment) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(segment)) !== null) tokens.push(m[1] ?? m[2] ?? m[3])
  return tokens
}

/** The tokens of a segment that is a `git push`, or null if the segment is not one. */
function pushArgs(segment) {
  const tokens = tokenize(segment)
  // Skip leading `VAR=value` assignments (the override rides in as one of these).
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  if (tokens[i] !== 'git') return null
  i++
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (GIT_VALUE_FLAGS.has(tokens[i])) i++
    i++
  }
  if (tokens[i] !== 'push') return null
  return tokens.slice(i + 1)
}

/** Does this token name master as the branch the push would LAND on? */
function targetsMaster(token) {
  // `origin master`, `origin HEAD:master`, `origin refs/heads/master`, `origin :master`
  // (a delete, which is emphatically landing on master). Deliberately NOT `master:other`:
  // that pushes local master somewhere else and never touches origin/master.
  const dst = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token
  return dst === 'master' || dst === 'refs/heads/master'
}

/**
 * @param {{command: string, branch: string|null|undefined}} input
 *   `branch` is the current HEAD; null/undefined means we could not determine it.
 * @returns {{blocked: boolean, reason?: string}}
 */
export function decidePush({ command, branch }) {
  if (typeof command !== 'string' || !command.trim()) return { blocked: false }

  for (const segment of splitSegments(command)) {
    const args = pushArgs(segment)
    if (args === null) continue

    // The override is per-segment: it excuses the push it is attached to, nothing else.
    if (tokenize(segment).includes(OVERRIDE)) continue

    const refs = []
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        if (PUSH_VALUE_FLAGS.has(args[i])) i++
        continue
      }
      refs.push(args[i])
    }

    // refs[0] is the remote; anything after it is a refspec. An explicit refspec decides on
    // its own — the current branch is irrelevant to `git push origin HEAD:master`.
    const refspecs = refs.slice(1)
    const named = refspecs.find(targetsMaster)
    if (named) {
      return {
        blocked: true,
        reason: `This push targets master (\`${named}\`). Neither lane works on master — see docs/LANES.md.`,
      }
    }

    // No refspec: `git push` / `git push origin` pushes the CURRENT branch. Unknown branch
    // fails open by design; see the header.
    if (refspecs.length === 0 && branch === 'master') {
      return {
        blocked: true,
        reason: 'HEAD is master and this push has no refspec, so it would push master. Neither lane works on master — see docs/LANES.md.',
      }
    }
  }

  return { blocked: false }
}

function currentBranch(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // Detached HEAD reports the literal string "HEAD" — that is "cannot determine", not a
    // branch called HEAD.
    return out && out !== 'HEAD' ? out : null
  } catch {
    return null
  }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    process.exit(0) // Unparseable payload: fail open.
  }

  if (payload?.tool_name !== 'Bash') process.exit(0)

  const command = payload?.tool_input?.command
  const decision = decidePush({ command, branch: currentBranch(payload?.cwd) })
  if (!decision.blocked) process.exit(0)

  // Exit 2 blocks the tool call, and stderr becomes the reason fed back as feedback.
  process.stderr.write(
    `${decision.reason}\n\n` +
      'Push to a branch and merge from there. If you genuinely must push straight to master ' +
      `(the morning something is broken), prefix the command: ${OVERRIDE} git push ...\n`,
  )
  process.exit(2)
}

// Only run the hook when executed directly, so the test can import the pure function.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => process.exit(0)) // Fail open on anything unexpected.
}
