# Next session — fix the Chromium memory leak

*Rewritten 2026-08-14 evening, after the day that ended with RC rendering again and the box
healthy on `7780c32`. **Delete this file once the leak is diagnosed.***

---

## STOP — READ THIS FIRST (added 2026-08-14, later still)

**THE SAMPLER IS STILL NOT ON THE BOX, AND THAT IS THE ONLY THING BLOCKING THE LEAK.**
`chromium-memory-readout.mts` correctly says `NO DATA`. The box is on `7780c32`;
the sampler shipped in `a57f6e7`. Nothing can be attributed until it updates.

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

**The request has been WITHDRAWN** (`requested_at = NULL`), because a pending request
re-spawns the updater every ~15 minutes and each attempt bounces every process on the box.
Leaving it set would have churned all night.

### The one action that unblocks everything

**A human runs `update.bat` on the mini-PC**, or the **02:00–05:00 PT quiet window** lands
it via the scheduled-task path — the path that has always worked. Nothing is queued, so the
window is open. Once `autocart.bot_version` shows the box past `a57f6e7`, samples arrive
every two minutes and the readout starts answering.

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

---

## THE PROMPT — paste this to open the session

> Read `docs/NEXT-SESSION.md` first, then CLAUDE.md.
>
> **This session is for the Chromium memory leak on the mini-PC.** It is the only failure left
> that has ever required physically power-cycling the box: it exhausts Windows COMMIT, which
> kills `supervise.ps1` (a supervisor that cannot start a shell cannot restart anything) and
> takes every remote lever down with it — the watchdog, `kill-chrome` and `bot_commands` all
> ride processes on that machine.
>
> **Attribution is the blocking step, not a fix.** One measurement exists (9.4 GB private,
> ~395 MB/min, COMMIT 99% of 50 GB) and the profile family was never established — I guessed it
> wrong twice from regexes, which is why `memory` now prints the full `--user-data-dir` per
> process. Get two readings five minutes apart: the growth RATE is the signature, not any single
> number. **Do not read "no leak observed" as "no leak"** — it did not reproduce on 08-14.
>
> The other levers are ready and should not be rebuilt: `kill-chrome rc|recgov|all` kills by
> profile family and is the remote remedy; `memory` is the reading; `mini-pc\fix-pagefile.ps1`
> raises the COMMIT ceiling and is explicitly NOT the fix (pagefile peak was 0.4 GB against
> 34 GB allocated — commit was going to reservations, not paging).
>
>
> ~~Two known instrument bugs to fix while you are in there~~ — **both were already fixed in
> `a57f6e7`** (the `SURVIVED` pid diff and the `op_Addition` rollup). Confirmed by reading the
> code, not the commit message. Do not redo them. **Confirmed live on 2026-08-14 that the BOX
> is still running the broken rollup** — a `memory` reading came back with
> `FAMILY rc 0 process(es), 0 MB` over a profile holding 264 MB, plus the `op_Addition` error,
> because the box has not taken the update. That is a demonstration of the update problem, not
> of the fix being wrong.
>
> Working rules: push to a branch, let `npm run verify` and CI go green, then merge to master.
> Mutation-test any regression test — break the code, watch it fail — before trusting it.
> `autocart.rc_session` reading dead between releases is CORRECT, not a fault.

---

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
2. **A wedge is only caught where the process detects its own wedge.** `supervise.ps1` restarts
   what *exits*; the watchdog restarts what is *missing*; a hung-but-alive process is neither.
   The keep-warm exits on purpose when its loop stalls, so it is covered — nothing else is. The
   server sees it (`rc_runner_heartbeat` goes stale) but nothing acts on it. **Proposed:** let
   the watchdog read that heartbeat and treat "alive but not beating for N minutes" as down. The
   box already polls camphawk.app every 15s, so there is no new plumbing.
3. **A last-resort reboot tier is now defensible** — the owner confirmed 2026-08-14 that the
   bots start at Windows login. Behind repeated `start-all` failures only, carrying the
   updater's release check, and `update-guard.test.mts`'s ban on `Restart-Computer` must be
   NARROWED to that branch rather than deleted. **It is still not the 08-12 fix.**
4. **Can one RC session hold more than one cart?** `rc-probe.mjs --cart-cap` settles it, is on
   the box, and is headful — **only a human at the mini-PC can run it**. Run
   `mini-pc\rc-cart-cap.bat`. Both confounds must be clear (the bot's cart empty AND the
   owner's phone cart empty) and each fakes the pessimistic answer. `INCONCLUSIVE` is not an
   answer. **Do not raise `RC_HOLD_CAPACITY` on reasoning alone.**
5. **Do the cart POSTs fire on Android?** Proven on iOS twice. One Android hand-off answers it;
   `rc-holds-readout.mts` prints the platform per hand-off.
6. **`TWILIO_AUTH_TOKEN` should be removed from the agent environment** — full account access,
   also signs the delivery webhooks, added for a one-off link test long since finished. An agent
   cannot remove it; it is environment config on the owner's side.
7. **The A2P campaign edit is blocked on Twilio** enabling API campaign edits (#28871693).
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
