# Next session — fix the Chromium memory leak

*Rewritten 2026-08-14 evening, after the day that ended with RC rendering again and the box
healthy on `7780c32`. **Delete this file once the leak is diagnosed.***

---

## STOP — ONE HUMAN ACTION IS BLOCKING EVERYTHING BELOW (2026-08-15)

**The mini-PC is running `e6a7ebf`. Its checkout is on `c1bd875`. Only a person at the box,
with an ELEVATED prompt, can fix it — and until they do, nothing about the leak can advance.**

**GIVE THE OWNER THESE TWO LINES AND NOTHING ELSE.** An earlier version of this block
prefixed each line with a `(elevated prompt)` / `(NORMAL prompt)` label, and the owner pasted
the labels — cmd answered `powershell was unexpected at this time`, which reads as a broken
script rather than as a broken instruction. **Anything inside a fenced block on this page is
something a human will paste verbatim.** Put the elevation in the prose, never in the block.

Elevated prompt — Start, type `cmd`, right-click Command Prompt, **Run as administrator**.
The title bar must read *Administrator: Command Prompt*:

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\mini-pc\stop-all.ps1
```

Then a NORMAL (unelevated) prompt:

```
C:\Users\Tyler\campsite-finder\scripts\auto-cart-bot\mini-pc\start-all.bat
```

**Start it back up UNELEVATED.** An elevated generation is invisible to every unelevated
`stop-all`, which is the entire bug: start it elevated again and the next update reloads the gun.
Confirm with `git-status` (checkout) **and** `autocart.bot_version` going `ok` (running code).
Absolute paths, and no `cd`: a failed `cd` on that box is silent, and the next command then
reports a confident result about the wrong directory. `start-all.bat` resolves its own siblings
through `%~dp0`, so it does not care where it is launched from.

### The RC browser cycling every ~20s is a SYMPTOM of this, not a separate fault

Observed by the owner 2026-08-15, while the duplicate generation was still up: the RC Chromium
opened and closed on a roughly 20-second beat, and Chromium offered *"Restore pages? Chromium
didn't shut down correctly"* — i.e. it was being killed, not closed.

`warmResident()` holds RC open continuously and breaks out of its loop for exactly two reasons:
the hold runner asked for the profile (`.camphawk-profile-wanted`), or the window was closed.
**The hold runner polls every 15 seconds.** Two generations means two hold runners each asking,
so the keep-warm yields, reopens, and yields again on that beat — which is what a ~20s cycle
looks like from the desktop.

**HYPOTHESIS, not a measurement** — nobody counted the processes before the restart. To settle
it on a recurrence, count them from an ELEVATED prompt (an unelevated one cannot see the
orphaned generation, which is the whole bug):

```
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'rc-keepwarm|rc-hold-runner' } | Select-Object ProcessId, CreationDate | Format-Table -Auto"
```

Two `rc-keepwarm` rows, or two `rc-hold-runner` rows, with creation times hours apart, confirms
it. If the cycling survives a clean restart it is something else and this paragraph is wrong.

### Why — the finding, 2026-08-15

The forced keepalive sample from `d85bc19` has never run. A real pass happened at 05:31:27 UTC
(`autocart_verified_at` moved for two accounts, 48s apart) and not one of the 250 rows in
`chromium_memory_samples` carried `source = 'bot-keepalive'`. **It was not the in-flight guard
and not a dropped `source` field — the running code is four commits old and `e6a7ebf` contains
zero occurrences of `bot-keepalive`.**

At 05:12 UTC `update.bat` moved the checkout and `start-all` ran. `stop-all` logged a bare
`nothing running.` **twice, thirteen seconds apart**, because its filters are all
`$_.CommandLine -and ...` and an unelevated WMI query reads `$null` for a process in another
security context — so the whole elevated 03:01 generation counted as **zero**. `start-all` took
the `exit 0` as permission, launched a second generation on top, its broker crash-looped on
EADDRINUSE against the elevated orphan on 8787, and the next `stop-all` killed that new
generation — the only one it could see. The pre-update generation survived all of it.

**Fixed this session** (`stop-all.ps1`): the blind note and the port check are functions now,
called from the quiet path as well as the stop path, port check first. The port was bound
throughout, so the fixed version exits 1 and `start-all` refuses to launch. **But the fix is
bot-side, so it only takes effect after the restart above.**

**The same blindness was in the memory sampler** (`memory-sample.mjs`), and it left a row
behind: at 05:12:24 the short-lived unelevated process stored `rc 0` while nine Chromium were
running. `C|` separates "found none" from "never ran"; "ran and could not see" is a third state
that reads identically to the first. It emits a blind count now and reverts to null rather than
recording a zero it could not see. **Also bot-side.**

`autocart.bot_version` had been reading *"mini-PC is on e6a7ebf … MISSING bot-side changes"*
for hours; its next sentence called that "the ordinary wait for a quiet window", which is one of
two causes and the wrong one — the update HAD been applied. That copy now names both causes and
the discriminator. Full write-up in CLAUDE.md.

**Nothing remote fixes this.** "Update now" is a no-op (HEAD is already at the target), and
`restart-rc` uses the same unelevated stop.

---

## STOP — READ THIS FIRST (added 2026-08-14, later still)

### THE BOX UPDATED, THE SERIES STARTED, AND THE SAMPLER'S FIRST ROWS WERE A LIE

The mini-PC reached **`60d9b98`** (owner ran `update.bat`) and samples began arriving every
two minutes exactly as designed. **Every one of them recorded `rc 0 procs, 0 MB`** — while the
`memory` command, interleaved with those samples *seconds apart on the same box through a
byte-identical filter*, reported **NINE Chromium processes on `.rc-bot-profile`**. The commit
figures in the same rows were correct (`10277 MB` against the command's `10.0 GB`), so
PowerShell ran and **only the process scan came back empty**.

**The empty scan is not the bug — the ZERO is.** `memory-sample.mjs`'s own header states the
rule it broke: an absent reading returns nulls, never zeros, because a plausible zero is worse
than a blank. It had been applied to the `M|` line and not to the scan. That is the same
half-application that let the sibling `memory` rollup print `FAMILY rc 0 MB` over a profile
holding 312 MB — **twice now, in the two instruments built to attribute this leak.**

**Fixed and merged, but it is BOT-SIDE, so it needs one more update to take effect:**
- the family counts start `null`, and a zero is written only when the scan proves it ran;
- PowerShell emits **`C|<count>` before the loop**, because "the scan found none of ours" and
  "the scan never completed" were the same evidence and **both are real** (08-14 had a window
  with genuinely zero of our browsers running). It also **localises the failure**: `C|9` with
  no `P|` lines means the loop broke; no `C|` at all means PowerShell stopped before it;
- stderr is read and logged — it was discarded, so the one line explaining the empty scan was
  thrown away where it was produced.

**WHY the scan returns nothing is NOT established, and is deliberately not guessed here.** The
filters are identical, so it is something about how the sampler invokes PowerShell rather than
what it asks. The `C|` line is what will answer it on the next reading — do not theorise ahead
of it, and note the same failure would be invisible again if anyone reinstates the zeros.

**Until that update lands the series is worthless but not misleading:** with counts at 0 the
readout reports `NOT ENOUGH DATA` and warns that no `rc` process was observed, which is the
guard doing its job. **Do not read those rows as evidence about any family.**

**THE ON-DEMAND UPDATE PATH IS BROKEN — do not spend the session pressing "Update now".**
It was tried twice (20:48Z and 21:08Z). Both times the box claimed the request within
seconds, spawned `auto-update.ps1`, ran `stop-all` — stopping every process — and left
`HEAD` at `7780c32`. **Neither attempt logged a single word about why**, and that is now
understood:

- `auto-update.ps1` built `$log` as the RELATIVE path `logs\auto-update.log`. The Windows
  Scheduled Task starts in the bot directory so the TIMER path writes correctly; `bot.mjs`
  spawns the updater with **no `cwd`**, so the on-demand path resolved it to
  `C:\Users\Tyler\campsite-finder\logs\` — a directory that does not exist — and every
  `Add-Content` failed. **Fixed** (absolute, anchored to `$PSScriptRoot`), guarded in
  `update-guard.test.mts`. *Why the directories diverge despite `Set-Location $botDir` two
  lines above is NOT established — the fix removes the question rather than answering it.*
- It compounds: the updater's stdout goes to `logs\update-spawn.log`, written by `bot.mjs`
  — **a process `stop-all` kills on the way through** — so that log necessarily ENDS at the
  stop. Between the two, an on-demand update had no durable record anywhere. That is why
  "Update now takes ~20 minutes" had to be inferred rather than read.

### `stop-all` CANNOT KILL AN ELEVATED ORPHAN, AND SAYS NOTHING ABOUT IT (2026-08-14)

A `broker.mjs` started at some point from an ELEVATED prompt survived every `stop-all`, which
runs unelevated: `taskkill` answers **"Access is denied"** and the script's log is a list of
what it STOPPED, so a refused kill and a successful one look identical in it. The orphan
squatted on port **8787** and every new broker died in one second with `EADDRINUSE` - the
symptom appearing in a DIFFERENT process from the cause, which is why it read as "the broker
is broken".

`supervise.ps1` then gave up after 5 exits in 10 minutes (correctly - a process that dies and
restarts instantly is a busy loop wearing a service's clothes), and the watchdog would not
have restarted it either: bot-or-broker down while the RC pair is UP is the deliberate NAMED
hole, because `start-all` would end a live RC session. So it stays down until a human acts.

Diagnose it with `netstat -ano | findstr :8787` then `tasklist /FI "PID eq <pid>"`; the kill
needs an ELEVATED prompt. **The fix `stop-all` still needs is to re-check by NAME after
killing and report survivors** - the same lesson as the Chromium children it could not match,
and as `kill-chrome`'s "SURVIVED" line.

**The request has been WITHDRAWN** (`requested_at = NULL`), because a pending request
re-spawns the updater every ~15 minutes and each attempt bounces every process on the box.
Leaving it set would have churned all night.

### ~~RESOLVED 2026-08-15 05:15 UTC — the box has the keepalive sampler, and the running code is current~~
### WRONG, AND KEPT VISIBLE. The running code was NOT current — see the STOP section at the top.

**The check below was the right check and it was read at the wrong moment.** `memory` was asked
at 05:14:25, ~two minutes after the `start-all` at 05:12:23 — so it was answered by the process
that had *just* started, which really was current, and which was killed nine seconds later by the
`stop-all` at 05:12:34. Everything after that was answered by the surviving pre-update process.
**A reading goes stale faster than the conclusion drawn from it** (CLAUDE.md, 08-12); here it went
stale in seconds, and the conclusion was written as a resolution. The absent `op_Addition` error
proves the code answering *that* question was current; it cannot prove which process answers the
next one. `autocart.bot_version` is the standing version of this check and it was reading
`e6a7ebf` the whole time.



**Box is on `c1bd875`** (owner ran `update.bat` then `start-all`), which carries the forced
keepalive sample. Verified BOTH halves, because the checkout moving is not the same fact as
the process moving:

- `git-status` -> `HEAD c1bd875 on master`;
- `memory` -> **`FAMILY rc 8 process(es), 266 MB private`** with **no `op_Addition` error**.
  That absent error is the cheap proof the RUNNING code is current - earlier the same day the
  checkout read current while `bot.mjs` executed the previous modules from memory, and both
  instruments lied in the same direction.

**`git show c1bd875:scripts/auto-cart-bot/bot.mjs | grep -c bot-keepalive` returns 1.**

**THE FIRST recgov SAMPLE IS DUE ~30 MINUTES AFTER THE BOT STARTED, NOT IMMEDIATELY.**
`keepSessionsWarm` runs on a fixed `KEEPALIVE_MS` (30 min) interval from `bot.mjs` start, and
the forced sample is taken from inside its `withBrowser` block. The bot restarted ~05:03 UTC,
so expect the first `recgov` row around **05:33**, then two per cycle.

Until one appears the readout keeps warning that no `recgov` process was observed. **That is
the guard being honest, not the fix having failed** - and it is the reading to check first,
because it is the difference between "the instrument still cannot see that family" and "the
family has now been sampled and looks fine".

### RESOLVED 2026-08-15 03:01 UTC — the update landed and the sampler is honest

Box and web are both on **`e6a7ebf`**, and the series records real numbers again:
`rc 325 MB, pid 2360 130 MB`, with zeros now appearing only where the scan proves nothing
was running. **Nothing above this line is an outstanding action any more** — it is kept
because the *reasons* are still live, and one of them nearly cost another evening:

**IT TOOK A `start-all` AS WELL AS THE UPDATE, AND THAT IS THE PART TO REMEMBER.** After
`update.bat` moved `HEAD`, `bot.mjs` went on executing the PRE-UPDATE `bot-commands.mjs` and
`memory-sample.mjs` from memory - so `memory` still printed the old `FAMILY rc 0` line with
its `op_Addition` error, and the sampler still wrote false zeros, on a box whose checkout was
demonstrably current. Both instruments were stale for the same reason and neither said so;
restarting `bot.mjs` fixed both at once.

**The broker did NOT come back with it** - see the elevated-orphan section above. That cost a
`netstat`, a `tasklist`, an elevated `taskkill` and a second `start-all`. `stop-all` now fails
outright when the broker port is still bound after a stop, so the next occurrence announces
itself instead of surfacing as a crash-loop in a different process.

**`git-status` PROVES THE CHECKOUT MOVED, NOT THAT THE RUNNING CODE DID (2026-08-14).**
An update left `HEAD` at the new sha while `bot.mjs` went on executing the PRE-UPDATE
`bot-commands.mjs` and `memory-sample.mjs` from memory - so `memory` printed the old
`FAMILY rc 0 process(es), 0 MB` and the `op_Addition` error, and the sampler went on writing
false zeros, on a box whose checkout was demonstrably current. **Both instruments were stale
for the same reason and neither said so.** Restarting `bot.mjs` (`start-all.bat`) fixed both
at once. So confirm the checkout with `git-status` AND confirm the running code by OBSERVING
it - an absent `op_Addition` error is the cheapest proof there is.

**CONFIRM WITH `git-status`, NOT with `autocart.bot_version`.** Measured 2026-08-14:
`git-status` said `HEAD 60d9b98 on master` while `bot_commit` sat at the pre-update `7780c32`
**steadily**, sampled eight times over 90 seconds, with `beat_at` advancing every 15s
throughout. A poller that cannot compute its own sha omits the header, COALESCE preserves the
last value anyone reported, and a stale sha sits next to a live heartbeat looking current.
It made the box appear to roll BACKWARDS; it never did. Ask the box directly:

```
requestBotCommand('git-status', null, 'you')   # or the admin diagnostics panel
```

Then the `C|` line answers why the scan was empty.

**Do NOT use "Update now" for this.** That path is the broken one (see below); the manual and
timer paths both work.

### Fixed this session (instruments only — the leak itself is untouched)

The two instrument bugs the old prompt below asks for were **already fixed in `a57f6e7`**;
do not redo them. These are new:

1. **The readout could not see its own crash signature.** `worstGapMin` measured holes
   *between* samples, so a series that simply STOPS — which is exactly what a commit-
   exhaustion crash produces — had no gap at all, and a box that died mid-ramp printed the
   same `NO LEAK IN THIS WINDOW` as an idle one. `seriesEnded` + `lastCommitPct` now tell a
   crash (ends at 90%) from a bot that was merely stopped (ends at ~16%). Additive, never
   replacing the growth verdict.
2. **Size is a second question the rate rule cannot answer.** The 08-12 process reached
   7.9 GB in **46 seconds** — faster than the 2-minute cadence — so the ramp leaves no
   comparable pair and the readout could print `NO LEAK IN THIS WINDOW` over a 7.9 GB
   browser in its own table. `BIG_PROCESS_MB` (1500) reports `OVERSIZED PROCESS`, and is
   deliberately NOT gated on the pair count.
3. **`tail-log` returned the newest lines as mojibake, every time.** These logs are
   append-only and outlived an encoding change, so ONE FILE holds UTF-16LE at the front and
   UTF-8 at the back; the heuristic sampled the head and mis-decoded the tail, which is the
   only part `tail-log` returns. Now split at the last NUL. **This is what made the update
   diagnosis expensive** — the log had to be recovered by hand.
4. **The sync-claim CI flake** blamed the release for a DB blip. The body now records that
   it ran and that is asserted first, so the honest sentence fires instead of
   `Missing expected rejection`.
5. **A doc correction with teeth:** `src/lib/bot-commands.ts` asserted *"The leaking process
   was on a rec.gov profile"* as fact. That is the guess CLAUDE.md records as having been
   made twice, wrongly. Its inference is also undermined by the 08-14 finding that the stop
   patterns could not match Chrome's quoted child processes — which explains "restart-rc
   could not clear it" without saying anything about the family.

**The leak is still unattributed. Nothing in this session measured it.**

### A HYPOTHESIS, LABELLED AS ONE — read before interpreting a long quiet series

**The RC Chromium profile was REPLACED on 2026-08-14**, because something in it made RC's SPA
spin for ever (the blank-page bug). *What* in it did that is recorded as UNKNOWN. Separately,
the 08-12 leak note says the process *"reached 7.9 GB in 46 seconds of the keep-warm
starting"* — and that sentence is already flagged here as ambiguous between `rc-keepwarm.mjs`
(the RC profile) and `keepSessionsWarm()` in `bot.mjs` (rec.gov).

So there are two unexplained failures, in the same week, both around a Chromium profile, and
one of them was fixed by throwing that profile away. **A corrupted profile driving a renderer
loop would produce both.** That is a hypothesis and nothing more — it is exactly the kind of
tidy story this log has twice recorded as fact and had to retract, so do not promote it.

**Why it matters anyway, and the discriminating test:** if it IS the profile, the leak may
simply never recur, and the series will read `NO LEAK IN THIS WINDOW` indefinitely. **Do not
read that as the instrument being broken** — the readout says so itself, and now also reports
`OVERSIZED PROCESS` and a stopped series, so it has more ways to speak than it did. The
counter-evidence would be a recurrence on a fresh profile, which kills the hypothesis outright.

**`rc-profile-old/` is still on the box** — confirmed 2026-08-14 in `git-status`, which lists
it as untracked. It is the only copy of the evidence for both questions. Do not delete it.

---

## THE PROMPT — paste this to open the session

*Current as of 2026-08-15 06:00 UTC. The leak work is BLOCKED on one human action at the box
(see the STOP section at the very top). Everything else in the queue is unblocked.*

> Read `docs/NEXT-SESSION.md` first — the STOP section at the top — then CLAUDE.md.
>
> **FIRST, CHECK WHETHER THE BOX HAS BEEN FIXED**, because the Chromium-leak work cannot
> advance until it has and there is nothing an agent can do about it:
>
> ```
> NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts
> ```
>
> If the samples still carry no `source = 'bot-keepalive'` rows, the box is still running
> `e6a7ebf` while its checkout says `c1bd875` — an elevated process generation that every
> unelevated `stop-all` counts as ZERO. It needs a person at the keyboard: an **elevated**
> `stop-all.ps1`, then `start-all.bat` **unelevated**. Ask; do not burn the session on it.
> `autocart.bot_version` going `ok` is the confirmation, and `git-status` alone is not — it
> proves the checkout moved, not that the running code did.
>
> **While that is outstanding, take item 2 in "Still open": the New-watch Filters control is
> decorative.** `NewWatch.tsx` discards `rvLength`/`electric`/`showers`/`pets` on submit, and
> `worker/` never reads `site_type` at all — `grep -rn "site_type\|siteType" worker/` returns
> zero hits. So a user picks RV and we alert them for tent sites, on a control that looks like
> it works. **The owner asked for a DECISION, not a patch**: thread it into detection, persist
> the rest properly, or drop the panel and say a watch covers the whole campground. Read the
> queue entry — it has the file/line evidence and the one inference in it is labelled.
> Recommend, with the trade-offs, before writing code.
>
> Do NOT take manual `memory` readings to hunt the leak. Three attempts produced three
> non-answers: `keepSessionsWarm()` opens a rec.gov Chromium for a few seconds twice per
> 30-minute cycle, so a five-minute window has ~1 chance in 10 of containing one. That is
> why the forced sample and the 2-minute series exist.
>
> Read a quiet series correctly. Under 10 comparable pairs the readout refuses a verdict, and
> a family with no processes running has been ruled out of NOTHING. The RC profile was
> REPLACED on 08-14 to fix a different bug, so if that profile was also the leak the series may
> read `NO LEAK IN THIS WINDOW` for ever — a real answer, not a broken instrument. That is a
> HYPOTHESIS and must not be promoted. `rc-profile-old/` on the box is the only copy of the
> evidence; do not delete it.
>
> Levers already built, do not rebuild: `kill-chrome rc|recgov|all`, `memory` (spot reading,
> full `--user-data-dir` per process), and `mini-pc\fix-pagefile.ps1`, which raises the COMMIT
> ceiling and is explicitly **NOT** the fix — pagefile peak was 0.4 GB against 34 GB allocated,
> so commit was going to reservations, not paging.
>
> Working rules: **push to a branch, then open a PR** — a hook blocks pushing to master and
> `docs/LANES.md` makes the PR the only merge path. `npm run verify` and CI green first.
> **Squash-merging leaves your branch and master with divergent histories for identical
> content**, so after a merge, reset the branch to `origin/master` rather than fighting a
> conflict. Mutation-test every regression test — break the code, watch it fail — and **assert
> the mutation actually applied**, because one that silently fails to apply is a green proving
> nothing. `autocart.rc_session` reading dead between releases is CORRECT, not a fault. Use
> ABSOLUTE paths on the mini-PC: a failed `cd` there is silent, and the next command then
> reports a confident result about the wrong thing.

## 2026-08-14, later: THE READINGS WERE TAKEN, AND THEY COULD NOT HAVE ANSWERED IT

**The prescribed two readings were run, five and a half minutes apart, and the result is a
clean negative rate that means nothing.** Both readings, and the reason, are why the recorder
below now exists.

| pid | 19:27:31Z | 19:33:01Z |
|---|---|---|
| 2976 | 44 MB | 40 MB |
| 10820 | 114 MB | 93 MB |
| 15392 | 84 MB | 66 MB |
| 16244 / 7720 | 17 / 19 | 14 / 17 |
| 2632 / 7148 / 16316 | 21 / 11 / 2 | 21 / 11 / 2 |

**The same 8 pids in both** — so the browser was never restarted and the numbers are a real
before/after on one process set: 312 MB → 264 MB, about **−9 MB/min**. COMMIT 16% of 57.7 GB.

**And every one of them was on `.rc-bot-profile`. Not a single rec.gov process existed.**
`CHROME 8` equalled `OURS 8`, so there was no other Chromium on the box at all.

**That is structural, not luck.** `keepSessionsWarm` in `bot.mjs` opens a rec.gov Chromium per
enrolled user **every 30 minutes** (`KEEPALIVE_MS`) and closes it again. So the family that has
never been ruled out exists in bursts, and a five-minute window has roughly **one chance in ten**
of containing one. Two manual readings do not merely risk missing it — they are structurally
unlikely to sample it, which is why three attempts have now produced three non-answers.

> **A family with no processes running has been ruled out of NOTHING.** The reading above is
> evidence about the RC keep-warm's resident tab (which looks healthy and flat) and is evidence
> about nothing else. Do not let it be quoted as "the leak did not reproduce".

**Also worth knowing: "keep-warm" names TWO different things**, and that ambiguity is a plausible
part of why the family was guessed wrong twice. `rc-keepwarm.mjs` is the RC session holder;
`keepSessionsWarm()` inside `bot.mjs` is the rec.gov keepalive. The 08-12 note *"it reached
7.9 GB in 46 seconds of the keep-warm starting"* does not say which — and they are different
profile families.

## THE SERIES IS RECORDED NOW (migration 059) — read it, do not re-take readings by hand

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts [--hours 24] [--all]
```

`bot.mjs` samples every two minutes and POSTs it on the roster/feed POST it already makes —
per-family totals, and **the largest single process with its pid**, because the 08-12 event was
ONE process and a family total cannot tell that from thirty ordinary ones.

- **It is hosted in `bot.mjs` deliberately.** The RC pair have died twice while that process
  stayed healthy and polling (2026-08-11, and the 08-14 morning when they were bare Node REPLs).
- **The verdict pairs on `max_pid`.** A rec.gov family total going 0 → 900 MB is usually a browser
  that did not exist in the first sample; subtracting those is not a rate, and without this rule
  it would report a leak on every keepalive pass for ever.
- **It refuses a verdict under 10 comparable pairs**, counting pairs it could actually compare
  rather than rows it fetched. Same posture as `recgov-429-profile.mts`.
- **A GAP IN THE SERIES IS THE SIGNATURE, NOT AN ABSENCE.** Taking a sample spawns PowerShell, and
  spawning is exactly what fails at 99% commit — the `supervise.ps1` failure IS that failure. So
  the samples nearest a crash are the ones most likely to be missing and the series will **end**
  rather than peak. The readout says so; never read the gap as a reading of zero.
- **It needs BOT-SIDE code on the box.** Until `autocart.bot_version` shows the box past `a57f6e7`
  the readout correctly says `NO DATA` — that is not a broken write.

**Still not built, deliberately: any alarm on this.** Every added alarm in this log that was not
carefully justified cried wolf. A warn when COMMIT crosses ~70% — the window where `kill-chrome`
still works and the box is still reachable — is defensible and is the obvious next step, but it
should be decided on the series once there is one, not before.

## The leak — what is measured, and what is still guessed

**Measured (2026-08-12, from the box's own `memory` command):**
- One `chrome.exe` on our profiles at **9.4 GB private**, growing **~395 MB/min**.
- It reached **7.9 GB in 46 seconds** of the keep-warm starting. Not ordinary growth.
- **COMMIT at 99% of 50 GB.** Killing that single pid took it to **21% of 35 GB** — ~41 GB
  freed — after which Windows shrank the lazily-grown pagefile back.
- **Pagefile PEAK 0.4 GB against 34 GB allocated.** Commit was going to *reservations*, not
  paging, which is why `fix-pagefile` is a ceiling and not a fix.

**Consequences already paid:**
- `supervise.ps1` could not start a shell (*"the paging file is too small"*, then an
  `OutOfMemoryException`). The process whose whole job is recovery failed at the one moment it
  exists for — silently, because it is also the thing that would have reported.
- On 08-12 the box wedged so hard **RustDesk could not connect** and it was power-cycled by
  hand. This is why the watchdog cannot close the loop: a Scheduled Task cannot fire on a
  Windows that is not scheduling.
- `disk-free` answered **404 GB** the same night, which reads as "not a space problem" and
  sends the question the wrong way.

**Still guessed — do not write any of this into CLAUDE.md as fact:**
- **Which profile family.** Guessed wrong twice. `…\auto-cart-bot\.rc-bot-profile` contains
  both substrings the candidate patterns match on, so **it cannot be settled by reading
  regexes** — only by a reading that prints the full `--user-data-dir`, which `memory` now does.
- Whether it is the resident RC keep-warm tab, a rec.gov per-user profile, or an orphan.
- **It did not reproduce on 08-14.** Every reading that day was healthy: COMMIT 15–16% of
  57.7 GB, all our Chromium 0.2–0.4 GB total.

**Where to start** *(rewritten 2026-08-14 evening — step 1 used to be "take two readings", and
that is now known not to work; see the section at the top of this file.)*
1. Read the recorded series. It samples the episodic rec.gov browsers that a manual pair misses.
   ```
   NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts --hours 48
   ```
   If it says `NO DATA`, check `autocart.bot_version` — the sampler is bot-side and reaches the
   box only on `update.bat`, "Update now", or a quiet-window run.
2. A single `memory` reading is still the right tool for "what is it doing RIGHT NOW", and it now
   prints the full `--user-data-dir`, a box-side timestamp, and per-family totals that are no
   longer always zero.
3. Only then decide the fix. A periodic recycle is NOT obviously right: the RC keep-warm tab is
   resident **on purpose** (an 8-second visit every 20 minutes renewed nothing), so recycling it
   trades a proven mechanism for an unproven one. If the leak is on a **rec.gov** profile, the
   keep-warm is not implicated and a recycle there is cheap — and a rec.gov browser is opened and
   closed every 30 minutes anyway, so the recycle already exists and the leak would have to be
   *within* one keepalive pass.

**Traps**
- `restart-rc` deliberately does not touch rec.gov Chromium. If the leak is there, the obvious
  lever does not reach it — `kill-chrome recgov` is the one that does.
- **Never kill by image name.** `taskkill /IM chrome.exe /F` closes the browser of whoever is
  sitting at that machine; it is somebody's home PC.
- `list-processes` cannot see any Chromium by construction — it matches our node and PowerShell
  scripts only.
- **Check `rc_runner_heartbeat` (which reports to the SERVER) before believing two local
  diagnostics.** On 08-12 I told the owner the RC pair was dead; it was running the whole time.

---

## Two other things this session turned up

- **The 08-14 08:00 holds ALL EXPIRED UNCARTED.** `#55` and `#C218` were both tapped at 03:00Z
  and neither was carted; `#95` was never tapped; `#L9003` reads *"no cart at release time — the
  hold runner did not pick it up"*. That is consistent with the RC pair having been bare Node
  REPLs that morning (fixed later the same day), and it was **not** re-investigated here. The
  next real hold is what confirms the repair — do not record the REPL bug as proven fixed until
  one carts.
- **`worker/sync-claim.test.mts` flakes in CI**, and it failed on `ba63dca`, a commit touching
  only two `.md` files and a `.ps1` — the identical code had passed 20 minutes earlier. The
  mechanism is the house shape again: `claimSyncJob` catches any DB error and returns `false`, so
  a transient blip is indistinguishable from "another machine holds it", and the test then fails
  with `Missing expected rejection` — which reads as "the release is broken" and is not. Left
  alone as out of scope; worth fixing before it trains somebody to re-run CI without looking.

## Done 2026-08-14 — do not re-do these

- **The blank ReserveCalifornia page was the Chromium profile.** Renaming `.rc-bot-profile` and
  letting a fresh one be built rendered RC completely, with "Log in / Sign up" in the header —
  so the auto-login's selector was never wrong either. **What in that profile did it is
  UNKNOWN**; it survived clearing `Cache`, `Code Cache`, `Service Worker` and `Local Storage`.
  `rc-profile-old` is the only copy of the evidence. Six theories died first (RC redeploying, a
  service worker, the JS bundle, Playwright's version, the WAF, the token-capture hook) — all
  recorded in CLAUDE.md so they are not re-run.
- **`rc-login.bat`'s kill had never once run** — `\"` is not a cmd escape. `mini-pc\stop-rc.ps1`
  is now the single stop path, called with `-File` so no code crosses cmd.
- **`restart-rc` was launching Node REPLs** and redirecting their output into
  `rc-keepwarm.mjs`, corrupting it. Fixed.
- **The watchdog checks each payload by name**, ignores supervisor command lines, and restarts
  processes only — never reboots.
- **The stop scripts could not match Chrome's quoted child processes** (`[^"]*` cannot cross a
  quote). Real bug, fixed, guarded — and explicitly **not** the blank-page cause.
- **The RC session is live** and the box is on `7780c32`, matching master.

## Still open, in rough priority

1. **The Chromium leak** — above.
2. **THE NEW-WATCH FILTERS CONTROL IS DECORATIVE, and this one is a DECISION, not a patch.**
   Measured by the side lane 2026-08-15 (`docs/NOTES-claude-side-lane-setup-f7bpe2.md`
   finding 1) and recorded here because a notes file is not where a user-facing defect
   should live:
   - `NewWatch.tsx` posts only `siteType` (`src/components/v2/NewWatch.tsx:186-198`);
     `rvLength`, `electric`, `showers` and `pets` are collected in the UI and **discarded on
     submit**.
   - `/api/watches` POST persists `site_type` and nothing else from that set.
   - **`worker/` NEVER READS IT.** `grep -rn "site_type\|siteType" worker/` returns zero hits,
     and `loadWatches` (`worker/poller.ts` ~585) does not even SELECT the column.
   - Its only consumer is Campflare, as `campsite_kinds` in `/api/watches/route.ts:241`, for
     non-flex rec.gov watches only — and `CAMPFLARE_API_KEY` is absent from the agent session
     env. **Vercel's env is authoritative and was not readable, so "unset in prod" is
     INFERENCE, not fact.**

   **So a user picks RV and we alert them for tent sites, and the control looks like it
   works.** `NewWatch.tsx` already carries a comment about the auto-cart toggle being "PURELY
   DECORATIVE until 2026-08-01" — same shape, same file, second time.

   Three honest options, and the owner asked for a DECISION rather than a quiet fix:
   thread `site_type` into detection (into `loadWatches` and every source's open-site finder,
   beside the existing `muted_site_ids` exclusion); persist the others too (they are
   CAMPGROUND-level in search, so on a watch they need SITE-level data — `hasElectric()` in
   `src/lib/sources/ridb/transform.ts` already computes electric per campsite, and
   `max_vehicle_length` is a campsites column); or **drop the panel from `/new` and say plainly
   that a watch covers the whole campground**, which is honest and cheap and may be right.

   **Muting is unaffected and works** — `muted_site_ids` is an explicit exclusion the user sets
   from `/manage/<token>`, and nothing writes it automatically, which is correct.

3. **`npm run jsx-spacing` exists but is NOT in `npm run verify`.** An HTML entity makes SWC eat
   a JSX text node's leading whitespace, which silently broke four user-visible strings, and
   this repo escapes entities everywhere. Adding it is a one-line change to the `verify` script
   and is the owner's call. (`verify` is `typecheck && test && build` today.)

4. **A wedge is only caught where the process detects its own wedge.** `supervise.ps1` restarts
   what *exits*; the watchdog restarts what is *missing*; a hung-but-alive process is neither.
   The keep-warm exits on purpose when its loop stalls, so it is covered — nothing else is. The
   server sees it (`rc_runner_heartbeat` goes stale) but nothing acts on it. **Proposed:** let
   the watchdog read that heartbeat and treat "alive but not beating for N minutes" as down. The
   box already polls camphawk.app every 15s, so there is no new plumbing.
5. **A last-resort reboot tier is now defensible** — the owner confirmed 2026-08-14 that the
   bots start at Windows login. Behind repeated `start-all` failures only, carrying the
   updater's release check, and `update-guard.test.mts`'s ban on `Restart-Computer` must be
   NARROWED to that branch rather than deleted. **It is still not the 08-12 fix.**
6. **Can one RC session hold more than one cart?** `rc-probe.mjs --cart-cap` settles it, is on
   the box, and is headful — **only a human at the mini-PC can run it**. Run
   `mini-pc\rc-cart-cap.bat`. Both confounds must be clear (the bot's cart empty AND the
   owner's phone cart empty) and each fakes the pessimistic answer. `INCONCLUSIVE` is not an
   answer. **Do not raise `RC_HOLD_CAPACITY` on reasoning alone.**
7. **Do the cart POSTs fire on Android?** Proven on iOS twice. One Android hand-off answers it;
   `rc-holds-readout.mts` prints the platform per hand-off.
8. **`TWILIO_AUTH_TOKEN` should be removed from the agent environment** — full account access,
   also signs the delivery webhooks, added for a one-off link test long since finished. An agent
   cannot remove it; it is environment config on the owner's side.
9. **The A2P campaign edit is blocked on Twilio** enabling API campaign edits (#28871693).
   Replacement samples are generated and waiting in `docs/a2p-campaign.md` with three caveats.

## Traps worth keeping

- **Use ABSOLUTE paths on that box.** A failed `cd` is silent, and the next command then runs
  somewhere else and reports a result about the wrong thing. That is exactly how "a fresh
  profile is still white" was reported on 08-14 from a test that never ran.
- **`exitCode=21` from `launchPersistentContext` means PROFILE IN USE**, not a crash.
- **The watchdog restarts the RC pair within 5 minutes**, so it fights any test that needs them
  stopped. Disabling that task needs an ELEVATED prompt
  (`schtasks /Change /TN "CampHawk watchdog" /DISABLE`).
- **"Update now" takes ~20 minutes, not ~2**, and shows `SKIP - another process holds the update
  claim` meanwhile. That is transient. **`autocart.bot_version` answers "did it land?"**
- **An `offered` hold does not block the update window; a `requested` one does.** This inverts
  the decision and has been misread twice.
- **Pushing to `master` auto-deploys Vercel.** Land changes between test runs, not during one.
