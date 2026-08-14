# Next session — the big push is the Chromium memory leak

*Rewritten 2026-08-14 (21:55 PT on 08-13 Pacific). The previous handover's two items are
still open and are listed at the bottom; the leak is promoted above them because it is the
only failure here that has ever needed **physical access to the machine**. **Delete this
file once the leak is diagnosed.***

---

## THE PROMPT — paste this to open the session

> Read `docs/NEXT-SESSION.md` first, then CLAUDE.md.
>
> **The big push this session is the Chromium memory leak on the mini-PC.** It is the only
> failure in this system that has ever required somebody to physically power-cycle the box —
> it exhausts Windows COMMIT, which kills `supervise.ps1` (a supervisor that cannot start a
> shell cannot restart anything) and kills every remote lever at the same time, so the
> watchdog, `kill-chrome` and `bot_commands` are all gone exactly when they are needed.
>
> Start by separating what is measured from what is guessed — NEXT-SESSION has both, and the
> profile family is the guessed part. **I got that wrong twice**; the RC profile path contains
> both substrings the candidate diagnostics match on, so it cannot be settled by reading the
> regexes. Get a reading with the FULL `--user-data-dir`, twice, five minutes apart, because
> the growth RATE (~320-395 MB/min) is the signature and not the absolute number.
>
> **Also settle this, because it decides whether the watchdog may reboot:** the owner believes
> the bots already start themselves at Windows login. That is UNVERIFIED. See "Do the bots
> start at login?" in NEXT-SESSION for the exact checks and for what it does and does not
> unlock — in particular it does NOT fix the 08-12 wedge, and saying otherwise is the trap.
>
> Then: `mini-pc\rc-cart-cap.bat` (needs a human at the box) and the Android cart POSTs.
>
> Working rules: push to a branch, let `npm run verify` and CI go green, then merge to master.
> Mutation-test any regression test — break the code and watch it fail — before trusting it.
> `autocart.rc_session` reading dead between releases is CORRECT, not a fault.

---

## THE BIG PUSH — a Chromium eats COMMIT until the box is unreachable

### What is actually known (and what is guessed — the two have been mixed up twice)

**Measured, 2026-08-12, from the box's own `memory` command:**
- One `chrome.exe` on our profiles at **9.4 GB private**, growing **~395 MB/min**.
- It reached **7.9 GB in 46 seconds** of the keep-warm starting. That is not ordinary growth.
- **COMMIT at 99% of 50 GB.** Killing that single pid took commit to **21% of 35 GB**,
  freeing ~41 GB; Windows then shrank the lazily-grown pagefile back.
- **Pagefile PEAK was 0.4 GB against 34 GB allocated.** So commit was going to
  *reservations*, not paging — which is why `fix-pagefile` is **not** the fix and would have
  masked this.

**Consequences already paid:**
- `supervise.ps1` could not start a shell at all (*"the paging file is too small"*, then an
  `OutOfMemoryException`). **A supervisor that cannot launch cannot restart anything**, so
  the process whose entire job is recovery failed at the one moment it exists for — silently,
  because it is also the thing that would have reported.
- On 08-12 the box wedged so hard that **RustDesk could not connect and it had to be
  power-cycled by hand.** This is the single reason the watchdog cannot close the loop: a
  Windows Scheduled Task cannot run on a Windows that is not scheduling.
- `disk-free` answered **404 GB** the same night, which reads as "not a space problem" and
  sends the question the wrong way.

**NOT known, and do not write a guess into CLAUDE.md as fact:**
- **Which profile family it is.** I guessed it twice and was wrong both times. The RC profile
  path is `…\auto-cart-bot\.rc-bot-profile`, so it contains **both** the substring `memory`
  matches on and the one `restart-rc` matches on — **the two cannot be told apart by reading
  the regexes**, which is exactly how I got it wrong. Attribute it on the next occurrence
  with evidence.
- Whether it is a leak in the resident RC keep-warm tab, a rec.gov per-user profile, or an
  orphan a force-kill left behind.

### Why it matters more than it looks

`kill-chrome` (added 08-12) gives a remote lever *if you get there in time*. It did not exist
during the outage it was written for, and it is useless once commit is exhausted, because by
then nothing can start a shell to run it. **The remote levers all die together, and this is
the failure that kills them.** Everything else in this system has a self-healing path;
this one ends with somebody driving to the machine.

### Where to start

1. **Get an occurrence with evidence.** `memory` reports the top 12 by private bytes and
   counts our Chromium by the same `--user-data-dir` families `stop-all` kills by. Take a
   reading, then take another five minutes later — the growth RATE is the signature
   (~320–395 MB/min in the three sightings), not the absolute number.
   ```
   # via Admin -> System Health -> Ask the box, or:
   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-command-probe.mts memory
   ```
2. **Settle the profile family with the FULL command line**, not a substring. The reading
   must name the `--user-data-dir` in full. If `memory` cannot show it, that is the first
   fix — a diagnostic that cannot distinguish the two candidate causes is not yet a
   diagnostic.
3. **Then consider whether a periodic recycle is the answer at all.** The RC keep-warm tab is
   resident *on purpose* (a tab open for 8s every 20min renewed nothing — see CLAUDE.md), so
   "just restart it hourly" trades a proven mechanism for an unproven one. If the leak is on
   a **rec.gov** profile, the keep-warm is not implicated and a recycle there is cheap.
4. **`fix-pagefile.bat` is a second line of defence, not the fix.** It raises the ceiling;
   nothing under it comes down. It needs a reboot, so time it like an update.

### Traps

- **`restart-rc` deliberately does not touch rec.gov Chromium**, and was right not to. If the
  leak is on a rec.gov profile, the one lever that exists for a runaway browser does not
  reach the family it came from. `kill-chrome recgov` is the one that does.
- **Never kill by image name.** `taskkill /IM chrome.exe /F` closes the browser of whoever is
  sitting at that machine — it is somebody's home PC.
- **`list-processes` cannot see any Chromium by construction** — it matches our node and
  PowerShell scripts only. Reading it as "nothing unusual is running" is how this was missed.
- **Check `rc_runner_heartbeat` (the thing that reports to the SERVER) before believing two
  local diagnostics.** On 08-12 I told the owner the RC pair was dead and to go to the box; it
  was running the whole time, and the heartbeat would have settled it in one query.

---

## Do the bots start at Windows login? — UNVERIFIED, and it gates the reboot tier

**The owner believes they do** (2026-08-14). Nothing in the repo establishes it, and
`watchdog.ps1`'s header currently says the opposite — *"a reboot is only safe at all if the
bots start themselves at login, which is not something this script can assume"*. That
sentence is the reason there is no reboot tier, so **the belief is worth converting into a
fact or a correction, and it is a five-minute check.**

**How to check, on the box.** There are four places it could be wired, and "I see a shortcut
on the desktop" is not one of them — a desktop shortcut starts nothing:

```
dir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
dir "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup"
reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run
reg query HKLM\Software\Microsoft\Windows\CurrentVersion\Run
schtasks /query /fo LIST /v | findstr /i "TaskName Logon"
```

There is a `mini-pc - Shortcut` on the desktop and an untracked
`"mini-pc - Shortcut (2).lnk"` inside `scripts/auto-cart-bot/` — **neither of those runs at
login**, and the second one is loose in the repo working tree. Worth tidying either way.

**This cannot be checked remotely.** `bot_commands` has a fixed allowlist (`tail-log`,
`list-processes`, `memory`, `kill-chrome`, `git-status`, `disk-free`, `restart-rc`) and
deliberately no arbitrary shell. Adding a `startup-check` command is itself bot-side code
needing an update, so for one question it is cheaper to ask the owner to paste the five
lines above.

**IF IT IS CONFIRMED, here is exactly what it does and does not buy.**
- ✅ It makes a **reboot tier defensible** as a last resort in `watchdog.ps1` — the case where
  processes are dead, `start-all.bat` has failed repeatedly, and there is nothing left to try.
- ❌ **It does NOT fix the 2026-08-12 wedge**, and this is the trap to avoid writing down. That
  box was wedged badly enough that RustDesk could not connect; **a Scheduled Task cannot fire
  on a Windows that is not scheduling**, so the tier would not have run. A reboot tier
  addresses "our processes cannot be revived", not "Windows is unresponsive". The remedy for
  the second one is still the leak.
- ⚠️ **A reboot ends the RC session regardless** (the token lives in the Chromium it closes),
  so any tier must carry the same release guard the updater does — never within 6h of a
  release — and must be a last resort after `start-all.bat` has genuinely failed, not a
  second lever tried in parallel.
- The check to update either way: `update-guard.test.mts` currently fails on any
  `Restart-Computer` / `shutdown /r` in `mini-pc/`. If a tier is added, that assertion becomes
  "only inside the last-resort branch, and only with the release guard" — **do not simply
  delete it**, or the next careless edit reboots the box mid-release.

## Done 2026-08-14 — do not re-do these

- **`rc-login.bat`'s kill had never run.** `\"` is PowerShell's escape and cmd has no
  backslash escape, so the quote closed the string and the next `|` became a cmd pipe —
  `'ForEach-Object' is not recognized`. Fixed by extracting `mini-pc\stop-rc.ps1` and calling
  it with `-File`; `rc-test-login.bat` and `restart-rc.ps1` now share it. Guards moved with
  the behaviour (they would have passed on a file that no longer killed anything). Full
  write-up in CLAUDE.md.
- **The watchdog checks each payload by name**, and restarts processes only — it never
  reboots. It shipped counting the union, which would have read the outage it was written
  for as healthy.
- **The box is on `c7ade45` and its checkout is clean.** `autocart.bot_version` read a stale
  `c682aa8` FAIL only because the runner computes its sha once at startup; a `restart-rc`
  cleared it. **`git-status` via `bot_commands` is how to check this without a human.**

## Still open from the previous handover

### 1. Can one RC session hold more than one cart?
The item that changes capacity. `RC_HOLD_CAPACITY` = `RC_SITES_PER_CART` (2, RC's, measured)
× `RC_MAX_CARTS` (**1, ours, and 1 only because that is all we can prove**).
`rc-probe.mjs --cart-cap` settles it, is on the box, and is **headful — only a human at the
mini-PC can run it**. Run `mini-pc\rc-cart-cap.bat`; it carries the units, the two confounds
and how to read the four outcomes.
**BOTH confounds must be clear and each fakes the pessimistic answer:** the bot's cart empty
(no hold in `carted`/`claiming`), **and the owner's PHONE cart empty** — the claim flow carts
on the owner's own RC session and there is one RC account, so a site left there occupies
exactly the seat a per-ACCOUNT cap is being tested for. `INCONCLUSIVE` is not an answer.
**Do not raise `RC_HOLD_CAPACITY` on reasoning alone.**

### 2. Do the cart POSTs fire on Android?
Proven on iOS twice (2026-08-13, one confirmed by eye on RC's own cart page). Android has
sign-in, session persistence and token capture measured — never `load` + `submit`. One
Android hand-off answers it and the readout says so by itself: it prints `[android build …]`
per hand-off, and `✓ Added to cart` is the answer. Queue one with
`scripts/rc-test-hold.mts --find`, then open the claim URL **in the app** (Admin → System
Health → "Open the claim screen") — from a browser `canInject` is false and the injected
precart never runs.

### 3. Housekeeping
- **`TWILIO_AUTH_TOKEN` should be removed from the agent environment.** It is full account
  access and also signs the delivery webhooks; it was added for a one-off link test that is
  long finished. An agent cannot remove it — it is environment config on the owner's side.
- **The A2P campaign edit is still blocked on Twilio** enabling API campaign edits
  (ticket #28871693). Replacement samples are generated and waiting in `docs/a2p-campaign.md`
  with three caveats. Do not draft another reply; the ball is in Twilio's court.

## Traps worth keeping

- **`rc-test-hold.mts` creates a `requested` hold, which blocks the update window** while it
  is live (the guard refuses within 6h of a release). Self-clearing once the time passes.
- **An `offered` hold does NOT block it.** This inverts the decision and has been misread
  twice — re-read it, do not remember it.
- **"Update now" takes ~20 minutes, not ~2**, and shows `SKIP - another process holds the
  update claim` in the meantime. That is TRANSIENT — a poller spawns the updater once per
  process life, so the retry that lands is the Windows task on its 5-minute tick.
  **`autocart.bot_version` answers "did it land?"**, not `appliedNote`.
- **`autocart.rc_session` reading dead/warn between releases is CORRECT, not a fault.** The
  token lives ~1h and `maybeAutoLogin` signs in at T−30, unattended and proven. Telling the
  owner to sign in by hand on that basis has cost a hold twice.
- **Pushing to `master` auto-deploys Vercel**, which swaps the claim bundle mid-test. Land
  changes between test runs, not during one.
