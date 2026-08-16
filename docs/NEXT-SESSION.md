# Next session — the renewal is BUILT and UNPROVEN on the box

*Rewritten 2026-08-15, latest. The previous version asked for a schedule around the
bootstrap; that is written, tested and merged. **It has never run on the mini-PC.** The one
job now is to watch it there and read the answer. Everything below the horizontal rule is
archive — resolved sections kept for their reasoning.*

> ## THE GOAL: confirm `✓ renewed by authorize` on the box, then stop babysitting
>
> ### What changed, and the correction that made it work
>
> The prior handover recorded "`renewByReload` genuinely fails" as settled. It fails, and the
> reason was wrong: **a plain page load is not the bootstrap.** The 2x2 is complete and every
> cell is reproduced off one evening of `tail-log rc-keepwarm` —
>
> - a plain load produces nothing, whether a short token is present (4x) or the profile is
>   genuinely signed out (2x, one of them sitting dead through two twenty-minute checks with
>   `okta session STILL ALIVE`);
> - a **click on RC's own sign-in control** produces a full **59-minute** token with no
>   credential typed (2x, ~19s after the click).
>
> With no token in storage RC's SPA renders signed-out and issues no `/authorize` of its own.
> The clear was necessary and never sufficient. `hasRefreshToken:false` is unaffected — what
> re-mints is a full authorization-code round trip that Okta answers from the `idx` cookie.
>
> ### What was built
>
> - `renewByReload` → **`renewSession`**: reload, then — only if the reload produced nothing —
>   the click. The result names the **stage** that minted the token, so the standing "has the
>   SDK's own bootstrap started working?" measurement is not thrown away to save a navigation.
> - `scripts/auto-cart-bot/renewal-schedule.mjs` decides **when**, and the case it adds is the
>   one the old loop refused outright: a token that has ALREADY expired. That refusal cost
>   ninety dead minutes on 08-15. Rationed on its own terms (floor 5m, gap 10m, backoff 30m
>   after 3 failures, never a stop) because a re-mint is not a login and must not spend the
>   login's one-attempt-per-release budget.
> - `maybeAutoLogin` is **untouched**. It stays the release-critical repair at T−30.
>
> ### THE ONE THING TO DO: get it onto the box and read the log
>
> It is bot-side, so it reaches the mini-PC only via `update.bat`, "Update now", or a
> 02:00–05:00 PT quiet-window run. Confirm with `git-status` through `bot_commands` —
> `autocart.bot_version` is a hint and has read a stale sha next to a live heartbeat before.
>
> ```
> NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status
> NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts tail-log rc-keepwarm:120
> ```
>
> **What a working night looks like:** `renewing the session — the app holds no usable token`
> followed by `✓ renewed by authorize`, and the `⚠ RC SESSION IS DEAD … okta=ALIVE` runs
> disappearing. **What to read carefully:**
>
> - **`✓ renewed by reload`** would be genuinely new — the SDK's own bootstrap working — and
>   means this can be simplified back down. Do not skim past it.
> - **`got as far as: no-signin-control`** is the known weak cell, and it is the near-expiry
>   one: on 08-15 18:22 a clear left the SPA still rendering its signed-in header, so no
>   "Log in" anchor existed. Expect it sometimes. The token then expires, the profile becomes
>   token-less, and the reliable cell takes it on the next pass — minutes lost, not the night.
> - **`got as far as: none`** repeatedly is a dead Okta session, and that is the honest
>   negative the design wants: it is obtained WITHOUT calling `oktaSessionAlive`, which
>   refreshes Okta's own idle timer. The schedule deliberately probes Okta only when there is
>   a token to lose, so a long-lived session in these logs is no longer partly our own doing.
> - **The 12h Okta session is still the ceiling**, and it has never been measured across a
>   night where nothing asked. That measurement is now possible for the first time; it is the
>   next real finding, not something to assume either way.
>
> **Nothing here is proven until that log line appears.** What exists today is two
> hand-triggered reproductions of the mechanism plus 27 mutation-verified guards on the
> plumbing. Neither is a run of the schedule.

## The state of everything else, 2026-08-15 evening

- **The box was on `d72fb2e`** (confirmed by `git-status`, not inferred) — the auto-login
  fixes, the hold-runner stand-off and the corrected renewal clear. **THE GAP IS NO LONGER
  WEB-SIDE ONLY:** the two-stage `renewSession` and the schedule are bot-side, so until the
  box updates it goes on doing exactly what the 08-15 log shows, and the whole point of this
  change is unobservable. Re-read `git-status` rather than this line — a reading goes stale
  faster than the conclusion drawn from it, and that rule has bitten here twice.
- **No holds were queued** at 15:43 PT, so nothing is at risk overnight and the 02:00–05:00
  quiet window is open. Test holds were queued and expired during the day's diagnosis; the
  readout is what says whether that is still true.
- **Alerting is healthy** — 16 of 18 checks green; the two warns are the `bot_version` gap
  and the login rehearsal, which has never passed and has no green to have lost.
- **The RC session was healthy at 15:43 PT** (token 48m), from a bootstrap at 22:26 UTC. That
  is `maybeAutoLogin` doing its job on a test hold, not the new schedule — which is exactly
  the confusion to avoid when reading the first post-update log.

## Still open, in rough priority

1. **RC automation** — above. Built; **unproven on the box.** The remaining work is an
   update and a night of log-reading, not more code.
2. **No park watch has ever run a poller cycle** (migration 070). The expansion is provably a
   no-op today and every new branch is gated on `multi`, so the path is dormant and safe —
   and completely unexercised. **Do not advertise park watches until one has been created and
   watched through a cycle.** The watches list still does not show a park watch's parts, and
   `/manage/<token>` can only enumerate the representative division.
3. **Muting is proven on the WRITE half only.** The batch endpoint was driven end to end
   against production; nobody has confirmed the POLLER honouring a mute set from `/new`. That
   is the half that was silently broken on 08-13, so it deserves a real check rather than a
   source-level chain.
4. **The Chromium leak** — downgraded. rec.gov has a flat 134-145 MB baseline; the
   unattributed 08-12 event (7.9 GB in 46s) cannot be caught by a 2-minute cadence.
   `OVERSIZED PROCESS` is the only reporter. Wait for a recurrence. `rc-profile-old/` on the
   box is the only copy of the evidence — do not delete it.
5. **`TWILIO_AUTH_TOKEN` should be removed from the agent environment** — full account
   access, added for a one-off long since finished. Only the owner can do it.
6. **The A2P campaign edit** is blocked on Twilio enabling API campaign edits (#28871693).

## Working rules that keep being earned

- **Push to a branch, open a PR.** A hook blocks master and `docs/LANES.md` makes the PR the
  only merge path. `npm run verify` + CI green first. After a squash merge, reset the branch
  to `origin/master` rather than fighting a divergent history.
- **Mutation-test every regression test, and ASSERT THE MUTATION APPLIED.** Four guards this
  session initially proved nothing — two matched an identical line in a different function,
  one missed a two-line compound condition, one broke the code so thoroughly that a different
  test failed. A green that proves nothing is worse than no test.
- **When you extract behaviour into a new function or file, check whether an existing guard
  pinned it BY NAME.** Six have now needed updating for this.
- **A reading goes stale faster than the conclusion drawn from it.** This session sent the
  owner to the mini-PC over a refusal the box had already resolved by the time it was read.
  Re-read `git-status` before sending anyone to the keyboard.
- **NO BACKTICKS in SQL comments** in `worker/poller.ts`, `src/lib/watch-openings.ts` and
  friends — the queries are template literals and a backtick ends the string, with the parse
  error surfacing somewhere unrelated. It cost a build even with the warning fresh.
- **`autocart.rc_session` reading dead between releases is CORRECT.** Do not tell the owner
  to sign in by hand on that basis; it has been wrong twice and cost a hold both times.
- Use ABSOLUTE paths on the mini-PC — a failed `cd` there is silent.
- **Put nothing in a fenced code block that a human should not paste verbatim.**

---

## ~~STOP — ONE HUMAN ACTION IS BLOCKING EVERYTHING BELOW (2026-08-15)~~ — CLEARED, see below

**IT CLEARED ITSELF at 09:00 UTC and nobody needs to go to the box.** The section is kept
because the *recipe* below is the right one next time an elevated generation survives — and
because it was written, acted on, and overtaken within two hours, which is the "a reading goes
stale faster than a conclusion drawn from it" rule biting again. **Read the RESOLVED subsection
before doing anything here.**

~~The mini-PC is running `e6a7ebf`. Its checkout is on `c1bd875`. Only a person at the box,
with an ELEVATED prompt, can fix it.~~ It is on `be93fcd` and the forced keepalive sample is
running.

**IF YOU DO EVER NEED IT: GIVE THE OWNER THESE TWO LINES AND NOTHING ELSE.** An earlier version of this block
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

### RESOLVED 2026-08-15 — the box fixed ITSELF, and the ~20s churn was leaked test fixtures

**The STOP section above is obsolete. Do not send anyone to the keyboard for it.**
`autocart.bot_version` reads `be93fcd`, and `chromium_memory_samples` carries 17 rows with
`source = 'bot-keepalive'` since 09:01 UTC — two per 30-minute cycle, exactly as designed. So
the forced keepalive sample IS running and **the rec.gov family has been sampled for the first
time**: 7-9 processes, **134-145 MB, flat across nine cycles**. That is the baseline that never
existed. A scheduled quiet-window update at 02:00 PT is the likely repair (inference from the
timing — nobody read the updater's log).

The RC browser opening and closing on a ~20s beat was **not** the duplicate generation. An
aborted `npm test` run left four `requested` holds with numeric unit ids, and the production
hold runner asked the keep-warm for the Chromium profile on every 15s attempt. Full write-up in
CLAUDE.md under "npm test TOLD THE PRODUCTION BOT TO CART A REAL CAMPSITE". Fixed with
non-numeric sentinel fixture ids plus `worker/hold-fixture-safety.test.mts`, which found two
more files with the same hazard.

**The lesson for this page:** the first draft of this section confidently blamed the duplicate
generation. One `rc-holds-readout.mts` run settled it. Read the instrument before writing the
paragraph.

---

## ~~STOP — READ THIS FIRST (added 2026-08-14, later still)~~ — CLEARED 2026-08-15

*The sampler's false zeros were fixed and the fix reached the box in the 09:00 UTC quiet-window
update. The series is honest now and the rec.gov family has a baseline. Kept for the reasoning,
which is the house failure shape in its purest form: an instrument recording a zero it had not
measured. **Nothing here needs doing.***

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

*Current as of 2026-08-15 evening. Nothing is blocked on a human; the box is healthy and on
current code. The 08-15 auto-login fixes are merged but have NOT yet reached the box.*

> Read `docs/NEXT-SESSION.md` first — the block at the very top — then CLAUDE.md.
>
> **This session is for making the RC session renew itself: option 6 of the 08-15 automation
> review.** It is the only remaining option that removes the human from the loop permanently.
> Everything shipped on 08-15 makes the auto-login reliable; this would make it unnecessary.
>
> **The discriminating fact is already measured.** `renewByReload` ran properly on the box on
> 08-15, against a live Okta session, and did NOT renew — `578s → 552s`, the token only aged
> and the restore guard put it back. But the **login rehearsal clears the same two localStorage
> keys and RC re-mints within seconds, no credential typed** (observed 08-11; the mobile app
> probe saw the same shape on 08-13). Two clears in this repo, apparently of the same thing,
> and only one works.
>
> **Start by diffing them line by line** — `renewByReload` in `scripts/auto-cart-bot/rc-token.mjs`
> against the rehearsal path in `rc-keepwarm.mjs` / `rehearsal.mjs`. If the clears really are
> equivalent, the difference is in the reload, the wait, or what is asked afterwards, not the
> clear. Do not start by rewriting the renewal.
>
> **Do not record "RC will not renew" as settled.** One reading of OUR path failing, beside a
> different path in the same codebase succeeding, is not that conclusion — and this file has
> twice hardened a single observation into a fact and paid for it.
>
> **The 08-15 fixes are merged and NOT on the box.** `attemptLogin` now proves the session will
> COVER the release rather than merely exist; the budget is two attempts, not one; every gate
> names itself; the hold runner stands off the Chromium profile after two dead-session passes.
> All bot-side, so they need an `update.bat`, "Update now", or a quiet window. `autocart.bot_version`
> is a hint, not proof — `git-status` through `bot_commands` is what actually answers "did it land?".
>
> **A real test hold is how you prove any of this**, and `scripts/rc-test-hold.mts --find` picks
> a genuinely bookable unit rather than an invented one. Queue it with plenty of lead, not
> minutes before the release, and only when the owner is free to watch — it locks a real site.
> Read the outcome with `scripts/rc-holds-readout.mts`, and `mini-pc\rc-check.bat` is the box-side
> equivalent.
>
> Working rules: **push to a branch, then open a PR** — a hook blocks pushing to master and
> `docs/LANES.md` makes the PR the only merge path. `npm run verify` and CI green first.
> **Squash-merging leaves your branch and master with divergent histories for identical
> content**, so after a merge reset the branch to `origin/master` rather than fighting a
> conflict. Mutation-test every regression test — break the code, watch it fail — and **assert
> the mutation actually applied**. When you extract behaviour into a new function or file,
> **check whether an existing guard pinned it by name**: three did on 08-15 and would have gone
> green against code that no longer did the thing. `autocart.rc_session` reading dead between
> releases is CORRECT, not a fault. Use ABSOLUTE paths on the mini-PC, and put nothing in a
> fenced code block that a human should not paste verbatim.

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

1. **MAKE THE RC SESSION RENEW ITSELF** — the headline, see the top of this file. The
   discriminating experiment is a line-by-line diff of the login rehearsal's storage clear
   (which re-mints) against `renewByReload`'s (which does not, measured 08-15). If they really
   are equivalent, the difference is in the reload or the wait, not the clear.
   **Why it is worth a whole session:** it is the only option that removes the human from the
   loop permanently. Everything shipped on 08-15 makes the auto-login reliable; this would make
   it unnecessary.
2. **The Chromium leak** — downgraded 2026-08-15. The rec.gov family now has a flat 134-145 MB
   baseline across nine cycles, so the ordinary keepalive browser does not leak. What remains
   unattributed is the 08-12 event (7.9 GB in 46 seconds), which a 2-minute cadence cannot
   catch by construction — `OVERSIZED PROCESS` is the only reporter. Wait for a recurrence
   rather than hunting it; `rc-profile-old/` on the box is still the only copy of the evidence.
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
