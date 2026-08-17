# Next session — the runner outage is diagnosed and fixed; the keep-warm wedge is not

*Rewritten 2026-08-17 (second pass), after the 08:00 miss was traced. This is a handover,
not a permanent doc. **Delete it once the box has been updated and one 08:00 has run clean.***

---

## The 2026-08-17 outage — ANSWERED, and it was none of the three candidates

The previous version of this file listed three candidate causes. **All three are ruled out.**

| candidate | why it is out |
| --- | --- |
| `supervise.ps1` gave up (5 exits in 10 min) | the log says `attempt 1`, and there is no `STOPPING` line |
| the watchdog counted it present | if it had run it would have logged; every branch writes a line before acting |
| the runner is alive but wedged | there was no runner process, and no supervisor for it either |

**What actually happened: the mini-PC's Windows Scheduled Tasks stopped firing at ~05:31 PT,
about five minutes before the hold runner hard-crashed. The watchdog never spoke because it
was never invoked.**

```
04:24:04 PT  watchdog: "NOTHING IS RUNNING - starting everything"   <- last watchdog line ever
04:24:10     supervisors log "starting:" for broker, keepwarm, runner
             ...watchdog never logs "recovered" or "START FAILED"
05:31:03     LAST EVER auto-update.log entry, after a flawless 5-min cadence
05:35:56     runner's last feed poll   (rc_runner_heartbeat.beat_at)
05:36:31     [supervise:rc-hold-runner] exited code=-1073740791 after 4,340s
05:36:39     "restarting in 5s (attempt 1 in the last 10 min)"      <- then nothing, ever
05:39-08:55  rc-keepwarm exits and restarts FOUR times, normally
```

`-1073740791` is `0xC0000409`, the Windows fast-fail `abort()` produces — the same code the
libuv `async.c:94` assertion yields, which appears after nearly every `update-guard` run in
`auto-update.log`. **That link is inference, not fact:** the runner's own log ends at 05:19
with no assertion text.

**Two independent tasks going silent together rules out a per-task hang or the `IgnoreNew`
multiple-instance policy.** Everything driven by a running PROCESS carried on perfectly,
which is exactly why the box looked healthy and was fully reachable throughout.

**WHY the scheduler stopped is NOT established.** `install-watchdog.bat` registers with no
`/RU`, i.e. "run only when user is logged on", so a session change is one candidate among
several. Do not write one in as fact. **A human at the box settles it:**

```
schtasks /Query /TN "CampHawk watchdog" /V /FO LIST
schtasks /Query /TN "CampHawk auto-update" /V /FO LIST
```
Look at `Scheduled Task State`, `Last Run Time`, `Last Result` and `Logon Mode`.

---

## What shipped (`b52755d`)

1. **`worker/runner-watch.ts` — rings the phone from Fly** when the runner is silent past
   `RUNNER_DEAD_MS` (15 min) *and* a hold releases within 45 min. Server-side, so it works
   whether or not the box ever updates. The message names the RUNNER and deliberately does
   **not** say `rc-login.bat`.
2. **Migration 060 + `autocart.watchdog`** — both Scheduled Tasks now report that they fired.
   Warn only, never paged.
3. **`bot.mjs` is a second trigger** for `watchdog.ps1`, which rate-limits itself.

A per-payload relaunch was built and **backed out** — see the note in
`worker/watchdog-recovery.test.mts` so it is not re-proposed as new.

---

## STILL OPEN, and it is the biggest risk to the next 08:00

**`rc-keepwarm` is wedging about once an hour, and a wedge holds the Chromium profile.**

```
15:42:58 renewing the session - the token has 10m left (src=live)
15:55:58 x WEDGED - the keep-warm loop has not advanced in 13m.
```

It enters the **near-expiry renewal cell** (`src=live`, ~10 min left) and never comes out;
`HUNG_MS` (12 min) fires, it releases the profile and exits 1, the supervisor restarts it,
the session recovers via `authorize` from a token-less profile, and ~50 minutes later the
token is back down to 10 minutes and it happens again. Four times on 08-17 alone (05:39,
06:53, 07:43, 08:55 PT).

**Why it matters:** a wedged keep-warm HOLDS the profile, and the hold runner's preemption is
cooperative — it drops `.camphawk-profile-wanted` and waits for the keep-warm's loop to
notice, which a wedged loop cannot do. **A wedge at 07:50 is an 08:00 cart that cannot
happen.** That is 2026-08-10 exactly, which cost a campsite.

**A bound has shipped** on the three unbounded `page.evaluate` calls in `rc-token.mjs`
(`readLiveToken`, `dropStoredToken`, `restoreStoredToken`). Playwright's `evaluate` has **no
timeout at all**, and `readLiveToken` is the first line of `renewSession`; every other await
on that path is bounded and they sum to ~4 minutes against an observed 13.

**That this is the hang is NOT proven** — nothing recorded which await it was, and a
Playwright call failing to honour its own timeout against an unresponsive browser is still
live. **Confirm it from the box after the update:** if the `renewing the session` line is
followed within ~20s by a result line instead of a wedge, it was this. If it still wedges,
the next suspect is the browser, not the code.

---

## Do NOT do these

- **Do not build or buy a CAPTCHA solver.** Nothing in this outage touched the login. The
  rehearsal passed 08-16 and the renewal re-mints unattended.
- **Do not reach for `restart-rc.ps1` while the session is healthy** — it closes the Chromium
  the token lives in.
- **Do not update the box while a hold is queued.**
- **Do not "simplify" `bot_task_heartbeat` into `bot_update_requests.applied_at`.** Checked
  2026-08-17: that column read 08-15 11:56Z while the task demonstrably ran every five
  minutes until 05:31 PT on 08-17. It is not a per-run signal.

---

## Owner's outstanding items

- **Update the box.** It is on `d09f225`; none of the bot-side work above is live until then,
  and it is also missing parallel carting (PR #98). Only `worker/runner-watch.ts` and the
  health check reach production on a push.
- **Delete `rc-blob.json`** from the box — a live RC login in the working tree. It is
  gitignored, so `git-status` cannot confirm it either way.
- **Change the ReserveCalifornia password** — a `TypeError` published it to `client_reports`
  on 08-16.
- **Re-enable / re-register the Scheduled Tasks** if the `schtasks /Query` above shows them
  disabled or not firing.

---

## Reading rules that will save a wrong call

- **`stale` ≠ `dead` on the session.** `dead` means the repair is *scheduled*; `stale` means
  the keep-warm is not reporting and the repair is *absent*.
- **`autocart.bot` green says nothing about RC.** Different process, green through every RC
  outage including this one.
- **`autocart.watchdog` "never reported" is not "stopped"** — it is the expected reading
  until the box updates.
- **`requested` with the release past is the one broken state**, and `last_attempt_note`
  tells you which of the two faults it is. It was NULL on 08-17: nothing tried at all.
