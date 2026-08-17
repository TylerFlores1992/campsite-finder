# Next session — make the RC hold runner survive without a human

*Rewritten 2026-08-17 after an 08:00 hold was missed. Everything before this was done or is
folded into CLAUDE.md; this file is a handover, not a permanent doc. **Delete it once the
runner stays up on its own.***

---

## The one thing that matters

**The hold runner stopped polling for 2½ hours and the watchdog — which fires every five
minutes for exactly this — never spoke.** An 08:00 test hold was never carted.

This is the whole obstacle to the product running unattended. It is **not** anti-bot, and the
temptation to treat it as one has to be resisted with evidence:

| claim | evidence against it |
| --- | --- |
| "RC is blocking us / we need a CAPTCHA solver" | The nightly login rehearsal **PASSED** 2026-08-16 (*"the bot can still sign itself in"*, Okta skipping the email step off the `DT` cookie) |
| "the session can't renew itself" | `✓ renewed by authorize: none → 3580s` on the box, 2026-08-16 01:53, from a genuinely token-less profile, no credential typed |
| "the session was the problem this morning" | `rc-login.bat` restored it in one attempt: FAIL *"no token at all"* → OK *"token exp in 47m; okta=ALIVE"* |

**The session works. The process supervision does not.**

---

## What was observed, exactly

```
07:46:31 PT  autocart.rc_runner   last poll 7822s ago (2h10m), no holds due    WARN
             autocart.rc_session  RC REJECTED - no token at all, signed out    FAIL
~08:05       mini-pc\rc-login.bat  →  session RESTORED
08:08:15 PT  autocart.rc_runner   last poll 9154s ago (2h32m), 1 hold due      FAIL
             autocart.rc_session  OK for 15m, token 47m, okta ALIVE            OK
             TEST · 4728          requested, last_attempt_note NULL,
                                  updated_at unchanged since the 06:38:54Z tap
```

**7822 → 9154 is 1332s across 22 minutes of wall clock**, so the runner did not poll once in
between — including after the sign-in. `last_attempt_note` being NULL is the readout's own
discriminator working: *"NOTHING has tried to act on this hold at all"*, not *"the runner
TRIED and the session was dead"*. Those are different faults and migration 046 exists to
keep them apart.

**The box was reachable the entire time.** `autocart.bot` was beating every 3 seconds, so
`bot.mjs` is alive and carrying the control channel. This is **not** the 2026-08-11 dark box
— `list-processes`, `tail-log`, `restart-rc` and `git-status` all work.

---

## Start here — four commands, in this order

Run these through Admin → System Health, or ask the owner to run them at the box. They are
ordered so each one narrows the next.

1. **`list-processes`** — is there a `rc-hold-runner.mjs` at all, and is its supervisor
   present? Read the command line closely: a healthy launch shows
   `supervise.ps1" -Name "rc-hold-runner" -Command "node rc-hold-runner.mjs"` **with the
   quotes**; a bare trailing `rc-hold-runner.mjs` with no closing quote is the 08-14
   REPL bug. That was fixed and the box is on `d09f225` which contains the fix, so seeing it
   would mean something new.

2. **`tail-log restarts`** — did `supervise.ps1` log anything? **Silence is the diagnosis
   here, not the absence of one**: the supervisor only speaks when a child EXITS, so a
   process that hangs without exiting produces a quiet log that is indistinguishable from a
   healthy night. If it shows `stopping after 5 exits in 10 min`, that is cause (1) below and
   the runner is dead **by design** until a human intervenes.

3. **`tail-log rc-hold-runner`** — its own last words. If it is mid-loop and simply not
   reaching the feed, that is a wedge rather than an exit.

4. **`git-status`** — the authoritative sha. `autocart.bot_version` reads `d09f225` on the
   box against `0eb8639` on the web, but that field is a **hint**: `COALESCE` preserves the
   last sha anyone reported, so a stale value can sit next to a live heartbeat and read as
   current. Only `git-status` answers "what is actually checked out?".

---

## Candidate causes — NONE established, do not write one in as fact

1. **`supervise.ps1` gave up.** It stops loudly after 5 exits in 10 minutes, because a
   process that dies and restarts instantly is a busy loop wearing a service's clothes. That
   is correct behaviour and it leaves the runner dead **for ever** with no further logging.
   If this is it, the fix is not to remove the rule — it is that *giving up must be visible
   to the server*, not only to a local log nobody reads.

2. **The watchdog counts it present while it is not polling.** This is the 2026-08-15
   elevation blindness: an unelevated WMI query reads `$null` for a process in another
   security context, so an **elevated generation counts as zero, not as unkillable** — and
   the union-count bug the watchdog already shipped once is the same shape. `Get-Missing`
   matching a string that appears in the *supervisor's own* command line is the other known
   way it goes blind.

3. **The runner is alive but wedged** — never reaching its poll. Symptom-identical to (1)
   from the server's side, which is precisely the problem.

---

## The fix has to be a SERVER-SIDE signal, not a better local watchdog

Every remote lever rides a poller on the box, and the watchdog is local — so when it is the
thing that is broken, nothing says so. That is structural and it has now bitten three times.

**`autocart.rc_runner` already knows.** It reads the runner heartbeat and it went FAIL at
08:08 with a hold due. What is missing is that **nothing acts on it**:

- It does not page (`pages: false` on the auto-cart family, added 2026-08-08 after the
  overnight "CampHawk DOWN" emails — that decision was right and should stand).
- `holdAtRisk` rings the phone for a dead **session**, not for a dead **runner**.

So the smallest honest change is probably: **ring for a stale runner heartbeat with a hold
due**, on the same gate as the session alarm. A hold that nothing is going to act on is at
least as fatal as a hold with a dead session, and today it was silent while the session
alarm — which was *also* correct — took all the attention.

Design it against the cry-wolf rules that are already written down: the runner is
legitimately quiet when nothing is queued, so the alarm must be *stale heartbeat AND a hold
ahead*, never staleness alone.

**A second, cheaper idea worth considering:** the watchdog reports its own liveness to the
server on every firing. Then "the watchdog has not spoken in 30 minutes" is itself readable,
and a silent watchdog stops being invisible. Same reasoning as `rc-keepwarm` posting its
verdict instead of a watcher inferring it: *the process that knows is the process that
reports*.

---

## Do NOT do these

- **Do not build or buy a CAPTCHA solver.** See the table at the top. Nothing in this
  outage touched the login.
- **Do not reach for `restart-rc.ps1` while the session is healthy.** It closes the Chromium
  the access token lives in. This morning that would have traded a 47-minute token for a
  dead session with minutes to spare.
- **Do not update the box while a hold is queued.** An update ends the RC session however it
  is triggered, and the guard's 6-hour release check is not liftable.
- **Do not repeat "`rc-login.bat` relaunches the RC pair" as fact.** CLAUDE.md says it does;
  the heartbeat says the runner did not come back after it ran this morning. **Whether it
  relaunches the runner is an open question** — settle it from `restarts.log`, not from the
  doc.

---

## Loose ends, lower priority

- **The box is behind:** `d09f225` vs `0eb8639`. Missing bot-side: **parallel carting**
  (`CART_CONCURRENCY = 4`, PR #98). Irrelevant to a single hold, so it is not urgent — but it
  is why `autocart.bot_version` is amber.
- **`rc-blob.json` may still be on the box** from the probe runs. It is a **live RC login** in
  the working tree. `del` it.
- **The ReserveCalifornia password still needs changing** — a `TypeError` published it to
  `client_reports` on 2026-08-16 (the row was scrubbed; the engine, not our code, quoted it).
- **Unit `4728` is an id I invented** and it was queued from a paste block of invented ids.
  Whether it is a real San Miguel unit was never established. Always re-derive with
  `scripts/rc-test-hold.mts --find --show 6`, which must run from a session with DB access —
  the mini-PC has no `@supabase/supabase-js`, so `--find` dies there with `MODULE_NOT_FOUND`.
- **The login rehearsal was skipped last night** (`no rehearsal has PASSED in 11h28m`). It
  passed on 08-16, so there is no green to have lost — but the skip reason is now recorded
  (the latching-slot bug was fixed 08-13), so it should be readable.

---

## Reading rules that will save a wrong call

- **`stale` ≠ `dead` on the session.** `dead` means the keep-warm is alive and honest and the
  repair is *scheduled*; `stale` means the keep-warm is not reporting and `maybeAutoLogin`
  lives inside it, so the repair is *absent*.
- **`autocart.bot` green says nothing about RC.** Different process. It stayed green through
  the 08-07, 08-11 and today's outages.
- **`offered` is not a fault** — nobody tapped it.
- **`requested` with the release past is the one broken state**, and `last_attempt_note`
  tells you which of the two faults it is.
- **A synthetic test hold produces no availability alert**, and that is correct — see the
  CLAUDE.md entry for why (the watch's dates, and the absence of a real RC lock).
