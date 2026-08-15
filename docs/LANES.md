# Two lanes — how the main and side sessions stay out of each other's way

*Written 2026-08-15, when a second session started running alongside the first.*

There are two Claude sessions in this repo. This file is the whole coordination protocol.
It is deliberately short and mechanical: the parts that matter are enforced by a hook and
two tests, because a convention that lives only in prose is one nobody notices breaking.

## Branches

**Neither session works on `master`.**

- Main lane: `claude/<topic>`
- Side lane: `claude/side-<topic>`

**The branch name IS the lane token** — there is nothing to configure, no lock file, no
registry. Look at the branch and you know which session's work you are reading.

`.claude/hooks/push-guard.mjs` refuses a push that lands on master.
`CH_ALLOW_MASTER_PUSH=1` on the front of the command clears it, and it is **reserved for a
genuine incident — it is NOT the merge path.** The override is read from the command and
never from the environment, so it cannot be left switched on the way a config flag or a
disabled scheduled task can.

## Merging — always a pull request

**Merges to master go through a PULL REQUEST, never a local push.**

```
branch  →  npm run verify + CI green  →  PR  →  merge
```

This is a standing instruction: no session needs to ask before opening a PR *for a merge*.
(The ordinary "no PR unless the owner asks" rule is satisfied for this case and this case
only.)

**Why PRs rather than overriding the guard on each merge.** With this workflow the guard
firing ALWAYS means a mistake — there is no legitimate reason for a local push to reach
master — and that is exactly what makes it worth keeping. The alternative was typing
`CH_ALLOW_MASTER_PUSH=1` on every merge, which would make the override routine; an override
used routinely stops being a guard. That is the argument in the hook's own header turned
against it, so the workflow moves instead of the guard.

**Merges are serialized between the lanes. Announce before merging.** A push to master
auto-deploys — Vercel always, and `worker-deploy.yml` on `worker/**` or the `src/lib` dirs
the worker imports (note that a file as innocuous as a new `worker/*.test.mts` matches, and
restarts both poller machines). So a merge lands underneath whatever the other lane is
verifying, and the other lane is then curl-verifying your code without knowing it.

## Merge small and often

Two long-lived branches diverging for days is what turns "two sessions" into a merge
weekend. Land work in small pieces.

**Before every push:**

```
git fetch origin master && git rebase origin/master
npm run typecheck
```

`npm run typecheck` runs **both** tsconfigs. The root one excludes `worker/` and
`scripts/`, which is how the poller — the most consequential code in the repo — went a long
time typechecked by nothing.

## Who owns what

**Main lane**

- `worker/`
- `src/lib/`
- `scripts/auto-cart-bot/`
- `mini-pc/`
- `src/lib/db/migrations/`

Bugs, the poller, alerting, the RC auto-cart flow, and major changes.

**Side lane**

- `src/app/(app)/` marketing + SEO
- `src/components/v2/`
- Store listing text: `docs/play-full-description.txt`, `docs/appstore-description.txt`
- Any new doc it creates, including `docs/NOTES-<its-branch>.md`

**`docs/` is NOT assigned wholesale.** `docs/CONTEXT.md`, `docs/SETUP.md` and
`docs/NEXT-SESSION.md` are the main lane's, for the same reason `CLAUDE.md` is: they are the
three files after it most likely to be appended to from both sides at once.

## One writer for `CLAUDE.md`

**The main lane is the sole writer of `CLAUDE.md`, `docs/CONTEXT.md`, `docs/SETUP.md` and
`docs/NEXT-SESSION.md`.** The side lane records findings in `docs/NOTES-<its-branch>.md` and
the main lane folds them in.

This is not tidiness. `CLAUDE.md` is ~1,200 lines of append-heavy, hard-won evidence; both
sessions will want to write it, and appends to the same region are exactly the conflict a
tired resolution gets wrong. **A finding deleted in a merge reads precisely like a finding
nobody ever wrote** — there is no diff to notice, no test to fail, and the next session
re-runs the experiment that produced it. Half this repo's cost has come from tidy stories
recorded as fact; the other half would come from evidence quietly disappearing.

## Migrations

`src/lib/db/migrations/NNN_name.sql`. Currently at **059**, so the next is **060**.

**Two sessions each writing `060_*.sql` is a collision git merges CLEANLY and Postgres does
not.** Different filenames, no conflict, both land — and then whichever runner applies them
decides what "060" meant. There is no failure at merge time at all.

- **Default: the side lane creates no migrations.**
- If it must, **claim a block out loud** first — main `060–069`, side `070+`.

`worker/migration-numbers.test.mts` asserts every number is claimed exactly once. It
deliberately does **not** assert contiguity: a gap is not a defect, and a test that fails on
a non-defect gets deleted by the next person it inconveniences, taking the duplicate check
with it.

## SERIAL — one session at a time

There is one production database, one mini-PC, and no locking anywhere. Announce before
starting any of these, and wait for the other lane to finish:

- **`scripts/rc-test-hold.mts`** — queues a **REAL** hold, which locks a real campsite. It
  also blocks the 02:00–05:00 PT update window while it is live, and **the other session's
  refusal will look exactly like the 08-12 update deadlock and will not be one.**
- **"Update now" / `update.bat` / `restart-rc` / `kill-chrome`** — one box, and these stop
  or restart processes on it.
- **`sms-link-test.mts --send`** — real texts against the A2P campaign.
- **`npm test`** — it hits the **production DB on purpose**, and
  `sync-claim.test.mts` / `shard-lease.test.mts` test **mutual exclusion** using real rows.
  Two suites at once produce flakes that are indistinguishable from regressions, which is
  worse than a slow queue: it trains both sessions to re-run CI without looking.

Land changes between test runs rather than during one.

## Talking to the other session

`ListAgents` lists the sibling sessions; `SendMessage` reaches one directly. Use it for
exactly the things above — "taking the mini-PC for 20 minutes", "merging in 5", "I need
migration 060".
