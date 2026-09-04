# Two lanes — how the main and side sessions stay out of each other's way

*Written 2026-08-15, when a second session started running alongside the first.*

There are two Claude sessions in this repo. This file is the whole coordination protocol.
It is deliberately short and mechanical: the parts that matter are enforced by a hook and
two tests, because a convention that lives only in prose is one nobody notices breaking.

**"Two" is the assumption, not a guarantee — on 2026-09-04 there were two MAIN lanes and
neither knew it.** Nothing in a branch name, a hook or a test distinguishes them, and
`ListAgents` cannot see a sibling on another machine. See "TWO SESSIONS CAN BE THE *SAME*
LANE" below before trusting anything here to be the only writer.

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

**THE FOLD-IN HAD NO TRIGGER, AND TWO FINDINGS SAT UNFOLDED FOR SIX DAYS (2026-08-30).** That
notes file reached 2,571 lines while being referenced by `CLAUDE.md`, this file and
`docs/NEXT-SESSION.md` a total of **zero** times — so the obligation depended on somebody
remembering a filename nothing named. One of the stranded findings had even flagged its own
misplacement in its own text. **So: `ls docs/NOTES-*.md` and diff its newest sections against
`CLAUDE.md` at the START of a main-lane session, not when you happen to think of it.** A
finding that lives in one file only is a finding the next session re-derives from scratch —
which is the cost this whole one-writer rule exists to avoid, arriving from the other side.

This is not tidiness. `CLAUDE.md` is ~1,200 lines of append-heavy, hard-won evidence; both
sessions will want to write it, and appends to the same region are exactly the conflict a
tired resolution gets wrong. **A finding deleted in a merge reads precisely like a finding
nobody ever wrote** — there is no diff to notice, no test to fail, and the next session
re-runs the experiment that produced it. Half this repo's cost has come from tidy stories
recorded as fact; the other half would come from evidence quietly disappearing.

## Migrations

`src/lib/db/migrations/NNN_name.sql`. **Highest is `074_hold_per_release.sql` (MAIN lane,
2026-09-04).** The main lane's original block 060-069 filled on 2026-08-28 with
`069_line_priority.sql`, and the side lane holds `070_watch_campgrounds.sql`.

> **AND 071 IS EXACTLY THE NUMBER THIS SECTION SAID NOT TO TAKE.** It read *"Do not simply
> take `071`: that is the number both lanes would reach for"*, and the next main-lane
> migration took 071 the following day without claiming a block. **Nothing collided — the
> side lane happened not to write one that week — so this is a near miss, not an incident**,
> and `worker/migration-numbers.test.mts` was green throughout because there was in fact no
> duplicate. The lesson is only that a warning phrased as "do not take the obvious next
> number" loses to the obvious next number, and that the fix is to have a claimed block
> standing at all times rather than a prohibition.

**BLOCKS, RESTATED 2026-09-04: main `075–079`, side `080+`.**

> **THE SIDE LANE TOOK 072 AND 073 OUT OF MAIN'S BLOCK** (PR #258, 2026-09-03) — so
> main's block is four numbers shorter than it was claimed as, and 074 is main's
> (`074_hold_per_release.sql`). **Nothing collided**, because main happened not to need
> a number that week; it is a near miss, not an incident, and
> `worker/migration-numbers.test.mts` was correctly green because there was no
> duplicate. The lesson is the same one the 071 near miss taught, from the other side:
> a block claimed in a file nobody re-reads loses to the next free number. **Restate
> the block here whenever you take one, and take it from YOUR OWN.**
 Take the next free number INSIDE YOUR OWN BLOCK and do not reach past its end
without claiming a new one out loud. **Two sessions each writing the same number is a
collision git merges CLEANLY and Postgres does not.**

**Two sessions each writing `060_*.sql` is a collision git merges CLEANLY and Postgres does
not.** Different filenames, no conflict, both land — and then whichever runner applies them
decides what "060" meant. There is no failure at merge time at all.

- **Default: the side lane creates no migrations.**
- If it must, take the next free number in **`080+`** (its block above). A lane that needs to
  go past the end of its block **claims a new one out loud** first, and edits this line.

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

## TWO SESSIONS CAN BE THE *SAME* LANE, AND ON 2026-09-04 TWO MAIN LANES COLLIDED

This file divides **main** from **side** and says nothing about two sessions of the same lane.
On 2026-09-04 there were two main-lane sessions, neither aware of the other, and the cost was
not a merge conflict — it was **two confident, first-person, mutually exclusive accounts of the
same production index written into `CLAUDE.md` on the same day.** One session applied migration
074; the other diffed the live index against a day-old checkout, called it drift and had the
owner revert it; the first then re-applied it and wrote up "it was never applied", which the
second wrote up as "a mysterious revert". Full write-ups are in `CLAUDE.md` under "TWO SESSIONS
WROTE CONTRADICTORY ACCOUNTS OF ONE INDEX" and "I READ A STALE CHECKOUT AS PRODUCTION DRIFT".

**THE BRANCH NAME IS THE LANE TOKEN AND IT DOES NOT DISTINGUISH TWO OF ONE LANE.** `claude/a`
and `claude/b` are both main. There is nothing in a branch name, a hook or a test that notices.

**AND `ListAgents` DOES NOT TELL YOU.** It lists only sessions on the local machine, so a
cloud-run sibling is invisible and **an empty list is not exclusive use of the database.** It
was read as one that day, twice.

Three habits, each one command, in the order they would have caught it:

1. **`git fetch origin master` before believing any diff**, and especially before calling
   production wrong. The whole revert rested on a local file that master had superseded.
2. **`git log --oneline origin/master -10` at the start of a session.** Three PRs merged that
   morning by the other lane and neither session saw the other's.
3. **`ls docs/NOTES-*.md` and re-read `CLAUDE.md`'s Open block before appending to it** — an
   Open block that already describes today under a different account is the tell.

**A read-back is not enough and that is the sharp part.** The index WAS read back, correctly,
and still produced a false account: a read-back proves the state at one instant and says
nothing about who else is writing. Only the fetch closes it.

## Talking to the other session

`ListAgents` lists the sibling sessions; `SendMessage` reaches one directly. Use it for
exactly the things above — "taking the mini-PC for 20 minutes", "merging in 5", "I need
migration 060".
