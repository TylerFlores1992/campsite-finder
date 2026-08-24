# Next session — start here

*Rewritten 2026-08-24, evening.*

> ## UPDATED 2026-08-24, EVENING — the two urgent items are DONE.
>
> **THE SMS STORM IS FIXED AND ON FLY** (`d842dc0`, #183). Migration 067 was already applied;
> the poller fix is deployed, the worker deploy reported success with a fresh heartbeat, and
> **nothing re-announced** — all six watches carrying a claim still read their backfilled
> `<hour>|*` wildcard. §1 is history, kept for its reasoning.
>
> **#183 IS MERGED** — it carried the `closeOnToken` liveness fix as well.
>
> **THE WARM-UP IS SAMPLED** (`18bb337`, #184) and **the box is on it**. Track A's third door
> is closed; it still has zero readings of a real ramp, because the event has not happened
> since. **It may not happen tomorrow either — see §1b.**
>
> **Track B remains NOT started**, by the owner's explicit decision on 2026-08-24: wait for one
> attributed reading first.
>
> Health at handover: **19 of 19 ok**. Master `18bb337`, box `18bb337`.

*Delete this file once Track A has a reading from a real ramp AND the App Store version has a
decision. It is a handover, not a permanent doc, and a stale one reads like current state.*

---

## 0. BEFORE ANYTHING: can you actually reach production?

**YES, as of 2026-08-24 evening** — camphawk.app 200, fly.io 200, Supabase reachable, and both
readouts plus several direct DB queries ran. `recentRelayFailures` names only `mcp.vercel.com`,
`mcp.sentry.dev` and `flyctl-metrics.fly.dev`.

**IT HAS BEEN REVOKED MID-SESSION BEFORE, so check anyway rather than assuming.** On 08-23
20:15 PT and still at 08-24 08:15 PT the proxy answered **403 to CONNECT** for `camphawk.app`,
`*.supabase.co` and `fly.io` — an org egress-policy denial that outlived a session restart.

**ONE THING THE READOUTS CANNOT REACH EITHER WAY: `notifications`.** RLS answers `policy context
unavailable` from an agent session. It fails loudly, so it is a clean non-answer — but do not
plan a verification around reading that table. The claim-key column on `watches` is what is
actually reachable, and it is the better evidence anyway.

**`api.github.com` is NOT blocked, and the earlier claim that it was is wrong** (measured
08-24). The CONNECT tunnel opens and the placeholder `GITHUB_TOKEN` *authenticates* — but access
is **REPO-SCOPED**, and that distinction is the trap:

```
GET /user                                    200   <- returns the real account
GET /rate_limit                              200
GET /repos/<owner>/<repo>                    403   "GitHub access is not enabled for this session"
GET /repos/<owner>/<repo>/commits/<sha>/check-runs   403   <- the CI-watchdog case
```

So **the natural smoke test succeeds and proves nothing.** `${#GITHUB_TOKEN}` is 14 and `/user`
returning your own login is a **false positive**, which is worse than the presence check already
documented in `CLAUDE.md` because it is a positive result rather than a mere absence. **Anything
repo-scoped still goes through the MCP tools** — that conclusion is unchanged; only the reason
for it is.

```bash
curl -sS "$HTTPS_PROXY/__agentproxy/status"        # recentRelayFailures names the blocked host
curl -sS -m 12 -o /dev/null -w '%{http_code}\n' https://camphawk.app/
```

- **Do not retry it and do not route around it.** Report the blocked host.
- **Verified reassurance:** the readout scripts **fail loudly** on an unreachable DB
  (`DB query error: TypeError: fetch failed`, exit 1). So an empty answer is a real answer and
  never a network failure in disguise. That was tested, not assumed.
- **If egress is still blocked, the check cannot happen.** Say so plainly, name the three hosts,
  and stop — do not substitute a guess for the reading. **This is what happened on 08-24**, and
  the loud failure is what made it a clean non-answer: `DB query error: TypeError: fetch failed`,
  exit 1. **Widen the readout's 14-day window if enough time has passed** — the row outliving the
  query that fetches it is the one way this reading still gets lost.

### WHERE THE READOUT RUNS — asked 2026-08-24, and it is not obvious

**Right here, in a session like this one.** Checked: `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are **already present as process env vars in this sandbox**, so
nothing needs installing or configuring. **Only the network is blocked.** The moment egress is
allowed, the command in §1b just works.

- **NOT the mini-PC.** Nothing under `scripts/auto-cart-bot/` touches Supabase — the bot only
  ever talks to `camphawk.app` with `AUTOCART_TOKEN` — so the box almost certainly holds no
  service-role key. And `VAR=1 npx …` is **bash syntax that silently does nothing in cmd**;
  Windows needs `set "VAR=value"` on its own line first.
- **`NODE_USE_ENV_PROXY=1` is a SANDBOX-ONLY prefix.** It points Node's fetch at the agent
  proxy. On an ordinary machine it is unnecessary — just `npx tsx scripts/…`.
- **There is NO admin UI for the attribution.** `native_alloc_readings` (066) has only its
  library and migration. `chromium_memory_samples` has a panel; the reading that says *what
  allocated* does not — so this script is the only way to see it. Worth closing eventually,
  since it means the leak's key instrument cannot be checked from a phone.

---

## 1. THE COMING-SOON DEDUP IS BROKEN IN PRODUCTION — the one live user cost

**26 texts and 26 emails in 62 minutes to one user**, alternating two divisions of Morro Bay,
**every one for the same physical campsite** (unit 43191, same release hour, same dates).

Migration 070 made `claimHoldNotification` write a **campground-namespaced** value into
`rc_hold_notified_for` so two divisions would not silence each other. **That column holds ONE
value**, so N divisions overwrite each other in turn and the dedup is **defeated outright** —
unbounded, not off-by-one. The fix for one missed alert traded it for a storm.

- **Migration 067 IS APPLIED to prod** (six rows backfilled, read back and verified). The column
  is additive and unread until the poller ships — migration first, then the code, as documented.
- **THE POLLER FIX IS NOT DEPLOYED.** It reaches Fly only on a merge to master. Until then **the
  storm can recur on any multi-division watch with a held unit.** Watch `eb886697` is primed.
- **Four real user offers were outstanding for 08-25 08:00 PT**, across three users. Untapped
  offers do not block the update window; **a tap makes it a real morning with a stranger
  waiting.**
- The fix is a **set** (`watches.rc_hold_notified_keys`), keyed `<releaseHour>|<unitId>`. Both
  cheaper fixes are wrong: hour-only reinstates 070's bug, unit-only ping-pongs again the moment
  two units share an hour. `worker/hold-claim.ts` + real-DB test, six mutations.

~~**This is the first thing to check on the next session: is that poller fix on master and on
Fly?**~~ **ANSWERED 2026-08-24 evening: it is on both.** Merged as `d842dc0`, the worker deploy
reported success, and `worker.heartbeat` read `last beat 11s ago, 13 watches` straight after —
that workflow fails unless a fresh heartbeat lands, which is what makes the success meaningful.
**Verified separately that nothing re-announced**, which is the risk the wildcard backfill exists
to cover: all six watches carrying a claim still read `<hour>|*` afterwards, with no per-unit key
appended. `eb886697`, the watch primed with `rc-583|2026-8-25T8`, is among them.

---

## 1a. THE 08-24 TEST RAN. THE HOLD WAS LOST TO A BUG IN OUR SIGN-IN — FIXED, NOT RE-TESTED

The 08-24 hand-off failed, and the owner's own account is what diagnosed it:

> *"I put login info in. Checked. Hit button. It opened RC for less than a second as if auto
> login worked. Hit grab it. Then went to RC not logged in."*

**ONE defect fixed in #183** — web-side, so it reaches already-installed apps on the merge,
**no rebuild, no App Store review.**

**`closeOnToken` tested `captured` alone.** A STALE token — the ordinary state, since it comes
from the SERVER and no local clear reaches it — was broadcast by `rc-inject.js` on RC's first
API call and closed the sign-in window in under a second. **The credentials were never typed:**
Okta's flow is several page loads and cannot finish that fast. The claim gate had learned this
on 08-21 (#152), AFTER `closeOnToken` shipped in #126, and nothing carried it next door because
**nothing tested `closeOnToken` at all.**

`src/lib/rc-token-liveness.ts` now classifies a token report three ways and `closeOnToken`
closes on `live` only. `rc-token-liveness.test.mts` is the guard that never existed.

### A SECOND FINDING, DELIBERATELY NOT FIXED — and my first fix for it was WRONG

A rebroadcast carries `{ captured, length }` and no `expiresInSec`, so it classifies as
`unknown`. The claim gate verifies on `unknown` as well as `live` — therefore **a replay
arriving after a correct `expired` verdict re-enters that branch and clears the warning.** The
message telling a user their session is dead lives about one API call. That is real, and it is
plausibly why the owner never saw it on 08-24.

**I first "fixed" this by making `unknown` stop verifying, and `claim-release-truth.test.mts`
caught it.** That guard exists for a reason I had not weighed: **a bundle older than migration
058 sends no `expiresInSec` at all**, so every report from it is `unknown` and refusing those
takes the fast path from every such client at once. The rule is *"we could not tell, so we do
not NEWLY refuse."* The gate is behaving as designed and is left byte-identical to master.

**The honest remedy is to make `expired` STICKY for the run** — a replay then cannot undo a
verdict the first sighting earned, and older bundles keep verifying. That is a deliberate
change to a release-critical gate with its own guards, not a drive-by, and it is the next
session's call.

### THE RE-TEST — NOT YET RUN, and it needs both a DB and a human

Blocked on egress (§0). When it returns:

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --find --show 6   # never invent an id
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --unit <id> --arrival <date> --watch <id>
```

**What should now happen, stated so it can be falsified:** the sign-in window **stays open**
on the stale token instead of closing in under a second, `afterLoad` injects the credentials
per page (bounded by `MAX_LOGIN_PAGES = 6`), and the window closes only once a **live** token
arrives.

**The proof is in `client_reports`:** look for the login stages — `signin-open`, `email`,
`password`, `submitted` — which were **entirely absent** on 08-24 because the window closed
before any of them could run. Their presence is the fix working; their absence means it is not.
Expect the "your sign-in has expired" warning to appear and then be cleared by a replay — that
is the second finding above, still unfixed, and NOT a failure of this fix. Then `✓ Added to cart` and
`cart read back`.

**The claim link must be opened IN THE APP.** From a browser `canInject` is false and none of
this is exercised. No session can do this — ask the owner.

---

## 1b. THE MANUFACTURED RAMP — IT ARRIVED, AND TRACK A RECORDED NOTHING

**Egress came back ~12:55 PT on 08-24 and both readouts ran.** The ramp happened exactly as
ordered: **9,338 MB, 05:00:51→05:11 PT, 89% COMMIT, renderer 90% of it** — matching the 08-20
password-sign-in figure almost exactly, and two minutes after the T−3h warm-up window opened.
**The prediction was right on both halves.**

**And `native_alloc_readings` has ZERO rows for it.** `maybeWarmupLogin` is the **third**
Okta-navigating path and the only one with no sampler on it — and by construction it is the
EXPENSIVE one, because it fires only when Okta is GONE, i.e. the full password variant.
`startNativeSampling` had two call sites: `maybeAutoLogin` and the renewal's throwaway tab.

~~**Wiring it onto the warm-up is the obvious next move and is NOT done.**~~ **DONE 2026-08-24
evening — #184, `18bb337`, and the box is on it.** Three things, because sampling alone would
have been inert: the sampler on the tab's own CDP session with a BEFORE profile, `attemptLogin`
wrapped in `withNetworkTrace` (`reportNativeAlloc` refuses a reading whose RAM delta is missing,
and the delta comes from the trace), and the report in the `finally` before the tab closes.
Context `'warmup'`, which the server already allow-lists — anything else stores NULL and lands
the reading unattributed.

**THE GUARD IS GENERAL: `worker/warmup-sampler.test.mts` fails on a FIFTH unsampled path**, so
this cannot recur one door along. `runLoginRehearsal` is a recorded EXCEPTION rather than a gap —
it navigates to Okta but runs on the resident page, so there is no close to reclaim what it
allocates; wiring it is a separate decision.

### WHAT IS MISSING NOW IS THE EVENT, NOT THE INSTRUMENT — AND TOMORROW MAY NOT SUPPLY IT

`maybeWarmupLogin` reads `nextHoldRelease()`, whose status filter is
`('requested','carted','claiming')` — **never `offered`**. All four real offers for 08-25 08:00 PT
were untapped at handover, so **if nobody taps, the warm-up stands down and there is no expensive
trip to sample at all.** The renewal path has been sampled for weeks and has produced no reading,
which is consistent with ramps having become much rarer.

**A tap is the precondition for the measurement, and no session can produce one.** Do not read an
empty `native-alloc-readout.mts` the next morning as a broken instrument — check whether a hold
was ever tapped first.

That is the fifth instance of the house shape — an instrument bolted to two of three doors — and
the first where it cost an experiment somebody deliberately set up.

**The one reading that DID land is the cheap T−30 sign-in** (−422 MB, 103 MB renderer). It shows
no `net::` and no system-dll frames, so the buffering candidate gets **no support** — but **do
NOT correct the three buffering entries on it**: it cleared the 400 MB bar by 22 MB, it is 4.5%
of the event under investigation, it is a different code path, and its shape disagrees (renderer
24% here against 90% on real ramps).

**The warm-up design is vindicated and the morning was clean** — the 9 GB trip landed at T−3h,
the T−30 sign-in cost ~106 MB with COMMIT flat at 16%, and the cart fired at **T+2s**.

**#171 IS PROVEN ON A REAL HOLD.** `TEST · 43129` carted T+2s, claimed, released, and reported
**`cart read back: 1 entry`** on iOS build 1.0 (21) — RC's own answer, the verification nobody
could force. **Still not exercised on Android.**

### The commands and the reading rules (unchanged, for the next ramp)

### The commands and the reading rules

A **real test hold** was queued to *manufacture* a memory ramp so Track A's native-allocation
sampler finally gets a reading. It is an instrument, not a product test.

```
hold      3020e05a-8e3f-444b-8973-1426f3211760
site      Morro Bay SP — Lower Section, unit 43129 (#33), arrival 2026-12-01
releases  2026-08-24 07:58:47 PT
claim     https://camphawk.app/claim/3020e05a-8e3f-444b-8973-1426f3211760?t=WNWD1BgU
delete    npx tsx scripts/rc-test-hold.mts --delete 3020e05a-8e3f-444b-8973-1426f3211760
```

**Run these two, in this order:**

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/native-alloc-readout.mts   # the attribution — the point
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts       # the hand-off + cart outcome
```

There is also `/rc-status`, which runs the health endpoint and the hold readout and applies the
reading rules. Use it if you want the health picture too.

### The timeline it was built around

| PT | what |
|---|---|
| ~04:58:47 | **T−3h warm-up window opens** — fires only if Okta is GONE, then does the full password sign-in: the **12-minute, ~9,434 MB** trip, the biggest Okta navigation this system makes. **This is the experiment.** |
| ~07:14 | `holdAtRisk` may ring the owner's phone if the session is dead. Not a fault. |
| 07:28:47 | T−30 `maybeAutoLogin` |
| 07:58:47 | release; the cart should fire within a few seconds |

### Reading the result — the rules matter more than the numbers

- **`net::` frames** → the network/IPC buffering candidate is **confirmed**, after three
  `CLAUDE.md` entries asserted it with no evidence.
- **Anything else** → those three entries need correcting. Say so.
- **The line covers the RENDERER ONLY.** `Memory.startSampling` is absent on the browser target
  (verified). The browser process's share is not in the figure, and the rendered line says so.
- **A flat JS heap eliminates ordinary JS retention and NOTHING ELSE.** 640 MB of `Uint8Array`
  reports `JSHeapUsedSize` = 0.0. Do not repeat the older, wider inference.
- **"No readings yet" is a REAL ANSWER** — it means the trip did not ramp. The three-way verdict
  deliberately refuses to speak without a RAM delta. It is not a broken sampler.
- **A ~9 GB ramp that morning is the ORDERED OUTCOME, not an incident.** Do not open
  `chromium_memory_samples`, read `peak_rc 9,180 / COMMIT 88%`, and write it up as the leak
  recurring or the containment failing. Somebody asked for this ramp. (And per §24b the RAM arm
  would not have fired on it anyway.)

### The prediction, stated so it can be falsified

The expensive trip should land at **~04:59 PT** (warm-up, Okta gone), making the 07:28:47
sign-in the **cheap cookie-answered** kind. **Check where it actually landed rather than
assuming** — the 08-22 handover predicted a quiet morning on exactly this reasoning and was
falsified by a 9,180 MB ramp at T−30.

**The precondition is DUE, not OBSERVED.** `okta_expires_at` was frozen at
`2026-08-24T03:00:59Z` across four reads by two sessions — the **absolute cap**, not the rolling
window our probe refreshes — so it was due to lapse ~20:01 PT on 08-23. **Nobody watched it
expire.** If the warm-up did not fire, an Okta session outliving its stated cap is the first
thing to check, and that would itself be a finding.

### The second thing this morning can prove — and it needs a human

#171 shipped the hand-off landing **in** the cart and **reading the cart back** there. Neither
has run against a real hold. `rc-holds-readout.mts` prints **`cart read back`** when it happens.

**It only fires if the claim link is opened IN THE APP.** From a browser `canInject` is false and
the injected precart never runs, so it tests nothing. **No session can do this — ask the owner,
do not investigate its absence.**

---

## 2. Serial rules — still binding whenever a hold is queued

The SERIAL rules in `docs/LANES.md` bind while the hold is live:

- **No `npm test`** (production DB, and it races production's own sweeps).
- **No second test hold.**
- **Nothing that restarts the box** — "Update now", `update.bat`, `restart-rc`, `kill-chrome`.
- The updater's **6h release gate shut at 01:58:47 PT**. A *requested* update lifts the quiet
  window but **never** that gate. A refusal there is correct, not the 08-12 deadlock.

---

## 3. State

| | |
|---|---|
| Master | **`18bb337`** |
| Branch | merged; `claude/main-lane-docs-0824` carries this handover update |
| Mini-PC | **`18bb337`** — updated 21:57 PT, "updated and verified", 24s. Box and web match. |
| Open PRs | **#180 (side lane, notes)** only. #183 and #184 are merged. |
| Open issues | **#76**, **#14** (#174/#175 folded and closed 2026-08-23) |
| Open holds | the 08-24 instrument has released; `expire-holds.ts` sweeps from Fly every 60s |
| Migrations | highest applied **067** (the SMS-storm fix, applied to prod 08-24); next main-lane number is **068** (`070` is an old side-lane block claim). LANES.md's "next is 060" is stale. |

**THAT LAST LINE WAS STALE BEFORE IT WAS READ, and it is worth keeping as the correction.** It
said #183 was web-side and would not restart the pollers. The SMS-storm fix was added to the same
branch AFTER it was written, so the merge touched `worker/**` and `src/lib/db/**`, fired
`worker-deploy.yml`, and restarted both machines — which is precisely how the fix reached Fly.
**A note about a branch ages the moment the branch does; re-read the diff, not the note.**

Master and the box differing is the ordinary drift `CLAUDE.md` documents — the merges since were
docs-only, so there is nothing waiting to reach the mini-PC.

**`autocart.bot_version` is a hint, not an answer.** `bot_commit` is COALESCEd and can sit stale
beside a live heartbeat. `git-status` through `bot_commands` is what answers "did it land?".

---

## 4. The leak — the standing ask, still unmet

**Everything shipped is containment or relocation.** The size guard, the RAM arm, the heap trail,
the post-Okta recycle, the orphan sweep, the throwaway tab, the warm-up. The box stays healthy.
**The allocation still happens.** Do not read green instruments as a cure; the owner asked
directly on 08-21 and was right to.

**Established:** the ramp is triggered by the **Okta navigation** — a controlled comparison, not
a correlation. It lands in the **renderer** (~90%) and the **browser process**.

**Never observed: what allocates.**

**The 08-23 shape:** an **eleven-minute climb on ONE renderer pid at ~400 MB/min**, not the short
burst recorded on 08-17.

### What changed on 2026-08-23 and weakens the case for waiting

**Neither 9 GB ramp tripped the RAM arm.** The arm needs a stall **AND** free RAM under 2,000 MB;
troughs were **3,191 and 3,328 MB**. A **browser replacement** ended both — the `gpu-process` pid
changes across each. The box reached **88% COMMIT**, two points off where Windows stops
scheduling.

- **The floor is a QUESTION, not a patch.** It is behaving exactly as designed: 08-19 predicted
  *"a trough near 3,300 MB"* and set the floor *below* it so a working renewal could not be
  killed. What moved is the peak (5,688 → 9,180 MB). **Lowering the trip point is the change that
  killed a working repair on 08-19.** The honest options — leave it and rely on the recycle, or
  give the arm a second non-free-RAM trigger — differ in kind and are not a drive-by.
- **What would settle what ended them:** a `♻ recycling` line in `logs\rc-keepwarm.log` at
  14:41:5x, via `tail-log`. The post-Okta recycle is the leading candidate for the 08-23 ramp;
  the 08-22 one coincides with a box update, so a `stop-all` is likelier there. **Both are
  candidates.**

### Track B — designed, NOT started, needs the owner's go-ahead

Take the renderer out of the OAuth round trip: intercept `/authorize`, replay over `ctx.request`
following redirects, exchange the code ourselves. Three pieces already exist. For the
cookie-answered case it is a plain redirect chain, and **all twenty recorded ramps were
renewals.** Leave the password case (Okta Identity Engine, CAPTCHA-exposed) in a browser.

**Two reasons it has waited, and only one still holds.** The design reason stands: Track A's
first reading could move the lever entirely — if the growth is buffering in the **browser
process**, `ctx.request` may be wrong. The other reason was *"the box stays healthy"*, and 88%
COMMIT with no guard firing weakens it. ~~**Take both to the owner honestly.**~~

**TAKEN TO THE OWNER 2026-08-24 AND ANSWERED: wait for one attributed reading first.** Recorded
as a decision so it is not re-litigated or quietly started. The deciding fact was the one worth
repeating — **the sampler is renderer-only** (`Memory.startSampling` is absent on the browser
target), and on the single event where both were measured the browser process held **545 MB of
2,046**. So if the growth is there, `ctx.request` may not be the lever at all, and building it
now is how a repair gets credited to the wrong mechanism — three times already.

**What changes the answer:** one reading from a real ramp, which now needs a tapped hold (see
§1b). If several mornings pass with no tap and no ramp, the wait itself becomes the cost, and
that is worth putting back to the owner rather than drifting.

---

## 5. The other live thread: iOS

**`1.0 (5)` awaits a decision** — same binary, rewritten App Review notes. **Release is
AUTOMATIC**, so it can go live with no human step; you may find out by seeing it on the App
Store. Read `docs/APP-STORE.md` §2d before touching anything.

- **Approved** → live, nothing to do; the `LINKOUT_BY_STORE.ios` flip already happened.
- **Rejected on 3.1.1 again** → **that is the ANSWER, not a fourth process failure.** This is the
  first submission where a reviewer can actually reach a link-out. It moves the decision to
  StoreKit — weeks of native work, a new build, 15–30% — and goes to the owner as that decision.
- **Rejected on something else** → treat on its own terms. §2a–§2d were each a different fault
  from what the previous one looked like.

**Android stays off.** `LINKOUT_BY_STORE.android` is `false` until Play PRODUCTION is live and
US-only; the closed test is worldwide and the carve-outs are US-storefront only.

---

## 6. Recorded, not fixed — do not drive-by these

- **A CI run can turn `autocart.rc_session` RED.** The health route carries its own inline
  `upcoming`/`imminent` counts that never got the `REAL_UNIT` filter, so test fixtures are
  visible to it. The phone is safe (`holdAtRisk` IS filtered); the dashboard is not, and while
  red it prints the destructive `rc-login.bat` remedy over a healthy session. Bounded to the
  length of a run. **The honest fix is one definition instead of three** — deliberate, not a
  drive-by.
- **The live manage token `EQO2oXcQ`** — unrotated, still returns 200. In git history, so
  scrubbing files is insufficient; rotation is one DELETE from `action_tokens`. **Owner's call**,
  four sessions running.
- **#76** — `rc-holds.test.mts`'s fixture sweep deletes a concurrent run's live rows.
- **#14** — rec.gov timeout cascade.

---

## 7. Traps that have actually fired

- **`GITHUB_TOKEN`/`GH_TOKEN` are SET and are 14-character PLACEHOLDERS.** `api.github.com`
  refuses them; GitHub works only through the MCP tools. **The variable existing is the trap** —
  check `${#GITHUB_TOKEN}` or read one response body. It cost a CI watchdog that parsed the
  refusal as "nothing terminal yet" and would have reported `TIMEOUT` on healthy CI.
- **Read the readout's `site` column.** `TEST · ` in `unit_name` is written only by
  `rc-test-hold.mts` and is the one unambiguous fixture marker — it was on screen for a day while
  three documents called the 08-23 hold real.
- **`claimed` in the readout is `claimed_at ?? released_at`.** A time there does not mean the hold
  was claimed; `released` is the successful terminal state.
- **`applied_note` and `applied_sha` describe DIFFERENT events.** Neither answers "did the update
  land?" — `git-status` through `bot_commands` does.
- **A health reading goes stale faster than a conclusion drawn from it.** Re-read before quoting.
- **A guard that anchors on a token occurring twice breaks silently.** Twenty-two times now. When
  one fails over unchanged behaviour, re-anchor **and verify it still fails against the
  regression it exists for** — a re-anchor that quietly weakens a guard is worse than the break.
- **Never invent an RC unit id.** `scripts/rc-test-hold.mts --find` is the only way; a real
  numeric id LOCKS a real campsite.
