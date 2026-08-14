# Next session — fix the Chromium memory leak

*Rewritten 2026-08-14 evening, after the day that ended with RC rendering again and the box
healthy on `7780c32`. **Delete this file once the leak is diagnosed.***

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
> **Two known instrument bugs to fix while you are in there**, both of the house shape where a
> failure and a success print the same thing: `kill-chrome` reports "SURVIVED" for processes
> that are actually a *fresh* browser the keep-warm opened inside its own 3-second re-check
> (print pids and diff the sets), and `memory`'s per-family rollup prints `0` because its
> PowerShell array arithmetic throws (`op_Addition`) while the per-process list is correct.
>
> Working rules: push to a branch, let `npm run verify` and CI go green, then merge to master.
> Mutation-test any regression test — break the code, watch it fail — before trusting it.
> `autocart.rc_session` reading dead between releases is CORRECT, not a fault.

---

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

**Where to start**
1. Two `memory` readings five minutes apart. Rate, not absolute.
   ```
   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-command-probe.mts memory
   ```
2. Settle the family from the full `--user-data-dir`, never a substring.
3. Only then decide the fix. A periodic recycle is NOT obviously right: the RC keep-warm tab is
   resident **on purpose** (an 8-second visit every 20 minutes renewed nothing), so recycling it
   trades a proven mechanism for an unproven one. If the leak is on a **rec.gov** profile, the
   keep-warm is not implicated and a recycle there is cheap.

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
