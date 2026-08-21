# Next session — a test hold fires at 08:00, and it is the first run of four new things

*Rewritten 2026-08-20 (evening PT). A handover, not a permanent doc. **Delete it once #146 is
merged and the 08-21 test has been read.***

---

## ⏰ FIRST: a REAL test hold releases 2026-08-21 08:00:18 PT

```
hold   9252cbaa-aa61-4b6a-afe2-a5a5a5ae34c9
site   TEST · 4733 — Carpinteria SB — San Miguel #M406
stay   arrive 2026-12-01 (Tue), 1 night
claim  https://camphawk.app/claim/9252cbaa-aa61-4b6a-afe2-a5a5a5ae34c9?t=EQO2oXcQ
```

**It is a REAL numeric unit id, so a cart takes that site off the market** until the claim
releases it or RC drops the cart (~15 min). San Miguel had 45 of ~60 sites bookable on that
date, so nothing is contended — but if the test is abandoned, delete it rather than leaving it:

```
npx tsx scripts/rc-test-hold.mts --delete 9252cbaa-aa61-4b6a-afe2-a5a5a5ae34c9
```

**Open the claim link IN THE APP.** From a browser `canInject` is false and the injected
precart never runs, which is most of what this exists to test.

**Bot updates are BLOCKED until the release passes** — `nextHoldRelease` counts `requested`,
so the 6h gate refuses. That is by design and is NOT the 08-20 morning bug. Nothing needs to
reach the box anyway: master and the mini-PC are both on `58cc767`.

### What this run is the FIRST exercise of

Four things merged on 08-20 that have never executed:

1. **The auto-login throwaway tab** — the one that matters. Fires at T−30 only when the
   session will not cover the release, which happens naturally overnight.
2. **The persisted login budget**, including the kill-refund if the RAM guard trips again.
3. **The platform column** (migration 064) — the hand-off should finally name iOS or Android
   instead of "platform not reported".
4. **The in-app Okta fill fix** (React's `_valueTracker`), if RC is signed out in the app.

### How to read it

- `scripts/rc-holds-readout.mts` — `T+s` is the cart lag; the **HAND-OFF** section is the
  client's own trace.
- **`✓ Added to cart` is the proof.** `token captured` as the last line is NOT a successful
  cart, and `RC declined (200) — cart is already added` on a re-injection is proof it STUCK.
- For the tab: **a memory spike that drains at tab close with NO `♻ recycling` line is it
  working.** A 9 GB reclaim is unmeasured — see below.
- Routines already cover it: **07:40 PT pre-flight**, **08:15 PT outcome**.

---

## Read this first

**Master and the box are both on `58cc767`.** Check, do not assume:

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status
```

`autocart.bot_version` agrees today, but it is a HINT — a COALESCE keeps the last reported
value, so it can show a stale sha beside a live heartbeat. `git-status` is the authority.

**`bot_update_requests.applied_sha` is trustworthy again as of #150**, and was not before: it
read `746cd5a` from 08-19 through two successful manual updates on 08-20 and misled a whole
session. See the `loadEnv` entry in CLAUDE.md before quoting that field.

---

## "Update now" works — proven, not argued

The two failures on the morning of 08-20 were **not slowness**. The updater was killed partway
through its own `stop-all`: on Windows `uv_spawn` puts a non-detached child in the parent's Job
Object, and the ancestry is `cmd.exe (npm start) → node.exe (bot.mjs) → powershell.exe
(auto-update.ps1)`. `stop-all` kills the first two.

It now goes through `schtasks /Run` against the task Windows already runs every five minutes, so
the updater is not our descendant and is in no job object of ours.

| when (PT) | what |
|---|---|
| 12:33 | `PROCEED` → `already current at b7015c7` — **proved the trigger fires, and nothing about the stop** |
| 19:42:49 → 19:46:27 | `b7015c7` → `58cc767`, **`updated and verified`, 3m38s, through the full `stop-all`** |

**Quote the 19:46 run as the evidence.** The 12:33 one never reached the step that used to kill
it, and reading it as a pass would be crediting a repair to a run that did not perform it.

---

## The one open PR

**#146 — `worker-deploy.yml`'s trigger paths, derived from the worker's real import closure.**
Green, rebased, unmerged.

`worker/poller.ts` imports `src/lib/limits.ts` and `src/lib/auth.ts`; neither triggered a worker
deploy, so a change to either shipped to Vercel and not to Fly. It had never bitten only because
every prior change to those files happened to land a `worker/*.test.mts` beside it — a habit, not
a mechanism.

**Merging it restarts both poller machines**, deliberately: the workflow is in its own path list
so a change to it is exercised by the next run. Land it away from an 08:00 release.

---

## Built, merged, and NEVER EXECUTED — the auto-login tab

`maybeAutoLogin`'s Okta trip now runs in a throwaway tab, because on 08-20 at 07:30 it cost
**9,434 MB over twelve minutes** on the resident page and the RAM guard killed it. That is four
times the worst renewal, because `okta=GONE` forces a full password sign-in.

It only runs at **T−30 of a real release with a session that will not cover it**, so it has not
run once.

**What is NOT claimed: that a tab close reclaims a nine-gigabyte trip.** The renewal's trips are
140–350 MB and drain in place on an unchanged pid. Nothing has closed a tab that ramped this far,
and the 08-20 event put 1,330 MB in a **`utility`** process, which is not the renderer.

**How to read it:** a spike that drains at tab close **with no `♻ recycling` line** is this
working. rc-family growth across logins would mean the browser-process share does not drain, and
the RAM arm still contains that case.

---

## Why the 08:00 cart worked, and the trap inside it

```
07:30  attempt 1 → 9.4 GB ramp → RAM guard killed the browser
07:43  supervisor restarted the process
07:48  attempt 2 → signed in, 60m token
08:00  carted at T+2s → claimed 08:05 → released
```

**The accidental refund is what bought attempt 2.** The budget was in process memory, so the
restart re-issued it. Persisting a plain counter would have made that morning strictly worse.

So a **killed** attempt is now refunded deliberately — by the record, bounded to one per release.
If you find yourself "tidying up" that refund, this is the morning it exists for.

---

## Two open questions, both unchanged from 08-19

**1. Where does the three-day-old token come from?** Eliminated: `localStorage`,
`sessionStorage`, IndexedDB. The corpse has not recurred, and the census gate is
`!renewed && after != null && after < 0`, so a token-less failure does not fire it. Waiting on a
recurrence to print either `TOKEN-SHAPED COOKIE(S)` or `NONE token-shaped … coming from the
server`.

**2. Does `prompt=login` force Okta's form?** Still unproven. `rc_login_rehearsal` has not passed
since 2026-08-16 — every night since has been a skip. Trigger with Admin → **"Prove the
unattended RC sign-in works, now"**, or `bot-ask.mts test-login`. One per 6h, never within 6h of
a release.

`autocart.rc_login` warns about this continuously. It is the oldest open item and nothing on
08-20 touched it.

---

## What is NOT broken, so nobody re-investigates it

- **The 08:00 hand-off works end to end**, including on iOS: `✓ Added to cart`, T+2s.
- **The renewal works** and is cheap: `✓ renewed by authorize`, under a minute, unattended.
- **The login works** — 07:48 on 08-20, unattended, after a guard kill.
- **`autocart.rc_login` warning** is that no *rehearsal* has passed, not that the login is broken.
- **A health reading taken 0 seconds after a restart is not evidence.**

---

## Standing traps worth re-reading before touching anything

- **`npm test` hits the production DB.** `expire-holds`, `rc-hold-capacity` and `claim` flake
  against *production's own* sweeps on a timer, not only against a second test run. The rule for
  calling it a flake is all three of: the diff cannot reach that code, the suite passes alone,
  and the mechanism is named. On 08-20 `expire-holds` failed in CI, passed alone, and the diff
  was `load-env.mjs` — so a re-run was legitimate.
- **Never invent an RC unit id** — `scripts/rc-test-hold.mts --find` is the only way.
- **`.ps1` files must be pure ASCII**, and the emitted JS bundles must be free of control
  characters — a NUL reached `rc-login-script.ts` on 08-20 and passed `tsc` and every test.
- **Guards anchored on a token that occurs twice break silently.** It happened three more times
  on 08-20: a 900-char window that reached into the neighbouring arm, `indexOf('const tab = await
  ctx.newPage()')` matching the auto-login's tab instead of the renewal's, and `indexOf('spawn(')`
  matching inside a comment quoting the old shape. Anchor on something unique, bound by the next
  real thing rather than a character count, and assert the anchor was found.
- **A mutation that does not apply is a green proving nothing.** Assert the mutation landed.
