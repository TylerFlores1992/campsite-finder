# Next session — the tab cure is PROVEN, and `attemptLogin` is the half still leaking

*Rewritten 2026-08-19 (late evening PT). A handover, not a permanent doc. **Delete it once
tasks 1–3 below are done and the two open questions are answered.***

---

## Read this first

**Master is `b9a1dba` plus whatever landed from `claude/camphawk-sms-test-update-s3cash`.**
The box was on `b9a1dba` at ~20:00 PT. Check, do not assume:

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status
```

`autocart.bot_version` is a HINT and can show a stale sha beside a live heartbeat (COALESCE
keeps the last reported value). `git-status` is the authority.

---

## The leak: the cure works, and we now know exactly what is left

**The throwaway tab (#142) executed for the first time on 2026-08-20 and it works.** Three
Okta round trips through it, all `✓ renewed by authorize`:

| when (UTC) | path | cost |
|---|---|---|
| 02:10 | tab | rc **206 → 346 → 288 MB**, pid 17688 **unchanged** |
| 02:34 | **resident page** (`attemptLogin`) | rc **281 → 5,097 MB**, free RAM 4,928 → 1,741, **guard killed it** |
| 02:37 | tab | free RAM **−8 MB** |

That middle row is not a regression — #142 deliberately left `attemptLogin` on the resident
page. It is a **paired A/B on the same box within 25 minutes**: the same allocation,
contained through a tab and uncontained through the resident page. It settles the mechanism
(it is the Okta navigation) and it settles the remedy (*where* you run it decides the cost).

**The 02:10 row is the strongest single reading.** Memory drained **in place, on an unchanged
pid** — CLAUDE.md records that across twenty ramps this had *never once* been observed; every
prior recovery was a new pid.

**A new fact for CLAUDE.md: `utility` went 24 → 1,330 MB** in the 02:34 ramp. Every previously
recorded ramp had utility flat, so the documented "renderer + browser process" attribution is
**incomplete**.

**And the failure is now self-healing.** After the guard kill at 02:36:32, the box was back to
a full hour of token at 02:37:45 — **73 seconds, unattended**, via the tab renewal. That is
why task 1 was *not* shipped the night before a release.

---

## A NAMED 08:00 RISK — the reason tasks 1 and 2 exist

`profile-lock.mjs` has `STALE_MS = 10 min`, and **only a living holder renews the lock**. So a
guard-killed keep-warm leaves a lock reading as HELD for up to ten minutes, and cooperative
preemption cannot help — no process is left to read `.camphawk-profile-wanted`. That is the
~6 minutes of `profile busy (rc-keepwarm)` observed twice on 08-20 (02:20, 03:18).

Chained with the two defects below:

```
07:30  maybeAutoLogin fires (likely — needs ~50m of token; it cycles 0→60)
07:33  ~3 GB ramp on the resident page → RAM guard kills the keep-warm
07:33  the ration is IN-MEMORY (rc-keepwarm.mjs:723) so the restart REFUNDS it
07:41  attempt 2 (AUTOLOGIN_RETRY_GAP_MS = 8 min) → ramp → kill ~07:53
07:53  the dead keep-warm's lock reads as held until ~08:03
08:00  the hold runner cannot take the profile
```

**A kill at ~07:33 clears by ~07:43 and is harmless. A kill after ~07:50 is not.**

---

## The three tasks, in order

1. **Move `attemptLogin`'s Okta trip into a throwaway tab**, exactly as #142 did for
   `renewSession`. `page.route` (via `withForcedLoginPrompt`), `diagnose()` and
   `saveFailureShot` must **all** rebind to the tab — a guard anchored on the resident `page`
   would pass while the tab leaked. Mutation-test each. This is the release-critical path, so
   land it with a morning free to observe it.
2. **Persist the auto-login ration to a file**, matching `rehearsal.mjs`. It is in-memory at
   `rc-keepwarm.mjs:723` (`let autoLogin = { release: null, spent: 0, lastAt: 0 }`), so
   `supervise.ps1` restarting the process refunds it — the crash-loop-spends-the-login-budget
   shape that cost the household IP 12 hours on 08-06, and newly reachable now that the login
   path reliably trips the guard.
3. **Update CLAUDE.md** with everything on this page, plus the two answered items below.

---

## Answered since the last handover

- **Unit ids 4728–4733, recorded on 08-17 as INVENTED, are REAL San Miguel campsites.**
  `rc-test-hold.mts --find` lists 4728 = `#M401`, 4729 = `#M402`, 4730 = `#M403`,
  4732 = `#M405`. CLAUDE.md says *"Whether it is a real San Miguel unit was never
  established."* It is now — and that near-miss was worse than recorded. (Unit **4734**, the
  08-20 test hold, is real and in the same block.)
- **The SwitchBot Plug Mini is set up and PROVEN END TO END.** Power cut → box booted unaided
  → auto-logon → bots started → RC session came back **live**. ~5 minutes dark, ~6½ minutes to
  a warm session, zero human involvement; the memory series recorded the outage as a
  5-minute gap, written server-side by nothing on the box. **This retires the structural gap
  open since 08-17** — *"no software installed on a machine can fix 'the machine is running
  nothing'"*.
  - **The session survived only because the last token was minted by OUR renewal**, which goes
    through the code exchange into `localStorage`. A token the SPA silently re-mints lives in
    page memory and would have been lost. Record it that way, **not** as "power cycles are
    session-safe".
  - `plugStatus()` + `GET /api/admin/power-cycle/status` were added because
    `powerPlugConfigured()` is only a presence check on three env vars, and the production
    credentials had never been exercised. It shares ONE signing helper with the cut, which is
    the only reason a green status says anything about whether the cut can authenticate.
  - **Auto-logon is load-bearing and easy to lose.** Both scheduled tasks are `Logon Mode:
    Interactive only`, so without it a power cycle boots to a lock screen and nothing starts.

---

## Two open questions, both still one reading away

**1. Where does the three-day-old token come from?** Eliminated: `localStorage`,
`sessionStorage`, IndexedDB. **The corpse has not recurred** since the 08-19 hand sign-in — the
08-20 failures were `none → none`, and the census gate is `!renewed && after != null && after
< 0`, so a token-less failure does not fire it. Still waiting on a recurrence to print either
`TOKEN-SHAPED COOKIE(S)` or `NONE token-shaped … coming from the server`.

**2. Does `prompt=login` force Okta's form?** Still unproven. The on-demand rehearsal that
would have answered it on 08-20 **was the browser the RAM guard killed** — it never reached a
verdict and printed no rewrite count. `rc_login_rehearsal` still reads `"rehearsal started"`.
The 6h on-demand ration was spent at ~02:33 UTC on 08-20.

Trigger it with Admin → **"Prove the unattended RC sign-in works, now"**, or
`bot-ask.mts test-login`. One per 6h, never within 6h of a release. **Expect it to ramp ~3 GB
and possibly be killed again until task 1 lands** — that is now the known behaviour, not a
surprise.

---

## What is NOT broken, so nobody re-investigates it

- **The renewal works**, and it is cheap now: `✓ renewed by authorize: none → 3580s`, three
  times on 08-20, unattended, under a minute, for −367 MB / −8 MB / +82 MB net.
- **The login works.** A hand sign-in took 17 seconds with no CAPTCHA — Okta still remembers
  the device via `DT`.
- **`autocart.rc_runner` saying "1 hold(s) due"** during a merge is an `npm test` fixture.
- **A health reading taken 0 seconds after a restart is not evidence.**

---

## Standing traps worth re-reading before touching anything

- **`npm test` hits the production DB.** `rc-hold-capacity` and `claim` flake against
  *production's own* `expire-holds` sweep, not only against a second test run.
- **Never invent an RC unit id** — `scripts/rc-test-hold.mts --find` is the only way. And see
  above: the last set that was invented turned out to be real sites.
- **`.ps1` files must be pure ASCII.**
- **Guards anchored on a token that occurs twice break silently.** It happened again writing
  this session's tests: `code.indexOf('export async function powerCycle')` matches
  **`powerCycleRefusal`**, four hundred lines earlier, so the slice ran backwards and every
  assertion passed against an empty string. Only an explicit `to > from` bounds assertion
  caught it. Anchor on something unique, and assert the anchor was found.
